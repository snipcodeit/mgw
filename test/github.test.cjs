'use strict';

/**
 * test/github.test.cjs — Unit tests for lib/github.cjs
 *
 * Strategy: module cache invalidation + mock.method on childProcess.execSync.
 *
 * Before each test:
 *   1. Evict lib/github.cjs from require.cache
 *   2. mock.method(childProcess, 'execSync', () => fixture)
 *   3. Re-require lib/github.cjs so it captures the mock at bind time
 *
 * This avoids real gh CLI calls entirely.
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const path = require('path');

const GITHUB_MODULE = path.resolve(__dirname, '..', 'lib', 'github.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reload lib/github.cjs with execSync replaced by a fake that returns
 * `returnValue` (as a Buffer / string — the real execSync returns a string
 * when encoding is specified, and run() calls .trim() on the result).
 *
 * @param {string} returnValue - Raw string the fake execSync should return
 * @returns {{ github: object, spy: import('node:test').MockFunctionContext }}
 */
function loadWithMock(returnValue) {
  // 1. Evict cached module so the re-require picks up the fresh mock
  delete require.cache[GITHUB_MODULE];

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
  delete require.cache[GITHUB_MODULE];
  mock.method(childProcess, 'execSync', () => { throw error; });
  return require(GITHUB_MODULE);
}

/**
 * Restore mocks after each test so they don't bleed across describe blocks.
 */
function restoreMocks() {
  mock.restoreAll();
  delete require.cache[GITHUB_MODULE];
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

  it('returns the repo nameWithOwner string', () => {
    const { github, spy } = loadWithMock(FX.repo);
    const result = github.getRepo();

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

  it('propagates execSync errors', () => {
    const github = loadWithThrow(new Error('gh: not found'));
    assert.throws(() => github.getRepo(), /gh: not found/);
  });
});

// ---------------------------------------------------------------------------
// getIssue
// ---------------------------------------------------------------------------

describe('getIssue', () => {
  beforeEach(restoreMocks);

  it('returns parsed issue object', () => {
    const { github, spy } = loadWithMock(FX.issue);
    const result = github.getIssue(42);

    assert.equal(result.number, 42);
    assert.equal(result.title, 'Fix everything');
    assert.equal(result.state, 'OPEN');
    assert.deepEqual(result.labels, [{ name: 'bug' }]);
  });

  it('constructs correct gh issue view command', () => {
    const { github, spy } = loadWithMock(FX.issue);
    github.getIssue(42);

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh issue view 42'), 'should include issue number');
    assert.ok(cmd.includes('number,title,state,labels,milestone,assignees,body'), 'should request all fields');
  });

  it('works with string issue number', () => {
    const { github } = loadWithMock(FX.issue);
    const result = github.getIssue('42');
    assert.equal(result.number, 42);
  });

  it('propagates execSync errors', () => {
    const github = loadWithThrow(new Error('issue not found'));
    assert.throws(() => github.getIssue(99), /issue not found/);
  });
});

// ---------------------------------------------------------------------------
// listIssues
// ---------------------------------------------------------------------------

describe('listIssues', () => {
  beforeEach(restoreMocks);

  it('returns parsed array of issues with no filters', () => {
    const { github, spy } = loadWithMock(FX.issueList);
    const result = github.listIssues();

    assert.ok(Array.isArray(result), 'should return array');
    assert.equal(result.length, 2);
    assert.equal(result[0].number, 1);
    assert.equal(result[1].title, 'Second');
  });

  it('builds base command correctly', () => {
    const { github, spy } = loadWithMock(FX.issueList);
    github.listIssues();

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh issue list'), 'should start with gh issue list');
    assert.ok(cmd.includes('--json number,title,state,labels,milestone,assignees'), 'should request correct fields');
  });

  it('appends --label flag when filter.label is set', () => {
    const { github, spy } = loadWithMock(FX.issueList);
    github.listIssues({ label: 'bug' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--label'), 'should include --label flag');
    assert.ok(cmd.includes('bug'), 'should include label value');
  });

  it('appends --milestone flag when filter.milestone is set', () => {
    const { github, spy } = loadWithMock(FX.issueList);
    github.listIssues({ milestone: 'v1.0' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--milestone'), 'should include --milestone flag');
  });

  it('appends --assignee flag when filter.assignee is set and not "all"', () => {
    const { github, spy } = loadWithMock(FX.issueList);
    github.listIssues({ assignee: 'hat' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--assignee'), 'should include --assignee flag');
  });

  it('omits --assignee when filter.assignee is "all"', () => {
    const { github, spy } = loadWithMock(FX.issueList);
    github.listIssues({ assignee: 'all' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(!cmd.includes('--assignee'), 'should NOT include --assignee for "all"');
  });

  it('appends --state flag when filter.state is set', () => {
    const { github, spy } = loadWithMock(FX.issueList);
    github.listIssues({ state: 'closed' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--state closed'), 'should include --state flag');
  });

  it('propagates execSync errors', () => {
    const github = loadWithThrow(new Error('rate limit exceeded'));
    assert.throws(() => github.listIssues(), /rate limit exceeded/);
  });
});

// ---------------------------------------------------------------------------
// getMilestone
// ---------------------------------------------------------------------------

describe('getMilestone', () => {
  beforeEach(restoreMocks);

  it('returns parsed milestone object', () => {
    // getMilestone calls getRepo() first, then fetches the milestone.
    // We return FX.repo for the first call, FX.milestone for the second.
    let callCount = 0;
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      return callCount === 1 ? FX.repo : FX.milestone;
    });
    const github = require(GITHUB_MODULE);

    const result = github.getMilestone(3);
    assert.equal(result.number, 3);
    assert.equal(result.title, 'v1.0');
    assert.equal(result.state, 'open');
  });

  it('constructs correct gh api repos/{repo}/milestones/{number} command', () => {
    let callCount = 0;
    const calls = [];
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      calls.push(cmd);
      return callCount === 1 ? FX.repo : FX.milestone;
    });
    const github = require(GITHUB_MODULE);

    github.getMilestone(3);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('gh repo view'), 'first call should be getRepo');
    assert.ok(calls[1].includes('gh api repos/snipcodeit/mgw/milestones/3'), 'second call should be getMilestone');
  });

  it('propagates execSync errors', () => {
    const github = loadWithThrow(new Error('milestone not found'));
    assert.throws(() => github.getMilestone(99), /milestone not found/);
  });
});

// ---------------------------------------------------------------------------
// getRateLimit
// ---------------------------------------------------------------------------

describe('getRateLimit', () => {
  beforeEach(restoreMocks);

  it('returns core rate limit fields', () => {
    const { github } = loadWithMock(FX.rateLimit);
    const result = github.getRateLimit();

    assert.equal(result.remaining, 4999);
    assert.equal(result.limit, 5000);
    assert.equal(result.reset, 1700000000);
  });

  it('constructs correct gh api rate_limit command', () => {
    const { github, spy } = loadWithMock(FX.rateLimit);
    github.getRateLimit();

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh api rate_limit'), 'should call gh api rate_limit');
  });

  it('does not include extra fields beyond remaining/limit/reset', () => {
    const { github } = loadWithMock(FX.rateLimit);
    const result = github.getRateLimit();

    const keys = Object.keys(result);
    assert.deepEqual(keys.sort(), ['limit', 'remaining', 'reset']);
  });

  it('propagates execSync errors', () => {
    const github = loadWithThrow(new Error('network error'));
    assert.throws(() => github.getRateLimit(), /network error/);
  });
});

// ---------------------------------------------------------------------------
// closeMilestone
// ---------------------------------------------------------------------------

describe('closeMilestone', () => {
  beforeEach(restoreMocks);

  it('returns parsed updated milestone JSON', () => {
    const { github } = loadWithMock(FX.closedMilestone);
    const result = github.closeMilestone('snipcodeit/mgw', 3);

    assert.equal(result.state, 'closed');
    assert.equal(result.number, 3);
  });

  it('constructs correct PATCH command', () => {
    const { github, spy } = loadWithMock(FX.closedMilestone);
    github.closeMilestone('snipcodeit/mgw', 3);

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh api repos/snipcodeit/mgw/milestones/3'), 'should target correct milestone');
    assert.ok(cmd.includes('--method PATCH'), 'should use PATCH method');
    assert.ok(cmd.includes('-f state=closed'), 'should send state=closed');
  });

  it('propagates execSync errors', () => {
    const github = loadWithThrow(new Error('forbidden'));
    assert.throws(() => github.closeMilestone('snipcodeit/mgw', 3), /forbidden/);
  });
});

// ---------------------------------------------------------------------------
// createRelease
// ---------------------------------------------------------------------------

describe('createRelease', () => {
  beforeEach(restoreMocks);

  it('returns raw output string from gh release create', () => {
    const { github } = loadWithMock(FX.releaseOutput);
    const result = github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0');

    assert.equal(result, FX.releaseOutput);
  });

  it('constructs base command with tag, repo, and title', () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0');

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh release create'), 'should call gh release create');
    assert.ok(cmd.includes('v1.0.0'), 'should include tag');
    assert.ok(cmd.includes('snipcodeit/mgw'), 'should include repo');
    assert.ok(cmd.includes('Release v1.0.0'), 'should include title');
  });

  it('appends --notes when opts.notes is provided', () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0', { notes: 'Bug fixes' });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--notes'), 'should include --notes flag');
    assert.ok(cmd.includes('Bug fixes'), 'should include notes content');
  });

  it('appends --draft when opts.draft is true', () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0', { draft: true });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--draft'), 'should include --draft flag');
  });

  it('appends --prerelease when opts.prerelease is true', () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0', { prerelease: true });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('--prerelease'), 'should include --prerelease flag');
  });

  it('does not append --draft or --prerelease when opts are false', () => {
    const { github, spy } = loadWithMock(FX.releaseOutput);
    github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Release v1.0.0', { draft: false, prerelease: false });

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(!cmd.includes('--draft'), 'should NOT include --draft when false');
    assert.ok(!cmd.includes('--prerelease'), 'should NOT include --prerelease when false');
  });

  it('propagates execSync errors', () => {
    const github = loadWithThrow(new Error('tag already exists'));
    assert.throws(() => github.createRelease('snipcodeit/mgw', 'v1.0.0', 'Dup'), /tag already exists/);
  });
});

// ---------------------------------------------------------------------------
// createProject
// ---------------------------------------------------------------------------

describe('createProject', () => {
  beforeEach(restoreMocks);

  it('returns { number, url } from parsed JSON', () => {
    const { github } = loadWithMock(FX.project);
    const result = github.createProject('snipcodeit', 'My Board');

    assert.equal(result.number, 7);
    assert.equal(result.url, 'https://github.com/orgs/snipcodeit/projects/7');
  });

  it('constructs correct gh project create command', () => {
    const { github, spy } = loadWithMock(FX.project);
    github.createProject('snipcodeit', 'My Board');

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh project create'), 'should call gh project create');
    assert.ok(cmd.includes('snipcodeit'), 'should include owner');
    assert.ok(cmd.includes('My Board'), 'should include title');
    assert.ok(cmd.includes('--format json'), 'should request json format');
  });

  it('propagates execSync errors', () => {
    const github = loadWithThrow(new Error('org not found'));
    assert.throws(() => github.createProject('bad-org', 'Board'), /org not found/);
  });
});

// ---------------------------------------------------------------------------
// addItemToProject
// ---------------------------------------------------------------------------

describe('addItemToProject', () => {
  beforeEach(restoreMocks);

  it('returns the raw item ID string', () => {
    const { github } = loadWithMock(FX.addItemOutput);
    const result = github.addItemToProject('snipcodeit', 7, 'https://github.com/snipcodeit/mgw/issues/1');

    assert.equal(result, FX.addItemOutput);
  });

  it('constructs correct gh project item-add command', () => {
    const { github, spy } = loadWithMock(FX.addItemOutput);
    github.addItemToProject('snipcodeit', 7, 'https://github.com/snipcodeit/mgw/issues/1');

    const cmd = spy.mock.calls[0].arguments[0];
    assert.ok(cmd.includes('gh project item-add 7'), 'should include project number');
    assert.ok(cmd.includes('snipcodeit'), 'should include owner');
    assert.ok(cmd.includes('https://github.com/snipcodeit/mgw/issues/1'), 'should include issue URL');
  });

  it('propagates execSync errors', () => {
    const github = loadWithThrow(new Error('project not found'));
    assert.throws(() => github.addItemToProject('snipcodeit', 99, 'https://github.com/snipcodeit/mgw/issues/1'), /project not found/);
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

  it('returns { posted: true, method: "discussion", url } when Discussions succeed', () => {
    let callCount = 0;
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      // First call: repoMeta GraphQL query
      if (callCount === 1) return FX.repoMeta;
      // Second call: createDiscussion mutation
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    const result = github.postMilestoneStartAnnouncement(baseOpts);
    assert.equal(result.posted, true);
    assert.equal(result.method, 'discussion');
    assert.equal(result.url, 'https://github.com/snipcodeit/mgw/discussions/99');
  });

  it('falls back to issue comment when Discussions are not available', () => {
    // Return repoMeta WITHOUT an Announcements category
    const repoMetaNoAnnouncements = JSON.stringify({
      id: 'R_kgDOABC',
      discussionCategories: { nodes: [{ id: 'DIC_kwDOXYZ', name: 'General' }] }
    });

    let callCount = 0;
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return repoMetaNoAnnouncements;
      // Second call is the fallback comment
      return '';
    });
    const github = require(GITHUB_MODULE);

    const result = github.postMilestoneStartAnnouncement(baseOpts);
    assert.equal(result.posted, true);
    assert.equal(result.method, 'comment');
    assert.equal(result.url, null);
  });

  it('falls back to issue comment when GraphQL throws', () => {
    let callCount = 0;
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) throw new Error('Discussions not enabled');
      // Second call is the fallback comment
      return '';
    });
    const github = require(GITHUB_MODULE);

    const result = github.postMilestoneStartAnnouncement(baseOpts);
    assert.equal(result.posted, true);
    assert.equal(result.method, 'comment');
  });

  it('returns { posted: false, method: "none" } when both paths fail', () => {
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', () => { throw new Error('all failed'); });
    const github = require(GITHUB_MODULE);

    const result = github.postMilestoneStartAnnouncement(baseOpts);
    assert.equal(result.posted, false);
    assert.equal(result.method, 'none');
    assert.equal(result.url, null);
  });

  it('returns { posted: false } when no repo or firstIssueNumber is provided', () => {
    // No repo → skip GraphQL; no firstIssueNumber → skip comment fallback
    const { github } = loadWithMock('');
    const result = github.postMilestoneStartAnnouncement({
      milestoneName: 'v3.5',
      issues: []
    });

    assert.equal(result.posted, false);
    assert.equal(result.method, 'none');
  });

  it('includes boardUrl line in constructed body when boardUrl is provided', () => {
    let capturedBody = '';
    let callCount = 0;
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      if (callCount === 1) return FX.repoMeta;
      // Capture the createDiscussion call to inspect the body
      capturedBody = cmd;
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    github.postMilestoneStartAnnouncement(baseOpts);
    // The second execSync call contains the mutation with the board URL embedded
    assert.ok(capturedBody.includes('https://github.com/orgs/snipcodeit/projects/7'), 'body should include board URL');
  });

  it('uses "_(not configured)_" when boardUrl is not provided', () => {
    let capturedBody = '';
    let callCount = 0;
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      if (callCount === 1) return FX.repoMeta;
      capturedBody = cmd;
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    github.postMilestoneStartAnnouncement({ ...baseOpts, boardUrl: undefined });
    assert.ok(capturedBody.includes('not configured'), 'body should include "not configured" when no board URL');
  });

  it('includes issue table rows in constructed body', () => {
    let capturedBody = '';
    let callCount = 0;
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      if (callCount === 1) return FX.repoMeta;
      capturedBody = cmd;
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    github.postMilestoneStartAnnouncement(baseOpts);
    assert.ok(capturedBody.includes('#134'), 'body should include issue number');
    assert.ok(capturedBody.includes('Write tests'), 'body should include issue title');
    assert.ok(capturedBody.includes('@hat'), 'body should include assignee');
  });

  it('renders "—" for unassigned issues in body', () => {
    let capturedBody = '';
    let callCount = 0;
    delete require.cache[GITHUB_MODULE];
    mock.method(childProcess, 'execSync', (cmd, _opts) => {
      callCount++;
      if (callCount === 1) return FX.repoMeta;
      capturedBody = cmd;
      return FX.discussionResult;
    });
    const github = require(GITHUB_MODULE);

    github.postMilestoneStartAnnouncement({
      ...baseOpts,
      issues: [{ number: 1, title: 'Unassigned issue', assignee: null, gsdRoute: 'execute' }]
    });
    // The em dash "—" appears as the assignee placeholder
    assert.ok(capturedBody.includes('\\u2014') || capturedBody.includes('—'), 'body should include em dash for unassigned');
  });
});
