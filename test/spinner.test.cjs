'use strict';

/**
 * test/spinner.test.cjs — Unit tests for lib/spinner.cjs
 *
 * Tests run in non-TTY mode (piped stdout), so SUPPORTS_SPINNER is false
 * and all output falls back to plain log lines. This makes assertions
 * on stdout straightforward without ANSI escape sequences.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createSpinner, withSpinner, SUPPORTS_SPINNER } = require('../lib/spinner.cjs');

describe('spinner module exports', () => {
  it('exports createSpinner as a function', () => {
    assert.strictEqual(typeof createSpinner, 'function');
  });

  it('exports withSpinner as a function', () => {
    assert.strictEqual(typeof withSpinner, 'function');
  });

  it('exports SUPPORTS_SPINNER as a boolean', () => {
    assert.strictEqual(typeof SUPPORTS_SPINNER, 'boolean');
  });

  it('SUPPORTS_SPINNER is false in non-TTY test environment', () => {
    // Tests run with piped stdout so process.stdout.isTTY is undefined/false
    assert.strictEqual(SUPPORTS_SPINNER, false);
  });
});

describe('createSpinner', () => {
  let captured;
  let originalWrite;

  beforeEach(() => {
    captured = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      captured += chunk;
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('returns an object with start, succeed, fail, stop methods', () => {
    const s = createSpinner('test-stage');
    assert.strictEqual(typeof s.start, 'function');
    assert.strictEqual(typeof s.succeed, 'function');
    assert.strictEqual(typeof s.fail, 'function');
    assert.strictEqual(typeof s.stop, 'function');
  });

  it('start() emits stage name in non-TTY mode', () => {
    const s = createSpinner('validate');
    s.start();
    s.stop();
    assert.ok(captured.includes('validate'), `Expected "validate" in output, got: ${captured}`);
  });

  it('succeed() emits success line with default stage label', () => {
    const s = createSpinner('create-worktree');
    s.start();
    s.succeed();
    assert.ok(
      captured.includes('create-worktree'),
      `Expected "create-worktree" in success output, got: ${captured}`
    );
  });

  it('succeed() emits custom message when provided', () => {
    const s = createSpinner('execute-gsd');
    s.start();
    s.succeed('GSD executed successfully');
    assert.ok(
      captured.includes('GSD executed successfully'),
      `Expected custom message in output, got: ${captured}`
    );
  });

  it('fail() emits failure line with default stage label', () => {
    const s = createSpinner('create-pr');
    s.start();
    s.fail();
    assert.ok(
      captured.includes('create-pr'),
      `Expected "create-pr" in fail output, got: ${captured}`
    );
  });

  it('fail() emits custom message when provided', () => {
    const s = createSpinner('triage');
    s.start();
    s.fail('triage failed: issue not found');
    assert.ok(
      captured.includes('triage failed: issue not found'),
      `Expected custom fail message in output, got: ${captured}`
    );
  });

  it('start() accepts an optional label override', () => {
    const s = createSpinner('initial-label');
    s.start('overridden-label');
    s.stop();
    assert.ok(
      captured.includes('overridden-label'),
      `Expected overridden label in output, got: ${captured}`
    );
  });

  it('stop() does not emit any output in non-TTY mode (no clearLine side effects)', () => {
    const s = createSpinner('silent-stop');
    // In non-TTY mode, start() emits a line but stop() does nothing extra
    captured = ''; // Reset after start
    s.stop();
    // stop() alone emits nothing
    assert.strictEqual(captured, '');
  });
});

describe('withSpinner', () => {
  let captured;
  let originalWrite;

  beforeEach(() => {
    captured = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      captured += chunk;
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('resolves with the return value of the wrapped function', async () => {
    const result = await withSpinner('stage', async () => 42);
    assert.strictEqual(result, 42);
  });

  it('emits success output when fn resolves', async () => {
    await withSpinner('pipeline', async () => 'done');
    assert.ok(
      captured.includes('pipeline'),
      `Expected "pipeline" in success output, got: ${captured}`
    );
  });

  it('uses custom successMessage when provided', async () => {
    await withSpinner('validate', async () => {}, { successMessage: 'validation passed' });
    assert.ok(
      captured.includes('validation passed'),
      `Expected custom success message in output, got: ${captured}`
    );
  });

  it('emits fail output and rethrows when fn rejects', async () => {
    const boom = new Error('test failure');
    let thrown;
    try {
      await withSpinner('create-pr', async () => { throw boom; });
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(thrown, boom, 'Should rethrow the original error');
    assert.ok(
      captured.includes('fail') || captured.includes('create-pr'),
      `Expected failure output, got: ${captured}`
    );
  });

  it('uses custom failMessage when fn rejects', async () => {
    try {
      await withSpinner('execute-gsd', async () => { throw new Error('x'); }, {
        failMessage: 'gsd execution failed'
      });
    } catch {
      // expected
    }
    assert.ok(
      captured.includes('gsd execution failed'),
      `Expected custom fail message in output, got: ${captured}`
    );
  });
});
