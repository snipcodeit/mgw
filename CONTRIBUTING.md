# Contributing to MGW

Thanks for considering a contribution. MGW is a small but opinionated project, and this guide covers everything you need to get started, ship a change, and avoid the one architectural mistake that will get your PR rejected.

## Table of Contents

- [Local Development Setup](#local-development-setup)
- [Code Style](#code-style)
- [Adding or Modifying Slash Commands](#adding-or-modifying-slash-commands)
- [Testing Changes](#testing-changes)
- [The Delegation Boundary (Read This First)](#the-delegation-boundary)
- [PR Process](#pr-process)
- [Publishing](#publishing)
- [GSD as a Model](#gsd-as-a-model)

---

## Local Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) (CLI)
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated
- [Get Shit Done](https://github.com/glittercowboy/get-shit-done) (GSD) installed at `~/.claude/get-shit-done/`

### Clone and Build

```bash
git clone https://github.com/snipcodeit/mgw.git
cd mgw
npm install
npm run build
```

`npm run build` uses [pkgroll](https://github.com/privatenumber/pkgroll) to bundle `bin/`, `lib/`, and `templates/` into `dist/`. The built output is gitignored.

### Link for Local Development

```bash
npm link
```

This puts the `mgw` CLI on your PATH so you can run `mgw --version` from anywhere. Changes require a rebuild (`npm run build`) to take effect, or use the watch mode:

```bash
npm run dev
```

`npm run dev` runs pkgroll in watch mode — it rebuilds automatically when you save a file.

### Deploy Slash Commands

```bash
mkdir -p ~/.claude/commands/mgw/workflows
cp -r .claude/commands/mgw/* ~/.claude/commands/mgw/
```

After copying, slash commands like `/mgw:help` and `/mgw:run` are available inside Claude Code.

### Verify

```bash
# CLI
mgw --version

# Slash commands
ls ~/.claude/commands/mgw/
# Should list: help.md, init.md, issue.md, issues.md, link.md,
#              milestone.md, next.md, pr.md, project.md, run.md,
#              sync.md, update.md, workflows/
```

---

## Code Style

### Language and Module System

- **CommonJS** (`require`/`module.exports`) throughout — no ESM.
- File extension is `.cjs` for all JavaScript files.
- `'use strict';` at the top of every file.

### File Naming

- `kebab-case.cjs` for all JavaScript files.
- Slash commands are `kebab-case.md` in `commands/`.
- Workflow includes are `kebab-case.md` in `.claude/commands/mgw/workflows/`.

### Structure Patterns

- **`lib/`** — Each module exports a focused set of functions. All modules are re-exported through `lib/index.cjs` (barrel export), so consumers can do:
  ```js
  const { loadProjectState, getIssue } = require('./lib/index.cjs');
  ```
- **`bin/mgw.cjs`** — CLI entry point using [Commander.js](https://github.com/tj/commander.js). Thin wrapper that delegates to `lib/` functions.
- **`commands/`** — Slash command source files (Markdown with YAML frontmatter).
- **`templates/`** — JSON Schema and template files for output validation.

### General Expectations

- No TypeScript. The project is intentionally plain CommonJS for simplicity.
- Keep functions small and focused. Each `lib/*.cjs` file should have a clear, single responsibility.
- Use JSDoc comments for exported functions (parameters, return types, throws).
- Error messages should be specific and actionable — tell the user what went wrong and what to do about it.

---

## Adding or Modifying Slash Commands

Slash commands are the primary interface for MGW users inside Claude Code. They live in `commands/` and get deployed to `~/.claude/commands/mgw/`.

### Anatomy of a Slash Command

Every command file is Markdown with this structure:

```markdown
---
name: mgw:command-name
description: One-line description shown in Claude Code's command list
argument-hint: "<required-arg> [optional-arg]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Task
---

<objective>
What this command does and when to use it. No side effects description.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
</execution_context>

<process>
Step-by-step instructions for Claude to follow.
</process>
```

### Key Elements

| Element | Purpose |
|---------|---------|
| `name` | The `/mgw:xyz` identifier. Must be unique. |
| `description` | Shows in Claude Code's command autocomplete. Keep it under 80 chars. |
| `argument-hint` | Displayed after the command name. Use `<>` for required, `[]` for optional. |
| `allowed-tools` | Whitelist of Claude Code tools the command may use. Only include what's needed. |
| `<objective>` | High-level purpose. Helps Claude understand intent without reading the full process. |
| `<execution_context>` | `@`-includes for shared workflow files. These inject shared patterns (state loading, GitHub CLI wrappers, GSD templates). |
| `<process>` | The actual step-by-step logic. This is what Claude executes. |

### Shared Workflows

Commands include shared logic from `.claude/commands/mgw/workflows/`:

| Workflow | What It Provides |
|----------|-----------------|
| `state.md` | State management — `validate_and_load`, staleness detection, `.mgw/` schema |
| `github.md` | GitHub CLI patterns — issues, PRs, labels, comments, milestones |
| `gsd.md` | GSD integration — `Task()` spawn templates, CLAUDE.md injection |
| `validation.md` | The delegation boundary rule (see below) |

If your command needs state, GitHub access, or GSD delegation, include the relevant workflow file. Don't duplicate patterns that already exist in a workflow.

### Adding a New Command

1. Create `commands/your-command.md` following the anatomy above.
2. Include the appropriate workflow files in `<execution_context>`.
3. Add the command to the help text in `commands/help.md`.
4. Test by copying to `~/.claude/commands/mgw/` and running in Claude Code.
5. Update the README command table if the command is user-facing.

### Modifying an Existing Command

1. Read the full command file and its included workflows before making changes.
2. Run the command in Claude Code before and after your change to verify behavior.
3. If you're changing shared workflow files, check all commands that include them.

---

## Testing Changes

MGW doesn't have a formal test suite yet. Testing is manual but follows a consistent process.

### Build Verification

After any code change:

```bash
npm run build
```

If the build fails, fix it before proceeding. pkgroll will report bundling errors clearly.

### CLI Testing

```bash
# Verify the CLI starts
mgw --version
mgw --help

# Test specific subcommands (if you changed them)
mgw sync
mgw issues
```

### Slash Command Testing

1. Copy your modified command to the Claude Code commands directory:
   ```bash
   cp commands/your-command.md ~/.claude/commands/mgw/
   ```
2. Open Claude Code in a test repository.
3. Run the command: `/mgw:your-command`
4. Verify the output matches expectations.

### What to Check

- **Build succeeds** — `npm run build` completes without errors.
- **CLI starts** — `mgw --version` prints the version from `package.json`.
- **Commands load** — slash commands appear in Claude Code's autocomplete.
- **State files** — if your change touches `.mgw/` state, verify the JSON schema is correct.
- **GitHub operations** — if your change posts comments or creates PRs, test with a real repo (use a test repo, not someone else's project).
- **Delegation boundary** — if your change is in a slash command, verify it doesn't read or write application code directly (see below).

---

## The Delegation Boundary

This is the most important architectural concept in MGW. If you internalize one thing from this guide, make it this:

> **MGW orchestrates. MGW never codes.**

MGW connects GitHub issues to GSD's execution engine. It reads state, writes state, talks to GitHub, and spawns agents. It **never** reads application source code, writes application source code, or makes implementation decisions.

### The Mechanical Check

For any logic you're adding to an MGW command, ask:

> "If GSD improved this tomorrow, would MGW automatically benefit?"

- **YES** — The logic is correctly delegated. It lives in a `Task()` agent or in GSD itself.
- **NO** — The logic is misplaced. Move it into a `Task()` agent that MGW spawns.

### What MGW May Do Directly

```
- Read/write .mgw/ state files (JSON)
- Call GitHub API via gh CLI
- Parse command arguments
- Display output (banners, tables, prompts)
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
- Generate PR descriptions from code (only from GSD artifacts)
- Run or interpret application tests
```

### Example: Right vs. Wrong

**Wrong** — MGW analyzing code inline:
```markdown
Search the codebase for files related to the issue:
grep -r "auth" src/
Determine scope: "3 files affected, medium scope"
```

**Right** — MGW spawning an agent to do the analysis:
```markdown
Task(
  prompt="Analyze issue #42 against this codebase.
          Return: scope, validity, security, conflicts.",
  description="Triage issue #42"
)
# MGW reads the agent's structured result and writes it to .mgw/active/
```

The agent reads code and returns structured results. MGW reads those results, writes them to state, and presents them to the user. MGW never touches the code.

**If you're unsure**, default to spawning an agent. Over-delegation wastes tokens but doesn't break the architecture. Under-delegation (MGW reading code) creates maintenance debt and will get your PR rejected.

For the complete rule with a review checklist, see `.claude/commands/mgw/workflows/validation.md`.

---

## PR Process

### Branch Naming

Use the pattern: `<type>/<short-description>`

Examples:
- `feat/webhook-support`
- `fix/sync-stale-branches`
- `docs/contributing-guide`

### Before Opening a PR

1. **Build passes**: `npm run build` completes without errors.
2. **CLI works**: `mgw --version` runs successfully.
3. **Commands load**: any modified slash commands work in Claude Code.
4. **Delegation boundary**: if you touched a slash command, apply the [mechanical check](#the-mechanical-check) to every block of logic.
5. **No secrets**: double-check that `.env` files, API keys, or credentials are not staged.

### PR Structure

Use the [PR template](/.github/PULL_REQUEST_TEMPLATE.md). Every PR needs:

- **Summary** — 2-4 bullets covering what changed and why.
- **`Closes #N`** — Link to the issue this PR resolves.
- **Changes** — File-level changes grouped by area (Commands, Workflows, Lib, etc.).
- **Test Plan** — Checklist of how you verified the change works.

### Review Expectations

- PRs are reviewed for **architectural correctness** first (delegation boundary), **functionality** second, **style** third.
- Small, focused PRs are preferred. One issue per PR.
- If a PR touches a slash command, the reviewer will apply the delegation boundary checklist from `workflows/validation.md`.
- Expect feedback. The project is opinionated about its architecture, and that's intentional.

### After Merge

MGW tracks issue-to-PR state in `.mgw/`. After a PR is merged:
- The linked issue closes automatically (via `Closes #N`).
- Run `/mgw:sync` to archive local state and clean up stale branches.

---

## Publishing

MGW is published to [npm](https://www.npmjs.com/package/mgw) as a public package. Publishing is currently a manual process performed by maintainers.

### Prerequisites

- You must have an npm account with publish access to the `mgw` package.
- You must be logged in via the npm CLI.

### Publish Workflow

```bash
# 1. Authenticate with npm (one-time setup)
npm login

# 2. Build the package
npm run build

# 3. Verify the package contents before publishing
npm pack --dry-run

# 4. Publish to npm
npm publish
```

### Pre-publish Checklist

1. **Version bump** — Update `version` in `package.json` following [semver](https://semver.org/). Patch for fixes, minor for features, major for breaking changes.
2. **CHANGELOG updated** — Add an entry to `CHANGELOG.md` for the new version.
3. **Build passes** — `npm run build` completes without errors.
4. **CLI works** — `mgw --version` prints the expected version.
5. **Dry run clean** — `npm pack --dry-run` shows only intended files (check `.npmignore` if unexpected files appear).

### Future Work

CI-based publishing (e.g., GitHub Actions triggered on version tags) is planned but not yet implemented. For now, all publishes are manual and coordinated by maintainers.

---

## GSD as a Model

MGW is built on top of [Get Shit Done](https://github.com/glittercowboy/get-shit-done) (GSD) and follows its contribution philosophy:

- **Slash commands are plain Markdown** — no compiled code, no framework. Anyone can read, modify, and deploy them.
- **Thin orchestration** — the command file describes *what to do*, not *how to implement it*. Heavy work is delegated to agents.
- **Structured planning** — GSD uses `.planning/` directories with ROADMAP, PLAN, and SUMMARY documents. MGW wraps this in GitHub state (`.mgw/`) and adds issue/PR lifecycle management.
- **Convention over configuration** — file names, directory structures, and workflow patterns are predictable. Learn one command, and you can read any of them.

If you've contributed to GSD, you'll feel at home. If you haven't, read through a few MGW command files in `commands/` to see the pattern. Start with `commands/help.md` (simplest) and work up to `commands/run.md` (most complex).

---

## Questions?

Open an issue. MGW will probably triage it for you.
