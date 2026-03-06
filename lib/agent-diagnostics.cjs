'use strict';

/**
 * lib/agent-diagnostics.cjs — Structured diagnostic logger for agent executions
 *
 * Captures per-agent-invocation telemetry (timing, turns, output size, exit
 * reason, failure classification) and persists it as individual JSON files
 * under .mgw/diagnostics/.
 *
 * All operations are non-blocking: logging failures are silently swallowed
 * to ensure the pipeline is never halted by diagnostic infrastructure.
 *
 * Diagnostic entry schema:
 *   agent_type             — GSD agent type (gsd-planner, gsd-executor, etc.)
 *   prompt_hash            — hash of the prompt sent to the agent
 *   start_time             — ISO timestamp when agent was spawned
 *   end_time               — ISO timestamp when agent completed
 *   duration_ms            — wall-clock execution time in milliseconds
 *   turn_count             — number of turns/iterations the agent used
 *   exit_reason            — why the agent stopped (success, error, timeout, etc.)
 *   output_size            — size of agent output in bytes
 *   failure_classification — null on success, or classification from agent-errors.cjs
 *   issue_number           — GitHub issue being worked
 *   timestamp              — entry creation timestamp
 *
 * Integrates with:
 *   - lib/agent-errors.cjs (classifyAgentFailure — graceful fallback if unavailable)
 *   - lib/logger.cjs       (pattern reference for non-blocking logging)
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/** Default max age for diagnostic entries (days) */
const DEFAULT_MAX_AGE_DAYS = 30;

// ---------------------------------------------------------------------------
// Diagnostics directory
// ---------------------------------------------------------------------------

/**
 * Get the diagnostics directory path (.mgw/diagnostics/ under repo root).
 * Creates the directory if it does not exist.
 *
 * @param {string} [repoRoot] - Repository root. Defaults to cwd.
 * @returns {string} Absolute path to diagnostics directory
 */
function getDiagnosticsDir(repoRoot) {
  const root = repoRoot || process.cwd();
  const diagDir = path.join(root, '.mgw', 'diagnostics');
  try {
    if (!fs.existsSync(diagDir)) {
      fs.mkdirSync(diagDir, { recursive: true });
    }
  } catch {
    // Non-blocking: if we cannot create the directory, writes will fail
    // gracefully later
  }
  return diagDir;
}

// ---------------------------------------------------------------------------
// Hash utility
// ---------------------------------------------------------------------------

/**
 * Compute a short SHA-256 hash of a string.
 *
 * @param {string} input - String to hash
 * @returns {string} First 12 hex characters of SHA-256 digest
 */
function shortHash(input) {
  if (!input || typeof input !== 'string') return 'none';
  try {
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
  } catch {
    return 'none';
  }
}

// ---------------------------------------------------------------------------
// Agent failure classification (graceful fallback)
// ---------------------------------------------------------------------------

/**
 * Attempt to classify an agent failure using lib/agent-errors.cjs.
 * Falls back gracefully if the module is unavailable (e.g. PR #238 not merged).
 *
 * @param {Error} error - The error that occurred
 * @param {object} [context] - Optional classification context
 * @returns {object|null} Classification result or null
 */
function classifyFailure(error, context) {
  if (!error) return null;

  try {
    const { classifyAgentFailure } = require('./agent-errors.cjs');
    return classifyAgentFailure(error, context);
  } catch {
    // agent-errors.cjs not available — fall back to basic classification
    // using lib/retry.cjs patterns
    try {
      const { classifyFailure: retryClassify } = require('./retry.cjs');
      const result = retryClassify(error);
      return {
        type: result.class,
        code: 'AGENT_ERR_UNKNOWN',
        severity: result.class === 'transient' ? 'low' : 'high',
        confidence: 'low',
      };
    } catch {
      // Neither module available — return minimal classification
      return {
        type: 'unknown',
        code: 'AGENT_ERR_UNKNOWN',
        severity: 'medium',
        confidence: 'low',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Write diagnostic entry
// ---------------------------------------------------------------------------

/**
 * Write a single diagnostic entry to .mgw/diagnostics/.
 *
 * File name format: <issueNumber>-<timestamp>.json
 * where timestamp is ISO format with colons replaced by hyphens for
 * filesystem compatibility.
 *
 * Non-blocking: all errors are swallowed. Returns true on success, false
 * on failure. Callers should never need to wrap this in try/catch.
 *
 * @param {object} entry - Diagnostic entry to write
 * @param {string} entry.agent_type - GSD agent type
 * @param {string} [entry.prompt_hash] - Hash of the prompt sent
 * @param {string} entry.start_time - ISO timestamp when agent started
 * @param {string} entry.end_time - ISO timestamp when agent finished
 * @param {number} entry.duration_ms - Execution time in milliseconds
 * @param {number} [entry.turn_count] - Number of agent turns
 * @param {string} entry.exit_reason - Why the agent stopped
 * @param {number} [entry.output_size] - Output size in bytes
 * @param {object|null} [entry.failure_classification] - Failure classification or null
 * @param {number} entry.issue_number - GitHub issue number
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - Repository root
 * @returns {boolean} True if write succeeded, false otherwise
 */
function writeDiagnosticEntry(entry, opts) {
  try {
    const o = opts || {};
    const diagDir = getDiagnosticsDir(o.repoRoot);

    const issueNum = entry.issue_number || 0;
    // Create filesystem-safe timestamp
    const ts = (entry.timestamp || new Date().toISOString())
      .replace(/:/g, '-')
      .replace(/\./g, '-');

    const fileName = `${issueNum}-${ts}.json`;
    const filePath = path.join(diagDir, fileName);

    const record = {
      agent_type: entry.agent_type || 'unknown',
      prompt_hash: entry.prompt_hash || 'none',
      start_time: entry.start_time || null,
      end_time: entry.end_time || null,
      duration_ms: typeof entry.duration_ms === 'number' ? entry.duration_ms : null,
      turn_count: typeof entry.turn_count === 'number' ? entry.turn_count : null,
      exit_reason: entry.exit_reason || 'unknown',
      output_size: typeof entry.output_size === 'number' ? entry.output_size : null,
      failure_classification: entry.failure_classification || null,
      issue_number: issueNum,
      timestamp: entry.timestamp || new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
    return true;
  } catch {
    // Non-blocking: swallow all write errors
    return false;
  }
}

// ---------------------------------------------------------------------------
// Diagnostic logger factory
// ---------------------------------------------------------------------------

/**
 * Create a diagnostic logger bound to a specific agent invocation.
 *
 * Usage:
 *   const logger = createDiagnosticLogger({
 *     agentType: 'gsd-executor',
 *     issueNumber: 230,
 *     promptHash: shortHash(prompt),
 *   });
 *   logger.start();
 *   // ... agent executes ...
 *   logger.finish({
 *     exitReason: 'success',
 *     turnCount: 12,
 *     outputSize: 4096,
 *   });
 *
 * @param {object} opts
 * @param {string} opts.agentType - GSD agent type (gsd-planner, gsd-executor, etc.)
 * @param {number} opts.issueNumber - GitHub issue being worked
 * @param {string} [opts.promptHash] - Hash of the prompt (use shortHash() to generate)
 * @param {string} [opts.repoRoot] - Repository root for diagnostics dir
 * @returns {{ start: () => void, finish: (result: object) => boolean }}
 */
function createDiagnosticLogger(opts) {
  const o = opts || {};
  let startTime = null;

  return {
    /**
     * Record the start of agent execution.
     * Can be called multiple times; only the last call is used.
     */
    start() {
      try {
        startTime = new Date().toISOString();
      } catch {
        // Non-blocking
      }
    },

    /**
     * Record the end of agent execution and write the diagnostic entry.
     *
     * @param {object} result
     * @param {string} result.exitReason - Why the agent stopped (success, error, timeout, etc.)
     * @param {number} [result.turnCount] - Number of turns the agent used
     * @param {number} [result.outputSize] - Size of agent output in bytes
     * @param {Error}  [result.error] - Error object if the agent failed
     * @param {object} [result.classificationContext] - Context for failure classification
     * @returns {boolean} True if write succeeded
     */
    finish(result) {
      try {
        const r = result || {};
        const endTime = new Date().toISOString();
        const start = startTime || endTime;

        // Calculate duration
        const durationMs = new Date(endTime).getTime() - new Date(start).getTime();

        // Classify failure if error is present
        let failureClassification = null;
        if (r.error) {
          failureClassification = classifyFailure(r.error, r.classificationContext || {
            agentType: o.agentType,
          });
        }

        return writeDiagnosticEntry({
          agent_type: o.agentType || 'unknown',
          prompt_hash: o.promptHash || 'none',
          start_time: start,
          end_time: endTime,
          duration_ms: durationMs,
          turn_count: typeof r.turnCount === 'number' ? r.turnCount : null,
          exit_reason: r.exitReason || 'unknown',
          output_size: typeof r.outputSize === 'number' ? r.outputSize : null,
          failure_classification: failureClassification,
          issue_number: o.issueNumber || 0,
          timestamp: endTime,
        }, { repoRoot: o.repoRoot });
      } catch {
        // Non-blocking: swallow all errors
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Prune old diagnostics
// ---------------------------------------------------------------------------

/**
 * Remove diagnostic entries older than the specified age.
 *
 * Scans .mgw/diagnostics/, parses file modification times, and removes
 * files older than maxAgeDays. Non-blocking: errors on individual files
 * are silently skipped.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays] - Maximum age in days (default: 30)
 * @param {string} [opts.repoRoot] - Repository root
 * @returns {{ removed: number, errors: number, total: number }}
 */
function pruneDiagnostics(opts) {
  const result = { removed: 0, errors: 0, total: 0 };

  try {
    const o = opts || {};
    const maxAgeDays = typeof o.maxAgeDays === 'number' ? o.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
    const diagDir = getDiagnosticsDir(o.repoRoot);

    if (!fs.existsSync(diagDir)) return result;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffMs = cutoff.getTime();

    let files;
    try {
      files = fs.readdirSync(diagDir).filter(f => f.endsWith('.json'));
    } catch {
      return result;
    }

    result.total = files.length;

    for (const file of files) {
      try {
        const filePath = path.join(diagDir, file);
        const stat = fs.statSync(filePath);

        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
          result.removed++;
        }
      } catch {
        result.errors++;
      }
    }
  } catch {
    // Non-blocking: swallow top-level errors
  }

  return result;
}

// ---------------------------------------------------------------------------
// Read diagnostics
// ---------------------------------------------------------------------------

/**
 * Read diagnostic entries with optional filters.
 *
 * Returns parsed diagnostic entries sorted by timestamp descending
 * (most recent first).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - Repository root
 * @param {number} [opts.issueNumber] - Filter by issue number
 * @param {string} [opts.agentType] - Filter by agent type
 * @param {string} [opts.since] - ISO date string — only entries after this date
 * @param {number} [opts.limit] - Maximum number of entries to return
 * @returns {object[]} Array of diagnostic entries
 */
function readDiagnostics(opts) {
  try {
    const o = opts || {};
    const diagDir = getDiagnosticsDir(o.repoRoot);

    if (!fs.existsSync(diagDir)) return [];

    let files;
    try {
      files = fs.readdirSync(diagDir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    // Parse since date if provided
    let sinceMs = null;
    if (o.since) {
      try {
        sinceMs = new Date(o.since).getTime();
      } catch {
        // Invalid date — ignore filter
      }
    }

    const entries = [];

    for (const file of files) {
      try {
        const filePath = path.join(diagDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const entry = JSON.parse(content);

        // Apply filters
        if (o.issueNumber && entry.issue_number !== o.issueNumber) continue;
        if (o.agentType && entry.agent_type !== o.agentType) continue;
        if (sinceMs && entry.timestamp) {
          const entryMs = new Date(entry.timestamp).getTime();
          if (entryMs < sinceMs) continue;
        }

        entries.push(entry);
      } catch {
        // Skip unparseable files
        continue;
      }
    }

    // Sort by timestamp descending (most recent first)
    entries.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });

    // Apply limit
    if (typeof o.limit === 'number' && o.limit > 0 && entries.length > o.limit) {
      return entries.slice(0, o.limit);
    }

    return entries;
  } catch {
    // Non-blocking
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Directory
  getDiagnosticsDir,

  // Logger factory
  createDiagnosticLogger,

  // Low-level write
  writeDiagnosticEntry,

  // Maintenance
  pruneDiagnostics,

  // Read/query
  readDiagnostics,

  // Utilities
  shortHash,

  // Constants
  DEFAULT_MAX_AGE_DAYS,
};
