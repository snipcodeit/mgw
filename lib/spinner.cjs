'use strict';

/**
 * lib/spinner.cjs — Per-stage spinner for mgw:run pipeline steps
 *
 * Provides a simple TTY spinner that shows the active pipeline stage
 * with elapsed time. Falls back to plain log lines in non-TTY/CI environments.
 *
 * Respects the same TTY/CI/NO_COLOR detection as lib/output.cjs.
 */

const { IS_TTY, IS_CI, USE_COLOR, COLORS } = require('./output.cjs');

/** Spinner frames for animation */
const FRAMES = ['|', '/', '-', '\\'];

/** Whether the terminal supports live spinner updates */
const SUPPORTS_SPINNER = IS_TTY && !IS_CI;

/**
 * Create a new pipeline stage spinner.
 *
 * Usage:
 *   const s = createSpinner('validate');
 *   s.start();
 *   // ... do work ...
 *   s.succeed('Validated — issue #120 triaged');
 *
 * @returns {object} Spinner instance with start/succeed/fail/stop methods
 */
function createSpinner(stage) {
  let frameIndex = 0;
  let intervalId = null;
  let startTime = null;
  let lastLineLength = 0;

  /**
   * Clear the current spinner line (move cursor to start, erase line).
   */
  function clearLine() {
    if (!SUPPORTS_SPINNER) return;
    process.stdout.write('\r' + ' '.repeat(lastLineLength) + '\r');
  }

  /**
   * Write a spinner frame with stage label and elapsed time.
   */
  function render() {
    const frame = FRAMES[frameIndex % FRAMES.length];
    frameIndex++;

    const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
    const elapsedStr = elapsed > 0 ? ` (${elapsed}s)` : '';

    let line;
    if (USE_COLOR) {
      line = `${COLORS.cyan}${frame}${COLORS.reset} ${COLORS.bold}${stage}${COLORS.reset}${COLORS.dim}${elapsedStr}${COLORS.reset}`;
    } else {
      line = `${frame} ${stage}${elapsedStr}`;
    }

    if (SUPPORTS_SPINNER) {
      clearLine();
      process.stdout.write(line);
      // Track plain text length for clearing (strip ANSI codes approximation)
      lastLineLength = `${frame} ${stage}${elapsedStr}`.length;
    }
  }

  /**
   * Start the spinner animation.
   * In non-TTY mode, prints a simple "starting stage" line.
   * @param {string} [label] - Optional override for the stage label
   */
  function start(label) {
    if (label) stage = label;
    startTime = Date.now();

    if (SUPPORTS_SPINNER) {
      render();
      intervalId = setInterval(render, 100);
    } else {
      // Non-TTY: plain log line
      process.stdout.write(`[mgw] ${stage}...\n`);
    }
  }

  /**
   * Stop the spinner and print a success line.
   * @param {string} [message] - Optional completion message (defaults to stage name)
   */
  function succeed(message) {
    _stop();
    const text = message || stage;
    if (USE_COLOR) {
      process.stdout.write(`${COLORS.green}✓${COLORS.reset} ${text}\n`);
    } else {
      process.stdout.write(`[done] ${text}\n`);
    }
  }

  /**
   * Stop the spinner and print a failure line.
   * @param {string} [message] - Optional failure message (defaults to stage name)
   */
  function fail(message) {
    _stop();
    const text = message || stage;
    if (USE_COLOR) {
      process.stdout.write(`${COLORS.red}✗${COLORS.reset} ${text}\n`);
    } else {
      process.stdout.write(`[fail] ${text}\n`);
    }
  }

  /**
   * Stop the spinner without printing a result line.
   */
  function stop() {
    _stop();
  }

  /**
   * Internal: clear interval and erase spinner line.
   */
  function _stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    clearLine();
  }

  return { start, succeed, fail, stop };
}

/**
 * Wrap an async function call with a spinner for a named pipeline stage.
 *
 * Shows a spinner while fn() is running, then prints succeed/fail based
 * on whether fn() resolves or rejects.
 *
 * @param {string} stage - Human-readable stage name (e.g. 'validate', 'execute-gsd')
 * @param {Function} fn - Async function to run while spinner is active
 * @param {object} [opts]
 * @param {string} [opts.successMessage] - Message shown on success (default: stage)
 * @param {string} [opts.failMessage] - Message shown on failure (default: stage + ' failed')
 * @returns {Promise<*>} Resolves with fn()'s return value, rejects if fn() throws
 */
async function withSpinner(stage, fn, opts) {
  const o = opts || {};
  const spinner = createSpinner(stage);
  spinner.start();
  try {
    const result = await fn();
    spinner.succeed(o.successMessage || stage);
    return result;
  } catch (err) {
    spinner.fail(o.failMessage || `${stage} failed`);
    throw err;
  }
}

module.exports = {
  createSpinner,
  withSpinner,
  SUPPORTS_SPINNER
};
