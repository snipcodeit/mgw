/**
 * test/progress.test.cjs — Tests for lib/progress.cjs
 *
 * Verifies renderProgressBar output and stageIcon mappings.
 * Runs in non-TTY mode (CI) so color codes are stripped.
 *
 * Run with: npm test
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Force non-TTY/non-color for deterministic output
process.env.NO_COLOR = '1';

const { renderProgressBar, stageIcon } = require('../lib/progress.cjs');

describe('renderProgressBar', () => {
  it('renders 0/0 without crashing', () => {
    const bar = renderProgressBar({ done: 0, total: 0 });
    assert.ok(typeof bar === 'string', 'should return a string');
    assert.ok(bar.includes('0/0'), 'should contain 0/0');
  });

  it('renders 0/9 as empty bar', () => {
    const bar = renderProgressBar({ done: 0, total: 9, width: 10 });
    assert.ok(bar.includes('[░░░░░░░░░░]'), 'empty bar should be all ░');
    assert.ok(bar.includes('0/9'), 'should show 0/9');
  });

  it('renders 9/9 as full bar', () => {
    const bar = renderProgressBar({ done: 9, total: 9, width: 10 });
    assert.ok(bar.includes('[██████████]'), 'full bar should be all █');
    assert.ok(bar.includes('9/9'), 'should show 9/9');
  });

  it('renders 4/9 as partial bar', () => {
    // 4/9 ≈ 44.4% → Math.round(0.444 * 10) = 4 filled
    const bar = renderProgressBar({ done: 4, total: 9, width: 10 });
    assert.ok(bar.includes('4/9'), 'should show 4/9');
    assert.ok(bar.includes('[████░░░░░░]'), 'should show 4 filled, 6 empty');
  });

  it('includes "issues complete" label', () => {
    const bar = renderProgressBar({ done: 2, total: 5 });
    assert.ok(bar.includes('issues complete'), 'should include "issues complete"');
  });

  it('clamps done > total to full bar', () => {
    const bar = renderProgressBar({ done: 12, total: 9, width: 10 });
    assert.ok(bar.includes('[██████████]'), 'overshoot should render as full bar');
  });
});

describe('stageIcon', () => {
  it('maps done to ✓', () => {
    const { icon } = stageIcon('done');
    assert.equal(icon, '✓');
  });

  it('maps pr-created to ✓', () => {
    const { icon } = stageIcon('pr-created');
    assert.equal(icon, '✓');
  });

  it('maps executing to ◆', () => {
    const { icon } = stageIcon('executing');
    assert.equal(icon, '◆');
  });

  it('maps failed to ✗', () => {
    const { icon } = stageIcon('failed');
    assert.equal(icon, '✗');
  });

  it('maps blocked to ⊘', () => {
    const { icon } = stageIcon('blocked');
    assert.equal(icon, '⊘');
  });

  it('maps unknown stage to ○', () => {
    const { icon } = stageIcon('new');
    assert.equal(icon, '○');
  });

  it('maps triaged to ○ (pending)', () => {
    const { icon } = stageIcon('triaged');
    assert.equal(icon, '○');
  });

  // should map all intermediate/unknown stages to pending icon
  it('maps intermediate pipeline stages to ○ (pending)', () => {
    const intermediatestages = ['needs-info', 'discussing', 'approved', 'diagnosing'];
    for (const stage of intermediatestages) {
      const { icon } = stageIcon(stage);
      assert.equal(icon, '○', `stage '${stage}' should map to ○`);
    }
  });
});

describe('progress.cjs module exports', () => {
  it('exports renderProgressBar, stageIcon, printMilestoneProgress, SUPPORTS_COLOR', () => {
    const mod = require('../lib/progress.cjs');
    assert.ok(typeof mod.renderProgressBar === 'function', 'renderProgressBar should be a function');
    assert.ok(typeof mod.stageIcon === 'function', 'stageIcon should be a function');
    assert.ok(typeof mod.printMilestoneProgress === 'function', 'printMilestoneProgress should be a function');
    assert.ok('SUPPORTS_COLOR' in mod, 'SUPPORTS_COLOR should be exported');
  });
});
