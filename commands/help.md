---
name: mgw:help
description: Show available MGW commands and usage guide
argument-hint: ""
allowed-tools: []
---

<objective>
Display the MGW (My GSD Workflow) command reference. No side effects.
</objective>

<process>

Display the following help text exactly:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW — My GSD Workflow
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GitHub ↔ GSD bridge. Automates the issue → triage → execute → PR lifecycle.
Work runs in isolated git worktrees — your main workspace stays on the default branch.
Local state in .mgw/ (gitignored, per-developer).

COMMANDS

  Setup
  ─────
  /mgw:init                    Bootstrap repo for MGW (state, templates, labels)

  Project
  ───────
  /mgw:project                 Initialize project — milestones, issues, ROADMAP from template

  Browse & Triage
  ───────────────
  /mgw:issues [filters]        List open issues (defaults: @me, open)
  /mgw:issue <number>          Triage issue against codebase, recommend GSD route

  Pipeline
  ────────
  /mgw:run <number>            Autonomous: triage → GSD execute → PR (worktree-isolated)
  /mgw:milestone               Execute milestone issues in dependency order (auto-sync, checkpoint)
  /mgw:next                    Show next unblocked issue — what to work on now

  GitHub Operations
  ─────────────────
  /mgw:update <number> [msg]   Post status comment (auto-detects type, or custom)
  /mgw:pr [number] [--base b]  Create PR from GSD artifacts + issue context
  /mgw:link <ref> <ref>        Cross-reference issues/PRs/branches

  Query
  ─────
  /mgw:ask <question>          Route a question — in-scope, adjacent, separate, duplicate, out-of-scope

  Maintenance
  ───────────
  /mgw:sync                    Reconcile .mgw/ state with GitHub
  /mgw:help                    This help text

TYPICAL FLOW

  0. /mgw:init                      One-time repo setup (state, templates, labels)
  1. /mgw:project                   Day 1: create milestones + issue backlog from template
  2. /mgw:next                      See what's unblocked — pick your next issue
  3. /mgw:run 42                    Full pipeline: plan → execute → verify → PR
                                    (runs in worktree, you stay on main)
  4. /mgw:milestone                 Auto-run all unblocked issues in dependency order
  5. /mgw:sync                      After merge: archive state, clean up branches

  Or work issue-by-issue:
  /mgw:issues                      Browse your assigned issues
  /mgw:issue 42                    Triage — scope, validity, security, GSD route
  /mgw:run 42                      Auto-triages if not done yet

MANUAL OPERATIONS

  /mgw:update 42 "switching approach due to #38"
  /mgw:link 42 #43
  /mgw:link 42 branch:fix/auth-42
  /mgw:pr                          Standalone PR from current branch
  /mgw:pr 42 --base develop        PR linked to issue, custom base

FILTER EXAMPLES

  /mgw:issues                      Your open issues (default)
  /mgw:issues --label bug           Filter by label
  /mgw:issues --assignee all        All open issues
  /mgw:issues --milestone v2.0      Filter by milestone

GSD ROUTE MAPPING

  Issue scope → GSD entry point (recommended by /mgw:issue):
  Small (1-2 files)        → gsd:quick
  Medium (3-8 files)       → gsd:quick --full
  Large (9+ files/new sys) → gsd:new-milestone

STATE

  .mgw/active/              In-progress issues
  .mgw/completed/           Archived after merge
  .mgw/cross-refs.json      Issue ↔ PR ↔ branch links
  .mgw/config.json          User preferences
  .mgw/project.json         Project structure (milestones, phases, template)

SHARED WORKFLOWS

  workflows/state.md        State management, staleness detection, validate_and_load
  workflows/github.md       All gh CLI patterns (issues, PRs, labels, comments)
  workflows/gsd.md          Task() spawn templates, CLAUDE.md injection, GSD utilities
  workflows/validation.md   Delegation boundary rule — MGW orchestrates, never codes
```

</process>
