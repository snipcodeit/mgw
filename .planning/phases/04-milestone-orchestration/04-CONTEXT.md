# Phase 4: Milestone Orchestration - Context

**Gathered:** 2026-02-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver two commands: `/mgw:milestone` (execute a milestone's issues in dependency order via `/mgw:run`) and `/mgw:next` (surface the next unblocked issue with full context). This is the coordination layer — it orchestrates existing per-issue pipelines, not individual issue work.

</domain>

<decisions>
## Implementation Decisions

### Execution flow
- Sequential execution of issues, even when multiple are unblocked (phase order, not parallel)
- Autonomous by default — runs all issues back-to-back without pausing. `--interactive` flag pauses between issues for user confirmation
- Smart start: reads project.json + GitHub state, skips completed issues, starts from first unfinished unblocked issue
- Auto-detect resume — no separate "start" vs "resume" subcommand. `/mgw:milestone` always checks for in-progress state
- Current milestone by default from project.json, optional argument to target a specific milestone number
- Auto-advance to next milestone after completion, but block if any issues failed/were skipped in the current milestone
- `--dry-run` flag shows execution plan (dependency graph, issue order, estimated scope) without running anything
- Pre-sync via `/mgw:sync` before starting (MLST-03). Skip rate limit estimation (MLST-04 simplified)
- Auto-close GitHub milestone on completion and advance `current_milestone` pointer in project.json

### Failure handling
- When an issue's `/mgw:run` pipeline fails: skip it, mark dependents as blocked, continue with remaining unblocked issues
- Failed issues get both a `pipeline-failed` label AND a detailed comment
- Failure comments include the full milestone progress table (collapsed) showing all issues and their statuses
- Every GitHub comment posted by milestone orchestration includes a collapsed milestone progress table — serves as a status snapshot
- GitHub is the source of truth for MGW-level orchestration; GSD is the source of truth for individual issue execution within a milestone

### Interruption & resume
- Dual-source resume: check GSD artifacts for in-progress phase state, cross-reference with GitHub milestone issues
- If an issue was mid-pipeline (partial worktree/commits), restart that issue from scratch — clean up partial state and re-run `/mgw:run`
- If no resumable state found (no GSD artifacts, no in-progress GitHub issues), treat as fresh — assume project needs planning or is brand new
- Per-issue checkpoint: update project.json pipeline_stage after each issue completes (MLST-05)

### Progress & reporting
- GitHub-first progress: all detailed progress lives in GitHub issue comments, not terminal
- Terminal output is minimal during run: "Running issue #N..." and "Done." or "Failed."
- Every comment on every issue includes the current issue status prominently, with a collapsed `<details>` block containing the full milestone progress table (all issues, status, PR links, agent/stage info)
- Final output (milestone complete): full result table printed in terminal AND posted to GitHub
- On milestone completion: create a draft GitHub Release with auto-generated summary (milestone name, issues completed, PRs merged, failures, stats)
- Release tag format: milestone-based (e.g., `milestone-1-complete`)

### /mgw:next output
- Returns single recommended next issue (dependency order, then phase order) plus brief list of other unblocked alternatives
- Full brief for the recommended issue: number, title, GSD route, description, labels, dependencies (what it depends on — all done), what it unblocks, milestone context
- Local-first with live verification: read project.json for fast answer, quick `gh` API check to verify issue is still open and unblocked
- Offers to run: after displaying the brief, asks "Run /mgw:run #N now?" — one confirmation to start
- When nothing unblocked: shows what's blocking and by what — "No unblocked issues. #44 blocked by #42 (in progress), #45 blocked by #43 (failed). Resolve #43 to unblock #45."

### Claude's Discretion
- Terminal banner formatting and styling
- Exact tag naming convention for milestone releases
- GitHub comment markdown formatting details
- How to calculate "estimated scope" for --dry-run
- Whether to include timing/duration info in progress tables

</decisions>

<specifics>
## Specific Ideas

- Milestone progress table should give exposure into what MGW and GSD agents are actually doing — not just pass/fail, but agent names, skills invoked, files touched, phases worked on
- The progress table in comments should be useful for maintaining multi-milestone GitHub pipelines fed through GSD — it's an operational tool, not just a log
- Two-layer truth model: GitHub for MGW milestone orchestration state, GSD for individual issue/phase execution state within a milestone

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-milestone-orchestration*
*Context gathered: 2026-02-25*
