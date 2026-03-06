'use strict';

/**
 * lib/retry-policy.cjs — Configurable retry policy engine for GSD agent failures
 *
 * Higher-level retry engine that USES lib/agent-errors.cjs for failure
 * classification and provides per-failure-type retry limits with
 * per-agent-type overrides from .mgw/config.json.
 *
 * This module does NOT replace lib/retry.cjs — that module handles
 * low-level pipeline retry infrastructure. This module provides
 * policy-driven retry for Task() agent calls.
 *
 * Default retry policies:
 *   timeout:            2 retries (agent exceeded turn limit — often recoverable)
 *   malformed-output:   1 retry  (may succeed with same prompt)
 *   partial-completion: 1 retry  (continuation may complete remaining tasks)
 *   hallucination:      0 retries (unsafe to retry — results are unreliable)
 *   permission-denied:  0 retries (requires human intervention)
 *
 * Integrates with:
 *   - lib/agent-errors.cjs  (agent failure taxonomy & classification)
 *   - lib/retry.cjs         (generic failure classification fallback)
 *   - lib/errors.cjs        (MgwError base class)
 */

const fs = require('fs');
const path = require('path');
const { MgwError } = require('./errors.cjs');
const { classifyFailure, getBackoffMs: genericBackoff } = require('./retry.cjs');

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
  // agent-errors.cjs not available — fall back to generic classification only
}

// ---------------------------------------------------------------------------
// Safe import of model-fallback.cjs (may not exist if PR #233 not merged)
// ---------------------------------------------------------------------------

let ModelFallbackEngine = null;
let ModelFallbackError = null;
try {
  const modelFallback = require('./model-fallback.cjs');
  ModelFallbackEngine = modelFallback.ModelFallbackEngine;
  ModelFallbackError = modelFallback.ModelFallbackError;
} catch (_) {
  // model-fallback.cjs not available — fallback feature disabled
}

// ---------------------------------------------------------------------------
// Default policy constants
// ---------------------------------------------------------------------------

/**
 * Default maximum retry counts per agent failure type.
 *
 * These represent the number of RETRY attempts (not total attempts).
 * Total attempts = maxRetries + 1 (the initial attempt).
 */
const DEFAULT_RETRY_POLICIES = Object.freeze({
  'timeout':            2,
  'malformed-output':   1,
  'partial-completion': 1,
  'hallucination':      0,
  'permission-denied':  0,
});

/**
 * Default backoff configuration for retry delays.
 *
 * Uses exponential backoff: delay = min(maxMs, baseMs * multiplier^attempt)
 * With optional full jitter: delay = random(0, computed_delay)
 */
const DEFAULT_BACKOFF_CONFIG = Object.freeze({
  baseMs:     5000,
  maxMs:      300000,
  multiplier: 2,
  jitter:     true,
});

// ---------------------------------------------------------------------------
// RetryPolicyError class
// ---------------------------------------------------------------------------

/**
 * Error thrown when retry policy is exhausted or a non-retryable failure occurs.
 * Wraps the original error with retry context.
 */
class RetryPolicyError extends MgwError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.failureType]       - Classified failure type
   * @param {string} [opts.agentType]         - GSD agent type
   * @param {number} [opts.attempts]          - Total attempts made
   * @param {number} [opts.maxRetries]        - Max retries allowed for this failure type
   * @param {number} [opts.fallback_attempts] - Number of model fallback attempts made
   * @param {Error}  [opts.cause]             - Original error
   */
  constructor(message, opts) {
    const o = opts || {};
    super(message, { code: 'RETRY_POLICY_EXHAUSTED', stage: o.stage, issueNumber: o.issueNumber, cause: o.cause });
    this.name = 'RetryPolicyError';
    this.failureType = o.failureType || null;
    this.agentType = o.agentType || null;
    this.attempts = typeof o.attempts === 'number' ? o.attempts : 0;
    this.maxRetries = typeof o.maxRetries === 'number' ? o.maxRetries : 0;
    this.fallback_attempts = typeof o.fallback_attempts === 'number' ? o.fallback_attempts : 0;
  }
}

// ---------------------------------------------------------------------------
// RetryPolicyEngine class
// ---------------------------------------------------------------------------

/**
 * Configurable retry policy engine for GSD agent failures.
 *
 * Provides per-failure-type retry limits with per-agent-type overrides.
 * Configuration is loaded from .mgw/config.json if present.
 *
 * Merge priority (right wins):
 *   DEFAULT_RETRY_POLICIES < config file < constructor opts
 */
class RetryPolicyEngine {
  /**
   * @param {object} [opts]
   * @param {object} [opts.policies]       - Per-failure-type max retries override
   * @param {object} [opts.backoff]        - Backoff config override
   * @param {object} [opts.agentOverrides] - Per-agent-type policy overrides
   *   Format: { 'gsd-planner': { timeout: 3 }, 'gsd-executor': { timeout: 1 } }
   * @param {string} [opts.configPath]     - Path to .mgw/config.json (default: auto-detect)
   */
  constructor(opts) {
    const o = opts || {};

    // Load config from file if available
    const fileConfig = RetryPolicyEngine.loadConfig(o.configPath || null);

    // Merge policies: defaults < file config < constructor opts
    this._policies = Object.assign(
      {},
      DEFAULT_RETRY_POLICIES,
      fileConfig.policies || {},
      o.policies || {}
    );

    // Merge backoff: defaults < file config < constructor opts
    this._backoff = Object.assign(
      {},
      DEFAULT_BACKOFF_CONFIG,
      fileConfig.backoff || {},
      o.backoff || {}
    );

    // Merge agent overrides: file config < constructor opts
    this._agentOverrides = Object.assign(
      {},
      fileConfig.agentOverrides || {},
      o.agentOverrides || {}
    );
  }

  // -------------------------------------------------------------------------
  // Policy query methods
  // -------------------------------------------------------------------------

  /**
   * Get the maximum retry count for a failure type, with optional
   * per-agent-type override.
   *
   * Lookup order:
   *   1. agentOverrides[agentType][failureType]  (if agentType provided)
   *   2. policies[failureType]
   *   3. 0 (unknown failure types are never retried)
   *
   * @param {string} failureType - Agent failure type (e.g. 'timeout')
   * @param {string} [agentType] - GSD agent type (e.g. 'gsd-planner')
   * @returns {number} Max retry count (0 means no retries)
   */
  getMaxRetries(failureType, agentType) {
    // Check agent-specific override first
    if (agentType && this._agentOverrides[agentType]) {
      const override = this._agentOverrides[agentType][failureType];
      if (typeof override === 'number') {
        return Math.max(0, Math.floor(override));
      }
    }

    // Fall back to global policy
    const global = this._policies[failureType];
    if (typeof global === 'number') {
      return Math.max(0, Math.floor(global));
    }

    // Unknown failure type — never retry
    return 0;
  }

  /**
   * Determine whether a retry should be attempted for a given failure type,
   * agent type, and current attempt count.
   *
   * @param {string} failureType    - Agent failure type
   * @param {string} [agentType]    - GSD agent type
   * @param {number} currentAttempt - Number of retries already attempted (0-based)
   * @returns {boolean} True if another retry is allowed
   */
  shouldRetry(failureType, agentType, currentAttempt) {
    const maxRetries = this.getMaxRetries(failureType, agentType);
    const attempt = typeof currentAttempt === 'number' ? currentAttempt : 0;
    return attempt < maxRetries;
  }

  /**
   * Calculate backoff delay in milliseconds for a given attempt number.
   *
   * Uses exponential backoff: delay = min(maxMs, baseMs * multiplier^attempt)
   * With optional full jitter: delay = random(0, computed_delay)
   *
   * @param {number} attempt - Retry attempt number (0-based)
   * @returns {number} Delay in milliseconds (integer, non-negative)
   */
  getBackoffMs(attempt) {
    const a = Math.max(0, Math.floor(attempt));
    const base = Math.min(
      this._backoff.maxMs,
      this._backoff.baseMs * Math.pow(this._backoff.multiplier, a)
    );

    if (this._backoff.jitter) {
      // Full jitter: uniform random in [0, base]
      return Math.floor(Math.random() * (base + 1));
    }

    return Math.floor(base);
  }

  // -------------------------------------------------------------------------
  // Execution wrapper
  // -------------------------------------------------------------------------

  /**
   * Execute an async function with retry policy and optional model fallback.
   *
   * Wraps a Task() call (or any async function) with automatic retry
   * based on the configured policy. On failure:
   *
   *   1. Classify using classifyAgentFailure (from agent-errors.cjs)
   *   2. Fall back to classifyFailure (from retry.cjs) if no agent match
   *   3. Check shouldRetry with the classified type
   *   4. If retryable and attempts remain: wait backoff, retry
   *   5. If not retryable or exhausted:
   *      a. If modelFallback is enabled and ModelFallbackEngine is available,
   *         try the next model in the fallback chain
   *      b. Otherwise throw original error
   *
   * @param {() => Promise<*>} fn - Async function to execute (or (modelName) => Promise if modelFallback enabled)
   * @param {object} [opts]
   * @param {string} [opts.agentType]     - GSD agent type for override lookup
   * @param {function} [opts.onRetry]     - Callback on retry: (attempt, failureType, backoffMs) => void
   * @param {AbortSignal} [opts.signal]   - AbortSignal to cancel retries
   * @param {boolean} [opts.modelFallback] - Enable model fallback when retries exhaust (default: false)
   * @param {function} [opts.onFallback]  - Callback on model fallback: (fromModel, toModel, attempt, error) => void
   * @returns {Promise<*>} Result of fn() — when modelFallback is used, returns
   *   { result, model, fallback_attempts, total_models_tried }
   * @throws {Error} Original error if all retries exhausted or failure is non-retryable
   */
  async executeWithPolicy(fn, opts) {
    const o = opts || {};
    const agentType = o.agentType || null;
    const onRetry = typeof o.onRetry === 'function' ? o.onRetry : null;
    const signal = o.signal || null;
    const useModelFallback = o.modelFallback === true;
    const onFallback = typeof o.onFallback === 'function' ? o.onFallback : null;

    let lastError;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check for abort signal
      if (signal && signal.aborted) {
        throw lastError || new MgwError('Retry aborted by signal', { code: 'RETRY_ABORTED' });
      }

      try {
        return await fn();
      } catch (err) {
        lastError = err;

        // Classify the failure
        const failureType = this._classifyError(err, agentType);

        // Check if we should retry
        if (!this.shouldRetry(failureType, agentType, attempt)) {
          // Retries exhausted or non-retryable — check model fallback
          if (useModelFallback && ModelFallbackEngine) {
            return this._attemptModelFallback(fn, {
              agentType,
              lastError: err,
              failureType,
              signal,
              onFallback,
            });
          }

          // No fallback — throw original error
          throw err;
        }

        // Calculate backoff
        const backoffMs = this.getBackoffMs(attempt);

        // Notify caller of retry
        if (onRetry) {
          try {
            onRetry(attempt, failureType, backoffMs);
          } catch (_) {
            // onRetry errors are non-fatal
          }
        }

        // Wait for backoff
        if (backoffMs > 0) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, backoffMs);

            // Handle abort during backoff
            if (signal) {
              const onAbort = () => {
                clearTimeout(timer);
                reject(lastError);
              };
              signal.addEventListener('abort', onAbort, { once: true });
              // Clean up listener when timer fires
              const origResolve = resolve;
              // eslint-disable-next-line no-param-reassign
              resolve = () => {
                signal.removeEventListener('abort', onAbort);
                origResolve();
              };
            }
          });
        }

        attempt++;
      }
    }
  }

  /**
   * Attempt model fallback after retry policy exhaustion.
   *
   * Creates a ModelFallbackEngine and delegates to executeWithFallback,
   * which tries the function with each model tier in the fallback chain.
   *
   * @param {function} fn - Original async function (must accept modelName arg for fallback)
   * @param {object} opts
   * @param {string} [opts.agentType]    - GSD agent type
   * @param {Error} opts.lastError       - Last error from retry exhaustion
   * @param {string} opts.failureType    - Classified failure type
   * @param {AbortSignal} [opts.signal]  - AbortSignal
   * @param {function} [opts.onFallback] - Fallback callback
   * @returns {Promise<{ result: *, model: string, fallback_attempts: number, total_models_tried: number }>}
   * @throws {Error} If fallback is disabled, unavailable, or all models exhausted
   * @private
   */
  async _attemptModelFallback(fn, opts) {
    const { agentType, lastError, failureType, signal, onFallback } = opts;

    try {
      const engine = new ModelFallbackEngine();

      // Check if fallback is enabled in config
      if (!engine.enabled) {
        throw lastError; // Fallback disabled — throw original error
      }

      // Delegate to model fallback engine
      return await engine.executeWithFallback(fn, {
        agentType: agentType || 'general-purpose',
        onFallback,
        signal,
      });
    } catch (fallbackErr) {
      // If the fallback itself failed, wrap with context
      if (ModelFallbackError && fallbackErr instanceof ModelFallbackError) {
        // Fallback chain exhausted — re-throw with fallback_attempts
        throw fallbackErr;
      }
      // Other errors (engine not enabled, config issues) — throw original
      throw lastError;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: error classification
  // -------------------------------------------------------------------------

  /**
   * Classify an error into an agent failure type string.
   *
   * Uses agent-errors.cjs classification first, then falls back to
   * generic retry.cjs classification.
   *
   * @param {Error} err       - The error to classify
   * @param {string} [agentType] - GSD agent type for context
   * @returns {string} Failure type key (e.g. 'timeout', 'permanent', 'transient')
   * @private
   */
  _classifyError(err, agentType) {
    // Try agent-specific classification first
    if (classifyAgentFailure) {
      const agentResult = classifyAgentFailure(err, { agentType });
      if (agentResult && agentResult.type) {
        return agentResult.type;
      }
    }

    // Fall back to generic classification
    const genericResult = classifyFailure(err);
    if (genericResult && genericResult.class) {
      // Map generic classes to policy keys
      // 'transient' from retry.cjs maps to 'timeout' in our policy
      // (generic transient errors get the timeout retry budget)
      if (genericResult.class === 'transient') return 'timeout';
      if (genericResult.class === 'needs-info') return 'needs-info';
      // 'permanent' is not retried
      return 'permanent';
    }

    // Unknown — treat as permanent (not retried)
    return 'permanent';
  }

  // -------------------------------------------------------------------------
  // Static: config loading
  // -------------------------------------------------------------------------

  /**
   * Load retry policy configuration from .mgw/config.json.
   *
   * Looks for a `retry_policies` section in the config file:
   * ```json
   * {
   *   "retry_policies": {
   *     "policies": {
   *       "timeout": 3,
   *       "malformed-output": 2
   *     },
   *     "backoff": {
   *       "baseMs": 10000
   *     },
   *     "agentOverrides": {
   *       "gsd-planner": { "timeout": 3 },
   *       "gsd-executor": { "malformed-output": 0 }
   *     }
   *   }
   * }
   * ```
   *
   * @param {string} [configPath] - Explicit path to config.json. If null,
   *   searches for .mgw/config.json relative to cwd.
   * @returns {{ policies?: object, backoff?: object, agentOverrides?: object }}
   */
  static loadConfig(configPath) {
    const empty = {};

    try {
      const cfgPath = configPath || path.join(process.cwd(), '.mgw', 'config.json');
      if (!fs.existsSync(cfgPath)) return empty;

      const raw = fs.readFileSync(cfgPath, 'utf-8');
      const config = JSON.parse(raw);

      if (!config || typeof config !== 'object') return empty;

      const section = config.retry_policies;
      if (!section || typeof section !== 'object') return empty;

      return {
        policies: section.policies && typeof section.policies === 'object' ? section.policies : undefined,
        backoff: section.backoff && typeof section.backoff === 'object' ? section.backoff : undefined,
        agentOverrides: section.agentOverrides && typeof section.agentOverrides === 'object' ? section.agentOverrides : undefined,
      };
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
  DEFAULT_RETRY_POLICIES,
  DEFAULT_BACKOFF_CONFIG,

  // Error class
  RetryPolicyError,

  // Engine
  RetryPolicyEngine,
};
