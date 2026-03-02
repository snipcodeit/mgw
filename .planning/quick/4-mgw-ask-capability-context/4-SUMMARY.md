---
phase: quick
plan: 4
type: quick
issue: 144
---

# Summary: Issue #144 — mgw:ask missing capability context

## What Was Done

Four edits were made to `commands/ask.md`:

### 1. New step: `load_capability_context` (inserted between `load_project_context` and `load_active_state`)

Collects three data sources into shell variables:
- `COMMAND_SURFACE` — iterates `commands/*.md`, extracts `name:` and `description:` front matter fields from each file
- `PR_CONTEXT` — runs `gh pr list --state open` with JSON output to list open PRs by number, branch, and title
- `MILESTONE_LIST` — uses `gh api repos/.../milestones` to fetch live milestone state; falls back to a "not found" message if the API is unavailable

### 2. `<mgw_capabilities>` block injected into the Task() prompt

Added after `<recent_changes>` and before `<classification_rules>` in `spawn_classification_agent`. The block exposes all three variables to the classification agent so it can reason about which commands exist, which PRs are in flight, and which milestones are open — even when `project.json` is absent or stale.

### 3. `<context>` block header updated

Added two lines documenting the new data sources:
- `Capability context: commands/*.md front matter (name + description per command)`
- `Live state: open PRs via gh pr list, milestones via gh api`

### 4. `success_criteria` extended

Added three new checklist items:
- `Command surface index built from commands/*.md front matter`
- `Open PRs fetched and injected into agent context`
- `Live GitHub milestones fetched as fallback when project.json is absent`

## Files Modified

- `commands/ask.md`

## Files Created

- `.planning/quick/4-mgw-ask-capability-context/4-PLAN.md`
- `.planning/quick/4-mgw-ask-capability-context/4-SUMMARY.md`
