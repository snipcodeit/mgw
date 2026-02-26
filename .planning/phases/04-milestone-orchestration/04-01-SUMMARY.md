# Summary: Plan 04-01 — Build /mgw:milestone Command

**Completed:** 2026-02-26T04:50:01.094Z
**Duration:** ~4 min
**Status:** Complete

## What Was Built

### Task 1: Extend Shared Workflows

Extended `workflows/github.md` with:
- **Rate Limit** section: `gh api rate_limit` pattern with remaining/limit/reset extraction and 25-calls-per-issue estimate
- **Close Milestone** section: `gh api repos/{repo}/milestones/{N}` PATCH to closed state
- **Release Operations** section: `gh release create` with draft flag and milestone-based tag format
- Updated Consumers table with milestone.md and next.md references

Extended `workflows/state.md` with:
- **Project State (project.json)** section with 4 patterns:
  - Read Project State (current_milestone extraction)
  - Read Milestone Issues (indexed by current_milestone)
  - Update Issue Pipeline Stage (python3 inline JSON update with stage enum)
  - Advance Current Milestone (increment pointer, guard on all-done)
- Updated Consumers table with milestone.md and next.md

### Task 2: Create /mgw:milestone Command

Created `.claude/commands/mgw/milestone.md` (~350 lines) with:
- **Frontmatter**: allowed-tools include Bash, Read, Write, Edit, Task, Glob, Grep, AskUserQuestion
- **Execution context**: references state.md, github.md, gsd.md, validation.md workflows
- **Process steps**:
  1. `parse_arguments` — extract milestone number, --interactive, --dry-run flags
  2. `validate_and_sync` (MLST-03) — run /mgw:sync before starting
  3. `load_milestone` — read project.json, extract milestone data
  4. `resolve_execution_order` — Kahn's algorithm with cycle detection on depends_on_slugs
  5. `rate_limit_guard` (MLST-04) — check remaining API calls vs. 25*issue_count estimate
  6. `dry_run` — display execution plan table without executing
  7. `resume_detection` — detect in-progress issues from prior interrupted runs, clean up worktrees
  8. `execute_loop` (MLST-01, MLST-05) — sequential Task() spawn of /mgw:run per issue, checkpoint to project.json after each, cascade failures to dependents
  9. `post_loop` — close milestone via API, create draft release, advance current_milestone pointer
- **Failure handling**: mark failed issues as 'failed', skip dependents as 'blocked', continue with unblocked issues
- **Progress table**: GitHub comment with collapsed `<details>` block showing issue-by-issue status
- **Success criteria**: 9 items covering all MLST requirements

### Task 3: Update help.md

Updated `.claude/commands/mgw/help.md`:
- Added `/mgw:milestone` and `/mgw:next` to the Pipeline section
- Updated TYPICAL FLOW to show the new milestone-oriented workflow (next -> run -> milestone -> sync)
- Preserved existing manual operations and filter examples

## Requirements Covered

| Requirement | How |
|-------------|-----|
| MLST-01 | execute_loop spawns Task() for each issue in topological order |
| MLST-03 | validate_and_sync step runs /mgw:sync before execution |
| MLST-04 | rate_limit_guard checks API remaining before starting loop |
| MLST-05 | checkpoint writes pipeline_stage to project.json after each issue |

## Files Modified

| File | Action |
|------|--------|
| `.claude/commands/mgw/workflows/github.md` | Extended (Rate Limit, Close Milestone, Release Operations) |
| `.claude/commands/mgw/workflows/state.md` | Extended (Project State section) |
| `.claude/commands/mgw/milestone.md` | Created (~350 lines) |
| `.claude/commands/mgw/help.md` | Updated (Pipeline section, TYPICAL FLOW) |
