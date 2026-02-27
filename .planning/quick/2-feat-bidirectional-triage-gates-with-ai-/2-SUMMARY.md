---
phase: quick-2
plan: 01
subsystem: triage-pipeline
tags: [triage, gates, labels, templates, pipeline-validation]
dependency_graph:
  requires: []
  provides: [triage-gate-evaluation, pipeline-gate-validation, resolution-classification, mgw-pipeline-labels, ai-optimized-templates]
  affects: [issue.md, run.md, review.md, init.md, state.md, github.md, github-templates]
tech_stack:
  added: []
  patterns: [gate-evaluation, label-lifecycle, immediate-github-feedback, resolution-classification]
key_files:
  created:
    - .github/ISSUE_TEMPLATE/architecture_refactor.yml
  modified:
    - .claude/commands/mgw/workflows/state.md
    - .claude/commands/mgw/workflows/github.md
    - commands/init.md
    - .claude/commands/mgw/init.md
    - .github/ISSUE_TEMPLATE/bug_report.yml
    - .github/ISSUE_TEMPLATE/feature_request.yml
    - .github/PULL_REQUEST_TEMPLATE.md
    - .github/labeler.yml
    - commands/issue.md
    - .claude/commands/mgw/issue.md
    - commands/run.md
    - .claude/commands/mgw/run.md
    - commands/review.md
    - .claude/commands/mgw/review.md
decisions:
  - "Triage comments posted IMMEDIATELY during /mgw:issue rather than deferred to /mgw:run — gives stakeholders instant visibility"
  - "Gate severity order: security > detail > validity for label selection on multiple blockers"
  - "run.md post_triage_update renamed to work-starting to avoid confusion with triage comment from issue.md"
  - "resolution classification added as 4th type alongside material/informational/blocking"
  - "Discussion phase for new-milestone route is opt-in (user can proceed or wait for stakeholder approval)"
metrics:
  duration: "~45 minutes"
  completed: "2026-02-27T20:31:24Z"
  tasks_completed: 3
  tasks_total: 3
  files_modified: 13
  files_created: 1
---

# Phase Quick-2 Plan 01: Bidirectional Triage Gates with AI-Optimized Templates Summary

Bidirectional triage quality gates with immediate GitHub feedback, 7 MGW pipeline labels, AI-optimized issue/PR templates, gate validation in run.md, and resolution classification in review.md.

## What Was Built

### Task 1: State Schema, GitHub Labels, and Init Bootstrapper

**state.md extensions:**
- Extended `pipeline_stage` enum from 7 to 13 values, adding: `needs-info`, `needs-security-review`, `discussing`, `approved`, `failed`, `blocked`
- Added `gate_result` object to triage schema with `status`, `blockers`, `warnings`, `missing_fields` fields
- Added Stage Flow Diagram section documenting all valid stage transitions

**github.md additions:**
- New "Label Lifecycle Operations" section with 7 MGW pipeline label definitions (color-coded table)
- `remove_mgw_labels_and_apply()` bash function for atomic label transitions
- Three comment templates: Gate Blocked, Gate Passed, Scope Proposal

**init.md updates:**
- 7 `mgw:*` label creation commands in `ensure_labels` step
- Updated report to show "MGW pipeline labels synced (7 labels)"
- Added success criteria for label bootstrapping

### Task 2: GitHub Issue and PR Templates

**bug_report.yml** — 5 new fields added:
- `acceptance-criteria` (textarea) — fix completion conditions
- `scope-estimate` (dropdown) — Small/Medium/Large
- `security-impact` (checkboxes) — auth, data, validation, API, none
- `whats-involved` (textarea) — files table
- `related-issues` (input) — issue references

**feature_request.yml** — 7 new fields added:
- `acceptance-criteria` (textarea, **required**) — testable done conditions
- `scope-estimate` (dropdown)
- `priority` (dropdown) — Nice to have / Should have / Must have / Critical
- `security-impact` (checkboxes)
- `whats-involved` (textarea)
- `non-functional` (textarea) — performance/scalability requirements
- `related-issues` (input)

**architecture_refactor.yml** — NEW template with 10 fields:
- `bluf`, `current-state`, `target-state`, `migration-strategy`, `risk-areas`, `breaking-changes`, `acceptance-criteria`, `scope-estimate`, `whats-involved`, `related-issues`

**PULL_REQUEST_TEMPLATE.md** — Redesigned from 3 to 10 sections:
- Summary, Milestone Context, Changes, Design Decisions, Security & Performance, Artifacts, Breaking Changes, Test Plan, Cross-References, Checklist

**labeler.yml** — Added `triage-pipeline` rule covering issue.md, run.md, review.md, state.md, github.md

### Task 3: Triage Gates, Pipeline Validation, Resolution Classification

**commands/issue.md** — 2 new steps, 3 modified steps:
- NEW `evaluate_gates` step: evaluates 3 gates (validity, security, detail sufficiency) after analysis agent returns
- NEW `post_triage_github` step: posts immediate GitHub comment (blocked or passed) and applies appropriate `mgw:` label
- Modified `present_report`: displays gate results with override/wait/reject flow
- Modified `write_state`: stores `gate_result`, sets `pipeline_stage` based on gate outcome
- Modified `offer_next`: handles wait/override/accepted flows separately

**commands/run.md** — multiple steps extended:
- `validate_and_load`: refuses `needs-info` without `--force`, refuses `needs-security-review` without `--security-ack`
- `create_worktree`: applies `mgw:in-progress` label after worktree creation
- `preflight_comment_check`: added security keyword detection for material comments; applies `mgw:blocked` label when blocking detected
- `post_triage_update` renamed to `work-starting` (triage comment now lives in issue.md)
- `execute_gsd_milestone`: discussion phase trigger for new-milestone route with scope proposal comment and `mgw:discussing` label
- `cleanup_and_complete`: removes `mgw:in-progress` label at completion

**commands/review.md** — resolution classification:
- Added `resolution` as 4th classification type to `classify_comments` rules
- Updated priority logic: blocking > resolution > material > informational
- Updated JSON output format to include `resolved_blocker` field
- Added `present_and_act` block for resolution: offers re-triage, acknowledge, or ignore

**Deployed copies synced:** All 3 source commands synced to `.claude/commands/mgw/`

## Commits

| Hash | Description |
|------|-------------|
| `e3fa0c3` | feat(quick-2): extend state schema, add MGW pipeline labels and triage comment templates |
| `9e90754` | feat(quick-2): redesign GitHub issue and PR templates with triage-optimized fields |
| `4659c73` | feat(quick-2): implement triage gates, pipeline validation, and resolution classification |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

Files verified:
- `.claude/commands/mgw/workflows/state.md` — FOUND
- `.claude/commands/mgw/workflows/github.md` — FOUND
- `commands/init.md` — FOUND
- `.claude/commands/mgw/init.md` — FOUND (matches source)
- `.github/ISSUE_TEMPLATE/bug_report.yml` — FOUND
- `.github/ISSUE_TEMPLATE/feature_request.yml` — FOUND
- `.github/ISSUE_TEMPLATE/architecture_refactor.yml` — FOUND (new)
- `.github/PULL_REQUEST_TEMPLATE.md` — FOUND
- `.github/labeler.yml` — FOUND
- `commands/issue.md` — FOUND
- `.claude/commands/mgw/issue.md` — FOUND (matches source)
- `commands/run.md` — FOUND
- `.claude/commands/mgw/run.md` — FOUND (matches source)
- `commands/review.md` — FOUND
- `.claude/commands/mgw/review.md` — FOUND (matches source)

Commits verified:
- `e3fa0c3` — FOUND
- `9e90754` — FOUND
- `4659c73` — FOUND
