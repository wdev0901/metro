/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const Router = require('router');

const {
  getGraphFromModule,
  getGraphToModule,
  getAllModules,
  getGraphFromModuleToModule,
} = require('./graphFunctions');

import type {Graph} from 'metro/src/DeltaBundler';

const router = Router();
let metroGraph: Graph<>;

/*
* Get the whole dependency graph in a cytoscape format
*
* @response {CyGraph}
*/
router.get('/', async function(req, res) {
  res.status(500).send('Unimplemented');
});

/*
* Get basic information about the graph
*
* @response {Object} info
* @response {String} info.entryPoints
* @response {String} info.edgeCount
* @response {String} info.nodeCount
*/
router.get('/info', function(req, res) {
  res.status(500).send('Unimplemented');
});

/*
* Get a list of all the modules in the graph
*
* @response {Array<string>}
*/
router.get('/modules', function(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.write(JSON.stringify(getAllModules(metroGraph)));
  res.end();
});

/*
* Get the cytoscape formatted dependency graph using a specific module as the
* root.
*
* @params [:path] Path to the module to be used as root
*
* TODO @query {number} [depth = 0] How many levels to recursively expand dependencies
* TODO @query {string} [segment] Filters expanded dependencies by segment
* TODO @query {string} [directory] Filters expanded dependencies by directory
*
* @response {CyGraph}
*/
router.get('/modules/:path(*)', function(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.query.inverse) {
    res.write(JSON.stringify(getGraphToModule(metroGraph, req.params.path)));
  } else if (req.query.to) {
    res.write(
      JSON.stringify(
        getGraphFromModuleToModule(metroGraph, req.params.path, req.query.to),
      ),
    );
  } else {
    res.write(JSON.stringify(getGraphFromModule(metroGraph, req.params.path)));
  }
  res.end();
});

/*
* Get a list of all the directories in the graph
*
* @response {Array<string>}
*/
router.get('/directories', function(req, res) {
  res.status(500).send('Unimplemented');
});

/*
* Get the cytoscape formatted dependency graph of all the modules within
* a specific directory
*
* @params :path Path to the directory
*
* @response {CyGraph}
*/
router.get('/directories/:path(*)', function(req, res) {
  res.status(500).send('Unimplemented');
});

module.exports = (graph: Graph<>) => {
  metroGraph = graph;
  return router;
};
