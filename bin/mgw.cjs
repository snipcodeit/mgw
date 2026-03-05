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
 *
 * NOTE: Action handlers use regular `function` (not arrow functions) so that
 * `this.optsWithGlobals()` works correctly in Commander.js v14. Arrow functions
 * don't bind `this` and would break global option inheritance.
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const { ProviderManager } = require('../lib/provider-manager.cjs');
const { log, error, formatJson, verbose } = require('../lib/output.cjs');
const { getActiveDir, getCompletedDir, getMgwDir } = require('../lib/state.cjs');
const { getIssue, listIssues } = require('../lib/github.cjs');
const { createIssuesBrowser } = require('../lib/tui/index.cjs');
const { createSpinner } = require('../lib/spinner.cjs');

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
  .option('--model <model>', 'Claude model override')
  .option('--provider <provider>', 'AI provider override (default: claude)');

// ---------------------------------------------------------------------------
// Helper: run an AI command via claude -p
// ---------------------------------------------------------------------------

/**
 * Pipeline stage labels shown as spinners before handing off to claude.
 * Used by runAiCommand when a stageLabel is provided.
 */
const STAGE_LABELS = {
  run: 'pipeline',
  init: 'init',
  project: 'project',
  milestone: 'milestone',
  issue: 'triage',
  pr: 'create-pr',
  update: 'update',
  next: 'next',
};

/**
 * @param {string} commandName - Name of the command (filename without .md)
 * @param {string} userPrompt - Prompt text to pass to claude
 * @param {object} opts - Merged options from this.optsWithGlobals()
 */
async function runAiCommand(commandName, userPrompt, opts) {
  const provider = ProviderManager.getProvider(opts.provider);
  provider.assertAvailable();
  const cmdFile = path.join(provider.getCommandsDir(), `${commandName}.md`);
  const stageLabel = STAGE_LABELS[commandName] || commandName;

  if (opts.quiet) {
    // Quiet mode: buffer claude output and show a spinner while it runs.
    // The spinner gives real-time feedback when output is suppressed.
    const spinner = createSpinner(`mgw:${stageLabel}`);
    spinner.start();
    let result;
    try {
      result = await provider.invoke(cmdFile, userPrompt, {
        model: opts.model,
        quiet: true,
        dryRun: opts.dryRun,
        json: opts.json,
      });
    } catch (err) {
      spinner.fail(`${stageLabel} failed`);
      throw err;
    }
    if (result.exitCode === 0) {
      spinner.succeed(`${stageLabel} complete`);
    } else {
      spinner.fail(`${stageLabel} failed (exit ${result.exitCode})`);
    }
    if (result.output) {
      process.stdout.write(result.output);
    }
    process.exitCode = result.exitCode;
  } else {
    // Streaming mode: show a brief stage announcement, then hand off to claude.
    // Claude streams its own output — no spinner during streaming to avoid conflicts.
    const spinner = createSpinner(`mgw:${stageLabel}`);
    spinner.start();
    // Give a brief visual indication before handing TTY to claude's streaming output
    await new Promise(r => setTimeout(r, 80));
    spinner.stop();

    const result = await provider.invoke(cmdFile, userPrompt, {
      model: opts.model,
      quiet: false,
      dryRun: opts.dryRun,
      json: opts.json,
    });
    process.exitCode = result.exitCode;
  }
}

// ---------------------------------------------------------------------------
// AI-dependent commands
// Note: All .action() handlers use `function` (not arrow) so `this` is bound
// to the Command instance, enabling this.optsWithGlobals() for global flags.
// ---------------------------------------------------------------------------

/** Pipeline stage sequence shown as a progress header for `mgw run` */
const RUN_PIPELINE_STAGES = [
  'validate',
  'triage',
  'create-worktree',
  'execute-gsd',
  'create-pr',
];

// run <issue-number>
program
  .command('run <issue-number>')
  .description('Run the full pipeline for an issue')
  .option('--quiet', 'buffer output, show summary at end')
  .option('--auto', 'phase chaining: discuss -> plan -> execute')
  .action(async function(issueNumber) {
    const opts = this.optsWithGlobals();
    // Print pipeline stage overview before launching
    if (!opts.json) {
      const { USE_COLOR, COLORS } = require('../lib/output.cjs');
      const dim = USE_COLOR ? COLORS.dim : '';
      const reset = USE_COLOR ? COLORS.reset : '';
      const bold = USE_COLOR ? COLORS.bold : '';
      const stages = RUN_PIPELINE_STAGES.join(` ${dim}→${reset} `);
      process.stdout.write(`${bold}mgw:run${reset} #${issueNumber}  ${dim}${stages}${reset}\n`);
    }
    await runAiCommand('run', issueNumber, opts);
  });

// init
program
  .command('init')
  .description('Bootstrap repo for MGW (state, templates, labels)')
  .action(async function() {
    const opts = this.optsWithGlobals();
    await runAiCommand('init', '', opts);
  });

// project
program
  .command('project')
  .description('Initialize project from template (milestones, issues, ROADMAP)')
  .action(async function() {
    const opts = this.optsWithGlobals();
    await runAiCommand('project', '', opts);
  });

// milestone [number]
program
  .command('milestone [number]')
  .description('Execute milestone issues in dependency order')
  .option('--interactive', 'pause between issues for review')
  .action(async function(number) {
    const opts = this.optsWithGlobals();
    await runAiCommand('milestone', number || '', opts);
  });

// next
program
  .command('next')
  .description('Show next unblocked issue')
  .action(async function() {
    const opts = this.optsWithGlobals();
    await runAiCommand('next', '', opts);
  });

// status [milestone]
program
  .command('status [milestone]')
  .description('Project status dashboard — milestone progress, issue pipeline stages, open PRs')
  .option('--board', 'open GitHub Projects board URL')
  .option('--watch', 'live-refresh mode — redraws dashboard every N seconds')
  .option('--interval <seconds>', 'refresh interval for --watch (default: 30)')
  .action(async function(milestone) {
    const opts = this.optsWithGlobals();
    if (opts.watch && opts.json) {
      error('Error: --watch and --json cannot be used together.');
      process.exit(1);
    }
    const args = [
      milestone || '',
      opts.board    ? '--board'                     : '',
      opts.watch    ? '--watch'                     : '',
      opts.interval ? `--interval ${opts.interval}` : '',
    ].filter(Boolean).join(' ');
    await runAiCommand('status', args, opts);
  });

// issue <number>
program
  .command('issue <number>')
  .description('Triage issue against codebase')
  .action(async function(number) {
    const opts = this.optsWithGlobals();
    await runAiCommand('issue', number, opts);
  });

// update <number> [message]
program
  .command('update <number> [message]')
  .description('Post status comment on issue')
  .action(async function(number, message) {
    const opts = this.optsWithGlobals();
    const userPrompt = [number, message].filter(Boolean).join(' ');
    await runAiCommand('update', userPrompt, opts);
  });

// pr [number]
program
  .command('pr [number]')
  .description('Create PR from GSD artifacts')
  .option('--base <branch>', 'custom base branch')
  .action(async function(number) {
    const opts = this.optsWithGlobals();
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
  .action(async function() {
    const opts = this.optsWithGlobals();

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
            log(`[drift] #${number}: local=${localState}, github=${ghState} -> would archive`);
          }
        } else {
          const completedDir = getCompletedDir();
          if (!fs.existsSync(completedDir)) {
            fs.mkdirSync(completedDir, { recursive: true });
          }
          const dest = path.join(completedDir, file);
          fs.renameSync(filePath, dest);
          results.push({ number, file, status: 'archived', localState, ghState });
          if (!opts.json) {
            log(`[archived] #${number}: ${ghState} on GitHub -> moved to .mgw/completed/`);
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
  .description('Browse open issues — interactive TUI in TTY, static table otherwise')
  .option('--label <label>', 'filter by label')
  .option('--milestone <name>', 'filter by milestone')
  .option('--assignee <user>', 'filter by assignee ("all" = no filter, default: all)', 'all')
  .option('--state <state>', 'issue state: open, closed, all (default: open)', 'open')
  .option('-s, --search <query>', 'pre-populate fuzzy search input')
  .option('--limit <n>', 'max issues to load (default: 50)', '50')
  .action(async function() {
    const opts = this.optsWithGlobals();

    const ghFilters = {
      state: opts.state || 'open',
      limit: parseInt(opts.limit, 10) || 50,
    };

    // Assignee filter — 'all' skips the filter entirely
    if (opts.assignee && opts.assignee !== 'all') {
      ghFilters.assignee = opts.assignee;
    }
    if (opts.label) ghFilters.label = opts.label;
    if (opts.milestone) ghFilters.milestone = opts.milestone;

    let issues;
    try {
      issues = listIssues(ghFilters);
    } catch (err) {
      error('Failed to list issues: ' + err.message);
      process.exitCode = 1;
      return;
    }

    // JSON output — always static, no TUI
    if (opts.json) {
      log(formatJson(issues));
      return;
    }

    if (issues.length === 0) {
      log('No issues found.');
      return;
    }

    // TUI mode: createIssuesBrowser detects TTY and falls back to static table
    await createIssuesBrowser({
      issues,
      onSelect: function(issue) {
        log('\nSelected: #' + issue.number + ' \u2014 ' + issue.title);
        log('Run: mgw issue ' + issue.number);
        process.exit(0);
      },
      onQuit: function() {
        process.exit(0);
      },
      initialQuery: opts.search || '',
      initialFilter: {
        label: opts.label,
        milestone: opts.milestone,
        assignee: opts.assignee || 'all',
      },
    });
  });

// link <ref-a> <ref-b>
program
  .command('link <ref-a> <ref-b>')
  .description('Cross-reference issues/PRs/branches')
  .option('--quiet', 'no GitHub comments')
  .action(async function(refA, refB) {
    const opts = this.optsWithGlobals();

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
      function(l) { return (l.a === refA && l.b === refB) || (l.a === refB && l.b === refA); }
    );

    if (exists) {
      log('Link already exists: ' + refA + ' <-> ' + refB);
      return;
    }

    const entry = { a: refA, b: refB, created: new Date().toISOString() };

    if (opts.dryRun) {
      if (opts.json) {
        log(formatJson(Object.assign({ action: 'would-link' }, entry)));
      } else {
        log('[dry-run] Would link: ' + refA + ' <-> ' + refB);
      }
      return;
    }

    // Add link
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
        const numA = aMatch[1];
        const numB = bMatch[1];
        try {
          execSync(
            'gh issue comment ' + numA + ' --body "Cross-referenced with #' + numB + '"',
            { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' }
          );
          execSync(
            'gh issue comment ' + numB + ' --body "Cross-referenced with #' + numA + '"',
            { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' }
          );
        } catch (err) {
          verbose('GitHub comment failed (non-fatal): ' + err.message, opts);
        }
      }
    }

    if (opts.json) {
      log(formatJson(Object.assign({ action: 'linked' }, entry)));
    } else {
      log('Linked: ' + refA + ' <-> ' + refB);
    }
  });

// help
program
  .command('help')
  .description('Show command reference')
  .action(function() {
    // Parse bundled help.md and extract text between triple-backtick fences
    // in the <process> section. Print directly without calling claude.
    const helpMdPath = path.join(ProviderManager.getProvider().getCommandsDir(), 'help.md');

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

program.parseAsync(process.argv).catch(function(err) {
  error(err.message);
  process.exit(1);
});
