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

module.exports = {
  getMgwDir,
  getActiveDir,
  getCompletedDir,
  loadProjectState,
  writeProjectState,
  loadActiveIssue
};
