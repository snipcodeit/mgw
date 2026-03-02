---
phase: quick-7
plan: 7
subsystem: install
tags: [npm, install, slash-commands, claude-code, postinstall]
dependency_graph:
  requires: []
  provides: [automatic-slash-command-install]
  affects: [package.json, commands/, bin/]
tech_stack:
  added: []
  patterns: [npm-postinstall, recursive-copy-node-builtins]
key_files:
  created:
    - bin/mgw-install.cjs
    - commands/board.md
    - commands/workflows/board-sync.md
    - commands/workflows/github.md
    - commands/workflows/gsd.md
    - commands/workflows/state.md
    - commands/workflows/validation.md
  modified:
    - package.json
    - README.md
  deleted:
    - .claude/commands/mgw/ (entire directory, 23 files)
decisions:
  - Use recursive fs copy in pure Node.js built-ins (no shell cp) for cross-platform npm sandbox compatibility
  - Exit 0 on missing ~/.claude/ so npm install -g succeeds in non-Claude environments
  - Remove broken symlink from ~/.claude/commands/mgw that pointed to deleted .claude/commands/mgw/
metrics:
  duration: ~18 minutes
  completed_date: "2026-03-02T05:30:36Z"
  tasks_completed: 3
  files_changed: 31
---

# Quick Task 7: Add Install-Time Command Injection Summary

**One-liner:** Automatic npm postinstall deploys all 23 slash commands to ~/.claude/commands/mgw/ from the commands/ source tree, removing the manual cp step and .claude/commands/mgw/ from the repo.

## What Was Built

### Task 0: Migrate board.md and workflows/ into commands/

`commands/` was missing `board.md` and the entire `workflows/` subdirectory (5 files). These existed only in `.claude/commands/mgw/`. All 6 files were copied into `commands/` to make it the complete source of truth before the installer was wired.

Files added to `commands/`:
- `commands/board.md` — GitHub Projects v2 board management command
- `commands/workflows/board-sync.md` — Board sync utilities (update_board_status, sync_pr_to_board)
- `commands/workflows/github.md` — Shared GitHub CLI patterns
- `commands/workflows/gsd.md` — GSD agent spawn templates
- `commands/workflows/state.md` — Shared state schema and initialization
- `commands/workflows/validation.md` — Delegation boundary rules

### Task 1: Write bin/mgw-install.cjs

Created a standalone Node.js installer with no external dependencies (only `path`, `fs`, `os`):

- Resolves source: `path.join(__dirname, '..', 'commands')`
- Resolves target: `~/.claude/commands/mgw/`
- If `~/.claude/` does not exist: prints skip message, exits 0 (non-fatal for non-Claude installs)
- If `~/.claude/` exists: creates target dir recursively, copies entire commands/ tree
- Idempotent: running twice produces identical result with no errors
- Prints one summary line: `mgw: installed N slash commands to ~/.claude/commands/mgw`

### Task 2: Wire postinstall + remove .claude/commands/mgw/ + update README

**package.json:**
- Added `"postinstall": "node ./bin/mgw-install.cjs"` to scripts
- Added `"bin/mgw-install.cjs"` to the `files` array

**Git removal:**
- Removed `.claude/commands/mgw/` (23 files) from git tracking with `git rm -rf`
- Directory is now a runtime artifact managed by the installer, not committed source

**README.md:**
- Replaced manual `mkdir -p ~/.claude/commands/mgw/workflows && cp -r .claude/commands/mgw/* ~/.claude/commands/mgw/` with: `# Slash commands are installed automatically by npm postinstall`
- Updated "Slash commands only" section to: `npm install -g mgw` + automatic deployment note
- Updated Project Structure section: removed `.claude/` block, added `workflows/` under `commands/` with all 5 workflow files listed

## Verification Results

```
commands/board.md                    EXISTS
commands/workflows/ (5 files)        EXISTS
node bin/mgw-install.cjs             installed 23 slash commands → exit 0
~/.claude/commands/mgw/              23 files installed
~/.claude/commands/mgw/workflows/    5 files (all present)
diff -r commands/ ~/.claude/commands/mgw/  CLEAN (no differences)
.claude/commands/mgw/ git-tracked    0 files (removed)
package.json postinstall             node ./bin/mgw-install.cjs
bin/mgw-install.cjs in files[]       YES
Idempotency (run twice)              CLEAN
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Broken symlink ~/.claude/commands/mgw after git rm**
- **Found during:** Overall verification (after Task 2)
- **Issue:** `~/.claude/commands/mgw` was a symlink pointing to `/hd1/repos/mgw/.claude/commands/mgw` — which was deleted by `git rm -rf`. The symlink became broken, causing the installer to fail with `ENOENT: no such file or directory, mkdir '/home/hat/.claude/commands/mgw'` because `fs.mkdirSync` with `{ recursive: true }` does not follow symlinks correctly when the parent is a broken symlink.
- **Fix:** Removed the broken symlink with `rm /home/hat/.claude/commands/mgw`. The installer then ran successfully and created a real directory.
- **Files modified:** None (symlink removed from filesystem, not a git-tracked file)
- **Commit:** No separate commit needed — the symlink was a runtime artifact, not part of the repo

## Commits

| Hash | Message |
|------|---------|
| b128340 | chore(quick-7): migrate board.md and workflows/ into commands/ |
| ed795bf | feat(quick-7): add bin/mgw-install.cjs idempotent slash command installer |
| 027e3df | chore(quick-7): wire postinstall, remove .claude/commands/mgw/, update README |

## Self-Check: PASSED

All critical files verified:
- `/hd1/repos/mgw/bin/mgw-install.cjs` — EXISTS (created mode 100755)
- `/hd1/repos/mgw/commands/board.md` — EXISTS
- `/hd1/repos/mgw/commands/workflows/board-sync.md` — EXISTS
- `/hd1/repos/mgw/commands/workflows/github.md` — EXISTS
- `/hd1/repos/mgw/commands/workflows/gsd.md` — EXISTS
- `/hd1/repos/mgw/commands/workflows/state.md` — EXISTS
- `/hd1/repos/mgw/commands/workflows/validation.md` — EXISTS
- `~/.claude/commands/mgw/` — EXISTS (23 files, real directory)
- `package.json postinstall` — `node ./bin/mgw-install.cjs`
- `.claude/commands/mgw/` git-tracked files — 0
