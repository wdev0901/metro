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

const t = require('@babel/types');
const template = require('@babel/template').default;
const traverse = require('@babel/traverse').default;

import type {Ast} from '@babel/core';

const WRAP_NAME = '$$_REQUIRE'; // note: babel will prefix this with _

// Check first the `global` variable as the global object. This way serializers
// can create a local variable called global to fake it as a global object
// without having to pollute the window object on web.
const IIFE_PARAM = template(
  "typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : typeof window !== 'undefined' ? window : this",
);

function wrapModule(
  fileAst: Ast,
  importDefaultName: string,
  importAllName: string,
  dependencyMapName: string,
  globalPrefix: string,
): {
  ast: Ast,
  requireName: string,
} {
  const params = buildParameters(
    importDefaultName,
    importAllName,
    dependencyMapName,
  );
  const factory = functionFromProgram(fileAst.program, params);
  const def = t.callExpression(t.identifier(`${globalPrefix}__d`), [factory]);
  const ast = t.file(t.program([t.expressionStatement(def)]));

  const requireName = renameRequires(ast);

  return {ast, requireName};
}

function wrapPolyfill(fileAst: Ast): Ast {
  const factory = functionFromProgram(fileAst.program, ['global']);

  const iife = t.callExpression(factory, [IIFE_PARAM().expression]);
  return t.file(t.program([t.expressionStatement(iife)]));
}

function wrapJson(source: string, globalPrefix: string): string {
  // Unused parameters; remember that's wrapping JSON.
  const moduleFactoryParameters = buildParameters(
    '_aUnused',
    '_bUnused',
    '_cUnused',
  );

  return [
    `${globalPrefix}__d(function(${moduleFactoryParameters.join(', ')}) {`,
    `  module.exports = ${source};`,
    '});',
  ].join('\n');
}

function functionFromProgram(
  program: Ast,
  parameters: $ReadOnlyArray<string>,
): Ast {
  return t.functionExpression(
    t.identifier(''),
    parameters.map(makeIdentifier),
    t.blockStatement(program.body, program.directives),
  );
}

function makeIdentifier(name: string): Ast {
  return t.identifier(name);
}

function buildParameters(
  importDefaultName: string,
  importAllName: string,
  dependencyMapName: string,
): $ReadOnlyArray<string> {
  return [
    'global',
    'require',
    importDefaultName,
    importAllName,
    'module',
    'exports',
    dependencyMapName,
  ];
}

// Renaming requires should ideally only be done when generating for the target
// that expects the custom require name in the optimize step.
// This visitor currently renames all `require` references even if the module
// contains a custom `require` declaration. This should be fixed by only renaming
// if the `require` symbol hasn't been redeclared.
function renameRequires(ast: Ast): string {
  let newRequireName = WRAP_NAME;

  traverse(ast, {
    Program(path) {
      const body = path.get('body.0.expression.arguments.0.body');

      newRequireName = body.scope.generateUid(WRAP_NAME);
      body.scope.rename('require', newRequireName);
    },
  });

  return newRequireName;
}

module.exports = {
  WRAP_NAME,

  wrapJson,
  wrapModule,
  wrapPolyfill,
};
