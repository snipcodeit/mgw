'use strict';

/**
 * test/config-wizard.test.cjs — Unit tests for lib/config-wizard.cjs
 *
 * Coverage:
 *   shouldRunWizard  — all early-exit conditions
 *   detectGitHubUsername — failure path (gh unavailable)
 *
 * Note on runWizard: the function requires an interactive TTY to operate
 * (it opens a readline interface and awaits user input). Full end-to-end
 * tests are not practical without a PTY harness. The isTTY guard path is
 * covered indirectly via shouldRunWizard tests, and the guard itself is a
 * trivial throw — integration smoke-testing in a real terminal is sufficient.
 *
 * Mocking strategy for process.stdin.isTTY:
 *   process.stdin.isTTY is a writable property in test environments.
 *   We save the original value, override it, then restore after each test.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WIZARD_MODULE = path.resolve(__dirname, '..', 'lib', 'config-wizard.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reload lib/config-wizard.cjs fresh (evicts module cache).
 */
function loadWizard() {
  delete require.cache[WIZARD_MODULE];
  return require(WIZARD_MODULE);
}

/**
 * Create a temporary directory and return its path.
 */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-wizard-test-'));
}

/**
 * Override process.stdin.isTTY for the duration of a test.
 * Returns a restore function.
 * @param {boolean|undefined} value
 */
function overrideStdinTTY(value) {
  const original = process.stdin.isTTY;
  process.stdin.isTTY = value;
  return () => { process.stdin.isTTY = original; };
}

// ---------------------------------------------------------------------------
// shouldRunWizard
// ---------------------------------------------------------------------------

describe('shouldRunWizard', () => {
  let tmpDir;
  let restoreTTY;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Default: behave as TTY so only one guard triggers at a time
    restoreTTY = overrideStdinTTY(true);
  });

  afterEach(() => {
    restoreTTY();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[WIZARD_MODULE];
  });

  it('returns false when --no-config is in argv', () => {
    const { shouldRunWizard } = loadWizard();
    const result = shouldRunWizard(tmpDir, ['node', 'mgw', '--no-config']);
    assert.equal(result, false);
  });

  it('returns false when config.json already exists in mgwDir', () => {
    const { shouldRunWizard } = loadWizard();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}', 'utf-8');
    const result = shouldRunWizard(tmpDir, ['node', 'mgw']);
    assert.equal(result, false);
  });

  it('returns false when process.stdin.isTTY is falsy (piped/automated)', () => {
    restoreTTY();
    restoreTTY = overrideStdinTTY(false);
    const { shouldRunWizard } = loadWizard();
    const result = shouldRunWizard(tmpDir, ['node', 'mgw']);
    assert.equal(result, false);
  });

  it('returns false when process.stdin.isTTY is undefined', () => {
    restoreTTY();
    restoreTTY = overrideStdinTTY(undefined);
    const { shouldRunWizard } = loadWizard();
    const result = shouldRunWizard(tmpDir, ['node', 'mgw']);
    assert.equal(result, false);
  });

  it('returns true when no flag, no config.json, and stdin is a TTY', () => {
    // restoreTTY already set isTTY to true in beforeEach
    const { shouldRunWizard } = loadWizard();
    const result = shouldRunWizard(tmpDir, ['node', 'mgw']);
    assert.equal(result, true);
  });

  it('--no-config takes priority over TTY check (isTTY=true but flag present)', () => {
    const { shouldRunWizard } = loadWizard();
    const result = shouldRunWizard(tmpDir, ['node', 'mgw', '--no-config']);
    assert.equal(result, false);
  });

  it('uses process.argv when argv argument is omitted', () => {
    // Inject --no-config into process.argv temporarily
    const original = process.argv;
    process.argv = ['node', 'mgw', '--no-config'];
    try {
      const { shouldRunWizard } = loadWizard();
      assert.equal(shouldRunWizard(tmpDir), false);
    } finally {
      process.argv = original;
    }
  });
});

// ---------------------------------------------------------------------------
// detectGitHubUsername
// ---------------------------------------------------------------------------

describe('detectGitHubUsername', () => {
  afterEach(() => {
    delete require.cache[WIZARD_MODULE];
  });

  it('returns null when the gh command fails (gh not available / not authenticated)', () => {
    // We cannot mock execSync without a full module-replacement framework,
    // but we CAN test the failure path by temporarily manipulating PATH so
    // that `gh` resolves to a command that exits non-zero (or doesn't exist).
    // Using a sub-shell one-liner is the simplest portable approach.
    const originalPath = process.env.PATH;
    process.env.PATH = '/dev/null'; // nothing on PATH — execSync will throw ENOENT

    try {
      const { detectGitHubUsername } = loadWizard();
      const result = detectGitHubUsername();
      assert.equal(result, null);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
