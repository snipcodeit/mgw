# Workflow Guide

End-to-end walkthroughs covering common MGW usage patterns, from single-issue runs to full milestone execution.

---

## Greenfield Project

Starting a brand new project from scratch:

```
# Step 1: Initialize the repo for MGW
/mgw:init

# Step 2: Run the state-aware project initializer
/mgw:project
# MGW detects that this is a fresh repo and launches the Vision Collaboration Cycle:
#
#   Stage 1 — Intake
#     You describe your project idea in plain language.
#
#   Stage 2 — Domain Expansion
#     A vision-researcher agent analyzes your idea, identifies similar products,
#     relevant technologies, and domain patterns. Produces .mgw/vision-research.json.
#
#   Stage 3 — Structured Questioning (3–8 rounds soft cap, 15 max hard cap)
#     MGW asks targeted questions informed by the domain research.
#     Your answers are captured as key decisions in .mgw/vision-draft.md.
#     Type 'done' at any point to move on.
#
#   Stage 4 — Vision Synthesis
#     A vision-synthesizer agent produces a structured Vision Brief:
#     MoSCoW feature categories, target personas, success metrics, scope.
#     Saved to .mgw/vision-brief.json.
#
#   Stage 5 — Review
#     You can accept the brief, request revisions, or ask to dig deeper.
#     Revision loops back to Stage 4.
#
#   Stage 6 — Condense + Spawn
#     A vision-condenser agent produces .mgw/vision-handoff.md.
#     MGW spawns gsd:new-project with the Vision Brief as context.
#     GSD creates .planning/ROADMAP.md and .planning/PROJECT.md.
#     milestone_mapper reads the ROADMAP and creates GitHub milestones and issues.
#     maps-to cross-refs link each GitHub milestone to its GSD milestone ID.

# Step 3: See the execution plan
/mgw:milestone --dry-run
# Shows: ordered issues, dependencies, estimated API calls

# Step 4: Execute the first milestone
/mgw:milestone
# Runs each issue in dependency order:
#   - Posts work-started comment
#   - Creates worktree
#   - Plans via GSD
#   - Executes code changes
#   - Creates PR
#   - Posts PR-ready comment
#   - Cleans up worktree

# Step 5: Review and merge PRs as they are created
# Each merged PR auto-closes its linked issue

# Step 6: After merging, sync state
/mgw:sync
# When the milestone completes, MGW checks if the next milestone has a GSD link.
# If not, it prompts you to run /gsd:new-milestone before continuing.
```

## Existing GSD Project (no GitHub structure yet)

If you already have a GSD project (`.planning/ROADMAP.md` exists) but haven't created GitHub issues yet:

```
# Run mgw:project — it detects the GSD-Only state
/mgw:project
# MGW spawns alignment-analyzer to read .planning/*
# Produces .mgw/alignment-report.json with structured GSD state
# milestone_mapper creates GitHub milestones and issues from the report
# maps-to links are written to cross-refs.json

# Then proceed as normal
/mgw:milestone
```

---

## Existing Issues

Working with a repo that already has GitHub issues:

```
# Step 1: See what is assigned to you
/mgw:issues

# Step 2: Find the next unblocked issue
/mgw:next

# Step 3: Run the full pipeline for that issue
/mgw:run 42
# Creates branch issue/42-fix-auth in a worktree
# Triages (if not already done)
# Plans and executes via GSD
# Opens PR with structured description
# Posts status comments on the issue

# Step 4: Review the PR, merge when ready

# Step 5: Sync state
/mgw:sync
```

---

## Manual Step-by-Step Control

For more control over individual pipeline stages:

```
# Triage first
/mgw:issue 42

# Review triage results, then link related issues
/mgw:link 42 #43

# Post a status update
/mgw:update 42 "starting implementation"

# Run the pipeline (skips triage since it is already done)
/mgw:run 42

# Or create a PR manually from the current branch
/mgw:pr 42 --base develop
```

---

## Working Across Multiple Sessions

MGW checkpoints state after each issue. If your session ends mid-milestone:

```
# Session 1: Start milestone execution
/mgw:milestone
# Completes issues #10, #11, #12 -- session ends

# Session 2: Resume where you left off
/mgw:milestone
# Detects #10, #11, #12 are done
# Continues with #13, #14, ...
```

If an issue was partially in progress when the session ended, `/mgw:milestone` detects this, cleans up the partial worktree, and restarts that issue from scratch.

---

## The `/mgw:run` Pipeline in Detail

When you run `/mgw:run 42`, here is the full sequence:

### Stage 1: Validate and Load

```
Parse issue number from arguments
Check .mgw/active/ for existing state
If no state: run triage inline
```

### Stage 2: Create Worktree

```
Derive branch name: issue/42-fix-auth
git worktree add .worktrees/issue/42-fix-auth
cd into worktree (all work happens here)
```

### Stage 3: Pre-Flight Comment Check

```
Compare current comment count with triage snapshot
If new comments: spawn classification agent
  - material  --> enrich context, continue
  - blocking  --> pause pipeline
  - informational --> log, continue
```

### Stage 4: Post Triage Comment

```
Post structured comment on issue:
  scope, route, files, security, branch name
```

### Stage 5: GSD Execution

Depending on the triage-determined route:

**Quick route:**
1. Initialize GSD quick project
2. Spawn planner agent --> creates PLAN.md
3. (if --full) Spawn plan checker agent
4. Spawn executor agent --> writes code, creates commits
5. (if --full) Spawn verifier agent
6. Verify artifacts

**Diagnose-issues route:**
1. pipeline_stage → "diagnosing"
2. Create .planning/debug/ directory
3. Spawn diagnosis agent --> investigates codebase → root cause in .planning/debug/{slug}.md
4. If root cause found: enrich context and route to quick fix
5. If inconclusive: report to user, suggest manual investigation

**Milestone route:**
1. Initialize GSD new-milestone
2. Gate: check ROADMAP.md exists (hard block if missing)
3. For each phase: plan, execute, verify, post phase-complete comment

### Stage 6: Post Execution Comment

```
Post on issue: commit count, file changes, test status
```

### Stage 7: Create PR

```
git push -u origin issue/42-fix-auth
Read GSD artifacts (SUMMARY.md, VERIFICATION.md)
Create PR with: summary, milestone context, changes, test plan
```

### Stage 8: Cleanup

```
cd back to repo root
git worktree remove
Post pr-ready comment on issue
Update state: pipeline_stage = "done"
```

---

## Milestone Execution Flow

`/mgw:milestone` is the highest-level orchestrator. Here is how it processes a milestone:

```
Load project.json
    |
    v
Topological sort (Kahn's algorithm)
    |
    v
Rate limit guard (estimate API calls)
    |
    v
For each issue in sorted order:
    |
    +-- Check: blocked by a failed dependency? --> skip
    +-- Check: rate limit exceeded? --> stop
    +-- Check: issue still open on GitHub? --> skip if closed
    |
    +-- Post work-started comment (with milestone progress table)
    +-- Run /mgw:run via Task()
    +-- Detect result (PR created or failed)
    +-- Post pr-ready or pipeline-failed comment
    +-- Checkpoint to project.json
    |
    v
All done? --> Close milestone, create draft release, advance pointer
Some failed? --> Report, do not close milestone
```

### What Happens When a Dependency Fails

1. The failed issue is marked with `pipeline_stage: "failed"` and labeled `pipeline-failed`
2. All issues that depend on the failed issue are marked as blocked
3. Issues that do **not** depend on the failed issue continue executing
4. The milestone is marked as incomplete

To recover:

```
# Fix the underlying problem, then re-run
/mgw:milestone
# Completed issues are skipped, failed issue retries
```

### Interactive Mode

For careful, step-by-step execution:

```
/mgw:milestone --interactive
```

After each issue completes, you choose: **Continue**, **Skip next**, or **Abort**.

### Dry Run

Preview the execution plan without running anything:

```
/mgw:milestone --dry-run
```

Displays a table showing order, issue number, title, current status, what each issue depends on, and what each issue blocks.

---

## Status Comments

Every pipeline step posts a structured comment on the GitHub issue:

```markdown
> MGW . `work-started` . 2026-02-26T03:31:00Z
> Milestone: v1.0 -- Auth & Data Layer | Phase 1: Database Schema

### Work Started

| | |
|---|---|
| **Issue** | #71 -- Implement user registration |
| **Route** | `plan-phase` |
| **Phase** | 1 of 6 -- Database Schema |
| **Milestone** | v1.0 -- Auth & Data Layer |

<details>
<summary>Milestone Progress (1/6 complete)</summary>
| # | Issue | Status | PR |
|---|-------|--------|----|
| 70 | Design SQLite schema | Done | #85 |
| **71** | **User registration** | In Progress | -- |
| 72 | JWT middleware | Pending | -- |
</details>
```

### Comment Types

| Stage | Tag | Content |
|-------|-----|---------|
| Triage complete | `triage-complete` | Scope, validity, security, route, affected files |
| Work started | `work-started` | Issue details, route, phase, milestone progress table |
| Execution complete | `execution-complete` | Commit count, file changes, test status |
| PR ready | `pr-ready` | PR link, one-liner summary, pipeline stage table |
| Pipeline failed | `pipeline-failed` | Failure notification, dependent issue impact |
| Pipeline blocked | `pipeline-blocked` | Blocking comment detected, reason |
| Phase complete | `phase-complete` | Per-phase summary during milestone execution |

---

## PR Description Structure

PRs created by MGW follow a consistent structure:

```markdown
## Summary
- 2-4 bullets of what was built and why

Closes #42

## Milestone Context
- **Milestone:** v1.0 -- Core Features
- **Phase:** 1 -- Database Schema
- **Issue:** 2 of 6 in milestone

## Changes
- File-level changes grouped by module

## Test Plan
- Verification checklist

## Cross-References
- Related issues and PRs
```

The content is generated from GSD artifacts (SUMMARY.md, VERIFICATION.md) and MGW state (cross-refs.json, project.json). The PR agent never reads application code directly.

---

## GSD Routes Explained

MGW selects a GSD route based on issue scope during triage:

| Issue Size | Files | Route | What Happens |
|-----------|-------|-------|--------------|
| Small | 1-2 | `quick` | Single-pass plan + execute. Fast, minimal overhead. |
| Medium | 3-8 | `quick --full` | Plan with verification loop. Includes plan checking and post-execution verification. |
| Large | 9+ | `new-milestone` | Full milestone with phased execution. ROADMAP.md gate, multi-phase planning, per-phase verification. |
| Bug | any | `diagnose-issues` | Debug agent investigates root cause in isolation, then routes to quick fix. Sets `diagnosing` stage. |

### All Available GSD Routes

| Route | Use Case |
|-------|----------|
| `quick` | Small, well-defined tasks. One plan, one execution pass. |
| `plan-phase` | Complex multi-step implementation. Detailed planning with task breakdown. |
| `discuss-phase` | Requirements clarification. Gather context before planning. |
| `research-phase` | Unknowns requiring investigation before implementation. |
| `execute-phase` | Straightforward mechanical execution (plan already exists). |
| `verify-phase` | Post-execution verification against acceptance criteria. |
| `new-project` | Full project scaffold from scratch. |
| `new-milestone` | New milestone with roadmap, phases, and dependency chain. |
| `complete-milestone` | Finalize a milestone (close, release, advance). |

### Overriding the Route

You can override the route after triage by editing the state file:

```bash
cat .mgw/active/42-fix-auth.json | jq '.gsd_route = "plan-phase"' > /tmp/fix.json
mv /tmp/fix.json .mgw/active/42-fix-auth.json
```

Or delete the state file and re-triage:

```bash
rm .mgw/active/42-fix-auth.json
/mgw:issue 42
```

---

## Dependency Ordering

### How Dependencies Are Declared

During `/mgw:project`, issues are generated with `depends_on` slugs. On GitHub, dependencies appear as `blocked-by:#N` labels.

### How Dependencies Are Resolved

`/mgw:milestone` uses Kahn's algorithm (topological sort):

1. Build a directed graph from `depends_on_slugs`
2. Find all issues with zero in-degree (no unresolved dependencies)
3. Process them in phase-number order (lower phase numbers first)
4. After processing, decrement the in-degree of downstream issues
5. Repeat until all issues are processed

Circular dependencies are detected and reported. MGW refuses to proceed until they are resolved.

### Adding a Dependency

```bash
# Create the label (if it does not exist)
gh label create "blocked-by:#10" --description "Blocked by issue #10" --color "e4e669" --force

# Apply it
gh issue edit 42 --add-label "blocked-by:#10"
```

---

## Next Steps

- [[Commands Reference]] -- Full docs for every command
- [[Architecture]] -- Deep dive into how the pipeline works
- [[Configuration]] -- Customize MGW behavior
- [[Troubleshooting]] -- When things go wrong
