'use strict';

/**
 * lib/index.cjs — Barrel export for all lib modules
 *
 * Re-exports all named exports from every lib module so callers
 * can import from a single entry point:
 *   const { loadProjectState, getIssue, invokeClaude } = require('./lib/index.cjs');
 */

const _exports = {
  ...require('./state.cjs'),
  ...require('./github.cjs'),
  ...require('./gsd.cjs'),
  ...require('./gsd-adapter.cjs'),
  ...require('./templates.cjs'),
  ...require('./output.cjs'),
  ...require('./claude.cjs'),
  ...require('./provider-manager.cjs'),
  ...require('./retry.cjs'),
  ...require('./spinner.cjs'),
  ...require('./progress.cjs'),
  ...require('./pipeline.cjs'),
  ...require('./errors.cjs'),
  ...require('./logger.cjs'),
  ...require('./issue-context.cjs'),
  ...require('./plugin-loader.cjs'),
};

// TUI is lazy-loaded — neo-blessed is an optionalDependency and may not be installed.
// Only the `issues` command uses TUI, so avoid eager loading for all other commands.
Object.defineProperty(_exports, 'createIssuesBrowser', {
  configurable: true,
  enumerable: true,
  get() {
    const value = require('./tui/index.cjs').createIssuesBrowser;
    Object.defineProperty(_exports, 'createIssuesBrowser', { value, enumerable: true });
    return value;
  },
});

module.exports = _exports;
