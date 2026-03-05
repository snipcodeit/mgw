'use strict';

/**
 * test/github.test.cjs — Unit tests for lib/github.cjs
 *
 * Strategy: module cache invalidation + mock.method on childProcess.execSync.
 *
 * Before each test:
 *   1. Evict lib/github.cjs (and dependencies) from require.cache
 *   2. mock.method(childProcess, 'execSync', () => fixture)
 *   3. Re-require lib/github.cjs so it captures the mock at bind time
 *
 * This avoids real gh CLI calls entirely.
 *
 * All public functions in github.cjs are async (return Promises).
 * Critical-path functions use runWithRetry (withRetry from retry.cjs).
 * Non-blocking functions use run() directly but are declared async.
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const path = require('path');

const GITHUB_MODULE = path.resolve(__dirname, '..', 'lib', 'github.cjs');
const ERRORS_MODULE = path.resolve(__dirname, '..', 'lib', 'errors.cjs');
const RETRY_MODULE = path.resolve(__dirname, '..', 'lib', 'retry.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Evict github.cjs and its dependencies (errors.cjs, retry.cjs) from the
 * require cache so re-require picks up fresh mocks.
 */
function evictModules() {
  delete require.cache[GITHUB_MODULE];
  delete require.cache[ERRORS_MODULE];
  delete require.cache[RETRY_MODULE];
}

/**
 * Reload lib/github.cjs with execSync replaced by a fake that returns
 * `returnValue` (as a Buffer / string — the real execSync returns a string
 * when encoding is specified, and run() calls .trim() on the result).
 *
 * @param {string} returnValue - Raw string the fake execSync should return
 * @returns {{ github: object, spy: import('node:test').MockFunctionContext }}
 */
function loadWithMock(returnValue) {
  // 1. Evict cached modules so the re-require picks up the fresh mock
  evictModules();

  // 2. Install mock — mock.method replaces the property on the live object
  const spy = mock.method(childProcess, 'execSync', (_cmd, _opts) => returnValue);

  // 3. Re-require — github.cjs does `const { execSync } = require('child_process')`
  //    at module scope, so evicting + re-requiring is the only reliable way to
  //    make it bind to the mocked function.
  const github = require(GITHUB_MODULE);

  return { github, spy };
}

/**
 * Reload lib/github.cjs with execSync replaced by a fake that throws `error`.
 */
function loadWithThrow(error) {
  evictModules();
  mock.method(childProcess, 'execSync', () => { throw error; });
  return require(GITHUB_MODULE);
}

/**
 * Restore mocks after each test so they don't bleed across describe blocks.
 */
function restoreMocks() {
  mock.restoreAll();
  evictModules();
}

// ---------------------------------------------------------------------------
// Fixtures — pre-baked JSON strings matching gh CLI output shapes
// ---------------------------------------------------------------------------

const FX = {
  repo: 'snipcodeit/mgw',

  issue: JSON.stringify({
    number: 42,
    title: 'Fix everything',
    state: 'OPEN',
    labels: [{ name: 'bug' }],
    milestone: { title: 'v1.0', number: 1 },
    assignees: [{ login: 'hat' }],
    body: 'Body text'
  }),

  issueList: JSON.stringify([
    { number: 1, title: 'First', state: 'OPEN', labels: [], milestone: null, assignees: [] },
    { number: 2, title: 'Second', state: 'OPEN', labels: [], milestone: null, assignees: [] }
  ]),

  milestone: JSON.stringify({
    number: 3,
    title: 'v1.0',
    state: 'open',
    open_issues: 2,
    closed_issues: 5
  }),

  rateLimit: JSON.stringify({
    resources: {
      core: { remaining: 4999, limit: 5000, reset: 1700000000 }
    }
  }),

  closedMilestone: JSON.stringify({
    number: 3,
    title: 'v1.0',
    state: 'closed',
    open_issues: 0,
    closed_issues: 7
  }),

  releaseOutput: 'https://github.com/snipcodeit/mgw/releases/tag/v1.0.0',

  project: JSON.stringify({ number: 7, url: 'https://github.com/orgs/snipcodeit/projects/7' }),

  addItemOutput: 'PVT_kwDOABC123',

  repoMeta: JSON.stringify({
    id: 'R_kgDOABC',
    discussionCategories: {
      nodes: [
        { id: 'DIC_kwDOABC', name: 'Announcements' },
        { id: 'DIC_kwDOXYZ', name: 'General' }
      ]
    }
  }),

  discussionResult: JSON.stringify({
    url: 'https://github.com/snipcodeit/mgw/discussions/99'
  })
};

// ---------------------------------------------------------------------------
// getRepo
// ---------------------------------------------------------------------------

describe('getRepo', () => {
  beforeEach(restoreMocks);

  it('returns the repo nameWithOwner string', async () => {
    const { github, spy } = loadWithMock(FX.repo);
    const result = await github.getRepo();

    assert.equal(result, 'snipcodeit/mgw');
    assert.equal(spy.mock.calls.length, 1);
    assert.ok(
      spy.mock.calls[0].arguments[0].includes('gh repo view'),
      'should call gh repo view'
    );
    assert.ok(
      spy.mock.calls[0].arguments[0].includes('nameWithOwner'),
      'should request nameWithOwner field'
    );
  });

  it('propagates execSync errors', async () => {
    const github = loadWithThrow(new Error('gh: not found'));
    await assert.rejects(github.getRepo(), /gh: not found/);
  });
});

// ---------------------------------------------------------------------------
// getIssue
// ---------------------------------------------------------------------------

describe('getIssue', () => {
  beforeEach(restoreMocks);

  it('returns parsed issue object', async () => {
    const { github } = loadWithMock(FX.issue);
    const result = await github.getIssue(42);

    assert.equal(result.number, 42);
    assert.equal(result.title, 'Fix everything');
    assert.equal(result.state, 'OPEN');
    assert.deepEqual(result.labels, [{ name: 'bug' }]);
  });

  it('constructs correct gh issue view command', async () => {
    const { github, spy } = loadWithMock(FX.issue);
    await github.getIssue(42);

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh issue view 42'), 'should include issue number');
    assert.ok(cmd.includes('number,title,state,labels,milestone,assignees,body'), 'should request all fields');
  });

  it('works with string issue number', async () => {
    const { github } = loadWithMock(FX.issue);
    const result = await github.getIssue('42');
    assert.equal(result.number, 42);
  });

  it('propagates execSync errors', async () => {
    const github = loadWithThrow(new Error('issue not found'));
    await assert.rejects(github.getIssue(99), /issue not found/);
  });
});

// ---------------------------------------------------------------------------
// listIssues
// ---------------------------------------------------------------------------

describe('listIssues', () => {
  beforeEach(restoreMocks);

  it('returns parsed array of issues with no filters', async () => {
    const { github } = loadWithMock(FX.issueList);
    const result = await github.listIssues();

    assert.ok(Array.isArray(result), 'should return array');
    assert.equal(result.length, 2);
    assert.equal(result[0].number, 1);
    assert.equal(result[1].title, 'Second');
  });

  it('builds base command correctly', async () => {
    const { github, spy } = loadWithMock(FX.issueList);
    await github.listIssues();

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh issue list'), 'should start with gh issue list');
    assert.ok(cmd.includes('--json number,title,state,labels,milestone,assignees'), 'should request correct fields');
  });

  it('appends --label flag when filter.label is set', async () => {
    const { github, spy } = loadWithMock(FX.issueList);
    await github.listIssues({ label: 'bug' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--label'), 'should include --label flag');
    assert.ok(cmd.includes('bug'), 'should include label value');
  });

  it('appends --milestone flag when filter.milestone is set', async () => {
    const { github, spy } = loadWithMock(FX.issueList);
    await github.listIssues({ milestone: 'v1.0' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--milestone'), 'should include --milestone flag');
  });

  it('appends --assignee flag when filter.assignee is set and not "all"', async () => {
    const { github, spy } = loadWithMock(FX.issueList);
    await github.listIssues({ assignee: 'hat' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--assignee'), 'should include --assignee flag');
  });

  it('omits --assignee when filter.assignee is "all"', async () => {
    const { github, spy } = loadWithMock(FX.issueList);
    await github.listIssues({ assignee: 'all' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(!cmd.includes('--assignee'), 'should NOT include --assignee for "all"');
  });

  it('appends --state flag when filter.state is set', async () => {
    const { github, spy } = loadWithMock(FX.issueList);
    await github.listIssues({ state: 'closed' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--state closed'), 'should include --state flag');
  });

  it('propagates execSync errors', async () => {
    const github = loadWithThrow(new Error('authentication failed'));
    await assert.rejects(github.listIssues(), /authentication failed/);
  });
});

// ---------------------------------------------------------------------------
// getMilestone
// ---------------------------------------------------------------------------

describe('getMilestone', () => {
  beforeEach(restoreMocks);

  it('returns parsed milestone object', async () => {
    // getMilestone calls getRepo() first, then fetches the milestone.
    // We return FX.repo for the first call, FX.milestone for the second.
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      return callCount === 1 ? FX.repo : FX.milestone;
    });
    const github = require(GITHUB_MODULE);

    const result = await github.getMilestone(3);
    assert.equal(result.number, 3);
    assert.equal(result.title, 'v1.0');
    assert.equal(result.state, 'open');
  });

  it('constructs correct gh api repos/{repo}/milestones/{number} command', async () => {
    let callCount = 0;
    const calls = [];
    evictModules();
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      calls.push(cmd);
      return callCount === 1 ? FX.repo : FX.milestone;
    });
    const github = require(GITHUB_MODULE);

    await github.getMilestone(3);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('gh repo view'), 'first call should be getRepo');
    assert.ok(calls[1].includes('gh api repos/snipcodeit/mgw/milestones/3'), 'second call should be getMilestone');
  });

  it('propagates execSync errors', async () => {
    const github = loadWithThrow(new Error('milestone not found'));
    await assert.rejects(github.getMilestone(99), /milestone not found/);
  });
});

// ---------------------------------------------------------------------------
// getRateLimit
// ---------------------------------------------------------------------------

describe('getRateLimit', () => {
  beforeEach(restoreMocks);

  it('returns core rate limit fields', async () => {
    const { github } = loadWithMock(FX.rateLimit);
    const result = await github.getRateLimit();

    assert.equal(result.remaining, 4999);
    assert.equal(result.limit, 5000);
    assert.equal(result.reset, 1700000000);
  });

  it('constructs correct gh api rate_limit command', async () => {
    const { github, spy } = loadWithMock(FX.rateLimit);
    await github.getRateLimit();

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh api rate_limit'), 'should call gh api rate_limit');
  });

  it('does not include extra fields beyond remaining/limit/reset', async () => {
    const { github } = loadWithMock(FX.rateLimit);
    const result = await github.getRateLimit();

    const keys = Object.keys(result);
    assert.deepEqual(keys.sort(), ['limit', 'remaining', 'reset']);
  });

  it('propagates execSync errors', async () => {
    const github = loadWithThrow(new Error('network error'));
    await assert.rejects(github.getRateLimit(), /network error/);
  });
});

// ---------------------------------------------------------------------------
// closeMilestone
// ---------------------------------------------------------------------------

describe('closeMilestone', () => {
  beforeEach(restoreMocks);

  it('returns parsed updated milestone JSON', async () => {
    const { github } = loadWithMock(FX.closedMilestone);
    const result = await github.closeMilestone('snipcodeit/mgw', 3);

    assert.equal(result.state, 'closed');
    assert.equal(result.number, 3);
  });

  it('constructs correct PATCH command', async () => {
    const { github, spy } = loadWithMock(FX.closedMilestone);
    await github.closeMilestone('snipcodeit/mgw', 3);

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh api repos/snipcodeit/mgw/milestones/3'), 'should target correct milestone');
    assert.ok(cmd.includes('--method PATCH'), 'should use PATCH method');
    assert.ok(cmd.includes('-f state=closed'), 'should send state=closed');
  });

  it('propagates execSync errors', async () => {
    const github = loadWithThrow(new Error('forbidden'));
    await assert.rejects(github.closeMilestone('snipcodeit/mgw', 3), /forbidden/);
  });
});

// ---------------------------------------------------------------------------
// createRelease
// ---------------------------------------------------------------------------

describe('createRelease', () => {
  beforeEach(restoreMocks);

  it('returns raw output string from gh release create', async () => {
    const { github } = loadWithMock(FX.releaseOutput);
    const result = await github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0');

    assert.equal(result, FX.releaseOutput);
  });

  it('constructs base command with tag, repo, and title', async () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    await github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0');

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh release create'), 'should call gh release create');
    assert.ok(cmd.includes('v1.0.0'), 'should include tag');
    assert.ok(cmd.includes('snipcodeit/mgw'), 'should include repo');
    assert.ok(cmd.includes('Release v1.0.0'), 'should include title');
  });

  it('appends --notes when opts.notes is provided', async () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    await github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0', { notes: 'Bug fixes' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--notes'), 'should include --notes flag');
    assert.ok(cmd.includes('Bug fixes'), 'should include notes content');
  });

  it('appends --draft when opts.draft is true', async () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    await github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0', { draft: true });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--draft'), 'should include --draft flag');
  });

  it('appends --prerelease when opts.prerelease is true', async () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    await github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0', { prerelease: true });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--prerelease'), 'should include --prerelease flag');
  });

  it('does not append --draft or --prerelease when opts are false', async () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    await github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0', { draft: false, prerelease: false });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(!cmd.includes('--draft'), 'should NOT include --draft when false');
    assert.ok(!cmd.includes('--prerelease'), 'should NOT include --prerelease when false');
  });

  it('propagates execSync errors', async () => {
    const github = loadWithThrow(new Error('tag already exists'));
    await assert.rejects(github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Dup'), /tag already exists/);
  });
});

// ---------------------------------------------------------------------------
// createProject
// ---------------------------------------------------------------------------

describe('createProject', () => {
  beforeEach(restoreMocks);

  it('returns { number, url } from parsed JSON', async () => {
    const { github } = loadWithMock(FX.project);
    const result = await github.createProject('snipcodeit', 'My Board');

    assert.equal(result.number, 7);
    assert.equal(result.url, 'https://github.com/orgs/snipcodeit/projects/7');
  });

  it('constructs correct gh project create command', async () => {
    const { github, spy } = loadWithMock(FX.project);
    await github.createProject('snipcodeit', 'My Board');

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh project create'), 'should call gh project create');
    assert.ok(cmd.includes('snipcodeit'), 'should include owner');
    assert.ok(cmd.includes('My Board'), 'should include title');
    assert.ok(cmd.includes('--format json'), 'should request json format');
  });

  it('propagates execSync errors', async () => {
    const github = loadWithThrow(new Error('org not found'));
    await assert.rejects(github.createProject('bad-org', 'Board'), /org not found/);
  });
});

// ---------------------------------------------------------------------------
// getProjectNodeId
// ---------------------------------------------------------------------------

describe('getProjectNodeId', () => {
  beforeEach(restoreMocks);

  it('returns node ID when user projectV2 query succeeds', async () => {
    const { github, spy } = loadWithMock('PVT_kwDOABC123');
    const result = await github.getProjectNodeId('snipcodeit', 7);

    assert.equal(result, 'PVT_kwDOABC123');
    assert.equal(spy.mock.calls.length, 1);
    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('user(login:'), 'should query user projectV2');
    assert.ok(cmd.includes('snipcodeit'), 'should include owner');
    assert.ok(cmd.includes('7'), 'should include project number');
  });

  it('falls back to org query when user query returns "null"', async () => {
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      return callCount === 1 ? 'null' : 'PVT_orgNodeId';
    });
    const github = require(GITHUB_MODULE);

    const result = await github.getProjectNodeId('snipcodeit', 7);
    assert.equal(result, 'PVT_orgNodeId');
    assert.equal(callCount, 2);
  });

  it('falls back to org query when user query throws', async () => {
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) throw new Error('user not found');
      return 'PVT_orgNodeId';
    });
    const github = require(GITHUB_MODULE);

    const result = await github.getProjectNodeId('myorg', 3);
    assert.equal(result, 'PVT_orgNodeId');
  });

  it('returns null when both user and org queries fail', async () => {
    evictModules();
    mock.method(childProcess, 'execSync', () => { throw new Error('not found'); });
    const github = require(GITHUB_MODULE);

    const result = await github.getProjectNodeId('snipcodeit', 999);
    assert.equal(result, null);
  });

  it('returns null when both queries return "null" string', async () => {
    const { github } = loadWithMock('null');
    const result = await github.getProjectNodeId('snipcodeit', 7);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// findExistingBoard
// ---------------------------------------------------------------------------

describe('findExistingBoard', () => {
  beforeEach(restoreMocks);

  const FX_USER_BOARDS = JSON.stringify([
    { id: 'PVT_user1', number: 5, url: 'https://github.com/users/snipcodeit/projects/5', title: 'MGW Roadmap' },
    { id: 'PVT_user2', number: 6, url: 'https://github.com/users/snipcodeit/projects/6', title: 'Other Project' }
  ]);

  const FX_ORG_BOARDS = JSON.stringify([
    { id: 'PVT_org1', number: 2, url: 'https://github.com/orgs/snipcodeit/projects/2', title: 'MGW Pipeline Board' }
  ]);

  it('returns board when user projectsV2 contains a title match', async () => {
    const { github } = loadWithMock(FX_USER_BOARDS);
    const result = await github.findExistingBoard('snipcodeit', 'MGW');

    assert.ok(result !== null, 'should find a board');
    assert.equal(result.number, 5);
    assert.equal(result.nodeId, 'PVT_user1');
    assert.equal(result.title, 'MGW Roadmap');
  });

  it('performs case-insensitive title matching', async () => {
    const { github } = loadWithMock(FX_USER_BOARDS);
    const result = await github.findExistingBoard('snipcodeit', 'mgw roadmap');

    assert.ok(result !== null);
    assert.equal(result.number, 5);
  });

  it('falls back to org projects when user query finds no match', async () => {
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      // First call: user boards — no matching title
      if (callCount === 1) return JSON.stringify([
        { id: 'PVT_other', number: 1, url: 'https://github.com/users/snipcodeit/projects/1', title: 'Unrelated Board' }
      ]);
      // Second call: org boards — has match
      return FX_ORG_BOARDS;
    });
    const github = require(GITHUB_MODULE);

    const result = await github.findExistingBoard('snipcodeit', 'MGW');
    assert.ok(result !== null);
    assert.equal(result.number, 2);
    assert.equal(result.nodeId, 'PVT_org1');
  });

  it('falls back to org projects when user query throws', async () => {
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) throw new Error('user not found');
      return FX_ORG_BOARDS;
    });
    const github = require(GITHUB_MODULE);

    const result = await github.findExistingBoard('snipcodeit', 'MGW');
    assert.ok(result !== null);
    assert.equal(result.number, 2);
  });

  it('returns null when no match in either user or org projects', async () => {
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      return JSON.stringify([
        { id: 'PVT_x', number: 9, url: 'https://github.com/users/snipcodeit/projects/9', title: 'Unrelated' }
      ]);
    });
    const github = require(GITHUB_MODULE);

    const result = await github.findExistingBoard('snipcodeit', 'MGW');
    assert.equal(result, null);
  });

  it('returns null when both queries throw', async () => {
    evictModules();
    mock.method(childProcess, 'execSync', () => { throw new Error('API error'); });
    const github = require(GITHUB_MODULE);

    const result = await github.findExistingBoard('snipcodeit', 'anything');
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// getProjectFields
// ---------------------------------------------------------------------------

describe('getProjectFields', () => {
  beforeEach(restoreMocks);

  const statusOptions = [
    { id: 'opt_new', name: 'New' },
    { id: 'opt_triaged', name: 'Triaged' },
    { id: 'opt_planning', name: 'Planning' },
    { id: 'opt_executing', name: 'Executing' },
    { id: 'opt_done', name: 'Done' },
    { id: 'opt_failed', name: 'Failed' },
    { id: 'opt_blocked', name: 'Blocked' },
    { id: 'opt_verifying', name: 'Verifying' },
    { id: 'opt_prcreated', name: 'PR Created' },
    { id: 'opt_approved', name: 'Approved' },
    { id: 'opt_discussing', name: 'Discussing' },
    { id: 'opt_needsinfo', name: 'Needs Info' },
    { id: 'opt_security', name: 'Needs Security Review' }
  ];

  const gsdRouteOptions = [
    { id: 'gsd_quick', name: 'quick' },
    { id: 'gsd_quickfull', name: 'quick --full' },
    { id: 'gsd_plan', name: 'plan-phase' },
    { id: 'gsd_milestone', name: 'new-milestone' }
  ];

  const FX_FIELDS_NODES = JSON.stringify([
    { id: 'PVTSSF_status', name: 'Status', options: statusOptions },
    { id: 'PVTF_ai', name: 'AI Agent State' },
    { id: 'PVTF_ms', name: 'Milestone' },
    { id: 'PVTF_phase', name: 'Phase' },
    { id: 'PVTSSF_route', name: 'GSD Route', options: gsdRouteOptions }
  ]);

  it('returns parsed fields object with all 5 field types', async () => {
    const { github } = loadWithMock(FX_FIELDS_NODES);
    const result = await github.getProjectFields('snipcodeit', 7);

    assert.ok(result !== null, 'should return fields');
    assert.ok('status' in result, 'should have status field');
    assert.ok('ai_agent_state' in result, 'should have ai_agent_state field');
    assert.ok('milestone' in result, 'should have milestone field');
    assert.ok('phase' in result, 'should have phase field');
    assert.ok('gsd_route' in result, 'should have gsd_route field');
  });

  it('maps status field options to pipeline_stage keys', async () => {
    const { github } = loadWithMock(FX_FIELDS_NODES);
    const result = await github.getProjectFields('snipcodeit', 7);

    assert.equal(result.status.field_id, 'PVTSSF_status');
    assert.equal(result.status.type, 'SINGLE_SELECT');
    assert.equal(result.status.options.new, 'opt_new');
    assert.equal(result.status.options.triaged, 'opt_triaged');
    assert.equal(result.status.options.planning, 'opt_planning');
    assert.equal(result.status.options.executing, 'opt_executing');
    assert.equal(result.status.options.done, 'opt_done');
    assert.equal(result.status.options['pr-created'], 'opt_prcreated');
    assert.equal(result.status.options['needs-info'], 'opt_needsinfo');
    assert.equal(result.status.options['needs-security-review'], 'opt_security');
  });

  it('maps gsd_route field options to route keys with gsd: prefix', async () => {
    const { github } = loadWithMock(FX_FIELDS_NODES);
    const result = await github.getProjectFields('snipcodeit', 7);

    assert.equal(result.gsd_route.field_id, 'PVTSSF_route');
    assert.equal(result.gsd_route.type, 'SINGLE_SELECT');
    assert.equal(result.gsd_route.options['gsd:quick'], 'gsd_quick');
    assert.equal(result.gsd_route.options['gsd:plan-phase'], 'gsd_plan');
    assert.equal(result.gsd_route.options['gsd:new-milestone'], 'gsd_milestone');
  });

  it('returns TEXT type for ai_agent_state, milestone, and phase fields', async () => {
    const { github } = loadWithMock(FX_FIELDS_NODES);
    const result = await github.getProjectFields('snipcodeit', 7);

    assert.equal(result.ai_agent_state.field_id, 'PVTF_ai');
    assert.equal(result.ai_agent_state.type, 'TEXT');
    assert.equal(result.milestone.field_id, 'PVTF_ms');
    assert.equal(result.milestone.type, 'TEXT');
    assert.equal(result.phase.field_id, 'PVTF_phase');
    assert.equal(result.phase.type, 'TEXT');
  });

  it('falls back to org query when user query throws', async () => {
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) throw new Error('user not found');
      return FX_FIELDS_NODES;
    });
    const github = require(GITHUB_MODULE);

    const result = await github.getProjectFields('snipcodeit', 7);
    assert.ok(result !== null);
    assert.ok('status' in result);
  });

  it('returns null when both queries fail', async () => {
    evictModules();
    mock.method(childProcess, 'execSync', () => { throw new Error('API error'); });
    const github = require(GITHUB_MODULE);

    const result = await github.getProjectFields('snipcodeit', 7);
    assert.equal(result, null);
  });

  it('returns null when nodes array has no recognized fields', async () => {
    const { github } = loadWithMock(JSON.stringify([
      { id: 'PVTF_unknown', name: 'UnknownField' }
    ]));
    const result = await github.getProjectFields('snipcodeit', 7);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// addItemToProject
// ---------------------------------------------------------------------------

describe('addItemToProject', () => {
  beforeEach(restoreMocks);

  it('returns the raw item ID string', async () => {
    const { github } = loadWithMock(FX.addItemOutput);
    const result = await github.addItemToProject('snipcodeit', 7, 'https://github.com/snipcodeit/mgw/issues/1');

    assert.equal(result, FX.addItemOutput);
  });

  it('constructs correct gh project item-add command', async () => {
    const { github, spy } = loadWithMock(FX.addItemOutput);
    await github.addItemToProject('snipcodeit', 7, 'https://github.com/snipcodeit/mgw/issues/1');

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh project item-add 7'), 'should include project number');
    assert.ok(cmd.includes('snipcodeit'), 'should include owner');
    assert.ok(cmd.includes('https://github.com/snipcodeit/mgw/issues/1'), 'should include issue URL');
  });

  it('propagates execSync errors', async () => {
    const github = loadWithThrow(new Error('project not found'));
    await assert.rejects(github.addItemToProject('snipcodeit', 99, 'https://github.com/snipcodeit/mgw/issues/1'), /project not found/);
  });
});

// ---------------------------------------------------------------------------
// postMilestoneStartAnnouncement
// ---------------------------------------------------------------------------

describe('postMilestoneStartAnnouncement', () => {
  beforeEach(restoreMocks);

  const baseOpts = {
    repo: 'snipcodeit/mgw',
    milestoneName: 'v3.5',
    milestoneNumber: 5,
    boardUrl: 'https://github.com/orgs/snipcodeit/projects/7',
    issues: [
      { number: 134, title: 'Write tests', assignee: 'hat', gsdRoute: 'execute' }
    ],
    firstIssueNumber: 134
  };

  it('returns { posted: true, method: "discussion", url } when Discussions succeed', async () => {
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      // First call: repoMeta GraphQL query
      if (callCount === 1) return FX.repoMeta;
      // Second call: createDiscussion mutation
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    const result = await github.postMilestoneStartAnnouncement(baseOpts);
    assert.equal(result.posted, true);
    assert.equal(result.method, 'discussion');
    assert.equal(result.url, 'https://github.com/snipcodeit/mgw/discussions/99');
  });

  it('falls back to issue comment when Discussions are not available', async () => {
    // Return repoMeta WITHOUT an Announcements category
    const repoMetaNoAnnouncements = JSON.stringify({
      id: 'R_kgDOABC',
      discussionCategories: { nodes: [{ id: 'DIC_kwDOXYZ', name: 'General' }] }
    });

    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return repoMetaNoAnnouncements;
      // Second call is the fallback comment
      return '';
    });
    const github = require(GITHUB_MODULE);

    const result = await github.postMilestoneStartAnnouncement(baseOpts);
    assert.equal(result.posted, true);
    assert.equal(result.method, 'comment');
    assert.equal(result.url, null);
  });

  it('falls back to issue comment when GraphQL throws', async () => {
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) throw new Error('Discussions not enabled');
      // Second call is the fallback comment
      return '';
    });
    const github = require(GITHUB_MODULE);

    const result = await github.postMilestoneStartAnnouncement(baseOpts);
    assert.equal(result.posted, true);
    assert.equal(result.method, 'comment');
  });

  it('returns { posted: false, method: "none" } when both paths fail', async () => {
    evictModules();
    mock.method(childProcess, 'execSync', () => { throw new Error('all failed'); });
    const github = require(GITHUB_MODULE);

    const result = await github.postMilestoneStartAnnouncement(baseOpts);
    assert.equal(result.posted, false);
    assert.equal(result.method, 'none');
    assert.equal(result.url, null);
  });

  it('returns { posted: false } when no repo or firstIssueNumber is provided', async () => {
    // No repo → skip GraphQL; no firstIssueNumber → skip comment fallback
    const { github } = loadWithMock('');
    const result = await github.postMilestoneStartAnnouncement({
      milestoneName: 'v3.5',
      issues: []
    });

    assert.equal(result.posted, false);
    assert.equal(result.method, 'none');
  });

  it('includes boardUrl line in constructed body when boardUrl is provided', async () => {
    let capturedBody = '';
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      if (callCount === 1) return FX.repoMeta;
      // Capture the createDiscussion call to inspect the body
      capturedBody = cmd;
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    await github.postMilestoneStartAnnouncement(baseOpts);
    // The second execSync call contains the mutation with the board URL embedded
    assert.ok(capturedBody.includes('https://github.com/orgs/snipcodeit/projects/7'), 'body should include board URL');
  });

  it('uses "_(not configured)_" when boardUrl is not provided', async () => {
    let capturedBody = '';
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      if (callCount === 1) return FX.repoMeta;
      capturedBody = cmd;
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    await github.postMilestoneStartAnnouncement({ ...baseOpts, boardUrl: undefined });
    assert.ok(capturedBody.includes('not configured'), 'body should include "not configured" when no board URL');
  });

  it('includes issue table rows in constructed body', async () => {
    let capturedBody = '';
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      if (callCount === 1) return FX.repoMeta;
      capturedBody = cmd;
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    await github.postMilestoneStartAnnouncement(baseOpts);
    assert.ok(capturedBody.includes('#134'), 'body should include issue number');
    assert.ok(capturedBody.includes('Write tests'), 'body should include issue title');
    assert.ok(capturedBody.includes('@hat'), 'body should include assignee');
  });

  it('renders "\u2014" for unassigned issues in body', async () => {
    let capturedBody = '';
    let callCount = 0;
    evictModules();
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      if (callCount === 1) return FX.repoMeta;
      capturedBody = cmd;
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    await github.postMilestoneStartAnnouncement({
      ...baseOpts,
      issues: [{ number: 1, title: 'Unassigned issue', assignee: null, gsdRoute: 'execute' }]
    });
    // The em dash "\u2014" appears as the assignee placeholder
    assert.ok(capturedBody.includes('\\u2014') || capturedBody.includes('\u2014'), 'body should include em dash for unassigned');
  });
});
