'use strict';

/**
 * MGW — Placeholder test suite
 *
 * This file establishes the test directory and a minimal smoke test.
 * Future contributors should add tests here for:
 *
 *   - CLI argument parsing (bin/mgw.cjs)
 *   - State file read/write (lib/state.cjs)
 *   - Template loading (lib/template-loader.cjs)
 *   - Output formatting (lib/output.cjs)
 *   - GitHub helpers (lib/github.cjs)
 *
 * Run with: npm test
 *
 * The test uses Node's built-in assert module and test runner (node:test)
 * which requires Node.js >= 18. No additional test dependencies needed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

describe('mgw', () => {
  it('package.json exists and has required fields', () => {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    assert.ok(existsSync(pkgPath), 'package.json should exist');

    const pkg = require(pkgPath);
    assert.ok(pkg.name, 'package.json should have a name');
    assert.ok(pkg.version, 'package.json should have a version');
    assert.ok(pkg.bin, 'package.json should have a bin field');
    assert.ok(pkg.main, 'package.json should have a main field');
  });

  it('CLI entry point exists', () => {
    const binPath = resolve(__dirname, '..', 'bin', 'mgw.cjs');
    assert.ok(existsSync(binPath), 'bin/mgw.cjs should exist');
  });

  it('lib modules exist', () => {
    const libDir = resolve(__dirname, '..', 'lib');
    const expectedModules = [
      'index.cjs',
      'state.cjs',
      'github.cjs',
      'output.cjs',
      'gsd.cjs',
      'claude.cjs',
      'template-loader.cjs',
      'templates.cjs',
      'spinner.cjs',
    ];

    for (const mod of expectedModules) {
      const modPath = resolve(libDir, mod);
      assert.ok(existsSync(modPath), `lib/${mod} should exist`);
    }
  });

  it('commands directory has expected slash commands', () => {
    const cmdDir = resolve(__dirname, '..', 'commands');
    const expectedCommands = [
      'run.md',
      'issue.md',
      'init.md',
      'status.md',
      'sync.md',
    ];

    for (const cmd of expectedCommands) {
      const cmdPath = resolve(cmdDir, cmd);
      assert.ok(existsSync(cmdPath), `commands/${cmd} should exist`);
    }
  });
});
