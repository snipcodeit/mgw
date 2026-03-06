'use strict';

/**
 * lib/state.cjs — MGW state management
 *
 * Read/write .mgw/project.json and .mgw/active/ issue files.
 * All paths are relative to process.cwd() so the CLI operates
 * correctly when run from any repo root.
 */

const fs = require('fs');
const path = require('path');

/**
 * Get the .mgw/ directory path for the current working directory.
 * @returns {string}
 */
function getMgwDir() {
  return path.join(process.cwd(), '.mgw');
}

/**
 * Get the .mgw/active/ directory path.
 * @returns {string}
 */
function getActiveDir() {
  return path.join(getMgwDir(), 'active');
}

/**
 * Get the .mgw/completed/ directory path.
 * @returns {string}
 */
function getCompletedDir() {
  return path.join(getMgwDir(), 'completed');
}

/**
 * Load project state from .mgw/project.json.
 * @returns {object|null} Parsed project.json or null if not found/invalid
 */
function loadProjectState() {
  const filePath = path.join(getMgwDir(), 'project.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write project state to .mgw/project.json.
 * Creates .mgw/ directory if it does not exist.
 * @param {object} state - Project state object to serialize
 */
function writeProjectState(state) {
  const mgwDir = getMgwDir();
  if (!fs.existsSync(mgwDir)) {
    fs.mkdirSync(mgwDir, { recursive: true });
  }
  const filePath = path.join(mgwDir, 'project.json');
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Load an active issue by number.
 * Looks for .mgw/active/{number}-*.json (glob pattern).
 * @param {number|string} number - Issue number
 * @returns {object|null} Parsed issue JSON or null if not found/invalid
 */
function loadActiveIssue(number) {
  const activeDir = getActiveDir();
  if (!fs.existsSync(activeDir)) {
    return null;
  }

  const prefix = String(number) + '-';
  let entries;
  try {
    entries = fs.readdirSync(activeDir);
  } catch {
    return null;
  }

  const match = entries.find(
    f => f.startsWith(prefix) && f.endsWith('.json')
  );

  if (!match) return null;

  try {
    const raw = fs.readFileSync(path.join(activeDir, match), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Merge new milestones into existing project state.
 * Appends milestones and phase_map entries, sets current_milestone.
 * Preserves all existing data (completed milestones, project config, board).
 * @param {Array} newMilestones - New milestone objects to append
 * @param {object} newPhaseMap - New phase_map entries (keyed by phase number string)
 * @param {number} newCurrentMilestone - 1-indexed milestone pointer for first new milestone (legacy)
 * @param {string|null} [activeGsdMilestone] - Optional new-schema active milestone ID (gsd_milestone_id string)
 * @returns {object} The merged project state
 * @throws {Error} If no existing project state found
 */
function mergeProjectState(newMilestones, newPhaseMap, newCurrentMilestone, activeGsdMilestone) {
  const existing = loadProjectState();
  if (!existing) {
    throw new Error('No existing project state found. Cannot merge without a project.json.');
  }

  // Append new milestones to existing milestones array
  existing.milestones = (existing.milestones || []).concat(newMilestones);

  // Merge new phase_map entries — new keys only, no overwrites of existing phase numbers
  existing.phase_map = Object.assign({}, newPhaseMap, existing.phase_map);

  // New schema: if activeGsdMilestone is provided, set it and skip the legacy field
  if (activeGsdMilestone !== undefined && activeGsdMilestone !== null) {
    existing.active_gsd_milestone = activeGsdMilestone;
  } else {
    // Legacy schema: set current_milestone (1-indexed) when active_gsd_milestone is not in use
    if (!existing.active_gsd_milestone) {
      existing.current_milestone = newCurrentMilestone;
    }
  }

  // Write the merged state back to disk
  writeProjectState(existing);

  return existing;
}

/**
 * Migrate an existing project.json to the new multi-milestone schema.
 * Adds default values for new fields (active_gsd_milestone, gsd_milestone_id,
 * gsd_state, roadmap_archived_at) without overwriting existing values.
 *
 * Also migrates active issue files in .mgw/active/ to add retry fields
 * (retry_count: 0, dead_letter: false) when they are absent.
 *
 * @returns {{ state: object|null, warnings: string[] }} Migrated state and any warnings
 */
function migrateProjectState() {
  const warnings = [];
  const existing = loadProjectState();
  if (!existing) return { state: null, warnings: [] };

  let changed = false;

  // Add active_gsd_milestone if missing (replaces current_milestone in new schema)
  if (!existing.hasOwnProperty('active_gsd_milestone')) {
    existing.active_gsd_milestone = null;
    changed = true;
    warnings.push('migration: added active_gsd_milestone field');
  }

  // Add new fields to each milestone if missing
  for (const m of (existing.milestones || [])) {
    const mLabel = m.title || m.gsd_milestone_id || 'unnamed';
    if (!m.hasOwnProperty('gsd_milestone_id')) {
      m.gsd_milestone_id = null;
      changed = true;
      warnings.push(`migration: added gsd_milestone_id to milestone "${mLabel}"`);
    }
    if (!m.hasOwnProperty('gsd_state')) {
      m.gsd_state = null;
      changed = true;
    }
    if (!m.hasOwnProperty('roadmap_archived_at')) {
      m.roadmap_archived_at = null;
      changed = true;
    }
  }

  if (changed) {
    writeProjectState(existing);
  }

  // Migrate active issue files: add retry fields if missing.
  // This is idempotent — fields are only written when absent.
  const activeDir = getActiveDir();
  if (fs.existsSync(activeDir)) {
    let entries;
    try {
      entries = fs.readdirSync(activeDir);
    } catch (err) {
      entries = [];
      warnings.push(`migration: could not read active dir: ${err.message}`);
    }

    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(activeDir, file);
      let issueState;
      try {
        issueState = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (err) {
        warnings.push(`migration: skipping unreadable ${file}: ${err.message}`);
        continue;
      }

      let issueChanged = false;

      if (!issueState.hasOwnProperty('retry_count')) {
        issueState.retry_count = 0;
        issueChanged = true;
      }

      if (!issueState.hasOwnProperty('dead_letter')) {
        issueState.dead_letter = false;
        issueChanged = true;
      }

      // Add checkpoint field if missing (null = not yet initialized).
      // Checkpoint is only populated when pipeline execution begins.
      if (!issueState.hasOwnProperty('checkpoint')) {
        issueState.checkpoint = null;
        issueChanged = true;
      }

      if (issueChanged) {
        try {
          fs.writeFileSync(filePath, JSON.stringify(issueState, null, 2), 'utf-8');
        } catch (err) {
          warnings.push(`migration: failed to write ${file}: ${err.message}`);
        }
      }
    }
  }

  return { state: existing, warnings };
}

/**
 * Resolve the 0-based index of the active milestone from project state.
 * Supports both the new schema (active_gsd_milestone string ID) and the
 * legacy schema (current_milestone 1-indexed integer).
 * @param {object|null} state - Project state object (from loadProjectState)
 * @returns {number} 0-based index into state.milestones, or -1 if not found/unset
 */
function resolveActiveMilestoneIndex(state) {
  if (!state) return -1;

  // New schema: active_gsd_milestone is a string ID matching gsd_milestone_id
  if (state.active_gsd_milestone) {
    const idx = (state.milestones || []).findIndex(
      m => m.gsd_milestone_id === state.active_gsd_milestone
    );
    return idx; // -1 if not found
  }

  // Legacy schema: current_milestone is 1-indexed integer
  if (typeof state.current_milestone === 'number') {
    return state.current_milestone - 1; // convert to 0-based
  }

  return -1;
}

// ---------------------------------------------------------------------------
// Checkpoint management
// ---------------------------------------------------------------------------

/** Current checkpoint schema version */
const CHECKPOINT_SCHEMA_VERSION = 1;

/**
 * Create a new checkpoint object with default values.
 * Called when pipeline execution begins (triage → executing transition).
 *
 * @param {string} [pipelineStep='triage'] - Initial pipeline step
 * @returns {object} Fresh checkpoint object
 */
function initCheckpoint(pipelineStep) {
  const now = new Date().toISOString();
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    pipeline_step: pipelineStep || 'triage',
    step_progress: {},
    last_agent_output: null,
    artifacts: [],
    resume: {
      action: null,
      context: {},
    },
    started_at: now,
    updated_at: now,
    step_history: [],
  };
}

/**
 * Merge checkpoint data into an active issue state file.
 *
 * Performs a shallow merge of the provided data onto the existing checkpoint
 * object — existing fields not present in `data` are preserved. The `artifacts`
 * and `step_history` arrays are append-only: new entries in `data` are concatenated
 * onto the existing arrays (never replaced).
 *
 * If the issue has no checkpoint yet, one is initialized first via initCheckpoint().
 *
 * @param {number|string} issueNumber - Issue number to update
 * @param {object} data - Partial checkpoint data to merge
 * @param {string} [data.pipeline_step] - Current pipeline step
 * @param {object} [data.step_progress] - Step-specific progress (shallow-merged)
 * @param {string} [data.last_agent_output] - Path to last agent output
 * @param {Array}  [data.artifacts] - New artifacts to append
 * @param {object} [data.resume] - Resume instructions (replaces entire resume object)
 * @param {Array}  [data.step_history] - New history entries to append
 * @returns {{ updated: boolean, checkpoint: object }} Result with updated checkpoint
 * @throws {Error} If no state file found for the given issue number
 */
function updateCheckpoint(issueNumber, data) {
  const activeDir = getActiveDir();
  if (!fs.existsSync(activeDir)) {
    throw new Error(`No active directory found. Cannot update checkpoint for #${issueNumber}.`);
  }

  const prefix = String(issueNumber) + '-';
  let entries;
  try {
    entries = fs.readdirSync(activeDir);
  } catch (err) {
    throw new Error(`Cannot read active directory: ${err.message}`);
  }

  const match = entries.find(f => f.startsWith(prefix) && f.endsWith('.json'));
  if (!match) {
    throw new Error(`No state file found for issue #${issueNumber}.`);
  }

  const filePath = path.join(activeDir, match);
  let issueState;
  try {
    issueState = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Cannot parse state file for #${issueNumber}: ${err.message}`);
  }

  // Initialize checkpoint if it does not exist
  if (!issueState.checkpoint || typeof issueState.checkpoint !== 'object') {
    issueState.checkpoint = initCheckpoint();
  }

  const cp = issueState.checkpoint;

  // Shallow merge scalar fields
  if (data.pipeline_step !== undefined) {
    cp.pipeline_step = data.pipeline_step;
  }
  if (data.last_agent_output !== undefined) {
    cp.last_agent_output = data.last_agent_output;
  }

  // Shallow merge step_progress (preserves keys not in data.step_progress)
  if (data.step_progress && typeof data.step_progress === 'object') {
    cp.step_progress = Object.assign({}, cp.step_progress, data.step_progress);
  }

  // Replace resume entirely if provided (resume.context is opaque per contract)
  if (data.resume && typeof data.resume === 'object') {
    cp.resume = data.resume;
  }

  // Append-only: artifacts
  if (Array.isArray(data.artifacts) && data.artifacts.length > 0) {
    cp.artifacts = (cp.artifacts || []).concat(data.artifacts);
  }

  // Append-only: step_history
  if (Array.isArray(data.step_history) && data.step_history.length > 0) {
    cp.step_history = (cp.step_history || []).concat(data.step_history);
  }

  // Always update the timestamp
  cp.updated_at = new Date().toISOString();

  // Write back
  issueState.checkpoint = cp;
  fs.writeFileSync(filePath, JSON.stringify(issueState, null, 2), 'utf-8');

  return { updated: true, checkpoint: cp };
}

// ---------------------------------------------------------------------------
// Cross-refs validation
// ---------------------------------------------------------------------------

/** Valid cross-ref link types */
const VALID_LINK_TYPES = new Set(['related', 'implements', 'tracks', 'maps-to', 'blocked-by']);

/**
 * Load and validate cross-refs.json from .mgw/.
 * Returns { links, warnings } where warnings contains validation messages
 * for skipped entries.
 *
 * @returns {{ links: Array<{a: string, b: string, type: string, created: string}>, warnings: string[] }}
 */
function loadCrossRefs() {
  const filePath = path.join(getMgwDir(), 'cross-refs.json');
  const warnings = [];

  if (!fs.existsSync(filePath)) {
    return { links: [], warnings: [] };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { links: [], warnings: [`cross-refs.json parse error: ${err.message}`] };
  }

  if (!raw || !Array.isArray(raw.links)) {
    return { links: [], warnings: ['cross-refs.json missing links array'] };
  }

  const validLinks = [];
  for (let i = 0; i < raw.links.length; i++) {
    const link = raw.links[i];
    const issues = [];

    if (!link || typeof link !== 'object') {
      warnings.push(`cross-refs link[${i}]: not an object, skipping`);
      continue;
    }
    if (typeof link.a !== 'string' || !link.a) {
      issues.push('missing "a"');
    }
    if (typeof link.b !== 'string' || !link.b) {
      issues.push('missing "b"');
    }
    if (link.type && !VALID_LINK_TYPES.has(link.type)) {
      issues.push(`unknown type "${link.type}"`);
    }

    if (issues.length > 0) {
      warnings.push(`cross-refs link[${i}]: ${issues.join(', ')}, skipping`);
      continue;
    }

    validLinks.push(link);
  }

  return { links: validLinks, warnings };
}

// ---------------------------------------------------------------------------
// Issue dependency parsing
// ---------------------------------------------------------------------------

/**
 * Parse issue body text for dependency declarations.
 *
 * Recognized patterns (case-insensitive):
 *   - "Depends on: #3, #7"
 *   - "Depends on #3 #7"
 *   - "Blocked by: #3, #7"
 *   - "Blocked by #3 and #7"
 *   - "depends-on: #3"
 *
 * @param {string} body - Issue body text
 * @returns {number[]} Array of dependency issue numbers (deduplicated)
 */
function parseDependencies(body) {
  if (!body || typeof body !== 'string') return [];

  const deps = new Set();
  // Match lines like "Depends on: #3, #7" or "Blocked by #3 and #7"
  const linePattern = /(?:depends[\s-]*on|blocked[\s-]*by)[:\s]+([^\n]+)/gi;
  let match;

  while ((match = linePattern.exec(body)) !== null) {
    const refs = match[1];
    const numPattern = /#(\d+)/g;
    let numMatch;
    while ((numMatch = numPattern.exec(refs)) !== null) {
      deps.add(parseInt(numMatch[1], 10));
    }
  }

  return Array.from(deps).sort((a, b) => a - b);
}

/**
 * Store parsed dependencies as blocked-by cross-refs.
 * Idempotent — skips links that already exist.
 *
 * @param {number} issueNumber - The issue that has dependencies
 * @param {number[]} dependsOn - Issue numbers this issue depends on
 * @returns {{ added: number, existing: number }} Count of new vs existing links
 */
function storeDependencies(issueNumber, dependsOn) {
  if (!dependsOn || dependsOn.length === 0) return { added: 0, existing: 0 };

  const crossRefsPath = path.join(getMgwDir(), 'cross-refs.json');
  let crossRefs = { links: [] };

  if (fs.existsSync(crossRefsPath)) {
    try {
      crossRefs = JSON.parse(fs.readFileSync(crossRefsPath, 'utf-8'));
      if (!Array.isArray(crossRefs.links)) crossRefs.links = [];
    } catch {
      crossRefs = { links: [] };
    }
  }

  let added = 0;
  let existing = 0;
  const issueRef = `#${issueNumber}`;

  for (const dep of dependsOn) {
    const depRef = `#${dep}`;
    const alreadyExists = crossRefs.links.some(
      l => l.a === issueRef && l.b === depRef && l.type === 'blocked-by'
    );

    if (alreadyExists) {
      existing++;
      continue;
    }

    crossRefs.links.push({
      a: issueRef,
      b: depRef,
      type: 'blocked-by',
      created: new Date().toISOString(),
    });
    added++;
  }

  if (added > 0) {
    const mgwDir = getMgwDir();
    if (!fs.existsSync(mgwDir)) {
      fs.mkdirSync(mgwDir, { recursive: true });
    }
    fs.writeFileSync(crossRefsPath, JSON.stringify(crossRefs, null, 2), 'utf-8');
  }

  return { added, existing };
}

/**
 * Topological sort of issues by their blocked-by dependencies.
 * Issues with no dependencies come first; issues blocked by others
 * come after their dependencies.
 *
 * @param {Array<{number: number}>} issues - Array of issue objects (must have .number)
 * @param {Array<{a: string, b: string, type: string}>} links - Cross-ref links
 * @returns {Array<{number: number}>} Topologically sorted issues
 */
function topologicalSort(issues, links) {
  if (!issues || issues.length === 0) return [];
  if (!links || links.length === 0) return [...issues];

  // Build adjacency: number → set of numbers it depends on
  const deps = new Map();
  const issueSet = new Set(issues.map(i => i.number));

  for (const issue of issues) {
    deps.set(issue.number, new Set());
  }

  for (const link of links) {
    if (link.type !== 'blocked-by') continue;
    const aMatch = String(link.a).match(/#(\d+)/);
    const bMatch = String(link.b).match(/#(\d+)/);
    if (!aMatch || !bMatch) continue;

    const a = parseInt(aMatch[1], 10);
    const b = parseInt(bMatch[1], 10);

    // a is blocked by b → b must come before a
    if (issueSet.has(a) && issueSet.has(b) && deps.has(a)) {
      deps.get(a).add(b);
    }
  }

  // Kahn's algorithm
  const inDegree = new Map();
  for (const issue of issues) {
    inDegree.set(issue.number, deps.get(issue.number).size);
  }

  const queue = [];
  for (const [num, degree] of inDegree) {
    if (degree === 0) queue.push(num);
  }

  // Stable sort: process in original order when degrees are equal
  const issueMap = new Map(issues.map(i => [i.number, i]));
  const sorted = [];

  while (queue.length > 0) {
    // Sort queue by original position for stability
    queue.sort((a, b) => {
      const idxA = issues.findIndex(i => i.number === a);
      const idxB = issues.findIndex(i => i.number === b);
      return idxA - idxB;
    });

    const num = queue.shift();
    sorted.push(issueMap.get(num));

    // Reduce in-degree for dependents
    for (const [dependent, depSet] of deps) {
      if (depSet.has(num)) {
        depSet.delete(num);
        inDegree.set(dependent, inDegree.get(dependent) - 1);
        if (inDegree.get(dependent) === 0) {
          queue.push(dependent);
        }
      }
    }
  }

  // Handle cycles: append remaining issues in original order
  if (sorted.length < issues.length) {
    for (const issue of issues) {
      if (!sorted.includes(issue)) {
        sorted.push(issue);
      }
    }
  }

  return sorted;
}

module.exports = {
  getMgwDir,
  getActiveDir,
  getCompletedDir,
  loadProjectState,
  writeProjectState,
  loadActiveIssue,
  mergeProjectState,
  migrateProjectState,
  resolveActiveMilestoneIndex,
  CHECKPOINT_SCHEMA_VERSION,
  initCheckpoint,
  updateCheckpoint,
  loadCrossRefs,
  VALID_LINK_TYPES,
  parseDependencies,
  storeDependencies,
  topologicalSort,
};
