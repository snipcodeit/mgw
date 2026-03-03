'use strict';

/**
 * lib/config-wizard.cjs — Interactive config wizard for mgw:init
 *
 * Prompts the user for first-time setup preferences and writes
 * them to .mgw/config.json. Safe to skip via --no-config flag
 * or if .mgw/config.json already exists.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

/**
 * Detect the authenticated GitHub username via gh CLI.
 * Returns null if detection fails.
 * @returns {string|null}
 */
function detectGitHubUsername() {
  try {
    const result = execSync('gh api user -q .login', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Prompt the user with a question and a default value.
 * Returns the user's answer, or the default if they press Enter.
 * @param {readline.Interface} rl
 * @param {string} question
 * @param {string} defaultValue
 * @returns {Promise<string>}
 */
function prompt(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt the user to choose from a numbered list of options.
 * Returns the selected value string.
 * @param {readline.Interface} rl
 * @param {string} question
 * @param {Array<{label: string, value: string}>} choices
 * @param {string} defaultValue - value string of the default choice
 * @returns {Promise<string>}
 */
async function promptChoice(rl, question, choices, defaultValue) {
  const defaultIndex = choices.findIndex(c => c.value === defaultValue);
  const defaultNum = defaultIndex >= 0 ? defaultIndex + 1 : 1;

  process.stdout.write(`\n${question}\n`);
  choices.forEach((c, i) => {
    const marker = c.value === defaultValue ? ' (default)' : '';
    process.stdout.write(`  ${i + 1}. ${c.label}${marker}\n`);
  });

  const answer = await prompt(rl, 'Choose', String(defaultNum));
  const num = parseInt(answer, 10);
  if (num >= 1 && num <= choices.length) {
    return choices[num - 1].value;
  }
  return defaultValue;
}

/**
 * Run the interactive config wizard.
 *
 * @param {string} mgwDir - Absolute path to the .mgw/ directory
 * @returns {Promise<object>} The config object that was written
 */
async function runWizard(mgwDir) {
  if (!process.stdin.isTTY) {
    throw new Error('runWizard: stdin is not a TTY — cannot prompt interactively');
  }
  const configPath = path.join(mgwDir, 'config.json');

  const detectedUsername = detectGitHubUsername();

  process.stdout.write('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stdout.write(' MGW ► CONFIG WIZARD\n');
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stdout.write(' Set your preferences. Press Enter to accept defaults.\n');
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdout.isTTY,
  });

  try {
    // 1. GitHub username
    const github_username = await prompt(
      rl,
      'GitHub username',
      detectedUsername || ''
    );

    // 2. Default issue state filter
    const default_issue_state = await promptChoice(
      rl,
      'Default issue state filter:',
      [
        { label: 'open — show only open issues', value: 'open' },
        { label: 'all  — show open and closed issues', value: 'all' },
      ],
      'open'
    );

    // 3. Default issue limit
    const limitChoice = await promptChoice(
      rl,
      'Default issue limit per fetch:',
      [
        { label: '10  — quick scan', value: '10' },
        { label: '25  — standard (recommended)', value: '25' },
        { label: '50  — deep list', value: '50' },
      ],
      '25'
    );
    const default_issue_limit = parseInt(limitChoice, 10);

    // 4. Default assignee filter
    const default_assignee = await promptChoice(
      rl,
      'Default assignee filter:',
      [
        { label: 'me  — show only issues assigned to you', value: 'me' },
        { label: 'all — show issues regardless of assignee', value: 'all' },
      ],
      'me'
    );

    rl.close();

    const config = {
      github_username: github_username || null,
      default_issue_state,
      default_issue_limit,
      default_assignee,
      created_at: new Date().toISOString(),
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    process.stdout.write('\n  .mgw/config.json   written\n\n');

    return config;
  } catch (err) {
    rl.close();
    throw err;
  }
}

/**
 * Check whether the wizard should run.
 *
 * Returns false (skip) when:
 *   - --no-config flag is present in argv
 *   - process.stdin is not a TTY (e.g. piped/automated execution)
 *   - .mgw/config.json already exists
 *
 * @param {string} mgwDir - Absolute path to the .mgw/ directory
 * @param {string[]} [argv] - Argument list to inspect (defaults to process.argv)
 * @returns {boolean} true if the wizard should run
 */
function shouldRunWizard(mgwDir, argv) {
  const args = argv || process.argv;
  if (args.includes('--no-config')) return false;
  if (!process.stdin.isTTY) return false;
  const configPath = path.join(mgwDir, 'config.json');
  if (fs.existsSync(configPath)) return false;
  return true;
}

module.exports = { runWizard, shouldRunWizard, detectGitHubUsername };
