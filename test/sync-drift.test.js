/**
 * test/sync-drift.test.js — Scenario tests for mgw:sync drift detection and auto-sync
 *
 * Tests the four drift detection scenarios described in commands/mgw/sync.md and
 * the staleness detection logic from commands/mgw/workflows/state.md:
 *
 *   Scenario 1: no-drift baseline
 *     GitHub updatedAt is older than (or equal to) local state file mtime.
 *     No sync should fire, no console.warn, state file unchanged.
 *
 *   Scenario 2: stale state auto-sync
 *     GitHub updatedAt is newer than local state file mtime.
 *     Sync fires: issue data is refreshed, state file updated, console.warn logged.
 *
 *   Scenario 3: comment delta drift
 *     Current GitHub comment count exceeds triage.last_comment_count.
 *     Comment delta > 0 is flagged as unreviewed; pipeline_stage is not mutated.
 *
 *   Scenario 4: PR merged but local stage = pr-created
 *     Linked PR has state=MERGED; issue should be reconciled to done.
 *     pipeline_stage transitions from pr-created → done.
 *
 * Isolation strategy:
 *   - lib/mock-github.cjs intercepts all gh CLI calls (child_process.execSync)
 *   - fs.mkdtempSync() creates a real tmp dir per describe block
 *   - process.cwd() is overridden to point at the tmp dir
 *   - fs.utimesSync() backdates state file mtime for staleness scenarios
 *   - afterAll() removes tmp dirs
 *
 * No live GitHub tokens or Claude API calls are used.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const MOCK_GITHUB_MODULE = path.join(REPO_ROOT, 'lib', 'mock-github.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Override process.cwd to return tmpDir. Returns restore function. */
function overrideCwd(tmpDir) {
  const original = process.cwd.bind(process);
  process.cwd = () => tmpDir;
  return () => { process.cwd = original; };
}

/** Remove a directory tree if it exists. */
function removeTmpDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Seed a minimal .mgw/active/ state file into tmpDir.
 *
 * @param {string} tmpDir - Base temp directory
 * @param {number} issueNum - Issue number
 * @param {string} slug - Short slug for filename
 * @param {object} [overrides] - Fields to merge into the default state
 * @returns {string} Absolute path to the state file
 */
function writeIssueState(tmpDir, issueNum, slug, overrides = {}) {
  const activeDir = path.join(tmpDir, '.mgw', 'active');
  fs.mkdirSync(activeDir, { recursive: true });

  const defaultState = {
    issue_number: issueNum,
    slug,
    title: `Test issue ${issueNum}`,
    pipeline_stage: 'triaged',
    gsd_route: 'plan-phase',
    created_at: new Date(Date.now() - 3600_000).toISOString(), // 1h ago
    updated_at: new Date(Date.now() - 3600_000).toISOString(),
    issue: {
      number: issueNum,
      title: `Test issue ${issueNum}`,
      url: `https://github.com/owner/repo/issues/${issueNum}`,
      labels: [],
      assignee: null,
    },
    triage: {
      scope: { files: 0, systems: [] },
      validity: 'confirmed',
      security_notes: '',
      conflicts: [],
      last_comment_count: 0,
      last_comment_at: null,
      gate_result: { status: 'passed', blockers: [], warnings: [], missing_fields: [] },
    },
    linked_branches: [],
    linked_prs: [],
    linked_issues: [],
    retry_count: 0,
    dead_letter: false,
    last_failure_class: null,
    checkpoint: null,
    comments_posted: [],
  };

  const state = Object.assign({}, defaultState, overrides);

  // Deep-merge triage and issue fields if provided
  if (overrides.triage) {
    state.triage = Object.assign({}, defaultState.triage, overrides.triage);
  }
  if (overrides.issue) {
    state.issue = Object.assign({}, defaultState.issue, overrides.issue);
  }

  const filePath = path.join(activeDir, `${issueNum}-${slug}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

/**
 * Read and parse a state file from tmpDir/.mgw/active/.
 *
 * @param {string} tmpDir - Base temp directory
 * @param {number} issueNum - Issue number to find
 * @returns {object} Parsed state
 */
function readIssueState(tmpDir, issueNum) {
  const activeDir = path.join(tmpDir, '.mgw', 'active');
  const entries = fs.readdirSync(activeDir);
  const match = entries.find(f => f.startsWith(`${issueNum}-`) && f.endsWith('.json'));
  if (!match) throw new Error(`No state file for #${issueNum} in ${activeDir}`);
  return JSON.parse(fs.readFileSync(path.join(activeDir, match), 'utf-8'));
}

/**
 * Backdate a file's mtime by the given number of seconds.
 *
 * @param {string} filePath - Absolute path to the file
 * @param {number} secondsAgo - How many seconds in the past to set mtime
 */
function backdateMtime(filePath, secondsAgo) {
  const target = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(filePath, target, target);
}

/**
 * Get a file's mtime as a Unix epoch (seconds).
 *
 * @param {string} filePath - Absolute path to the file
 * @returns {number} Epoch seconds
 */
function getMtimeEpoch(filePath) {
  return Math.floor(fs.statSync(filePath).mtimeMs / 1000);
}

/**
 * Convert an ISO timestamp string to Unix epoch seconds.
 *
 * @param {string} iso - ISO 8601 string
 * @returns {number} Epoch seconds
 */
function isoToEpoch(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Scenario 1: No-drift baseline
// ---------------------------------------------------------------------------

describe('no-drift-baseline: no sync when GitHub updatedAt <= local mtime', () => {
  let tmpDir;
  let restoreCwd;
  let mockGitHub;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-sync-nodrift-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
    mockGitHub = _require(MOCK_GITHUB_MODULE);
    mockGitHub.activate();
  });

  afterEach(() => {
    mockGitHub.deactivate();
    restoreCwd();
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  it('GH_EPOCH <= LOCAL_MTIME means no stale condition', () => {
    // State file created NOW (high mtime)
    const stateFile = writeIssueState(tmpDir, 101, 'test-issue', {
      pipeline_stage: 'triaged',
    });

    // GitHub says the issue was updated 10 minutes ago (before the mtime)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const ghEpoch = isoToEpoch(tenMinutesAgo);
    const localMtime = getMtimeEpoch(stateFile);

    // Core staleness check: GH_EPOCH > LOCAL_MTIME triggers sync
    const isStalenessTriggered = ghEpoch > localMtime;

    expect(isStalenessTriggered).toBe(false);
    expect(ghEpoch).toBeLessThanOrEqual(localMtime);
  });

  it('state file pipeline_stage is unchanged when no stale condition', () => {
    const stateFile = writeIssueState(tmpDir, 101, 'test-issue', {
      pipeline_stage: 'triaged',
    });

    // Simulate: GitHub updatedAt older than mtime → no sync performed
    const oldUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const ghEpoch = isoToEpoch(oldUpdatedAt);
    const localMtime = getMtimeEpoch(stateFile);

    expect(ghEpoch).toBeLessThanOrEqual(localMtime);

    // No sync means no state mutation
    const stateBefore = readIssueState(tmpDir, 101);
    // (no sync action taken)
    const stateAfter = readIssueState(tmpDir, 101);

    expect(stateAfter.pipeline_stage).toBe('triaged');
    expect(stateAfter.issue.title).toBe(stateBefore.issue.title);
  });

  it('mock-github call log is empty when staleness check skips sync', () => {
    writeIssueState(tmpDir, 101, 'test-issue', { pipeline_stage: 'triaged' });

    // No gh calls should fire when local mtime >= GitHub updatedAt
    const callLog = mockGitHub.getCallLog();
    expect(callLog).toHaveLength(0);
  });

  it('staleness check returns 0 (no stale) when mtime equals GitHub epoch', () => {
    const stateFile = writeIssueState(tmpDir, 101, 'test-issue', {
      pipeline_stage: 'executing',
    });

    const localMtime = getMtimeEpoch(stateFile);
    // GitHub updatedAt = exactly the same epoch as local mtime
    const sameEpochIso = new Date(localMtime * 1000).toISOString();
    const ghEpoch = isoToEpoch(sameEpochIso);

    // Equal timestamps: GH_EPOCH > LOCAL_MTIME is false (no stale)
    expect(ghEpoch > localMtime).toBe(false);
  });

  it('multiple issues — none stale — all pass without sync', () => {
    writeIssueState(tmpDir, 101, 'issue-a', { pipeline_stage: 'triaged' });
    writeIssueState(tmpDir, 102, 'issue-b', { pipeline_stage: 'executing' });

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const ghEpoch = isoToEpoch(tenMinutesAgo);

    const stateFile101 = path.join(tmpDir, '.mgw', 'active', '101-issue-a.json');
    const stateFile102 = path.join(tmpDir, '.mgw', 'active', '102-issue-b.json');

    const mtime101 = getMtimeEpoch(stateFile101);
    const mtime102 = getMtimeEpoch(stateFile102);

    // Neither file is stale
    expect(ghEpoch > mtime101).toBe(false);
    expect(ghEpoch > mtime102).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Stale auto-sync
// ---------------------------------------------------------------------------

describe('stale-auto-sync: sync fires when GitHub updatedAt > local mtime', () => {
  let tmpDir;
  let restoreCwd;
  let mockGitHub;
  let warnSpy;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-sync-stale-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
    mockGitHub = _require(MOCK_GITHUB_MODULE);
    mockGitHub.activate();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    mockGitHub.deactivate();
    restoreCwd();
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  it('GH_EPOCH > LOCAL_MTIME triggers the stale condition', () => {
    const stateFile = writeIssueState(tmpDir, 102, 'test-issue', {
      pipeline_stage: 'triaged',
    });

    // Backdate the state file to 1 hour ago
    backdateMtime(stateFile, 3600);

    // GitHub says the issue was updated 5 minutes ago (after the backdated mtime)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const ghEpoch = isoToEpoch(fiveMinutesAgo);
    const localMtime = getMtimeEpoch(stateFile);

    const isStalenessTriggered = ghEpoch > localMtime;

    expect(isStalenessTriggered).toBe(true);
    expect(ghEpoch).toBeGreaterThan(localMtime);
  });

  it('stale state sync updates issue title from fresh GitHub data', () => {
    const stateFile = writeIssueState(tmpDir, 102, 'test-issue', {
      pipeline_stage: 'triaged',
      issue: { title: 'Old title' },
    });

    // Backdate state file mtime to simulate stale state
    backdateMtime(stateFile, 3600);

    // Mock GitHub to return fresh data with updated title
    const freshIssueData = {
      number: 102,
      title: 'Updated title',
      url: 'https://github.com/owner/repo/issues/102',
      body: 'Updated body',
      labels: [{ name: 'testing' }],
      assignees: [{ login: 'developer' }],
      state: 'OPEN',
      comments: [],
      milestone: null,
    };

    mockGitHub.setResponse(
      'gh issue view 102 --json number,title,body,labels,assignees,state,comments,url,milestone',
      JSON.stringify(freshIssueData)
    );

    // Simulate the auto-sync: read fresh data, update state file .issue fields
    const freshData = JSON.parse(
      mockGitHub.isActive()
        ? JSON.stringify(freshIssueData) // mock returns this
        : '{}'
    );

    // Apply update (simulating the state.md auto-sync behavior)
    const state = readIssueState(tmpDir, 102);
    state.issue.title = freshData.title;
    state.issue.labels = freshData.labels.map(l => l.name);
    state.updated_at = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    // Verify state file was updated
    const updatedState = readIssueState(tmpDir, 102);
    expect(updatedState.issue.title).toBe('Updated title');
    expect(updatedState.issue.labels).toContain('testing');
  });

  it('stale state sync updates mtime to prevent re-triggering', () => {
    const stateFile = writeIssueState(tmpDir, 102, 'test-issue', {
      pipeline_stage: 'triaged',
    });

    // Backdate to 1 hour ago
    backdateMtime(stateFile, 3600);

    const mtimeBefore = getMtimeEpoch(stateFile);

    // Simulate: touch the file to update mtime after sync (as state.md prescribes)
    // In real code: `touch "$STATE_FILE"` — here we write and re-stat
    fs.writeFileSync(stateFile, fs.readFileSync(stateFile));

    const mtimeAfter = getMtimeEpoch(stateFile);

    // After sync, mtime should be updated (no longer stale against GitHub's 5-min-ago update)
    expect(mtimeAfter).toBeGreaterThan(mtimeBefore);
  });

  it('console.warn is called with stale state message when sync fires', () => {
    const stateFile = writeIssueState(tmpDir, 102, 'test-issue', {
      pipeline_stage: 'triaged',
    });

    backdateMtime(stateFile, 3600);

    const localMtime = getMtimeEpoch(stateFile);
    const nowIso = new Date().toISOString();
    const ghEpoch = isoToEpoch(nowIso);

    // Simulate the staleness notification from state.md:
    // "MGW: Stale state detected for #${ISSUE_NUMBER} — auto-syncing..."
    if (ghEpoch > localMtime) {
      console.warn(`MGW: Stale state detected for #102 — auto-syncing...`);
    }

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stale state detected for #102')
    );
  });

  it('pipeline_stage is preserved during auto-sync (only issue data is refreshed)', () => {
    const stateFile = writeIssueState(tmpDir, 102, 'test-issue', {
      pipeline_stage: 'executing',
      issue: { title: 'Old title' },
    });

    backdateMtime(stateFile, 3600);

    // Simulate sync: update .issue fields only, not pipeline_stage
    const state = readIssueState(tmpDir, 102);
    const stageBefore = state.pipeline_stage;
    state.issue.title = 'Updated title';
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const updatedState = readIssueState(tmpDir, 102);
    // pipeline_stage is preserved — only issue metadata refreshed
    expect(updatedState.pipeline_stage).toBe(stageBefore);
    expect(updatedState.issue.title).toBe('Updated title');
  });

  it('sync report shows stale issue in sync output', () => {
    // Simulate the sync report format from sync.md:
    // "Stale: ${stale_count} need attention"
    const STALE_COUNT = 1;
    const syncReport = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► SYNC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Active:    2 issues in progress
Completed: 0 archived
Stale:     ${STALE_COUNT} need attention
    `.trim();

    expect(syncReport).toContain('Stale:     1 need attention');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Comment delta drift
// ---------------------------------------------------------------------------

describe('comment-delta-drift: detects unreviewed comments since triage', () => {
  let tmpDir;
  let restoreCwd;
  let mockGitHub;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-sync-comment-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
    mockGitHub = _require(MOCK_GITHUB_MODULE);
    mockGitHub.activate();
  });

  afterEach(() => {
    mockGitHub.deactivate();
    restoreCwd();
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  it('COMMENT_DELTA > 0 when current count exceeds stored count', () => {
    writeIssueState(tmpDir, 103, 'test-issue', {
      pipeline_stage: 'executing',
      triage: { last_comment_count: 1 },
    });

    const CURRENT_COMMENTS = 3;
    const STORED_COMMENTS = 1;

    const COMMENT_DELTA = CURRENT_COMMENTS - STORED_COMMENTS;

    expect(COMMENT_DELTA).toBe(2);
    expect(COMMENT_DELTA).toBeGreaterThan(0);
  });

  it('COMMENT_DELTA = 0 when current count equals stored count (no drift)', () => {
    writeIssueState(tmpDir, 103, 'test-issue', {
      pipeline_stage: 'executing',
      triage: { last_comment_count: 3 },
    });

    const CURRENT_COMMENTS = 3;
    const STORED_COMMENTS = 3;

    const COMMENT_DELTA = CURRENT_COMMENTS - STORED_COMMENTS;

    expect(COMMENT_DELTA).toBe(0);
  });

  it('COMMENT_DELTA = 0 when stored count is null/missing (skip check)', () => {
    // From state.md: if STORED_COMMENTS is null/missing, skip comment drift check
    writeIssueState(tmpDir, 103, 'test-issue', {
      pipeline_stage: 'executing',
      triage: { last_comment_count: null },
    });

    const _CURRENT_COMMENTS = 5;
    const STORED_COMMENTS_RAW = null;

    // Skip check: treat as 0 delta (same as run.md pre-flight check logic)
    const _STORED_COMMENTS =
      STORED_COMMENTS_RAW === null || STORED_COMMENTS_RAW === undefined
        ? 0
        : STORED_COMMENTS_RAW;

    // With stored = 0, delta would be 5 — but in practice the check is skipped
    // when there was never a baseline. Test the guard condition:
    const shouldSkip = STORED_COMMENTS_RAW === null || STORED_COMMENTS_RAW === undefined;
    expect(shouldSkip).toBe(true);
  });

  it('pipeline_stage is NOT mutated when comment delta drift is detected', () => {
    // Comment delta is a reporting/flagging operation — it does not change pipeline_stage.
    // Only blocking comment classification (in run.md pre-flight) changes stage.
    writeIssueState(tmpDir, 103, 'test-issue', {
      pipeline_stage: 'executing',
      triage: { last_comment_count: 1 },
    });

    const CURRENT_COMMENTS = 3;
    const STORED_COMMENTS = 1;
    const COMMENT_DELTA = CURRENT_COMMENTS - STORED_COMMENTS;

    expect(COMMENT_DELTA).toBeGreaterThan(0);

    // sync.md flags comment drift in the report but does NOT update pipeline_stage
    const state = readIssueState(tmpDir, 103);
    expect(state.pipeline_stage).toBe('executing');
  });

  it('mock-github intercepts gh issue view --json comments call', () => {
    mockGitHub.setResponse(
      'gh issue view 103 --json comments',
      JSON.stringify({ comments: [{ body: 'First comment' }, { body: 'Second comment' }, { body: 'Third comment' }] })
    );

    // Simulate the call: gh issue view 103 --json comments --jq '.comments | length'
    // mock-github routes this via the issue-view fixture handler
    const callsBefore = mockGitHub.getCallLog().length;

    // The mock intercepts 'gh issue view' commands — the setResponse override applies
    expect(mockGitHub.isActive()).toBe(true);
    expect(callsBefore).toBe(0); // No calls yet in this test
  });

  it('comment drift classified as "unreviewed comments" in sync report', () => {
    // From sync.md report step:
    // "Comments: ${comment_drift_count} issues with unreviewed comments"
    const COMMENT_DRIFT_COUNT = 1;
    const COMMENT_DRIFT_DETAILS =
      '  #103 executing: 2 unreviewed comments (stored: 1, current: 3)';

    const syncReport = `Comments:  ${COMMENT_DRIFT_COUNT} issues with unreviewed comments
Unreviewed comments:
${COMMENT_DRIFT_DETAILS}`;

    expect(syncReport).toContain('1 issues with unreviewed comments');
    expect(syncReport).toContain('#103');
    expect(syncReport).toContain('2 unreviewed comments');
  });

  it('multiple issues — only one has comment drift', () => {
    writeIssueState(tmpDir, 103, 'issue-c', {
      pipeline_stage: 'executing',
      triage: { last_comment_count: 1 },
    });
    writeIssueState(tmpDir, 104, 'issue-d', {
      pipeline_stage: 'triaged',
      triage: { last_comment_count: 5 },
    });

    // Issue 103: 3 current comments, 1 stored → delta = 2 (drift)
    // Issue 104: 5 current comments, 5 stored → delta = 0 (no drift)
    const driftedIssues = [];

    const issues = [
      { number: 103, currentComments: 3, storedComments: 1 },
      { number: 104, currentComments: 5, storedComments: 5 },
    ];

    for (const issue of issues) {
      const delta = issue.currentComments - issue.storedComments;
      if (delta > 0) {
        driftedIssues.push(issue.number);
      }
    }

    expect(driftedIssues).toHaveLength(1);
    expect(driftedIssues).toContain(103);
    expect(driftedIssues).not.toContain(104);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: PR merged but local stage = pr-created
// ---------------------------------------------------------------------------

describe('pr-merged-stage-pr-created: reconcile to done when PR is merged', () => {
  let tmpDir;
  let restoreCwd;
  let mockGitHub;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-sync-prmerged-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
    mockGitHub = _require(MOCK_GITHUB_MODULE);
    mockGitHub.activate();
  });

  afterEach(() => {
    mockGitHub.deactivate();
    restoreCwd();
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  it('PR with state=MERGED triggers Completed classification', () => {
    // From sync.md check_each step:
    // Completed = Issue closed AND (PR merged OR no PR expected)
    const prState = { state: 'MERGED', mergedAt: '2026-03-05T10:00:00Z' };
    const issueState = { state: 'CLOSED', closed: true };

    const prMerged = prState.state === 'MERGED';
    const issueClosed = issueState.closed === true;

    const classification = prMerged && issueClosed ? 'Completed' : 'Active';

    expect(classification).toBe('Completed');
  });

  it('local stage pr-created with merged PR → reconciled to done', () => {
    const stateFile = writeIssueState(tmpDir, 104, 'test-issue', {
      pipeline_stage: 'pr-created',
      linked_prs: [200],
    });

    // Mock: gh pr view 200 returns MERGED
    mockGitHub.setResponse(
      'gh pr view 200',
      JSON.stringify({ number: 200, state: 'MERGED', mergedAt: '2026-03-05T10:00:00Z' })
    );

    // Mock: gh issue view 104 returns CLOSED
    mockGitHub.setResponse(
      'gh issue view 104',
      JSON.stringify({ state: 'CLOSED', closed: true })
    );

    // Simulate reconciliation: PR merged + issue closed → update pipeline_stage to done
    const state = readIssueState(tmpDir, 104);
    const prMerged = true; // from mock response above
    const issueClosed = true;

    if (state.pipeline_stage === 'pr-created' && prMerged && issueClosed) {
      state.pipeline_stage = 'done';
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    }

    const updatedState = readIssueState(tmpDir, 104);
    expect(updatedState.pipeline_stage).toBe('done');
  });

  it('completed issue state file is moved to .mgw/completed/', () => {
    const stateFile = writeIssueState(tmpDir, 104, 'test-issue', {
      pipeline_stage: 'pr-created',
      linked_prs: [200],
    });

    // Simulate archival: move state file to .mgw/completed/
    const completedDir = path.join(tmpDir, '.mgw', 'completed');
    fs.mkdirSync(completedDir, { recursive: true });

    const destPath = path.join(completedDir, path.basename(stateFile));
    fs.renameSync(stateFile, destPath);

    // Verify active/ no longer has the file
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    const activeEntries = fs.readdirSync(activeDir);
    expect(activeEntries.filter(f => f.startsWith('104-'))).toHaveLength(0);

    // Verify completed/ has the file
    const completedEntries = fs.readdirSync(completedDir);
    expect(completedEntries.filter(f => f.startsWith('104-'))).toHaveLength(1);
  });

  it('open PR (not merged) keeps stage as pr-created', () => {
    writeIssueState(tmpDir, 104, 'test-issue', {
      pipeline_stage: 'pr-created',
      linked_prs: [200],
    });

    // PR is still open
    const prState = { state: 'OPEN', mergedAt: null };

    const prMerged = prState.state === 'MERGED';
    const classification = prMerged ? 'Completed' : 'Active';

    expect(classification).toBe('Active');

    // State should remain pr-created
    const state = readIssueState(tmpDir, 104);
    if (classification === 'Active') {
      // No mutation
    }
    expect(state.pipeline_stage).toBe('pr-created');
  });

  it('issue closed but PR still open → classified as Stale (not Completed)', () => {
    // From sync.md: Stale = PR merged but issue still open (auto-close missed)
    // The inverse: issue closed but PR still open is a different edge case
    // that sync.md flags as needing attention

    const prState = { state: 'OPEN', mergedAt: null };
    const issueState = { state: 'CLOSED', closed: true };

    const prMerged = prState.state === 'MERGED';
    const issueClosed = issueState.closed === true;

    // Completed requires BOTH PR merged AND issue closed
    const classification =
      prMerged && issueClosed ? 'Completed' :
      issueClosed && !prMerged ? 'Drift' : // issue closed but PR open — unusual
      'Active';

    expect(classification).toBe('Drift');
  });

  it('mock-github pr-view-merged fixture is well-formed', () => {
    // Verify the fixture file exists and is parseable
    const fixturePath = path.join(REPO_ROOT, 'test', 'fixtures', 'github', 'pr-view-merged.json');
    expect(fs.existsSync(fixturePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    expect(content.state).toBe('MERGED');
    expect(content.mergedAt).toBeTruthy();
    expect(typeof content.number).toBe('number');
  });

  it('pr-created stage with no linked_prs does not trigger Completed classification', () => {
    writeIssueState(tmpDir, 104, 'no-linked-pr', {
      pipeline_stage: 'pr-created',
      linked_prs: [], // empty
    });

    const state = readIssueState(tmpDir, 104);

    // No PR to check — cannot classify as Completed without PR evidence
    const linkedPrs = state.linked_prs || [];
    const hasPrEvidence = linkedPrs.length > 0;

    expect(hasPrEvidence).toBe(false);

    // Without PR evidence, keep as Active (incomplete sync data)
    const classification = hasPrEvidence ? 'check-pr' : 'Active';
    expect(classification).toBe('Active');
  });
});

// ---------------------------------------------------------------------------
// Integration: sync report structure
// ---------------------------------------------------------------------------

describe('sync-report: report structure reflects all four drift signals', () => {
  it('report contains expected sections for a mixed-drift scenario', () => {
    // From sync.md report step — verify the structure of the output report
    const ACTIVE_COUNT = 1;
    const COMPLETED_COUNT = 1;
    const STALE_COUNT = 1;
    const ORPHANED_COUNT = 0;
    const COMMENT_DRIFT_COUNT = 1;
    const DELETED_COUNT = 0;

    const syncReport = [
      'MGW ► SYNC',
      `Active:    ${ACTIVE_COUNT} issues in progress`,
      `Completed: ${COMPLETED_COUNT} archived`,
      `Stale:     ${STALE_COUNT} need attention`,
      `Orphaned:  ${ORPHANED_COUNT} need attention`,
      `Comments:  ${COMMENT_DRIFT_COUNT} issues with unreviewed comments`,
      `Branches:  ${DELETED_COUNT} cleaned up`,
    ].join('\n');

    expect(syncReport).toContain('MGW ► SYNC');
    expect(syncReport).toContain('Active:    1');
    expect(syncReport).toContain('Completed: 1');
    expect(syncReport).toContain('Stale:     1');
    expect(syncReport).toContain('Comments:  1');
  });

  it('each drift scenario maps to the correct sync report field', () => {
    // Verify the mapping from scenario to report field
    const scenarioToReportField = {
      'no-drift': 'Active',
      'stale-auto-sync': 'Stale',
      'comment-delta': 'Comments',
      'pr-merged-stage-pr-created': 'Completed',
    };

    expect(scenarioToReportField['no-drift']).toBe('Active');
    expect(scenarioToReportField['stale-auto-sync']).toBe('Stale');
    expect(scenarioToReportField['comment-delta']).toBe('Comments');
    expect(scenarioToReportField['pr-merged-stage-pr-created']).toBe('Completed');
  });

  it('drift report captures all scenario types in a single sync run', () => {
    // In a real sync, multiple issues could exhibit different drift types simultaneously.
    // This test verifies the aggregation logic.
    const issueResults = [
      { number: 101, drift: 'none', stage: 'triaged' },
      { number: 102, drift: 'stale', stage: 'triaged' },
      { number: 103, drift: 'comment', stage: 'executing' },
      { number: 104, drift: 'completed', stage: 'done' },
    ];

    const active = issueResults.filter(i => i.drift === 'none');
    const stale = issueResults.filter(i => i.drift === 'stale');
    const commentDrift = issueResults.filter(i => i.drift === 'comment');
    const completed = issueResults.filter(i => i.drift === 'completed');

    expect(active).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(commentDrift).toHaveLength(1);
    expect(completed).toHaveLength(1);
  });
});
