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

## Who This Is For

MGW is for **solo developers and small teams using Claude Code** who want their GitHub history to reflect the work they actually did — without spending time on project management.

**You'll get the most out of MGW if you:**

- Use [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) as your primary development tool
- Have a pile of GitHub issues that never get proper status updates, PR descriptions, or cross-references
- Want a repeatable issue-to-PR pipeline that handles triage, planning, execution, and documentation automatically
- Work across multiple projects and lose context switching between GitHub and your terminal

**When to use MGW vs. Claude Code directly:**

| Scenario | Use |
|----------|-----|
| One-off code changes with no issue tracking | Claude Code directly |
| Issues that need triage, planning, status updates, and PRs | MGW |
| Executing a backlog of issues in dependency order | MGW (`/mgw:milestone`) |
| Scaffolding a new project from a description | MGW (`/mgw:project`) |
| Quick code question or file edit | Claude Code directly |

**Prerequisites:**

- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) CLI installed and working
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated (`gh auth status`)
- [Get Shit Done](https://github.com/glittercowboy/get-shit-done) (GSD) installed in Claude Code
- A GitHub repository with issues enabled

If you're already using Claude Code and GSD for development, MGW is the missing piece that connects your work back to GitHub. If you're not using either yet, start with Claude Code, then add GSD, then add MGW.

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

## Troubleshooting

### GitHub CLI not authenticated

```
Error: gh: not logged in
```

Run `gh auth status` to check. If not authenticated:

```bash
gh auth login
# Select GitHub.com, HTTPS, and authenticate via browser
```

MGW requires the `repo` scope. If you're authenticated but getting permission errors, re-authenticate with the correct scopes:

```bash
gh auth login --scopes repo
```

### GSD not installed

```
Error: GSD slash commands not found
```

MGW delegates planning and execution to [Get Shit Done](https://github.com/glittercowboy/get-shit-done). Install it following the GSD README, then verify the commands are available in Claude Code:

```
/gsd:quick --help
```

### State file issues (.mgw/ directory)

**State drift** — Local `.mgw/` state can fall out of sync with GitHub if you merge PRs from the web UI, close issues manually, or work from a different machine. Run sync to reconcile:

```
/mgw:sync
```

**Corrupted state** — If `.mgw/` gets into a bad state, you can safely delete it and re-initialize:

```bash
rm -rf .mgw/
/mgw:init
```

This won't affect anything on GitHub. The `.mgw/` directory is local-only and gitignored.

**Missing .mgw/ directory** — If you cloned a repo that uses MGW but don't have a `.mgw/` directory, run init:

```
/mgw:init
```

### Worktree cleanup

MGW creates git worktrees in `.worktrees/` for each issue pipeline. If a pipeline fails mid-execution, stale worktrees can accumulate:

```bash
# List active worktrees
git worktree list

# Remove a specific stale worktree
git worktree remove .worktrees/issue/42-fix-auth

# Prune all stale worktree references
git worktree prune
```

The associated branches are not deleted automatically. Clean them up after removing the worktree:

```bash
git branch -d issue/42-fix-auth
```

### Rate limiting

MGW posts comments on GitHub issues at each pipeline stage. If you're executing many issues in quick succession (e.g., via `/mgw:milestone`), you may hit GitHub's API rate limits:

```
Error: API rate limit exceeded
```

Check your current rate limit status:

```bash
gh api rate_limit --jq '.resources.core'
```

If rate-limited, wait for the reset window (usually under an hour) or reduce the number of concurrent pipelines. Authenticated requests get 5,000 requests per hour — plenty for normal use, but milestone-level execution with many issues can approach the limit.

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Issue #N not found` | Issue doesn't exist or is in a different repo | Check the issue number and ensure you're in the correct repo |
| `Branch already exists` | A previous pipeline run created the branch | Delete the branch (`git branch -D issue/N-...`) or use the existing one |
| `No GSD route determined` | Triage couldn't determine issue scope | Run `/mgw:issue N` manually to inspect the triage output |
| `Merge conflict in worktree` | Main branch diverged during execution | Resolve conflicts in the worktree, then resume with `/mgw:run N` |
| `Permission denied` | GitHub token lacks required scopes | Re-authenticate: `gh auth login --scopes repo` |

### Uninstalling

```bash
# Remove CLI
npm unlink mgw

# Remove slash commands
rm -rf ~/.claude/commands/mgw/

# Remove local state (per-repo, if initialized)
rm -rf .mgw/
```

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
