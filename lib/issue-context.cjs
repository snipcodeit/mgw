'use strict';

/**
 * lib/issue-context.cjs — Structured issue comment read/write layer
 *
 * Provides functions to post and retrieve structured planning comments
 * on GitHub issues with machine-readable metadata headers.
 *
 * Comment format:
 *   <!-- mgw:type=plan mgw:phase=3 mgw:milestone=1 mgw:timestamp=2026-03-05T12:00:00Z -->
 *   # Phase 3: Authentication Layer
 *   ...
 *
 * All GitHub interactions use the `gh` CLI (matching lib/github.cjs patterns).
 * Context assembly respects budget limits to avoid agent prompt overflow.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Default timeout for gh CLI calls (30 seconds) */
const GH_TIMEOUT_MS = 30_000;

/** Context budget limits (chars) */
const BUDGET = {
  vision: 2000,
  priorSummary: 500,
  maxPriorSummaries: 5,
  currentPlan: 4000,
  milestone: 1000,
};

/** Cache TTL in minutes */
const CACHE_TTL_MINUTES = 30;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a shell command synchronously, return trimmed stdout.
 * @param {string} cmd
 * @returns {string}
 */
function run(cmd) {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: GH_TIMEOUT_MS,
  }).trim();
}

/**
 * Get the .mgw/ directory path.
 * @returns {string}
 */
function getMgwDir() {
  return path.join(process.cwd(), '.mgw');
}

/**
 * Get context cache directory, creating it if needed.
 * @returns {string}
 */
function getCacheDir() {
  const dir = path.join(getMgwDir(), 'context-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Truncate a string to maxLen chars.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen) + '...';
}

// ---------------------------------------------------------------------------
// Metadata parsing and formatting
// ---------------------------------------------------------------------------

/**
 * Parse `<!-- mgw:key=value ... -->` metadata from a comment body.
 * @param {string} commentBody
 * @returns {{ type: string|null, phase: number|null, milestone: number|null, timestamp: string|null }}
 */
function parseMetadata(commentBody) {
  const result = { type: null, phase: null, milestone: null, timestamp: null };
  if (!commentBody) return result;

  const match = commentBody.match(/<!--\s*(mgw:[^\n]*?)-->/);
  if (!match) return result;

  const header = match[1];
  const typeMatch = header.match(/mgw:type=(\S+)/);
  const phaseMatch = header.match(/mgw:phase=(\S+)/);
  const milestoneMatch = header.match(/mgw:milestone=(\S+)/);
  const timestampMatch = header.match(/mgw:timestamp=(\S+)/);

  if (typeMatch) result.type = typeMatch[1];
  if (phaseMatch) result.phase = parseInt(phaseMatch[1], 10);
  if (milestoneMatch) result.milestone = parseInt(milestoneMatch[1], 10);
  if (timestampMatch) result.timestamp = timestampMatch[1];

  return result;
}

/**
 * Prepend `<!-- mgw:type=X mgw:phase=N ... -->` metadata header to content.
 * @param {string} content
 * @param {{ type?: string, phase?: number, milestone?: number, timestamp?: string }} meta
 * @returns {string}
 */
function formatWithMetadata(content, meta) {
  const m = meta || {};
  const ts = m.timestamp || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const parts = [];
  if (m.type) parts.push(`mgw:type=${m.type}`);
  if (m.phase != null) parts.push(`mgw:phase=${m.phase}`);
  if (m.milestone != null) parts.push(`mgw:milestone=${m.milestone}`);
  parts.push(`mgw:timestamp=${ts}`);

  const header = `<!-- ${parts.join(' ')} -->`;
  return `${header}\n${content}`;
}

// ---------------------------------------------------------------------------
// Comment posting and retrieval
// ---------------------------------------------------------------------------

/**
 * Post a comment with structured metadata header on a GitHub issue.
 * @param {number} issueNumber
 * @param {string} type - Comment type (plan, summary, verification, triage)
 * @param {string} content - Markdown content
 * @param {{ phase?: number, milestone?: number }} meta - Additional metadata
 * @returns {Promise<void>}
 */
async function postPlanningComment(issueNumber, type, content, meta) {
  const formatted = formatWithMetadata(content, { ...meta, type });
  // Write to temp file to avoid shell escaping issues with large content
  const tmpFile = path.join(require('os').tmpdir(), `mgw-comment-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmpFile, formatted, 'utf-8');
    run(`gh issue comment ${issueNumber} --body-file ${JSON.stringify(tmpFile)}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Find all comments matching a metadata type on an issue.
 * @param {number} issueNumber
 * @param {string} type - Comment type to filter by
 * @returns {Promise<Array<{ body: string, meta: object, createdAt: string }>>}
 */
async function findPlanningComments(issueNumber, type) {
  const raw = run(
    `gh issue view ${issueNumber} --json comments --jq '.comments'`
  );
  const comments = JSON.parse(raw);
  const results = [];
  for (const c of comments) {
    const meta = parseMetadata(c.body);
    if (meta.type === type) {
      results.push({
        body: c.body,
        meta,
        createdAt: c.createdAt || '',
      });
    }
  }
  return results;
}

/**
 * Get the most recent comment of a given type from an issue.
 * @param {number} issueNumber
 * @param {string} type
 * @returns {Promise<{ body: string, meta: object, createdAt: string } | null>}
 */
async function findLatestComment(issueNumber, type) {
  const comments = await findPlanningComments(issueNumber, type);
  if (comments.length === 0) return null;
  // Sort by timestamp (from metadata or createdAt), return last
  comments.sort((a, b) => {
    const tsA = a.meta.timestamp || a.createdAt || '';
    const tsB = b.meta.timestamp || b.createdAt || '';
    return tsA.localeCompare(tsB);
  });
  return comments[comments.length - 1];
}

/**
 * Pull summary comments from all completed issues in a milestone.
 * @param {number|string} milestoneNum - GitHub milestone number or title
 * @returns {Promise<Array<{ issueNumber: number, title: string, summary: string }>>}
 */
async function assembleMilestoneContext(milestoneNum) {
  // Check cache first
  const cached = readCache(milestoneNum);
  if (cached) return Object.values(cached.summaries);

  const raw = run(
    `gh issue list --milestone ${JSON.stringify(String(milestoneNum))} --state closed --json number,title --limit 100`
  );
  const issues = JSON.parse(raw);
  const summaries = [];

  for (const issue of issues) {
    try {
      const comment = await findLatestComment(issue.number, 'summary');
      if (comment) {
        // Strip metadata header from body for clean summary
        const bodyWithoutHeader = comment.body.replace(/<!--[\s\S]*?-->\n?/, '').trim();
        summaries.push({
          issueNumber: issue.number,
          title: issue.title,
          summary: truncate(bodyWithoutHeader, BUDGET.priorSummary),
        });
      }
    } catch (_) {
      // Skip issues we can't read
    }
  }

  // Cache results
  writeCache(milestoneNum, summaries);
  return summaries;
}

/**
 * Pull full context for an issue: body + milestone context from sibling issues.
 * @param {number} issueNumber
 * @returns {Promise<{ issue: object, milestoneContext: Array, planComment: object|null, summaryComment: object|null }>}
 */
async function assembleIssueContext(issueNumber) {
  const raw = run(
    `gh issue view ${issueNumber} --json number,title,body,milestone,labels,state`
  );
  const issue = JSON.parse(raw);

  let milestoneContext = [];
  if (issue.milestone && issue.milestone.number) {
    try {
      milestoneContext = await assembleMilestoneContext(issue.milestone.number);
    } catch (_) {}
  }

  let planComment = null;
  let summaryComment = null;
  try { planComment = await findLatestComment(issueNumber, 'plan'); } catch (_) {}
  try { summaryComment = await findLatestComment(issueNumber, 'summary'); } catch (_) {}

  return { issue, milestoneContext, planComment, summaryComment };
}

// ---------------------------------------------------------------------------
// Context assembly for GSD agent prompts
// ---------------------------------------------------------------------------

/**
 * Fetch project vision from GitHub Project README first, fall back to local project.json.
 * @returns {Promise<string>} Vision text (may be empty string)
 */
async function fetchProjectVision() {
  // Source 1: GitHub Project README (works on any machine)
  try {
    const projectJsonPath = path.join(getMgwDir(), 'project.json');
    if (fs.existsSync(projectJsonPath)) {
      const project = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
      const projectNumber = (project.project && project.project.project_board && project.project.project_board.number) || '';
      if (projectNumber) {
        const owner = run('gh repo view --json owner -q .owner.login');
        const readme = run(
          `gh project view ${projectNumber} --owner ${owner} --json readme -q .readme`
        );
        if (readme && readme.length > 10) {
          // Extract the Vision section from the README if present
          const visionMatch = readme.match(/##\s*Vision\s*\n([\s\S]*?)(?=\n##\s|\n$|$)/);
          if (visionMatch && visionMatch[1].trim()) {
            return visionMatch[1].trim();
          }
          // If no Vision section, use the whole README (minus title line)
          const lines = readme.split('\n');
          const bodyLines = lines.filter(l => !l.startsWith('# '));
          const body = bodyLines.join('\n').trim();
          if (body) return body;
        }
      }
    }
  } catch (_) {
    // GitHub Project README unavailable — fall through to local
  }

  // Source 2: Local project.json (fallback)
  try {
    const projectJsonPath = path.join(getMgwDir(), 'project.json');
    if (fs.existsSync(projectJsonPath)) {
      const project = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
      const description = (project.project && project.project.description) || '';
      if (description) return description;
      const projectName = (project.project && project.project.name) || '';
      if (projectName) return `Project: ${projectName}`;
    }
  } catch (_) {}

  // Source 3: Vision brief (last resort)
  try {
    const visionBriefPath = path.join(getMgwDir(), 'vision-brief.json');
    if (fs.existsSync(visionBriefPath)) {
      const brief = JSON.parse(fs.readFileSync(visionBriefPath, 'utf-8'));
      return brief.vision_summary || brief.description || '';
    }
  } catch (_) {}

  return '';
}

/**
 * Format assembled context as `<mgw_context>` XML block for GSD agent injection.
 * @param {object} opts
 * @param {number} [opts.milestone] - Milestone number
 * @param {number} [opts.phase] - Current phase number
 * @param {number} [opts.issueNumber] - Current issue number
 * @param {boolean} [opts.includeVision] - Include project vision
 * @param {boolean} [opts.includePriorSummaries] - Include prior phase summaries
 * @param {boolean} [opts.includeCurrentPlan] - Include current plan
 * @returns {Promise<string>}
 */
async function buildGSDPromptContext(opts) {
  const o = opts || {};
  const sections = [];

  // Vision: GitHub Project README first, local fallback
  if (o.includeVision) {
    try {
      const vision = await fetchProjectVision();
      if (vision) {
        sections.push(`<vision>\n${truncate(vision, BUDGET.vision)}\n</vision>`);
      }
    } catch (_) {}
  }

  // Milestone context
  if (o.milestone) {
    try {
      const milestoneRaw = run(
        `gh api repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/milestones/${o.milestone} --jq '{title: .title, description: .description}'`
      );
      const milestoneData = JSON.parse(milestoneRaw);
      const milestoneInfo = truncate(
        `${milestoneData.title}\n${milestoneData.description || ''}`,
        BUDGET.milestone
      );
      sections.push(`<milestone>\n${milestoneInfo}\n</milestone>`);
    } catch (_) {}
  }

  // Prior phase summaries
  if (o.includePriorSummaries && o.milestone) {
    try {
      const summaries = await assembleMilestoneContext(o.milestone);
      // Filter to only phases before current, take last N
      const prior = summaries
        .filter(s => o.issueNumber == null || s.issueNumber !== o.issueNumber)
        .slice(-BUDGET.maxPriorSummaries);

      if (prior.length > 0) {
        const priorText = prior
          .map(s => `### Issue #${s.issueNumber}: ${s.title}\n${s.summary}`)
          .join('\n\n');
        sections.push(`<prior_phases>\n${priorText}\n</prior_phases>`);
      }
    } catch (_) {}
  }

  // Current plan
  if (o.includeCurrentPlan && o.issueNumber) {
    try {
      const planComment = await findLatestComment(o.issueNumber, 'plan');
      if (planComment) {
        const planBody = planComment.body.replace(/<!--[\s\S]*?-->\n?/, '').trim();
        sections.push(`<current_phase>\n${truncate(planBody, BUDGET.currentPlan)}\n</current_phase>`);
      }
    } catch (_) {}
  }

  if (sections.length === 0) return '';
  return `<mgw_context>\n\n${sections.join('\n\n')}\n\n</mgw_context>`;
}

/**
 * Non-throwing wrapper for context assembly. Returns empty string on any failure.
 * Pipeline never blocks on context assembly.
 * @param {object} opts - Same as buildGSDPromptContext
 * @returns {Promise<string>}
 */
async function safeContext(opts) {
  try {
    return await buildGSDPromptContext(opts);
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Context cache
// ---------------------------------------------------------------------------

/**
 * Read cached summaries for a milestone.
 * @param {number|string} milestoneNum
 * @returns {{ summaries: object } | null}
 */
function readCache(milestoneNum) {
  try {
    const cachePath = path.join(getCacheDir(), `milestone-${milestoneNum}.json`);
    if (!fs.existsSync(cachePath)) return null;
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const cachedAt = new Date(data.cached_at);
    const now = new Date();
    const ageMinutes = (now - cachedAt) / (1000 * 60);
    if (ageMinutes > (data.ttl_minutes || CACHE_TTL_MINUTES)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/**
 * Write summaries to cache for a milestone.
 * @param {number|string} milestoneNum
 * @param {Array} summaries
 */
function writeCache(milestoneNum, summaries) {
  try {
    const cachePath = path.join(getCacheDir(), `milestone-${milestoneNum}.json`);
    const summaryMap = {};
    for (const s of summaries) {
      summaryMap[String(s.issueNumber)] = s;
    }
    const data = {
      milestone: Number(milestoneNum),
      cached_at: new Date().toISOString(),
      ttl_minutes: CACHE_TTL_MINUTES,
      summaries: summaryMap,
    };
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (_) {}
}

/**
 * Rebuild context cache from GitHub issue comments for all milestones.
 * Invalidates existing cache and rebuilds from GitHub.
 * @returns {Promise<{ issueCount: number, milestoneCount: number }>}
 */
async function rebuildContextCache() {
  const cacheDir = getCacheDir();
  // Clear existing cache
  try {
    const files = fs.readdirSync(cacheDir);
    for (const f of files) {
      if (f.startsWith('milestone-') && f.endsWith('.json')) {
        fs.unlinkSync(path.join(cacheDir, f));
      }
    }
  } catch (_) {}

  // Get all milestones
  let milestones;
  try {
    const repo = run('gh repo view --json nameWithOwner -q .nameWithOwner');
    const raw = run(`gh api repos/${repo}/milestones?state=all --jq '.[].number'`);
    milestones = raw.split('\n').filter(Boolean).map(Number);
  } catch (_) {
    milestones = [];
  }

  let totalIssues = 0;
  for (const num of milestones) {
    try {
      const summaries = await assembleMilestoneContext(num);
      totalIssues += summaries.length;
    } catch (_) {}
  }

  return { issueCount: totalIssues, milestoneCount: milestones.length };
}

// ---------------------------------------------------------------------------
// Project README management
// ---------------------------------------------------------------------------

/**
 * Update the GitHub Project README with current vision and milestone state.
 * Reads from project.json for milestone data and fetchProjectVision() for vision.
 * Non-blocking — returns silently on any failure.
 * @returns {Promise<boolean>} true if updated, false if skipped/failed
 */
async function updateProjectReadme() {
  try {
    const projectJsonPath = path.join(getMgwDir(), 'project.json');
    if (!fs.existsSync(projectJsonPath)) return false;

    const project = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
    const board = (project.project && project.project.project_board) || {};
    const projectNumber = board.number;
    if (!projectNumber) return false;

    const owner = run('gh repo view --json owner -q .owner.login');
    const projectName = (project.project && project.project.name) || '';

    // Get vision from local sources (don't re-read the README we're about to write)
    let visionSummary = '';
    try {
      const visionBriefPath = path.join(getMgwDir(), 'vision-brief.json');
      if (fs.existsSync(visionBriefPath)) {
        const brief = JSON.parse(fs.readFileSync(visionBriefPath, 'utf-8'));
        visionSummary = (brief.vision_summary || brief.description || '').slice(0, 500);
      }
    } catch (_) {}
    if (!visionSummary) {
      visionSummary = (project.project && project.project.description) || 'Project initialized via MGW.';
    }

    // Build milestones table
    const milestones = project.milestones || [];
    const tableLines = ['| # | Milestone | Issues | Status |', '|---|-----------|--------|--------|'];
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      const name = m.name || m.title || 'Unnamed';
      const count = (m.issues || []).length;
      const doneCount = (m.issues || []).filter(iss => iss.pipeline_stage === 'done').length;
      const state = m.gsd_state || 'planned';
      const progress = count > 0 ? ` (${doneCount}/${count})` : '';
      const stateLabel = state.charAt(0).toUpperCase() + state.slice(1);
      tableLines.push(`| ${i + 1} | ${name} | ${count}${progress} | ${stateLabel} |`);
    }

    const boardUrl = board.url || '';
    const readmeBody = `# ${projectName}\n\n## Vision\n${visionSummary}\n\n## Milestones\n${tableLines.join('\n')}\n\n## Links\n- [Board](${boardUrl})`;

    // Write to temp file to avoid shell escaping issues
    const tmpFile = path.join(require('os').tmpdir(), `mgw-readme-${Date.now()}.md`);
    try {
      fs.writeFileSync(tmpFile, readmeBody, 'utf-8');
      run(`gh project edit ${projectNumber} --owner ${owner} --readme "$(cat ${JSON.stringify(tmpFile)})"`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }

    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  parseMetadata,
  formatWithMetadata,
  postPlanningComment,
  findPlanningComments,
  findLatestComment,
  assembleMilestoneContext,
  assembleIssueContext,
  buildGSDPromptContext,
  safeContext,
  rebuildContextCache,
  fetchProjectVision,
  updateProjectReadme,
};
