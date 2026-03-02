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
 * @returns {object|null} The (possibly updated) project state, or null if no state exists
 */
function migrateProjectState() {
  const existing = loadProjectState();
  if (!existing) return null;

  let changed = false;

  // Add active_gsd_milestone if missing (replaces current_milestone in new schema)
  if (!existing.hasOwnProperty('active_gsd_milestone')) {
    existing.active_gsd_milestone = null;
    changed = true;
  }

  // Add new fields to each milestone if missing
  for (const m of (existing.milestones || [])) {
    if (!m.hasOwnProperty('gsd_milestone_id')) {
      m.gsd_milestone_id = null;
      changed = true;
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
    } catch {
      entries = [];
    }

    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(activeDir, file);
      let issueState;
      try {
        issueState = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        continue; // Skip unreadable/invalid files
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

      if (issueChanged) {
        try {
          fs.writeFileSync(filePath, JSON.stringify(issueState, null, 2), 'utf-8');
        } catch {
          // Non-fatal: migration is best-effort
        }
      }
    }
  }

  return existing;
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

module.exports = {
  getMgwDir,
  getActiveDir,
  getCompletedDir,
  loadProjectState,
  writeProjectState,
  loadActiveIssue,
  mergeProjectState,
  migrateProjectState,
  resolveActiveMilestoneIndex
};
