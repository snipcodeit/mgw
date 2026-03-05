'use strict';

/**
 * lib/gsd-adapter.cjs — Centralized GSD integration layer
 *
 * Single point of contact for all gsd-tools.cjs invocations within MGW.
 * Absorbs lib/gsd.cjs (getGsdToolsPath, invokeGsdTool) and adds typed
 * wrappers for the most-used tool calls so commands never hardcode the
 * gsd-tools path directly.
 *
 * Typed wrappers:
 *   getTimestamp()                          → current-timestamp --raw
 *   generateSlug(title)                     → generate-slug <title> --raw
 *   resolveModel(agentType)                 → resolve-model <agentType> --raw
 *   historyDigest()                         → history-digest --raw
 *   roadmapAnalyze()                        → roadmap analyze
 *   selectGsdRoute(issue, projectState)     → routing decision for GSD execution
 *   getGsdState()                           → reads .planning/STATE.md + ROADMAP.md
 */

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { TimeoutError, GsdToolError } = require('./errors.cjs');
const { STAGES } = require('./pipeline.cjs');

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the GSD installation root directory using a 3-tier lookup:
 *   1. GSD_TOOLS_PATH environment variable (if set and non-empty)
 *   2. .mgw/config.json `gsd_path` field (if file exists and field is present)
 *   3. Default: ~/.claude/get-shit-done/
 *
 * @returns {string} Absolute path to the GSD root directory
 */
function resolveGsdRoot() {
  // Tier 1: environment variable
  if (process.env.GSD_TOOLS_PATH) {
    return process.env.GSD_TOOLS_PATH;
  }

  // Tier 2: .mgw/config.json gsd_path field
  const configPath = path.join(process.cwd(), '.mgw', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.gsd_path) {
        return config.gsd_path;
      }
    } catch {
      // Malformed config.json — fall through to default
    }
  }

  // Tier 3: default install location
  return path.join(os.homedir(), '.claude', 'get-shit-done');
}

/**
 * Resolve the absolute path to gsd-tools.cjs using 3-tier path resolution:
 *   1. GSD_TOOLS_PATH environment variable
 *   2. .mgw/config.json gsd_path field
 *   3. Default: ~/.claude/get-shit-done/bin/gsd-tools.cjs
 *
 * @returns {string} Absolute path to gsd-tools.cjs
 * @throws {Error} If gsd-tools.cjs is not found at any of the checked locations
 */
function getGsdToolsPath() {
  const root = resolveGsdRoot();
  const toolPath = path.join(root, 'bin', 'gsd-tools.cjs');

  if (fs.existsSync(toolPath)) {
    return toolPath;
  }

  // Build a helpful error listing which paths were checked
  const checked = [];
  if (process.env.GSD_TOOLS_PATH) {
    checked.push(`  GSD_TOOLS_PATH: ${path.join(process.env.GSD_TOOLS_PATH, 'bin', 'gsd-tools.cjs')}`);
  }
  const configPath = path.join(process.cwd(), '.mgw', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.gsd_path) {
        checked.push(`  .mgw/config.json gsd_path: ${path.join(config.gsd_path, 'bin', 'gsd-tools.cjs')}`);
      }
    } catch { /* ignore */ }
  }
  const defaultPath = path.join(os.homedir(), '.claude', 'get-shit-done', 'bin', 'gsd-tools.cjs');
  checked.push(`  default: ${defaultPath}`);

  throw new Error(
    `GSD tools not found. Checked:\n${checked.join('\n')}\n` +
    'Set GSD_TOOLS_PATH or add gsd_path to .mgw/config.json'
  );
}

// ---------------------------------------------------------------------------
// Low-level invocation
// ---------------------------------------------------------------------------

/**
 * Invoke a gsd-tools subcommand and return its output.
 * If the output is valid JSON it is parsed and returned as a value; otherwise
 * the raw trimmed string is returned.
 *
 * @param {string}   command - GSD subcommand name (e.g. "current-timestamp")
 * @param {string[]} [args]  - Additional positional arguments
 * @returns {*} Parsed JSON or raw string output; null for empty output
 * @throws {Error} If the subprocess exits with a non-zero status
 */
/** Default timeout for GSD tool calls (15 seconds) */
const GSD_TIMEOUT_MS = 15_000;

function invokeGsdTool(command, args) {
  const toolPath = getGsdToolsPath();
  const argsStr = Array.isArray(args)
    ? args.map(a => JSON.stringify(String(a))).join(' ')
    : '';
  const cmd = `node ${JSON.stringify(toolPath)} ${command}${argsStr ? ' ' + argsStr : ''}`;

  let raw;
  try {
    raw = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GSD_TIMEOUT_MS,
    }).trim();
  } catch (err) {
    if (err.killed) {
      throw new TimeoutError(
        `GSD tool timed out after ${GSD_TIMEOUT_MS / 1000}s: ${command}`,
        { timeoutMs: GSD_TIMEOUT_MS, operation: `gsd-tools ${command}` }
      );
    }
    const stderr = err.stderr ? err.stderr.trim() : '';
    throw new GsdToolError(
      `GSD tool command failed: ${command}\n` +
      (stderr ? `stderr: ${stderr}` : `exit code: ${err.status}`),
      { command, cause: err }
    );
  }

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON — return the raw string
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------

/**
 * Return the current UTC timestamp string from gsd-tools.
 * Falls back to a JS-generated ISO string if gsd-tools is unavailable.
 *
 * @returns {string} ISO 8601 timestamp (e.g. "2026-03-01T12:00:00Z")
 */
function getTimestamp() {
  try {
    const result = invokeGsdTool('current-timestamp', ['--raw']);
    return typeof result === 'string' ? result : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

/**
 * Generate a URL-safe slug from a title using gsd-tools (40-char truncation).
 *
 * @param {string} title - Human-readable title to slugify
 * @returns {string} Generated slug string
 */
function generateSlug(title) {
  const result = invokeGsdTool('generate-slug', [title]);
  return typeof result === 'string' ? result : String(result);
}

/**
 * Resolve the canonical model name for a GSD agent type.
 *
 * @param {string} agentType - Agent type identifier (e.g. "gsd-planner", "gsd-executor")
 * @returns {string} Resolved model name/ID
 */
function resolveModel(agentType) {
  const result = invokeGsdTool('resolve-model', [agentType, '--raw']);
  return typeof result === 'string' ? result : String(result);
}

/**
 * Return a compact digest of the current GSD history log.
 *
 * @returns {*} Parsed JSON history digest or raw string
 */
function historyDigest() {
  return invokeGsdTool('history-digest', ['--raw']);
}

/**
 * Run the GSD roadmap analysis and return structured roadmap data.
 *
 * @returns {*} Parsed JSON roadmap analysis result
 */
function roadmapAnalyze() {
  return invokeGsdTool('roadmap', ['analyze']);
}

// ---------------------------------------------------------------------------
// Route selection
// ---------------------------------------------------------------------------

/**
 * Determine the GSD execution route for an issue.
 *
 * Decision priority (evaluated in order):
 *
 *   1. Explicit label — if issue labels include a gsd-route:* or gsd:* label,
 *      that label wins regardless of pipeline_stage or milestone position.
 *      Recognized label patterns:
 *        - "gsd-route:quick" / "gsd:quick" / "quick"   → 'quick'
 *        - "gsd-route:diagnose" / "needs-diagnosis"     → 'diagnose'
 *
 *   2. Pipeline stage continuation — if the issue already has a pipeline_stage
 *      that implies a specific in-progress route, continue that route:
 *        - "diagnosing"   → 'diagnose'
 *        - "executing"    → 'execute-only'
 *        - "verifying"    → 'verify-only'
 *
 *   3. Milestone position — if projectState is provided and indicates the active
 *      milestone has no prior completed phases (first issue of a new milestone),
 *      prefer 'plan-phase' to establish the initial plan.
 *
 *   4. Default — fall back to 'plan-phase' (safe default for any standard issue).
 *
 * @param {object} issue        - Issue state object (from .mgw/active/*.json).
 *                                Expected fields: labels (string[]), pipeline_stage (string).
 * @param {object} [projectState] - MGW project state (from lib/state.cjs loadProjectState).
 *                                  Optional; used only for milestone position check.
 * @returns {'quick'|'plan-phase'|'diagnose'|'execute-only'|'verify-only'} Route string
 */
function selectGsdRoute(issue, projectState) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const stage = typeof issue.pipeline_stage === 'string' ? issue.pipeline_stage : '';

  // Priority 1: Explicit label
  const labelStr = labels.map(l => (typeof l === 'string' ? l : (l.name || ''))).join(',').toLowerCase();

  if (/gsd-route:quick|gsd:quick\b|(?:^|,)quick(?:,|$)/.test(labelStr)) {
    return 'quick';
  }
  if (/gsd-route:diagnose|needs-diagnosis/.test(labelStr)) {
    return 'diagnose';
  }

  // Priority 2: Pipeline stage continuation
  if (stage === STAGES.DIAGNOSING) {
    return 'diagnose';
  }
  if (stage === STAGES.EXECUTING) {
    return 'execute-only';
  }
  if (stage === STAGES.VERIFYING) {
    return 'verify-only';
  }

  // Priority 3: Milestone position — first issue of an active milestone
  // suggests plan-phase is needed to establish the initial phase plan.
  // (This is a soft hint; plan-phase is already the default, so this branch
  //  exists only as a documented decision point for future extension.)
  if (projectState && projectState.milestones) {
    // Currently resolved to plan-phase regardless; placeholder for future
    // milestone-position-specific routing logic (e.g. execute-only for
    // issues in a milestone where planning is already complete).
  }

  // Priority 4: Default
  return 'plan-phase';
}

// ---------------------------------------------------------------------------
// GSD state reader
// ---------------------------------------------------------------------------

/**
 * Read current GSD execution state from .planning/STATE.md and ROADMAP.md.
 *
 * Combines two data sources:
 *   - .planning/STATE.md — contains the current phase and plan count summary
 *   - ROADMAP.md analysis via gsd-tools roadmap analyze — provides the active
 *     milestone identifier and structured phase data
 *
 * Returns null if .planning/ does not exist (GSD not yet initialized for this repo).
 *
 * @returns {{ activeMilestone: string|null, currentPhase: string|null, planCount: number }|null}
 */
function getGsdState() {
  const planningDir = path.join(process.cwd(), '.planning');
  const stateMdPath = path.join(planningDir, 'STATE.md');
  const roadmapPath = path.join(planningDir, 'ROADMAP.md');

  // If .planning/ doesn't exist, GSD is not initialized — return null.
  if (!fs.existsSync(planningDir)) {
    return null;
  }

  let activeMilestone = null;
  let currentPhase = null;
  let planCount = 0;

  // Read STATE.md for current phase and plan count
  if (fs.existsSync(stateMdPath)) {
    const stateContent = fs.readFileSync(stateMdPath, 'utf-8');

    // Extract current phase — look for "Phase N" or "Current Phase: N"
    const phaseMatch = stateContent.match(/(?:Current Phase|Phase)[:\s]+(\d+)/i);
    if (phaseMatch) {
      currentPhase = phaseMatch[1];
    }

    // Count plan file references (lines containing .planning/phase- paths)
    const planLines = stateContent.match(/\.planning\/phase-\d+/g);
    if (planLines) {
      planCount = planLines.length;
    }
  }

  // Read ROADMAP.md for active milestone via gsd-tools roadmap analyze
  if (fs.existsSync(roadmapPath)) {
    try {
      const roadmapData = roadmapAnalyze();
      if (roadmapData && typeof roadmapData === 'object') {
        // roadmap analyze returns { milestone, phases, ... } or similar
        activeMilestone = roadmapData.milestone || roadmapData.activeMilestone || null;

        // If roadmap data includes phase info and we didn't get it from STATE.md
        if (!currentPhase && roadmapData.currentPhase) {
          currentPhase = String(roadmapData.currentPhase);
        }
        if (!planCount && roadmapData.planCount) {
          planCount = Number(roadmapData.planCount) || 0;
        }
      }
    } catch {
      // roadmap analyze failure is non-fatal — return what we have from STATE.md
    }
  }

  return { activeMilestone, currentPhase, planCount };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  resolveGsdRoot,
  getGsdToolsPath,
  invokeGsdTool,
  getTimestamp,
  generateSlug,
  resolveModel,
  historyDigest,
  roadmapAnalyze,
  selectGsdRoute,
  getGsdState
};
