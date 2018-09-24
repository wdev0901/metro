/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const WorkerFarm = require('./WorkerFarm');

const assert = require('assert');
const fs = require('fs');
const getTransformCacheKeyFn = require('./Transformer/getTransformCacheKeyFn');
const path = require('path');

const {Cache, stableHash} = require('metro-cache');

import type {TransformResult} from '../DeltaBundler';
import type {WorkerOptions} from './Worker';
import type {ConfigT} from 'metro-config/src/configTypes.flow';

class Transformer {
  _config: ConfigT;
  _cache: Cache<TransformResult<>>;
  _baseHash: string;
  _getSha1: string => string;
  _workerFarm: WorkerFarm;

  constructor(config: ConfigT, getSha1Fn: string => string) {
    this._config = config;

    this._config.watchFolders.forEach(verifyRootExists);
    this._cache = new Cache(config.cacheStores);
    this._getSha1 = getSha1Fn;
    this._workerFarm = new WorkerFarm(config);

    const getTransformCacheKey = getTransformCacheKeyFn({
      babelTransformerPath: this._config.transformer.babelTransformerPath,
      cacheVersion: this._config.cacheVersion,
      projectRoot: this._config.projectRoot,
      transformerPath: this._config.transformerPath,
    });

    this._baseHash = stableHash([getTransformCacheKey()]).toString('binary');
  }

  async transformFile(
    filePath: string,
    transformerOptions: WorkerOptions,
  ): Promise<TransformResult<>> {
    const cache = this._cache;

    const {
      assetPlugins,
      assetRegistryPath,
      asyncRequireModulePath,
      // Already in the global cache key.
      babelTransformerPath: _babelTransformerPath,
      dynamicDepsInPackages,
      minifierPath,
      optimizationSizeLimit,
      transformOptions: {
        customTransformOptions,
        enableBabelRCLookup,
        dev,
        hot,
        inlineRequires,
        minify,
        platform,
        projectRoot: _projectRoot, // Blacklisted property.
      },
      type,
      ...extra
    } = transformerOptions;

    for (const key in extra) {
      if (hasOwnProperty.call(extra, key)) {
        throw new Error(
          'Extra keys detected: ' + Object.keys(extra).join(', '),
        );
      }
    }

    const localPath = path.relative(this._config.projectRoot, filePath);

    const partialKey = stableHash([
      // This is the hash related to the global Bundler config.
      this._baseHash,

      // Path.
      localPath,

      // We cannot include "transformCodeOptions" because of "projectRoot".
      assetPlugins,
      assetRegistryPath,
      asyncRequireModulePath,
      dynamicDepsInPackages,
      minifierPath,

      customTransformOptions,
      enableBabelRCLookup,
      dev,
      hot,
      inlineRequires,
      minify,
      optimizationSizeLimit,
      platform,
      type,
    ]);

    const sha1 = this._getSha1(filePath);
    let fullKey = Buffer.concat([partialKey, Buffer.from(sha1, 'hex')]);
    const result = await cache.get(fullKey);

    // A valid result from the cache is used directly; otherwise we call into
    // the transformer to computed the corresponding result.
    const data = result
      ? {result, sha1}
      : await this._workerFarm.transform(
          localPath,
          _projectRoot,
          this._config.transformerPath,
          transformerOptions,
        );

    // Only re-compute the full key if the SHA-1 changed. This is because
    // references are used by the cache implementation in a weak map to keep
    // track of the cache that returned the result.
    if (sha1 !== data.sha1) {
      fullKey = Buffer.concat([partialKey, Buffer.from(data.sha1, 'hex')]);
    }

    cache.set(fullKey, data.result);

    return {
      ...data.result,
      getSource() {
        return fs.readFileSync(filePath);
      },
    };
  }

  end() {
    this._workerFarm.kill();
  }
}

function verifyRootExists(root) {
  // Verify that the root exists.
  assert(fs.statSync(root).isDirectory(), 'Root has to be a valid directory');
}

module.exports = Transformer;
