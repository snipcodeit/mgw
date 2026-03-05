'use strict';

/**
 * lib/provider-claude.cjs -- Claude CLI provider implementing the MGW provider interface
 *
 * Detects the claude CLI, checks auth status, and spawns claude
 * for AI-dependent command execution. Streams output in real-time
 * by default; supports quiet, dry-run, model, and JSON modes.
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ClaudeNotAvailableError, TimeoutError } = require('./errors.cjs');

/** Identifies this provider in ProviderManager registry. */
const PROVIDER_ID = 'claude';

/**
 * Get the bundled commands/ directory path.
 * Resolves relative to this file's location: ../commands/ from lib/.
 * @returns {string} Absolute path to commands/
 * @throws {Error} If commands/ directory cannot be found
 */
function getCommandsDir() {
  const dir = path.join(__dirname, '..', 'commands');
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Commands directory not found at: ${dir}\n` +
      'This may indicate a corrupted installation. Try reinstalling mgw.'
    );
  }
  return dir;
}

/**
 * Assert that the claude CLI is installed and authenticated.
 * Throws ClaudeNotAvailableError if not available — callers handle exit.
 * @throws {ClaudeNotAvailableError}
 */
function assertAvailable() {
  // Check if claude binary exists
  try {
    execSync('claude --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch (err) {
    if (err.killed) {
      throw new TimeoutError(
        'claude --version timed out after 10s',
        { timeoutMs: 10_000, operation: 'claude --version' }
      );
    }
    if (err.code === 'ENOENT') {
      throw new ClaudeNotAvailableError(
        'claude CLI is not installed.\n\n' +
        'Install it with:\n' +
        '  npm install -g @anthropic-ai/claude-code\n\n' +
        'Then run:\n' +
        '  claude login',
        { reason: 'not-installed' }
      );
    }
    throw new ClaudeNotAvailableError(
      'claude CLI check failed.\n' +
      'Ensure claude is installed and on your PATH.',
      { reason: 'check-failed', cause: err }
    );
  }

  // Check auth status
  try {
    execSync('claude auth status', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch (err) {
    if (err.killed) {
      throw new TimeoutError(
        'claude auth status timed out after 10s',
        { timeoutMs: 10_000, operation: 'claude auth status' }
      );
    }
    throw new ClaudeNotAvailableError(
      'claude CLI is not authenticated.\n\n' +
      'Run:\n' +
      '  claude login\n\n' +
      'Then retry your command.',
      { reason: 'not-authenticated' }
    );
  }
}

/**
 * Invoke claude CLI with a command file and user prompt.
 *
 * @param {string} commandFile - Absolute path to the .md system prompt file
 * @param {string} userPrompt - User prompt text to pass as argument
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] - Buffer output instead of streaming (default: false)
 * @param {boolean} [opts.dryRun] - Print what would run without executing (default: false)
 * @param {string} [opts.model] - Claude model override (e.g. "claude-opus-4-6")
 * @param {boolean} [opts.json] - Request JSON output format (default: false)
 * @returns {Promise<{exitCode: number, output: string}>}
 */
function invoke(commandFile, userPrompt, opts) {
  const o = opts || {};

  // Build argument list
  const args = ['-p'];

  if (commandFile) {
    args.push('--system-prompt-file', commandFile);
  }

  if (o.model) {
    args.push('--model', o.model);
  }

  if (o.json) {
    args.push('--output-format', 'json');
  }

  // Add user prompt -- claude -p requires a non-empty positional argument.
  // Fall back to 'run' when no user input is needed (e.g. mgw status, mgw next).
  args.push(userPrompt || 'run');

  if (o.dryRun) {
    console.log('Would invoke: claude ' + args.join(' '));
    return Promise.resolve({ exitCode: 0, output: '' });
  }

  return new Promise((resolve, reject) => {
    const stdio = o.quiet ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'];

    const child = spawn('claude', args, { stdio });

    let output = '';

    // Forward SIGINT to child so Ctrl-C propagates cleanly
    const sigintHandler = () => { child.kill('SIGINT'); };
    process.on('SIGINT', sigintHandler);

    if (o.quiet) {
      child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
    }

    child.on('error', err => {
      process.removeListener('SIGINT', sigintHandler);
      if (err.code === 'ENOENT') {
        reject(new ClaudeNotAvailableError(
          'claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code',
          { reason: 'not-installed' }
        ));
      } else {
        reject(err);
      }
    });

    child.on('close', code => {
      process.removeListener('SIGINT', sigintHandler);
      resolve({ exitCode: code || 0, output });
    });
  });
}

/**
 * Provider interface contract. Every lib/provider-*.cjs must export:
 *   PROVIDER_ID {string}  -- identifies this provider (e.g. "claude")
 *   assertAvailable()     -- synchronous; process.exit(1) on failure
 *   invoke(commandFile, userPrompt, opts) -- Promise<{exitCode, output}>
 *   getCommandsDir()      -- returns absolute path string
 */
module.exports = { PROVIDER_ID, assertAvailable, invoke, getCommandsDir };
