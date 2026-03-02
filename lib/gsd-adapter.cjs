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
 *   getTimestamp()          → current-timestamp --raw
 *   generateSlug(title)     → generate-slug <title> --raw
 *   resolveModel(agentType) → resolve-model <agentType> --raw
 *   historyDigest()         → history-digest --raw
 *   roadmapAnalyze()        → roadmap analyze
 */

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to gsd-tools.cjs.
 * Checks the standard install location: ~/.claude/get-shit-done/bin/gsd-tools.cjs
 *
 * @returns {string} Absolute path to gsd-tools.cjs
 * @throws {Error} If gsd-tools.cjs is not found at the standard location
 */
function getGsdToolsPath() {
  const standard = path.join(
    os.homedir(),
    '.claude',
    'get-shit-done',
    'bin',
    'gsd-tools.cjs'
  );

  if (fs.existsSync(standard)) {
    return standard;
  }

  throw new Error(
    `GSD tools not found at ${standard}.\n` +
    'Ensure the get-shit-done framework is installed at ~/.claude/get-shit-done/'
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
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.trim() : '';
    throw new Error(
      `GSD tool command failed: ${command}\n` +
      (stderr ? `stderr: ${stderr}` : `exit code: ${err.status}`)
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
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getGsdToolsPath,
  invokeGsdTool,
  getTimestamp,
  generateSlug,
  resolveModel,
  historyDigest,
  roadmapAnalyze
};
