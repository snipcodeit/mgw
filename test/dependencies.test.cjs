'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseDependencies, topologicalSort } = require('../lib/state.cjs');

// ---------------------------------------------------------------------------
// parseDependencies
// ---------------------------------------------------------------------------

describe('parseDependencies', () => {
  it('returns empty array for null/undefined/empty body', () => {
    assert.deepEqual(parseDependencies(null), []);
    assert.deepEqual(parseDependencies(undefined), []);
    assert.deepEqual(parseDependencies(''), []);
  });

  it('parses "Depends on: #3, #7"', () => {
    assert.deepEqual(parseDependencies('Depends on: #3, #7'), [3, 7]);
  });

  it('parses "depends on #3 #7" (no colon, no commas)', () => {
    assert.deepEqual(parseDependencies('depends on #3 #7'), [3, 7]);
  });

  it('parses "Blocked by: #10, #20"', () => {
    assert.deepEqual(parseDependencies('Blocked by: #10, #20'), [10, 20]);
  });

  it('parses "blocked-by: #5"', () => {
    assert.deepEqual(parseDependencies('blocked-by: #5'), [5]);
  });

  it('parses "Depends on #3 and #7"', () => {
    assert.deepEqual(parseDependencies('Depends on #3 and #7'), [3, 7]);
  });

  it('is case-insensitive', () => {
    assert.deepEqual(parseDependencies('DEPENDS ON: #1, #2'), [1, 2]);
    assert.deepEqual(parseDependencies('BLOCKED BY: #3'), [3]);
  });

  it('deduplicates issue numbers', () => {
    assert.deepEqual(parseDependencies('Depends on: #3, #3, #7'), [3, 7]);
  });

  it('returns sorted results', () => {
    assert.deepEqual(parseDependencies('Depends on: #7, #3, #1'), [1, 3, 7]);
  });

  it('ignores non-matching lines', () => {
    const body = `
## Description
This is a feature request.

Depends on: #5, #10

Some more text here.
    `;
    assert.deepEqual(parseDependencies(body), [5, 10]);
  });

  it('handles multiple dependency lines', () => {
    const body = `Depends on: #1, #2\nBlocked by: #3`;
    assert.deepEqual(parseDependencies(body), [1, 2, 3]);
  });

  it('returns empty for body with no dependency patterns', () => {
    assert.deepEqual(parseDependencies('Just a normal issue body'), []);
  });
});

// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------

describe('topologicalSort', () => {
  it('returns empty for empty input', () => {
    assert.deepEqual(topologicalSort([], []), []);
  });

  it('returns issues in original order when no deps', () => {
    const issues = [{ number: 3 }, { number: 1 }, { number: 2 }];
    const result = topologicalSort(issues, []);
    assert.deepEqual(result.map(i => i.number), [3, 1, 2]);
  });

  it('sorts blocked issues after their dependencies', () => {
    const issues = [{ number: 1 }, { number: 2 }, { number: 3 }];
    const links = [
      { a: '#3', b: '#1', type: 'blocked-by' }, // 3 depends on 1
      { a: '#2', b: '#1', type: 'blocked-by' }, // 2 depends on 1
    ];
    const result = topologicalSort(issues, links);
    // 1 must come before 2 and 3
    const idx1 = result.findIndex(i => i.number === 1);
    const idx2 = result.findIndex(i => i.number === 2);
    const idx3 = result.findIndex(i => i.number === 3);
    assert.ok(idx1 < idx2);
    assert.ok(idx1 < idx3);
  });

  it('handles chain dependencies: 3 → 2 → 1', () => {
    const issues = [{ number: 3 }, { number: 2 }, { number: 1 }];
    const links = [
      { a: '#3', b: '#2', type: 'blocked-by' },
      { a: '#2', b: '#1', type: 'blocked-by' },
    ];
    const result = topologicalSort(issues, links);
    assert.deepEqual(result.map(i => i.number), [1, 2, 3]);
  });

  it('ignores non-blocked-by link types', () => {
    const issues = [{ number: 1 }, { number: 2 }];
    const links = [
      { a: '#2', b: '#1', type: 'related' },
    ];
    const result = topologicalSort(issues, links);
    assert.deepEqual(result.map(i => i.number), [1, 2]);
  });

  it('handles cycles gracefully by appending remaining', () => {
    const issues = [{ number: 1 }, { number: 2 }];
    const links = [
      { a: '#1', b: '#2', type: 'blocked-by' },
      { a: '#2', b: '#1', type: 'blocked-by' },
    ];
    const result = topologicalSort(issues, links);
    assert.equal(result.length, 2);
  });

  it('ignores deps on issues not in the input set', () => {
    const issues = [{ number: 1 }, { number: 2 }];
    const links = [
      { a: '#2', b: '#99', type: 'blocked-by' }, // 99 not in issues
    ];
    const result = topologicalSort(issues, links);
    assert.deepEqual(result.map(i => i.number), [1, 2]);
  });
});
