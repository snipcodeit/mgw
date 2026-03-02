---
phase: quick
plan: 4
type: quick
must_haves:
  - New step load_capability_context added between load_project_context and load_active_state in commands/ask.md
  - Step builds COMMAND_SURFACE from commands/*.md front matter (name + description fields)
  - Step fetches PR_CONTEXT via gh pr list --state open
  - Step fetches MILESTONE_LIST via gh api repos/.../milestones
  - <mgw_capabilities> block injected into Task() prompt after <recent_changes> and before <classification_rules>
  - <context> block header updated to mention capability context and live state sources
  - success_criteria updated with three new checklist items
---

# Plan: Issue #144 — mgw:ask missing capability context

## Summary

`mgw:ask` spawns a classification agent with milestone/issue context but no awareness of
the MGW command surface, open PRs, or live GitHub milestones. This plan adds a
`load_capability_context` step to gather that data and injects it into the agent prompt
via a `<mgw_capabilities>` block.

## Tasks

### Task 1 — Update commands/ask.md

| Field | Value |
|-------|-------|
| files | commands/ask.md |
| action | (1) Insert new `load_capability_context` step between `load_project_context` and `load_active_state`. (2) Add `<mgw_capabilities>` block in the Task() prompt after `<recent_changes>` and before `<classification_rules>`. (3) Update `<context>` block header to mention capability context and live state. (4) Add three new items to `success_criteria`. |
| verify | Read back the file and confirm: step exists in the correct position, `<mgw_capabilities>` block references all three variables, context block lists both new lines, success_criteria has three new items. |
| done | All four edits applied; file parses as valid markdown with no broken XML structure. |
