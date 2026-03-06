'use strict';

/**
 * lib/model-fallback.cjs — Model fallback strategy for GSD agent failures
 *
 * When an agent fails after retry exhaustion at a given model tier,
 * automatically attempt re-execution with a lower-tier model
 * (e.g., opus -> sonnet -> haiku for analysis tasks).
 *
 * Architecture:
 *   MGW orchestrator
 *     → RetryPolicyEngine.executeWithPolicy(fn, { agentType })    (lib/retry-policy.cjs)
 *       → on policy exhaustion at current model tier:
 *         → ModelFallbackEngine.executeWithFallback(fn, { agentType })  (this file)
 *           → resolves fallback chain: [opus, sonnet, haiku]
 *           → tries fn(model) for each tier until success or chain exhausted
 *
 * Design:
 *   - Fallback chain is per-agent-type (different agents have different needs)
 *   - Configurable via .mgw/config.json retry.model_fallback (boolean toggle)
 *   - Non-breaking: when model_fallback is false (default), behavior unchanged
 *   - Integrates with gsd-adapter.cjs resolveModel for primary model resolution
 *
 * Integrates with:
 *   - lib/retry-policy.cjs  (RetryPolicyEngine, dependency from #232)
 *   - lib/agent-errors.cjs  (AGENT_FAILURE_TYPES, dependency from #229)
 *   - lib/retry.cjs         (classifyFailure, generic fallback classification)
 *   - lib/errors.cjs        (MgwError base class)
 *   - lib/gsd-adapter.cjs   (resolveModel wrapper)
 */

const fs = require('fs');
const path = require('path');
const { MgwError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// Safe import of agent-errors.cjs (may not exist if PR #229 not merged)
// ---------------------------------------------------------------------------

let classifyAgentFailure = null;
let AGENT_FAILURE_TYPES = null;
try {
  const agentErrors = require('./agent-errors.cjs');
  classifyAgentFailure = agentErrors.classifyAgentFailure;
  AGENT_FAILURE_TYPES = agentErrors.AGENT_FAILURE_TYPES;
} catch (_) {
  // agent-errors.cjs not available — fall back to generic classification
}

// Safe import of retry.cjs for generic classification
let classifyFailure = null;
try {
  const retry = require('./retry.cjs');
  classifyFailure = retry.classifyFailure;
} catch (_) {
  // retry.cjs not available — fallback will be disabled
}

// ---------------------------------------------------------------------------
// Default fallback chains
// ---------------------------------------------------------------------------

/**
 * Default model fallback chains per agent type.
 *
 * Each chain is an ordered list of model tiers to attempt.
 * "inherit" means "use the model running the current session" (passthrough).
 *
 * On failure at tier N, the engine tries tier N+1 in the chain.
 * If the chain is exhausted, the failure is final.
 *
 * Chain design rationale:
 *   - gsd-planner: starts with inherit (session model, usually opus-level),
 *     falls back to sonnet for simpler planning, then haiku for minimal plans
 *   - gsd-executor: starts at sonnet (execution rarely needs opus-level reasoning),
 *     falls back to haiku for straightforward code changes
 *   - gsd-verifier: same as executor — verification is pattern-matching
 *   - gsd-plan-checker: same as executor — structural checks don't need opus
 *   - general-purpose: sonnet default with haiku fallback
 */
const DEFAULT_FALLBACK_CHAINS = Object.freeze({
  'gsd-planner':      Object.freeze(['inherit', 'sonnet', 'haiku']),
  'gsd-executor':     Object.freeze(['sonnet', 'haiku']),
  'gsd-verifier':     Object.freeze(['sonnet', 'haiku']),
  'gsd-plan-checker': Object.freeze(['sonnet', 'haiku']),
  'general-purpose':  Object.freeze(['sonnet', 'haiku']),
});

/**
 * Failure types that should NOT trigger model fallback.
 *
 * These failures are inherent to the task or environment, not to
 * the model's capability. Retrying with a different model would
 * either produce the same error or produce unsafe results.
 */
const NON_FALLBACK_FAILURE_TYPES = new Set([
  'hallucination',      // Unsafe — different model might hallucinate differently
  'permission-denied',  // Environment issue — model change won't help
]);

// ---------------------------------------------------------------------------
// ModelFallbackError class
// ---------------------------------------------------------------------------

/**
 * Error thrown when all models in the fallback chain have been exhausted.
 * Wraps the last error from the final model attempt.
 */
class ModelFallbackError extends MgwError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.failureType]      - Last classified failure type
   * @param {string} [opts.agentType]        - GSD agent type
   * @param {string[]} [opts.modelsAttempted] - Models that were tried
   * @param {number} [opts.fallback_attempts] - Number of fallback attempts made
   * @param {Error}  [opts.cause]            - Last error from final model attempt
   * @param {string} [opts.stage]            - Pipeline stage
   * @param {number} [opts.issueNumber]      - Related GitHub issue number
   */
  constructor(message, opts) {
    const o = opts || {};
    super(message, {
      code: 'MODEL_FALLBACK_EXHAUSTED',
      stage: o.stage,
      issueNumber: o.issueNumber,
      cause: o.cause,
    });
    this.name = 'ModelFallbackError';
    this.failureType = o.failureType || null;
    this.agentType = o.agentType || null;
    this.modelsAttempted = Array.isArray(o.modelsAttempted) ? o.modelsAttempted : [];
    this.fallback_attempts = typeof o.fallback_attempts === 'number' ? o.fallback_attempts : 0;
  }
}

// ---------------------------------------------------------------------------
// ModelFallbackEngine class
// ---------------------------------------------------------------------------

/**
 * Model fallback engine for GSD agent execution failures.
 *
 * Provides per-agent-type model fallback chains with configuration
 * from .mgw/config.json. When an agent fails after retry exhaustion
 * at one model tier, the engine tries the next model in the chain.
 *
 * Configuration merge priority (right wins):
 *   DEFAULT_FALLBACK_CHAINS < config file < constructor opts
 */
class ModelFallbackEngine {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled]        - Master enable/disable switch (overrides config)
   * @param {object} [opts.chains]          - Per-agent-type chain overrides
   *   Format: { 'gsd-planner': ['inherit', 'sonnet'] }
   * @param {string} [opts.configPath]      - Path to .mgw/config.json (default: auto-detect)
   */
  constructor(opts) {
    const o = opts || {};

    // Load config from file if available
    const fileConfig = ModelFallbackEngine.loadConfig(o.configPath || null);

    // Determine enabled state: constructor > config > default (false)
    if (typeof o.enabled === 'boolean') {
      this._enabled = o.enabled;
    } else if (typeof fileConfig.enabled === 'boolean') {
      this._enabled = fileConfig.enabled;
    } else {
      this._enabled = false;
    }

    // Merge chains: defaults < file config < constructor opts
    this._chains = Object.assign(
      {},
      DEFAULT_FALLBACK_CHAINS,
      fileConfig.chains || {},
      o.chains || {}
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Check whether model fallback is enabled.
   * @returns {boolean}
   */
  get enabled() {
    return this._enabled;
  }

  /**
   * Resolve the ordered fallback chain for an agent type.
   *
   * If model_fallback is disabled, returns an array with only the primary
   * model (no fallback — preserves backward-compatible behavior).
   *
   * @param {string} agentType - GSD agent type (e.g. 'gsd-planner')
   * @returns {string[]} Ordered model chain (first = primary, rest = fallbacks)
   */
  resolveFallbackChain(agentType) {
    const chain = this._chains[agentType] || this._chains['general-purpose'] || ['sonnet'];

    if (!this._enabled) {
      // When disabled, return only the primary model (no fallback)
      return [chain[0]];
    }

    // Return a copy to prevent mutation
    return [...chain];
  }

  /**
   * Execute an async function with model-tier fallback.
   *
   * Takes a function that receives a model name and attempts execution
   * with each model in the fallback chain until one succeeds or the
   * chain is exhausted.
   *
   * @param {(modelName: string) => Promise<*>} fn - Async function that accepts model name
   * @param {object} [opts]
   * @param {string} [opts.agentType]    - GSD agent type for chain lookup
   * @param {function} [opts.onFallback] - Callback on fallback: (fromModel, toModel, attempt, error) => void
   * @param {AbortSignal} [opts.signal]  - AbortSignal to cancel fallback attempts
   * @returns {Promise<{ result: *, model: string, fallback_attempts: number, total_models_tried: number }>}
   * @throws {ModelFallbackError} If all models in chain are exhausted
   * @throws {Error} Original error if failure type is non-fallback-eligible
   */
  async executeWithFallback(fn, opts) {
    const o = opts || {};
    const agentType = o.agentType || 'general-purpose';
    const onFallback = typeof o.onFallback === 'function' ? o.onFallback : null;
    const signal = o.signal || null;

    const chain = this.resolveFallbackChain(agentType);
    const modelsAttempted = [];
    let lastError = null;
    let fallbackAttempts = 0;

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];

      // Check for abort signal
      if (signal && signal.aborted) {
        throw lastError || new MgwError('Fallback aborted by signal', { code: 'FALLBACK_ABORTED' });
      }

      modelsAttempted.push(model);

      try {
        const result = await fn(model);
        return {
          result,
          model,
          fallback_attempts: fallbackAttempts,
          total_models_tried: modelsAttempted.length,
        };
      } catch (err) {
        lastError = err;

        // Classify the error to determine if fallback is appropriate
        const failureType = this._classifyForFallback(err, agentType);

        // Non-fallback-eligible failures: throw immediately
        if (NON_FALLBACK_FAILURE_TYPES.has(failureType)) {
          throw err;
        }

        // If this is the last model in the chain, don't increment fallback_attempts
        if (i < chain.length - 1) {
          fallbackAttempts++;

          // Notify caller of fallback
          if (onFallback) {
            try {
              onFallback(model, chain[i + 1], fallbackAttempts, err);
            } catch (_) {
              // onFallback errors are non-fatal
            }
          }
        }
      }
    }

    // All models exhausted — throw ModelFallbackError
    throw new ModelFallbackError(
      `Model fallback exhausted for ${agentType}: tried ${modelsAttempted.join(', ')}`,
      {
        failureType: this._classifyForFallback(lastError, agentType),
        agentType,
        modelsAttempted,
        fallback_attempts: fallbackAttempts,
        cause: lastError,
      }
    );
  }

  // -------------------------------------------------------------------------
  // Internal: error classification for fallback decisions
  // -------------------------------------------------------------------------

  /**
   * Classify an error to determine if model fallback should be attempted.
   *
   * Uses agent-errors.cjs classification first (if available), then falls
   * back to generic retry.cjs classification.
   *
   * @param {Error} err       - The error to classify
   * @param {string} [agentType] - GSD agent type for context
   * @returns {string} Failure type key (e.g. 'timeout', 'permanent', 'transient')
   * @private
   */
  _classifyForFallback(err, agentType) {
    // Try agent-specific classification first
    if (classifyAgentFailure) {
      const agentResult = classifyAgentFailure(err, { agentType });
      if (agentResult && agentResult.type) {
        return agentResult.type;
      }
    }

    // Fall back to generic classification
    if (classifyFailure) {
      const genericResult = classifyFailure(err);
      if (genericResult && genericResult.class) {
        // Map generic classes to failure type keys
        if (genericResult.class === 'transient') return 'timeout';
        if (genericResult.class === 'needs-info') return 'needs-info';
        return 'permanent';
      }
    }

    // No classifier available — treat as permanent (safe default)
    return 'permanent';
  }

  // -------------------------------------------------------------------------
  // Static: config loading
  // -------------------------------------------------------------------------

  /**
   * Load model fallback configuration from .mgw/config.json.
   *
   * Looks for a `retry` section with `model_fallback` and `fallback_chains`:
   * ```json
   * {
   *   "retry": {
   *     "model_fallback": true,
   *     "fallback_chains": {
   *       "gsd-planner": ["inherit", "sonnet"],
   *       "gsd-executor": ["sonnet", "haiku"]
   *     }
   *   }
   * }
   * ```
   *
   * @param {string} [configPath] - Explicit path to config.json. If null,
   *   searches for .mgw/config.json relative to cwd.
   * @returns {{ enabled?: boolean, chains?: object }}
   */
  static loadConfig(configPath) {
    const empty = {};

    try {
      const cfgPath = configPath || path.join(process.cwd(), '.mgw', 'config.json');
      if (!fs.existsSync(cfgPath)) return empty;

      const raw = fs.readFileSync(cfgPath, 'utf-8');
      const config = JSON.parse(raw);

      if (!config || typeof config !== 'object') return empty;

      const retry = config.retry;
      if (!retry || typeof retry !== 'object') return empty;

      const result = {};

      // Master enable/disable switch
      if (typeof retry.model_fallback === 'boolean') {
        result.enabled = retry.model_fallback;
      }

      // Per-agent-type chain overrides
      if (retry.fallback_chains && typeof retry.fallback_chains === 'object') {
        const chains = {};
        for (const [agentType, chain] of Object.entries(retry.fallback_chains)) {
          if (Array.isArray(chain) && chain.every(m => typeof m === 'string')) {
            chains[agentType] = chain;
          }
        }
        if (Object.keys(chains).length > 0) {
          result.chains = chains;
        }
      }

      return result;
    } catch (_) {
      // Config load failure is non-fatal — use defaults
      return empty;
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  DEFAULT_FALLBACK_CHAINS,
  NON_FALLBACK_FAILURE_TYPES,

  // Error class
  ModelFallbackError,

  // Engine
  ModelFallbackEngine,
};
