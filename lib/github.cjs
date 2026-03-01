'use strict';

/**
 * lib/github.cjs — GitHub API via gh CLI
 *
 * Thin wrappers around gh CLI commands for issues, milestones,
 * PRs, labels, and rate limit queries.
 * All functions use execSync with stdio piped; throw on error.
 */

const { execSync } = require('child_process');

/**
 * Execute a shell command and return its stdout as a trimmed string.
 * @param {string} cmd
 * @returns {string}
 */
function run(cmd) {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
}

/**
 * Get the current repo's nameWithOwner (e.g. "owner/repo").
 * @returns {string}
 */
function getRepo() {
  return run('gh repo view --json nameWithOwner -q .nameWithOwner');
}

/**
 * Get a single issue by number.
 * @param {number|string} number - Issue number
 * @returns {object} Parsed issue JSON
 */
function getIssue(number) {
  const raw = run(
    `gh issue view ${number} --json number,title,state,labels,milestone,assignees,body`
  );
  return JSON.parse(raw);
}

/**
 * List issues with optional filters.
 * @param {object} [filters]
 * @param {string} [filters.label] - Filter by label name
 * @param {string} [filters.milestone] - Filter by milestone title or number
 * @param {string} [filters.assignee] - Filter by assignee login
 * @param {string} [filters.state] - "open" | "closed" | "all" (default: "open")
 * @returns {Array<object>} Parsed array of issue objects
 */
function listIssues(filters) {
  const f = filters || {};
  let cmd = 'gh issue list --json number,title,state,labels,milestone,assignees';

  if (f.label) cmd += ` --label ${JSON.stringify(f.label)}`;
  if (f.milestone) cmd += ` --milestone ${JSON.stringify(f.milestone)}`;
  if (f.assignee && f.assignee !== 'all') cmd += ` --assignee ${JSON.stringify(f.assignee)}`;
  if (f.state) cmd += ` --state ${f.state}`;

  const raw = run(cmd);
  return JSON.parse(raw);
}

/**
 * Get a milestone by number via GitHub API.
 * @param {number|string} number - Milestone number
 * @returns {object} Parsed milestone JSON
 */
function getMilestone(number) {
  const repo = getRepo();
  const raw = run(`gh api repos/${repo}/milestones/${number}`);
  return JSON.parse(raw);
}

/**
 * Get the current API rate limit status.
 * @returns {{remaining: number, limit: number, reset: number}} Core rate limit
 */
function getRateLimit() {
  const raw = run('gh api rate_limit');
  const data = JSON.parse(raw);
  const core = data.resources.core;
  return {
    remaining: core.remaining,
    limit: core.limit,
    reset: core.reset
  };
}

/**
 * Close a milestone via GitHub API PATCH.
 * @param {string} repo - "owner/repo"
 * @param {number|string} number - Milestone number
 * @returns {object} Parsed updated milestone JSON
 */
function closeMilestone(repo, number) {
  const raw = run(
    `gh api repos/${repo}/milestones/${number} --method PATCH -f state=closed`
  );
  return JSON.parse(raw);
}

/**
 * Create a GitHub release.
 * @param {string} repo - "owner/repo"
 * @param {string} tag - Tag name (e.g. "v1.0.0")
 * @param {string} title - Release title
 * @param {object} [opts]
 * @param {string} [opts.notes] - Release notes body
 * @param {boolean} [opts.draft] - Create as draft
 * @param {boolean} [opts.prerelease] - Mark as pre-release
 * @returns {string} Output from gh release create
 */
function createRelease(repo, tag, title, opts) {
  const o = opts || {};
  let cmd = `gh release create ${JSON.stringify(tag)} --repo ${JSON.stringify(repo)} --title ${JSON.stringify(title)}`;

  if (o.notes) cmd += ` --notes ${JSON.stringify(o.notes)}`;
  if (o.draft) cmd += ' --draft';
  if (o.prerelease) cmd += ' --prerelease';

  return run(cmd);
}

/**
 * Create a GitHub Projects v2 board.
 * @param {string} owner - GitHub org or user (e.g. "snipcodeit")
 * @param {string} title - Project board title
 * @returns {{number: number, url: string}} Project number and URL
 */
function createProject(owner, title) {
  const raw = run(
    `gh project create --owner ${JSON.stringify(owner)} --title ${JSON.stringify(title)} --format json`
  );
  const data = JSON.parse(raw);
  return { number: data.number, url: data.url };
}

/**
 * Add an issue to a GitHub Projects v2 board.
 * @param {string} owner - GitHub org or user
 * @param {number} projectNumber - Project board number
 * @param {string} issueUrl - Full issue URL (e.g. https://github.com/owner/repo/issues/1)
 * @returns {string} Item ID
 */
function addItemToProject(owner, projectNumber, issueUrl) {
  return run(
    `gh project item-add ${projectNumber} --owner ${JSON.stringify(owner)} --url ${JSON.stringify(issueUrl)}`
  );
}

/**
 * Post a milestone-start announcement to GitHub Discussions (Announcements category).
 * Falls back to a comment on the first milestone issue if Discussions are not enabled.
 * Never throws — all errors are caught and returned as { posted: false }.
 *
 * @param {object} opts
 * @param {string} opts.repo              - "owner/repo"
 * @param {string} opts.milestoneName     - Human-readable milestone name
 * @param {string|number} [opts.milestoneNumber] - GitHub milestone number (optional, for context)
 * @param {string} [opts.boardUrl]        - Optional project board URL
 * @param {Array<{number: number, title: string, assignee: string|null, gsdRoute: string}>} opts.issues
 * @param {number} [opts.firstIssueNumber] - Fallback: issue number to comment on if Discussions fail
 * @returns {{ posted: boolean, method: 'discussion'|'comment'|'none', url: string|null }}
 */
function postMilestoneStartAnnouncement(opts) {
  const {
    repo,
    milestoneName,
    boardUrl,
    issues,
    firstIssueNumber
  } = opts;

  const timestamp = new Date().toISOString();
  const issueList = Array.isArray(issues) ? issues : [];

  // Build issue table rows
  const issueRows = issueList.map(i => {
    const assignee = i.assignee ? `@${i.assignee}` : '—';
    return `| #${i.number} | ${i.title} | ${assignee} | \`${i.gsdRoute}\` |`;
  }).join('\n');

  const boardLine = boardUrl
    ? `**Board:** ${boardUrl}`
    : '**Board:** _(not configured)_';

  const body = [
    `> **MGW** · \`milestone-started\` · ${timestamp}`,
    '',
    `## Milestone Execution Started: ${milestoneName}`,
    '',
    boardLine,
    '',
    '### Issues in This Milestone',
    '',
    '| # | Title | Assignee | Route |',
    '|---|-------|----------|-------|',
    issueRows,
    '',
    `**${issueList.length} issue(s)** queued for autonomous execution. PRs will be posted on each issue as they complete.`,
    '',
    '---',
    '*Auto-posted by MGW milestone orchestration*'
  ].join('\n');

  const title = `[MGW] Milestone Started: ${milestoneName}`;

  // 1. Try GitHub Discussions (Announcements category) via GraphQL
  if (repo) {
    try {
      const [owner, repoName] = repo.split('/');

      const repoMetaRaw = run(
        `gh api graphql -f query='query { repository(owner: "${owner}", name: "${repoName}") { id discussionCategories(first: 20) { nodes { id name } } } }' --jq '.data.repository'`
      );
      const repoMeta = JSON.parse(repoMetaRaw);

      const categories = (repoMeta.discussionCategories && repoMeta.discussionCategories.nodes) || [];
      const announcements = categories.find(c => c.name === 'Announcements');

      if (announcements) {
        const repoId = repoMeta.id;
        const categoryId = announcements.id;

        const bodyEscaped = JSON.stringify(body);
        const titleEscaped = JSON.stringify(title);

        const resultRaw = run(
          `gh api graphql -f query='mutation { createDiscussion(input: { repositoryId: ${JSON.stringify(repoId)}, categoryId: ${JSON.stringify(categoryId)}, title: ${titleEscaped}, body: ${bodyEscaped} }) { discussion { url } } }' --jq '.data.createDiscussion.discussion'`
        );

        const result = JSON.parse(resultRaw);
        if (result && result.url) {
          return { posted: true, method: 'discussion', url: result.url };
        }
      }
    } catch (_) {
      // Discussions not available or GraphQL failed — fall through to comment
    }
  }

  // 2. Fallback: comment on first issue
  if (firstIssueNumber && repo) {
    try {
      run(
        `gh issue comment ${firstIssueNumber} --repo ${JSON.stringify(repo)} --body ${JSON.stringify(body)}`
      );
      return { posted: true, method: 'comment', url: null };
    } catch (_) {
      // ignore
    }
  }

  return { posted: false, method: 'none', url: null };
}

module.exports = {
  getRepo,
  getIssue,
  listIssues,
  getMilestone,
  getRateLimit,
  closeMilestone,
  createRelease,
  createProject,
  addItemToProject,
  postMilestoneStartAnnouncement
};
