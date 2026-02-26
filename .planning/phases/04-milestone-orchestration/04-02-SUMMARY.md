# Summary: Plan 04-02 — Build /mgw:next Command

**Completed:** 2026-02-26T04:50:01.094Z
**Duration:** ~3 min
**Status:** Complete

## What Was Built

### Task 1: Create /mgw:next Command

Created `.claude/commands/mgw/next.md` (~370 lines) with:
- **Frontmatter**: minimal allowed-tools (Bash, Read, AskUserQuestion only) — enforces read-only
- **Execution context**: references state.md and github.md workflows
- **Process steps**:
  1. `load_state` — read project.json, extract current milestone data
  2. `resolve_dependencies` — build slug-to-issue mapping, compute forward/reverse dependency graph from depends_on_slugs, identify unblocked (all deps done) vs blocked issues
  3. `handle_nothing_unblocked` — two paths:
     - ALL DONE: all issues complete, suggest /mgw:milestone to finalize
     - BLOCKED: show blocking chain table with issue/blocker/status, specific actionable advice for failed blockers
  4. `verify_live` — quick `gh issue view` to verify recommended issue is still OPEN on GitHub; skip to next if closed externally
  5. `display_brief` — full context for recommended issue: number, title, GSD route, phase, labels, milestone progress, resolved dependencies (all done), what it unblocks (downstream)
  6. `offer_run` — AskUserQuestion with Yes/No/Pick different options; display `/mgw:run N` command for user to execute
- **Alternatives display**: when multiple issues are unblocked, list alternatives with GSD route
- **Read-only enforcement**: allowed-tools exclude Task, Write, Edit — cannot modify state or run pipelines
- **Success criteria**: 9 items covering dependency graph, brief display, alternatives, blocking chain, GitHub verification

## Requirements Covered

| Requirement | How |
|-------------|-----|
| MLST-02 | Dependency graph computed from depends_on_slugs; single recommended issue surfaced with full brief |

## Files Modified

| File | Action |
|------|--------|
| `.claude/commands/mgw/next.md` | Created (~370 lines) |
