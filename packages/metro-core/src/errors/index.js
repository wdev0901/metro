/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const AmbiguousModuleResolutionError = require('./AmbiguousModuleResolutionError');
const PackageResolutionError = require('./PackageResolutionError');

module.exports = {
  AmbiguousModuleResolutionError,
  PackageResolutionError,
};
