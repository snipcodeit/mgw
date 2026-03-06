'use strict';

/**
 * lib/agent-criticality.cjs — Agent spawn point criticality classification
 *
 * Classifies each Task() spawn point in the MGW pipeline as either:
 *   - critical: failure blocks the pipeline (retry/fallback before dead-letter)
 *   - advisory: failure is non-fatal (log warning, continue pipeline)
 *
 * Advisory agents provide quality-of-life improvements (comment classification,
 * plan checking, verification) but the pipeline can produce a valid PR without
 * their output. Critical agents produce artifacts the pipeline cannot proceed
 * without (plans, executed code, PRs).
 *
 * Integrates with:
 *   - lib/retry.cjs          (generic retry infrastructure)
 *   - lib/retry-policy.cjs   (policy-driven retry, from #232 — safe-imported)
 *   - lib/errors.cjs         (MgwError base class)
 *
 * @module agent-criticality
 */

const { MgwError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// Safe import of retry-policy.cjs (dependency from #232, may not be merged)
// ---------------------------------------------------------------------------

let _RetryPolicyEngine = null;
try {
  const retryPolicy = require('./retry-policy.cjs');
  _RetryPolicyEngine = retryPolicy.RetryPolicyEngine;
} catch (_) {
  // retry-policy.cjs not available — graceful degradation for the
  // graceful degradation module itself
}

// ---------------------------------------------------------------------------
// Criticality classification
// ---------------------------------------------------------------------------

/**
 * Criticality levels for agent spawn points.
 * @enum {string}
 */
const CRITICALITY = Object.freeze({
  CRITICAL: 'critical',
  ADVISORY: 'advisory',
});

/**
 * Maps each Task() spawn point identifier to its criticality level.
 *
 * Spawn point identifiers match the agent's role in the pipeline,
 * not its GSD agent type (since the same agent type can have different
 * criticality depending on where it's used).
 *
 * Key:
 *   triage/   — spawn points in commands/run/triage.md
 *   quick/    — spawn points in commands/run/execute.md (quick route)
 *   milestone/— spawn points in commands/run/execute.md (milestone route)
 *   pr/       — spawn points in commands/run/pr-create.md
 */
const CRITICALITY_MAP = Object.freeze({
  // --- triage.md spawn points ---
  'comment-classifier':       CRITICALITY.ADVISORY,

  // --- execute.md quick-route spawn points ---
  'planner':                  CRITICALITY.CRITICAL,
  'plan-checker':             CRITICALITY.ADVISORY,
  'executor':                 CRITICALITY.CRITICAL,
  'verifier':                 CRITICALITY.ADVISORY,

  // --- execute.md milestone-route spawn points ---
  'milestone-planner':        CRITICALITY.CRITICAL,
  'milestone-executor':       CRITICALITY.CRITICAL,
  'milestone-verifier':       CRITICALITY.ADVISORY,

  // --- pr-create.md spawn points ---
  'pr-creator':               CRITICALITY.CRITICAL,
});

/**
 * Check whether a spawn point is classified as advisory (non-blocking).
 *
 * @param {string} spawnPoint - Spawn point identifier from CRITICALITY_MAP
 * @returns {boolean} True if advisory, false if critical or unknown
 */
function isAdvisory(spawnPoint) {
  return CRITICALITY_MAP[spawnPoint] === CRITICALITY.ADVISORY;
}

/**
 * Check whether a spawn point is classified as critical (pipeline-blocking).
 *
 * Unknown spawn points default to critical (fail-safe: don't silently
 * swallow errors for unclassified agents).
 *
 * @param {string} spawnPoint - Spawn point identifier from CRITICALITY_MAP
 * @returns {boolean} True if critical or unknown
 */
function isCritical(spawnPoint) {
  const level = CRITICALITY_MAP[spawnPoint];
  // Unknown spawn points are treated as critical (fail-safe)
  return level !== CRITICALITY.ADVISORY;
}

// ---------------------------------------------------------------------------
// Advisory agent wrapper
// ---------------------------------------------------------------------------

/**
 * Error subclass for advisory agent failures that were gracefully degraded.
 * These are logged but do not halt the pipeline.
 */
class AdvisoryAgentWarning extends MgwError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.spawnPoint] - The spawn point that failed
   * @param {string} [opts.agentType]  - GSD agent type
   * @param {Error}  [opts.cause]      - Original error
   */
  constructor(message, opts) {
    const o = opts || {};
    super(message, {
      code: 'ADVISORY_AGENT_DEGRADED',
      stage: o.stage,
      issueNumber: o.issueNumber,
      cause: o.cause,
    });
    this.name = 'AdvisoryAgentWarning';
    this.spawnPoint = o.spawnPoint || null;
    this.agentType = o.agentType || null;
  }
}

/**
 * Wrap an async function (typically a Task() agent spawn) with advisory
 * graceful degradation. If the function throws and the spawn point is
 * advisory, the error is caught, a warning is logged to stderr, and
 * the specified fallback value is returned.
 *
 * For critical spawn points, the error is re-thrown unchanged.
 *
 * @param {() => Promise<*>} fn         - Async function to execute
 * @param {string} spawnPoint           - Spawn point identifier from CRITICALITY_MAP
 * @param {object} [context]            - Context for logging
 * @param {number} [context.issueNumber] - Issue being processed
 * @param {string} [context.agentType]   - GSD agent type
 * @param {*}      [context.fallback]    - Value to return on advisory failure (default: null)
 * @returns {Promise<*>} Result of fn() or fallback value
 * @throws {Error} Re-throws if spawn point is critical
 */
async function wrapAdvisoryAgent(fn, spawnPoint, context) {
  const ctx = context || {};
  const fallback = ctx.hasOwnProperty('fallback') ? ctx.fallback : null;

  try {
    return await fn();
  } catch (err) {
    if (isAdvisory(spawnPoint)) {
      // Advisory: log warning and return fallback
      const warning = new AdvisoryAgentWarning(
        `Advisory agent "${spawnPoint}" failed gracefully: ${err.message}`,
        {
          spawnPoint,
          agentType: ctx.agentType || null,
          issueNumber: ctx.issueNumber || null,
          cause: err,
        }
      );

      // Log to stderr (non-blocking, never throws)
      try {
        const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        process.stderr.write(
          `[${ts}] MGW WARNING: ${warning.message}\n` +
          `  spawn_point=${spawnPoint} agent_type=${ctx.agentType || 'unknown'} ` +
          `issue=#${ctx.issueNumber || '?'}\n` +
          `  original_error=${err.message}\n`
        );
      } catch (_) {
        // Even logging failed — truly swallow
      }

      return fallback;
    }

    // Critical: re-throw (existing retry/dead-letter flow handles it)
    throw err;
  }
}

/**
 * Get a human-readable summary of all spawn point classifications.
 * Useful for diagnostics and documentation.
 *
 * @returns {Array<{spawnPoint: string, criticality: string}>}
 */
function getClassificationSummary() {
  return Object.entries(CRITICALITY_MAP).map(([sp, crit]) => ({
    spawnPoint: sp,
    criticality: crit,
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  CRITICALITY,
  CRITICALITY_MAP,

  // Query functions
  isAdvisory,
  isCritical,
  getClassificationSummary,

  // Wrapper
  wrapAdvisoryAgent,

  // Error class
  AdvisoryAgentWarning,
};
