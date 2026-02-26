'use strict';

/**
 * lib/index.cjs — Barrel export for all lib modules
 *
 * Re-exports all named exports from every lib module so callers
 * can import from a single entry point:
 *   const { loadProjectState, getIssue, invokeClaude } = require('./lib/index.cjs');
 */

module.exports = {
  ...require('./state.cjs'),
  ...require('./github.cjs'),
  ...require('./gsd.cjs'),
  ...require('./templates.cjs'),
  ...require('./output.cjs'),
  ...require('./claude.cjs')
};
