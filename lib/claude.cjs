'use strict';

/**
 * lib/claude.cjs -- Backward-compatibility shim.
 *
 * The canonical implementation has moved to lib/provider-claude.cjs.
 * This file re-exports the original API surface (assertClaudeAvailable,
 * invokeClaude, getCommandsDir) so existing callers continue to work.
 * Generic provider names are accessed via ProviderManager, not this shim.
 */

const provider = require('./provider-claude.cjs');

// Export only the original API surface — assertClaudeAvailable, invokeClaude,
// getCommandsDir. Generic names (PROVIDER_ID, assertAvailable, invoke) stay
// internal to the provider module and are accessed via ProviderManager.
module.exports = {
  assertClaudeAvailable: provider.assertAvailable,
  invokeClaude: provider.invoke,
  getCommandsDir: provider.getCommandsDir,
};
