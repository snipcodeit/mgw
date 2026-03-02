'use strict';

const { EventEmitter } = require('events');

/**
 * Default key bindings map.
 *
 * Keys are raw terminal sequences or characters.
 * Values are action names emitted as events.
 *
 * @type {Record<string, string>}
 */
const DEFAULT_BINDINGS = {
  // Scroll
  'j': 'scroll-down',
  '\u001B[B': 'scroll-down',   // Down arrow
  '\u001B[1;2B': 'scroll-down', // Shift+Down (some terminals)
  'k': 'scroll-up',
  '\u001B[A': 'scroll-up',     // Up arrow
  '\u001B[1;2A': 'scroll-up',  // Shift+Up

  // Jump
  'g': 'jump-top',
  '\u001B[H': 'jump-top',      // Home
  'G': 'jump-bottom',
  '\u001B[F': 'jump-bottom',   // End
  '\u001B[5~': 'page-up',      // PgUp
  '\u001B[6~': 'page-down',    // PgDn

  // Select / quit
  '\r': 'select',              // Enter
  '\n': 'select',
  'q': 'quit',
  '\u001B': 'quit',            // Escape (bare — only if not start of sequence)

  // Search
  '/': 'search-focus',

  // Focus
  '\t': 'tab-focus',           // Tab
  '\u001B[Z': 'tab-focus-reverse', // Shift+Tab

  // Help
  '?': 'help',

  // Filter pane
  'f': 'filter-focus',          // Open filter pane
  ' ': 'filter-toggle',         // Toggle item under cursor (Space)
  'c': 'filter-clear',          // Clear all filters

  // Ctrl+C — force-quit
  '\u0003': 'force-quit',
};

/**
 * KeyboardHandler — dispatches raw key strings to named action events.
 *
 * Extends EventEmitter. Emitted events match action names in DEFAULT_BINDINGS.
 *
 * @example
 *   const kb = new KeyboardHandler();
 *   kb.on('select', () => console.log('selected'));
 *   kb.dispatch('\r'); // triggers 'select'
 *
 * @example Custom bindings:
 *   const kb = new KeyboardHandler({ 'x': 'quit', '\r': 'select' });
 */
class KeyboardHandler extends EventEmitter {
  /**
   * @param {Record<string, string>} [bindings=DEFAULT_BINDINGS]
   *   Map of raw key sequences to action names.
   */
  constructor(bindings = DEFAULT_BINDINGS) {
    super();
    this.bindings = Object.assign({}, bindings);
  }

  /**
   * Dispatch a raw key string to the matching action event.
   *
   * If no binding is found, emits 'unbound' with the key as argument.
   *
   * @param {string} key - Raw keypress string from terminal
   * @param {Object} [meta={}] - Optional metadata (e.g. { shift, ctrl, name })
   */
  dispatch(key, meta = {}) {
    const action = this.bindings[key];
    if (action) {
      this.emit(action, key, meta);
    } else {
      this.emit('unbound', key, meta);
    }
  }

  /**
   * Emit a search-update event for live search input.
   * Called by the renderer when characters are typed in the search input.
   *
   * @param {string} query - Current search string
   */
  updateSearch(query) {
    this.emit('search-update', query);
  }

  /**
   * Add or override a key binding.
   *
   * @param {string} key - Raw key sequence
   * @param {string} action - Action name to emit
   */
  bind(key, action) {
    this.bindings[key] = action;
  }

  /**
   * Remove a key binding.
   *
   * @param {string} key - Raw key sequence to unbind
   */
  unbind(key) {
    delete this.bindings[key];
  }
}

module.exports = { KeyboardHandler, DEFAULT_BINDINGS };
