'use strict';

/**
 * test/filter.test.cjs — Unit tests for lib/tui/filter.cjs
 *
 * Covers:
 *   - FilterState construction: label and milestone extraction from issues
 *   - toggleCursor() add and remove from activeLabels
 *   - apply() with label filter, state filter, and no filters
 *   - clearAll() resets activeLabels, activeMilestones, activeState
 *   - isEmpty returns true after clearAll()
 *   - toJSON() round-trip: serialised and re-constructed state matches active selections
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { FilterState } = require(path.resolve(__dirname, '..', 'lib', 'tui', 'filter.cjs'));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUES = [
  {
    number: 1,
    title: 'Fix login bug',
    state: 'open',
    labels: [{ name: 'bug' }, { name: 'auth' }],
    milestone: { title: 'v1.0' },
  },
  {
    number: 2,
    title: 'Add dark mode',
    state: 'open',
    labels: [{ name: 'enhancement' }],
    milestone: { title: 'v1.0' },
  },
  {
    number: 3,
    title: 'Remove deprecated API',
    state: 'closed',
    labels: [{ name: 'bug' }, { name: 'breaking' }],
    milestone: { title: 'v2.0' },
  },
  {
    number: 4,
    title: 'Update docs',
    state: 'open',
    labels: [],
    milestone: null,
  },
];

// ---------------------------------------------------------------------------
// Construction — label and milestone extraction
// ---------------------------------------------------------------------------

describe('FilterState construction', () => {
  it('extracts available labels from issues (sorted, deduplicated)', () => {
    const fs = new FilterState(ISSUES);
    // Labels present: bug, auth, enhancement, breaking — sorted alphabetically
    assert.deepEqual(fs.availableLabels, ['auth', 'breaking', 'bug', 'enhancement']);
  });

  it('extracts available milestones from issues (sorted, deduplicated)', () => {
    const fs = new FilterState(ISSUES);
    assert.deepEqual(fs.availableMilestones, ['v1.0', 'v2.0']);
  });

  it('starts with empty activeLabels when no persisted state', () => {
    const fs = new FilterState(ISSUES);
    assert.equal(fs.activeLabels.size, 0);
  });

  it('starts with empty activeMilestones when no persisted state', () => {
    const fs = new FilterState(ISSUES);
    assert.equal(fs.activeMilestones.size, 0);
  });

  it('starts with activeState = "open" by default', () => {
    const fs = new FilterState(ISSUES);
    assert.equal(fs.activeState, 'open');
  });

  it('restores activeLabels from persisted state', () => {
    const fs = new FilterState(ISSUES, { activeLabels: ['bug'] });
    assert.ok(fs.activeLabels.has('bug'));
    assert.equal(fs.activeLabels.size, 1);
  });

  it('restores activeMilestones from persisted state', () => {
    const fs = new FilterState(ISSUES, { activeMilestones: ['v1.0'] });
    assert.ok(fs.activeMilestones.has('v1.0'));
  });

  it('restores activeState from persisted state', () => {
    const fs = new FilterState(ISSUES, { activeState: 'closed' });
    assert.equal(fs.activeState, 'closed');
  });

  it('ignores persisted labels that are not in the available set', () => {
    const fs = new FilterState(ISSUES, { activeLabels: ['nonexistent-label'] });
    assert.equal(fs.activeLabels.size, 0);
  });

  it('ignores persisted milestones that are not in the available set', () => {
    const fs = new FilterState(ISSUES, { activeMilestones: ['v99.0'] });
    assert.equal(fs.activeMilestones.size, 0);
  });

  it('defaults activeState to "open" when persisted state value is invalid', () => {
    const fs = new FilterState(ISSUES, { activeState: 'invalid-state' });
    assert.equal(fs.activeState, 'open');
  });

  it('handles empty issues array', () => {
    const fs = new FilterState([]);
    assert.deepEqual(fs.availableLabels, []);
    assert.deepEqual(fs.availableMilestones, []);
  });
});

// ---------------------------------------------------------------------------
// toggleCursor() — add and remove from activeLabels
// ---------------------------------------------------------------------------

describe('toggleCursor()', () => {
  it('adds a label to activeLabels when cursor is on that label', () => {
    const fs = new FilterState(ISSUES);
    // Default cursorSection is 'labels', cursorIndex is 0 → 'auth'
    assert.equal(fs.cursorSection, 'labels');
    assert.equal(fs.cursorIndex, 0);
    fs.toggleCursor();
    assert.ok(fs.activeLabels.has(fs.availableLabels[0]));
  });

  it('removes a label from activeLabels when toggled a second time', () => {
    const fs = new FilterState(ISSUES);
    // Toggle on then off
    fs.toggleCursor();
    assert.ok(fs.activeLabels.has(fs.availableLabels[0]));
    fs.toggleCursor();
    assert.ok(!fs.activeLabels.has(fs.availableLabels[0]));
  });

  it('adds a milestone to activeMilestones when cursorSection is milestones', () => {
    const fs = new FilterState(ISSUES);
    fs.nextSection(); // move to 'milestones'
    assert.equal(fs.cursorSection, 'milestones');
    fs.toggleCursor();
    assert.ok(fs.activeMilestones.has(fs.availableMilestones[0]));
  });

  it('removes a milestone from activeMilestones when toggled a second time', () => {
    const fs = new FilterState(ISSUES);
    fs.nextSection(); // move to 'milestones'
    fs.toggleCursor();
    assert.ok(fs.activeMilestones.has(fs.availableMilestones[0]));
    fs.toggleCursor();
    assert.ok(!fs.activeMilestones.has(fs.availableMilestones[0]));
  });

  it('sets activeState to selected option when cursorSection is state', () => {
    const fs = new FilterState(ISSUES);
    // Navigate to state section and move cursor to index 1 (closed)
    fs.nextSection(); // milestones
    fs.nextSection(); // state
    assert.equal(fs.cursorSection, 'state');
    fs.cursorDown(); // index 1 = 'closed'
    fs.toggleCursor();
    assert.equal(fs.activeState, 'closed');
  });

  it('does nothing when cursorSection is labels but availableLabels is empty', () => {
    const fs = new FilterState([]);
    // cursorSection is 'labels', but availableLabels is empty
    // toggleCursor should not throw
    assert.doesNotThrow(() => fs.toggleCursor());
    assert.equal(fs.activeLabels.size, 0);
  });
});

// ---------------------------------------------------------------------------
// apply() — filtering behaviour
// ---------------------------------------------------------------------------

describe('apply()', () => {
  it('returns all issues when no filters are active', () => {
    const fs = new FilterState(ISSUES);
    // Default state is 'open', so apply() filters by open state
    // Issues 1, 2, 4 are open; issue 3 is closed
    const result = fs.apply(ISSUES);
    assert.equal(result.length, 3);
    assert.ok(result.every(i => i.state === 'open'));
  });

  it('returns all issues when activeState is "all"', () => {
    const fs = new FilterState(ISSUES, { activeState: 'all' });
    const result = fs.apply(ISSUES);
    assert.equal(result.length, ISSUES.length);
  });

  it('returns only open issues when activeState is "open"', () => {
    const fs = new FilterState(ISSUES, { activeState: 'open' });
    const result = fs.apply(ISSUES);
    assert.ok(result.every(i => i.state === 'open'));
    assert.equal(result.length, 3);
  });

  it('returns only closed issues when activeState is "closed"', () => {
    const fs = new FilterState(ISSUES, { activeState: 'closed' });
    const result = fs.apply(ISSUES);
    assert.ok(result.every(i => i.state === 'closed'));
    assert.equal(result.length, 1);
    assert.equal(result[0].number, 3);
  });

  it('returns only issues that have the active label', () => {
    const fs = new FilterState(ISSUES, { activeState: 'all', activeLabels: ['bug'] });
    const result = fs.apply(ISSUES);
    // Issues 1 and 3 have the 'bug' label
    assert.equal(result.length, 2);
    assert.ok(result.some(i => i.number === 1));
    assert.ok(result.some(i => i.number === 3));
  });

  it('requires ALL selected labels (AND logic)', () => {
    const fs = new FilterState(ISSUES, { activeState: 'all', activeLabels: ['bug', 'auth'] });
    const result = fs.apply(ISSUES);
    // Only issue 1 has both 'bug' and 'auth'
    assert.equal(result.length, 1);
    assert.equal(result[0].number, 1);
  });

  it('returns empty array when no issues match the label filter', () => {
    const fs = new FilterState(ISSUES, { activeState: 'all', activeLabels: ['auth', 'breaking'] });
    const result = fs.apply(ISSUES);
    // No issue has both 'auth' and 'breaking'
    assert.equal(result.length, 0);
  });

  it('returns only issues matching ANY selected milestone (OR logic)', () => {
    const fs = new FilterState(ISSUES, { activeState: 'all', activeMilestones: ['v1.0'] });
    const result = fs.apply(ISSUES);
    // Issues 1 and 2 have milestone v1.0
    assert.equal(result.length, 2);
    assert.ok(result.some(i => i.number === 1));
    assert.ok(result.some(i => i.number === 2));
  });

  it('includes all matched milestones when multiple milestones are active', () => {
    const fs = new FilterState(ISSUES, { activeState: 'all', activeMilestones: ['v1.0', 'v2.0'] });
    const result = fs.apply(ISSUES);
    // Issues 1, 2 (v1.0) and 3 (v2.0) — issue 4 has no milestone
    assert.equal(result.length, 3);
    assert.ok(!result.some(i => i.number === 4));
  });

  it('excludes issues with no milestone when a milestone filter is active', () => {
    const fs = new FilterState(ISSUES, { activeState: 'all', activeMilestones: ['v1.0'] });
    const result = fs.apply(ISSUES);
    // Issue 4 has no milestone — must be excluded
    assert.ok(!result.some(i => i.number === 4));
  });

  it('combines label and milestone filters (AND across dimensions)', () => {
    const fs = new FilterState(ISSUES, {
      activeState: 'all',
      activeLabels: ['bug'],
      activeMilestones: ['v1.0'],
    });
    const result = fs.apply(ISSUES);
    // Issue 1: bug label + v1.0 milestone — included
    // Issue 3: bug label + v2.0 milestone — excluded (milestone doesn't match)
    assert.equal(result.length, 1);
    assert.equal(result[0].number, 1);
  });
});

// ---------------------------------------------------------------------------
// clearAll()
// ---------------------------------------------------------------------------

describe('clearAll()', () => {
  it('resets activeLabels to empty', () => {
    const fs = new FilterState(ISSUES, { activeLabels: ['bug', 'auth'] });
    assert.ok(fs.activeLabels.size > 0);
    fs.clearAll();
    assert.equal(fs.activeLabels.size, 0);
  });

  it('resets activeMilestones to empty', () => {
    const fs = new FilterState(ISSUES, { activeMilestones: ['v1.0'] });
    assert.ok(fs.activeMilestones.size > 0);
    fs.clearAll();
    assert.equal(fs.activeMilestones.size, 0);
  });

  it('resets activeState to "open"', () => {
    const fs = new FilterState(ISSUES, { activeState: 'closed' });
    assert.equal(fs.activeState, 'closed');
    fs.clearAll();
    assert.equal(fs.activeState, 'open');
  });
});

// ---------------------------------------------------------------------------
// isEmpty
// ---------------------------------------------------------------------------

describe('isEmpty', () => {
  it('returns true when no filters are active (default state)', () => {
    const fs = new FilterState(ISSUES);
    assert.equal(fs.isEmpty, true);
  });

  it('returns false when a label is active', () => {
    const fs = new FilterState(ISSUES, { activeLabels: ['bug'] });
    assert.equal(fs.isEmpty, false);
  });

  it('returns false when a milestone is active', () => {
    const fs = new FilterState(ISSUES, { activeMilestones: ['v1.0'] });
    assert.equal(fs.isEmpty, false);
  });

  it('returns false when activeState is not "open"', () => {
    const fs = new FilterState(ISSUES, { activeState: 'closed' });
    assert.equal(fs.isEmpty, false);
  });

  it('returns true after clearAll() regardless of prior state', () => {
    const fs = new FilterState(ISSUES, {
      activeLabels: ['bug'],
      activeMilestones: ['v1.0'],
      activeState: 'closed',
    });
    assert.equal(fs.isEmpty, false);
    fs.clearAll();
    assert.equal(fs.isEmpty, true);
  });
});

// ---------------------------------------------------------------------------
// toJSON() round-trip
// ---------------------------------------------------------------------------

describe('toJSON() round-trip', () => {
  it('serialises active selections to a plain object', () => {
    const fs = new FilterState(ISSUES, {
      activeLabels: ['bug', 'auth'],
      activeMilestones: ['v1.0'],
      activeState: 'open',
    });
    const json = fs.toJSON();
    assert.ok(Array.isArray(json.activeLabels));
    assert.ok(Array.isArray(json.activeMilestones));
    assert.equal(typeof json.activeState, 'string');
  });

  it('round-trips: re-constructed FilterState matches original active selections', () => {
    const original = new FilterState(ISSUES, {
      activeLabels: ['bug', 'auth'],
      activeMilestones: ['v1.0'],
      activeState: 'open',
    });
    const json = original.toJSON();
    const restored = new FilterState(ISSUES, json);

    assert.deepEqual(
      Array.from(restored.activeLabels).sort(),
      Array.from(original.activeLabels).sort()
    );
    assert.deepEqual(
      Array.from(restored.activeMilestones).sort(),
      Array.from(original.activeMilestones).sort()
    );
    assert.equal(restored.activeState, original.activeState);
  });

  it('round-trips correctly when all selections are empty', () => {
    const original = new FilterState(ISSUES);
    const json = original.toJSON();
    const restored = new FilterState(ISSUES, json);

    assert.equal(restored.activeLabels.size, 0);
    assert.equal(restored.activeMilestones.size, 0);
    assert.equal(restored.activeState, 'open');
  });

  it('round-trips correctly after clearAll()', () => {
    const original = new FilterState(ISSUES, {
      activeLabels: ['bug'],
      activeState: 'closed',
    });
    original.clearAll();
    const json = original.toJSON();
    const restored = new FilterState(ISSUES, json);

    assert.equal(restored.activeLabels.size, 0);
    assert.equal(restored.activeMilestones.size, 0);
    assert.equal(restored.activeState, 'open');
  });

  it('produces JSON-serialisable output (no Sets or non-primitive types)', () => {
    const fs = new FilterState(ISSUES, { activeLabels: ['bug'], activeMilestones: ['v1.0'] });
    const json = fs.toJSON();
    // Should not throw when passed through JSON.stringify/parse
    const str = JSON.stringify(json);
    const parsed = JSON.parse(str);
    assert.deepEqual(parsed, json);
  });
});
