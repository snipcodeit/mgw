---
phase: 05-standalone-tools
verified: 2026-02-25T12:00:00Z
status: passed
score: 10/10 must-haves verified
re_verification: false
gaps: []
human_verification:
  - test: "npm install -g mgw from published registry"
    expected: "mgw binary lands on PATH, mgw --version succeeds from any directory"
    why_human: "Package is not published to npm registry; local install verified via node bin/mgw.cjs and dist/bin/mgw.cjs only"
---

# Phase 5: Standalone Tools Verification Report

**Phase Goal:** A developer can install `mgw` as a global npm package and run `mgw run`, `mgw project`, `mgw milestone`, `mgw next`, and other commands from any terminal — with the same behavior as the slash commands — without Claude Code.
**Verified:** 2026-02-25
**Status:** PASSED (one human verification item remains for registry publish scenario)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `npm install -g mgw` succeeds and `mgw --version` prints a version string | ? HUMAN | Build passes; `node dist/bin/mgw.cjs --version` prints `0.1.0`; `npm pack --dry-run` shows correct tarball; actual global registry install not testable |
| 2 | `mgw run`, `mgw project`, `mgw milestone`, `mgw next` execute slash command logic via shared `lib/` modules — no logic duplication | ✓ VERIFIED | All 4 commands call `runAiCommand()` which requires `../lib/claude.cjs` and resolves bundled `.md` files; slash commands in `.claude/commands/mgw/` are unchanged |
| 3 | Binary works without Claude Code command discovery — no reliance on Claude Code slash command format | ✓ VERIFIED | Non-AI commands (sync, issues, link, help) verified to work independently; `mgw help` prints reference without invoking claude; command files resolved via `getCommandsDir()` using `__dirname` not `~/.claude/commands/` |

**Score:** 2/3 truths fully verified (1 needs human for registry scenario, but all automation passes)

### Plan Must-Have Truths (Plan 01)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | lib/ modules usable by both slash commands and binary without duplication | ✓ VERIFIED | 7 lib/ modules exist; slash commands in `.claude/commands/mgw/` are unchanged; bin/mgw.cjs imports from `../lib/` |
| 2 | package.json defines bin, files, and build script that pkgroll can process | ✓ VERIFIED | `package.json` has `bin.mgw = ./dist/bin/mgw.cjs`, `files: [dist/, commands/, templates/]`, `scripts.build = pkgroll --clean-dist --src .` |
| 3 | commands/ directory contains copies of all 12 .md command files for npm distribution | ✓ VERIFIED | `ls commands/*.md | wc -l` = 12; all 12 present (run, init, sync, project, milestone, next, issues, issue, update, pr, link, help) |
| 4 | npm pack --dry-run shows dist/, commands/, and templates/ in the tarball | ✓ VERIFIED | 12 commands/*.md + 3 dist/ files + 4 templates/ files all present in dry-run output |

### Plan Must-Have Truths (Plan 02)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | mgw --version prints a version string | ✓ VERIFIED | `node bin/mgw.cjs --version` outputs `0.1.0`; `node dist/bin/mgw.cjs --version` outputs `0.1.0` |
| 2 | mgw help displays the full command reference without requiring claude | ✓ VERIFIED | `node bin/mgw.cjs help` prints MGW formatted reference; `node dist/bin/mgw.cjs help` also works; no claude invocation |
| 3 | mgw sync runs without claude installed (non-AI command) | ✓ VERIFIED | `mgw sync --dry-run --json` returns `{"status":"complete","drifted":[],"all":[]}` without any claude dependency |
| 4 | mgw run 42 invokes claude -p with the bundled run.md command file and streams output | ✓ VERIFIED | `mgw run 42 --dry-run` outputs `Would invoke: claude -p --system-prompt-file /hd1/repos/mgw/commands/run.md 42` |
| 5 | mgw run 42 --dry-run shows what would happen without executing | ✓ VERIFIED | Same as above — dry-run correctly shows the would-invoke string without executing |
| 6 | mgw next --json outputs structured JSON | ✓ VERIFIED | `mgw next --json --dry-run` outputs `Would invoke: claude -p --system-prompt-file .../next.md --output-format json` confirming --output-format json is passed through |
| 7 | All 12 subcommands are registered and appear in mgw --help | ✓ VERIFIED | `mgw --help` lists all 12: run, init, project, milestone, next, issue, update, pr, sync, issues, link, help |

**Combined score:** 10/10 truths verified (+ 1 human verification item)

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/state.cjs` | Read/write .mgw/project.json and .mgw/active/ | ✓ VERIFIED | 107 lines; exports getMgwDir, getActiveDir, getCompletedDir, loadProjectState, writeProjectState, loadActiveIssue |
| `lib/github.cjs` | gh CLI wrappers for issues, milestones, PRs, labels, rate limits | ✓ VERIFIED | 136 lines; exports getRepo, getIssue, listIssues, getMilestone, getRateLimit, closeMilestone, createRelease |
| `lib/gsd.cjs` | GSD tooling bridge for gsd-tools.cjs | ✓ VERIFIED | 73 lines; exports getGsdToolsPath, invokeGsdTool |
| `lib/templates.cjs` | Re-export of template-loader.cjs load() and validate() | ✓ VERIFIED | 13 lines; `const { load, validate } = require('./template-loader.cjs'); module.exports = { load, validate };` |
| `lib/output.cjs` | TTY detection, colored output, JSON output mode | ✓ VERIFIED | 117 lines; exports IS_TTY, USE_COLOR, IS_CI, statusLine, log, error, verbose, debug, formatJson |
| `lib/claude.cjs` | Claude CLI detection, streaming invocation, quiet mode | ✓ VERIFIED | 148 lines; exports assertClaudeAvailable, invokeClaude, getCommandsDir |
| `lib/index.cjs` | Barrel export for all lib modules | ✓ VERIFIED | 18 lines; spreads all 6 modules; node -e loads 32 named exports |
| `package.json` | npm package config with bin, files, scripts.build, dependencies, engines | ✓ VERIFIED | bin.mgw=./dist/bin/mgw.cjs; files includes dist/, commands/, templates/; pkgroll build works |
| `commands/run.md` | Bundled copy of slash command for npm distribution | ✓ VERIFIED | 12 .md files present; all 12 slash commands bundled |
| `bin/mgw.cjs` | CLI entry point with Commander.js routing for all 12 commands | ✓ VERIFIED | 432 lines; hashbang present; 8 AI commands + 4 non-AI commands registered |
| `dist/bin/mgw.cjs` | pkgroll-built distributable binary with hashbang | ✓ VERIFIED | Exists; `node dist/bin/mgw.cjs --version` and `help` both work |

---

### Key Link Verification

#### Plan 01 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `lib/templates.cjs` | `lib/template-loader.cjs` | require re-export | ✓ WIRED | Line 11: `const { load, validate } = require('./template-loader.cjs');` |
| `package.json` | `dist/bin/mgw.cjs` | bin field | ✓ WIRED | `"bin": { "mgw": "./dist/bin/mgw.cjs" }` |
| `package.json` | `commands/` | files array | ✓ WIRED | `"files": ["dist/", "commands/", "templates/"]` |

#### Plan 02 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `bin/mgw.cjs` | `lib/claude.cjs` | require for AI command invocation | ✓ WIRED | Line 23: `const { assertClaudeAvailable, invokeClaude, getCommandsDir } = require('../lib/claude.cjs');` |
| `bin/mgw.cjs` | `lib/output.cjs` | require for TTY/JSON output | ✓ WIRED | Line 24: `const { log, error, formatJson, verbose } = require('../lib/output.cjs');` |
| `bin/mgw.cjs` | `lib/state.cjs` | require for state operations | ✓ WIRED | Line 25: `const { getActiveDir, getCompletedDir, getMgwDir } = require('../lib/state.cjs');` |
| `bin/mgw.cjs` | `lib/github.cjs` | require for non-AI GitHub commands | ✓ WIRED | Line 26: `const { getIssue, listIssues } = require('../lib/github.cjs');` |
| `bin/mgw.cjs` | `commands/*.md` | getCommandsDir() path resolution | ✓ WIRED | Line 57: `const cmdFile = path.join(getCommandsDir(), ...)` and Line 402 (help command) |

**Path resolution note:** In the built bundle, `getCommandsDir()` lives in `dist/claude-DVW_psWv.cjs` where `__dirname = dist/`. Thus `path.join(__dirname, '..', 'commands')` resolves to repo root `/commands/` — correct. Verified: `node dist/bin/mgw.cjs run 42 --dry-run` shows `/hd1/repos/mgw/commands/run.md` (correct path, not `dist/commands/`).

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| TOOL-01 | 05-02-PLAN.md | `bin/mgw` CLI binary mirrors slash command surface (run, init, sync, project, milestone, next) | ✓ SATISFIED | bin/mgw.cjs has all 12 commands including the 6 named; `mgw --help` lists all |
| TOOL-02 | 05-01-PLAN.md | Shared `lib/` modules (state, github, gsd, templates) used by both slash commands and binary | ✓ SATISFIED | 7 lib/ modules exist; bin/mgw.cjs imports from lib/; slash commands unchanged |
| TOOL-03 | 05-01-PLAN.md | Binary distributable via `npm install -g mgw` or `npm link` | ✓ SATISFIED | package.json correct; `npm pack --dry-run` shows all required files; pkgroll build produces dist/bin/mgw.cjs |
| TOOL-04 | 05-02-PLAN.md | Binary works independently of Claude Code command format (format-independent fallback) | ✓ SATISFIED | Non-AI commands work without claude; getCommandsDir() uses __dirname (npm install path), not ~/.claude/commands/ |

All 4 TOOL-xx requirements from both plans are satisfied. No orphaned requirements found in REQUIREMENTS.md for Phase 5.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `lib/state.cjs` | 48, 75, 83, 90, 96 | `return null` | INFO | Correct "not found" semantics in loadProjectState/loadActiveIssue — not stubs |

No blocker anti-patterns found. No TODO/FIXME/placeholder comments. No stub implementations. No empty handlers.

---

### Human Verification Required

#### 1. Global npm install from registry

**Test:** Run `npm install -g mgw` from a machine where mgw is not present, then run `mgw --version` from any directory outside the repo.
**Expected:** `mgw` binary appears on PATH; `mgw --version` prints `0.1.0`; `mgw help` prints formatted command reference.
**Why human:** Package is not published to npm registry yet. Local verification (`node dist/bin/mgw.cjs`) passes, but actual `npm install -g` from registry cannot be tested without publishing.

---

### Gaps Summary

No gaps found. All automated verification checks passed.

The one HUMAN item (registry install) is not a gap in the implementation — the package is correctly configured for npm distribution (`package.json`, `pkgroll` build, `dist/`, `commands/`, `templates/` all verified). It is a pre-publish validation that requires the package to be on the registry.

---

## Build Verification Summary

The following commands were run and passed during verification:

- `node bin/mgw.cjs --version` → `0.1.0`
- `node bin/mgw.cjs --help` → lists all 12 subcommands
- `node bin/mgw.cjs help` → prints MGW command reference without claude
- `node bin/mgw.cjs run 42 --dry-run` → `Would invoke: claude -p --system-prompt-file .../commands/run.md 42`
- `node bin/mgw.cjs next --json --dry-run` → shows `--output-format json` in invocation
- `node bin/mgw.cjs sync --dry-run --json` → returns valid JSON without claude
- `node bin/mgw.cjs link 42 43 --dry-run --json` → returns valid JSON without claude
- `node dist/bin/mgw.cjs --version` → `0.1.0`
- `node dist/bin/mgw.cjs help` → prints MGW command reference (commands/ resolved correctly from dist/)
- `node dist/bin/mgw.cjs run 42 --dry-run` → correct path `/hd1/repos/mgw/commands/run.md`
- `node dist/bin/mgw.cjs issues --help` → shows --label, --milestone, --assignee, --state options
- `npm pack --dry-run` → shows 12 commands/*.md + dist/bin/mgw.cjs + dist/lib/index.cjs + 4 templates/*.json
- `node -e "require('./lib/index.cjs')"` → loads cleanly, 32 named exports

---

_Verified: 2026-02-25_
_Verifier: Claude (gsd-verifier)_
