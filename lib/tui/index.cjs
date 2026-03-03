'use strict';

const { createRenderer } = require('./renderer.cjs');
const { FuzzySearch } = require('./search.cjs');
const { KeyboardHandler } = require('./keyboard.cjs');
const { FilterState } = require('./filter.cjs');
const { isInteractive, renderStaticTable } = require('./graceful.cjs');

/**
 * Attempt to load persisted filter state from .mgw/config.json.
 * Returns an empty object if the file doesn't exist or is unreadable.
 *
 * @returns {Object}
 */
function _loadPersistedFilters() {
  try {
    const path = require('path');
    const fs = require('fs');
    const configPath = path.join(process.cwd(), '.mgw', 'config.json');
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf-8');
    const data = JSON.parse(raw);
    return data.tuiFilters || {};
  } catch (_e) {
    return {};
  }
}

/**
 * Persist filter state to .mgw/config.json.
 * Merges into existing config; silently ignores write errors.
 *
 * @param {import('./filter.cjs').FilterState} filterState
 */
function _savePersistedFilters(filterState) {
  try {
    const path = require('path');
    const fs = require('fs');
    const configPath = path.join(process.cwd(), '.mgw', 'config.json');
    let data = {};
    if (fs.existsSync(configPath)) {
      try { data = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (_e) { /* ignore */ }
    }
    data.tuiFilters = filterState.toJSON();
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  } catch (_e) {
    // Silently ignore — persistence is best-effort
  }
}

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
 * @param {Object} [options.initialFilter={}] - Initial filter state (from CLI flags)
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

  // Build filter state — load persisted selections, then override with CLI flags
  const persisted = _loadPersistedFilters();

  const seedFilters = Object.assign({}, persisted);
  if (initialFilter.label) seedFilters.activeLabels = [initialFilter.label];
  if (initialFilter.milestone) seedFilters.activeMilestones = [initialFilter.milestone];
  if (initialFilter.state) seedFilters.activeState = initialFilter.state;

  const filterState = new FilterState(issues, seedFilters);

  const search = new FuzzySearch(issues, { keys: ['title', 'number', 'labels'] });

  const renderer = createRenderer();
  const keyboard = new KeyboardHandler();

  /** Number of rows to scroll on Page Up / Page Down. */
  const PAGE_SIZE = 10;

  // Browser state
  let query = initialQuery;
  let selectedIndex = 0;
  let focusPane = 'list'; // 'list' | 'detail' | 'filter' | 'search'
  let running = true;
  let helpVisible = false;

  /**
   * Create a temporary FuzzySearch over a filtered subset and search it.
   * FuzzySearch.search() searches its constructor items — use this helper
   * to search within an already-filtered subset.
   */
  function _searchIn(subset, q) {
    if (!q) return subset;
    return new FuzzySearch(subset, { keys: ['title', 'number', 'labels'] }).search(q);
  }

  let filtered = _searchIn(filterState.apply(issues), query);

  /** Re-render with current state. */
  function draw() {
    return renderer.render({
      filtered,
      selectedIndex,
      query,
      focusPane,
      filterState,
      helpVisible,
    });
  }

  /** Clamp selectedIndex to valid range. */
  function clampIndex() {
    if (selectedIndex < 0) selectedIndex = 0;
    if (filtered.length > 0 && selectedIndex >= filtered.length) {
      selectedIndex = filtered.length - 1;
    }
  }

  /** Recalculate filtered list after a filter or search change. */
  function refilter() {
    filtered = _searchIn(filterState.apply(issues), query);
    selectedIndex = 0;
  }

  // ── List navigation ──────────────────────────────────────────────────────

  keyboard.on('scroll-down', () => {
    if (focusPane === 'filter') return; // handled by filter-scroll-down
    selectedIndex++;
    clampIndex();
    draw();
  });

  keyboard.on('scroll-up', () => {
    if (focusPane === 'filter') return;
    selectedIndex--;
    clampIndex();
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

  keyboard.on('page-down', () => {
    selectedIndex = Math.min(selectedIndex + PAGE_SIZE, Math.max(0, filtered.length - 1));
    draw();
  });

  keyboard.on('page-up', () => {
    selectedIndex = Math.max(selectedIndex - PAGE_SIZE, 0);
    draw();
  });

  // ── Select / quit ────────────────────────────────────────────────────────

  keyboard.on('select', () => {
    if (focusPane === 'filter') {
      _savePersistedFilters(filterState);
      focusPane = 'list';
      draw();
      return;
    }
    if (filtered.length > 0 && typeof onSelect === 'function') {
      const issue = filtered[selectedIndex];
      running = false;
      renderer.destroy();
      onSelect(issue);
    }
  });

  keyboard.on('quit', () => {
    // Hierarchical: close help → close filter → exit search → quit
    if (helpVisible) {
      helpVisible = false;
      draw();
      return;
    }
    if (focusPane === 'filter') {
      _savePersistedFilters(filterState);
      focusPane = 'list';
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

  // ── Focus cycling ────────────────────────────────────────────────────────

  keyboard.on('tab-focus', () => {
    const order = ['list', 'detail', 'filter'];
    const current = order.indexOf(focusPane);
    focusPane = order[(current + 1) % order.length];
    draw();
  });

  keyboard.on('tab-focus-reverse', () => {
    const order = ['list', 'detail', 'filter'];
    const current = order.indexOf(focusPane);
    const base = current === -1 ? 0 : current;
    focusPane = order[(base - 1 + order.length) % order.length];
    draw();
  });

  // ── Search ───────────────────────────────────────────────────────────────

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
    refilter();
    draw();
  });

  // ── Help ─────────────────────────────────────────────────────────────────

  keyboard.on('help', () => {
    helpVisible = !helpVisible;
    draw();
  });

  // ── Filter pane ──────────────────────────────────────────────────────────

  keyboard.on('filter-focus', () => {
    if (focusPane === 'filter') {
      _savePersistedFilters(filterState);
      focusPane = 'list';
    } else {
      focusPane = 'filter';
    }
    draw();
  });

  keyboard.on('filter-scroll-down', () => { filterState.cursorDown(); draw(); });
  keyboard.on('filter-scroll-up',   () => { filterState.cursorUp();   draw(); });
  keyboard.on('filter-next-section', () => { filterState.nextSection(); draw(); });
  keyboard.on('filter-prev-section', () => { filterState.prevSection(); draw(); });

  keyboard.on('filter-toggle', () => {
    if (focusPane !== 'filter') return;
    filterState.toggleCursor();
    refilter();
    _savePersistedFilters(filterState);
    draw();
  });

  keyboard.on('filter-clear', () => {
    filterState.clearAll();
    refilter();
    _savePersistedFilters(filterState);
    draw();
  });

  // Initial render
  await draw();

  // Hand off keyboard dispatching to renderer
  if (typeof renderer.startKeyboard === 'function') {
    renderer.startKeyboard(keyboard);
  }
}

module.exports = { createIssuesBrowser };
