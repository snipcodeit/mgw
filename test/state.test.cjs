'use strict';

/**
 * test/state.test.cjs — Unit tests for lib/state.cjs
 *
 * Isolation strategy:
 *   - fs.mkdtempSync() creates a real temp directory per test suite
 *   - process.cwd is overridden to point at the temp dir so getMgwDir()
 *     and all derived paths stay sandboxed
 *   - afterEach removes .mgw/ inside the temp dir for clean state
 *   - The temp dir itself is cleaned up in after() on each describe block
 *
 * All 9 exported functions are covered:
 *   getMgwDir, getActiveDir, getCompletedDir,
 *   loadProjectState, writeProjectState, loadActiveIssue,
 *   mergeProjectState, migrateProjectState, resolveActiveMilestoneIndex
 */

const { describe, it, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_MODULE = path.resolve(__dirname, '..', 'lib', 'state.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reload lib/state.cjs fresh (evict module cache so process.cwd override
 * takes effect on each load).
 */
function loadState() {
  delete require.cache[STATE_MODULE];
  return require(STATE_MODULE);
}

/**
 * Override process.cwd to return tmpDir for the duration of each test.
 * Returns a restore function.
 */
function overrideCwd(tmpDir) {
  const original = process.cwd.bind(process);
  process.cwd = () => tmpDir;
  return () => { process.cwd = original; };
}

/**
 * Remove .mgw/ inside tmpDir if it exists.
 */
function cleanMgw(tmpDir) {
  const mgwDir = path.join(tmpDir, '.mgw');
  if (fs.existsSync(mgwDir)) {
    fs.rmSync(mgwDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// getMgwDir, getActiveDir, getCompletedDir
// ---------------------------------------------------------------------------

describe('getMgwDir / getActiveDir / getCompletedDir', () => {
  let tmpDir;
  let restoreCwd;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-state-test-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete require.cache[STATE_MODULE];
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getMgwDir returns <cwd>/.mgw', () => {
    const state = loadState();
    assert.equal(state.getMgwDir(), path.join(tmpDir, '.mgw'));
  });

  it('getActiveDir returns <cwd>/.mgw/active', () => {
    const state = loadState();
    assert.equal(state.getActiveDir(), path.join(tmpDir, '.mgw', 'active'));
  });

  it('getCompletedDir returns <cwd>/.mgw/completed', () => {
    const state = loadState();
    assert.equal(state.getCompletedDir(), path.join(tmpDir, '.mgw', 'completed'));
  });

  it('all three paths share the same .mgw/ prefix', () => {
    const state = loadState();
    const mgw = state.getMgwDir();
    assert.ok(state.getActiveDir().startsWith(mgw));
    assert.ok(state.getCompletedDir().startsWith(mgw));
  });
});

// ---------------------------------------------------------------------------
// loadProjectState / writeProjectState
// ---------------------------------------------------------------------------

describe('loadProjectState / writeProjectState', () => {
  let tmpDir;
  let restoreCwd;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-state-test-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete require.cache[STATE_MODULE];
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadProjectState returns null when .mgw/ does not exist', () => {
    const state = loadState();
    assert.equal(state.loadProjectState(), null);
  });

  it('loadProjectState returns null when project.json is missing', () => {
    const state = loadState();
    fs.mkdirSync(path.join(tmpDir, '.mgw'), { recursive: true });
    assert.equal(state.loadProjectState(), null);
  });

  it('loadProjectState returns null when project.json is invalid JSON', () => {
    const state = loadState();
    const mgwDir = path.join(tmpDir, '.mgw');
    fs.mkdirSync(mgwDir, { recursive: true });
    fs.writeFileSync(path.join(mgwDir, 'project.json'), '{ broken json }', 'utf-8');
    assert.equal(state.loadProjectState(), null);
  });

  it('writeProjectState creates .mgw/ if it does not exist', () => {
    const state = loadState();
    const mgwDir = path.join(tmpDir, '.mgw');
    assert.ok(!fs.existsSync(mgwDir));
    state.writeProjectState({ name: 'test' });
    assert.ok(fs.existsSync(mgwDir));
  });

  it('writeProjectState serialises state to project.json', () => {
    const state = loadState();
    const payload = { name: 'mgw', version: '0.1.0', milestones: [] };
    state.writeProjectState(payload);
    const raw = fs.readFileSync(path.join(tmpDir, '.mgw', 'project.json'), 'utf-8');
    assert.deepEqual(JSON.parse(raw), payload);
  });

  it('loadProjectState round-trips through writeProjectState', () => {
    const state = loadState();
    const payload = { project: 'test', active_gsd_milestone: 'v1.0', milestones: [{ gsd_milestone_id: 'v1.0' }] };
    state.writeProjectState(payload);
    const loaded = state.loadProjectState();
    assert.deepEqual(loaded, payload);
  });

  it('writeProjectState overwrites existing project.json', () => {
    const state = loadState();
    state.writeProjectState({ name: 'first' });
    state.writeProjectState({ name: 'second' });
    assert.equal(state.loadProjectState().name, 'second');
  });
});

// ---------------------------------------------------------------------------
// loadActiveIssue
// ---------------------------------------------------------------------------

describe('loadActiveIssue', () => {
  let tmpDir;
  let restoreCwd;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-state-test-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete require.cache[STATE_MODULE];
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when active/ directory does not exist', () => {
    const state = loadState();
    assert.equal(state.loadActiveIssue(42), null);
  });

  it('returns null when no matching file exists in active/', () => {
    const state = loadState();
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    assert.equal(state.loadActiveIssue(42), null);
  });

  it('returns parsed JSON for a matching active issue file', () => {
    const state = loadState();
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    const issue = { number: 42, title: 'Fix bug', pipeline_stage: 'executing' };
    fs.writeFileSync(path.join(activeDir, '42-fix-bug.json'), JSON.stringify(issue), 'utf-8');
    const loaded = state.loadActiveIssue(42);
    assert.deepEqual(loaded, issue);
  });

  it('matches by numeric prefix (string number arg)', () => {
    const state = loadState();
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    const issue = { number: 7, title: 'String test' };
    fs.writeFileSync(path.join(activeDir, '7-string-test.json'), JSON.stringify(issue), 'utf-8');
    const loaded = state.loadActiveIssue('7');
    assert.deepEqual(loaded, issue);
  });

  it('does not match a file whose prefix is a superset (e.g. 42 should not match 420-*.json)', () => {
    const state = loadState();
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, '420-unrelated.json'), JSON.stringify({ number: 420 }), 'utf-8');
    assert.equal(state.loadActiveIssue(42), null);
  });

  it('returns null when active issue file contains invalid JSON', () => {
    const state = loadState();
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, '99-bad.json'), '{ not json', 'utf-8');
    assert.equal(state.loadActiveIssue(99), null);
  });
});

// ---------------------------------------------------------------------------
// mergeProjectState
// ---------------------------------------------------------------------------

describe('mergeProjectState', () => {
  let tmpDir;
  let restoreCwd;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-state-test-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete require.cache[STATE_MODULE];
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when no existing project state is found', () => {
    const state = loadState();
    assert.throws(
      () => state.mergeProjectState([], {}, 1),
      /No existing project state found/
    );
  });

  it('appends new milestones to existing milestones array', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [{ title: 'v1.0' }], phase_map: {} });
    const result = state.mergeProjectState([{ title: 'v2.0' }], {}, 2);
    assert.equal(result.milestones.length, 2);
    assert.equal(result.milestones[1].title, 'v2.0');
  });

  it('merges phase_map — new keys added, existing keys preserved (no overwrite)', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [], phase_map: { '1': 'existing' } });
    const result = state.mergeProjectState([], { '2': 'new', '1': 'overwrite-attempt' }, 1);
    // Existing key '1' must not be overwritten
    assert.equal(result.phase_map['1'], 'existing');
    // New key '2' must be added
    assert.equal(result.phase_map['2'], 'new');
  });

  it('sets active_gsd_milestone when activeGsdMilestone param is provided', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [], phase_map: {} });
    const result = state.mergeProjectState([], {}, 1, 'v2.0');
    assert.equal(result.active_gsd_milestone, 'v2.0');
  });

  it('sets legacy current_milestone when active_gsd_milestone is not in use and no activeGsdMilestone param', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [], phase_map: {} });
    const result = state.mergeProjectState([], {}, 3);
    assert.equal(result.current_milestone, 3);
  });

  it('does NOT update current_milestone when active_gsd_milestone already exists in state', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [], phase_map: {}, active_gsd_milestone: 'v1.0' });
    const result = state.mergeProjectState([], {}, 99);
    // current_milestone should NOT have been set
    assert.ok(result.current_milestone === undefined || result.current_milestone !== 99);
  });

  it('persists the merged result to disk', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [], phase_map: {} });
    state.mergeProjectState([{ title: 'v3.0' }], {}, 1);
    const onDisk = state.loadProjectState();
    assert.equal(onDisk.milestones.length, 1);
    assert.equal(onDisk.milestones[0].title, 'v3.0');
  });
});

// ---------------------------------------------------------------------------
// migrateProjectState
// ---------------------------------------------------------------------------

describe('migrateProjectState', () => {
  let tmpDir;
  let restoreCwd;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-state-test-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete require.cache[STATE_MODULE];
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns { state: null, warnings: [] } when no project.json exists', () => {
    const state = loadState();
    const result = state.migrateProjectState();
    assert.equal(result.state, null);
    assert.deepEqual(result.warnings, []);
  });

  it('adds active_gsd_milestone: null when field is missing', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [] });
    const { state: result, warnings } = state.migrateProjectState();
    assert.ok(result.hasOwnProperty('active_gsd_milestone'));
    assert.equal(result.active_gsd_milestone, null);
    assert.ok(warnings.length > 0, 'should report migration warning');
  });

  it('does NOT overwrite active_gsd_milestone when it already exists', () => {
    const state = loadState();
    state.writeProjectState({ active_gsd_milestone: 'v1.0', milestones: [] });
    const { state: result } = state.migrateProjectState();
    assert.equal(result.active_gsd_milestone, 'v1.0');
  });

  it('adds gsd_milestone_id, gsd_state, roadmap_archived_at to milestones missing those fields', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [{ title: 'v1.0' }] });
    const { state: result } = state.migrateProjectState();
    const m = result.milestones[0];
    assert.ok(m.hasOwnProperty('gsd_milestone_id'));
    assert.ok(m.hasOwnProperty('gsd_state'));
    assert.ok(m.hasOwnProperty('roadmap_archived_at'));
    assert.equal(m.gsd_milestone_id, null);
    assert.equal(m.gsd_state, null);
    assert.equal(m.roadmap_archived_at, null);
  });

  it('does NOT overwrite existing gsd_milestone_id / gsd_state / roadmap_archived_at', () => {
    const state = loadState();
    state.writeProjectState({
      milestones: [{
        title: 'v1.0',
        gsd_milestone_id: 'v1.0',
        gsd_state: 'completed',
        roadmap_archived_at: '2025-01-01T00:00:00Z'
      }]
    });
    const { state: result } = state.migrateProjectState();
    const m = result.milestones[0];
    assert.equal(m.gsd_milestone_id, 'v1.0');
    assert.equal(m.gsd_state, 'completed');
    assert.equal(m.roadmap_archived_at, '2025-01-01T00:00:00Z');
  });

  it('is idempotent — running twice yields the same state', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [{ title: 'v1.0' }] });
    const first = state.migrateProjectState();
    const second = state.migrateProjectState();
    assert.deepEqual(first.state, second.state);
  });

  it('persists migration changes to disk', () => {
    const state = loadState();
    state.writeProjectState({ milestones: [{ title: 'v1.0' }] });
    state.migrateProjectState();
    const onDisk = state.loadProjectState();
    assert.ok(onDisk.hasOwnProperty('active_gsd_milestone'));
    assert.ok(onDisk.milestones[0].hasOwnProperty('gsd_milestone_id'));
  });

  it('handles state with no milestones array gracefully', () => {
    const state = loadState();
    state.writeProjectState({ name: 'test' });
    const { state: result } = state.migrateProjectState();
    assert.ok(result.hasOwnProperty('active_gsd_milestone'));
  });
});

// ---------------------------------------------------------------------------
// resolveActiveMilestoneIndex
// ---------------------------------------------------------------------------

describe('resolveActiveMilestoneIndex', () => {
  it('returns -1 for null state', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    assert.equal(state.resolveActiveMilestoneIndex(null), -1);
  });

  it('returns -1 for undefined state', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    assert.equal(state.resolveActiveMilestoneIndex(undefined), -1);
  });

  it('new schema: resolves active_gsd_milestone string to correct 0-based index', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    const s = {
      active_gsd_milestone: 'v2.0',
      milestones: [
        { gsd_milestone_id: 'v1.0' },
        { gsd_milestone_id: 'v2.0' },
        { gsd_milestone_id: 'v3.0' }
      ]
    };
    assert.equal(state.resolveActiveMilestoneIndex(s), 1);
  });

  it('new schema: returns -1 when active_gsd_milestone does not match any milestone (dangling reference)', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    const s = {
      active_gsd_milestone: 'v99.0',
      milestones: [
        { gsd_milestone_id: 'v1.0' },
        { gsd_milestone_id: 'v2.0' }
      ]
    };
    assert.equal(state.resolveActiveMilestoneIndex(s), -1);
  });

  it('new schema: takes precedence over current_milestone when both are present', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    // current_milestone=1 (0-based: 0) vs active_gsd_milestone='v2.0' (0-based: 1)
    const s = {
      active_gsd_milestone: 'v2.0',
      current_milestone: 1,
      milestones: [
        { gsd_milestone_id: 'v1.0' },
        { gsd_milestone_id: 'v2.0' }
      ]
    };
    assert.equal(state.resolveActiveMilestoneIndex(s), 1);
  });

  it('legacy schema: converts current_milestone (1-indexed) to 0-based index', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    const s = {
      current_milestone: 3,
      milestones: [
        { title: 'v1.0' },
        { title: 'v2.0' },
        { title: 'v3.0' }
      ]
    };
    assert.equal(state.resolveActiveMilestoneIndex(s), 2);
  });

  it('legacy schema: current_milestone=1 maps to index 0', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    const s = { current_milestone: 1, milestones: [{ title: 'v1.0' }] };
    assert.equal(state.resolveActiveMilestoneIndex(s), 0);
  });

  it('returns -1 when neither active_gsd_milestone nor current_milestone is set', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    const s = { milestones: [{ gsd_milestone_id: 'v1.0' }] };
    assert.equal(state.resolveActiveMilestoneIndex(s), -1);
  });

  it('handles empty milestones array with active_gsd_milestone set', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    const s = { active_gsd_milestone: 'v1.0', milestones: [] };
    assert.equal(state.resolveActiveMilestoneIndex(s), -1);
  });

  it('handles missing milestones key entirely', () => {
    delete require.cache[STATE_MODULE];
    const state = require(STATE_MODULE);
    const s = { active_gsd_milestone: 'v1.0' };
    assert.equal(state.resolveActiveMilestoneIndex(s), -1);
  });
});
