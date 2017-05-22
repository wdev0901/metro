/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

const path = require('path');
const runCommand = require('./_runCommand');

console.log(`Setting up metro-bundler's development environment...`);
const isWindows = process.platform === 'win32';
const lerna = isWindows ? 'lerna.cmd' : 'lerna';
const lernaCmd = path.resolve(__dirname, '../node_modules/.bin/' + lerna);
const args = process.env.CI ? ['bootstrap', '--concurrency=1'] : ['bootstrap'];

runCommand(lernaCmd, args, path.resolve(__dirname, '..'));
