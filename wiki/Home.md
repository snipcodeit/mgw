# MGW -- My GSD Workflow

> Issue in. PR out. No excuses.

**MGW** is a GitHub-native issue-to-PR automation tool for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), powered by [Get Shit Done](https://github.com/glittercowboy/get-shit-done) (GSD).

Point it at a GitHub issue. It triages the issue, plans the work, executes through GSD, and opens a pull request -- posting structured status comments at every stage.

```
/mgw:run 42
```

That's it. One command takes an issue from open to PR-ready.

---

## How It Works

```
GitHub Issue #42
    |
    v
MGW triages (scope, validity, security, conflicts)
    |
    v
MGW creates isolated worktree
    |
    v
GSD plans and executes code changes
    |
    v
MGW creates PR with structured description
    |
    v
PR #85 ready for review -- issue auto-closes on merge
```

MGW handles the orchestration (GitHub metadata, state tracking, status comments, PR creation). GSD handles the execution (planning, coding, verification). MGW never touches application code.

---

## Quick Navigation

| Page | Description |
|------|-------------|
| [[Getting Started]] | Installation, prerequisites, first run |
| [[Commands Reference]] | All `/mgw:*` commands with usage, flags, and examples |
| [[Workflow Guide]] | End-to-end walkthroughs: triage to PR, milestone execution |
| [[Architecture]] | Two-layer model, pipeline flow, state management, agent delegation |
| [[Configuration]] | `.mgw/` directory, project.json, config.json, templates |
| [[Troubleshooting]] | Common issues and solutions |

---

## Who This Is For

MGW is for **solo developers and small teams using Claude Code** who want their GitHub history to reflect the work they actually did -- without spending time on project management.

You'll get the most out of MGW if you:

- Use [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) as your primary development tool
- Have a pile of GitHub issues that never get proper status updates or PR descriptions
- Want a repeatable issue-to-PR pipeline that handles triage, planning, execution, and documentation automatically
- Work across multiple projects and lose context switching between GitHub and your terminal

---

## Key Concepts

### The Two-Layer Model

MGW and GSD serve distinct roles:

- **MGW** (orchestration layer) -- owns GitHub metadata, pipeline state, status comments, PR creation, worktree management
- **GSD** (execution layer) -- owns planning, coding, verification, `.planning/` directory

MGW never writes application code. GSD never writes to `.mgw/`. This separation is the core architectural principle.

### Pipeline Stages

Every issue progresses through:

```
new --> triaged --> planning --> executing --> verifying --> pr-created --> done
```

### GSD Routes

MGW selects a GSD route based on issue scope:

| Issue Size | Files | Route | Description |
|-----------|-------|-------|-------------|
| Small | 1-2 | `quick` | Single-pass plan + execute |
| Medium | 3-8 | `quick --full` | Plan with verification loop |
| Large | 9+ | `new-milestone` | Full milestone with phased execution |

---

## Links

- [GitHub Repository](https://github.com/snipcodeit/mgw)
- [npm Package](https://www.npmjs.com/package/mgw)
- [Get Shit Done (GSD)](https://github.com/glittercowboy/get-shit-done)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
