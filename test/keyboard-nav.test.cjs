'use strict';

/**
 * test/keyboard-nav.test.cjs — Unit tests for lib/tui/keyboard.cjs
 *
 * Coverage:
 *   - KeyboardHandler dispatches named actions for all documented key bindings
 *   - 'unbound' event emitted for unmapped keys
 *   - helpVisible toggle pattern (two toggles return to false)
 *   - updateSearch emits 'search-update' with the query string
 *   - bind() / unbind() mutation methods
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const KEYBOARD_MODULE = path.resolve(__dirname, '..', 'lib', 'tui', 'keyboard.cjs');

function loadKeyboard() {
  delete require.cache[KEYBOARD_MODULE];
  return require(KEYBOARD_MODULE);
}

// ---------------------------------------------------------------------------
// Action dispatch — individual key bindings
// ---------------------------------------------------------------------------

describe('KeyboardHandler dispatch', () => {
  it('dispatches "jump-top" when "g" is pressed', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('jump-top', () => done());
    kb.dispatch('g');
  });

  it('dispatches "jump-bottom" when "G" is pressed', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('jump-bottom', () => done());
    kb.dispatch('G');
  });

  it('dispatches "page-up" on PgUp key (\\x1b[5~)', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('page-up', () => done());
    kb.dispatch('\x1b[5~');
  });

  it('dispatches "page-down" on PgDn key (\\x1b[6~)', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('page-down', () => done());
    kb.dispatch('\x1b[6~');
  });

  it('dispatches "help" when "?" is pressed', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('help', () => done());
    kb.dispatch('?');
  });

  it('dispatches "force-quit" on Ctrl+C (\\u0003)', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('force-quit', () => done());
    kb.dispatch('\u0003');
  });

  it('dispatches "tab-focus-reverse" on Shift+Tab (\\x1b[Z)', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('tab-focus-reverse', () => done());
    kb.dispatch('\x1b[Z');
  });

  it('emits "unbound" for an unmapped key', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('unbound', (key) => {
      assert.equal(key, 'z');
      done();
    });
    kb.dispatch('z');
  });

  it('passes the raw key string as first argument to the action listener', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('jump-top', (key) => {
      assert.equal(key, 'g');
      done();
    });
    kb.dispatch('g');
  });

  it('passes the meta object as second argument to the action listener', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    const meta = { ctrl: false, shift: false };
    kb.once('help', (_key, receivedMeta) => {
      assert.deepEqual(receivedMeta, meta);
      done();
    });
    kb.dispatch('?', meta);
  });

  it('defaults meta to an empty object when not provided', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('help', (_key, meta) => {
      assert.deepEqual(meta, {});
      done();
    });
    kb.dispatch('?');
  });
});

// ---------------------------------------------------------------------------
// helpVisible toggle pattern
// ---------------------------------------------------------------------------

describe('helpVisible toggle pattern', () => {
  it('toggling help twice returns to false', () => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();

    // Simulate the same toggle logic used in lib/tui/index.cjs
    let helpVisible = false;
    kb.on('help', () => {
      helpVisible = !helpVisible;
    });

    kb.dispatch('?'); // toggle on
    assert.equal(helpVisible, true, 'helpVisible should be true after first toggle');

    kb.dispatch('?'); // toggle off
    assert.equal(helpVisible, false, 'helpVisible should be false after second toggle');
  });

  it('helpVisible is true after a single "?" press', () => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();

    let helpVisible = false;
    kb.on('help', () => {
      helpVisible = !helpVisible;
    });

    kb.dispatch('?');
    assert.equal(helpVisible, true);
  });
});

// ---------------------------------------------------------------------------
// updateSearch
// ---------------------------------------------------------------------------

describe('KeyboardHandler updateSearch', () => {
  it('emits "search-update" with the provided query string', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('search-update', (query) => {
      assert.equal(query, 'foo bar');
      done();
    });
    kb.updateSearch('foo bar');
  });

  it('emits "search-update" with an empty string', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.once('search-update', (query) => {
      assert.equal(query, '');
      done();
    });
    kb.updateSearch('');
  });
});

// ---------------------------------------------------------------------------
// bind / unbind mutation methods
// ---------------------------------------------------------------------------

describe('KeyboardHandler bind / unbind', () => {
  it('bind() adds a new key-to-action mapping', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.bind('x', 'custom-action');
    kb.once('custom-action', () => done());
    kb.dispatch('x');
  });

  it('bind() overrides an existing mapping', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.bind('g', 'overridden-action');
    kb.once('overridden-action', () => done());
    kb.dispatch('g');
  });

  it('unbind() removes a mapping so the key emits "unbound"', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler();
    kb.unbind('g');
    kb.once('unbound', (key) => {
      assert.equal(key, 'g');
      done();
    });
    kb.dispatch('g');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_BINDINGS export
// ---------------------------------------------------------------------------

describe('DEFAULT_BINDINGS export', () => {
  it('exports DEFAULT_BINDINGS as a plain object', () => {
    const { DEFAULT_BINDINGS } = loadKeyboard();
    assert.equal(typeof DEFAULT_BINDINGS, 'object');
    assert.ok(DEFAULT_BINDINGS !== null);
  });

  it('DEFAULT_BINDINGS maps "g" to "jump-top"', () => {
    const { DEFAULT_BINDINGS } = loadKeyboard();
    assert.equal(DEFAULT_BINDINGS['g'], 'jump-top');
  });

  it('DEFAULT_BINDINGS maps "G" to "jump-bottom"', () => {
    const { DEFAULT_BINDINGS } = loadKeyboard();
    assert.equal(DEFAULT_BINDINGS['G'], 'jump-bottom');
  });

  it('DEFAULT_BINDINGS maps "\\u0003" to "force-quit"', () => {
    const { DEFAULT_BINDINGS } = loadKeyboard();
    assert.equal(DEFAULT_BINDINGS['\u0003'], 'force-quit');
  });

  it('DEFAULT_BINDINGS maps "\\x1b[Z" to "tab-focus-reverse"', () => {
    const { DEFAULT_BINDINGS } = loadKeyboard();
    assert.equal(DEFAULT_BINDINGS['\x1b[Z'], 'tab-focus-reverse');
  });
});

// ---------------------------------------------------------------------------
// Custom bindings constructor
// ---------------------------------------------------------------------------

describe('KeyboardHandler custom bindings', () => {
  it('accepts a custom bindings map in the constructor', (t, done) => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler({ 'a': 'action-a' });
    kb.once('action-a', () => done());
    kb.dispatch('a');
  });

  it('custom bindings do not include DEFAULT_BINDINGS entries', () => {
    const { KeyboardHandler } = loadKeyboard();
    const kb = new KeyboardHandler({ 'a': 'action-a' });
    let jumpTopFired = false;
    kb.on('jump-top', () => { jumpTopFired = true; });
    kb.dispatch('g'); // 'g' is in DEFAULT_BINDINGS but not in the custom map
    assert.equal(jumpTopFired, false, '"g" should emit "unbound", not "jump-top"');
  });
});
