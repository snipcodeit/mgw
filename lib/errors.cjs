'use strict';

/**
 * lib/errors.cjs — Typed error hierarchy for MGW
 *
 * All errors extend MgwError for unified catch/handle patterns.
 * Each error carries a `code` string for programmatic classification
 * and optional `stage`/`issueNumber` for pipeline context.
 */

/**
 * Base error for all MGW operations.
 */
class MgwError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.code] - Machine-readable error code
   * @param {string} [opts.stage] - Pipeline stage where error occurred
   * @param {number} [opts.issueNumber] - Related GitHub issue number
   * @param {Error}  [opts.cause] - Original error
   */
  constructor(message, opts) {
    super(message);
    this.name = 'MgwError';
    const o = opts || {};
    this.code = o.code || 'MGW_ERROR';
    this.stage = o.stage || null;
    this.issueNumber = o.issueNumber || null;
    if (o.cause) this.cause = o.cause;
  }
}

/**
 * GitHub API error — wraps failures from `gh` CLI calls.
 */
class GitHubApiError extends MgwError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status] - HTTP status code
   * @param {string} [opts.endpoint] - API endpoint or gh subcommand
   */
  constructor(message, opts) {
    const o = opts || {};
    super(message, { code: 'GITHUB_API_ERROR', ...o });
    this.name = 'GitHubApiError';
    this.status = o.status || null;
    this.endpoint = o.endpoint || null;
  }
}

/**
 * GSD tool invocation error.
 */
class GsdToolError extends MgwError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.command] - GSD subcommand that failed
   */
  constructor(message, opts) {
    const o = opts || {};
    super(message, { code: 'GSD_TOOL_ERROR', ...o });
    this.name = 'GsdToolError';
    this.command = o.command || null;
  }
}

/**
 * State file read/write/validation error.
 */
class StateError extends MgwError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.filePath] - State file path
   */
  constructor(message, opts) {
    const o = opts || {};
    super(message, { code: 'STATE_ERROR', ...o });
    this.name = 'StateError';
    this.filePath = o.filePath || null;
  }
}

/**
 * Subprocess or network timeout error.
 */
class TimeoutError extends MgwError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] - Timeout duration in milliseconds
   * @param {string} [opts.operation] - Description of the timed-out operation
   */
  constructor(message, opts) {
    const o = opts || {};
    super(message, { code: 'TIMEOUT_ERROR', ...o });
    this.name = 'TimeoutError';
    this.timeoutMs = o.timeoutMs || null;
    this.operation = o.operation || null;
  }
}

/**
 * Claude CLI not available (not installed or not authenticated).
 */
class ClaudeNotAvailableError extends MgwError {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {'not-installed'|'not-authenticated'|'check-failed'} [opts.reason]
   */
  constructor(message, opts) {
    const o = opts || {};
    super(message, { code: 'CLAUDE_NOT_AVAILABLE', ...o });
    this.name = 'ClaudeNotAvailableError';
    this.reason = o.reason || null;
  }
}

module.exports = {
  MgwError,
  GitHubApiError,
  GsdToolError,
  StateError,
  TimeoutError,
  ClaudeNotAvailableError,
};
