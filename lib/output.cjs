'use strict';

/**
 * lib/output.cjs — Terminal output utilities
 *
 * TTY detection, colored output, JSON output mode.
 * Respects NO_COLOR, CI, and TTY detection for clean piped output.
 */

const IS_TTY = process.stdout.isTTY === true;
const IS_CI = Boolean(process.env.CI);
const USE_COLOR = IS_TTY && !IS_CI && !process.env.NO_COLOR;

/**
 * ANSI color codes (only applied when USE_COLOR is true)
 */
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m'
};

/**
 * Wrap text in an ANSI color code if USE_COLOR is true.
 * @param {string} text
 * @param {string} colorCode - ANSI escape sequence
 * @returns {string}
 */
function colorize(text, colorCode) {
  if (!USE_COLOR) return text;
  return `${colorCode}${text}${COLORS.reset}`;
}

/**
 * Format a status line with icon prefix.
 * In TTY mode: returns `icon + " " + message`.
 * In non-TTY mode: returns plain message.
 * @param {string} icon - Unicode icon or prefix character
 * @param {string} message
 * @returns {string}
 */
function statusLine(icon, message) {
  if (USE_COLOR) {
    return `${icon} ${message}`;
  }
  return message;
}

/**
 * Log an informational message to stdout.
 * @param {string} message
 */
function log(message) {
  console.log(message);
}

/**
 * Log an error message to stderr with red prefix in TTY.
 * @param {string} message
 */
function error(message) {
  const prefix = colorize('error:', COLORS.red);
  console.error(`${prefix} ${message}`);
}

/**
 * Log a verbose-level message. Only outputs if opts.verbose or opts.debug.
 * @param {string} message
 * @param {object} [opts]
 * @param {boolean} [opts.verbose]
 * @param {boolean} [opts.debug]
 */
function verbose(message, opts) {
  if (opts && (opts.verbose || opts.debug)) {
    console.log(colorize(`  ${message}`, COLORS.dim));
  }
}

/**
 * Log a debug-level message. Only outputs if opts.debug.
 * @param {string} message
 * @param {object} [opts]
 * @param {boolean} [opts.debug]
 */
function debug(message, opts) {
  if (opts && opts.debug) {
    console.log(colorize(`[debug] ${message}`, COLORS.dim));
  }
}

/**
 * Format data as pretty-printed JSON string.
 * @param {*} data
 * @returns {string}
 */
function formatJson(data) {
  return JSON.stringify(data, null, 2);
}

module.exports = {
  IS_TTY,
  IS_CI,
  USE_COLOR,
  COLORS,
  colorize,
  statusLine,
  log,
  error,
  verbose,
  debug,
  formatJson
};
