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
 * Layout (normal mode):
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ Header (1 row): title + keyboard hints                              │
 *   ├──── SearchBar (1 row): fuzzy input ────────────────────────────────┤
 *   ├──── IssueList (60%) ────┬──── DetailPane (40%) ────────────────────┤
 *   │                         │                                           │
 *   ├──── FilterBar (1 row) ──────────────────────────────────────────────┤
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Filter pane (overlay, shown when focusPane === 'filter'):
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ Header (1 row)                                                      │
 *   ├──── SearchBar (1 row) ──────────────────────────────────────────────┤
 *   ├──── IssueList (60%) ────┬──── Filter Pane (40%) ───────────────────┤
 *   │                         │  Labels                                   │
 *   │                         │    [ ] bug                                │
 *   │                         │    [x] enhancement                        │
 *   │                         │  Milestones                               │
 *   │                         │    [ ] v4                                 │
 *   │                         │  State                                    │
 *   │                         │    (*) open   ( ) closed   ( ) all        │
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
    content: ' MGW ISSUES  [/] search  [f] filter  [j/k] scroll  [Enter] select  [q] quit  [?] help',
    style: {
      fg: 'brightwhite',
      bg: 'brightblack',
      bold: true,
    },
    tags: false,
  });

  // ── Search bar (plain display box — input handled manually in keypress) ──
  const searchBar = blessed.box({
    top: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: 'Search: ',
    style: {
      fg: 'brightwhite',
      bg: 'black',
    },
  });

  // ── Issue list ───────────────────────────────────────────────────────────
  const issueList = blessed.list({
    top: 2,
    left: 0,
    width: '60%',
    height: '100%-5', // header + search + filterbar + status
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

  // ── Filter pane (overlays detail pane when active) ───────────────────────
  const filterPane = blessed.box({
    top: 2,
    left: '60%',
    width: '40%',
    height: '100%-5',
    label: ' Filters [f] close  [j/k] move  [Space] toggle  [c] clear ',
    style: {
      fg: 'brightwhite',
      bg: 'black',
      border: {
        fg: 'yellow',
        bold: true,
      },
      label: {
        fg: 'yellow',
      },
    },
    border: { type: 'line' },
    scrollable: true,
    keys: false,
    mouse: false,
    content: '',
    tags: false,
    hidden: true,
  });

  // ── Filter bar (summary row) ─────────────────────────────────────────────
  const filterBar = blessed.box({
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: ' Filter: none',
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

  // ── Help overlay ─────────────────────────────────────────────────────────
  const helpOverlay = blessed.box({
    top: 'center',
    left: 'center',
    width: 56,
    height: 22,
    label: ' Keyboard Shortcuts ',
    border: { type: 'line' },
    style: {
      fg: 'brightwhite',
      bg: 'black',
      border: { fg: 'cyan' },
      label: { fg: 'cyan' },
    },
    content: [
      '',
      '  Navigation',
      '    j / ↓       Scroll down',
      '    k / ↑       Scroll up',
      '    g / Home    Jump to top',
      '    G / End     Jump to bottom',
      '    PgDn        Page down',
      '    PgUp        Page up',
      '    Tab         Cycle pane focus',
      '    Shift+Tab   Cycle pane reverse',
      '',
      '  Actions',
      '    /           Open search',
      '    f           Open/close filter pane',
      '    Space       Toggle filter item',
      '    c           Clear all filters',
      '    Enter       Select issue',
      '    q / Esc     Quit / close overlay',
      '    Ctrl+C      Force quit',
      '    ?           Show this help',
      '',
    ].join('\n'),
    tags: false,
    hidden: true,
  });

  // Append all elements (order matters: overlays last)
  screen.append(header);
  screen.append(searchBar);
  screen.append(issueList);
  screen.append(detailPane);
  screen.append(filterPane);
  screen.append(filterBar);
  screen.append(statusBar);
  screen.append(helpOverlay);

  // State
  let lastState = null;
  let keyboardRef = null;
  let helpVisible = false;

  // ── Private helpers ──────────────────────────────────────────────────────

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
      `#${issue.number} \u2014 ${issue.title}`,
      '',
      `Labels:    ${labels}`,
      `Assignees: ${assignees}`,
      `Milestone: ${milestone}`,
      `Comments:  ${commentCount}`,
      `URL:       ${issue.url || ''}`,
      '',
      '\u2500'.repeat(40),
      '',
      issue.body || '(no description)',
    ].join('\n');
  }

  /**
   * Build the text content for the filter pane from a FilterState.
   *
   * @param {import('./filter.cjs').FilterState} filterState
   * @returns {string}
   * @private
   */
  function _formatFilterPane(filterState) {
    if (!filterState) return '(no filters available)';

    const lines = [];

    // ── Labels section ────────────────────────────────────────────────────
    const labelFocused = filterState.cursorSection === 'labels';
    lines.push(labelFocused ? ' > Labels' : '   Labels');

    if (filterState.availableLabels.length === 0) {
      lines.push('   (none)');
    } else {
      filterState.availableLabels.forEach((label, i) => {
        const checked = filterState.activeLabels.has(label) ? 'x' : ' ';
        const cursor = (labelFocused && i === filterState.cursorIndex) ? '>' : ' ';
        lines.push(`  ${cursor}[${checked}] ${label}`);
      });
    }

    lines.push('');

    // ── Milestones section ────────────────────────────────────────────────
    const msFocused = filterState.cursorSection === 'milestones';
    lines.push(msFocused ? ' > Milestones' : '   Milestones');

    if (filterState.availableMilestones.length === 0) {
      lines.push('   (none)');
    } else {
      filterState.availableMilestones.forEach((ms, i) => {
        const checked = filterState.activeMilestones.has(ms) ? 'x' : ' ';
        const cursor = (msFocused && i === filterState.cursorIndex) ? '>' : ' ';
        lines.push(`  ${cursor}[${checked}] ${ms}`);
      });
    }

    lines.push('');

    // ── State section ─────────────────────────────────────────────────────
    const stateFocused = filterState.cursorSection === 'state';
    lines.push(stateFocused ? ' > State' : '   State');

    const stateOptions = ['open', 'closed', 'all'];
    stateOptions.forEach((opt, i) => {
      const selected = filterState.activeState === opt ? '*' : ' ';
      const cursor = (stateFocused && i === filterState.cursorIndex) ? '>' : ' ';
      lines.push(`  ${cursor}(${selected}) ${opt}`);
    });

    return lines.join('\n');
  }

  /**
   * Build the filter bar summary string from a FilterState.
   *
   * @param {import('./filter.cjs').FilterState|null} filterState
   * @returns {string}
   * @private
   */
  function _formatFilterBar(filterState) {
    if (!filterState || filterState.isEmpty) {
      return ' Filter: none  [f] open filter pane';
    }

    const parts = [];

    if (filterState.activeLabels.size > 0) {
      parts.push(`Labels: ${Array.from(filterState.activeLabels).join(', ')}`);
    }
    if (filterState.activeMilestones.size > 0) {
      parts.push(`Milestone: ${Array.from(filterState.activeMilestones).join(', ')}`);
    }
    if (filterState.activeState !== 'open') {
      parts.push(`State: ${filterState.activeState}`);
    }

    return ` Filter: ${parts.join('  |  ')}  [f] edit  [c] clear`;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Render current state to the screen.
   *
   * @param {Object} state
   * @param {Object[]} state.filtered - Filtered issue list
   * @param {number} state.selectedIndex - Currently selected row
   * @param {string} state.query - Search query
   * @param {string} state.focusPane - Active focus: 'list'|'detail'|'filter'|'search'
   * @param {import('./filter.cjs').FilterState|null} [state.filterState] - Live filter state
   * @param {boolean} [state.helpVisible] - Whether to show the help overlay
   */
  function render(state) {
    lastState = state;
    const { filtered, selectedIndex, query, focusPane, filterState } = state;
    helpVisible = Boolean(state.helpVisible);

    // Update list items
    const items = filtered.map(_formatListItem);
    issueList.setItems(items);
    if (filtered.length > 0) {
      issueList.select(selectedIndex);
    }

    // Update search bar — plain display box, always safe to update
    const cursor = focusPane === 'search' ? '\u2588' : '';
    searchBar.setContent(`Search: ${query}${cursor}`);

    // Filter pane vs detail pane — mutually exclusive
    if (focusPane === 'filter') {
      detailPane.hide();
      filterPane.setContent(_formatFilterPane(filterState || null));
      filterPane.show();
    } else {
      filterPane.hide();
      const selectedIssue = filtered[selectedIndex] || null;
      detailPane.setContent(_formatDetail(selectedIssue));
      detailPane.show();
    }

    // Update filter bar
    filterBar.setContent(_formatFilterBar(filterState || null));

    // Update status bar
    const filterActive = filterState && !filterState.isEmpty;
    const filterHint = filterActive ? '  [c] clear filters' : '';
    const searchHint = focusPane === 'search'
      ? '  [Enter] apply  [Esc] cancel'
      : '  [/] search';
    statusBar.setContent(
      ` ${filtered.length} issue${filtered.length === 1 ? '' : 's'}` +
      (query ? ` matching "${query}"` : '') +
      searchHint +
      filterHint
    );

    // Help overlay
    if (helpVisible) {
      helpOverlay.show();
    } else {
      helpOverlay.hide();
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
      // Force-quit always works regardless of mode
      if (key.full === 'C-c' || ch === '\u0003') {
        keyboard.emit('force-quit');
        return;
      }

      // In search mode: handle all input manually
      if (lastState && lastState.focusPane === 'search') {
        const name = key.name || '';
        if (name === 'enter' || name === 'return') {
          keyboard.emit('search-exit');
        } else if (name === 'escape') {
          keyboard.updateSearch('');
          keyboard.emit('search-exit');
        } else if (name === 'backspace') {
          const q = lastState.query || '';
          keyboard.updateSearch(q.slice(0, -1));
        } else if (ch && ch.length === 1 && ch >= ' ') {
          keyboard.updateSearch((lastState.query || '') + ch);
        }
        return;
      }

      // In filter mode: j/k navigate within filter pane; Tab/Shift+Tab change section
      if (lastState && lastState.focusPane === 'filter') {
        const name = key.name || '';
        if (name === 'j' || key.full === 'down') {
          keyboard.emit('filter-scroll-down');
          return;
        }
        if (name === 'k' || key.full === 'up') {
          keyboard.emit('filter-scroll-up');
          return;
        }
        if (key.full === 'tab') {
          keyboard.emit('filter-next-section');
          return;
        }
        if (key.full === 'S-tab') {
          keyboard.emit('filter-prev-section');
          return;
        }
        // Space — toggle; Enter — close filter pane; f — close filter pane
        // Fall through to dispatch for these
      }

      // Normal mode: dispatch through key bindings
      keyboard.dispatch(key.full || ch || '', key);
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
