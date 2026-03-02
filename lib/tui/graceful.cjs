'use strict';

/**
 * Graceful TTY detection and non-interactive fallback rendering.
 *
 * When MGW is run in a pipe, CI, or other non-TTY context, the TUI
 * cannot render. This module provides detection and a static table
 * fallback that is pipe-friendly.
 *
 * @module graceful
 */

/**
 * Check whether the current process is running in an interactive terminal.
 *
 * Returns false when:
 *   - stdout is not a TTY (piped output, redirection)
 *   - CI environment variable is set (GitHub Actions, CircleCI, etc.)
 *   - MGW_NO_TUI environment variable is set (user override)
 *
 * @returns {boolean}
 */
function isInteractive() {
  if (process.env.MGW_NO_TUI === '1') return false;
  if (process.env.CI) return false;
  return Boolean(process.stdout.isTTY);
}

/**
 * Render a static issues table to stdout.
 * Pipe-friendly: no ANSI codes, no interactive elements.
 *
 * Column widths:
 *   #       — 6 chars
 *   Title   — 40 chars
 *   Labels  — 25 chars
 *   Age     — 5 chars
 *
 * @param {Object[]} issues - Array of issue objects
 * @param {number} [issues[].number]
 * @param {string} [issues[].title]
 * @param {Array}  [issues[].labels]
 * @param {string} [issues[].createdAt] - ISO 8601 date string
 */
function renderStaticTable(issues) {
  if (!issues || issues.length === 0) {
    console.log('No issues found.');
    return;
  }

  const COL = { num: 6, title: 40, labels: 25, age: 5 };
  const totalWidth = COL.num + 1 + COL.title + 1 + COL.labels + 1 + COL.age;

  const header = [
    '#'.padEnd(COL.num),
    'Title'.padEnd(COL.title),
    'Labels'.padEnd(COL.labels),
    'Age'.padEnd(COL.age),
  ].join(' ');

  const separator = '-'.repeat(totalWidth);

  console.log(header);
  console.log(separator);

  for (const issue of issues) {
    const num = String(issue.number || '').padEnd(COL.num);
    const title = _truncate(issue.title || '', COL.title).padEnd(COL.title);
    const labelStr = _formatLabels(issue.labels).slice(0, COL.labels).padEnd(COL.labels);
    const age = _relativeAge(issue.createdAt).padEnd(COL.age);

    console.log([num, title, labelStr, age].join(' '));
  }

  console.log(separator);
  console.log(`${issues.length} issue${issues.length === 1 ? '' : 's'}`);
}

/**
 * Format labels array to a comma-separated string.
 *
 * Handles both string arrays and label objects with a `.name` property.
 *
 * @param {Array} labels
 * @returns {string}
 * @private
 */
function _formatLabels(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return '';
  return labels
    .map((l) => (typeof l === 'object' && l !== null ? l.name : String(l)))
    .join(', ');
}

/**
 * Truncate a string to maxLen, appending '…' if truncated.
 *
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 * @private
 */
function _truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026'; // '…'
}

/**
 * Convert an ISO 8601 date string to a human-readable relative age.
 *
 * @param {string} dateStr - ISO 8601 date string
 * @returns {string} e.g. 'today', '3d', '2w', '1mo', '1yr'
 * @private
 */
function _relativeAge(dateStr) {
  if (!dateStr) return '-';

  let ms;
  try {
    ms = Date.now() - new Date(dateStr).getTime();
  } catch (e) {
    return '-';
  }

  if (ms < 0) return 'now';

  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);

  if (days === 0) return hours > 0 ? `${hours}h` : minutes > 0 ? `${minutes}m` : 'now';
  if (days === 1) return '1d';
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}yr`;
}

module.exports = { isInteractive, renderStaticTable };
