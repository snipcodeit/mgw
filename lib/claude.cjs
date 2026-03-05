'use strict';

/**
 * lib/claude.cjs -- Backward-compatibility shim.
 *
 * The canonical implementation has moved to lib/provider-claude.cjs.
 * This file re-exports everything plus legacy aliases so existing callers
 * (bin/mgw.cjs, lib/index.cjs) continue to work without modification.
 */

const provider = require('./provider-claude.cjs');

module.exports = {
  ...provider,
  // Legacy aliases preserved for backward compatibility
  assertClaudeAvailable: provider.assertAvailable,
  invokeClaude: provider.invoke,
};
