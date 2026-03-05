'use strict';

/**
 * lib/provider-gemini.cjs -- Gemini CLI provider implementing the MGW provider interface
 *
 * Detects the gemini CLI, checks binary availability, and spawns gemini
 * for AI-dependent command execution. Streams output in real-time
 * by default; supports quiet, dry-run, and model modes.
 *
 * Note: gemini CLI has no --system-prompt-file equivalent. Command file
 * contents are prepended inline as a <system> block before the user prompt.
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** Identifies this provider in ProviderManager registry. */
const PROVIDER_ID = 'gemini';

/**
 * Get the user-level gemini commands directory path.
 * Returns ~/.gemini/commands/mgw/ -- commands are user-installed, not bundled with mgw.
 * @returns {string} Absolute path to ~/.gemini/commands/mgw/
 * @throws {Error} If commands/ directory does not exist
 */
function getCommandsDir() {
  const dir = path.join(os.homedir(), '.gemini', 'commands', 'mgw');
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Commands directory not found at: ${dir}\n` +
      'Run: mgw install-commands --provider gemini\n' +
      'to install MGW commands for the Gemini provider.'
    );
  }
  return dir;
}

/**
 * Assert that the gemini CLI is installed and available.
 * Prints actionable error messages and exits if not available.
 * Note: gemini has no separate auth status subcommand; binary presence is the guard.
 */
function assertAvailable() {
  try {
    execSync('gemini --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(
        'Error: gemini CLI is not installed.\n\n' +
        'Install it with:\n' +
        '  npm install -g @google/gemini-cli\n\n' +
        'Then run:\n' +
        '  gemini auth'
      );
    } else {
      console.error(
        'Error: gemini CLI check failed.\n' +
        'Ensure gemini is installed and on your PATH.'
      );
    }
    process.exit(1);
  }
}

/**
 * Invoke gemini CLI with a command file and user prompt.
 *
 * Because gemini CLI has no --system-prompt-file equivalent, commandFile
 * contents are read and prepended as a <system> block before the user prompt.
 *
 * @param {string} commandFile - Absolute path to the .md system prompt file
 * @param {string} userPrompt - User prompt text to pass as argument
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] - Buffer output instead of streaming (default: false)
 * @param {boolean} [opts.dryRun] - Print what would run without executing (default: false)
 * @param {string} [opts.model] - Gemini model override (e.g. "gemini-2.0-flash")
 * @param {boolean} [opts.json] - Ignored; gemini CLI does not support JSON output format
 * @returns {Promise<{exitCode: number, output: string}>}
 */
function invoke(commandFile, userPrompt, opts) {
  const o = opts || {};

  // Build the effective prompt: prepend commandFile contents as a system block if provided
  let effectivePrompt = userPrompt || 'run';
  if (commandFile) {
    const fileContents = fs.readFileSync(commandFile, 'utf-8');
    effectivePrompt = '<system>\n' + fileContents + '\n</system>\n\n' + effectivePrompt;
  }

  // Build argument list
  const args = ['-p'];

  if (o.model) {
    args.push('--model', o.model);
  }

  // opts.json is intentionally ignored -- gemini CLI has no --output-format json equivalent

  // Add the combined prompt as the positional argument
  args.push(effectivePrompt);

  if (o.dryRun) {
    console.log('Would invoke: gemini ' + args.join(' '));
    return Promise.resolve({ exitCode: 0, output: '' });
  }

  return new Promise((resolve, reject) => {
    const stdio = o.quiet ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'];

    const child = spawn('gemini', args, { stdio });

    let output = '';

    if (o.quiet) {
      child.stdout.on('data', function(chunk) { output += chunk.toString(); });
      child.stderr.on('data', function(chunk) { output += chunk.toString(); });
    }

    child.on('error', function(err) {
      if (err.code === 'ENOENT') {
        reject(new Error('gemini CLI not found. Install with: npm install -g @google/gemini-cli'));
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
 *   PROVIDER_ID {string}  -- identifies this provider (e.g. "gemini")
 *   assertAvailable()     -- synchronous; process.exit(1) on failure
 *   invoke(commandFile, userPrompt, opts) -- Promise<{exitCode, output}>
 *   getCommandsDir()      -- returns absolute path string
 */
module.exports = { PROVIDER_ID: PROVIDER_ID, assertAvailable: assertAvailable, invoke: invoke, getCommandsDir: getCommandsDir };
