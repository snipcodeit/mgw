'use strict';

/**
 * lib/diagnostic-hooks.cjs — Diagnostic capture hooks for Task() agent spawns
 *
 * Provides a wrapper pattern for instrumenting Task() agent spawns with
 * diagnostic capture from lib/agent-diagnostics.cjs. All operations are
 * non-blocking: if diagnostic capture fails, a warning is logged and
 * pipeline execution continues normally.
 *
 * Usage in mgw:run pipeline (pseudocode in command .md files):
 *
 *   ```bash
 *   # Before spawning agent
 *   DIAG_ID=$(node -e "
 *   const dh = require('${REPO_ROOT}/lib/diagnostic-hooks.cjs');
 *   const id = dh.beforeAgentSpawn({
 *     agentType: 'gsd-planner',
 *     issueNumber: ${ISSUE_NUMBER},
 *     prompt: PROMPT_TEXT,
 *     repoRoot: '${REPO_ROOT}'
 *   });
 *   process.stdout.write(id);
 *   " 2>/dev/null || echo "")
 *
 *   # Spawn Task() agent ...
 *
 *   # After agent completes
 *   node -e "
 *   const dh = require('${REPO_ROOT}/lib/diagnostic-hooks.cjs');
 *   dh.afterAgentSpawn({
 *     diagId: '${DIAG_ID}',
 *     exitReason: 'success',
 *     outputSize: ${OUTPUT_SIZE:-0},
 *     repoRoot: '${REPO_ROOT}'
 *   });
 *   " 2>/dev/null || true
 *   ```
 *
 * The diagId is an opaque handle that links the before/after calls.
 * Internally it stores start timestamps in a module-level Map so
 * that duration can be computed on finish.
 *
 * Integrates with:
 *   - lib/agent-diagnostics.cjs (createDiagnosticLogger, shortHash)
 *
 * @module diagnostic-hooks
 */

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// In-flight tracking (module-level Map)
// ---------------------------------------------------------------------------

/**
 * Tracks in-flight agent spawns by diagId.
 * Each entry stores: { agentType, issueNumber, promptHash, startTime, repoRoot }
 * @type {Map<string, object>}
 */
const inFlight = new Map();

// ---------------------------------------------------------------------------
// Lazy-load agent-diagnostics (graceful fallback)
// ---------------------------------------------------------------------------

/**
 * Attempt to load agent-diagnostics.cjs. Returns null if unavailable.
 * Caches the result after first attempt.
 * @returns {object|null}
 */
let _diagModule = undefined;
function getDiagModule() {
  if (_diagModule !== undefined) return _diagModule;
  try {
    _diagModule = require('./agent-diagnostics.cjs');
  } catch {
    // agent-diagnostics.cjs not available (PR #239 not merged yet)
    _diagModule = null;
  }
  return _diagModule;
}

// ---------------------------------------------------------------------------
// Generate diagnostic ID
// ---------------------------------------------------------------------------

/**
 * Generate a unique diagnostic ID for linking before/after calls.
 * Format: <agentType>-<timestamp>-<random>
 *
 * @param {string} agentType - GSD agent type
 * @returns {string} Unique diagnostic ID
 */
function generateDiagId(agentType) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${agentType || 'unknown'}-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Before agent spawn
// ---------------------------------------------------------------------------

/**
 * Call before spawning a Task() agent. Records start time, computes
 * prompt hash, and returns a diagId for use in afterAgentSpawn().
 *
 * Non-blocking: returns empty string on any error.
 *
 * @param {object} opts
 * @param {string} opts.agentType - GSD agent type (gsd-planner, gsd-executor, etc.)
 * @param {number} opts.issueNumber - GitHub issue being worked
 * @param {string} [opts.prompt] - Full prompt text (will be hashed, not stored)
 * @param {string} [opts.repoRoot] - Repository root
 * @returns {string} diagId handle for afterAgentSpawn(), or empty string on error
 */
function beforeAgentSpawn(opts) {
  try {
    const o = opts || {};
    const diagId = generateDiagId(o.agentType);

    // Hash the prompt if agent-diagnostics is available
    let promptHash = 'none';
    const diag = getDiagModule();
    if (diag && diag.shortHash && o.prompt) {
      promptHash = diag.shortHash(o.prompt);
    }

    inFlight.set(diagId, {
      agentType: o.agentType || 'unknown',
      issueNumber: o.issueNumber || 0,
      promptHash,
      startTime: new Date().toISOString(),
      repoRoot: o.repoRoot || process.cwd(),
    });

    return diagId;
  } catch (err) {
    // Non-blocking: log warning and return empty
    try {
      console.error(`WARNING: diagnostic-hooks beforeAgentSpawn failed: ${err.message}`);
    } catch {
      // Even console.error failed — truly swallow
    }
    return '';
  }
}

// ---------------------------------------------------------------------------
// After agent spawn
// ---------------------------------------------------------------------------

/**
 * Call after a Task() agent completes. Records end time, computes duration,
 * writes diagnostic entry, and cleans up in-flight tracking.
 *
 * Non-blocking: returns false on any error.
 *
 * @param {object} opts
 * @param {string} opts.diagId - Handle from beforeAgentSpawn()
 * @param {string} opts.exitReason - Why the agent stopped (success, error, timeout, etc.)
 * @param {number} [opts.outputSize] - Size of agent output in bytes
 * @param {number} [opts.turnCount] - Number of agent turns/iterations
 * @param {Error}  [opts.error] - Error object if the agent failed
 * @param {string} [opts.repoRoot] - Repository root (override)
 * @returns {boolean} True if diagnostic entry was written, false otherwise
 */
function afterAgentSpawn(opts) {
  try {
    const o = opts || {};
    const diagId = o.diagId || '';

    // Look up in-flight data
    const flight = inFlight.get(diagId);
    if (!flight) {
      // No matching beforeAgentSpawn — still try to write what we can
      const diag = getDiagModule();
      if (diag && diag.writeDiagnosticEntry) {
        return diag.writeDiagnosticEntry({
          agent_type: 'unknown',
          prompt_hash: 'none',
          start_time: null,
          end_time: new Date().toISOString(),
          duration_ms: null,
          exit_reason: o.exitReason || 'unknown',
          output_size: typeof o.outputSize === 'number' ? o.outputSize : null,
          failure_classification: null,
          issue_number: 0,
          timestamp: new Date().toISOString(),
        }, { repoRoot: o.repoRoot });
      }
      return false;
    }

    // Clean up in-flight tracking
    inFlight.delete(diagId);

    const endTime = new Date().toISOString();
    const durationMs = new Date(endTime).getTime() - new Date(flight.startTime).getTime();

    // Classify failure if error present
    let failureClassification = null;
    const diag = getDiagModule();
    if (o.error && diag) {
      try {
        // Use agent-diagnostics classifyFailure if available
        const { classifyFailure } = diag;
        if (typeof classifyFailure === 'function') {
          failureClassification = classifyFailure(o.error, { agentType: flight.agentType });
        }
      } catch {
        // Classification failed — continue without it
      }
    }

    // Write diagnostic entry
    if (diag && diag.writeDiagnosticEntry) {
      return diag.writeDiagnosticEntry({
        agent_type: flight.agentType,
        prompt_hash: flight.promptHash,
        start_time: flight.startTime,
        end_time: endTime,
        duration_ms: durationMs,
        turn_count: typeof o.turnCount === 'number' ? o.turnCount : null,
        exit_reason: o.exitReason || 'unknown',
        output_size: typeof o.outputSize === 'number' ? o.outputSize : null,
        failure_classification: failureClassification,
        issue_number: flight.issueNumber,
        timestamp: endTime,
      }, { repoRoot: flight.repoRoot });
    }

    return false;
  } catch (err) {
    // Non-blocking: log warning
    try {
      console.error(`WARNING: diagnostic-hooks afterAgentSpawn failed: ${err.message}`);
    } catch {
      // Swallow
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Convenience: wrap an entire agent spawn
// ---------------------------------------------------------------------------

/**
 * High-level wrapper that calls beforeAgentSpawn, runs a callback,
 * and calls afterAgentSpawn. Designed for programmatic use (not pseudocode).
 *
 * Example:
 *   const result = await wrapAgentSpawn({
 *     agentType: 'gsd-executor',
 *     issueNumber: 231,
 *     prompt: fullPrompt,
 *   }, async () => {
 *     return await someAgentCall();
 *   });
 *
 * Non-blocking: diagnostic failures never propagate to the caller.
 * The callback's errors DO propagate normally.
 *
 * @param {object} opts - Same as beforeAgentSpawn opts
 * @param {Function} fn - Async function to execute (the agent spawn)
 * @returns {Promise<*>} Result of fn()
 */
async function wrapAgentSpawn(opts, fn) {
  let diagId = '';
  try {
    diagId = beforeAgentSpawn(opts);
  } catch {
    // Non-blocking
  }

  let result;
  let spawnError = null;
  try {
    result = await fn();
  } catch (err) {
    spawnError = err;
  }

  try {
    afterAgentSpawn({
      diagId,
      exitReason: spawnError ? 'error' : 'success',
      error: spawnError || undefined,
      repoRoot: opts.repoRoot,
    });
  } catch {
    // Non-blocking
  }

  if (spawnError) throw spawnError;
  return result;
}

// ---------------------------------------------------------------------------
// Pending count (for testing/debugging)
// ---------------------------------------------------------------------------

/**
 * Returns the number of in-flight agent spawns that have been started
 * but not yet finished.
 *
 * @returns {number}
 */
function pendingCount() {
  return inFlight.size;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  beforeAgentSpawn,
  afterAgentSpawn,
  wrapAgentSpawn,
  generateDiagId,
  pendingCount,
};
