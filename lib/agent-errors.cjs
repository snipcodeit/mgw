'use strict';

/**
 * lib/agent-errors.cjs — Agent failure taxonomy for GSD agents
 *
 * Defines a formal taxonomy of GSD agent failure modes with structured
 * error codes, severity levels, and recommended recovery actions.
 *
 * Failure types:
 *   timeout            — agent exceeded turn limit
 *   malformed-output   — agent returned unparseable result
 *   partial-completion — agent completed some but not all tasks
 *   hallucination      — agent claimed success but artifacts missing
 *   permission-denied  — agent blocked by hook or sandbox
 *
 * Each failure type carries:
 *   - code       — machine-readable error code (AGENT_ERR_*)
 *   - name       — human-readable failure name
 *   - severity   — critical | high | medium | low
 *   - description — what happened
 *   - recovery   — recommended recovery action
 *   - retryable  — whether automatic retry is safe
 *
 * Integrates with:
 *   - lib/errors.cjs (MgwError base class)
 *   - lib/retry.cjs  (pipeline retry infrastructure)
 */

const { MgwError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// Severity levels (ordered: critical > high > medium > low)
// ---------------------------------------------------------------------------

/**
 * Ordered severity levels for agent failures.
 * Higher numeric weight = more severe.
 */
const SEVERITY_LEVELS = Object.freeze({
  critical: { name: 'critical', weight: 4, description: 'Agent produced dangerous or misleading results' },
  high:     { name: 'high',     weight: 3, description: 'Agent failed to produce usable output' },
  medium:   { name: 'medium',   weight: 2, description: 'Agent partially succeeded but gaps remain' },
  low:      { name: 'low',      weight: 1, description: 'Minor issue, likely recoverable automatically' },
});

// ---------------------------------------------------------------------------
// Agent failure type definitions
// ---------------------------------------------------------------------------

/**
 * The five canonical agent failure types.
 *
 * Each entry is a frozen descriptor with:
 *   code, name, severity, description, recovery, retryable
 */
const AGENT_FAILURE_TYPES = Object.freeze({
  timeout: Object.freeze({
    code: 'AGENT_ERR_TIMEOUT',
    name: 'timeout',
    severity: 'high',
    description: 'Agent exceeded turn limit or wall-clock timeout without completing its task',
    recovery: 'Retry with reduced scope — split the task into smaller sub-tasks or increase the turn budget',
    retryable: true,
  }),

  'malformed-output': Object.freeze({
    code: 'AGENT_ERR_MALFORMED_OUTPUT',
    name: 'malformed-output',
    severity: 'high',
    description: 'Agent returned output that cannot be parsed or does not match the expected format',
    recovery: 'Retry with explicit format instructions — add structured output examples to the prompt',
    retryable: true,
  }),

  'partial-completion': Object.freeze({
    code: 'AGENT_ERR_PARTIAL_COMPLETION',
    name: 'partial-completion',
    severity: 'medium',
    description: 'Agent completed some but not all assigned tasks — partial artifacts exist',
    recovery: 'Spawn a continuation agent for the remaining tasks using the partial output as context',
    retryable: true,
  }),

  hallucination: Object.freeze({
    code: 'AGENT_ERR_HALLUCINATION',
    name: 'hallucination',
    severity: 'critical',
    description: 'Agent claimed success but required artifacts are missing or do not match expectations',
    recovery: 'Reject all results and retry with a verification-first approach — require artifact proof before completion',
    retryable: false,
  }),

  'permission-denied': Object.freeze({
    code: 'AGENT_ERR_PERMISSION_DENIED',
    name: 'permission-denied',
    severity: 'high',
    description: 'Agent was blocked by a pre-commit hook, sandbox restriction, or file permission',
    recovery: 'Escalate to human operator — review sandbox configuration and hook settings',
    retryable: false,
  }),
});

// ---------------------------------------------------------------------------
// Error code to failure type lookup (reverse map)
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const _codeToType = new Map();
for (const [key, def] of Object.entries(AGENT_FAILURE_TYPES)) {
  _codeToType.set(def.code, { key, ...def });
}

// ---------------------------------------------------------------------------
// AgentFailureError class
// ---------------------------------------------------------------------------

/**
 * Error class for agent failures.
 * Extends MgwError with agent-specific context fields.
 */
class AgentFailureError extends MgwError {
  /**
   * @param {string} message - Human-readable error description
   * @param {object} [opts]
   * @param {string} [opts.agentType]   - GSD agent type (gsd-planner, gsd-executor, etc.)
   * @param {string} [opts.failureType] - Failure type key from AGENT_FAILURE_TYPES
   * @param {string[]} [opts.artifacts] - List of expected artifacts that are missing/malformed
   * @param {string} [opts.stage]       - Pipeline stage where failure occurred
   * @param {number} [opts.issueNumber] - Related GitHub issue number
   * @param {Error}  [opts.cause]       - Original error
   */
  constructor(message, opts) {
    const o = opts || {};
    const failureDef = o.failureType ? AGENT_FAILURE_TYPES[o.failureType] : null;
    const code = failureDef ? failureDef.code : 'AGENT_ERR_UNKNOWN';

    super(message, { code, stage: o.stage, issueNumber: o.issueNumber, cause: o.cause });
    this.name = 'AgentFailureError';
    this.agentType = o.agentType || null;
    this.failureType = o.failureType || null;
    this.artifacts = Array.isArray(o.artifacts) ? o.artifacts : [];
  }

  /**
   * Get the full failure type definition for this error.
   * @returns {object|null}
   */
  getFailureDefinition() {
    if (!this.failureType) return null;
    return AGENT_FAILURE_TYPES[this.failureType] || null;
  }

  /**
   * Get the severity level for this error.
   * @returns {string|null}
   */
  getSeverity() {
    const def = this.getFailureDefinition();
    return def ? def.severity : null;
  }

  /**
   * Check whether this failure type is safe to auto-retry.
   * @returns {boolean}
   */
  isRetryable() {
    const def = this.getFailureDefinition();
    return def ? def.retryable : false;
  }
}

// ---------------------------------------------------------------------------
// Classification function
// ---------------------------------------------------------------------------

/**
 * Error message patterns mapped to agent failure types.
 * Matched case-insensitively against error.message.
 *
 * Order matters — first match wins. More specific patterns come first.
 */
const CLASSIFICATION_PATTERNS = [
  // Timeout patterns
  { pattern: 'turn limit', type: 'timeout' },
  { pattern: 'max turns', type: 'timeout' },
  { pattern: 'context window exhausted', type: 'timeout' },
  { pattern: 'exceeded.*timeout', type: 'timeout' },
  { pattern: 'agent timed out', type: 'timeout' },
  { pattern: 'wall.?clock.*exceeded', type: 'timeout' },

  // Malformed output patterns
  { pattern: 'unparseable', type: 'malformed-output' },
  { pattern: 'invalid json', type: 'malformed-output' },
  { pattern: 'parse error', type: 'malformed-output' },
  { pattern: 'unexpected token', type: 'malformed-output' },
  { pattern: 'malformed output', type: 'malformed-output' },
  { pattern: 'missing required field', type: 'malformed-output' },
  { pattern: 'output format', type: 'malformed-output' },
  { pattern: 'expected.*format', type: 'malformed-output' },

  // Partial completion patterns
  { pattern: 'partial completion', type: 'partial-completion' },
  { pattern: 'incomplete.*tasks', type: 'partial-completion' },
  { pattern: 'completed.*of.*tasks', type: 'partial-completion' },
  { pattern: 'remaining tasks', type: 'partial-completion' },
  { pattern: 'some tasks failed', type: 'partial-completion' },

  // Hallucination patterns (check before generic patterns)
  { pattern: 'artifacts? missing', type: 'hallucination' },
  { pattern: 'claimed success.*missing', type: 'hallucination' },
  { pattern: 'file.*not found.*after', type: 'hallucination' },
  { pattern: 'verification failed.*not exist', type: 'hallucination' },
  { pattern: 'hallucination', type: 'hallucination' },
  { pattern: 'phantom', type: 'hallucination' },

  // Permission denied patterns
  { pattern: 'permission denied', type: 'permission-denied' },
  { pattern: 'access denied', type: 'permission-denied' },
  { pattern: 'hook.*failed', type: 'permission-denied' },
  { pattern: 'pre.?commit.*rejected', type: 'permission-denied' },
  { pattern: 'sandbox.*blocked', type: 'permission-denied' },
  { pattern: 'sandbox.*violation', type: 'permission-denied' },
  { pattern: 'eacces', type: 'permission-denied' },
];

/**
 * Classify a raw error into an agent failure type.
 *
 * Examines the error message (and optional context) to determine which
 * agent failure type best describes the failure. Falls back to null
 * if no pattern matches (caller should use lib/retry.cjs for generic
 * classification in that case).
 *
 * @param {object} error - Error object with at least a `message` field
 * @param {string} [error.message] - Error message to classify
 * @param {string} [error.code] - Error code (e.g. 'EACCES')
 * @param {object} [context] - Optional context for richer classification
 * @param {string} [context.agentType] - GSD agent type that failed
 * @param {string[]} [context.expectedArtifacts] - Artifacts the agent was expected to produce
 * @param {string[]} [context.actualArtifacts] - Artifacts the agent actually produced
 * @param {number} [context.tasksTotal] - Total number of tasks assigned
 * @param {number} [context.tasksCompleted] - Number of tasks completed
 * @returns {{ type: string, code: string, severity: string, confidence: 'high'|'medium'|'low' }|null}
 */
function classifyAgentFailure(error, context) {
  if (!error || typeof error !== 'object') return null;

  const message = (error.message || '').toLowerCase();
  const code = (error.code || '').toLowerCase();
  const ctx = context || {};

  // --- Context-based classification (higher confidence) ---

  // Artifact mismatch → hallucination
  if (ctx.expectedArtifacts && ctx.actualArtifacts) {
    const expected = new Set(ctx.expectedArtifacts);
    const actual = new Set(ctx.actualArtifacts);
    const missing = [...expected].filter(a => !actual.has(a));
    if (missing.length > 0 && ctx.tasksCompleted > 0) {
      const def = AGENT_FAILURE_TYPES.hallucination;
      return { type: 'hallucination', code: def.code, severity: def.severity, confidence: 'high' };
    }
  }

  // Partial task completion
  if (typeof ctx.tasksTotal === 'number' && typeof ctx.tasksCompleted === 'number') {
    if (ctx.tasksCompleted > 0 && ctx.tasksCompleted < ctx.tasksTotal) {
      const def = AGENT_FAILURE_TYPES['partial-completion'];
      return { type: 'partial-completion', code: def.code, severity: def.severity, confidence: 'high' };
    }
  }

  // --- Error code classification ---

  if (code === 'eacces' || code === 'eperm') {
    const def = AGENT_FAILURE_TYPES['permission-denied'];
    return { type: 'permission-denied', code: def.code, severity: def.severity, confidence: 'high' };
  }

  // --- Message pattern classification ---

  for (const { pattern, type } of CLASSIFICATION_PATTERNS) {
    const regex = new RegExp(pattern, 'i');
    if (regex.test(message)) {
      const def = AGENT_FAILURE_TYPES[type];
      return { type, code: def.code, severity: def.severity, confidence: 'medium' };
    }
  }

  // No match — return null so caller can fall back to generic retry classification
  return null;
}

// ---------------------------------------------------------------------------
// Recovery action lookup
// ---------------------------------------------------------------------------

/**
 * Get the recommended recovery action for a failure type.
 *
 * @param {string} failureType - Failure type key (e.g. 'timeout', 'hallucination')
 * @returns {{ action: string, retryable: boolean, severity: string }|null}
 */
function getRecoveryAction(failureType) {
  const def = AGENT_FAILURE_TYPES[failureType];
  if (!def) return null;

  return {
    action: def.recovery,
    retryable: def.retryable,
    severity: def.severity,
  };
}

// ---------------------------------------------------------------------------
// Retry eligibility check
// ---------------------------------------------------------------------------

/**
 * Check whether a failure type is safe for automatic retry.
 *
 * @param {string} failureType - Failure type key
 * @returns {boolean}
 */
function isRetryable(failureType) {
  const def = AGENT_FAILURE_TYPES[failureType];
  return def ? def.retryable : false;
}

// ---------------------------------------------------------------------------
// Severity comparison utility
// ---------------------------------------------------------------------------

/**
 * Compare two severity levels.
 * Returns positive if a is more severe, negative if b is more severe, 0 if equal.
 *
 * @param {string} a - Severity level name
 * @param {string} b - Severity level name
 * @returns {number}
 */
function compareSeverity(a, b) {
  const weightA = (SEVERITY_LEVELS[a] || { weight: 0 }).weight;
  const weightB = (SEVERITY_LEVELS[b] || { weight: 0 }).weight;
  return weightA - weightB;
}

// ---------------------------------------------------------------------------
// Failure type lookup by error code
// ---------------------------------------------------------------------------

/**
 * Look up a failure type definition by its error code.
 *
 * @param {string} errorCode - Error code (e.g. 'AGENT_ERR_TIMEOUT')
 * @returns {object|null} Failure type definition or null
 */
function getFailureByCode(errorCode) {
  return _codeToType.get(errorCode) || null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  AGENT_FAILURE_TYPES,
  SEVERITY_LEVELS,

  // Error class
  AgentFailureError,

  // Classification
  classifyAgentFailure,

  // Recovery
  getRecoveryAction,
  isRetryable,

  // Utilities
  compareSeverity,
  getFailureByCode,
};
