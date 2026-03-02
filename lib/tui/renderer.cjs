'use strict';

/**
 * Renderer adapter — wraps the selected TUI library (neo-blessed).
 *
 * The renderer is the only file that has a hard dependency on a TUI library.
 * All other lib/tui/*.cjs modules are pure logic. To swap libraries, only
 * this file changes.
 *
 * Current implementation: neo-blessed (optional dependency)
 *
 * Graceful behavior when neo-blessed is not installed:
 *   - createRenderer() returns a no-op renderer
 *   - isInteractive() in graceful.cjs will have already gated TUI launch
 *   - If somehow reached without blessed, render() is a safe no-op
 *
 * @module renderer
 */

let blessed;
try {
  blessed = require('neo-blessed');
} catch (_e) {
  try {
    blessed = require('blessed');
  } catch (_e2) {
    blessed = null;
  }
}

/**
 * Create a renderer for the current environment.
 *
 * Returns a blessed-based renderer if the library is available,
 * or a no-op renderer otherwise.
 *
 * @returns {Renderer}
 */
function createRenderer() {
  if (!blessed) {
    return createNoopRenderer();
  }
  return createBlessedRenderer();
}

// ─────────────────────────────────────────────
// Blessed Renderer
// ─────────────────────────────────────────────

/**
 * Create a full blessed-based renderer.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ Header (1 row): title + keyboard hints                              │
 *   ├──── SearchBar (1 row): fuzzy input ────────────────────────────────┤
 *   ├──── IssueList (60%) ────┬──── DetailPane (40%) ────────────────────┤
 *   │                         │                                           │
 *   ├──── FilterBar (1 row) ──────────────────────────────────────────────┤
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * @returns {Renderer}
 * @private
 */
function createBlessedRenderer() {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'MGW Issues',
    cursor: {
      artificial: true,
      shape: 'line',
      blink: true,
      color: null,
    },
  });

  // ── Header ──────────────────────────────────────────────────────────────
  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' MGW ISSUES         [/] search  [j/k] scroll  [Enter] select  [q] quit  [?] help',
    style: {
      fg: 'brightwhite',
      bg: 'brightblack',
      bold: true,
    },
    tags: false,
  });

  // ── Search bar ──────────────────────────────────────────────────────────
  const searchBar = blessed.textbox({
    top: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: 'Search: ',
    style: {
      fg: 'brightwhite',
      bg: 'black',
    },
    keys: true,
    mouse: true,
    inputOnFocus: true,
  });

  // ── Issue list ───────────────────────────────────────────────────────────
  const issueList = blessed.list({
    top: 2,
    left: 0,
    width: '60%',
    height: '100%-5', // header + search + filter + status
    style: {
      fg: 'brightwhite',
      bg: 'black',
      selected: {
        fg: 'black',
        bg: 'magenta',
      },
      border: {
        fg: 'cyan',
      },
    },
    border: { type: 'line' },
    scrollable: true,
    keys: true,
    mouse: true,
    items: [],
  });

  // ── Detail pane ──────────────────────────────────────────────────────────
  const detailPane = blessed.box({
    top: 2,
    left: '60%',
    width: '40%',
    height: '100%-5',
    style: {
      fg: 'brightwhite',
      bg: 'black',
      border: {
        fg: 'cyan',
      },
    },
    border: { type: 'line' },
    scrollable: true,
    keys: true,
    mouse: true,
    content: '',
    tags: false,
  });

  // ── Filter bar ───────────────────────────────────────────────────────────
  const filterBar = blessed.box({
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: ' Filter: [All labels] [All milestones] [Assignee: @me]',
    style: {
      fg: 'yellow',
      bg: 'black',
    },
  });

  // ── Status bar ───────────────────────────────────────────────────────────
  const statusBar = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' 0 issues',
    style: {
      fg: 'brightwhite',
      bg: 'brightblack',
    },
  });

  // Append all elements
  screen.append(header);
  screen.append(searchBar);
  screen.append(issueList);
  screen.append(detailPane);
  screen.append(filterBar);
  screen.append(statusBar);

  // State
  let lastState = null;
  let keyboardRef = null;

  /**
   * Format a single issue for the list display.
   *
   * @param {Object} issue
   * @returns {string}
   * @private
   */
  function _formatListItem(issue) {
    const num = `#${issue.number}`.padEnd(6);
    const title = (issue.title || '').slice(0, 45);
    return `${num} ${title}`;
  }

  /**
   * Format an issue for the detail pane.
   *
   * @param {Object} issue
   * @returns {string}
   * @private
   */
  function _formatDetail(issue) {
    if (!issue) return '(no issue selected)';

    const labels = (issue.labels || [])
      .map((l) => (typeof l === 'object' ? l.name : l))
      .join(', ') || 'none';

    const assignees = (issue.assignees || [])
      .map((a) => (typeof a === 'object' ? a.login : a))
      .join(', ') || 'unassigned';

    const milestone = issue.milestone
      ? (typeof issue.milestone === 'object' ? issue.milestone.title : issue.milestone)
      : 'none';

    const commentCount = Array.isArray(issue.comments)
      ? issue.comments.length
      : (issue.comments || 0);

    return [
      `#${issue.number} — ${issue.title}`,
      '',
      `Labels:    ${labels}`,
      `Assignees: ${assignees}`,
      `Milestone: ${milestone}`,
      `Comments:  ${commentCount}`,
      `URL:       ${issue.url || ''}`,
      '',
      '─'.repeat(40),
      '',
      issue.body || '(no description)',
    ].join('\n');
  }

  /**
   * Render current state to the screen.
   *
   * @param {Object} state
   * @param {Object[]} state.filtered - Filtered issue list
   * @param {number} state.selectedIndex - Currently selected row
   * @param {string} state.query - Search query
   * @param {string} state.focusPane - Active focus: 'list'|'detail'|'filter'|'search'
   */
  function render(state) {
    lastState = state;
    const { filtered, selectedIndex, query, focusPane } = state;

    // Update list items
    const items = filtered.map(_formatListItem);
    issueList.setItems(items);
    if (filtered.length > 0) {
      issueList.select(selectedIndex);
    }

    // Update detail pane
    const selectedIssue = filtered[selectedIndex] || null;
    detailPane.setContent(_formatDetail(selectedIssue));

    // Update search bar — don't overwrite content while user is actively typing
    if (screen.focused !== searchBar) {
      searchBar.setContent(`Search: ${query}`);
    }

    // Update status bar
    statusBar.setContent(` ${filtered.length} issue${filtered.length === 1 ? '' : 's'}${query ? ` for "${query}"` : ''}`);

    // Sync focus to the active pane
    if (focusPane === 'search') {
      searchBar.focus();
    } else {
      issueList.focus();
    }

    screen.render();
  }

  /**
   * Wire keyboard events from a KeyboardHandler to the screen.
   *
   * @param {import('./keyboard.cjs').KeyboardHandler} keyboard
   */
  function startKeyboard(keyboard) {
    keyboardRef = keyboard;

    screen.on('keypress', (ch, key) => {
      // Let the search textbox handle its own input when focused
      if (screen.focused === searchBar) return;
      const raw = key.full || ch || '';
      keyboard.dispatch(raw, key);
    });

    // Submit (Enter) in search bar — apply query and return focus to list
    searchBar.on('submit', (value) => {
      keyboard.updateSearch(value || '');
      issueList.focus();
    });

    // Cancel (Escape) in search bar — clear query and return focus to list
    searchBar.on('cancel', () => {
      searchBar.clearValue();
      keyboard.updateSearch('');
      issueList.focus();
    });
  }

  /**
   * Clean up the blessed screen and restore terminal.
   */
  function destroy() {
    try {
      screen.destroy();
    } catch (_e) {
      // Ignore errors during cleanup
    }
  }

  return { render, startKeyboard, destroy };
}

// ─────────────────────────────────────────────
// No-op Renderer (when blessed not installed)
// ─────────────────────────────────────────────

/**
 * Create a no-op renderer for when blessed is not available.
 *
 * render() is a safe no-op — isInteractive() should have prevented reaching here,
 * but this ensures no crash if library goes missing after initial check.
 *
 * @returns {Renderer}
 * @private
 */
function createNoopRenderer() {
  return {
    render(_state) {
      // No-op — blessed not installed. Static table was shown by graceful.cjs.
    },
    startKeyboard(_keyboard) {
      // No-op
    },
    destroy() {
      // No-op
    },
  };
}

module.exports = { createRenderer };
