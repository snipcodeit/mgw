'use strict';

/**
 * lib/progress.cjs — Milestone progress bar for mgw:milestone output
 *
 * Renders an ASCII progress bar showing X/N issues complete.
 * Uses Catppuccin Macchiato ANSI colors when the terminal supports them.
 * Falls back to plain ASCII in non-TTY / CI / NO_COLOR environments.
 *
 * Usage:
 *   const { renderProgressBar, printMilestoneProgress } = require('./lib/progress.cjs');
 *
 *   // Render a progress bar string:
 *   const bar = renderProgressBar({ done: 4, total: 9 });
 *   // → "[████████░░░░░░░░░░░░] 4/9 issues complete"
 *
 *   // Print milestone progress to stdout:
 *   printMilestoneProgress({ done: 0, total: 9, label: 'v4 — Interactive CLI & TUI' });
 *
 * Pipeline stage icons printed alongside the bar:
 *   done      → ✓  (green)
 *   running   → ◆  (blue)
 *   failed    → ✗  (red)
 *   blocked   → ⊘  (yellow)
 *   pending   → ○  (dim)
 */

const { USE_COLOR } = require('./output.cjs');
const { STAGES } = require('./pipeline.cjs');

// ── Catppuccin Macchiato palette (subset) ─────────────────────────────────────
// Reference: https://github.com/catppuccin/catppuccin
// These are 256-color ANSI escape sequences so they degrade gracefully.

/** Whether the terminal supports rich ANSI output */
const SUPPORTS_COLOR = USE_COLOR;

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  // Catppuccin Macchiato — Green (issue 'done')
  green:  '\x1b[38;2;166;218;149m',
  // Catppuccin Macchiato — Blue (issue 'running')
  blue:   '\x1b[38;2;138;173;244m',
  // Catppuccin Macchiato — Red (issue 'failed')
  red:    '\x1b[38;2;237;135;150m',
  // Catppuccin Macchiato — Yellow (issue 'blocked')
  yellow: '\x1b[38;2;238;212;159m',
  // Catppuccin Macchiato — Peach (bar fill)
  peach:  '\x1b[38;2;245;169;127m',
  // Catppuccin Macchiato — Surface2 (bar empty)
  surface: '\x1b[38;2;91;96;120m',
  // Catppuccin Macchiato — Subtext1 (labels)
  subtext: '\x1b[38;2;184;192;224m',
};

/** Apply color only when terminal supports it */
function col(colorCode, text) {
  if (!SUPPORTS_COLOR) return text;
  return `${colorCode}${text}${C.reset}`;
}

/**
 * Render a single-line ASCII progress bar string.
 *
 * @param {object} opts
 * @param {number} opts.done    - Number of issues completed
 * @param {number} opts.total   - Total number of issues
 * @param {number} [opts.width] - Bar width in characters (default: 20)
 * @returns {string} Formatted progress bar line, e.g. "[████████░░░░░░░░░░░░] 4/9 issues complete"
 */
function renderProgressBar({ done, total, width = 20 }) {
  if (total === 0) return col(C.dim, '[──────────────────────] 0/0 issues');

  const pct = Math.min(done / total, 1);
  const filled = Math.round(pct * width);
  const empty = width - filled;

  const fillChar = '█';
  const emptyChar = '░';

  const fillStr = fillChar.repeat(filled);
  const emptyStr = emptyChar.repeat(empty);

  if (SUPPORTS_COLOR) {
    const bar = `${C.peach}${fillStr}${C.reset}${C.surface}${emptyStr}${C.reset}`;
    const fraction = `${C.bold}${done}/${total}${C.reset}`;
    const label = col(C.subtext, ' issues complete');
    return `[${bar}] ${fraction}${label}`;
  } else {
    return `[${fillStr}${emptyStr}] ${done}/${total} issues complete`;
  }
}

/**
 * Map a pipeline stage to its display icon and color.
 *
 * @param {string} stage - Pipeline stage value
 * @returns {{ icon: string, colored: string }}
 */
function stageIcon(stage) {
  switch (stage) {
    case STAGES.DONE:
    case STAGES.PR_CREATED:
      return { icon: '✓', colored: col(C.green, '✓') };
    case STAGES.EXECUTING:
    case STAGES.PLANNING:
    case STAGES.VERIFYING:
      return { icon: '◆', colored: col(C.blue,  '◆') };
    case STAGES.FAILED:
      return { icon: '✗', colored: col(C.red,   '✗') };
    case STAGES.BLOCKED:
      return { icon: '⊘', colored: col(C.yellow, '⊘') };
    default:
      return { icon: '○', colored: col(C.dim,   '○') };
  }
}

/**
 * Print the milestone progress block to stdout.
 *
 * Outputs:
 *   Progress: [████████░░░░░░░░░░░░] 4/9 issues complete
 *   #121 ✓  #122 ○  #123 ○  ...   (per-issue stage icons)
 *
 * @param {object} opts
 * @param {number}   opts.done           - Issues complete so far
 * @param {number}   opts.total          - Total issues in milestone
 * @param {string}   [opts.label]        - Milestone name (printed as header)
 * @param {Array}    [opts.issues]       - Array of { number, pipeline_stage } for per-issue icons
 * @param {number}   [opts.currentIssue] - Issue number currently running (shown as ◆)
 */
function printMilestoneProgress({ done, total, label, issues, currentIssue } = {}) {
  const bar = renderProgressBar({ done: done || 0, total: total || 0 });

  if (label) {
    const header = SUPPORTS_COLOR
      ? `${C.bold}${C.subtext}${label}${C.reset}`
      : label;
    process.stdout.write(`\n${header}\n`);
  }

  process.stdout.write(`Progress: ${bar}\n`);

  // Per-issue stage icons on one line (compact — shows up to 15 without wrapping)
  if (issues && issues.length > 0) {
    const parts = issues.map(({ number, pipeline_stage }) => {
      const s = number === currentIssue && pipeline_stage !== STAGES.DONE ? STAGES.EXECUTING : (pipeline_stage || STAGES.NEW);
      const { colored } = stageIcon(s);
      const numStr = SUPPORTS_COLOR
        ? `${C.dim}#${number}${C.reset}`
        : `#${number}`;
      return `${numStr}${colored}`;
    });
    process.stdout.write(`         ${parts.join('  ')}\n`);
  }

  process.stdout.write('\n');
}

module.exports = {
  renderProgressBar,
  printMilestoneProgress,
  stageIcon,
  SUPPORTS_COLOR,
};
