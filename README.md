# MGW — My GSD Workflow

> Issue in. PR out. No excuses.

**GitHub-native issue-to-PR automation for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), powered by [Get Shit Done](https://github.com/glittercowboy/get-shit-done).**

MGW bridges GitHub Issues and the GSD planning framework into a single pipeline. Point it at an issue, and it triages, plans, executes, and opens a PR — posting structured status updates at every stage. No context switching, no tab juggling, no copy-pasting between GitHub and your terminal.

```
/mgw:run 42
```

That's it. One command takes an issue from open to PR-ready.

---

## What It Does

MGW is a [Claude Code slash command](https://docs.anthropic.com/en/docs/claude-code/slash-commands) suite and standalone Node.js CLI that automates the lifecycle of a GitHub issue:

```
  /mgw:project               Scaffold milestones + issues from a description
       |
  /mgw:issue 42              Triage: scope, validity, security, conflicts
       |
  /mgw:run 42                Plan → Execute → Verify → PR (autonomous)
       |
  /mgw:milestone              Execute all issues in dependency order
       |
  PR created + status comments posted
       |
  Merge → issue auto-closes
```

Each step is composable. Use the full pipeline or pick individual commands.

## Why I Built This

I'm a solo developer. On any given day I might be writing a game server, reverse-engineering a VM, building a mobile app, or reorganizing my entire dotfiles setup for the third time this week. My brain has one mode: *build*. The part where you go back and update the issue, post a comment, open a PR with a nice description, cross-reference the other thing you broke — that part doesn't exist in my workflow. It's not that I don't care. It's that by the time the feature works, I've already mentally moved on to the next thing.

The result is a graveyard of GitHub issues that say "Fix auth" with zero follow-up, branches named things only I understand, and PRs that my past self apparently thought were self-documenting. They were not.

So I built MGW to be the responsible adult in the room. I point it at an issue, it does all the paperwork I was never going to do, and my GitHub history finally looks like a person who has their life together. It's the professional version of me that answers emails on time and keeps a clean desk — except it's a dozen Markdown files, a Node CLI, and Claude doing all the work.

## Commands

| Command | What it does |
|---------|-------------|
| `/mgw:project` | Scaffold a new project — generate milestones, issues, and persist project state |
| `/mgw:init` | Bootstrap repo for MGW — creates .mgw/ state, GitHub templates, gitignore entries |
| `/mgw:issues` | Browse and filter your GitHub issues |
| `/mgw:issue <n>` | Deep triage — scope analysis, security review, GSD route recommendation |
| `/mgw:next` | Show next unblocked issue based on dependency order |
| `/mgw:run <n>` | Full autonomous pipeline: triage through PR creation |
| `/mgw:milestone [n]` | Execute a milestone's issues in dependency order with checkpointing |
| `/mgw:update <n>` | Post structured status comments on issues |
| `/mgw:pr [n]` | Create PR from GSD artifacts with testing procedures |
| `/mgw:link <ref> <ref>` | Cross-reference issues, PRs, and branches |
| `/mgw:status [n]` | Project dashboard — milestone progress, issue stages, open PRs |
| `/mgw:sync` | Reconcile local state with GitHub |
| `/mgw:help` | Command reference |

## How Triage Works

`/mgw:issue` spawns an analysis agent that reads your codebase and evaluates the issue across five dimensions:

- **Scope** — which files and systems are affected, estimated size
- **Validity** — can the issue be confirmed by reading the code?
- **Purpose** — who benefits, what's the impact of inaction?
- **Security** — does it touch auth, user data, external APIs?
- **Conflicts** — does it overlap with other in-progress work?

Based on scope, MGW recommends a GSD route:

| Issue Size | GSD Route | What Happens |
|-----------|-----------|--------------|
| Small (1-2 files) | `gsd:quick` | Single-pass plan + execute |
| Medium (3-8 files) | `gsd:quick --full` | Plan with verification loop |
| Large (9+ files) | `gsd:new-milestone` | Full milestone with phased execution |

## Status Comments

Every pipeline step posts a structured comment on the issue so you (and your team) can follow along on GitHub without touching the terminal:

```
> MGW · `work-started` · 2026-02-26T03:31:00Z
> Milestone: v1.0 — Auth & Data Layer | Phase 1: Database Schema

### Work Started

| | |
|---|---|
| **Issue** | #71 — Implement user registration |
| **Route** | `plan-phase` |
| **Phase** | 1 of 6 — Database Schema |
| **Milestone** | v1.0 — Auth & Data Layer |

<details>
<summary>Milestone Progress (1/6 complete)</summary>
| # | Issue | Status | PR |
|---|-------|--------|----|
| 70 | Design SQLite schema | ✓ Done | #85 |
| **71** | **User registration** | ◆ In Progress | — |
| 72 | JWT middleware | ○ Pending | — |
</details>
```

Comments are posted for: `work-started`, `triage-complete`, `execution-complete`, `pr-ready`, and `pipeline-failed`. The milestone orchestrator handles all comment posting directly (not delegated to sub-agents), guaranteeing every stage is logged.

## PR Descriptions

PRs follow a consistent structure with milestone context:

```markdown
## Summary
- 2-4 bullets of what was built and why

Closes #71

## Milestone Context
- **Milestone:** v1.0 — Auth & Data Layer
- **Phase:** 1 — Database Schema
- **Issue:** 2 of 6 in milestone

## Changes
- File-level changes grouped by module

## Test Plan
- Verification checklist
```

## State Management

MGW tracks pipeline state in a local `.mgw/` directory (gitignored, per-developer):

```
.mgw/
  project.json         Milestones, issues, phases, and pipeline stages
  config.json          User prefs (GitHub username, default filters)
  active/              In-progress issue pipelines
    42-fix-auth.json   Issue state: triage results, pipeline stage, artifacts
  completed/           Archived after PR merge
  cross-refs.json      Bidirectional issue/PR/branch links
```

Pipeline stages flow: `new` → `triaged` → `planning` → `executing` → `verifying` → `pr-created` → `done` (or `failed`)

The `/mgw:sync` command reconciles local state with GitHub reality — archiving completed work, flagging stale branches, and catching drift.

## Requirements

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) (CLI)
- [Get Shit Done](https://github.com/glittercowboy/get-shit-done) (GSD) installed in Claude Code
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated
- A GitHub repository with issues enabled

## Quick Start

Try MGW without installing anything:

```bash
# See available commands
npx mgw --help

# List your open issues
npx mgw issues

# Sync local state with GitHub
npx mgw sync

# Cross-reference two issues
npx mgw link 42 43
```

`npx mgw` gives you the full CLI subset that works without Claude Code. For the AI-powered pipeline commands (`run`, `issue`, `project`, `milestone`, etc.), do a full install below.

## Installation

### Full install (CLI + slash commands)

```bash
git clone https://github.com/snipcodeit/mgw.git
cd mgw
npm install && npm run build
npm link

# Deploy slash commands to Claude Code
mkdir -p ~/.claude/commands/mgw/workflows
cp -r .claude/commands/mgw/* ~/.claude/commands/mgw/
```

### Slash commands only (no CLI)

If you only want the Claude Code slash commands:

```bash
git clone https://github.com/snipcodeit/mgw.git
mkdir -p ~/.claude/commands/mgw/workflows
cp -r mgw/.claude/commands/mgw/* ~/.claude/commands/mgw/
```

### Verify

```bash
# CLI (if installed)
mgw --version

# Slash commands
ls ~/.claude/commands/mgw/
# help.md  init.md  issue.md  issues.md  link.md  milestone.md  next.md
# pr.md  project.md  run.md  status.md  sync.md  update.md  workflows/
```

Then in Claude Code:

```
/mgw:help
```

### npx vs full install

Not all commands work via `npx`. The CLI has two tiers:

| Tier | Commands | Requirements |
|------|----------|--------------|
| **CLI-only** (works with npx) | `issues`, `sync`, `link`, `help`, `--help`, `--version` | Node.js >= 18, `gh` CLI |
| **AI-powered** (requires full install) | `run`, `init`, `project`, `milestone`, `next`, `issue`, `update`, `pr` | Node.js >= 18, `gh` CLI, Claude Code CLI, GSD |

AI-powered commands call `claude -p` under the hood and require the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) to be installed and authenticated. The slash command `.md` files must also be deployed to `~/.claude/commands/mgw/` for the full pipeline to work. Use `npx mgw` to explore the CLI and verify your GitHub setup before committing to a full install.

## Typical Workflow

### New project (from scratch)

```bash
# 1. Scaffold milestones and issues from a project description
/mgw:project

# 2. Execute the first milestone (issues run in dependency order)
/mgw:milestone

# 3. Review PRs as they're created, merge when ready
```

### Existing issues

```bash
# 1. See what's assigned to you
/mgw:issues

# 2. Pick the next unblocked issue
/mgw:next

# 3. Run the full pipeline
/mgw:run 42
# → Creates branch, triages (if needed), plans via GSD, executes,
#   verifies, opens PR, posts status comments on the issue

# 4. Review the PR, merge when ready
```

### Manual control

```bash
/mgw:issue 42                          # Triage
/mgw:link 42 #43                       # Cross-reference related issue
/mgw:update 42 "blocked on #43"        # Post custom status
/mgw:pr 42 --base develop              # Create PR to specific base
/mgw:sync                              # Clean up stale state
```

## Project Structure

```
bin/
  mgw.cjs                 CLI entry point (Commander.js)
lib/
  index.cjs               Barrel export
  claude.cjs              Claude Code invocation helpers
  github.cjs              GitHub CLI wrappers (issues, PRs, milestones, Projects v2)
  gsd.cjs                 GSD integration
  state.cjs               .mgw/ state management
  output.cjs              Logging and formatting
  templates.cjs           Template system
  template-loader.cjs     Output validation (JSON Schema)
commands/                  Slash command source files (deployed to ~/.claude/commands/mgw/)
  help.md                 Command reference display
  init.md                 One-time repo bootstrap (state, templates, labels)
  project.md              AI-driven project scaffolding (milestones, issues, dependencies)
  issues.md               Issue browser with filters
  issue.md                Deep triage with agent analysis
  next.md                 Next unblocked issue picker
  run.md                  Autonomous pipeline orchestrator
  milestone.md            Milestone execution with dependency ordering and status comments
  update.md               Structured GitHub comment templates
  pr.md                   PR creation from GSD artifacts with milestone context
  link.md                 Cross-referencing system
  status.md               Project status dashboard and milestone progress query
  sync.md                 State reconciliation
templates/
  schema.json             JSON Schema for project output validation
.claude/
  commands/
    mgw/                   Deployed slash commands (symlinked or copied)
      workflows/
        state.md           Shared state schema and initialization
        github.md          Shared GitHub CLI patterns
        gsd.md             GSD agent spawn templates
        validation.md      Delegation boundary rules
```

## Acknowledgments

MGW wouldn't exist without **[Get Shit Done](https://github.com/glittercowboy/get-shit-done)** by [Lex Christopherson](https://github.com/glittercowboy) — a structured project management framework for Claude Code that handles planning, execution, and verification. GSD does the heavy lifting; MGW just connects it to GitHub so the rest of the world can see what you actually accomplished.

Seriously, if you're using Claude Code for development, go install GSD. MGW is just the GitHub layer on top.

## Contributing

MGW is young and there's plenty of room to make it better:

- **GitHub Projects v2 board integration** — currently scaffolds issues but needs `project` OAuth scope for board creation
- **Multi-repo support** — monorepo and cross-repo issue tracking
- **GitHub Actions integration** — trigger MGW from CI events
- **Review cycle automation** — handle PR review comments → fix → re-request
- **Dashboard** — terminal UI for pipeline visualization
- **Webhook support** — react to issue assignments and label changes in real-time

The slash commands are plain Markdown with a simple frontmatter + process structure. The CLI is a lightweight Node.js wrapper (`bin/mgw.cjs`) that delegates AI work to Claude and handles non-AI commands (sync, issues, link) directly. If any of the above interests you, open an issue or submit a PR. I promise MGW will keep mine updated even if I won't.

## License

[MIT](LICENSE)
