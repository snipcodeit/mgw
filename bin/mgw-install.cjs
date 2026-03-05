#!/usr/bin/env node
'use strict';

/**
 * bin/mgw-install.cjs — Multi-CLI-aware idempotent slash command installer
 *
 * Runs automatically via npm postinstall. Detects the active AI CLI
 * (claude, gemini, or opencode — in priority order) and copies the
 * commands/ source tree into the correct provider-specific commands
 * directory so slash commands are available without any manual copy step.
 *
 * Behavior:
 * - Auto-detects first available CLI binary (claude > gemini > opencode)
 * - --provider=<id> flag overrides auto-detection
 * - If no AI CLI is found on PATH: prints skip message and exits 0 (non-fatal)
 * - If provider's base dir does not exist: prints skip message and exits 0
 * - If previously installed provider differs: removes old install dir first
 * - Idempotent: running twice for the same provider is safe
 * - Tracks installed provider in ~/.mgw-install-state.json
 *
 * Dependencies: Node.js built-ins only (path, fs, os, child_process)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// Source: commands/ directory relative to this script (bin/ → ../commands/)
const sourceDir = path.join(__dirname, '..', 'commands');

// State file for tracking installed provider across runs
const statePath = path.join(os.homedir(), '.mgw-install-state.json');

// Provider target directories — where each CLI expects slash commands
const PROVIDER_TARGETS = {
  claude:   path.join(os.homedir(), '.claude', 'commands', 'mgw'),
  gemini:   path.join(os.homedir(), '.gemini', 'commands', 'mgw'),
  opencode: path.join(os.homedir(), '.opencode', 'commands', 'mgw'),
};

// Valid provider IDs (order is also detection priority)
const VALID_PROVIDERS = ['claude', 'gemini', 'opencode'];

/**
 * Parse --provider flag from process.argv.
 * Handles both --provider=claude and --provider claude forms.
 * @returns {string|null} provider ID string or null if not specified
 */
function parseProviderFlag() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--provider=')) {
      return args[i].split('=')[1] || null;
    }
    if (args[i] === '--provider' && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return null;
}

/**
 * Detect the active AI CLI by trying binaries in priority order.
 * @param {string|null} forcedProvider - If set, skip detection and return this value.
 * @returns {string|null} Provider ID of the first found binary, or null if none found.
 */
function detectProvider(forcedProvider) {
  if (forcedProvider) {
    return forcedProvider;
  }

  for (const id of VALID_PROVIDERS) {
    try {
      execSync(id + ' --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return id;
    } catch (_) {
      // Binary not found or not working — try next
    }
  }

  return null;
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

// --- Main ---

// Guard: ensure commands/ source exists in this package
if (!fs.existsSync(sourceDir)) {
  console.log('mgw: commands/ source not found — skipping slash command install');
  process.exit(0);
}

// Parse and validate --provider flag
const flagProvider = parseProviderFlag();
if (flagProvider !== null && !VALID_PROVIDERS.includes(flagProvider)) {
  console.error(
    'mgw: unknown provider "' + flagProvider + '" — valid options: ' + VALID_PROVIDERS.join(', ')
  );
  process.exit(1);
}

// Detect or use forced provider
const detectedProvider = detectProvider(flagProvider);

if (detectedProvider === null) {
  console.log('mgw: no AI CLI found (claude/gemini/opencode) — skipping slash command install');
  process.exit(0);
}

// Parent dir guard: provider's base config directory must already exist
// (i.e. the user has run the CLI at least once to initialize it).
// This MUST run before old-dir cleanup — otherwise switching to a provider
// whose home dir doesn't exist would delete old commands and install nothing.
const targetDir = PROVIDER_TARGETS[detectedProvider];
const providerHomeDir = path.join(os.homedir(), '.' + detectedProvider);

if (!fs.existsSync(providerHomeDir)) {
  console.log(
    'mgw: ~/.' + detectedProvider + '/ not found — skipping slash command install ' +
    '(run the CLI once to initialize it)'
  );
  process.exit(0);
}

// Old-dir cleanup: if previously installed provider differs, remove old install.
// Safe to run here — we've already confirmed the new provider's home dir exists.
if (fs.existsSync(statePath)) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (state.provider && state.provider !== detectedProvider && PROVIDER_TARGETS[state.provider]) {
      const oldDir = PROVIDER_TARGETS[state.provider];
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  } catch (_) {
    // Corrupt or unreadable state file — ignore and continue
  }
}

// Perform the install
const fileCount = copyDirRecursive(sourceDir, targetDir);

// Write state file
fs.writeFileSync(statePath, JSON.stringify({ provider: detectedProvider }, null, 2));

console.log('mgw: detected ' + detectedProvider + ' CLI — installed ' + fileCount + ' slash commands to ' + targetDir);
