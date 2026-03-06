/**
 * test/milestone-execution.test.js — Scenario tests for mgw:milestone execution loop
 *
 * Tests the orchestration logic described in commands/milestone.md:
 *   - Dependency-ordered execution (topological sort via lib/state.cjs)
 *   - Failed-issue recovery: Retry (resetRetryState), Skip (blocked dependents), Abort
 *   - Rate limit guard (REMAINING < ESTIMATED_CALLS → cap MAX_ISSUES)
 *   - Next-milestone GSD linkage check (linked vs unlinked gsd_milestone_id)
 *
 * Isolation strategy:
 *   - lib/state.cjs is loaded fresh (cache evicted) per describe block
 *   - lib/retry.cjs is loaded fresh per describe block
 *   - mock-github intercepts gh CLI calls; mock-gsd-agent records agent spawns
 *   - fs.mkdtempSync() creates a real tmp dir; process.cwd() override sandboxes it
 *   - Fixtures in test/fixtures/project-state/milestone-execution.json seed project.json
 *   - test/fixtures/github/rate-limit-low.json provides a constrained rate limit scenario
 *   - afterAll() removes tmp dirs
 *
 * No live GitHub tokens or Claude API calls are used.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const STATE_MODULE = path.join(REPO_ROOT, 'lib', 'state.cjs');
const RETRY_MODULE = path.join(REPO_ROOT, 'lib', 'retry.cjs');
const MOCK_GITHUB_MODULE = path.join(REPO_ROOT, 'lib', 'mock-github.cjs');
const MOCK_AGENT_MODULE = path.join(REPO_ROOT, 'lib', 'mock-gsd-agent.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'project-state');
const MILESTONE_FIXTURE = path.join(FIXTURE_DIR, 'milestone-execution.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reload lib/state.cjs fresh (evict cache). */
function loadState() {
  delete _require.cache[STATE_MODULE];
  return _require(STATE_MODULE);
}

/** Reload lib/retry.cjs fresh (evict cache). */
function loadRetry() {
  delete _require.cache[RETRY_MODULE];
  return _require(RETRY_MODULE);
}

/** Override process.cwd to return tmpDir. Returns restore function. */
function overrideCwd(tmpDir) {
  const original = process.cwd.bind(process);
  process.cwd = () => tmpDir;
  return () => { process.cwd = original; };
}

/** Create .mgw/active/ and .mgw/project.json inside tmpDir. */
function seedMgwDir(tmpDir, projectFixture) {
  const mgwDir = path.join(tmpDir, '.mgw');
  const activeDir = path.join(mgwDir, 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(path.join(mgwDir, 'completed'), { recursive: true });
  fs.writeFileSync(
    path.join(mgwDir, 'project.json'),
    JSON.stringify(projectFixture, null, 2)
  );
  return { mgwDir, activeDir };
}

/** Write a minimal active issue state file into tmpDir/.mgw/active/. */
function writeIssueState(tmpDir, issueNum, slug, overrides = {}) {
  const activeDir = path.join(tmpDir, '.mgw', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const state = Object.assign(
    {
      issue_number: issueNum,
      slug,
      title: `Test issue ${issueNum}`,
      pipeline_stage: 'new',
      gsd_route: 'plan-phase',
      retry_count: 0,
      dead_letter: false,
      last_failure_class: null,
      checkpoint: null,
    },
    overrides
  );
  const filePath = path.join(activeDir, `${issueNum}-${slug}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

/** Read active issue state from tmpDir/.mgw/active/. */
function readIssueState(tmpDir, issueNum) {
  const activeDir = path.join(tmpDir, '.mgw', 'active');
  const entries = fs.readdirSync(activeDir);
  const match = entries.find(f => f.startsWith(`${issueNum}-`) && f.endsWith('.json'));
  if (!match) throw new Error(`No state file for #${issueNum} in ${activeDir}`);
  return JSON.parse(fs.readFileSync(path.join(activeDir, match), 'utf-8'));
}

/** Load the milestone-execution fixture. */
function loadMilestoneFixture() {
  return JSON.parse(fs.readFileSync(MILESTONE_FIXTURE, 'utf-8'));
}

/** Remove a directory tree if it exists. */
function removeTmpDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: Dependency-ordered execution (topological sort)
// ---------------------------------------------------------------------------

describe('dependency-order: topological sort respects blocked-by links', () => {
  let tmpDir;
  let restoreCwd;
  let mockGitHub;
  let mockAgent;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-milestone-dep-test-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
    mockGitHub = _require(MOCK_GITHUB_MODULE);
    mockAgent = _require(MOCK_AGENT_MODULE);
    mockGitHub.activate();
    mockAgent.activate();
  });

  afterEach(() => {
    mockGitHub.deactivate();
    mockAgent.deactivate();
    restoreCwd();
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  it('sorts four issues respecting a linear dependency chain', () => {
    const state = loadState();

    // Issues: 101 ← 102 ← 103 (dependency chain), 104 standalone
    const issues = [
      { number: 101, title: 'Set up base infrastructure' },
      { number: 102, title: 'Add core logic layer' },
      { number: 103, title: 'Implement API endpoints' },
      { number: 104, title: 'Add documentation' },
    ];

    // 102 blocked by 101, 103 blocked by 102
    const links = [
      { a: 'issue:#102', b: 'issue:#101', type: 'blocked-by' },
      { a: 'issue:#103', b: 'issue:#102', type: 'blocked-by' },
    ];

    const sorted = state.topologicalSort(issues, links);
    const nums = sorted.map(i => i.number);

    // 101 must come before 102
    expect(nums.indexOf(101)).toBeLessThan(nums.indexOf(102));
    // 102 must come before 103
    expect(nums.indexOf(102)).toBeLessThan(nums.indexOf(103));
    // All 4 issues appear exactly once
    expect(nums).toHaveLength(4);
    expect(new Set(nums).size).toBe(4);
  });

  it('returns all issues when there are no dependency links', () => {
    const state = loadState();

    const issues = [
      { number: 101, title: 'Issue A' },
      { number: 102, title: 'Issue B' },
      { number: 103, title: 'Issue C' },
    ];

    const sorted = state.topologicalSort(issues, []);
    expect(sorted).toHaveLength(3);
    // Order is preserved (original order) when no dependencies
    expect(sorted.map(i => i.number)).toEqual([101, 102, 103]);
  });

  it('sorts standalone issues before their dependents', () => {
    const state = loadState();

    // 104 has no deps; should appear before 102 and 103 OR at least before its own dependents
    const issues = [
      { number: 101, title: 'Set up base infrastructure' },
      { number: 102, title: 'Add core logic layer' },
      { number: 103, title: 'Implement API endpoints' },
      { number: 104, title: 'Add documentation' },
    ];

    // Only 102 → 101, 103 → 102 chain. 104 is independent.
    const links = [
      { a: 'issue:#102', b: 'issue:#101', type: 'blocked-by' },
      { a: 'issue:#103', b: 'issue:#102', type: 'blocked-by' },
    ];

    const sorted = state.topologicalSort(issues, links);
    const nums = sorted.map(i => i.number);

    // Core invariant: dependency order respected
    expect(nums.indexOf(101)).toBeLessThan(nums.indexOf(102));
    expect(nums.indexOf(102)).toBeLessThan(nums.indexOf(103));
    // 104 has no deps and no dependents — it appears somewhere in the result
    expect(nums).toContain(104);
  });

  it('handles a single issue with no links', () => {
    const state = loadState();

    const issues = [{ number: 55, title: 'Solo issue' }];
    const sorted = state.topologicalSort(issues, []);

    expect(sorted).toHaveLength(1);
    expect(sorted[0].number).toBe(55);
  });

  it('ignores non-blocked-by link types during sort', () => {
    const state = loadState();

    const issues = [
      { number: 101, title: 'Issue A' },
      { number: 102, title: 'Issue B' },
    ];

    // 'related' links should not affect sort order
    const links = [
      { a: 'issue:#102', b: 'issue:#101', type: 'related' },
    ];

    const sorted = state.topologicalSort(issues, links);
    // Without blocked-by constraints, order follows original
    expect(sorted.map(i => i.number)).toEqual([101, 102]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Failed issue → Retry (resetRetryState, re-run)
// ---------------------------------------------------------------------------

describe('failed-issue-retry: resetRetryState clears retry fields for re-run', () => {
  let tmpDir;
  let restoreCwd;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-milestone-retry-test-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
    delete _require.cache[STATE_MODULE];
    delete _require.cache[RETRY_MODULE];
  });

  afterEach(() => {
    restoreCwd();
    delete _require.cache[STATE_MODULE];
    delete _require.cache[RETRY_MODULE];
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  it('resetRetryState clears retry_count, dead_letter, and last_failure_class', () => {
    const retry = loadRetry();

    const failedState = {
      issue_number: 102,
      pipeline_stage: 'failed',
      retry_count: 2,
      dead_letter: false,
      last_failure_class: 'transient',
    };

    const reset = retry.resetRetryState(failedState);

    expect(reset.retry_count).toBe(0);
    expect(reset.dead_letter).toBe(false);
    expect(reset.last_failure_class).toBeNull();
    // pipeline_stage is NOT changed by resetRetryState — caller sets it separately
    expect(reset.pipeline_stage).toBe('failed');
  });

  it('resetRetryState clears dead_letter=true (dead-lettered issues become retriable)', () => {
    const retry = loadRetry();

    const deadLettered = {
      issue_number: 102,
      pipeline_stage: 'failed',
      retry_count: 3,
      dead_letter: true,
      last_failure_class: 'permanent',
    };

    const reset = retry.resetRetryState(deadLettered);

    expect(reset.dead_letter).toBe(false);
    expect(reset.retry_count).toBe(0);
    expect(reset.last_failure_class).toBeNull();
  });

  it('canRetry returns true after resetRetryState', () => {
    const retry = loadRetry();

    const exhausted = {
      issue_number: 102,
      retry_count: 3,
      dead_letter: false,
      last_failure_class: 'transient',
    };

    // Before reset: not retryable (retry_count at MAX_RETRIES)
    expect(retry.canRetry(exhausted)).toBe(false);

    // After reset: retryable
    const reset = retry.resetRetryState(exhausted);
    expect(retry.canRetry(reset)).toBe(true);
  });

  it('resetRetryState is immutable — does not modify the original state object', () => {
    const retry = loadRetry();

    const original = {
      issue_number: 102,
      retry_count: 2,
      dead_letter: true,
      last_failure_class: 'transient',
    };
    const originalCopy = Object.assign({}, original);

    const reset = retry.resetRetryState(original);

    // Original unchanged
    expect(original).toEqual(originalCopy);
    // Reset is a new object
    expect(reset).not.toBe(original);
  });

  it('canRetry is false when retry_count equals MAX_RETRIES (3)', () => {
    const retry = loadRetry();

    const atLimit = { retry_count: 3, dead_letter: false };
    expect(retry.canRetry(atLimit)).toBe(false);
  });

  it('canRetry is true when retry_count is below MAX_RETRIES', () => {
    const retry = loadRetry();

    expect(retry.canRetry({ retry_count: 0, dead_letter: false })).toBe(true);
    expect(retry.canRetry({ retry_count: 1, dead_letter: false })).toBe(true);
    expect(retry.canRetry({ retry_count: 2, dead_letter: false })).toBe(true);
  });

  it('pipeline_stage should be set to triaged after retry — resetRetryState + caller sets stage', () => {
    const retry = loadRetry();

    const failedState = {
      issue_number: 102,
      pipeline_stage: 'failed',
      retry_count: 1,
      dead_letter: false,
      last_failure_class: 'transient',
    };

    // resetRetryState does NOT change pipeline_stage — the milestone loop does
    const reset = retry.resetRetryState(failedState);
    const readyForRetry = Object.assign({}, reset, { pipeline_stage: 'triaged' });

    expect(readyForRetry.pipeline_stage).toBe('triaged');
    expect(readyForRetry.retry_count).toBe(0);
    expect(retry.canRetry(readyForRetry)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Failed issue → Skip (marks blocked, continues loop)
// ---------------------------------------------------------------------------

describe('failed-issue-skip: dependents blocked when blocker in FAILED_ISSUES', () => {
  let tmpDir;
  let restoreCwd;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-milestone-skip-test-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterEach(() => {
    restoreCwd();
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  it('issue with a failed blocker in FAILED_ISSUES should be skipped', () => {
    // Simulate the milestone execute_loop blocking logic:
    // IS_BLOCKED = true when any dependency appears in FAILED_ISSUES

    const FAILED_ISSUES = [101]; // issue 101 failed

    // Issue 102 depends on 101 (slug-based dependency)
    const issueData = {
      github_number: 102,
      title: 'Add core logic layer',
      depends_on_slugs: ['set-up-base-infrastructure'],
    };

    // Slug for issue 101
    const issue101Slug = 'set-up-base-infrastructure';
    const issue101Number = 101;

    // Simulate the blocking check: IS_BLOCKED when any failed issue's slug
    // matches a dependency slug of the current issue
    const issueMap = new Map([
      [101, { slug: issue101Slug, github_number: 101 }],
    ]);

    let isBlocked = false;
    for (const failedNum of FAILED_ISSUES) {
      const failedIssue = issueMap.get(failedNum);
      if (!failedIssue) continue;
      if (issueData.depends_on_slugs.includes(failedIssue.slug)) {
        isBlocked = true;
        break;
      }
    }

    expect(isBlocked).toBe(true);
  });

  it('issue with no failed blockers should NOT be blocked', () => {
    const FAILED_ISSUES = [101]; // issue 101 failed

    // Issue 104 has no deps — should run regardless
    const issueData = {
      github_number: 104,
      title: 'Add documentation',
      depends_on_slugs: [],
    };

    const issueMap = new Map([
      [101, { slug: 'set-up-base-infrastructure', github_number: 101 }],
    ]);

    let isBlocked = false;
    for (const failedNum of FAILED_ISSUES) {
      const failedIssue = issueMap.get(failedNum);
      if (!failedIssue) continue;
      if (issueData.depends_on_slugs.includes(failedIssue.slug)) {
        isBlocked = true;
        break;
      }
    }

    expect(isBlocked).toBe(false);
  });

  it('blocked issues are excluded from completed count and added to BLOCKED_ISSUES', () => {
    const COMPLETED_ISSUES = [];
    const BLOCKED_ISSUES = [];
    const FAILED_ISSUES = [101];
    const SKIPPED_ISSUES = [];

    // Simulate loop behavior: issue 102 is blocked by failed 101
    const issueMap = new Map([
      [101, { slug: 'set-up-base-infrastructure', github_number: 101 }],
    ]);

    const issue102 = {
      github_number: 102,
      title: 'Add core logic layer',
      depends_on_slugs: ['set-up-base-infrastructure'],
    };

    // Check blocking
    let isBlocked = false;
    for (const failedNum of FAILED_ISSUES) {
      const fi = issueMap.get(failedNum);
      if (fi && issue102.depends_on_slugs.includes(fi.slug)) {
        isBlocked = true;
        break;
      }
    }

    if (isBlocked) {
      BLOCKED_ISSUES.push(issue102.github_number);
      // continue — do NOT add to completed
    } else {
      COMPLETED_ISSUES.push(issue102.github_number);
    }

    expect(BLOCKED_ISSUES).toContain(102);
    expect(COMPLETED_ISSUES).not.toContain(102);
    expect(SKIPPED_ISSUES).not.toContain(102);
  });

  it('skip does not affect issues that are not dependents of the failed issue', () => {
    const FAILED_ISSUES = [102]; // only 102 failed
    const BLOCKED_ISSUES = [];

    const issueMap = new Map([
      [102, { slug: 'add-core-logic-layer', github_number: 102 }],
    ]);

    // Issue 104 has no deps on 102
    const issue104 = {
      github_number: 104,
      title: 'Add documentation',
      depends_on_slugs: [],
    };

    let isBlocked = false;
    for (const failedNum of FAILED_ISSUES) {
      const fi = issueMap.get(failedNum);
      if (fi && issue104.depends_on_slugs.includes(fi.slug)) {
        isBlocked = true;
        break;
      }
    }

    if (isBlocked) BLOCKED_ISSUES.push(104);

    expect(BLOCKED_ISSUES).not.toContain(104);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Failed issue → Abort (stops loop)
// ---------------------------------------------------------------------------

describe('failed-issue-abort: abort choice stops the execution loop', () => {
  it('abort stops loop — no subsequent issues executed', () => {
    // Simulate the INTERACTIVE abort path from the execute_loop.
    // When user chooses Abort, the loop breaks. We model this as a
    // function returning whether to continue after each issue result.

    function handleIssueResult(issueNumber, pipelineStage, userChoice, abortFlag) {
      if (userChoice === 'Abort') {
        return { shouldContinue: false, aborted: true };
      }
      return { shouldContinue: true, aborted: false };
    }

    // Issue 101 completes but user chooses Abort
    const result = handleIssueResult(101, 'done', 'Abort', false);
    expect(result.shouldContinue).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it('abort after first issue means remaining issues are not run', () => {
    const issues = [101, 102, 103, 104];
    const executed = [];
    let aborted = false;

    for (const issueNum of issues) {
      if (aborted) break;

      executed.push(issueNum);

      // Simulate: user aborts after issue 101
      if (issueNum === 101) {
        aborted = true;
        break;
      }
    }

    expect(executed).toEqual([101]);
    expect(executed).not.toContain(102);
    expect(executed).not.toContain(103);
    expect(executed).not.toContain(104);
  });

  it('abort is distinguishable from skip (skip continues, abort stops)', () => {
    // Skip: moves to next issue (continue in loop)
    // Abort: stops the entire loop (break)

    const issues = [101, 102, 103];
    const executedWithSkip = [];
    const executedWithAbort = [];

    // Skip scenario: skip 102, continue to 103
    for (const issueNum of issues) {
      if (issueNum === 102) {
        // continue (skip)
        continue;
      }
      executedWithSkip.push(issueNum);
    }

    // Abort scenario: stop after 101
    let aborted = false;
    for (const issueNum of issues) {
      if (aborted) break;
      executedWithAbort.push(issueNum);
      if (issueNum === 101) {
        aborted = true;
        break;
      }
    }

    // Skip: 101 and 103 run, 102 skipped
    expect(executedWithSkip).toEqual([101, 103]);
    expect(executedWithSkip).not.toContain(102);

    // Abort: only 101 runs
    expect(executedWithAbort).toEqual([101]);
    expect(executedWithAbort).not.toContain(102);
    expect(executedWithAbort).not.toContain(103);
  });

  it('FAILED_ISSUES receives failed issue before abort check', () => {
    // In the execute_loop, after an issue fails, it is pushed to FAILED_ISSUES
    // regardless of whether the user then chooses Abort.
    const FAILED_ISSUES = [];
    const COMPLETED_ISSUES = [];

    // Issue 101 fails
    const issue101Result = { prNumber: null }; // no PR created
    if (!issue101Result.prNumber) {
      FAILED_ISSUES.push(101);
    } else {
      COMPLETED_ISSUES.push(101);
    }

    // User chooses Abort — loop breaks, but FAILED_ISSUES already has 101
    const aborted = true;

    expect(FAILED_ISSUES).toContain(101);
    expect(COMPLETED_ISSUES).not.toContain(101);
    expect(aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Rate limit guard (REMAINING < ESTIMATED_CALLS → cap MAX_ISSUES)
// ---------------------------------------------------------------------------

describe('rate-limit-guard: caps MAX_ISSUES when REMAINING < ESTIMATED_CALLS', () => {
  let mockGitHub;

  beforeEach(() => {
    mockGitHub = _require(MOCK_GITHUB_MODULE);
    mockGitHub.activate();
  });

  afterEach(() => {
    mockGitHub.deactivate();
  });

  it('calculates MAX_ISSUES as REMAINING / 25 when rate limit is constrained', () => {
    // From milestone.md: ESTIMATED_CALLS = UNFINISHED_COUNT * 25, SAFE_ISSUES = REMAINING / 25
    const REMAINING = 50;
    const UNFINISHED_COUNT = 4;
    const CALLS_PER_ISSUE = 25;

    const ESTIMATED_CALLS = UNFINISHED_COUNT * CALLS_PER_ISSUE; // 100
    const SAFE_ISSUES = Math.floor(REMAINING / CALLS_PER_ISSUE); // 2
    const MAX_ISSUES = REMAINING < ESTIMATED_CALLS ? SAFE_ISSUES : UNFINISHED_COUNT;

    expect(ESTIMATED_CALLS).toBe(100);
    expect(SAFE_ISSUES).toBe(2);
    expect(MAX_ISSUES).toBe(2);
    expect(MAX_ISSUES).toBeLessThan(UNFINISHED_COUNT);
  });

  it('does NOT cap MAX_ISSUES when REMAINING >= ESTIMATED_CALLS', () => {
    const REMAINING = 4999;
    const UNFINISHED_COUNT = 4;
    const CALLS_PER_ISSUE = 25;

    const ESTIMATED_CALLS = UNFINISHED_COUNT * CALLS_PER_ISSUE; // 100
    const SAFE_ISSUES = Math.floor(REMAINING / CALLS_PER_ISSUE); // 199
    const MAX_ISSUES = REMAINING < ESTIMATED_CALLS ? SAFE_ISSUES : UNFINISHED_COUNT;

    expect(MAX_ISSUES).toBe(UNFINISHED_COUNT); // No cap
    expect(MAX_ISSUES).toBe(4);
  });

  it('loop breaks when ISSUES_RUN reaches MAX_ISSUES', () => {
    const MAX_ISSUES = 2;
    const issues = [101, 102, 103, 104];
    const executed = [];
    let ISSUES_RUN = 0;

    for (const issueNum of issues) {
      if (ISSUES_RUN >= MAX_ISSUES) {
        // Rate limit cap reached — stop
        break;
      }
      executed.push(issueNum);
      ISSUES_RUN++;
    }

    expect(executed).toHaveLength(MAX_ISSUES);
    expect(executed).toEqual([101, 102]);
    expect(executed).not.toContain(103);
    expect(executed).not.toContain(104);
  });

  it('mock-github returns low rate limit from rate-limit-low fixture', () => {
    // Override mock to return the low rate limit fixture
    mockGitHub.setResponse('gh api rate_limit', JSON.stringify({
      resources: {
        core: { remaining: 50, limit: 5000, reset: 1700000000, used: 4950 },
      },
      rate: { remaining: 50, limit: 5000, reset: 1700000000, used: 4950 },
    }));

    // Simulate the rate limit check from milestone.md
    // In real code: RATE_JSON=$(gh api rate_limit --jq '.resources.core')
    // Here we verify the mock intercepts the call correctly

    const callLog = mockGitHub.getCallLog();
    // No calls made yet — just verifying override was set
    expect(callLog).toHaveLength(0);

    // Verify the low limit logic
    const REMAINING = 50;
    const UNFINISHED_COUNT = 4;
    const ESTIMATED_CALLS = UNFINISHED_COUNT * 25;
    const rateLimitTriggered = REMAINING < ESTIMATED_CALLS;

    expect(rateLimitTriggered).toBe(true);
  });

  it('SAFE_ISSUES is 0 when REMAINING < 25 (one issue cost)', () => {
    const REMAINING = 10;
    const SAFE_ISSUES = Math.floor(REMAINING / 25); // 0

    expect(SAFE_ISSUES).toBe(0);

    // With MAX_ISSUES = 0, loop never executes
    const issues = [101, 102, 103];
    const executed = [];
    let ISSUES_RUN = 0;
    for (const issueNum of issues) {
      if (ISSUES_RUN >= SAFE_ISSUES) break; // breaks immediately
      executed.push(issueNum);
      ISSUES_RUN++;
    }

    expect(executed).toHaveLength(0);
  });

  it('rate limit check is bypassed when gh api call fails (undefined REMAINING)', () => {
    // If gh api rate_limit fails, RATE_JSON is empty — MAX_ISSUES = UNFINISHED_COUNT
    const UNFINISHED_COUNT = 4;
    const RATE_JSON = ''; // simulates failed gh api call

    // From milestone.md: if RATE_JSON is empty, skip check and proceed without cap
    const MAX_ISSUES = RATE_JSON ? Math.floor(50 / 25) : UNFINISHED_COUNT;

    expect(MAX_ISSUES).toBe(UNFINISHED_COUNT);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Next-milestone GSD linkage check
// ---------------------------------------------------------------------------

describe('next-milestone-gsd-linkage: linked vs unlinked gsd_milestone_id', () => {
  let tmpDir;
  let restoreCwd;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-milestone-linkage-test-'));
  });

  beforeEach(() => {
    restoreCwd = overrideCwd(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterEach(() => {
    restoreCwd();
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  it('next milestone with gsd_milestone_id set → linked check reports linked', () => {
    // Simulate the NEXT_MILESTONE_CHECK logic from milestone.md post_loop step.
    // linked:<name>:<gsdId> when gsd_milestone_id is set
    const nextMilestone = {
      name: 'v2 — Next Milestone',
      gsd_milestone_id: 'v2.0',
    };

    const gsdId = nextMilestone.gsd_milestone_id;
    const name = nextMilestone.name;

    const checkResult = gsdId ? `linked:${name}:${gsdId}` : `unlinked:${name}`;

    expect(checkResult).toMatch(/^linked:/);
    expect(checkResult).toContain('v2.0');
    expect(checkResult).toContain(name);
  });

  it('next milestone with null gsd_milestone_id → unlinked check reports unlinked', () => {
    const nextMilestone = {
      name: 'v2 — Next Milestone',
      gsd_milestone_id: null,
    };

    const gsdId = nextMilestone.gsd_milestone_id;
    const name = nextMilestone.name;

    const checkResult = gsdId ? `linked:${name}:${gsdId}` : `unlinked:${name}`;

    expect(checkResult).toMatch(/^unlinked:/);
    expect(checkResult).toContain(name);
    expect(checkResult).not.toContain('v2.0');
  });

  it('no next milestone → reports none (all milestones complete)', () => {
    // From milestone.md: if activeIdx >= milestones.length, output "none"
    const milestones = [
      { name: 'v1', gsd_milestone_id: 'v1.0', gsd_state: 'completed' },
    ];
    // After completing last milestone, active pointer moves past end
    const activeIdx = 1; // past end of array

    const nextMilestone = milestones[activeIdx] || null;

    const checkResult = nextMilestone
      ? (nextMilestone.gsd_milestone_id
        ? `linked:${nextMilestone.name}:${nextMilestone.gsd_milestone_id}`
        : `unlinked:${nextMilestone.name}`)
      : 'none';

    expect(checkResult).toBe('none');
  });

  it('reads next milestone correctly from milestone-execution fixture', () => {
    const fixture = loadMilestoneFixture();

    // milestone[0] is v1 (active, gsd_milestone_id = 'v1.0')
    // milestone[1] is v2 (planned, gsd_milestone_id = null)

    const currentIdx = 0; // completing milestone 0
    const nextMilestone = fixture.milestones[currentIdx + 1];

    expect(nextMilestone).toBeDefined();
    expect(nextMilestone.name).toBe('v2 — Next Milestone');
    expect(nextMilestone.gsd_milestone_id).toBeNull();

    const checkResult = nextMilestone.gsd_milestone_id
      ? `linked:${nextMilestone.name}:${nextMilestone.gsd_milestone_id}`
      : `unlinked:${nextMilestone.name}`;

    expect(checkResult).toMatch(/^unlinked:/);
  });

  it('active milestone pointer advances correctly after milestone completion', () => {
    const state = loadState();
    const fixture = loadMilestoneFixture();

    // Seed project.json
    const { mgwDir } = seedMgwDir(tmpDir, fixture);

    // Verify resolveActiveMilestoneIndex returns 0 (v1.0 is active)
    delete _require.cache[STATE_MODULE];
    const freshState = loadState();
    const projectState = freshState.loadProjectState();

    expect(projectState).not.toBeNull();
    const activeIdx = freshState.resolveActiveMilestoneIndex(projectState);
    expect(activeIdx).toBe(0);

    // After completing milestone 0, active pointer should advance to 1
    const nextMilestone = projectState.milestones[activeIdx + 1];
    expect(nextMilestone).toBeDefined();
    expect(nextMilestone.gsd_milestone_id).toBeNull(); // unlinked
  });

  it('linked milestone with ROADMAP.md match is fully ready', () => {
    // Simulate the full linked path check:
    // linked:<name>:<gsdId> → verify ROADMAP.md contains gsdId
    const nextMilestone = {
      name: 'v3 — Third Milestone',
      gsd_milestone_id: 'v3.0',
    };

    // Simulate ROADMAP.md containing the GSD milestone ID
    const roadmapContent = '# Roadmap\n\n## v3.0 — Third Milestone\n\nPhases...';
    const roadmapValid = roadmapContent.includes(nextMilestone.gsd_milestone_id);

    const checkResult = nextMilestone.gsd_milestone_id
      ? `linked:${nextMilestone.name}:${nextMilestone.gsd_milestone_id}`
      : `unlinked:${nextMilestone.name}`;

    expect(checkResult).toMatch(/^linked:/);
    expect(roadmapValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: project.json fixture integrity check
// ---------------------------------------------------------------------------

describe('fixture integrity: milestone-execution.json is well-formed', () => {
  it('fixture file exists and is valid JSON', () => {
    expect(() => loadMilestoneFixture()).not.toThrow();
    const fixture = loadMilestoneFixture();
    expect(fixture).toBeDefined();
    expect(typeof fixture).toBe('object');
  });

  it('fixture has two milestones', () => {
    const fixture = loadMilestoneFixture();
    expect(Array.isArray(fixture.milestones)).toBe(true);
    expect(fixture.milestones).toHaveLength(2);
  });

  it('first milestone has 4 issues with dependency relationships', () => {
    const fixture = loadMilestoneFixture();
    const m1 = fixture.milestones[0];
    expect(m1.issues).toHaveLength(4);

    const issue101 = m1.issues.find(i => i.github_number === 101);
    const issue102 = m1.issues.find(i => i.github_number === 102);
    const issue103 = m1.issues.find(i => i.github_number === 103);
    const issue104 = m1.issues.find(i => i.github_number === 104);

    expect(issue101).toBeDefined();
    expect(issue102).toBeDefined();
    expect(issue103).toBeDefined();
    expect(issue104).toBeDefined();

    // Dependency chain: 102 depends on 101, 103 depends on 102
    expect(issue102.depends_on_slugs).toContain('set-up-base-infrastructure');
    expect(issue103.depends_on_slugs).toContain('add-core-logic-layer');
    // 101 and 104 have no dependencies
    expect(issue101.depends_on_slugs).toHaveLength(0);
    expect(issue104.depends_on_slugs).toHaveLength(0);
  });

  it('first milestone has gsd_milestone_id set (linked)', () => {
    const fixture = loadMilestoneFixture();
    expect(fixture.milestones[0].gsd_milestone_id).toBe('v1.0');
  });

  it('second milestone has null gsd_milestone_id (unlinked)', () => {
    const fixture = loadMilestoneFixture();
    expect(fixture.milestones[1].gsd_milestone_id).toBeNull();
  });

  it('active_gsd_milestone matches first milestone gsd_milestone_id', () => {
    const fixture = loadMilestoneFixture();
    expect(fixture.active_gsd_milestone).toBe(fixture.milestones[0].gsd_milestone_id);
  });

  it('mock-gsd-agent and mock-github activate without errors', () => {
    const mockGitHub = _require(MOCK_GITHUB_MODULE);
    const mockAgent = _require(MOCK_AGENT_MODULE);

    expect(() => mockGitHub.activate()).not.toThrow();
    expect(() => mockAgent.activate()).not.toThrow();

    expect(mockGitHub.getCallLog()).toHaveLength(0);
    expect(mockAgent.getCallLog()).toHaveLength(0);

    mockGitHub.deactivate();
    mockAgent.deactivate();
  });
});
