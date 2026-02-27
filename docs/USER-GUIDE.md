# MGW User Guide

> From installed to productive in one document.

This guide covers everything you need to know after running `/mgw:help` for the first time: how MGW stores state, what every configuration option does, how to customize templates, how to use advanced flags, how dependency ordering works, and how to recover when things go wrong.

For architecture and design decisions, see [ARCHITECTURE.md](./ARCHITECTURE.md).
For contributing code, see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Table of Contents

- [Installation and Setup](#installation-and-setup)
- [The .mgw/ Directory](#the-mgw-directory)
- [Configuration Reference](#configuration-reference)
- [Command Reference](#command-reference)
- [Workflow Walkthrough](#workflow-walkthrough)
- [GSD Routes Explained](#gsd-routes-explained)
- [Dependency Ordering](#dependency-ordering)
- [Worktree Isolation](#worktree-isolation)
- [Status Comments and PR Descriptions](#status-comments-and-pr-descriptions)
- [Cross-References](#cross-references)
- [Advanced Usage](#advanced-usage)
- [Recovering from Failures](#recovering-from-failures)
- [Using MGW with Existing GSD Projects](#using-mgw-with-existing-gsd-projects)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## Installation and Setup

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | >= 18 | Runtime for the CLI |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) | Latest | AI execution engine |
| [GitHub CLI](https://cli.github.com/) (`gh`) | Latest | GitHub API access |
| [Get Shit Done](https://github.com/glittercowboy/get-shit-done) (GSD) | Latest | Planning and execution framework |

Verify your prerequisites:

```bash
node --version          # >= 18.0.0
claude --version        # Claude Code CLI
gh auth status          # Must be authenticated
ls ~/.claude/get-shit-done/bin/gsd-tools.cjs  # GSD installed
```

### Option 1: Full Install (CLI + Slash Commands)

```bash
git clone https://github.com/snipcodeit/mgw.git
cd mgw
npm install && npm run build
npm link

# Deploy slash commands to Claude Code
mkdir -p ~/.claude/commands/mgw/workflows
cp -r .claude/commands/mgw/* ~/.claude/commands/mgw/
```

After linking, the `mgw` CLI is available globally:

```bash
mgw --version
mgw --help
```

### Option 2: Slash Commands Only (No CLI)

If you only want the Claude Code integration without the standalone CLI:

```bash
git clone https://github.com/snipcodeit/mgw.git
mkdir -p ~/.claude/commands/mgw/workflows
cp -r mgw/.claude/commands/mgw/* ~/.claude/commands/mgw/
```

### Option 3: Per-Project Slash Commands

To scope MGW commands to a specific project instead of installing globally:

```bash
cd your-project
mkdir -p .claude/commands/mgw/workflows
cp -r /path/to/mgw/.claude/commands/mgw/* .claude/commands/mgw/
```

### Verify Installation

```bash
# CLI verification
mgw --version

# Slash command verification
ls ~/.claude/commands/mgw/
# Expected: ask.md help.md init.md issue.md issues.md link.md
#           milestone.md next.md pr.md project.md review.md
#           run.md status.md sync.md update.md workflows/
```

Then inside Claude Code:

```
/mgw:help
```

### Bootstrap a Repository

Before using MGW in a repository, run the one-time setup:

```
/mgw:init
```

This creates:
- `.mgw/` state directory (gitignored)
- `.mgw/cross-refs.json` for tracking links between issues, PRs, and branches
- GitHub issue templates (bug report + enhancement)
- GitHub PR template
- Standard labels on the repository
- `.gitignore` entries for `.mgw/` and `.worktrees/`

The init command is safe to re-run. It skips anything that already exists.

---

## The .mgw/ Directory

MGW stores all pipeline state locally in `.mgw/` at your repository root. This directory is gitignored and per-developer -- each person working on the repo has their own copy.

```
.mgw/
  config.json          User preferences (GitHub username, default filters)
  project.json         Project structure: milestones, phases, issues, pipeline stages
  active/              In-progress issue pipelines
    42-fix-auth.json   Per-issue state: triage results, pipeline stage, artifacts
    71-user-reg.json
  completed/           Archived state files (moved here after PR merge)
  cross-refs.json      Bidirectional links: issue <-> PR <-> branch
```

### project.json

Created by `/mgw:project`. Contains the full project structure:

```json
{
  "project": {
    "name": "my-app",
    "description": "A web application for ...",
    "repo": "owner/my-app",
    "template": "web-app",
    "created": "2026-02-26T10:00:00Z",
    "project_board": {
      "number": 1,
      "url": "https://github.com/orgs/owner/projects/1"
    }
  },
  "milestones": [
    {
      "github_number": 1,
      "github_id": 12345,
      "name": "v1 -- Core Features",
      "issues": [
        {
          "github_number": 10,
          "title": "Design database schema",
          "phase_number": 1,
          "phase_name": "Database Layer",
          "gsd_route": "quick",
          "labels": ["backend", "database"],
          "depends_on_slugs": [],
          "pipeline_stage": "done"
        }
      ]
    }
  ],
  "current_milestone": 1,
  "phase_map": { ... }
}
```

Key fields:
- **`current_milestone`** -- 1-indexed pointer to the active milestone. Advanced automatically when a milestone completes.
- **`pipeline_stage`** per issue -- Tracks progress: `new` -> `triaged` -> `planning` -> `executing` -> `verifying` -> `pr-created` -> `done` (or `failed` / `blocked`).
- **`depends_on_slugs`** -- Slugified issue titles used for dependency resolution (see [Dependency Ordering](#dependency-ordering)).

### active/ Issue State Files

Each in-progress issue has a JSON file in `.mgw/active/`:

```json
{
  "issue": {
    "number": 42,
    "title": "Fix authentication flow",
    "url": "https://github.com/owner/repo/issues/42",
    "labels": ["bug"],
    "assignee": "username"
  },
  "triage": {
    "scope": { "files": 5, "systems": ["auth", "middleware"] },
    "validity": "confirmed",
    "security_notes": "Touches auth tokens -- review required",
    "conflicts": [],
    "last_comment_count": 3,
    "last_comment_at": "2026-02-26T10:00:00Z"
  },
  "gsd_route": "quick",
  "gsd_artifacts": { "type": "quick", "path": ".planning/quick/01-fix-auth" },
  "pipeline_stage": "executing",
  "comments_posted": ["triage-complete", "work-started"],
  "linked_pr": null,
  "linked_issues": [],
  "linked_branches": ["issue/42-fix-auth"]
}
```

The `triage` section stores the analysis results from `/mgw:issue`. The `last_comment_count` and `last_comment_at` fields enable the pre-flight comment check that runs before execution begins (see [Pre-Flight Comment Check](#pre-flight-comment-check)).

### cross-refs.json

Tracks bidirectional relationships:

```json
{
  "links": [
    { "a": "issue:42", "b": "issue:43", "type": "related", "created": "2026-02-26T10:00:00Z" },
    { "a": "issue:42", "b": "pr:15", "type": "implements", "created": "2026-02-26T12:00:00Z" },
    { "a": "issue:42", "b": "branch:issue/42-fix-auth", "type": "tracks", "created": "2026-02-26T10:00:00Z" },
    { "a": "issue:71", "b": "issue:70", "type": "blocked-by", "created": "2026-02-26T10:00:00Z" }
  ]
}
```

Link types:

| From | To | Type | Meaning |
|------|----|------|---------|
| issue | issue | `related` | General cross-reference |
| issue | issue | `blocked-by` | Dependency relationship |
| issue | pr | `implements` | PR resolves the issue |
| issue | branch | `tracks` | Branch contains work for the issue |
| pr | branch | `tracks` | PR is based on the branch |

---

## Configuration Reference

### config.json

User-level preferences stored at `.mgw/config.json`:

```json
{
  "github_username": "your-username",
  "default_assignee": "@me",
  "default_state": "open"
}
```

This file is optional. MGW falls back to sensible defaults when it is absent.

### CLI Global Options

Every CLI subcommand supports these flags:

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would happen without executing. Useful for previewing milestone execution plans. |
| `--json` | Output structured JSON instead of formatted text. Useful for scripting and piping. |
| `-v, --verbose` | Show API calls and file writes. |
| `--debug` | Full payloads, timings, and internal state. |
| `--model <model>` | Override the Claude model for AI-dependent commands (e.g., `--model claude-opus-4-6`). |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `NO_COLOR` | Disable colored terminal output |
| `CI` | Detected automatically; disables color and interactive prompts |

### GitHub Issue Templates

`/mgw:init` creates two issue templates in `.github/ISSUE_TEMPLATE/`:

- **`bug_report.yml`** -- Fields: BLUF, What's Wrong, What's Involved, Steps to Fix, Additional Context
- **`feature_request.yml`** -- Fields: BLUF, What's Needed, What's Involved, Additional Context

These structured fields help MGW's triage agent extract requirements more reliably. You can customize the templates -- MGW will work with any issue body, but structured templates produce better triage results.

### PR Template

`.github/PULL_REQUEST_TEMPLATE.md` provides the base structure for PRs:

```markdown
## Summary
<!-- 2-4 bullets: what changed and why -->

Closes #<!-- issue number -->

## Changes
<!-- Group by system/module -->

## Test Plan
<!-- How to verify these changes work -->
```

When MGW creates PRs via `/mgw:pr` or `/mgw:run`, it fills in these sections automatically from GSD artifacts and milestone context.

---

## Command Reference

### Setup Commands

#### `/mgw:init`

Bootstrap a repository for MGW. One-time setup, safe to re-run.

```
/mgw:init
```

Creates: `.mgw/` directory, GitHub templates, standard labels, gitignore entries.

#### `/mgw:project`

Scaffold an entire project from a description. Creates milestones, issues, dependency labels, and a GitHub Projects v2 board.

```
/mgw:project
```

This is an interactive command. MGW asks "What are you building?" and generates project-specific milestones, phases, and issues based on your description. It does not ask you to pick a template type -- the AI infers the project structure from your description.

If all milestones in the project are already complete, `/mgw:project` enters **extend mode**: it asks what new milestones to add, appends them to the existing project.json, reuses the GitHub Projects board, and continues phase numbering from the last phase. Existing data is fully preserved.

What gets created:
- GitHub milestones with descriptions
- Issues assigned to milestones with phase labels
- `blocked-by:#N` labels for dependency tracking
- `.mgw/project.json` with full project state
- A GitHub Projects v2 board with all issues added

**Important:** `/mgw:project` creates structure only. It does not trigger execution. Run `/mgw:milestone` to begin working through issues.

### Browse and Triage Commands

#### `/mgw:issues [filters]`

List open issues with optional filters. Works without Claude -- purely a `gh` CLI wrapper.

```
/mgw:issues                        # Your open issues (default: @me, open)
/mgw:issues --label bug            # Filter by label
/mgw:issues --milestone "v2.0"     # Filter by milestone
/mgw:issues --assignee all         # All open issues (not just yours)
/mgw:issues --state closed         # Closed issues
/mgw:issues --json                 # JSON output for scripting
```

CLI equivalent:
```bash
mgw issues
mgw issues --label bug --json
```

#### `/mgw:issue <number>`

Deep triage of a single issue against the codebase. Spawns an analysis agent that evaluates five dimensions:

```
/mgw:issue 42
```

Triage dimensions:
- **Scope** -- Which files and systems are affected, estimated size
- **Validity** -- Can the issue be confirmed by reading the code?
- **Purpose** -- Who benefits, what is the impact of inaction?
- **Security** -- Does it touch auth, user data, external APIs?
- **Conflicts** -- Does it overlap with other in-progress work?

Output: a recommended GSD route and a state file at `.mgw/active/42-<slug>.json`.

#### `/mgw:next`

Show the next unblocked issue based on dependency order. Read-only -- does not start any work.

```
/mgw:next
```

Displays:
- Recommended issue with full context (GSD route, phase, labels)
- Resolved dependencies (what had to finish first)
- What this issue unblocks (downstream issues)
- Alternative unblocked issues (if multiple are available)
- Offer to start `/mgw:run` for the recommended issue

### Pipeline Commands

#### `/mgw:run <number>`

The main command. Runs the full autonomous pipeline for a single issue:

```
/mgw:run 42
```

Pipeline stages:
1. **Validate** -- Load or create triage state
2. **Worktree** -- Create isolated git worktree (`issue/42-<slug>`)
3. **Pre-flight** -- Check for new comments since triage (classify as material/informational/blocking)
4. **Triage comment** -- Post structured triage results on the issue
5. **GSD execution** -- Run the appropriate GSD route (quick, quick --full, or new-milestone)
6. **Execution comment** -- Post commit count, file changes, test status
7. **PR creation** -- Push branch, create PR with milestone context
8. **PR-ready comment** -- Post PR link and pipeline summary
9. **Cleanup** -- Remove worktree, update state

If the issue has not been triaged yet, `/mgw:run` runs triage inline before starting execution.

CLI equivalent:
```bash
mgw run 42
mgw run 42 --dry-run    # Preview without executing
mgw run 42 --quiet      # Buffer output, show summary at end
```

#### `/mgw:milestone [number] [--interactive] [--dry-run]`

Execute all issues in a milestone in dependency order. The most powerful command -- it chains multiple `/mgw:run` invocations with checkpointing.

```
/mgw:milestone              # Current milestone (from project.json)
/mgw:milestone 2            # Specific milestone by number
/mgw:milestone --dry-run    # Show execution plan without running
/mgw:milestone --interactive  # Pause between issues for review
```

What it does:
1. Loads project.json and resolves the target milestone
2. Runs a batch staleness check against GitHub
3. Checks API rate limits (caps execution if limits are low)
4. Topologically sorts issues by dependency (Kahn's algorithm)
5. Filters out already-completed issues
6. For each issue: posts work-started comment, runs pipeline, posts result comment
7. Handles failures: marks failed issues, blocks dependents, continues with unblocked issues
8. On full completion: closes GitHub milestone, creates draft release, advances to next milestone

Flags:
- **`--dry-run`** -- Displays the execution order table with dependencies, status, and rate limit estimates. Does not execute anything.
- **`--interactive`** -- Pauses after each issue with options: Continue, Skip next, Abort.

CLI equivalent:
```bash
mgw milestone
mgw milestone 2 --interactive
mgw milestone --dry-run
```

### Query Commands

#### `/mgw:status [milestone] [--json]`

Project dashboard showing milestone progress, issue pipeline stages, and open PRs.

```
/mgw:status              # Current milestone
/mgw:status 2            # Specific milestone
/mgw:status --json       # Machine-readable output
```

Displays:
- Progress bar with percentage
- Per-issue pipeline stages with icons
- Open PRs matched to milestone issues
- Next milestone preview

Falls back gracefully when no project.json exists (shows GitHub-only status with open issues and PRs).

#### `/mgw:ask <question>`

Route a question or observation during work. Classifies it against the current project context:

```
/mgw:ask "The slug generation doesn't handle unicode characters"
```

Classifications:
- **In-scope** -- Relates to the current active issue. Include in current work.
- **Adjacent** -- Relates to a different issue in the same milestone. Suggest posting a comment.
- **Separate** -- No matching issue. Suggest filing a new one.
- **Duplicate** -- Matches an existing issue. Point to it.
- **Out-of-scope** -- Beyond the current milestone. Note for future planning.

### GitHub Operations

#### `/mgw:update <number> [message]`

Post a structured status comment on an issue:

```
/mgw:update 42                           # Auto-detect status from state
/mgw:update 42 "switching approach"      # Custom message
```

#### `/mgw:pr [number] [--base branch]`

Create a PR from GSD artifacts:

```
/mgw:pr                    # From current branch
/mgw:pr 42                 # Linked to issue #42
/mgw:pr 42 --base develop  # Custom base branch
```

PR body includes:
- Summary from GSD execution artifacts
- Milestone context (milestone name, phase, position in sequence)
- File-level changes grouped by module
- Testing procedures from verification artifacts
- Cross-references from `.mgw/cross-refs.json`

#### `/mgw:link <ref> <ref>`

Create a bidirectional cross-reference:

```
/mgw:link 42 #43              # Issue-to-issue
/mgw:link 42 branch:fix/auth  # Issue-to-branch
```

Posts GitHub comments on both referenced issues (unless `--quiet`). Records the link in `.mgw/cross-refs.json`.

CLI equivalent:
```bash
mgw link 42 43
mgw link 42 43 --quiet  # No GitHub comments
```

### Maintenance Commands

#### `/mgw:sync`

Reconcile local `.mgw/` state with GitHub reality:

```
/mgw:sync
mgw sync                # CLI equivalent
mgw sync --dry-run      # Preview what would change
mgw sync --json         # JSON output
```

What it does:
- Compares local issue state with GitHub issue state
- Archives completed issues (moves from `active/` to `completed/`)
- Flags stale branches and drift

#### `/mgw:help`

Display the command reference. No side effects, works without Claude.

```
/mgw:help
mgw help     # CLI equivalent
```

---

## Workflow Walkthrough

### Greenfield Project

Starting a brand new project from scratch:

```
# Step 1: Initialize the repo for MGW
/mgw:init

# Step 2: Scaffold milestones and issues from your description
/mgw:project
# MGW asks: "What are you building?"
# You describe your project. MGW generates milestones, phases, and issues.

# Step 3: See the execution plan
/mgw:milestone --dry-run
# Shows: ordered issues, dependencies, estimated API calls

# Step 4: Execute the first milestone
/mgw:milestone
# Runs each issue in dependency order:
#   - Posts work-started comment
#   - Creates worktree
#   - Plans via GSD
#   - Executes code changes
#   - Creates PR
#   - Posts PR-ready comment
#   - Cleans up worktree

# Step 5: Review and merge PRs as they are created
# Each merged PR auto-closes its linked issue

# Step 6: After merging, sync state
/mgw:sync
```

### Extending a Completed Project

When all milestones are complete and you want to add more work:

```
# Run project again -- MGW detects all milestones are done
/mgw:project
# MGW shows: "All N milestones complete. Entering extend mode."
# Asks: "What new milestones should we add?"
# You describe the new work.

# What happens:
# - New milestones and issues are appended (existing ones preserved)
# - Phase numbering continues from where it left off
# - current_milestone is set to the first new milestone
# - Existing project board is reused (new issues added to it)
# - cross-refs.json is preserved and extended with new dependency entries

# Then execute the new milestones
/mgw:milestone
```

What is preserved during extension:
- All completed milestone data and pipeline stages
- The GitHub Projects v2 board (new issues added, old ones remain)
- cross-refs.json entries for all existing links
- project.json `project` metadata (name, description, repo, etc.)

### Existing Issues

Working with a repo that already has GitHub issues:

```
# Step 1: See what is assigned to you
/mgw:issues

# Step 2: Find the next unblocked issue
/mgw:next

# Step 3: Run the full pipeline for that issue
/mgw:run 42
# Creates branch issue/42-fix-auth in a worktree
# Triages (if not already done)
# Plans and executes via GSD
# Opens PR with structured description
# Posts status comments on the issue

# Step 4: Review the PR, merge when ready

# Step 5: Sync state
/mgw:sync
```

### Manual Step-by-Step Control

For more control over individual pipeline stages:

```
# Triage first
/mgw:issue 42

# Review triage results, then link related issues
/mgw:link 42 #43

# Post a status update
/mgw:update 42 "starting implementation"

# Run the pipeline (skips triage since it is already done)
/mgw:run 42

# Or create a PR manually from the current branch
/mgw:pr 42 --base develop
```

### Working Across Multiple Sessions

MGW checkpoints state after each issue. If your session ends mid-milestone:

```
# Session 1: Start milestone execution
/mgw:milestone
# Completes issues #10, #11, #12 -- session ends

# Session 2: Resume where you left off
/mgw:milestone
# Detects #10, #11, #12 are done
# Continues with #13, #14, ...
```

If an issue was partially in progress when the session ended, `/mgw:milestone` detects this, cleans up the partial worktree, and restarts that issue from scratch.

---

## GSD Routes Explained

GSD (Get Shit Done) is the planning and execution framework that MGW delegates to. MGW recommends a GSD route based on issue scope:

| Issue Size | Files | Route | What Happens |
|-----------|-------|-------|--------------|
| Small | 1-2 files | `quick` | Single-pass plan + execute. Fast, minimal overhead. |
| Medium | 3-8 files | `quick --full` | Plan with verification loop. Includes plan checking and post-execution verification. |
| Large | 9+ files | `new-milestone` | Full milestone with phased execution. Roadmap creation, multi-phase planning, per-phase verification. |

### Available GSD Routes

| Route | Use Case |
|-------|----------|
| `quick` | Small, well-defined tasks. One plan, one execution pass. |
| `plan-phase` | Complex multi-step implementation. Detailed planning with task breakdown. |
| `discuss-phase` | Requirements clarification. Gather context before planning. |
| `research-phase` | Unknowns requiring investigation before implementation. |
| `execute-phase` | Straightforward mechanical execution (plan already exists). |
| `verify-phase` | Post-execution verification against acceptance criteria. |
| `new-project` | Full project scaffold from scratch. |
| `new-milestone` | New milestone with roadmap, phases, and dependency chain. |
| `complete-milestone` | Finalize a milestone (close, release, advance). |

### How Route Selection Works

When `/mgw:issue` triages an issue, the analysis agent examines the codebase and recommends a route based on:
- Number of files that need changes
- Number of systems/modules affected
- Whether new systems need to be created
- Complexity of the required changes

You can override the route during the `/mgw:run` confirmation step.

---

## Dependency Ordering

### How Dependencies Are Declared

During `/mgw:project`, issues are generated with `depends_on` slugs. These slugs are derived from issue titles:

```
Title: "Design database schema"
Slug:  "design-database-schema" (lowercase, spaces-to-hyphens, truncated to 40 chars)
```

On GitHub, dependencies appear as `blocked-by:#N` labels on dependent issues.

### How Dependencies Are Resolved

`/mgw:milestone` uses **Kahn's algorithm** (topological sort) to determine execution order:

1. Build a directed graph from `depends_on_slugs`
2. Find all issues with zero in-degree (no unresolved dependencies)
3. Process them in phase-number order (lower phase numbers first as tiebreaker)
4. After processing, decrement the in-degree of downstream issues
5. Repeat until all issues are processed

If a circular dependency is detected (cycle in the graph), MGW refuses to proceed and reports the involved issues.

### What Happens When a Dependency Fails

When an issue fails during milestone execution:
1. The failed issue is marked with `pipeline_stage: "failed"` and labeled `pipeline-failed`
2. All issues that depend on the failed issue are marked as blocked
3. Issues that do not depend on the failed issue continue executing
4. The milestone is marked as incomplete

To recover:
```
# Fix the underlying problem
# Re-run the milestone (it picks up where it left off)
/mgw:milestone
```

### Viewing the Dependency Graph

```
# See the full execution plan with dependencies
/mgw:milestone --dry-run
```

This displays a table showing order, issue number, title, current status, what each issue depends on, and what each issue blocks.

---

## Worktree Isolation

### How It Works

Every `/mgw:run` execution happens in an isolated git worktree:

```
.worktrees/
  issue/42-fix-auth/     # Full checkout on branch issue/42-fix-auth
  issue/71-user-reg/     # Full checkout on branch issue/71-user-reg
```

Your main workspace stays on the default branch (usually `main`). You can continue browsing code, reviewing PRs, or even running another MGW pipeline in a separate terminal.

### Worktree Lifecycle

1. **Created** by `/mgw:run` at `.worktrees/issue/<number>-<slug>/`
2. **Branch** created: `issue/<number>-<slug>` based on the default branch
3. **All work** (GSD planning, execution, commits) happens inside the worktree
4. **Branch pushed** to origin after execution completes
5. **Worktree removed** after PR creation -- the branch persists for the PR

### State File Location

The `.mgw/` directory is **not** inside worktrees. It only exists in the main repository checkout. All state operations during `/mgw:run` use absolute paths back to the main repo:

```bash
# Inside worktree -- CWD is .worktrees/issue/42-fix-auth/
# State reads/writes use absolute path: ${REPO_ROOT}/.mgw/active/42-fix-auth.json
```

### Gitignore

Both `.mgw/` and `.worktrees/` are automatically added to `.gitignore` by `/mgw:init`.

---

## Status Comments and PR Descriptions

### Comment Types

MGW posts structured comments on issues at each pipeline stage:

| Stage | Comment Tag | Content |
|-------|-------------|---------|
| Triage complete | `triage-complete` | Scope, validity, security, route, affected files |
| Work started | `work-started` | Issue details, route, phase, milestone progress table |
| Execution complete | `execution-complete` | Commit count, file changes, test status |
| PR ready | `pr-ready` | PR link, one-liner summary, pipeline stage table |
| Pipeline failed | `pipeline-failed` | Failure notification, dependent issue impact |
| Pipeline blocked | `pipeline-blocked` | Blocking comment detected, reason |
| Phase complete | `phase-complete` | Per-phase summary during milestone execution |

### Comment Format

All comments follow a consistent structure:

```markdown
> **MGW** . `stage-tag` . 2026-02-26T10:00:00Z
> Milestone: v1 -- Core Features | Phase 1: Database Schema

### Stage Title

| | |
|---|---|
| **Issue** | #42 -- Fix authentication flow |
| **Route** | `quick` |

<details>
<summary>Milestone Progress (3/6 complete)</summary>

| # | Issue | Status | PR |
|---|-------|--------|----|
| 10 | Design schema | Done | #15 |
| **42** | **Fix auth** | In Progress | -- |
| 43 | Add middleware | Pending | -- |

</details>
```

### PR Description Structure

PRs created by MGW follow this structure:

```markdown
## Summary
- 2-4 bullets of what was built and why

Closes #42

## Milestone Context
- **Milestone:** v1 -- Core Features
- **Phase:** 1 -- Database Schema
- **Issue:** 2 of 6 in milestone

## Changes
- File-level changes grouped by module

## Test Plan
- Verification checklist

## Cross-References
- Related issues and PRs

<details>
<summary>GSD Progress</summary>
Progress table from GSD artifacts
</details>
```

### Pre-Flight Comment Check

Before execution begins, `/mgw:run` checks if new comments have been posted on the issue since triage. New comments are classified:

| Classification | Meaning | Pipeline Action |
|---------------|---------|-----------------|
| **Informational** | Status update, +1, question | Continue normally |
| **Material** | Changes scope, requirements, acceptance criteria | Enrich context with new requirements, continue |
| **Blocking** | Explicit "hold", "wait", "don't work on this" | Pause pipeline, set stage to "blocked" |

This prevents executing against stale plans when stakeholders have posted material changes.

---

## Cross-References

### Creating Links

```
/mgw:link 42 #43              # Issue-to-issue
/mgw:link 42 branch:fix/auth  # Issue-to-branch
```

Or via CLI:
```bash
mgw link 42 43
mgw link 42 43 --quiet    # Skip GitHub comments
mgw link 42 43 --dry-run  # Preview without creating
mgw link 42 43 --json     # JSON output
```

### Automatic Cross-References

MGW automatically creates cross-references during pipeline execution:
- Issue to branch (when worktree is created)
- Issue to PR (when PR is created)
- Issue to issue (when `blocked-by` dependencies are declared)

### Viewing Cross-References

Cross-references appear in:
- PR descriptions (Cross-References section)
- `/mgw:status` dashboard
- The raw file at `.mgw/cross-refs.json`

---

## Advanced Usage

### Dry Run Everything

Preview any destructive operation before executing:

```bash
mgw sync --dry-run              # See what would be archived
mgw milestone --dry-run         # See the execution plan
mgw link 42 43 --dry-run        # Preview link creation
```

### JSON Output for Scripting

Most commands support `--json` for machine-readable output:

```bash
mgw issues --json | jq '.[].number'
mgw sync --json | jq '.drifted'
mgw status --json | jq '.milestone.progress_pct'
```

### Interactive Milestone Execution

For careful, step-by-step milestone execution:

```bash
mgw milestone --interactive
```

After each issue completes, you choose: Continue, Skip next, or Abort.

### Model Override

Use a specific Claude model for AI-dependent commands:

```bash
mgw run 42 --model claude-opus-4-6
```

### Standalone PR Creation

Create a PR from any branch, not just MGW-managed ones:

```
/mgw:pr                     # From current branch, auto-detect issue
/mgw:pr 42                  # Link to specific issue
/mgw:pr 42 --base develop   # Target a non-default base branch
```

### Manual State Editing

If pipeline state gets out of sync, you can edit the JSON files directly:

```bash
# Mark an issue as done manually
cat .mgw/active/42-fix-auth.json | jq '.pipeline_stage = "done"' > /tmp/fix.json
mv /tmp/fix.json .mgw/active/42-fix-auth.json

# Or move it to completed manually
mv .mgw/active/42-fix-auth.json .mgw/completed/

# Then sync to reconcile
mgw sync
```

### Resuming After Failure

If `/mgw:run` fails mid-execution:

```
# The worktree and branch still exist
# Simply re-run -- MGW detects existing state and resumes
/mgw:run 42
```

If `/mgw:milestone` fails:

```
# Re-run -- completed issues are skipped
/mgw:milestone
```

---

## Recovering from Failures

### Pipeline Failed (No PR Created)

When `/mgw:run` fails to produce a PR:

1. **Check the issue comments** -- MGW posts a `pipeline-failed` comment with details
2. **Check for a lingering worktree**:
   ```bash
   git worktree list
   # If the worktree exists, you can inspect it:
   cd .worktrees/issue/42-fix-auth
   git log --oneline
   ```
3. **Clean up and retry**:
   ```bash
   git worktree remove .worktrees/issue/42-fix-auth
   /mgw:run 42
   ```

### Blocked by Stakeholder Comment

If a blocking comment is detected during pre-flight:

1. The pipeline pauses with `pipeline_stage: "blocked"`
2. A `pipeline-blocked` comment is posted on the issue
3. Resolve the blocker (reply on the issue, update requirements)
4. Re-run: `/mgw:run 42`

### Stale Local State

If your local `.mgw/` state drifts from GitHub:

```
/mgw:sync
# Archives completed issues, flags drift
```

For manual repair:
```bash
# Delete and re-triage
rm .mgw/active/42-fix-auth.json
/mgw:issue 42
/mgw:run 42
```

### Circular Dependencies

If `/mgw:milestone` reports a circular dependency:

1. Check the reported issue slugs
2. Review `blocked-by` labels on GitHub
3. Remove the circular label:
   ```bash
   gh issue edit 42 --remove-label "blocked-by:#43"
   ```
4. Update `depends_on_slugs` in `.mgw/project.json` if needed
5. Re-run: `/mgw:milestone`

### Rate Limit Exhaustion

If GitHub API rate limits are hit during milestone execution:

1. MGW detects this during the rate limit guard step
2. It caps execution at the number of issues that can safely run
3. Wait for the rate limit to reset (shown in the output)
4. Re-run `/mgw:milestone` -- completed issues are skipped

---

## Using MGW with Existing GSD Projects

If your project already uses GSD (has a `.planning/` directory with `ROADMAP.md`, `STATE.md`, etc.), MGW integrates cleanly:

### Boundary Between MGW and GSD

- **MGW owns:** `.mgw/` directory, GitHub issues, PRs, labels, comments, milestones, worktrees
- **GSD owns:** `.planning/` directory, `ROADMAP.md`, `STATE.md`, `config.json`, plan/summary documents

MGW never writes to `.planning/`. GSD never writes to `.mgw/`.

### Adding MGW to an Existing GSD Project

```
# Step 1: Initialize MGW state
/mgw:init

# Step 2: If you want milestone tracking, scaffold the project
/mgw:project
# This creates GitHub milestones/issues but does NOT touch .planning/

# Step 3: Work issues through MGW pipeline
/mgw:run 42
# MGW creates worktrees and delegates to GSD for planning/execution
# GSD writes plans and summaries in .planning/ (inside the worktree)
# MGW reads GSD artifacts for PR descriptions
```

### What If There Is No .planning/ Directory?

When `/mgw:run` delegates to GSD and no `.planning/` directory exists, MGW creates the minimal structure that GSD needs:

```bash
mkdir -p .planning/quick
```

MGW never creates `config.json`, `ROADMAP.md`, or `STATE.md` -- those are GSD's responsibility. If you need them, run `/gsd:new-milestone` after the initial pipeline completes.

---

## Troubleshooting

### "claude CLI is not installed"

```
Error: claude CLI is not installed.
Install it with: npm install -g @anthropic-ai/claude-code
Then run: claude login
```

Install Claude Code and authenticate before using AI-dependent commands. Non-AI commands (`sync`, `issues`, `link`, `help`) work without Claude.

### "claude CLI is not authenticated"

```
Error: claude CLI is not authenticated.
Run: claude login
```

### "GSD tools not found"

```
Error: GSD tools not found at ~/.claude/get-shit-done/bin/gsd-tools.cjs
```

Install GSD at the standard location:
```bash
git clone https://github.com/glittercowboy/get-shit-done.git ~/.claude/get-shit-done
```

### "No project initialized"

Commands like `/mgw:next` and `/mgw:milestone` require project state. Run:

```
/mgw:project
```

Or, if you just want to run individual issues without full project scaffolding:

```
/mgw:run 42
```

`/mgw:run` works with or without `project.json`.

### "Not a git repository"

MGW requires a git repository with a GitHub remote. Verify:

```bash
git rev-parse --show-toplevel
gh repo view
```

### Slash Commands Not Appearing

If `/mgw:` commands are not showing up in Claude Code:

```bash
# Verify commands are deployed
ls ~/.claude/commands/mgw/
# Should list .md files

# If missing, redeploy
mkdir -p ~/.claude/commands/mgw/workflows
cp -r /path/to/mgw/.claude/commands/mgw/* ~/.claude/commands/mgw/
```

### Worktree Cleanup After Crash

If a session ends without cleaning up worktrees:

```bash
# List active worktrees
git worktree list

# Remove a specific worktree
git worktree remove .worktrees/issue/42-fix-auth

# Force remove if there are uncommitted changes
git worktree remove .worktrees/issue/42-fix-auth --force

# Clean up empty directories
rmdir .worktrees/issue .worktrees 2>/dev/null
```

### State File Corruption

If `.mgw/` JSON files become corrupted:

```bash
# Validate JSON
python3 -c "import json; json.load(open('.mgw/project.json'))"

# If corrupt, remove and re-initialize
rm -rf .mgw/
/mgw:init
/mgw:project   # If you need project tracking
```

---

## FAQ

### Do I need all the prerequisites?

It depends on which commands you use:

| Commands | Requires |
|----------|----------|
| `help`, `issues`, `sync`, `link` | Node.js + GitHub CLI only |
| `run`, `issue`, `milestone`, `project`, `next`, `pr`, `update`, `ask` | All prerequisites (Node.js + Claude Code + GSD + GitHub CLI) |

### Can I use MGW without GSD?

Partially. The non-AI commands (`sync`, `issues`, `link`, `help`, `status`) work independently. The pipeline commands (`run`, `milestone`, `project`) require GSD because MGW delegates planning and execution to GSD agents.

### Can I use MGW with a team?

Yes. Each developer has their own `.mgw/` directory (gitignored). GitHub issues, milestones, labels, and comments are shared. Multiple developers can run MGW pipelines concurrently on different issues.

### Does MGW modify my code?

MGW itself never reads or writes application code. That is the delegation boundary. All code changes happen inside GSD agents that MGW spawns. MGW only manages state files (`.mgw/`), GitHub metadata (issues, PRs, comments), and git operations (worktrees, branches, pushes).

### What happens if I merge a PR manually?

The linked issue closes via GitHub's `Closes #N` mechanism. Run `/mgw:sync` to update local state:

```
mgw sync
```

This moves the completed issue from `.mgw/active/` to `.mgw/completed/`.

### Can I skip the triage step?

Yes. `/mgw:run` auto-triages if no state file exists, but if you create a state file manually (or have already triaged), it skips straight to execution.

### How do I change the GSD route after triage?

Edit the state file directly:

```bash
# View current route
cat .mgw/active/42-fix-auth.json | jq '.gsd_route'

# Change it
cat .mgw/active/42-fix-auth.json | jq '.gsd_route = "plan-phase"' > /tmp/fix.json
mv /tmp/fix.json .mgw/active/42-fix-auth.json
```

Or delete the state file and re-triage:

```bash
rm .mgw/active/42-fix-auth.json
/mgw:issue 42
```

### How do I add a dependency between issues?

On GitHub, add a `blocked-by:#N` label to the dependent issue:

```bash
# Create the label (if it does not exist)
gh label create "blocked-by:#10" --description "Blocked by issue #10" --color "e4e669" --force

# Apply it
gh issue edit 42 --add-label "blocked-by:#10"
```

If using project.json, also update the `depends_on_slugs` array for the dependent issue.

### What is the slug format?

Slugs are derived from issue titles: lowercase, spaces replaced with hyphens, truncated to 40 characters.

```
"Design Core Game Loop and Player Mechanics"
-> "design-core-game-loop-and-player-mechanic"  (truncated at 40 chars)
```

MGW uses `gsd-tools.cjs generate-slug` for consistent slug generation.

### Can I run MGW in CI/GitHub Actions?

Not currently. MGW is designed for interactive use with Claude Code. CI integration is on the roadmap.

### How do I add more milestones after completing all of them?

Run `/mgw:project` again. When all milestones are complete, it automatically enters extend mode:

```
/mgw:project
# "All milestones complete. Entering extend mode."
# Describe the new work.
```

New milestones are appended. Existing data (completed milestones, board, cross-refs) is preserved.

### How do I completely reset MGW state?

```bash
rm -rf .mgw/
/mgw:init
```

This preserves your GitHub issues, milestones, and PRs but resets all local tracking state. You will need to re-run `/mgw:project` if you want milestone orchestration.
