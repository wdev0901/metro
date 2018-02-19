/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+javascript_foundation
 * @format
 */

'use strict';

const {
  initialTraverseDependencies,
  traverseDependencies,
} = require('../traverseDependencies');

const entryModule = createModule({path: '/bundle', name: 'bundle'});
const moduleFoo = createModule({path: '/foo', name: 'foo'});
const moduleBar = createModule({path: '/bar', name: 'bar'});
const moduleBaz = createModule({path: '/baz', name: 'baz'});

let dependencyGraph;
let mockedDependencies;
let mockedDependencyTree;

function deferred(value) {
  let resolve;
  const promise = new Promise(res => (resolve = res));

  return {promise, resolve: () => resolve(value)};
}

function createModule({path, name, isAsset, isPolyfill}) {
  return {
    path,
    name,
    isAsset() {
      return !!isAsset;
    },
    isPolyfill() {
      return !!isPolyfill;
    },
    async read() {
      const deps = mockedDependencyTree.get(path);
      const dependencies = deps ? deps.map(dep => dep.name) : [];

      return {
        code: '// code',
        map: [],
        source: '// source',
        dependencies,
      };
    },
  };
}

function getPaths({added, deleted}) {
  const addedPaths = [...added.values()].map(edge => edge.path);

  return {
    added: new Set(addedPaths),
    deleted,
  };
}

beforeEach(async () => {
  mockedDependencies = new Set([entryModule, moduleFoo, moduleBar, moduleBaz]);
  mockedDependencyTree = new Map([
    [entryModule.path, [moduleFoo]],
    [moduleFoo.path, [moduleBar, moduleBaz]],
  ]);

  dependencyGraph = {
    getAbsolutePath(path) {
      return '/' + path;
    },
    getModuleForPath(path) {
      return Array.from(mockedDependencies).find(dep => dep.path === path);
    },
    resolveDependency(module, relativePath) {
      const deps = mockedDependencyTree.get(module.path);
      const dependency = deps.filter(dep => dep.name === relativePath)[0];

      if (!mockedDependencies.has(dependency)) {
        throw new Error('Dependency not found');
      }
      return dependency;
    },
  };
});

it('should do the initial traversal correctly', async () => {
  const edges = new Map();
  const result = await initialTraverseDependencies(
    '/bundle',
    dependencyGraph,
    {},
    edges,
  );

  expect(getPaths(result)).toEqual({
    added: new Set(['/bundle', '/foo', '/bar', '/baz']),
    deleted: new Set(),
  });
});

it('should return an empty result when there are no changes', async () => {
  const edges = new Map();
  await initialTraverseDependencies('/bundle', dependencyGraph, {}, edges);

  expect(
    getPaths(
      await traverseDependencies(['/bundle'], dependencyGraph, {}, edges),
    ),
  ).toEqual({
    added: new Set(['/bundle']),
    deleted: new Set(),
  });
});

it('should return a removed dependency', async () => {
  const edges = new Map();
  await initialTraverseDependencies('/bundle', dependencyGraph, {}, edges);

  // Remove moduleBar
  mockedDependencyTree.set(moduleFoo.path, [moduleBaz]);

  expect(
    getPaths(await traverseDependencies(['/foo'], dependencyGraph, {}, edges)),
  ).toEqual({
    added: new Set(['/foo']),
    deleted: new Set(['/bar']),
  });
});

it('should return added/removed dependencies', async () => {
  const edges = new Map();
  await initialTraverseDependencies('/bundle', dependencyGraph, {}, edges);

  // Add moduleQux
  const moduleQux = createModule({path: '/qux', name: 'qux'});
  mockedDependencyTree.set(moduleFoo.path, [moduleQux]);
  mockedDependencies.add(moduleQux);

  expect(
    getPaths(await traverseDependencies(['/foo'], dependencyGraph, {}, edges)),
  ).toEqual({
    added: new Set(['/foo', '/qux']),
    deleted: new Set(['/bar', '/baz']),
  });
});

it('should retry to traverse the dependencies as it was after getting an error', async () => {
  const edges = new Map();
  await initialTraverseDependencies('/bundle', dependencyGraph, {}, edges);

  mockedDependencies.delete(moduleBar);

  await expect(
    traverseDependencies(['/foo'], dependencyGraph, {}, edges),
  ).rejects.toBeInstanceOf(Error);

  // Second time that the traversal of dependencies we still have to throw an
  // error (no matter if no file has been changed).
  await expect(
    traverseDependencies(['/foo'], dependencyGraph, {}, edges),
  ).rejects.toBeInstanceOf(Error);
});

describe('edge cases', () => {
  it('should handle renames correctly', async () => {
    const edges = new Map();
    await initialTraverseDependencies('/bundle', dependencyGraph, {}, edges);

    // Change the dependencies of /path, removing /baz and adding /qux.
    const moduleQux = createModule({path: '/qux', name: 'qux'});
    mockedDependencyTree.set(moduleFoo.path, [moduleQux, moduleBar]);
    mockedDependencies.add(moduleQux);

    // Call traverseDependencies with /foo, /qux and /baz, simulating that the
    // user has modified the 3 files.
    expect(
      getPaths(
        await traverseDependencies(
          ['/foo', '/qux', '/baz'],
          dependencyGraph,
          {},
          edges,
        ),
      ),
    ).toEqual({
      added: new Set(['/foo', '/qux']),
      deleted: new Set(['/baz']),
    });
  });

  it('should not try to remove wrong dependencies when renaming files', async () => {
    const edges = new Map();
    await initialTraverseDependencies('/bundle', dependencyGraph, {}, edges);

    // Rename /foo to /foo-renamed, but keeping all its dependencies.
    const moduleFooRenamed = createModule({
      path: '/foo-renamed',
      name: 'foo-renamed',
    });
    mockedDependencyTree.set(entryModule.path, [moduleFooRenamed]);
    mockedDependencyTree.set(moduleFooRenamed.path, [moduleBar, moduleBaz]);
    mockedDependencies.add(moduleFooRenamed);
    mockedDependencies.delete(moduleFoo);

    // Call traverseDependencies with /foo, /qux and /baz, simulating that the
    // user has modified the 3 files.
    expect(
      getPaths(
        await traverseDependencies(['/bundle'], dependencyGraph, {}, edges),
      ),
    ).toEqual({
      added: new Set(['/bundle', '/foo-renamed']),
      deleted: new Set(['/foo']),
    });
  });

  it('move a file to a different folder', async () => {
    const edges = new Map();
    await initialTraverseDependencies('/bundle', dependencyGraph, {}, edges);

    const moduleBazMoved = createModule({path: '/baz-moved', name: 'baz'});
    mockedDependencyTree.set(moduleFoo.path, [moduleBar, moduleBazMoved]);
    mockedDependencies.add(moduleBazMoved);
    mockedDependencies.delete(moduleBaz);

    // Modify /baz, rename it to /qux and modify it again.
    expect(
      getPaths(
        await traverseDependencies(['/foo'], dependencyGraph, {}, edges),
      ),
    ).toEqual({
      added: new Set(['/foo', '/baz-moved']),
      deleted: new Set(['/baz']),
    });
  });

  it('should traverse the dependency tree in a deterministic order', async () => {
    // Mocks the shallow dependency call, always resolving the module in
    // `slowPath` after the module in `fastPath`.
    function mockShallowDependencies(slowPath, fastPath) {
      let deferredSlow;
      let fastResolved = false;

      dependencyGraph.getShallowDependencies = async path => {
        const deps = mockedDependencyTree.get(path);

        const result = deps
          ? await Promise.all(deps.map(dep => dep.getName()))
          : [];

        if (path === slowPath && !fastResolved) {
          // Return a Promise that won't be resolved after fastPath.
          deferredSlow = deferred(result);
          return deferredSlow.promise;
        }

        if (path === fastPath) {
          fastResolved = true;

          if (deferredSlow) {
            return new Promise(async resolve => {
              await resolve(result);

              deferredSlow.resolve();
            });
          }
        }

        return result;
      };
    }

    async function assertOrder() {
      expect(
        Array.from(
          getPaths(
            await initialTraverseDependencies(
              '/bundle',
              dependencyGraph,
              {},
              new Map(),
            ),
          ).added,
        ),
      ).toEqual(['/bundle', '/foo', '/baz', '/bar']);
    }

    // Create a dependency tree where moduleBaz has two inverse dependencies.
    mockedDependencyTree = new Map([
      [entryModule.path, [moduleFoo, moduleBar]],
      [moduleFoo.path, [moduleBaz]],
      [moduleBar.path, [moduleBaz]],
    ]);

    // Test that even when having different modules taking longer, the order
    // remains the same.
    mockShallowDependencies('/foo', '/bar');
    await assertOrder();

    mockShallowDependencies('/bar', '/foo');
    await assertOrder();
  });

  it('should simplify inlineRequires transform option', async () => {
    jest.spyOn(entryModule, 'read');
    jest.spyOn(moduleFoo, 'read');
    jest.spyOn(moduleBar, 'read');
    jest.spyOn(moduleBaz, 'read');

    const edges = new Map();
    const transformOptions = {
      inlineRequires: {
        blacklist: {
          '/baz': true,
        },
      },
    };

    await initialTraverseDependencies(
      '/bundle',
      dependencyGraph,
      transformOptions,
      edges,
    );

    expect(entryModule.read).toHaveBeenCalledWith({inlineRequires: true});
    expect(moduleFoo.read).toHaveBeenCalledWith({inlineRequires: true});
    expect(moduleBar.read).toHaveBeenCalledWith({inlineRequires: true});
    expect(moduleBaz.read).toHaveBeenCalledWith({inlineRequires: false});

    moduleFoo.read.mockClear();

    await traverseDependencies(
      ['/foo'],
      dependencyGraph,
      transformOptions,
      edges,
    );

    expect(moduleFoo.read).toHaveBeenCalledWith({inlineRequires: true});
  });
});
