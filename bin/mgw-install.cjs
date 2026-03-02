#!/usr/bin/env node
'use strict';

/**
 * bin/mgw-install.cjs — Idempotent slash command installer
 *
 * Runs automatically via npm postinstall. Copies the commands/ source tree
 * into ~/.claude/commands/mgw/ so Claude Code slash commands are available
 * without any manual copy step.
 *
 * Behavior:
 * - If ~/.claude/ does not exist: prints a skip message and exits 0 (non-fatal)
 * - If ~/.claude/ exists: creates ~/.claude/commands/mgw/ and recursively
 *   copies commands/ into it (overwriting existing files — idempotent)
 * - Exits 0 in both cases
 *
 * Dependencies: Node.js built-ins only (path, fs, os)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Source: commands/ directory relative to this script (bin/ → ../commands/)
const sourceDir = path.join(__dirname, '..', 'commands');

// Target: ~/.claude/commands/mgw/
const claudeDir = path.join(os.homedir(), '.claude');
const targetDir = path.join(claudeDir, 'commands', 'mgw');

// Guard: if ~/.claude/ does not exist, skip silently with a clear message
if (!fs.existsSync(claudeDir)) {
  console.log(
    'mgw: ~/.claude/ not found — skipping slash command install ' +
    '(run `node ./bin/mgw-install.cjs` after installing Claude Code)'
  );
  process.exit(0);
}

// Guard: ensure commands/ source exists in this package
if (!fs.existsSync(sourceDir)) {
  console.log('mgw: commands/ source not found — skipping slash command install');
  process.exit(0);
}

/**
 * Recursively copy a directory tree from src to dest.
 * Creates dest and any subdirectories as needed.
 * Overwrites existing files (idempotent).
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @returns {number} Number of files copied
 */
function copyDirRecursive(src, dest) {
  let count = 0;

  // Create destination directory if it doesn't exist
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src);
  for (const entry of entries) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath);
    } else if (stat.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }

  return count;
}

// Perform the install
const fileCount = copyDirRecursive(sourceDir, targetDir);
console.log(`mgw: installed ${fileCount} slash commands to ${targetDir}`);
