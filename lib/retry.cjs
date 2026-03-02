'use strict';

/**
 * lib/retry.cjs — Retry, backoff, and failure-handling infrastructure
 *
 * Provides failure taxonomy (transient / permanent / needs-info),
 * exponential backoff with jitter, and immutable issue-state helpers
 * for tracking retry attempts across pipeline stages.
 *
 * Failure taxonomy:
 *   transient   — temporary conditions; safe to retry automatically
 *   permanent   — unrecoverable without human intervention
 *   needs-info  — issue data is ambiguous or incomplete; requires author input
 */

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 300000;

/**
 * HTTP status codes that indicate a transient (retryable) server-side error.
 */
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * HTTP status codes that indicate a permanent (non-retryable) client-side error.
 */
const PERMANENT_STATUS_CODES = new Set([400, 401, 404, 422]);

/**
 * Error message substrings that classify a failure as transient.
 * Matched case-insensitively against error.message.
 */
const TRANSIENT_MESSAGE_PATTERNS = [
  'network timeout',
  'econnreset',
  'econnrefused',
  'etimedout',
  'socket hang up',
  'worktree lock',
  'model overload',
  'rate limit',
  'too many requests',
  'service unavailable',
  'bad gateway',
  'gateway timeout'
];

/**
 * Error message substrings that classify a failure as needs-info.
 * Matched case-insensitively against error.message.
 */
const NEEDS_INFO_MESSAGE_PATTERNS = [
  'ambiguous',
  'missing required field',
  'contradictory requirements',
  'issue body'
];

/**
 * Classify a failure as transient, permanent, or needs-info.
 *
 * Accepts an error object with optional fields:
 *   { status, message, code }
 *
 * Classification priority:
 *   1. HTTP status code (if present)
 *   2. Message pattern matching (transient before needs-info)
 *   3. Default to permanent (fail safe — unknown errors require investigation)
 *
 * @param {object} error - Error descriptor
 * @param {number} [error.status] - HTTP response status code
 * @param {string} [error.message] - Error message string
 * @param {string} [error.code] - Node.js error code (e.g. 'ECONNRESET')
 * @returns {{ class: 'transient'|'permanent'|'needs-info', reason: string }}
 */
function classifyFailure(error) {
  if (!error || typeof error !== 'object') {
    return { class: 'permanent', reason: 'no error object provided' };
  }

  const status = error.status;
  const message = (error.message || '').toLowerCase();
  const code = (error.code || '').toLowerCase();

  // --- HTTP status code classification ---

  if (typeof status === 'number') {
    // 429 Too Many Requests — always transient
    if (status === 429) {
      return { class: 'transient', reason: 'rate limit (HTTP 429)' };
    }

    // 5xx server errors — transient (external infrastructure issue)
    if (TRANSIENT_STATUS_CODES.has(status)) {
      return { class: 'transient', reason: `server error (HTTP ${status})` };
    }

    // 403 Forbidden — permanent (non-rate-limit; quota or auth issue)
    if (status === 403) {
      return { class: 'permanent', reason: 'forbidden (HTTP 403 — non-rate-limit)' };
    }

    // Other 4xx — permanent (client-side issue; no point retrying)
    if (status >= 400 && status < 500) {
      return { class: 'permanent', reason: `client error (HTTP ${status})` };
    }
  }

  // --- Node.js error code classification ---

  if (code) {
    const networkCodes = new Set([
      'econnreset', 'econnrefused', 'etimedout', 'enotfound', 'epipe'
    ]);
    if (networkCodes.has(code)) {
      return { class: 'transient', reason: `network error (${code.toUpperCase()})` };
    }

    if (code === 'enoent') {
      // Missing file — likely GSD tools not present; permanent
      return { class: 'permanent', reason: 'file not found (ENOENT) — GSD tools may be missing' };
    }
  }

  // --- Message pattern classification (transient first) ---

  for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
    if (message.includes(pattern)) {
      return { class: 'transient', reason: `transient condition detected: "${pattern}"` };
    }
  }

  for (const pattern of NEEDS_INFO_MESSAGE_PATTERNS) {
    if (message.includes(pattern)) {
      return { class: 'needs-info', reason: `issue requires clarification: "${pattern}"` };
    }
  }

  // --- Default: permanent (unknown errors are not safe to retry blindly) ---

  return {
    class: 'permanent',
    reason: 'unknown error — classified as permanent to prevent runaway retries'
  };
}

/**
 * Determine whether an issue state is eligible for another retry attempt.
 *
 * Returns false if:
 *   - retry_count has reached or exceeded MAX_RETRIES
 *   - dead_letter is set to true (issue was manually quarantined)
 *
 * @param {object} issueState - Active issue state object from .mgw/active/*.json
 * @param {number} [issueState.retry_count] - Number of retries attempted so far
 * @param {boolean} [issueState.dead_letter] - True if issue is quarantined
 * @returns {boolean}
 */
function canRetry(issueState) {
  if (!issueState || typeof issueState !== 'object') return false;

  if (issueState.dead_letter === true) return false;

  const count = typeof issueState.retry_count === 'number' ? issueState.retry_count : 0;
  return count < MAX_RETRIES;
}

/**
 * Return a new issue state with retry_count incremented by one.
 * Immutable — does not modify the input object.
 *
 * @param {object} issueState - Active issue state object
 * @returns {object} New state with incremented retry_count
 */
function incrementRetry(issueState) {
  const current = typeof issueState.retry_count === 'number' ? issueState.retry_count : 0;
  return Object.assign({}, issueState, { retry_count: current + 1 });
}

/**
 * Return a new issue state with all retry fields cleared.
 * Immutable — does not modify the input object.
 *
 * Clears: retry_count, last_failure_class, dead_letter.
 *
 * @param {object} issueState - Active issue state object
 * @returns {object} New state with retry fields reset
 */
function resetRetryState(issueState) {
  return Object.assign({}, issueState, {
    retry_count: 0,
    last_failure_class: null,
    dead_letter: false
  });
}

/**
 * Calculate the backoff delay in milliseconds for a given retry count.
 *
 * Uses exponential backoff with full jitter:
 *   base = min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2^retryCount)
 *   delay = random(0, base)
 *
 * This avoids thundering-herd effects when multiple issues retry simultaneously.
 * The minimum base at retryCount=0 is BACKOFF_BASE_MS (5000ms), so the actual
 * delay is in [0, 5000ms] on the first retry, [0, 10000ms] on the second, etc.
 *
 * @param {number} retryCount - Number of retries already attempted (0-based)
 * @returns {number} Delay in milliseconds (integer, non-negative)
 */
function getBackoffMs(retryCount) {
  const count = Math.max(0, Math.floor(retryCount));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, count));
  // Full jitter: uniform random in [0, base]
  return Math.floor(Math.random() * (base + 1));
}

module.exports = {
  // Constants
  MAX_RETRIES,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,

  // Core functions
  classifyFailure,
  canRetry,
  incrementRetry,
  resetRetryState,
  getBackoffMs
};
