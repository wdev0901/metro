/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 * @format
 * @oncall react_native
 */

import type {WatcherOptions} from './common';
import type {
  Client,
  WatchmanClockResponse,
  WatchmanFileChange,
  WatchmanQuery,
  WatchmanSubscriptionEvent,
  WatchmanSubscribeResponse,
  WatchmanWatchResponse,
} from 'fb-watchman';
import type {Stats} from 'fs';

import * as common from './common';
import RecrawlWarning from './RecrawlWarning';
import assert from 'assert';
import {createHash} from 'crypto';
import EventEmitter from 'events';
import watchman from 'fb-watchman';
import * as fs from 'graceful-fs';
import invariant from 'invariant';
import path from 'path';

const debug = require('debug')('Metro:WatchmanWatcher');

const CHANGE_EVENT = common.CHANGE_EVENT;
const DELETE_EVENT = common.DELETE_EVENT;
const ADD_EVENT = common.ADD_EVENT;
const ALL_EVENT = common.ALL_EVENT;
const SUB_PREFIX = 'metro-file-map';

/**
 * Watches `dir`.
 */
export default class WatchmanWatcher extends EventEmitter {
  client: Client;
  dot: boolean;
  doIgnore: string => boolean;
  globs: $ReadOnlyArray<string>;
  hasIgnore: boolean;
  root: string;
  subscriptionName: string;
  watchProjectInfo: ?$ReadOnly<{
    relativePath: string,
    root: string,
  }>;
  watchmanDeferStates: $ReadOnlyArray<string>;

  constructor(dir: string, opts: WatcherOptions) {
    super();

    common.assignOptions(this, opts);
    this.root = path.resolve(dir);

    // Use a unique subscription name per process per watched directory
    const watchKey = createHash('md5').update(this.root).digest('hex');
    const readablePath = this.root
      .replace(/[\/\\]/g, '-') // \ and / to -
      .replace(/[^\-\w]/g, ''); // Remove non-word/hyphen
    this.subscriptionName = `${SUB_PREFIX}-${process.pid}-${readablePath}-${watchKey}`;

    this._init();
  }

  /**
   * Run the watchman `watch` command on the root and subscribe to changes.
   */
  _init() {
    if (this.client) {
      this.client.removeAllListeners();
    }

    const self = this;
    this.client = new watchman.Client();
    this.client.on('error', error => {
      self.emit('error', error);
    });
    this.client.on('subscription', changeEvent =>
      this._handleChangeEvent(changeEvent),
    );
    this.client.on('end', () => {
      console.warn(
        '[metro-file-map] Warning: Lost connection to Watchman, reconnecting..',
      );
      self._init();
    });

    this.watchProjectInfo = null;

    function getWatchRoot() {
      return self.watchProjectInfo ? self.watchProjectInfo.root : self.root;
    }

    function onWatchProject(error: ?Error, resp: WatchmanWatchResponse) {
      if (handleError(self, error)) {
        return;
      }
      debug('Received watch-project response: %s', resp.relative_path);

      handleWarning(resp);

      self.watchProjectInfo = {
        relativePath: resp.relative_path ? resp.relative_path : '',
        root: resp.watch,
      };

      self.client.command(['clock', getWatchRoot()], onClock);
    }

    function onClock(error: ?Error, resp: WatchmanClockResponse) {
      if (handleError(self, error)) {
        return;
      }

      debug('Received clock response: %s', resp.clock);
      const watchProjectInfo = self.watchProjectInfo;

      invariant(
        watchProjectInfo != null,
        'watch-project response should have been set before clock response',
      );

      handleWarning(resp);

      const options: WatchmanQuery = {
        fields: ['name', 'exists', 'new'],
        since: resp.clock,
        defer: self.watchmanDeferStates,
        relative_root: watchProjectInfo.relativePath,
      };

      // Make sure we honor the dot option if even we're not using globs.
      if (self.globs.length === 0 && !self.dot) {
        options.expression = [
          'match',
          '**',
          'wholename',
          {
            includedotfiles: false,
          },
        ];
      }

      self.client.command(
        ['subscribe', getWatchRoot(), self.subscriptionName, options],
        onSubscribe,
      );
    }

    function onSubscribe(error: ?Error, resp: WatchmanSubscribeResponse) {
      if (handleError(self, error)) {
        return;
      }
      debug('Received subscribe response: %s', resp.subscribe);

      handleWarning(resp);

      self.emit('ready');
    }

    self.client.command(['watch-project', getWatchRoot()], onWatchProject);
  }

  /**
   * Handles a change event coming from the subscription.
   */
  _handleChangeEvent(resp: WatchmanSubscriptionEvent) {
    debug(
      'Received subscription response: %s (fresh: %s, files: %s, enter: %s, leave: %s)',
      resp.subscription,
      resp.is_fresh_instance,
      resp.files?.length,
      resp['state-enter'],
      resp['state-leave'],
    );

    assert.equal(
      resp.subscription,
      this.subscriptionName,
      'Invalid subscription event.',
    );

    if (resp.is_fresh_instance) {
      this.emit('fresh_instance');
    }
    if (resp.is_fresh_instance) {
      this.emit('fresh_instance');
    }
    if (Array.isArray(resp.files)) {
      resp.files.forEach(change => this._handleFileChange(change));
    }
    if (
      resp['state-enter'] != null &&
      (this.watchmanDeferStates ?? []).includes(resp['state-enter'])
    ) {
      debug(
        'Watchman reports "%s" just started. Filesystem notifications are paused.',
        resp['state-enter'],
      );
    }
    if (
      resp['state-leave'] != null &&
      (this.watchmanDeferStates ?? []).includes(resp['state-leave'])
    ) {
      debug(
        'Watchman reports "%s" ended. Filesystem notifications resumed.',
        resp['state-leave'],
      );
    }
  }

  /**
   * Handles a single change event record.
   */
  _handleFileChange(changeDescriptor: WatchmanFileChange) {
    const self = this;
    const watchProjectInfo = self.watchProjectInfo;

    invariant(
      watchProjectInfo != null,
      'watch-project response should have been set before receiving subscription events',
    );

    const {
      name: relativePath,
      new: isNew = false,
      exists = false,
    } = changeDescriptor;

    debug(
      'Handling change to: %s (new: %s, exists: %s)',
      relativePath,
      isNew,
      exists,
    );

    const absPath = path.join(
      watchProjectInfo.root,
      watchProjectInfo.relativePath,
      relativePath,
    );

    if (
      this.hasIgnore &&
      !common.isFileIncluded(this.globs, this.dot, this.doIgnore, relativePath)
    ) {
      return;
    }

    if (!exists) {
      self._emitEvent(DELETE_EVENT, relativePath, self.root);
    } else {
      fs.lstat(absPath, (error, stat) => {
        // Files can be deleted between the event and the lstat call
        // the most reliable thing to do here is to ignore the event.
        if (error && error.code === 'ENOENT') {
          return;
        }

        if (handleError(self, error)) {
          return;
        }

        const eventType = isNew ? ADD_EVENT : CHANGE_EVENT;

        // Change event on dirs are mostly useless.
        if (!(eventType === CHANGE_EVENT && stat.isDirectory())) {
          self._emitEvent(eventType, relativePath, self.root, stat);
        }
      });
    }
  }

  /**
   * Dispatches the event.
   */
  _emitEvent(eventType: string, filepath: string, root: string, stat?: Stats) {
    this.emit(eventType, filepath, root, stat);
    this.emit(ALL_EVENT, eventType, filepath, root, stat);
  }

  /**
   * Closes the watcher.
   */
  async close() {
    this.client.removeAllListeners();
    this.client.end();
  }
}

/**
 * Handles an error and returns true if exists.
 */
function handleError(emitter: EventEmitter, error: ?Error) {
  if (error != null) {
    emitter.emit('error', error);
    return true;
  } else {
    return false;
  }
}

/**
 * Handles a warning in the watchman resp object.
 */
function handleWarning(resp: $ReadOnly<{warning?: mixed, ...}>) {
  if ('warning' in resp) {
    if (RecrawlWarning.isRecrawlWarningDupe(resp.warning)) {
      return true;
    }
    console.warn(resp.warning);
    return true;
  } else {
    return false;
  }
}
