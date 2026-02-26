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

module.exports = {
  getRepo,
  getIssue,
  listIssues,
  getMilestone,
  getRateLimit,
  closeMilestone,
  createRelease
};
