'use strict';

/**
 * lib/provider-opencode.cjs -- OpenCode CLI provider implementing the MGW provider interface
 *
 * Detects the opencode CLI, checks binary availability, and spawns opencode
 * for AI-dependent command execution. Streams output in real-time
 * by default; supports quiet, dry-run, model, and system-prompt modes.
 *
 * OpenCode uses `opencode run <prompt>` as the non-interactive invocation mode.
 * System prompt files are passed via --system-prompt <file> flag.
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** Identifies this provider in ProviderManager registry. */
const PROVIDER_ID = 'opencode';

/**
 * Get the user-level opencode commands directory path.
 * Returns ~/.opencode/commands/mgw/ -- commands are user-installed, not bundled with mgw.
 * @returns {string} Absolute path to ~/.opencode/commands/mgw/
 * @throws {Error} If commands/ directory does not exist
 */
function getCommandsDir() {
  const dir = path.join(os.homedir(), '.opencode', 'commands', 'mgw');
  if (!fs.existsSync(dir)) {
    throw new Error(
      'Commands directory not found at: ' + dir + '\n' +
      'Run: node bin/mgw-install.cjs --provider opencode\n' +
      '(or reinstall the mgw package to trigger postinstall)'
    );
  }
  return dir;
}

/**
 * Assert that the opencode CLI is installed and available.
 * Prints actionable error messages and exits if not available.
 * Note: opencode has no separate auth status subcommand; binary presence is the guard.
 */
function assertAvailable() {
  try {
    execSync('opencode --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(
        'Error: opencode CLI is not installed.\n\n' +
        'Install it with:\n' +
        '  npm install -g opencode-ai\n\n' +
        '(or see https://opencode.ai for installation instructions)'
      );
    } else {
      console.error(
        'Error: opencode CLI check failed.\n' +
        'Ensure opencode is installed and on your PATH.'
      );
    }
    process.exit(1);
  }
}

/**
 * Invoke opencode CLI with a command file and user prompt.
 *
 * Uses `opencode run` as the non-interactive invocation mode.
 * If commandFile is provided, passes it via --system-prompt <file>.
 *
 * @param {string} commandFile - Absolute path to the .md system prompt file
 * @param {string} userPrompt - User prompt text to pass as positional argument
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] - Buffer output instead of streaming (default: false)
 * @param {boolean} [opts.dryRun] - Print what would run without executing (default: false)
 * @param {string} [opts.model] - Model override (e.g. "gpt-4o")
 * @param {boolean} [opts.json] - Ignored; opencode CLI does not support JSON output format
 * @returns {Promise<{exitCode: number, output: string}>}
 */
function invoke(commandFile, userPrompt, opts) {
  const o = opts || {};

  // Build argument list: opencode run [options] <prompt>
  const args = ['run'];

  if (commandFile) {
    args.push('--system-prompt', commandFile);
  }

  if (o.model) {
    args.push('--model', o.model);
  }

  // opts.json is intentionally ignored -- opencode CLI has no --output-format json equivalent

  // Add the user prompt as the final positional argument
  args.push(userPrompt || 'run');

  if (o.dryRun) {
    console.log('Would invoke: opencode ' + args.join(' '));
    return Promise.resolve({ exitCode: 0, output: '' });
  }

  return new Promise(function(resolve, reject) {
    const stdio = o.quiet ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'];

    const child = spawn('opencode', args, { stdio: stdio });

    let output = '';

    if (o.quiet) {
      child.stdout.on('data', function(chunk) { output += chunk.toString(); });
      child.stderr.on('data', function(chunk) { output += chunk.toString(); });
    }

    child.on('error', function(err) {
      if (err.code === 'ENOENT') {
        reject(new Error('opencode CLI not found. See https://opencode.ai for installation instructions.'));
      } else {
        reject(err);
      }
    });

    child.on('close', function(code) {
      resolve({ exitCode: code || 0, output: output });
    });
  });
}

/**
 * Provider interface contract. Every lib/provider-*.cjs must export:
 *   PROVIDER_ID {string}  -- identifies this provider (e.g. "opencode")
 *   assertAvailable()     -- synchronous; process.exit(1) on failure
 *   invoke(commandFile, userPrompt, opts) -- Promise<{exitCode, output}>
 *   getCommandsDir()      -- returns absolute path string
 */
module.exports = { PROVIDER_ID: PROVIDER_ID, assertAvailable: assertAvailable, invoke: invoke, getCommandsDir: getCommandsDir };
