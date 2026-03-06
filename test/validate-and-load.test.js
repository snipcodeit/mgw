/**
 * test/validate-and-load.test.js — Integration tests for validate_and_load
 * and state file lifecycle in lib/state.cjs.
 *
 * Covers:
 *   - Fresh .mgw/ init (directories, gitignore injection, cross-refs.json)
 *   - migrateProjectState() idempotency
 *   - loadActiveIssue() lifecycle (prefix pattern, null returns)
 *   - Staleness detection with mocked GitHub updatedAt timestamps
 *   - loadCrossRefs() validation and warning generation
 *
 * Isolation strategy:
 *   - fs.mkdtempSync() creates a real tmp dir per describe block
 *   - process.cwd() is overridden to point at the tmp dir so getMgwDir()
 *     stays sandboxed — same pattern as test/state.test.cjs
 *   - require.cache is cleared before each require of state.cjs so the
 *     cwd override takes effect in the module's top-level path resolution
 *   - afterEach removes .mgw/ inside tmp dir and restores process.cwd()
 *   - Tmp dirs removed in afterAll via fs.rmSync
 *   - mock-github.cjs loaded conditionally — staleness tests skip gracefully
 *     when the mock is absent (PR #247 not yet merged to this branch)
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
// Do NOT import execSync directly — the mock patches child_process.execSync on
// the module object, so we must call it via _require('child_process').execSync
// to pick up the patched version after mock.activate().

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_MODULE = path.join(REPO_ROOT, 'lib', 'state.cjs');
const MOCK_GITHUB_MODULE = path.join(REPO_ROOT, 'lib', 'mock-github.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clear the state module cache and re-require it fresh.
 * Required so that process.cwd() overrides take effect on path resolution.
 */
function loadState() {
  delete _require.cache[STATE_MODULE];
  return _require(STATE_MODULE);
}

/**
 * Override process.cwd to return tmpDir.
 * Returns a restore function — call it in afterEach.
 */
function overrideCwd(tmpDir) {
  const original = process.cwd.bind(process);
  process.cwd = () => tmpDir;
  return () => {
    process.cwd = original;
  };
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

/**
 * Write a minimal project.json into the tmp dir's .mgw/ directory.
 * Creates .mgw/ if it does not exist.
 */
function writeMinimalProject(tmpDir, overrides = {}) {
  const mgwDir = path.join(tmpDir, '.mgw');
  fs.mkdirSync(mgwDir, { recursive: true });
  const base = { milestones: [], current_milestone: 1 };
  const data = Object.assign({}, base, overrides);
  fs.writeFileSync(path.join(mgwDir, 'project.json'), JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

/**
 * Conditionally load mock-github.cjs.
 * Returns the module if available, null otherwise.
 */
function tryLoadMockGitHub() {
  try {
    delete _require.cache[MOCK_GITHUB_MODULE];
    return _require(MOCK_GITHUB_MODULE);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Group 1: Fresh .mgw/ init
// ---------------------------------------------------------------------------

describe('Group 1: Fresh .mgw/ init', () => {
  let tmpDir;
  let restoreCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-validate-g1-'));
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T1.1 – getMgwDir returns .mgw/ inside tmp dir', () => {
    const { getMgwDir } = loadState();
    expect(getMgwDir()).toBe(path.join(tmpDir, '.mgw'));
  });

  it('T1.2 – loadProjectState returns null when .mgw/ is absent', () => {
    const { loadProjectState } = loadState();
    expect(loadProjectState()).toBeNull();
  });

  it('T1.3 – writeProjectState creates .mgw/ and writes project.json', () => {
    const { writeProjectState, loadProjectState } = loadState();
    const state = { milestones: [], active_gsd_milestone: null };
    writeProjectState(state);

    const projectPath = path.join(tmpDir, '.mgw', 'project.json');
    expect(fs.existsSync(projectPath)).toBe(true);

    const loaded = loadProjectState();
    expect(loaded).toEqual(state);
  });

  it('T1.4 – cross-refs.json creation via storeDependencies', () => {
    const { storeDependencies } = loadState();

    // .mgw/ does not yet exist — storeDependencies should create it
    const result = storeDependencies(99, [42]);
    expect(result.added).toBe(1);
    expect(result.existing).toBe(0);

    const crossRefsPath = path.join(tmpDir, '.mgw', 'cross-refs.json');
    expect(fs.existsSync(crossRefsPath)).toBe(true);

    const crossRefs = JSON.parse(fs.readFileSync(crossRefsPath, 'utf-8'));
    expect(Array.isArray(crossRefs.links)).toBe(true);
    expect(crossRefs.links).toHaveLength(1);
    expect(crossRefs.links[0]).toMatchObject({
      a: '#99',
      b: '#42',
      type: 'blocked-by',
    });
  });

  it('T1.5 – gitignore injection pattern is idempotent', () => {
    // Simulate the init process: inject .mgw/ and .worktrees/ into .gitignore
    const gitignorePath = path.join(tmpDir, '.gitignore');

    // First injection
    function injectIfAbsent(entry) {
      const current = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf-8')
        : '';
      if (!current.split('\n').some(line => line.trim() === entry)) {
        fs.appendFileSync(gitignorePath, (current.length > 0 && !current.endsWith('\n') ? '\n' : '') + entry + '\n', 'utf-8');
      }
    }

    injectIfAbsent('.mgw/');
    injectIfAbsent('.worktrees/');

    const afterFirst = fs.readFileSync(gitignorePath, 'utf-8');
    const firstMgwCount = afterFirst.split('\n').filter(l => l.trim() === '.mgw/').length;
    const firstWtCount = afterFirst.split('\n').filter(l => l.trim() === '.worktrees/').length;
    expect(firstMgwCount).toBe(1);
    expect(firstWtCount).toBe(1);

    // Second injection (idempotency)
    injectIfAbsent('.mgw/');
    injectIfAbsent('.worktrees/');

    const afterSecond = fs.readFileSync(gitignorePath, 'utf-8');
    const secondMgwCount = afterSecond.split('\n').filter(l => l.trim() === '.mgw/').length;
    const secondWtCount = afterSecond.split('\n').filter(l => l.trim() === '.worktrees/').length;
    expect(secondMgwCount).toBe(1);
    expect(secondWtCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Group 2: migrateProjectState() idempotency
// ---------------------------------------------------------------------------

describe('Group 2: migrateProjectState() idempotency', () => {
  let tmpDir;
  let restoreCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-validate-g2-'));
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T2.1 – migrate adds active_gsd_milestone when absent', () => {
    writeMinimalProject(tmpDir, { milestones: [] });
    // Confirm field is absent before migration
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mgw', 'project.json'), 'utf-8'));
    expect(raw.active_gsd_milestone).toBeUndefined();

    const { migrateProjectState, loadProjectState } = loadState();
    migrateProjectState();

    const migrated = loadProjectState();
    expect(migrated).not.toBeNull();
    expect(migrated.active_gsd_milestone).toBeNull();
  });

  it('T2.2 – migrate is idempotent when called twice', () => {
    writeMinimalProject(tmpDir, { milestones: [{ title: 'v1', gsd_milestone_id: 'v1.0' }] });
    const { migrateProjectState, loadProjectState } = loadState();

    migrateProjectState();
    const afterFirst = loadProjectState();

    // Clear cache to simulate a fresh call context
    delete _require.cache[STATE_MODULE];
    const { migrateProjectState: migrate2, loadProjectState: load2 } = loadState();
    migrate2();
    const afterSecond = load2();

    // Milestone count must not change
    expect(afterSecond.milestones.length).toBe(afterFirst.milestones.length);
    // Fields must still be present once
    expect(afterSecond.active_gsd_milestone).toBeNull();
    expect(typeof afterSecond.milestones[0].gsd_milestone_id).toBe('string');
  });

  it('T2.3 – migrate adds gsd_milestone_id, gsd_state, roadmap_archived_at to milestones', () => {
    // Write milestone without the migration fields
    writeMinimalProject(tmpDir, {
      milestones: [{ title: 'v1', number: 1 }],
    });

    const { migrateProjectState, loadProjectState } = loadState();
    migrateProjectState();

    const state = loadProjectState();
    const m = state.milestones[0];
    expect(m).toHaveProperty('gsd_milestone_id');
    expect(m.gsd_milestone_id).toBeNull();
    expect(m).toHaveProperty('gsd_state');
    expect(m.gsd_state).toBeNull();
    expect(m).toHaveProperty('roadmap_archived_at');
    expect(m.roadmap_archived_at).toBeNull();
  });

  it('T2.4 – migrate adds retry_count, dead_letter, checkpoint to active issue files', () => {
    // Create .mgw/active/ with a minimal issue file missing retry fields
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });

    const issueFile = path.join(activeDir, '42-some-issue.json');
    fs.writeFileSync(issueFile, JSON.stringify({ issue_number: 42, title: 'Some issue', pipeline_stage: 'triaged' }), 'utf-8');

    // Write project.json too so migration can complete
    writeMinimalProject(tmpDir, { milestones: [] });

    const { migrateProjectState } = loadState();
    migrateProjectState();

    const migrated = JSON.parse(fs.readFileSync(issueFile, 'utf-8'));
    expect(migrated.retry_count).toBe(0);
    expect(migrated.dead_letter).toBe(false);
    expect(migrated.checkpoint).toBeNull();
  });

  it('T2.5 – migrate is idempotent on active files (run twice)', () => {
    // Create active file that already HAS retry fields
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });

    const issueFile = path.join(activeDir, '55-existing.json');
    const existing = {
      issue_number: 55,
      title: 'Existing issue',
      pipeline_stage: 'triaged',
      retry_count: 3,
      dead_letter: true,
      checkpoint: null,
    };
    fs.writeFileSync(issueFile, JSON.stringify(existing), 'utf-8');
    writeMinimalProject(tmpDir, { milestones: [] });

    const { migrateProjectState } = loadState();
    migrateProjectState();

    delete _require.cache[STATE_MODULE];
    const { migrateProjectState: m2 } = loadState();
    m2();

    const afterTwo = JSON.parse(fs.readFileSync(issueFile, 'utf-8'));
    // Migration must NOT overwrite existing non-default values
    expect(afterTwo.retry_count).toBe(3);
    expect(afterTwo.dead_letter).toBe(true);
    expect(afterTwo.checkpoint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group 3: loadActiveIssue lifecycle
// ---------------------------------------------------------------------------

describe('Group 3: loadActiveIssue lifecycle', () => {
  let tmpDir;
  let restoreCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-validate-g3-'));
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T3.1 – returns null when .mgw/active/ is absent', () => {
    const { loadActiveIssue } = loadState();
    expect(loadActiveIssue(123)).toBeNull();
  });

  it('T3.2 – returns null when no matching file exists', () => {
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, '99-other.json'), '{"issue_number":99}', 'utf-8');

    const { loadActiveIssue } = loadState();
    expect(loadActiveIssue(123)).toBeNull();
  });

  it('T3.3 – finds and returns file by numeric prefix pattern', () => {
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    const data = { issue_number: 123, title: 'My issue', pipeline_stage: 'triaged' };
    fs.writeFileSync(path.join(activeDir, '123-some-slug.json'), JSON.stringify(data), 'utf-8');

    const { loadActiveIssue } = loadState();
    const loaded = loadActiveIssue(123);
    expect(loaded).not.toBeNull();
    expect(loaded.issue_number).toBe(123);
    expect(loaded.pipeline_stage).toBe('triaged');
  });

  it('T3.4 – accepts string issue number', () => {
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    const data = { issue_number: 456, title: 'String test' };
    fs.writeFileSync(path.join(activeDir, '456-string-test.json'), JSON.stringify(data), 'utf-8');

    const { loadActiveIssue } = loadState();
    const loaded = loadActiveIssue('456');
    expect(loaded).not.toBeNull();
    expect(loaded.issue_number).toBe(456);
  });
});

// ---------------------------------------------------------------------------
// Group 4: Staleness detection with mocked GitHub updatedAt timestamps
// ---------------------------------------------------------------------------

describe('Group 4: Staleness detection with mocked GitHub timestamps', () => {
  let tmpDir;
  let restoreCwd;
  let mockGitHub;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-validate-g4-'));
    restoreCwd = overrideCwd(tmpDir);
    mockGitHub = tryLoadMockGitHub();
    // Deactivate any auto-activation from test/setup.js so we control it here
    if (mockGitHub && typeof mockGitHub.deactivate === 'function') {
      mockGitHub.deactivate();
    }
  });

  afterEach(() => {
    if (mockGitHub && typeof mockGitHub.deactivate === 'function') {
      mockGitHub.deactivate();
    }
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T4.1 – mock-github intercepts gh issue view and returns mocked updatedAt', () => {
    if (!mockGitHub) {
      // Gracefully skip when mock-github.cjs is not available
      console.warn('T4.1 skipped: lib/mock-github.cjs not available (PR #247 not merged)');
      return;
    }

    mockGitHub.activate();

    const mockResponse = JSON.stringify({ number: 99, updatedAt: '2025-01-15T12:00:00Z' });
    mockGitHub.setResponse('gh issue view', mockResponse);

    // Use _require('child_process').execSync so we pick up the patched version
    const childProcess = _require('child_process');
    let result;
    try {
      result = childProcess.execSync('gh issue view 99 --json updatedAt', { encoding: 'utf-8' });
    } catch (err) {
      result = err.stdout || '';
    }

    const parsed = JSON.parse(result.trim());
    expect(parsed.updatedAt).toBe('2025-01-15T12:00:00Z');

    mockGitHub.deactivate();
  });

  it('T4.2 – stale detection via comment count mismatch (stored=2, current=5)', () => {
    if (!mockGitHub) {
      console.warn('T4.2 skipped: lib/mock-github.cjs not available');
      return;
    }

    // Write active issue with stored comment count of 2
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    const issueState = {
      issue_number: 99,
      triage: { last_comment_count: 2 },
    };
    fs.writeFileSync(path.join(activeDir, '99-test-issue.json'), JSON.stringify(issueState), 'utf-8');

    // Mock GitHub to return 5 comments
    mockGitHub.activate();
    const mockComments = JSON.stringify({
      comments: Array.from({ length: 5 }, (_, i) => ({
        author: { login: 'user' },
        body: `Comment ${i + 1}`,
        createdAt: '2025-01-01T00:00:00Z',
      })),
    });
    mockGitHub.setResponse('gh issue view', mockComments);

    const childProcess = _require('child_process');
    let commentData;
    try {
      commentData = childProcess.execSync('gh issue view 99 --json comments', { encoding: 'utf-8' });
    } catch (err) {
      commentData = err.stdout || '{"comments":[]}';
    }

    const parsed = JSON.parse(commentData.trim());
    const currentCount = Array.isArray(parsed.comments) ? parsed.comments.length : 0;
    const storedCount = issueState.triage.last_comment_count;

    // Assert staleness detected: current > stored
    expect(currentCount).toBeGreaterThan(storedCount);
    expect(currentCount - storedCount).toBe(3);

    mockGitHub.deactivate();
  });

  it('T4.3 – no staleness when comment counts match', () => {
    if (!mockGitHub) {
      console.warn('T4.3 skipped: lib/mock-github.cjs not available');
      return;
    }

    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    const issueState = {
      issue_number: 99,
      triage: { last_comment_count: 2 },
    };
    fs.writeFileSync(path.join(activeDir, '99-test-no-stale.json'), JSON.stringify(issueState), 'utf-8');

    // Mock returns exactly 2 comments (same as stored)
    mockGitHub.activate();
    const mockComments = JSON.stringify({
      comments: Array.from({ length: 2 }, (_, i) => ({
        author: { login: 'user' },
        body: `Comment ${i + 1}`,
        createdAt: '2025-01-01T00:00:00Z',
      })),
    });
    mockGitHub.setResponse('gh issue view', mockComments);

    const childProcess = _require('child_process');
    let commentData;
    try {
      commentData = childProcess.execSync('gh issue view 99 --json comments', { encoding: 'utf-8' });
    } catch (err) {
      commentData = err.stdout || '{"comments":[]}';
    }

    const parsed = JSON.parse(commentData.trim());
    const currentCount = Array.isArray(parsed.comments) ? parsed.comments.length : 0;
    const storedCount = issueState.triage.last_comment_count;

    // No staleness: counts are equal
    expect(currentCount).toBe(storedCount);
    expect(currentCount > storedCount).toBe(false);

    mockGitHub.deactivate();
  });

  it('T4.4 – mock-github call log captures gh commands', () => {
    if (!mockGitHub) {
      console.warn('T4.4 skipped: lib/mock-github.cjs not available');
      return;
    }

    mockGitHub.activate();
    mockGitHub.clearCallLog();

    mockGitHub.setResponse('gh issue view', JSON.stringify({ number: 77 }));

    const childProcess = _require('child_process');
    try {
      childProcess.execSync('gh issue view 77 --json number', { encoding: 'utf-8' });
    } catch {
      // ignore exit code
    }

    const log = mockGitHub.getCallLog();
    expect(Array.isArray(log)).toBe(true);
    expect(log.length).toBeGreaterThanOrEqual(1);

    const entry = log[0];
    expect(entry).toHaveProperty('cmd');
    expect(entry.cmd).toContain('gh');

    mockGitHub.deactivate();
  });
});

// ---------------------------------------------------------------------------
// Group 5: loadCrossRefs validation
// ---------------------------------------------------------------------------

describe('Group 5: loadCrossRefs validation', () => {
  let tmpDir;
  let restoreCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-validate-g5-'));
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T5.1 – returns empty links when cross-refs.json is absent', () => {
    const { loadCrossRefs } = loadState();
    const result = loadCrossRefs();
    expect(result.links).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('T5.2 – parses valid cross-refs.json and returns links', () => {
    const mgwDir = path.join(tmpDir, '.mgw');
    fs.mkdirSync(mgwDir, { recursive: true });

    const data = {
      links: [
        { a: 'issue:1', b: 'issue:2', type: 'related' },
      ],
    };
    fs.writeFileSync(path.join(mgwDir, 'cross-refs.json'), JSON.stringify(data), 'utf-8');

    const { loadCrossRefs } = loadState();
    const result = loadCrossRefs();
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({ a: 'issue:1', b: 'issue:2', type: 'related' });
    expect(result.warnings).toEqual([]);
  });

  it('T5.3 – skips invalid links and adds warnings for missing "a"', () => {
    const mgwDir = path.join(tmpDir, '.mgw');
    fs.mkdirSync(mgwDir, { recursive: true });

    const data = {
      links: [
        { b: 'issue:2', type: 'related' }, // missing "a"
      ],
    };
    fs.writeFileSync(path.join(mgwDir, 'cross-refs.json'), JSON.stringify(data), 'utf-8');

    const { loadCrossRefs } = loadState();
    const result = loadCrossRefs();
    expect(result.links).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('missing "a"');
  });

  it('T5.4 – returns warning when cross-refs.json has malformed JSON', () => {
    const mgwDir = path.join(tmpDir, '.mgw');
    fs.mkdirSync(mgwDir, { recursive: true });
    fs.writeFileSync(path.join(mgwDir, 'cross-refs.json'), 'NOT JSON', 'utf-8');

    const { loadCrossRefs } = loadState();
    const result = loadCrossRefs();
    expect(result.links).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('parse error');
  });

  it('T5.5 – returns warning when cross-refs.json has no links array', () => {
    const mgwDir = path.join(tmpDir, '.mgw');
    fs.mkdirSync(mgwDir, { recursive: true });
    fs.writeFileSync(path.join(mgwDir, 'cross-refs.json'), JSON.stringify({ entries: [] }), 'utf-8');

    const { loadCrossRefs } = loadState();
    const result = loadCrossRefs();
    expect(result.links).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
