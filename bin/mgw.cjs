#!/usr/bin/env node
'use strict';

/**
 * bin/mgw.cjs — MGW CLI entry point
 *
 * Registers all 12 subcommands with Commander.js.
 * AI-dependent commands (run, init, project, milestone, next, issue, update, pr)
 * call assertClaudeAvailable() then delegate to claude -p with bundled .md files.
 * Non-AI commands (sync, issues, link, help) call lib/ modules directly and work
 * without claude installed.
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { assertClaudeAvailable, invokeClaude, getCommandsDir } = require('../lib/claude.cjs');
const { log, error, formatJson, verbose, debug, statusLine, IS_TTY } = require('../lib/output.cjs');
const { loadProjectState, loadActiveIssue, getActiveDir, getCompletedDir, getMgwDir } = require('../lib/state.cjs');
const { getRepo, getIssue, listIssues, getRateLimit } = require('../lib/github.cjs');

const pkg = require('../package.json');

// ---------------------------------------------------------------------------
// Program setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('mgw')
  .description('GitHub issue pipeline automation — Day 1 idea to Go Live')
  .version(pkg.version)
  .option('--dry-run', 'show what would happen without executing')
  .option('--json', 'output structured JSON')
  .option('-v, --verbose', 'show API calls and file writes')
  .option('--debug', 'full payloads and timings')
  .option('--model <model>', 'Claude model override');

// ---------------------------------------------------------------------------
// Helper: run an AI command via claude -p
// ---------------------------------------------------------------------------

/**
 * @param {string} commandName - Name of the command (filename without .md)
 * @param {string} userPrompt - Prompt text to pass to claude
 * @param {object} opts - Merged options from optsWithGlobals()
 */
async function runAiCommand(commandName, userPrompt, opts) {
  assertClaudeAvailable();
  const cmdFile = path.join(getCommandsDir(), `${commandName}.md`);
  const result = await invokeClaude(cmdFile, userPrompt, {
    model: opts.model,
    quiet: opts.quiet,
    dryRun: opts.dryRun,
    json: opts.json,
  });
  process.exitCode = result.exitCode;
}

// ---------------------------------------------------------------------------
// AI-dependent commands
// ---------------------------------------------------------------------------

// run <issue-number>
program
  .command('run <issue-number>')
  .description('Run the full pipeline for an issue')
  .option('--quiet', 'buffer output, show summary at end')
  .option('--auto', 'phase chaining: discuss -> plan -> execute')
  .action(async (issueNumber, options) => {
    const opts = options.optsWithGlobals();
    await runAiCommand('run', issueNumber, opts);
  });

// init
program
  .command('init')
  .description('Bootstrap repo for MGW (state, templates, labels)')
  .action(async (options) => {
    const opts = options.optsWithGlobals();
    await runAiCommand('init', '', opts);
  });

// project
program
  .command('project')
  .description('Initialize project from template (milestones, issues, ROADMAP)')
  .action(async (options) => {
    const opts = options.optsWithGlobals();
    await runAiCommand('project', '', opts);
  });

// milestone [number]
program
  .command('milestone [number]')
  .description('Execute milestone issues in dependency order')
  .option('--interactive', 'pause between issues for review')
  .action(async (number, options) => {
    const opts = options.optsWithGlobals();
    await runAiCommand('milestone', number || '', opts);
  });

// next
program
  .command('next')
  .description('Show next unblocked issue')
  .action(async (options) => {
    const opts = options.optsWithGlobals();
    await runAiCommand('next', '', opts);
  });

// issue <number>
program
  .command('issue <number>')
  .description('Triage issue against codebase')
  .action(async (number, options) => {
    const opts = options.optsWithGlobals();
    await runAiCommand('issue', number, opts);
  });

// update <number> [message]
program
  .command('update <number> [message]')
  .description('Post status comment on issue')
  .action(async (number, message, options) => {
    const opts = options.optsWithGlobals();
    const userPrompt = [number, message].filter(Boolean).join(' ');
    await runAiCommand('update', userPrompt, opts);
  });

// pr [number]
program
  .command('pr [number]')
  .description('Create PR from GSD artifacts')
  .option('--base <branch>', 'custom base branch')
  .action(async (number, options) => {
    const opts = options.optsWithGlobals();
    const parts = [number, opts.base ? '--base ' + opts.base : ''].filter(Boolean);
    await runAiCommand('pr', parts.join(' '), opts);
  });

// ---------------------------------------------------------------------------
// Non-AI commands (work without claude installed)
// ---------------------------------------------------------------------------

// sync
program
  .command('sync')
  .description('Reconcile .mgw/ state with GitHub')
  .action(async (options) => {
    const opts = options.optsWithGlobals();

    const activeDir = getActiveDir();

    if (!fs.existsSync(activeDir)) {
      if (opts.json) {
        log(formatJson({ status: 'no-active-issues', drifted: [], archived: [] }));
      } else {
        log('No active issues found in .mgw/active/');
      }
      return;
    }

    let files;
    try {
      files = fs.readdirSync(activeDir).filter(f => f.endsWith('.json'));
    } catch (err) {
      error('Failed to read active directory: ' + err.message);
      process.exitCode = 1;
      return;
    }

    if (files.length === 0) {
      if (opts.json) {
        log(formatJson({ status: 'no-active-issues', drifted: [], archived: [] }));
      } else {
        log('No active issues in .mgw/active/');
      }
      return;
    }

    const results = [];

    for (const file of files) {
      const filePath = path.join(activeDir, file);
      let issueData;
      try {
        issueData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        verbose(`Skipping unreadable file: ${file}`, opts);
        continue;
      }

      const number = issueData.number;
      if (!number) {
        verbose(`Skipping file with no issue number: ${file}`, opts);
        continue;
      }

      let ghIssue;
      try {
        ghIssue = getIssue(number);
      } catch (err) {
        error(`Failed to fetch issue #${number} from GitHub: ${err.message}`);
        results.push({ number, file, status: 'error', error: err.message });
        continue;
      }

      const localState = issueData.state || 'unknown';
      const ghState = ghIssue.state;
      const drifted = localState.toLowerCase() !== ghState.toLowerCase();

      if (drifted) {
        if (opts.dryRun) {
          results.push({ number, file, status: 'drift', localState, ghState, action: 'would-archive' });
          if (!opts.json) {
            log(`[drift] #${number}: local=${localState}, github=${ghState} → would archive`);
          }
        } else {
          // Archive: move to completed/
          const completedDir = getCompletedDir();
          if (!fs.existsSync(completedDir)) {
            fs.mkdirSync(completedDir, { recursive: true });
          }
          const dest = path.join(completedDir, file);
          fs.renameSync(filePath, dest);
          results.push({ number, file, status: 'archived', localState, ghState });
          if (!opts.json) {
            log(`[archived] #${number}: ${ghState} on GitHub → moved to .mgw/completed/`);
          }
        }
      } else {
        results.push({ number, file, status: 'ok', state: ghState });
        if (!opts.json) {
          verbose(`[ok] #${number}: ${ghState}`, opts);
        }
      }
    }

    if (opts.json) {
      const drifted = results.filter(r => r.status === 'drift' || r.status === 'archived');
      log(formatJson({ status: 'complete', drifted, all: results }));
    } else if (!opts.dryRun) {
      const archived = results.filter(r => r.status === 'archived').length;
      const ok = results.filter(r => r.status === 'ok').length;
      log(`sync complete: ${ok} up-to-date, ${archived} archived`);
    }
  });

// issues [filters...]
program
  .command('issues [filters...]')
  .description('List open issues')
  .option('--label <label>', 'filter by label')
  .option('--milestone <name>', 'filter by milestone')
  .option('--assignee <user>', 'filter by assignee (default: @me)', '@me')
  .option('--state <state>', 'issue state: open, closed, all (default: open)', 'open')
  .action(async (filters, options) => {
    const opts = options.optsWithGlobals();

    const ghFilters = {
      label: opts.label,
      milestone: opts.milestone,
      assignee: opts.assignee || '@me',
      state: opts.state || 'open',
    };

    // Remove undefined filters
    Object.keys(ghFilters).forEach(k => {
      if (ghFilters[k] === undefined) delete ghFilters[k];
    });

    let issues;
    try {
      issues = listIssues(ghFilters);
    } catch (err) {
      error('Failed to list issues: ' + err.message);
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      log(formatJson(issues));
      return;
    }

    if (issues.length === 0) {
      log('No issues found.');
      return;
    }

    // Table output
    const pad = (s, n) => String(s).padEnd(n);
    log(pad('#', 6) + pad('Title', 60) + pad('State', 10) + 'Labels');
    log('─'.repeat(90));
    for (const issue of issues) {
      const labels = (issue.labels || []).map(l => l.name || l).join(', ');
      log(
        pad(issue.number, 6) +
        pad((issue.title || '').substring(0, 58), 60) +
        pad(issue.state || '', 10) +
        labels
      );
    }
    log(`\n${issues.length} issue(s)`);
  });

// link <ref-a> <ref-b>
program
  .command('link <ref-a> <ref-b>')
  .description('Cross-reference issues/PRs/branches')
  .option('--quiet', 'no GitHub comments')
  .action(async (refA, refB, options) => {
    const opts = options.optsWithGlobals();

    const mgwDir = getMgwDir();
    const crossRefsPath = path.join(mgwDir, 'cross-refs.json');

    // Load existing cross-refs
    let crossRefs = { links: [] };
    if (fs.existsSync(crossRefsPath)) {
      try {
        crossRefs = JSON.parse(fs.readFileSync(crossRefsPath, 'utf-8'));
        if (!Array.isArray(crossRefs.links)) crossRefs.links = [];
      } catch {
        crossRefs = { links: [] };
      }
    }

    // Check for duplicate
    const exists = crossRefs.links.some(
      l => (l.a === refA && l.b === refB) || (l.a === refB && l.b === refA)
    );

    if (exists) {
      log(`Link already exists: ${refA} <-> ${refB}`);
      return;
    }

    const entry = { a: refA, b: refB, created: new Date().toISOString() };

    if (opts.dryRun) {
      if (opts.json) {
        log(formatJson({ action: 'would-link', ...entry }));
      } else {
        log(`[dry-run] Would link: ${refA} <-> ${refB}`);
      }
      return;
    }

    // Add bidirectional link
    crossRefs.links.push(entry);

    // Ensure .mgw/ directory exists
    if (!fs.existsSync(mgwDir)) {
      fs.mkdirSync(mgwDir, { recursive: true });
    }

    fs.writeFileSync(crossRefsPath, JSON.stringify(crossRefs, null, 2), 'utf-8');

    if (!opts.quiet) {
      // Post GitHub comments if refs look like issue numbers
      const issuePattern = /^#?(\d+)$/;
      const aMatch = refA.match(issuePattern);
      const bMatch = refB.match(issuePattern);

      if (aMatch && bMatch) {
        const { execSync } = require('child_process');
        const numA = aMatch[1];
        const numB = bMatch[1];
        try {
          execSync(
            `gh issue comment ${numA} --body "Cross-referenced with #${numB}"`,
            { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' }
          );
          execSync(
            `gh issue comment ${numB} --body "Cross-referenced with #${numA}"`,
            { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' }
          );
        } catch (err) {
          verbose(`GitHub comment failed (non-fatal): ${err.message}`, opts);
        }
      }
    }

    if (opts.json) {
      log(formatJson({ action: 'linked', ...entry }));
    } else {
      log(`Linked: ${refA} <-> ${refB}`);
    }
  });

// help
program
  .command('help')
  .description('Show command reference')
  .action(() => {
    // Parse bundled help.md and extract text between triple-backtick fences
    // in the <process> section. Print directly without calling claude.
    const helpMdPath = path.join(getCommandsDir(), 'help.md');

    let helpText;
    try {
      const raw = fs.readFileSync(helpMdPath, 'utf-8');
      // Extract content between first ``` and last ```
      const fenceStart = raw.indexOf('```\n');
      const fenceEnd = raw.lastIndexOf('\n```');
      if (fenceStart !== -1 && fenceEnd !== -1 && fenceEnd > fenceStart) {
        helpText = raw.substring(fenceStart + 4, fenceEnd);
      } else {
        helpText = raw;
      }
    } catch (err) {
      error('Failed to load help text: ' + err.message);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(helpText + '\n');
  });

// ---------------------------------------------------------------------------
// Parse and execute
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err) => {
  error(err.message);
  process.exit(1);
});
