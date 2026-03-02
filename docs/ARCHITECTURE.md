# MGW Architecture

This document describes the internal architecture of MGW: how it is structured, why it is structured that way, and how the pieces fit together.

---

## Table of Contents

- [System Overview](#system-overview)
- [The Two-Layer Model](#the-two-layer-model)
- [The Delegation Boundary](#the-delegation-boundary)
- [How an Issue Becomes a PR](#how-an-issue-becomes-a-pr)
- [Command Pipeline Flow](#command-pipeline-flow)
- [State Management](#state-management)
- [Agent Delegation Model](#agent-delegation-model)
- [Slash Command Anatomy](#slash-command-anatomy)
- [CLI Architecture](#cli-architecture)
- [Directory Structure](#directory-structure)
- [Shared Workflow System](#shared-workflow-system)
- [GSD Artifact Flow into PRs](#gsd-artifact-flow-into-prs)

---

## System Overview

MGW (My GSD Workflow) is a GitHub-native issue-to-PR automation system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview). It takes a GitHub issue, triages it, plans the work, executes it through [Get Shit Done](https://github.com/glittercowboy/get-shit-done) (GSD), and opens a pull request -- posting structured status comments at every stage.

MGW exists at a specific layer in the development stack:

```
 GitHub (issues, PRs, milestones, labels)
    ^
    |  reads/writes metadata
    |
 MGW (orchestration layer)
    |
    |  spawns agents, passes context
    v
 GSD (execution layer — planning, coding, verification)
    |
    |  reads/writes application code
    v
 Your Codebase
```

MGW never touches application code. It reads GitHub state, manages pipeline state, and delegates all code-touching work to GSD agents. This separation is the core architectural principle.

---

## The Two-Layer Model

MGW and GSD serve distinct, complementary roles. Understanding the boundary between them is essential to understanding the system.

### MGW: The Orchestration Layer

MGW owns the GitHub lifecycle. Its responsibilities are:

- **Issue triage** -- spawn analysis agents, store results, post structured comments
- **Pipeline sequencing** -- move issues through stages (new, triaged, planning, executing, verifying, pr-created, done)
- **State management** -- read/write `.mgw/` state files, track cross-references between issues, PRs, and branches
- **GitHub communication** -- post status comments, create PRs, manage labels and milestones
- **Agent spawning** -- invoke Claude Code `Task()` agents with the right context and constraints
- **Worktree management** -- create isolated git worktrees for issue work, clean up after PR creation

### GSD: The Execution Layer

GSD owns planning, coding, and verification. Its responsibilities are:

- **Planning** -- create PLAN.md files with tasks, files, and verification steps
- **Code execution** -- read application code, write application code, make implementation decisions
- **Verification** -- check that plans were executed correctly, run tests, validate artifacts
- **State tracking** -- manage `.planning/` directories with ROADMAP.md, STATE.md, config.json

### What Each Layer Owns

```
MGW Owns                          GSD Owns
------                            --------
.mgw/                             .planning/
  project.json                      config.json
  active/*.json                     ROADMAP.md
  completed/                        STATE.md
  cross-refs.json                   quick/
  config.json                         *-PLAN.md
                                      *-SUMMARY.md
GitHub metadata                       *-VERIFICATION.md
  Issues, PRs, milestones
  Labels, comments                Application code
  Branches (creation/push)          Source files
                                    Tests
Pipeline stage transitions          Architecture decisions
Agent invocation
Worktree lifecycle
```

MGW never writes to `.planning/` state files (config.json, ROADMAP.md, STATE.md). GSD never writes to `.mgw/`. The only shared surface is the GSD artifacts directory (PLAN.md, SUMMARY.md, VERIFICATION.md), which GSD writes and MGW reads.

---

## The Delegation Boundary

The delegation boundary is the architectural rule that keeps MGW and GSD separate. It has a mechanical check:

> **For any logic in an MGW command, ask: "If GSD improved this tomorrow, would MGW automatically benefit?"**

- **YES** -- the logic is correctly delegated. It lives in a `Task()` agent or in GSD itself, and MGW references the result.
- **NO** -- the logic is misplaced in MGW. It should be moved into a `Task()` agent.

### What MGW May Do Directly (Allowlist)

```
- Read/write .mgw/ state files (JSON)
- Read/write GitHub metadata (via gh CLI)
- Parse command arguments ($ARGUMENTS)
- Display user-facing output (banners, tables, prompts)
- Spawn Task() agents
- Call gsd-tools.cjs for utilities (slugs, timestamps, model resolution)
- Manage git worktrees and branches
```

### What MGW Must Never Do (Denylist)

```
- Read application source code
- Write application source code
- Analyze code for scope, security, or conflicts
- Make architecture or implementation decisions
- Generate PR descriptions from code analysis (only from GSD artifacts)
- Run or interpret application tests
```

### Example

**Wrong** -- MGW analyzing code inline:

```
Search the codebase for files related to "auth":
grep -r "auth" src/
# MGW decides: "3 files affected, medium scope"
```

**Right** -- MGW spawning an agent to analyze:

```
Task(
  prompt="Analyze issue #42 against this codebase.
          Return: scope, validity, security, conflicts.",
  subagent_type="general-purpose",
  description="Triage issue #42"
)
# MGW reads the agent's structured result
# MGW writes it to .mgw/active/42-fix-auth.json
# MGW presents it to the user
```

The full rule with a review checklist is defined in `workflows/validation.md`. Every slash command is expected to pass this check.

---

## How an Issue Becomes a PR

### mgw:project State-Aware Routing

`/mgw:project` reads five signals before deciding what to do:

| Signal | Meaning |
|--------|---------|
| P | `.mgw/project.json` exists |
| R | `.planning/ROADMAP.md` exists |
| S | GitHub milestones exist |
| M | `maps-to` cross-refs exist |
| G | GSD phase state exists |

These signals map to routing states and execution paths:

| State | Signals | Path |
|-------|---------|------|
| Fresh | none | 6-stage Vision Collaboration Cycle |
| GSD-Only | R+G, no P/S | `alignment-analyzer` agent → milestone_mapper |
| GSD-Mid-Exec | R+G+partial S | alignment with partial execution state |
| Aligned | P+R+S+M | Status report + interactive extend option |
| Diverged | P+S, R mismatch | `drift-analyzer` agent → reconciliation table |
| Extend | explicit | Add new milestones to existing project |

**Fresh path (Vision Collaboration Cycle):**

1. **Intake** -- freeform project description from user
2. **Domain Expansion** -- `vision-researcher` Task agent produces `.mgw/vision-research.json`
3. **Structured Questioning** -- 3-8 rounds (soft cap), 15 max (hard cap); decisions → `.mgw/vision-draft.md`
4. **Vision Synthesis** -- `vision-synthesizer` produces `.mgw/vision-brief.json` (schema: `templates/vision-brief-schema.json`)
5. **Review** -- user accepts or requests revisions
6. **Condense** -- `vision-condenser` produces `.mgw/vision-handoff.md` → `gsd:new-project` spawn → `milestone_mapper`

**GSD-Only path:**

1. `alignment-analyzer` reads `.planning/*` → `.mgw/alignment-report.json`
2. `milestone_mapper` creates GitHub milestones/issues from the report
3. `maps-to` cross-refs written linking `milestone:N` ↔ `gsd-milestone:id`

**Aligned path:**

When all signals are consistent, shows status and offers three choices: proceed with `/mgw:milestone`, add new milestones (Extend mode), or view full status.

After any path, `milestone_mapper` creates GitHub structure and verifies GSD linkage. If the next milestone lacks a GSD link, the user is prompted to run `gsd:new-milestone` before executing.

This is the end-to-end data flow for a single issue processed through `/mgw:run`:

```
GitHub Issue #42
    |
    v
[1] VALIDATE & LOAD
    - Parse issue number from $ARGUMENTS
    - Check .mgw/active/ for existing state
    - If no state: run triage inline
    |
    v
[2] CREATE WORKTREE
    - Derive branch: issue/42-fix-auth
    - git worktree add .worktrees/issue/42-fix-auth
    - cd into worktree (all work happens here)
    |
    v
[3] PRE-FLIGHT COMMENT CHECK
    - Compare current comment count with triage snapshot
    - If new comments: spawn classification agent
      - material  --> enrich context, continue
      - blocking  --> pause pipeline
      - informational --> log, continue
    |
    v
[4] POST TRIAGE COMMENT
    - Post structured comment on issue:
      scope, route, files, security, branch name
    |
    v
[5] EXECUTE GSD (quick or milestone route)
    |
    +--[quick route]---------------------------+
    |  a. gsd-tools init quick                 |
    |  b. Spawn planner agent --> PLAN.md      |
    |  c. (if --full) Spawn checker agent      |
    |  d. Spawn executor agent --> code + commits|
    |  e. (if --full) Spawn verifier agent     |
    |  f. gsd-tools verify artifacts           |
    +------------------------------------------+
    |
    +--[diagnose-issues route]-----------------+
    |  a. pipeline_stage → "diagnosing"        |
    |  b. Create .planning/debug/ directory    |
    |  c. Spawn diagnosis agent (general-purpose)|
    |     - Reads codebase, finds root cause   |
    |     - Creates .planning/debug/{slug}.md  |
    |  d. If root cause found: route to quick  |
    |  e. If inconclusive: report to user      |
    +------------------------------------------+
    |
    +--[milestone route]-----------------------+
    |  a. gsd-tools init new-milestone         |
    |  b. Spawn roadmapper agent              |
    |  c. For each phase:                      |
    |     - Spawn planner                      |
    |     - Spawn executor                     |
    |     - Spawn verifier                     |
    |     - Post phase-complete comment        |
    +------------------------------------------+
    |
    v
[6] POST EXECUTION COMMENT
    - Commit count, file changes, test status
    |
    v
[7] CREATE PR
    - git push -u origin issue/42-fix-auth
    - Read GSD artifacts (SUMMARY.md, VERIFICATION.md)
    - Spawn PR agent --> gh pr create
    - PR body includes: summary, milestone context, changes, test plan
    |
    v
[8] CLEANUP
    - cd back to repo root
    - git worktree remove
    - Post pr-ready comment on issue
    - Update .mgw/active/ state: pipeline_stage = "done"
    |
    v
PR #85 ready for review
Issue #42 auto-closes on merge
```

---

## Command Pipeline Flow

MGW provides composable commands. The full pipeline is `/mgw:run`, but each stage can be invoked independently:

```
/mgw:project -----> Read GSD ROADMAP.md to create GitHub milestones and issues (or generate from AI description as fallback)
                    Creates: GitHub milestones, issues, labels, .mgw/project.json

/mgw:issue N -----> Deep triage of a single issue
                    Spawns analysis agent, writes .mgw/active/N-slug.json
                    Posts triage comment on issue

/mgw:run N -------> Full autonomous pipeline (triage + execute + PR)
                    Combines: issue triage, GSD execution, PR creation
                    Posts status comments at every stage

/mgw:milestone ---> Execute all issues in a milestone in dependency order
                    Topological sort, rate limit guard, per-issue checkpoint
                    Delegates each issue to /mgw:run via Task()

/mgw:pr [N] ------> Create PR from GSD artifacts (standalone)
                    Reads SUMMARY.md + VERIFICATION.md
                    Spawns PR body builder agent

/mgw:status ------> Dashboard: milestone progress, issue stages, open PRs
                    Read-only query of .mgw/ state and GitHub

/mgw:sync --------> Reconcile .mgw/ state with GitHub reality
                    Archive completed issues, flag stale branches

/mgw:ask ---------> Route a question during milestone execution
                    Classify: in-scope, adjacent, separate, duplicate, out-of-scope
                    Recommends action (file issue, post comment, etc.)
```

### Milestone Orchestration

`/mgw:milestone` is the highest-level orchestrator. It runs issues sequentially in dependency order:

```
Load project.json (resolveActiveMilestoneIndex)
    |
    v
Topological sort (Kahn's algorithm)
    |
    v
Rate limit guard (estimate API calls)
    |
    v
For each issue in sorted order:
    |
    +-- Check: blocked by a failed dependency? --> skip
    +-- Check: rate limit exceeded? --> stop
    +-- Check: issue still open on GitHub? --> skip if closed
    |
    +-- Post work-started comment (with milestone progress table)
    +-- Spawn /mgw:run via Task()
    +-- Detect result (PR created or failed)
    +-- If failed: Retry/Skip/Abort prompt (failed-issue recovery)
    +-- Post pr-ready or pipeline-failed comment
    +-- Checkpoint to project.json
    |
    v
All done?
    --> End-of-milestone execution report
    --> Close milestone, create draft release
    --> Advance active_gsd_milestone pointer
    --> Verify next milestone's GSD linkage
        (if unlinked: prompt to run gsd:new-milestone before continuing)
Some failed? --> Report, do not close milestone
```

---

## State Management

### The `.mgw/` Directory

MGW tracks all pipeline state in a local `.mgw/` directory at the repo root. This directory is gitignored and local-only (per-developer).

```
.mgw/
  project.json          Milestones, issues, phases, dependency graph
  config.json           User prefs (GitHub username, default filters)
  active/               In-progress issue pipelines
    42-fix-auth.json    Per-issue state: triage results, pipeline stage, artifacts
    43-add-tests.json
  completed/            Archived after PR merge or issue close
    41-setup-ci.json
  cross-refs.json       Bidirectional issue/PR/branch links
```

### Pipeline Stages

Each issue progresses through a linear stage sequence:

```
new --> triaged --> planning --> executing --> verifying --> pr-created --> done
                                                                    \
                                                                     --> failed
                                                                     --> blocked
```

| Stage | Set By | Meaning |
|-------|--------|---------|
| `new` | `/mgw:project` or manual | Issue exists but has not been analyzed |
| `triaged` | `/mgw:issue` | Triage complete: scope, route, and security assessed |
| `planning` | `/mgw:run` | GSD planner agent is creating PLAN.md |
| `diagnosing` | `/mgw:run` | Diagnosis agent investigating root cause (gsd:diagnose-issues route) |
| `executing` | `/mgw:run` | GSD executor agent is writing code |
| `verifying` | `/mgw:run` | GSD verifier agent is checking results |
| `pr-created` | `/mgw:run` | PR has been opened on GitHub |
| `done` | `/mgw:run` or `/mgw:sync` | PR merged, issue closed, state archived |
| `failed` | `/mgw:run` or `/mgw:milestone` | Pipeline failed, no PR created |
| `blocked` | `/mgw:run` | Blocking comment detected, pipeline paused |

### Issue State Schema

Each active issue has a JSON state file at `.mgw/active/<number>-<slug>.json`:

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
    "scope": { "files": 3, "systems": ["auth", "middleware"] },
    "validity": "confirmed",
    "security_notes": "Touches auth tokens",
    "conflicts": [],
    "last_comment_count": 2,
    "last_comment_at": "2026-02-25T10:00:00Z"
  },
  "gsd_route": "quick",
  "gsd_artifacts": { "type": "quick", "path": ".planning/quick/3-fix-auth" },
  "pipeline_stage": "executing",
  "comments_posted": ["triage-complete", "work-started"],
  "linked_pr": null,
  "linked_issues": [],
  "linked_branches": ["issue/42-fix-auth"]
}
```

### Cross-References

`.mgw/cross-refs.json` maintains bidirectional links between issues, PRs, and branches:

```json
{
  "links": [
    { "a": "issue:42", "b": "issue:43", "type": "related", "created": "..." },
    { "a": "issue:42", "b": "pr:85", "type": "implements", "created": "..." },
    { "a": "issue:42", "b": "branch:issue/42-fix-auth", "type": "tracks", "created": "..." }
  ]
}
```

Link types: `related` (issue-to-issue), `implements` (issue-to-PR), `tracks` (issue/PR-to-branch), `maps-to` (GitHub milestone ↔ GSD milestone).

The `maps-to` link format: `{ "a": "milestone:3", "b": "gsd-milestone:v1.0", "type": "maps-to" }`. These links are written by `milestone_mapper` during `mgw:project` and verified by `mgw:sync` (checks that the GSD milestone ID exists in `.planning/ROADMAP.md` or `.planning/MILESTONES.md`).

### Project State

`.mgw/project.json` holds the full project structure when scaffolded via `/mgw:project`:

- Milestone definitions with GitHub milestone numbers
- Phase structure within each milestone
- Issue list with GitHub issue numbers, dependency slugs, and pipeline stages
- Active milestone pointer (dual-schema: legacy integer + new string ID)

**Schema changes introduced in v3:**

| Field | Type | Notes |
|-------|------|-------|
| `current_milestone` | integer (1-indexed) | Legacy — kept for backward compat |
| `active_gsd_milestone` | string \| null | Canonical active pointer (e.g. `"v1.1"`) |
| `milestones[].gsd_milestone_id` | string \| null | Links to GSD milestone (e.g. `"v1.0"`) |
| `milestones[].gsd_state` | `"active"\|"completed"\|"planned"\|null` | GSD execution state |
| `milestones[].roadmap_archived_at` | ISO timestamp \| null | Set on milestone completion |
| `milestones[].issues[].board_item_id` | string \| null | GitHub Projects v2 item ID |

`migrateProjectState()` in `lib/state.cjs` upgrades older `project.json` files to include these fields idempotently — it runs automatically at `validate_and_load` startup. Always use `resolveActiveMilestoneIndex(state)` to read the active milestone; never read `current_milestone` directly.

### Staleness Detection

MGW runs lightweight staleness checks on every command that touches state:

- **Per-issue**: compares GitHub `updatedAt` timestamp with local state file modification time
- **Batch (milestone-level)**: single GraphQL call to check all open issues at once

If stale state is detected, MGW auto-syncs with a notice. If the check fails (network error, API limit), MGW continues silently -- staleness detection never blocks command execution.

### Comment Tracking

During triage, MGW snapshots the issue's comment count and last comment timestamp. Before GSD execution begins, `/mgw:run` compares the current count against the snapshot. If new comments are found, a classification agent categorizes them:

| Classification | Meaning | Pipeline Action |
|---------------|---------|-----------------|
| **material** | Changes scope or requirements | Enrich context, continue |
| **informational** | Status update, acknowledgment | Log, continue |
| **blocking** | Explicit "stop" or "wait" | Pause pipeline |

---

## Agent Delegation Model

MGW delegates all code-touching work to Claude Code `Task()` agents. Each agent type has a specific role:

| Agent Type | Purpose | Spawned By |
|-----------|---------|------------|
| `general-purpose` | Triage, comment classification, PR body, question routing, debug diagnosis | `/mgw:issue`, `/mgw:run`, `/mgw:pr`, `/mgw:ask`, `/mgw:review` |
| `general-purpose` (vision-researcher) | Domain analysis for Fresh projects | `/mgw:project` |
| `general-purpose` (vision-synthesizer) | Produces structured Vision Brief JSON | `/mgw:project` |
| `general-purpose` (vision-condenser) | Condenses Vision Brief into handoff for gsd:new-project | `/mgw:project` |
| `general-purpose` (alignment-analyzer) | Reads `.planning/*`, produces alignment-report.json | `/mgw:project` (GSD-Only path) |
| `general-purpose` (drift-analyzer) | Compares project.json vs GitHub, produces drift-report.json | `/mgw:project` (Diverged path) |
| `gsd-planner` | Create PLAN.md from issue description and triage context | `/mgw:run` |
| `gsd-executor` | Execute plan tasks: read code, write code, commit | `/mgw:run` |
| `gsd-verifier` | Verify execution against plan goals | `/mgw:run` |
| `gsd-plan-checker` | Review plan structure and coverage (quick --full) | `/mgw:run` |

### Mandatory Context Injection

Every `Task()` spawn includes project context at the start of its prompt:

```markdown
<files_to_read>
- ./CLAUDE.md (Project instructions -- if exists, follow all guidelines)
- .agents/skills/ (Project skills -- if dir exists, list and read SKILL.md files)
</files_to_read>
```

This ensures agents inherit project-specific conventions, security requirements, and coding standards.

### Model Resolution

Agent models are never hardcoded. They are resolved at runtime through GSD tools:

```bash
PLANNER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-planner --raw)
EXECUTOR_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-executor --raw)
```

This allows users to configure which Claude models power each agent role.

### Agent Spawn Flow

```
MGW Command (e.g., /mgw:run)
    |
    |  1. Gather context (issue data, triage results, GSD init)
    |  2. Build prompt with mandatory CLAUDE.md injection
    |  3. Resolve model via gsd-tools
    |
    v
Task(
  prompt="...",
  subagent_type="gsd-planner",
  model="{resolved_model}",
  description="Plan: fix auth flow"
)
    |
    |  Agent executes in worktree context
    |  Agent reads code, creates PLAN.md
    |
    v
MGW reads structured result
    |
    |  Writes to .mgw/active/
    |  Updates pipeline_stage
    |  Posts status comment on GitHub
    |
    v
Next agent spawn (or PR creation)
```

---

## Slash Command Anatomy

Slash commands are plain Markdown files with YAML frontmatter. They are the primary interface for MGW users inside Claude Code.

### Structure

```markdown
---
name: mgw:command-name
description: One-line description for Claude Code's autocomplete
argument-hint: "<required-arg> [optional-arg]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Task
---

<objective>
What this command does and when to use it.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<context>
Runtime data: $ARGUMENTS, state files, etc.
</context>

<process>
<step name="step_name">
Step-by-step instructions for Claude to follow.
</step>
</process>

<success_criteria>
Checklist of conditions that must be true when the command completes.
</success_criteria>
```

### Key Elements

| Element | Purpose |
|---------|---------|
| `name` | The `/mgw:xyz` identifier shown in Claude Code |
| `allowed-tools` | Whitelist of Claude Code tools the command may use |
| `<objective>` | High-level intent (helps Claude understand without reading the full process) |
| `<execution_context>` | `@`-includes that inject shared workflow patterns |
| `<process>` | The step-by-step logic Claude executes |
| `<success_criteria>` | Exit conditions -- what must be true when the command finishes |

### Command Deployment

Commands live in two locations:

- **Source**: `commands/` in the repo (canonical, version-controlled)
- **Deployed**: `~/.claude/commands/mgw/` (where Claude Code reads them)

The `.claude/commands/mgw/` directory in the repo is a mirror of the deployed commands. Both locations contain identical files. Users deploy by copying:

```bash
cp -r .claude/commands/mgw/* ~/.claude/commands/mgw/
```

---

## CLI Architecture

The `mgw` CLI (`bin/mgw.cjs`) is a thin Node.js wrapper built with [Commander.js](https://github.com/tj/commander.js). It provides the same commands as slash commands but invoked from the terminal.

### Command Categories

Commands split into two categories based on whether they need Claude:

**AI-dependent commands** (require Claude CLI):

```
run, init, project, milestone, next, issue, update, pr
```

These call `assertClaudeAvailable()` to verify Claude is installed and authenticated, then invoke `claude -p --system-prompt-file <command.md>` with the bundled Markdown file as the system prompt.

**Non-AI commands** (work without Claude):

```
sync, issues, link, help
```

These call `lib/` modules directly. `sync` reads `.mgw/active/` and reconciles with GitHub. `issues` wraps `gh issue list`. `link` manages `.mgw/cross-refs.json`. `help` extracts text from the bundled `help.md`.

### Library Modules

```
lib/
  index.cjs             Barrel export -- re-exports all modules
  claude.cjs            Claude CLI detection, auth check, invocation via spawn
  github.cjs            Thin wrappers around gh CLI (issues, milestones, PRs, rate limit)
  gsd.cjs               GSD bridge -- resolves gsd-tools path, invokes gsd-tools commands
  state.cjs             .mgw/ directory management (paths, read/write project/issue state)
  output.cjs            Terminal output: TTY detection, ANSI colors, JSON formatting
  templates.cjs         Re-export of template-loader
  template-loader.cjs   JSON Schema validation for /mgw:project output
```

### How the CLI Invokes Claude

```
mgw run 42
    |
    v
bin/mgw.cjs (Commander.js)
    |
    |  1. assertClaudeAvailable() -- checks claude binary + auth
    |  2. Resolves command file: commands/run.md
    |
    v
claude -p --system-prompt-file commands/run.md "42"
    |
    |  Claude reads the Markdown as system prompt
    |  Claude executes the <process> steps
    |  Claude uses allowed tools (Bash, Read, Task, etc.)
    |
    v
Output streamed to terminal (or buffered with --quiet)
```

### Build System

The project uses [pkgroll](https://github.com/privatenumber/pkgroll) to bundle `bin/`, `lib/`, and `templates/` into `dist/`. The `package.json` `bin` field points to `dist/bin/mgw.cjs`. Source files use CommonJS (`require`/`module.exports`) with `.cjs` extensions throughout.

---

## Directory Structure

```
mgw/
  bin/
    mgw.cjs                   CLI entry point (Commander.js, 12 subcommands)
  lib/
    index.cjs                 Barrel export for all lib modules
    claude.cjs                Claude CLI detection and invocation
    github.cjs                GitHub API via gh CLI wrappers
    gsd.cjs                   GSD tools bridge (resolve path, invoke commands)
    state.cjs                 .mgw/ state management (read/write JSON)
    output.cjs                Terminal output utilities (color, TTY, JSON)
    templates.cjs             Template system re-export
    template-loader.cjs       JSON Schema validation for project output
  commands/                   Slash command source files (deployed to ~/.claude/commands/mgw/)
    ask.md                    Question routing during milestone execution
    help.md                   Command reference display
    init.md                   One-time repo bootstrap (state, templates, labels)
    issue.md                  Deep triage with agent analysis
    issues.md                 Issue browser with filters
    link.md                   Cross-referencing system
    milestone.md              Milestone execution with dependency ordering
    next.md                   Next unblocked issue picker
    pr.md                     PR creation from GSD artifacts
    project.md                AI-driven project scaffolding
    review.md                 Comment classification for in-progress issues
    run.md                    Autonomous pipeline orchestrator
    status.md                 Project status dashboard
    sync.md                   State reconciliation
    update.md                 Structured GitHub comment templates
  .claude/
    commands/
      mgw/                    Deployed slash commands (mirror of commands/)
        workflows/
          state.md            Shared state schema and initialization
          github.md           Shared GitHub CLI patterns
          gsd.md              GSD agent spawn templates and utility patterns
          validation.md       Delegation boundary rule and review checklist
  templates/
    schema.json               JSON Schema for /mgw:project output validation
    vision-brief-schema.json  JSON Schema for vision-synthesizer Vision Brief output
  docs/
    ARCHITECTURE.md           This file
  .github/
    ISSUE_TEMPLATE/           Bug report and feature request templates
    PULL_REQUEST_TEMPLATE.md  PR template with summary, changes, test plan
    workflows/                GitHub Actions (auto-labeler)
    labeler.yml               Label rules for auto-labeler
  CONTRIBUTING.md             Contributor guide with setup, style, and boundary rules
  README.md                   User-facing documentation
  package.json                Node.js package config (Commander.js, pkgroll)
  CODEOWNERS                  Code ownership rules
  LICENSE                     MIT
```

---

## Shared Workflow System

Slash commands include shared logic from `.claude/commands/mgw/workflows/` via `@`-include directives in their `<execution_context>` block. This avoids duplicating patterns across commands.

### Workflow Files

| File | What It Provides |
|------|-----------------|
| `state.md` | `validate_and_load` entry point, `.mgw/` directory schema, staleness detection (per-issue and batch), comment tracking, issue state schema, cross-refs schema, project state read/write, slug generation, timestamps |
| `github.md` | Copy-paste-ready `gh` CLI snippets for every GitHub operation MGW performs: issue CRUD, milestone CRUD, PR operations, label management, rate limit checks, GraphQL batch queries, release creation |
| `gsd.md` | `Task()` spawn templates with mandatory CLAUDE.md injection, model resolution patterns, comment classification agent template, quick pipeline pattern, milestone pipeline pattern, utility patterns (slugs, timestamps, progress, summaries, health checks, commits, verification) |
| `validation.md` | The delegation boundary rule, mechanical check, allowlist/denylist, review checklist, concrete examples, per-command boundary point table |

### Inclusion Pattern

Commands declare which workflows they need:

```markdown
<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>
```

When Claude Code processes the slash command, it reads the `@`-referenced files and includes their content as additional context. This gives every command access to shared patterns without copy-pasting.

### Consumer Map

Each workflow tracks which commands reference it:

- **state.md**: init, issue, run, update, link, pr, sync, milestone, ask (9 commands)
- **github.md**: issue, run, issues, sync, milestone, next, update, pr, init, project, ask (11 commands)
- **gsd.md**: run, issue, pr, ask, review (5 commands)
- **validation.md**: run, issue, review, pr, ask, sync, update, link, init, issues, help (all commands)

---

## GSD Artifact Flow into PRs

When GSD agents execute, they produce artifacts in the `.planning/` directory. MGW reads these artifacts to build PR descriptions. The data flow:

```
GSD Planner Agent
    |
    v
.planning/quick/3-fix-auth/3-PLAN.md
    - Tasks with files, actions, verification steps
    - must_haves (truths, artifacts, key_links)
    |
    v
GSD Executor Agent
    |
    v
.planning/quick/3-fix-auth/3-SUMMARY.md
    - One-liner summary
    - Key files created/modified
    - Technologies added
    - Patterns used
    - Decisions made
    |
    v
GSD Verifier Agent
    |
    v
.planning/quick/3-fix-auth/3-VERIFICATION.md
    - Goal achievement checklist
    - Test results
    |
    v
MGW PR Agent reads all three artifacts
    |
    |  gsd-tools summary-extract --> structured JSON
    |  (one_liner, key_files, tech_added, patterns, decisions)
    |
    v
PR Body:
    ## Summary         <-- from SUMMARY.md one_liner + key facts
    Closes #42
    ## Milestone Context <-- from .mgw/project.json
    ## Changes         <-- from SUMMARY.md key_files
    ## Test Plan       <-- from VERIFICATION.md checklist
```

MGW also runs non-blocking post-execution checks via `gsd-tools verify artifacts` and `gsd-tools verify key-links`. If these flag issues, they appear as warnings in the PR description rather than blocking creation.

The PR agent is a `general-purpose` type (no code execution). It reads the artifacts as text and composes the PR body. It never reads application source code -- it only works from GSD's structured output.

### Debug Artifacts

When the `gsd:diagnose-issues` route is used, the following artifact is created before execution:

```
.planning/debug/
  {slug}.md    (debug session: root cause, evidence, files involved, fix direction)
```

MGW may reference `.planning/debug/{slug}.md` when building context for the subsequent quick-fix execution agent. The debug artifact is not included in the PR body directly, but informs the planner agent that follows.

---

*This document describes MGW v3 architecture. For usage instructions, see the [README](../README.md). For contribution guidelines, see [CONTRIBUTING.md](../CONTRIBUTING.md).*
