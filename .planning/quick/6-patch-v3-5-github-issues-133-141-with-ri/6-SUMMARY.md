---
phase: quick-6
plan: 1
subsystem: github-issues
tags: [gh-cli, issue-enrichment, v3.5, execution-briefs]

# Dependency graph
requires: []
provides:
  - "All 9 v3.5 milestone issues (#133-141) have rich execution briefs with 8-section bodies"
  - "What Already Exists sections reference real file paths, line counts, and exported function names"
  - "Done When sections have 5 specific checkbox items each"
  - "Dependency chains accurately reflect Phase 32/33/34/35 blocking relationships"
affects: [phase-32, phase-33, phase-34, phase-35]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "8-section issue body format: Context, What Already Exists, Description, Technical Approach, Done When, GSD Route, Phase Context, Depends on"
    - "What Already Exists anchored to real codebase: file paths, line numbers, export names"

key-files:
  created: []
  modified:
    - "GitHub issues #133-141 (via gh issue edit)"

key-decisions:
  - "Used exact line counts from wc -l to anchor What Already Exists sections"
  - "Updated issue.md invocation count to 3 (actual) rather than 4 (plan estimate) after reading source"
  - "Updated run.md gsd-tools invocation count to ~21 (actual) rather than ~15 (plan estimate)"

patterns-established:
  - "Pre-read all source files before writing What Already Exists — no guessing"

requirements-completed: []

# Metrics
duration: 15min
completed: 2026-03-02
---

# Quick Task 6: Patch v3.5 GitHub Issues #133-141 with Rich Execution Briefs

**9 v3.5 milestone issues patched with 8-section execution briefs — all 45 Done When checkboxes referencing real file paths (lib/state.cjs:216L, lib/github.cjs:272L, lib/gsd.cjs:73L) and accurate invocation counts verified against source**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-03-02T03:40:00Z
- **Completed:** 2026-03-02T03:55:00Z
- **Tasks:** 3 (grouped by phase: 32, 33, 34/35)
- **Files modified:** 0 (GitHub API only)

## Accomplishments
- All 9 issues (#133-141) patched via `gh issue edit --body` with 8-section bodies
- What Already Exists sections verified against actual source: lib/state.cjs (216 lines, 9 exports), lib/github.cjs (272 lines, 10 exports + internal run()), lib/gsd.cjs (73 lines, 2 exports), commands/project.md (1979 lines, detect_state at line 66), commands/run.md (1282 lines), commands/milestone.md (952 lines)
- Corrected two plan estimates: issue.md has 3 gsd-tools invocations (not 4), run.md has ~21 (not ~15)
- Each issue has exactly 5 Done When checkbox items, all specific and measurable

## Task Commits

This was a GitHub-API-only task — no local file changes were committed per task. All changes are GitHub issue body updates.

1. **Task 1: Patch issues #133 and #134 (Phase 32 — Test Coverage)** — issues updated via gh CLI
2. **Task 2: Patch issues #135, #136, #137 (Phase 33 — project.md Decomposition)** — issues updated via gh CLI
3. **Task 3: Patch issues #138, #139, #140, #141 (Phases 34 and 35)** — issues updated via gh CLI

## Files Created/Modified

GitHub issues (all via `gh issue edit`):
- `#133` — Write unit tests for lib/state.cjs (Phase 32)
- `#134` — Write unit tests for lib/github.cjs (Phase 32)
- `#135` — Extract detect-state.md workflow from project.md (Phase 33)
- `#136` — Extract vision-cycle.md workflow from project.md (Phase 33)
- `#137` — Extract remaining workflows from project.md (Phase 33)
- `#138` — Create lib/gsd-adapter.cjs with path resolution and tool invocation (Phase 34)
- `#139` — Migrate route selection and state reading to gsd-adapter.cjs (Phase 34)
- `#140` — Create lib/retry.cjs with backoff and failure taxonomy (Phase 35)
- `#141` — Integrate retry into run.md and milestone.md (Phase 35)

## Decisions Made
- Read all source files before writing issue bodies to ensure What Already Exists sections are accurate rather than relying solely on plan estimates
- Updated run.md invocation count from ~15 to ~21 after counting actual grep matches
- Updated issue.md invocation count from 4 to 3 after reading the file directly
- lib/github.cjs exports 10 functions (not listed as "10 functions" in plan context — confirmed by counting module.exports)

## Deviations from Plan

None — plan executed exactly as written. Two numeric corrections (invocation counts) were made as accuracy improvements, not functional changes.

## Issues Encountered

None. All 9 `gh issue edit` commands succeeded on first attempt.

## Verification

All 9 issues verified with:
```
Issue #133: PASS (5 checkboxes)
Issue #134: PASS (5 checkboxes)
Issue #135: PASS (5 checkboxes)
Issue #136: PASS (5 checkboxes)
Issue #137: PASS (5 checkboxes)
Issue #138: PASS (5 checkboxes)
Issue #139: PASS (5 checkboxes)
Issue #140: PASS (5 checkboxes)
Issue #141: PASS (5 checkboxes)
```

All 8 required sections present in every issue: Context, What Already Exists, Description, Technical Approach, Done When, GSD Route, Phase Context, Depends on.

## Next Phase Readiness
- Issues #133 and #134 are ready for execution (no dependencies)
- Issues #135 is ready for execution (no dependencies within Phase 33)
- Issues #138 and #140 are ready for execution (no cross-phase dependencies)
- Dependency chains accurately reflect blocking: #136 blocked on #135, #137 on #136, #139 on #138, #141 on #140

---
*Phase: quick-6*
*Completed: 2026-03-02*
