---
phase: quick
plan: 4
subsystem: commands
tags: [issue-scaffolding, triage, project, issue, run, comment-history, done-when]
dependency_graph:
  requires: []
  provides: [enriched-issue-bodies, comment-aware-triage, discussion-bypass]
  affects: [project.md, issue.md, run.md]
tech_stack:
  added: []
  patterns: [conditional-body-builder, comment-history-fetch, pipeline-bypass-guard]
key_files:
  modified:
    - .claude/commands/mgw/project.md
    - .claude/commands/mgw/issue.md
    - .claude/commands/mgw/run.md
decisions:
  - "Use conditional string concatenation (ISSUE_BODY+=) rather than printf to allow optional sections to be omitted entirely when template data is absent"
  - "done_when always renders — fallback to single title checkbox when array is empty, ensuring Done When section is always present"
  - "Wrap discussion gate block in NEW_STAGE guard rather than deleting it — preserves fallback for issues that are not self-contained"
  - "prior_context_complete flag in output_format uses prose section (Self-Contained Check) rather than JSON schema, matching the existing output_format style in issue.md"
metrics:
  duration: "~10 minutes"
  completed: "2026-03-02T03:35:37Z"
  tasks_completed: 2
  files_modified: 3
---

# Quick Task 4: Enrich MGW Issue Scaffolding and Triage Summary

**One-liner:** Enriched issue bodies with 4 optional template fields (context, what_exists, technical_approach, done_when), added comment-history-aware triage with prior_context_complete flag, and wired a discussion-phase bypass for self-contained issues.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Enrich create_issues step and generate_template instructions in project.md | 23380fb | .claude/commands/mgw/project.md |
| 2 | Add comment history to triage agent in issue.md and discussion bypass in run.md | 0041698 | .claude/commands/mgw/issue.md, .claude/commands/mgw/run.md |

## What Was Built

### Task 1 — project.md enrichment

**Four new field extractions** added to the `create_issues` step, inserted after the `ISSUE_SLUG` block:

- `ISSUE_CONTEXT` — 1-2 sentences tying the issue to the milestone goal
- `ISSUE_WHAT_EXISTS` — existing files/patterns the executor should know
- `ISSUE_TECH_APPROACH` — implementation approach and library choices
- `ISSUE_DONE_WHEN` — checklist rendered from `done_when` array; falls back to a single `- [ ] $ISSUE_TITLE` checkbox if the array is absent

**Conditional ISSUE_BODY builder** replaces the `printf` heredoc. The four optional sections (Context, What Already Exists, Technical Approach) only appear when their template values are non-empty. Description, Done When, GSD Route, Phase Context, and Depends on are always present.

**generate_template item 12** instructs the AI generating the template JSON to populate all four fields for every issue when the information is known, with specific formatting guidance for each field.

### Task 2 — issue.md comment history + run.md bypass

**COMMENT_HISTORY fetch** added before the `Task()` spawn in `spawn_analysis`:
```bash
COMMENT_HISTORY=$(gh issue view "$ISSUE_NUMBER" \
  --json comments \
  --jq '[.comments[] | {author: .author.login, body: .body, created: .createdAt}]' 2>/dev/null || echo "[]")
```

**`<comment_history>` and `<comment_analysis_instructions>` blocks** injected into the triage prompt after `</issue>`, giving the analysis agent full comment JSON and explicit instructions to identify resolved decisions, cleared blockers, and implementation hints.

**`prior_context_complete` flag** documented in the `output_format` section under a new "Self-Contained Check" heading. Set to `true` only when the issue body has a `## Done When` section AND all scope/requirements questions are resolved.

**Discussion-phase bypass** in `execute_gsd_milestone` (run.md): checks `PRIOR_CONTEXT_COMPLETE` and `BODY_HAS_DONE_WHEN` before the discussion gate, sets `NEW_STAGE=planning` for self-contained issues, and wraps the entire scope-proposal block in `if [ "${NEW_STAGE:-}" != "planning" ]` so it is skipped when the bypass fires.

## Deviations from Plan

None — plan executed exactly as written. Renumbered the discussion phase trigger from item "1." to item "2." in run.md (since the new bypass check is now item "1.") to maintain readable numbered flow — this was implied by the plan's insertion position.

## Self-Check: PASSED

Files confirmed present:
- .claude/commands/mgw/project.md — exists, ISSUE_CONTEXT/ISSUE_DONE_WHEN/done_when confirmed
- .claude/commands/mgw/issue.md — exists, COMMENT_HISTORY/prior_context_complete/comment_analysis_instructions confirmed
- .claude/commands/mgw/run.md — exists, PRIOR_CONTEXT_COMPLETE/BODY_HAS_DONE_WHEN/NEW_STAGE confirmed

Commits confirmed:
- 23380fb — feat(quick-4): enrich create_issues step and generate_template instructions
- 0041698 — feat(quick-4): add comment history to issue triage and discussion bypass
