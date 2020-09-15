/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @flow
 */

'use strict';

const nullthrows = require('nullthrows');

const generate = require('@babel/generator').default;
const template = require('@babel/template').default;
const traverse = require('@babel/traverse').default;
const types = require('@babel/types');

import type {Ast} from '@babel/core';
import type {Path} from '@babel/traverse';
import type {
  AllowOptionalDependencies,
  AsyncDependencyType,
} from 'metro/src/DeltaBundler/types.flow.js';

opaque type Identifier = any;

type ImportDependencyOptions = $ReadOnly<{
  asyncType: AsyncDependencyType,
  jsResource?: boolean,
  splitCondition?: Path,
}>;

export type Dependency<TSplitCondition> = $ReadOnly<{
  data: DependencyData<TSplitCondition>,
  name: string,
}>;

type DependencyData<TSplitCondition> = $ReadOnly<{
  // If null, then the dependency is synchronous.
  // (ex. `require('foo')`)
  asyncType: AsyncDependencyType | null,
  isOptional?: boolean,
  // If left unspecified, then the dependency is unconditionally split.
  splitCondition?: TSplitCondition,
  locs: Array<BabelSourceLocation>,
}>;

export type MutableInternalDependency<TSplitCondition> = {
  ...DependencyData<TSplitCondition>,
  index: number,
  name: string,
};

export type InternalDependency<TSplitCondition> = $ReadOnly<
  MutableInternalDependency<TSplitCondition>,
>;

export type State<TSplitCondition> = {
  asyncRequireModulePathStringLiteral: ?Identifier,
  dependencyCalls: Set<string>,
  dependencyRegistry: ModuleDependencyRegistry<TSplitCondition>,
  dependencyTransformer: DependencyTransformer<TSplitCondition>,
  dynamicRequires: DynamicRequiresBehavior,
  dependencyMapIdentifier: ?Identifier,
  keepRequireNames: boolean,
  allowOptionalDependencies: AllowOptionalDependencies,
};

export type Options<TSplitCondition = void> = $ReadOnly<{
  asyncRequireModulePath: string,
  dependencyMapName?: string,
  dynamicRequires: DynamicRequiresBehavior,
  inlineableCalls: $ReadOnlyArray<string>,
  keepRequireNames: boolean,
  allowOptionalDependencies: AllowOptionalDependencies,
  dependencyRegistry?: ModuleDependencyRegistry<TSplitCondition>,
  dependencyTransformer?: DependencyTransformer<TSplitCondition>,
}>;

export type CollectedDependencies<+TSplitCondition> = $ReadOnly<{
  ast: Ast,
  dependencyMapName: string,
  dependencies: $ReadOnlyArray<Dependency<TSplitCondition>>,
}>;

// Registry for the dependency of a module.
// Defines when dependencies should be collapsed.
// E.g. should a module that's once required optinally and once not
// be tretaed as the smae or different dependencies.
export interface ModuleDependencyRegistry<+TSplitCondition> {
  registerDependency(
    qualifier: ImportQualifier,
  ): InternalDependency<TSplitCondition>;
  getDependencies(): Array<InternalDependency<TSplitCondition>>;
}

export interface DependencyTransformer<-TSplitCondition> {
  transformSyncRequire(
    path: Path,
    dependency: InternalDependency<TSplitCondition>,
    state: State<TSplitCondition>,
  ): void;
  transformImportCall(
    path: Path,
    dependency: InternalDependency<TSplitCondition>,
    state: State<TSplitCondition>,
  ): void;
  transformJSResource(
    path: Path,
    dependency: InternalDependency<TSplitCondition>,
    state: State<TSplitCondition>,
  ): void;
  transformPrefetch(
    path: Path,
    dependency: InternalDependency<TSplitCondition>,
    state: State<TSplitCondition>,
  ): void;
  transformIllegalDynamicRequire(
    path: Path,
    state: State<TSplitCondition>,
  ): void;
}

export type DynamicRequiresBehavior = 'throwAtRuntime' | 'reject';

/**
 * Transform all the calls to `require()` and `import()` in a file into ID-
 * independent code, and return the list of dependencies. For example, a call
 * like `require('Foo')` could be transformed to `require(_depMap[3], 'Foo')`
 * where `_depMap` is provided by the outer scope. As such, we don't need to
 * know the actual module ID.
 *
 * The second argument is only provided for debugging purposes.
 */
function collectDependencies<TSplitCondition = void>(
  ast: Ast,
  options: Options<TSplitCondition>,
): CollectedDependencies<TSplitCondition> {
  const visited = new WeakSet();

  const state: State<TSplitCondition> = {
    asyncRequireModulePathStringLiteral: null,
    dependencyCalls: new Set(),
    dependencyRegistry:
      options.dependencyRegistry ?? new DefaultModuleDependencyRegistry(),
    dependencyTransformer:
      options.dependencyTransformer ?? DefaultDependencyTransformer,
    dependencyMapIdentifier: null,
    dynamicRequires: options.dynamicRequires,
    keepRequireNames: options.keepRequireNames,
    allowOptionalDependencies: options.allowOptionalDependencies,
  };

  const visitor = {
    CallExpression(path: Path, state: State<TSplitCondition>) {
      if (visited.has(path.node)) {
        return;
      }

      const callee = path.get('callee');
      const name = callee.node.name;

      if (callee.isImport()) {
        processImportCall(path, state, {
          asyncType: 'async',
        });
        return;
      }

      if (name === '__prefetchImport' && !path.scope.getBinding(name)) {
        processImportCall(path, state, {
          asyncType: 'prefetch',
        });
        return;
      }

      if (name === '__jsResource' && !path.scope.getBinding(name)) {
        processImportCall(path, state, {
          asyncType: 'async',
          jsResource: true,
        });
        return;
      }

      if (
        name === '__conditionallySplitJSResource' &&
        !path.scope.getBinding(name)
      ) {
        processImportCall(path, state, {
          asyncType: 'async',
          jsResource: true,
          splitCondition: path.get('arguments')[1],
        });
        return;
      }

      if (state.dependencyCalls.has(name) && !path.scope.getBinding(name)) {
        processRequireCall(path, state);
        visited.add(path.node);
      }
    },

    ImportDeclaration: collectImports,
    ExportNamedDeclaration: collectImports,
    ExportAllDeclaration: collectImports,

    Program(path: Path, state: State<TSplitCondition>) {
      state.asyncRequireModulePathStringLiteral = types.stringLiteral(
        options.asyncRequireModulePath,
      );

      if (options.dependencyMapName != null) {
        state.dependencyMapIdentifier = types.identifier(
          options.dependencyMapName,
        );
      } else {
        state.dependencyMapIdentifier = path.scope.generateUidIdentifier(
          'dependencyMap',
        );
      }

      state.dependencyCalls = new Set(['require', ...options.inlineableCalls]);
    },
  };

  traverse(ast, visitor, null, state);

  const collectedDependencies = state.dependencyRegistry.getDependencies();
  // Compute the list of dependencies.
  const dependencies = new Array(collectedDependencies.length);

  for (const {index, name, ...dependencyData} of collectedDependencies) {
    dependencies[index] = {
      name,
      data: dependencyData,
    };
  }

  return {
    ast,
    dependencies,
    dependencyMapName: nullthrows(state.dependencyMapIdentifier).name,
  };
}

function collectImports<TSplitCondition>(
  path: Path,
  state: State<TSplitCondition>,
) {
  if (path.node.source) {
    registerDependency(
      state,
      {
        name: path.node.source.value,
        asyncType: null,
        optional: false,
      },
      path,
    );
  }
}

function processImportCall<TSplitCondition>(
  path: Path,
  state: State<TSplitCondition>,
  options: ImportDependencyOptions,
): void {
  const name = getModuleNameFromCallArgs(path);

  if (name == null) {
    throw new InvalidRequireCallError(path);
  }

  const dep = registerDependency(
    state,
    {
      name,
      asyncType: options.asyncType,
      splitCondition: options.splitCondition,
      optional: isOptionalDependency(name, path, state),
    },
    path,
  );

  const transformer = state.dependencyTransformer;

  if (options.jsResource) {
    transformer.transformJSResource(path, dep, state);
  } else if (options.asyncType === 'async') {
    transformer.transformImportCall(path, dep, state);
  } else {
    transformer.transformPrefetch(path, dep, state);
  }
}

function processRequireCall<TSplitCondition>(
  path: Path,
  state: State<TSplitCondition>,
): void {
  const name = getModuleNameFromCallArgs(path);

  const transformer = state.dependencyTransformer;

  if (name == null) {
    if (state.dynamicRequires === 'reject') {
      throw new InvalidRequireCallError(path);
    }

    transformer.transformIllegalDynamicRequire(path, state);
    return;
  }

  const dep = registerDependency(
    state,
    {
      name,
      asyncType: null,
      optional: isOptionalDependency(name, path, state),
    },
    path,
  );

  transformer.transformSyncRequire(path, dep, state);
}

function getNearestLocFromPath(path: Path): ?BabelSourceLocation {
  while (path && !path.node.loc) {
    path = path.parentPath;
  }
  return path?.node.loc;
}

export type ImportQualifier = $ReadOnly<{
  name: string,
  asyncType: AsyncDependencyType | null,
  splitCondition?: Path,
  optional: boolean,
}>;

function registerDependency<TSplitCondition>(
  state: State<TSplitCondition>,
  qualifier: ImportQualifier,
  path: Path,
): InternalDependency<TSplitCondition> {
  const dependency = state.dependencyRegistry.registerDependency(qualifier);

  const loc = getNearestLocFromPath(path);
  if (loc != null) {
    dependency.locs.push(loc);
  }

  return dependency;
}

function isOptionalDependency<TSplitCondition>(
  name: string,
  path: Path,
  state: State<TSplitCondition>,
): boolean {
  const {allowOptionalDependencies} = state;

  // The async require module is a 'built-in'. Resolving should never fail -> treat it as non-optional.
  if (name === state.asyncRequireModulePathStringLiteral?.name) {
    return false;
  }

  const isExcluded = () =>
    Array.isArray(allowOptionalDependencies.exclude) &&
    allowOptionalDependencies.exclude.includes(name);

  if (!allowOptionalDependencies || isExcluded()) {
    return false;
  }

  // Valid statement stack for single-level try-block: expressionStatement -> blockStatement -> tryStatement
  let sCount = 0;
  let p = path;
  while (p && sCount < 3) {
    if (p.isStatement()) {
      if (p.node.type === 'BlockStatement') {
        // A single-level should have the tryStatement immediately followed BlockStatement
        // with the key 'block' to distinguish from the finally block, which has key = 'finalizer'
        return p.parentPath.node.type === 'TryStatement' && p.key === 'block';
      }
      sCount += 1;
    }
    p = p.parentPath;
  }

  return false;
}

function getModuleNameFromCallArgs(path: Path): ?string {
  const expectedCount =
    path.node.callee.name === '__conditionallySplitJSResource' ? 2 : 1;
  if (path.get('arguments').length !== expectedCount) {
    throw new InvalidRequireCallError(path);
  }

  const result = path.get('arguments.0').evaluate();

  if (result.confident && typeof result.value === 'string') {
    return result.value;
  }

  return null;
}
collectDependencies.getModuleNameFromCallArgs = getModuleNameFromCallArgs;

class InvalidRequireCallError extends Error {
  constructor({node}: any) {
    const line = node.loc && node.loc.start && node.loc.start.line;

    super(
      `Invalid call at line ${line || '<unknown>'}: ${generate(node).code}`,
    );
  }
}

collectDependencies.InvalidRequireCallError = InvalidRequireCallError;

/**
 * Produces a Babel template that will throw at runtime when the require call
 * is reached. This makes dynamic require errors catchable by libraries that
 * want to use them.
 */
const dynamicRequireErrorTemplate = template(`
  (function(line) {
    throw new Error(
      'Dynamic require defined at line ' + line + '; not supported by Metro',
    );
  })(LINE)
`);

/**
 * Produces a Babel template that transforms an "import(...)" call into a
 * "require(...)" call to the asyncRequire specified.
 */
const makeAsyncRequireTemplate = template(`
  require(ASYNC_REQUIRE_MODULE_PATH)(MODULE_ID, MODULE_NAME)
`);

const makeAsyncPrefetchTemplate = template(`
  require(ASYNC_REQUIRE_MODULE_PATH).prefetch(MODULE_ID, MODULE_NAME)
`);

const makeJSResourceTemplate = template(`
  require(ASYNC_REQUIRE_MODULE_PATH).resource(MODULE_ID, MODULE_NAME)
`);

const DefaultDependencyTransformer: DependencyTransformer<mixed> = {
  transformSyncRequire(
    path: Path,
    dependency: InternalDependency<mixed>,
    state: State<mixed>,
  ): void {
    const moduleIDExpression = createModuleIDExpression(dependency, state);
    path.node.arguments = state.keepRequireNames
      ? [moduleIDExpression, types.stringLiteral(dependency.name)]
      : [moduleIDExpression];
  },

  transformImportCall(
    path: Path,
    dependency: InternalDependency<mixed>,
    state: State<mixed>,
  ): void {
    path.replaceWith(
      makeAsyncRequireTemplate({
        ASYNC_REQUIRE_MODULE_PATH: state.asyncRequireModulePathStringLiteral,
        MODULE_ID: createModuleIDExpression(dependency, state),
        MODULE_NAME: createModuleNameLiteral(dependency),
      }),
    );
  },

  transformJSResource(
    path: Path,
    dependency: InternalDependency<mixed>,
    state: State<mixed>,
  ): void {
    path.replaceWith(
      makeJSResourceTemplate({
        ASYNC_REQUIRE_MODULE_PATH: state.asyncRequireModulePathStringLiteral,
        MODULE_ID: createModuleIDExpression(dependency, state),
        MODULE_NAME: createModuleNameLiteral(dependency),
      }),
    );
  },

  transformPrefetch(
    path: Path,
    dependency: InternalDependency<mixed>,
    state: State<mixed>,
  ): void {
    path.replaceWith(
      makeAsyncPrefetchTemplate({
        ASYNC_REQUIRE_MODULE_PATH: state.asyncRequireModulePathStringLiteral,
        MODULE_ID: createModuleIDExpression(dependency, state),
        MODULE_NAME: createModuleNameLiteral(dependency),
      }),
    );
  },

  transformIllegalDynamicRequire(path: Path, state: State<mixed>): void {
    path.replaceWith(
      dynamicRequireErrorTemplate({
        LINE: '' + path.node.loc.start.line,
      }),
    );
  },
};

function createModuleIDExpression(
  dependency: InternalDependency<mixed>,
  state: State<mixed>,
) {
  return types.memberExpression(
    state.dependencyMapIdentifier,
    types.numericLiteral(dependency.index),
    true,
  );
}

function createModuleNameLiteral(dependency: InternalDependency<mixed>) {
  return types.stringLiteral(dependency.name);
}

class DefaultModuleDependencyRegistry<TSplitCondition = void>
  implements ModuleDependencyRegistry<TSplitCondition> {
  _dependencies: Map<string, InternalDependency<TSplitCondition>> = new Map();

  registerDependency(
    qualifier: ImportQualifier,
  ): InternalDependency<TSplitCondition> {
    let dependency: ?InternalDependency<TSplitCondition> = this._dependencies.get(
      qualifier.name,
    );

    if (dependency == null) {
      const newDependency: MutableInternalDependency<TSplitCondition> = {
        name: qualifier.name,
        asyncType: qualifier.asyncType,
        locs: [],
        index: this._dependencies.size,
      };

      if (qualifier.optional) {
        newDependency.isOptional = true;
      }

      dependency = newDependency;
      this._dependencies.set(qualifier.name, dependency);
    } else {
      const original = dependency;
      dependency = collapseDependencies(original, qualifier);
      if (original !== dependency) {
        this._dependencies.set(qualifier.name, dependency);
      }
    }

    return dependency;
  }

  getDependencies(): Array<InternalDependency<TSplitCondition>> {
    return Array.from(this._dependencies.values());
  }
}

function collapseDependencies<TSplitCondition>(
  dependency: InternalDependency<TSplitCondition>,
  qualifier: ImportQualifier,
): InternalDependency<TSplitCondition> {
  let collapsed = dependency;

  // A previously optionally required dependency was required non-optionaly.
  // Mark it non optional for the whole module
  if (collapsed.isOptional && !qualifier.optional) {
    collapsed = {
      ...dependency,
      isOptional: false,
    };
  }

  // A previously asynchronously (or prefetch) required module was required synchronously.
  // Make the dependency sync.
  if (collapsed.asyncType != null && qualifier.asyncType == null) {
    collapsed = {...dependency, asyncType: null};
  }

  // A prefetched dependency was required async in the module. Mark it as async.
  if (collapsed.asyncType === 'prefetch' && qualifier.asyncType === 'async') {
    collapsed = {
      ...dependency,
      asyncType: 'async',
    };
  }

  return collapsed;
}

module.exports = collectDependencies;
