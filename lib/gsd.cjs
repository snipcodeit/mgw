'use strict';

/**
 * lib/gsd.cjs — GSD tooling bridge
 *
 * Wrappers for invoking gsd-tools.cjs from within the mgw CLI.
 * Resolves the gsd-tools path from the standard install location.
 */

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

/**
 * Resolve the path to gsd-tools.cjs.
 * Checks the standard location: ~/.claude/get-shit-done/bin/gsd-tools.cjs
 * @returns {string} Absolute path to gsd-tools.cjs
 * @throws {Error} If gsd-tools.cjs is not found
 */
function getGsdToolsPath() {
  const standard = path.join(os.homedir(), '.claude', 'get-shit-done', 'bin', 'gsd-tools.cjs');
  const fs = require('fs');

  if (fs.existsSync(standard)) {
    return standard;
  }

  throw new Error(
    `GSD tools not found at ${standard}.\n` +
    'Ensure the get-shit-done framework is installed at ~/.claude/get-shit-done/'
  );
}

/**
 * Invoke a gsd-tools command and return parsed JSON output.
 * @param {string} command - GSD command name (e.g. "state", "roadmap")
 * @param {string[]} [args] - Additional arguments to pass
 * @returns {*} Parsed JSON output from gsd-tools
 * @throws {Error} If invocation fails or output is not valid JSON
 */
function invokeGsdTool(command, args) {
  const toolPath = getGsdToolsPath();
  const argsStr = Array.isArray(args) ? args.map(a => JSON.stringify(String(a))).join(' ') : '';
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
    // Return raw string if not JSON
    return raw;
  }
}

module.exports = {
  getGsdToolsPath,
  invokeGsdTool
};
