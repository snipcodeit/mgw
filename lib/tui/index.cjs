'use strict';

const { createRenderer } = require('./renderer.cjs');
const { FuzzySearch } = require('./search.cjs');
const { KeyboardHandler } = require('./keyboard.cjs');
const { isInteractive, renderStaticTable } = require('./graceful.cjs');

/**
 * Number of rows to scroll on Page Up / Page Down.
 * @type {number}
 */
const PAGE_SIZE = 10;

/**
 * Launch the interactive TUI issue browser.
 *
 * Falls back to a static table when not running in a TTY (CI, pipe).
 *
 * @param {Object} options
 * @param {Array<Object>} options.issues - Issue objects from GitHub API
 * @param {Function} options.onSelect - Called with the selected issue object
 * @param {Function} options.onQuit - Called when the user exits without selecting
 * @param {string} [options.initialQuery=''] - Pre-populate the search input
 * @param {Object} [options.initialFilter={}] - Initial filter state
 * @param {string} [options.initialFilter.label] - Label filter
 * @param {string} [options.initialFilter.milestone] - Milestone filter
 * @param {string} [options.initialFilter.assignee] - Assignee filter
 * @returns {Promise<void>}
 */
async function createIssuesBrowser(options) {
  const {
    issues = [],
    onSelect,
    onQuit,
    initialQuery = '',
    initialFilter = {},
  } = options;

  if (!isInteractive()) {
    // Non-TTY fallback: apply --search filter then render static table
    const displayed = initialQuery
      ? new FuzzySearch(issues, { keys: ['title', 'number', 'labels'] }).search(initialQuery)
      : issues;
    renderStaticTable(displayed);
    if (typeof onQuit === 'function') onQuit();
    return;
  }

  const search = new FuzzySearch(issues, {
    keys: ['title', 'number', 'labels'],
  });

  const renderer = createRenderer();
  const keyboard = new KeyboardHandler();

  // Browser state
  let query = initialQuery;
  let selectedIndex = 0;
  let focusPane = 'list'; // 'list' | 'detail' | 'filter' | 'search'
  let filtered = search.search(query);
  let running = true;
  let helpVisible = false;

  /**
   * Re-render with current state.
   */
  function draw() {
    return renderer.render({
      filtered,
      selectedIndex,
      query,
      focusPane,
      filter: initialFilter,
      helpVisible,
    });
  }

  /**
   * Clamp selectedIndex to valid range.
   */
  function clampIndex() {
    if (selectedIndex < 0) selectedIndex = 0;
    if (filtered.length > 0 && selectedIndex >= filtered.length) {
      selectedIndex = filtered.length - 1;
    }
  }

  // Wire keyboard events
  keyboard.on('scroll-down', () => {
    selectedIndex++;
    clampIndex();
    draw();
  });

  keyboard.on('scroll-up', () => {
    selectedIndex--;
    clampIndex();
    draw();
  });

  keyboard.on('select', () => {
    if (filtered.length > 0 && typeof onSelect === 'function') {
      const issue = filtered[selectedIndex];
      running = false;
      renderer.destroy();
      onSelect(issue);
    }
  });

  keyboard.on('quit', () => {
    // If help is visible, close it first; if in search mode, exit search
    if (helpVisible) {
      helpVisible = false;
      draw();
      return;
    }
    if (focusPane === 'search') {
      focusPane = 'list';
      draw();
      return;
    }
    if (running) {
      running = false;
      renderer.destroy();
      if (typeof onQuit === 'function') onQuit();
    }
  });

  keyboard.on('force-quit', () => {
    if (running) {
      running = false;
      renderer.destroy();
      process.exit(0);
    }
  });

  keyboard.on('tab-focus', () => {
    const order = ['list', 'detail', 'filter'];
    const current = order.indexOf(focusPane);
    focusPane = order[(current + 1) % order.length];
    draw();
  });

  keyboard.on('search-focus', () => {
    focusPane = 'search';
    draw();
  });

  keyboard.on('search-exit', () => {
    focusPane = 'list';
    draw();
  });

  keyboard.on('search-update', (newQuery) => {
    query = newQuery;
    selectedIndex = 0;
    filtered = search.search(query);
    draw();
  });

  keyboard.on('jump-top', () => {
    selectedIndex = 0;
    draw();
  });

  keyboard.on('jump-bottom', () => {
    selectedIndex = Math.max(0, filtered.length - 1);
    draw();
  });

  keyboard.on('page-up', () => {
    selectedIndex = Math.max(0, selectedIndex - PAGE_SIZE);
    draw();
  });

  keyboard.on('page-down', () => {
    selectedIndex = Math.min(Math.max(0, filtered.length - 1), selectedIndex + PAGE_SIZE);
    draw();
  });

  keyboard.on('tab-focus-reverse', () => {
    const order = ['list', 'detail', 'filter'];
    const current = order.indexOf(focusPane);
    // Cycle backwards; if focusPane is 'search' (not in order), default to last
    const base = current === -1 ? 0 : current;
    focusPane = order[(base - 1 + order.length) % order.length];
    draw();
  });

  keyboard.on('help', () => {
    helpVisible = !helpVisible;
    draw();
  });

  // Initial render
  await draw();

  // Hand off keyboard dispatching to renderer
  // (renderer wires up raw keypress events and calls keyboard.dispatch)
  if (typeof renderer.startKeyboard === 'function') {
    renderer.startKeyboard(keyboard);
  }
}

module.exports = { createIssuesBrowser };
