'use strict';

/**
 * lib/provider-manager.cjs -- Runtime provider resolution for MGW.
 *
 * Maintains a registry of known AI providers and resolves the active
 * provider at runtime. Future providers register here and are selected
 * via config or --provider flag without touching any command logic.
 *
 * @example
 *   const { ProviderManager } = require('./provider-manager.cjs');
 *   const provider = ProviderManager.getProvider();          // defaults to claude
 *   const provider2 = ProviderManager.getProvider('claude'); // explicit
 *   provider.assertAvailable();
 *   const result = await provider.invoke(cmdFile, prompt, opts);
 */

const registry = {
  claude: require('./provider-claude.cjs'),
};

/**
 * Resolve a provider by ID. Defaults to 'claude' if no ID given.
 * @param {string} [providerId] - Provider identifier (e.g. "claude")
 * @returns {{ PROVIDER_ID: string, assertAvailable: Function, invoke: Function, getCommandsDir: Function }}
 * @throws {Error} If the requested provider is not registered
 */
function getProvider(providerId) {
  const id = providerId || 'claude';
  const provider = registry[id];
  if (!provider) {
    const available = Object.keys(registry).join(', ');
    throw new Error(`Unknown provider: "${id}". Available: ${available}`);
  }
  return provider;
}

/**
 * List all registered provider IDs.
 * @returns {string[]} Array of provider ID strings
 */
function listProviders() {
  return Object.keys(registry);
}

module.exports = { ProviderManager: { getProvider, listProviders } };
