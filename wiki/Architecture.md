# Architecture

This page describes the internal architecture of MGW: how it is structured, why it is structured that way, and how the pieces fit together.

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
GSD (execution layer -- planning, coding, verification)
    |
    |  reads/writes application code
    v
Your Codebase
```

MGW never touches application code. It reads GitHub state, manages pipeline state, and delegates all code-touching work to GSD agents. This separation is the core architectural principle.

---

## The Two-Layer Model

MGW and GSD serve distinct, complementary roles.

### MGW: The Orchestration Layer

MGW owns the GitHub lifecycle:

- **Issue triage** -- spawn analysis agents, store results, post structured comments
- **Pipeline sequencing** -- move issues through stages (new, triaged, planning, executing, verifying, pr-created, done)
- **State management** -- read/write `.mgw/` state files, track cross-references
- **GitHub communication** -- post status comments, create PRs, manage labels and milestones
- **Agent spawning** -- invoke Claude Code `Task()` agents with the right context
- **Worktree management** -- create isolated git worktrees, clean up after PR creation

### GSD: The Execution Layer

GSD owns planning, coding, and verification:

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

MGW never writes to `.planning/` state files. GSD never writes to `.mgw/`. The only shared surface is the GSD artifacts directory (PLAN.md, SUMMARY.md, VERIFICATION.md), which GSD writes and MGW reads.

---

## The Delegation Boundary

The delegation boundary is the architectural rule that keeps MGW and GSD separate. It has a mechanical check:

> **For any logic in an MGW command, ask: "If GSD improved this tomorrow, would MGW automatically benefit?"**

- **YES** -- the logic is correctly delegated
- **NO** -- the logic is misplaced in MGW

### What MGW May Do Directly

```
- Read/write .mgw/ state files (JSON)
- Read/write GitHub metadata (via gh CLI)
- Parse command arguments
- Display user-facing output
- Spawn Task() agents
- Call gsd-tools.cjs for utilities
- Manage git worktrees and branches
```

### What MGW Must Never Do

```
- Read application source code
- Write application source code
- Analyze code for scope, security, or conflicts
- Make architecture or implementation decisions
- Generate PR descriptions from code analysis (only from GSD artifacts)
- Run or interpret application tests
```

---

## Pipeline Data Flow

### mgw:project State-Aware Routing

`/mgw:project` reads five signals before deciding what to do:

| Signal | Meaning |
|--------|---------|
| P | `.mgw/project.json` exists |
| R | `.planning/ROADMAP.md` exists |
| S | GitHub milestones exist |
| M | `maps-to` cross-refs exist |
| G | GSD phase state exists |

| State | Signals | Path |
|-------|---------|------|
| Fresh | none | 6-stage Vision Collaboration Cycle → gsd:new-project → milestone_mapper |
| GSD-Only | R+G, no P/S | `alignment-analyzer` agent → milestone_mapper (backfill GitHub structure) |
| Aligned | P+R+S+M | Status report + interactive extend option |
| Diverged | P+S, R mismatch | `drift-analyzer` agent → reconciliation table |
| Extend | explicit | Add new milestones to existing project |

**Fresh path (Vision Collaboration Cycle):**
1. Intake -- freeform project description
2. Domain Expansion -- `vision-researcher` agent → `.mgw/vision-research.json`
3. Structured Questioning -- 3-8 rounds (soft cap), 15 max (hard cap) → `.mgw/vision-draft.md`
4. Vision Synthesis -- `vision-synthesizer` → `.mgw/vision-brief.json`
5. Review -- accept or revise loop
6. Condense -- `vision-condenser` → `.mgw/vision-handoff.md` → `gsd:new-project` Task spawn → `milestone_mapper`

### How an Issue Becomes a PR

End-to-end data flow for `/mgw:run`:

```
GitHub Issue #42
    |
    v
[1] VALIDATE & LOAD
    Parse issue number, check .mgw/active/ for existing state
    Cross-milestone check: if issue belongs to non-active milestone,
      gsd:quick → note + proceed, gsd:plan-phase → warn + switch/continue/abort
    |
    v
[2] CREATE WORKTREE
    Derive branch: issue/42-fix-auth
    git worktree add .worktrees/issue/42-fix-auth
    |
    v
[3] PRE-FLIGHT COMMENT CHECK
    Compare comment count with triage snapshot
    Classify new comments: material / informational / blocking
    |
    v
[4] POST TRIAGE COMMENT
    Structured comment: scope, route, files, security
    |
    v
[5] EXECUTE GSD
    Quick route: init -> plan -> execute -> verify
    Diagnose-issues route: pipeline_stage → "diagnosing"
      -> diagnosis agent -> root cause -> quick fix
    Milestone route: init -> roadmap gate -> (plan -> execute -> verify) per phase
    |
    v
[6] POST EXECUTION COMMENT
    Commit count, file changes, test status
    |
    v
[7] CREATE PR
    Push branch, read GSD artifacts, generate PR body
    PR includes: phase context, collapsed PLAN.md, verification
    |
    v
[8] CLEANUP
    Remove worktree, post pr-ready comment, update state
    |
    v
PR #85 ready for review
Issue #42 auto-closes on merge
```

---

## State Management

### The `.mgw/` Directory

```
.mgw/
  project.json          Milestones, issues, phases, dependency graph
  config.json           User prefs (GitHub username, default filters)
  active/               In-progress issue pipelines
    42-fix-auth.json    Per-issue state
  completed/            Archived after PR merge
  cross-refs.json       Bidirectional issue/PR/branch links
```

See [[Configuration]] for full details on each file.

### Pipeline Stages

```
new --> triaged --> planning --> executing --> verifying --> pr-created --> done
                     ^
                     |-- diagnosing (gsd:diagnose-issues route)
                                                                    \
                                                                     --> failed
                                                                     --> blocked
```

| Stage | Set By | Meaning |
|-------|--------|---------|
| `new` | `/mgw:project` or manual | Issue exists but has not been analyzed |
| `triaged` | `/mgw:issue` | Triage complete: scope, route, security assessed |
| `planning` | `/mgw:run` | GSD planner agent is creating PLAN.md |
| `diagnosing` | `/mgw:run` | Diagnosis agent investigating root cause (gsd:diagnose-issues route) |
| `executing` | `/mgw:run` | GSD executor agent is writing code |
| `verifying` | `/mgw:run` | GSD verifier agent is checking results |
| `pr-created` | `/mgw:run` | PR has been opened on GitHub |
| `done` | `/mgw:run` or `/mgw:sync` | PR merged, issue closed, state archived |
| `failed` | `/mgw:run` or `/mgw:milestone` | Pipeline failed, no PR created |
| `blocked` | `/mgw:run` | Blocking comment detected, pipeline paused |

### Staleness Detection

MGW runs lightweight staleness checks on every command that touches state:

- **Per-issue**: compares GitHub `updatedAt` timestamp with local state file modification time
- **Batch (milestone-level)**: single GraphQL call to check all open issues at once

If stale state is detected, MGW auto-syncs with a notice. If the check fails (network error, API limit), MGW continues silently.

---

## Agent Delegation Model

MGW delegates all code-touching work to Claude Code `Task()` agents:

| Agent Type | Purpose | Spawned By |
|-----------|---------|------------|
| `general-purpose` | Triage, comment classification, PR body, question routing, debug diagnosis | `/mgw:issue`, `/mgw:run`, `/mgw:pr`, `/mgw:ask`, `/mgw:review` |
| `general-purpose` (vision-researcher) | Domain analysis for Fresh projects | `/mgw:project` |
| `general-purpose` (vision-synthesizer) | Produces structured Vision Brief JSON | `/mgw:project` |
| `general-purpose` (vision-condenser) | Condenses Vision Brief for gsd:new-project spawn | `/mgw:project` |
| `general-purpose` (alignment-analyzer) | Reads `.planning/*`, produces alignment-report.json | `/mgw:project` (GSD-Only) |
| `general-purpose` (drift-analyzer) | Compares project.json vs GitHub, produces drift-report.json | `/mgw:project` (Diverged) |
| `gsd-planner` | Create PLAN.md from issue description and triage context | `/mgw:run` |
| `gsd-executor` | Execute plan tasks: read code, write code, commit | `/mgw:run` |
| `gsd-verifier` | Verify execution against plan goals | `/mgw:run` |
| `gsd-plan-checker` | Review plan structure and coverage (quick --full) | `/mgw:run` |

### Mandatory Context Injection

Every `Task()` spawn includes project context at the start of its prompt:

```markdown
<files_to_read>
- ./CLAUDE.md (Project instructions)
- .agents/skills/ (Project skills)
</files_to_read>
```

This ensures agents inherit project-specific conventions, security requirements, and coding standards.

### Model Resolution

Agent models are resolved at runtime through GSD tools:

```bash
PLANNER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-planner --raw)
EXECUTOR_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-executor --raw)
```

---

## Slash Command Anatomy

Slash commands are plain Markdown files with YAML frontmatter:

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

### Command Deployment

Commands live in two locations:

- **Source**: `commands/` in the repo (canonical, version-controlled)
- **Deployed**: `~/.claude/commands/mgw/` (where Claude Code reads them)

---

## CLI Architecture

The `mgw` CLI (`bin/mgw.cjs`) is a thin Node.js wrapper built with [Commander.js](https://github.com/tj/commander.js).

### How the CLI Invokes Claude

```
mgw run 42
    |
    v
bin/mgw.cjs (Commander.js)
    |
    |  1. assertClaudeAvailable()
    |  2. Resolves command file: commands/run.md
    |
    v
claude -p --system-prompt-file commands/run.md "42"
    |
    |  Claude reads Markdown as system prompt
    |  Claude executes the <process> steps
    |
    v
Output streamed to terminal
```

### Library Modules

```
lib/
  index.cjs             Barrel export
  claude.cjs            Claude CLI detection and invocation
  github.cjs            GitHub API via gh CLI wrappers
  gsd.cjs               GSD tools bridge
  state.cjs             .mgw/ state management
  output.cjs            Terminal output utilities
  templates.cjs         Template system re-export
  template-loader.cjs   JSON Schema validation
```

---

## Shared Workflow System

Slash commands include shared logic from `.claude/commands/mgw/workflows/` via `@`-include directives:

| File | What It Provides |
|------|-----------------|
| `state.md` | Entry point, `.mgw/` schema, staleness detection, comment tracking, slug generation |
| `github.md` | `gh` CLI snippets for every GitHub operation MGW performs |
| `gsd.md` | `Task()` spawn templates, model resolution, pipeline patterns |
| `validation.md` | Delegation boundary rule, mechanical check, review checklist |

---

## GSD Artifact Flow into PRs

When GSD agents execute, they produce artifacts that MGW reads for PR descriptions:

```
GSD Planner --> .planning/quick/3-fix-auth/3-PLAN.md
    |
GSD Executor --> .planning/quick/3-fix-auth/3-SUMMARY.md
    |
GSD Verifier --> .planning/quick/3-fix-auth/3-VERIFICATION.md
    |
MGW PR Agent reads all three artifacts
    |
    v
PR Body:
    ## Summary         <-- from SUMMARY.md
    Closes #42
    ## Milestone Context <-- from .mgw/project.json
    ## Changes         <-- from SUMMARY.md key_files
    ## Test Plan       <-- from VERIFICATION.md
```

The PR agent is a `general-purpose` type (no code execution). It reads artifacts as text and composes the PR body. It never reads application source code.

---

## Directory Structure

```
mgw/
  bin/
    mgw.cjs                   CLI entry point (Commander.js)
  lib/
    index.cjs                 Barrel export
    claude.cjs                Claude CLI detection and invocation
    github.cjs                GitHub API via gh CLI wrappers
    gsd.cjs                   GSD tools bridge
    state.cjs                 .mgw/ state management
    output.cjs                Terminal output utilities
    templates.cjs             Template system re-export
    template-loader.cjs       JSON Schema validation
  commands/                   Slash command source files
    ask.md                    Question routing during milestone execution
    help.md                   Command reference display
    init.md                   One-time repo bootstrap
    issue.md                  Deep triage with agent analysis
    issues.md                 Issue browser with filters
    link.md                   Cross-referencing system
    milestone.md              Milestone execution with dependency ordering
    next.md                   Next unblocked issue picker
    pr.md                     PR creation from GSD artifacts
    project.md                AI-driven project scaffolding
    review.md                 Comment classification
    run.md                    Autonomous pipeline orchestrator
    status.md                 Project status dashboard
    sync.md                   State reconciliation
    update.md                 Structured GitHub comment templates
  .claude/commands/mgw/       Deployed slash commands
    workflows/
      state.md                Shared state schema
      github.md               Shared GitHub CLI patterns
      gsd.md                  GSD agent spawn templates
      validation.md           Delegation boundary rules
  templates/
    schema.json               JSON Schema for /mgw:project output
  docs/
    ARCHITECTURE.md           Detailed architecture document
    USER-GUIDE.md             Comprehensive user guide
```

---

## Next Steps

- [[Commands Reference]] -- What every command does
- [[Configuration]] -- State files, schemas, and settings
- [[Workflow Guide]] -- Practical usage patterns
