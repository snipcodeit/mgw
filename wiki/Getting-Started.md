# Getting Started

This page covers everything you need to install MGW, set up your environment, and run your first pipeline.

---

## Prerequisites

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

> **Note:** Not all commands require all prerequisites. See [[Commands Reference]] for which commands need Claude Code and GSD vs. which work with just Node.js and the GitHub CLI.

---

## Installation

### Option 1: Full Install (CLI + Slash Commands)

This gives you both the standalone `mgw` CLI and the `/mgw:*` slash commands in Claude Code.

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

### Option 2: npx (No Install)

Try MGW without installing anything:

```bash
# See available commands
npx @snipcodeit/mgw --help

# List your open issues
npx @snipcodeit/mgw issues

# Sync local state with GitHub
npx @snipcodeit/mgw sync

# Cross-reference two issues
npx @snipcodeit/mgw link 42 43
```

`npx @snipcodeit/mgw` gives you the CLI subset that works without Claude Code. For the AI-powered pipeline commands (`run`, `issue`, `project`, `milestone`, etc.), do the full install.

### Option 3: Slash Commands Only (No CLI)

If you only want the Claude Code integration:

```bash
git clone https://github.com/snipcodeit/mgw.git
mkdir -p ~/.claude/commands/mgw/workflows
cp -r mgw/.claude/commands/mgw/* ~/.claude/commands/mgw/
```

### Option 4: Per-Project Slash Commands

To scope MGW commands to a specific project instead of installing globally:

```bash
cd your-project
mkdir -p .claude/commands/mgw/workflows
cp -r /path/to/mgw/.claude/commands/mgw/* .claude/commands/mgw/
```

---

## Verify Installation

```bash
# CLI verification
mgw --version

# Slash command verification
ls ~/.claude/commands/mgw/
# Expected: ask.md assign.md board.md help.md init.md issue.md issues.md link.md
#           milestone.md next.md pr.md project.md review.md roadmap.md
#           run.md status.md sync.md update.md workflows/
```

Then inside Claude Code:

```
/mgw:help
```

---

## npx vs Full Install

Not all commands work via `npx`. The CLI has two tiers:

| Tier | Commands | Requirements |
|------|----------|--------------|
| **CLI-only** (works with npx) | `issues`, `sync`, `link`, `help`, `--help`, `--version` | Node.js >= 18, `gh` CLI |
| **AI-powered** (requires full install) | `run`, `init`, `project`, `milestone`, `next`, `issue`, `update`, `pr`, `ask`, `review`, `assign`, `board`, `roadmap`, `status` | Node.js >= 18, `gh` CLI, Claude Code CLI, GSD |

AI-powered commands call `claude -p` under the hood and require the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) to be installed and authenticated. The slash command `.md` files must also be deployed to `~/.claude/commands/mgw/` for the full pipeline to work.

---

## Bootstrap a Repository

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

## Your First Pipeline

### Scenario 1: Run a Single Issue

If your repo already has open GitHub issues:

```bash
# 1. See what's assigned to you
/mgw:issues

# 2. Pick an issue and run the full pipeline
/mgw:run 42
# Creates branch, triages, plans via GSD, executes, opens PR

# 3. Review the PR, merge when ready
```

### Scenario 2: Scaffold a New Project

Starting from scratch:

```bash
# 1. Initialize the repo for MGW
/mgw:init

# 2. Scaffold milestones and issues from your description
/mgw:project
# MGW asks: "What are you building?"
# Generates milestones, phases, and issues.

# 3. See the execution plan
/mgw:milestone --dry-run

# 4. Execute the first milestone
/mgw:milestone
# Runs each issue in dependency order, creating PRs as it goes

# 5. Review and merge PRs as they are created
```

### Scenario 3: Manual Step-by-Step

For more control:

```bash
# Triage first
/mgw:issue 42

# Link related issues
/mgw:link 42 #43

# Run the pipeline (skips triage since already done)
/mgw:run 42

# Or create a PR manually
/mgw:pr 42 --base develop
```

---

## What Happens During `/mgw:run`

When you run `/mgw:run 42`, here is the full sequence:

1. **Validate** -- Load or create triage state for issue #42
2. **Worktree** -- Create isolated git worktree at `.worktrees/issue/42-<slug>/`
3. **Pre-flight** -- Check for new comments since triage
4. **Triage comment** -- Post structured triage results on the GitHub issue
5. **GSD execution** -- Run the appropriate GSD route (quick, quick --full, or new-milestone)
6. **Execution comment** -- Post commit count and file changes on the issue
7. **PR creation** -- Push branch, create PR with milestone context and test plan
8. **PR-ready comment** -- Post PR link on the issue
9. **Cleanup** -- Remove worktree, update state to `done`

Your main workspace stays on the default branch throughout. All work happens in the isolated worktree.

---

## Uninstalling

```bash
# Remove CLI
npm uninstall -g @snipcodeit/mgw

# Remove slash commands
rm -rf ~/.claude/commands/mgw/

# Remove local state (per-repo, if initialized)
rm -rf .mgw/
```

---

## Next Steps

- [[Commands Reference]] -- Full documentation for every command
- [[Workflow Guide]] -- End-to-end walkthroughs with examples
- [[Configuration]] -- Customize MGW for your workflow
