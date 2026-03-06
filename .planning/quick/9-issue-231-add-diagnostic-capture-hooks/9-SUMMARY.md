# Summary: Add Diagnostic Capture Hooks to mgw:run Agent Spawns

## One-liner
Added diagnostic capture hooks to all 9 Task() agent spawns in the mgw:run pipeline, with a new lib/diagnostic-hooks.cjs helper module and pattern documentation.

## Changes

### New Files
- **lib/diagnostic-hooks.cjs** — Helper module providing `beforeAgentSpawn()` and `afterAgentSpawn()` functions that wrap Task() agent spawns with diagnostic capture from `agent-diagnostics.cjs`. All operations are non-blocking. Also provides `wrapAgentSpawn()` for programmatic use and `pendingCount()` for debugging.

### Modified Files
- **commands/run/triage.md** — Instrumented the comment classifier Task() spawn in the `preflight_comment_check` step with before/after diagnostic hooks.
- **commands/run/execute.md** — Instrumented 7 Task() spawns across both quick and milestone routes:
  - Quick route: planner (step 3), plan-checker (step 6), executor (step 7), verifier (step 9)
  - Milestone route: planner (step b), executor (step d), verifier (step e)
- **commands/run/pr-create.md** — Instrumented the PR creation Task() spawn with before/after diagnostic hooks.
- **commands/workflows/gsd.md** — Added "Diagnostic Capture Hooks" section documenting the pattern, design principles, and table of all instrumented spawns.

## Key Decisions
- Used a dedicated `lib/diagnostic-hooks.cjs` module rather than inline diagnostic code in each command file to centralize the pattern and reduce duplication
- Prompt hashing uses `shortHash()` from `agent-diagnostics.cjs` -- only short prompt summaries (descriptions) are passed, never the full prompt text
- Exit reason detection uses artifact existence checks (e.g., `PLAN.md` exists = success) rather than relying on Task() return values, which is more reliable in the pseudocode context
- `diagnostic-hooks.cjs` gracefully degrades if `agent-diagnostics.cjs` is not available (dependency PR #239 not yet merged)

## Tech Added
- `lib/diagnostic-hooks.cjs`: Node.js module with Map-based in-flight tracking, lazy module loading, non-blocking error handling

## Commits
1. `feat(diagnostics): add diagnostic-hooks.cjs wrapper for Task() agent spawns`
2. `feat(diagnostics): add diagnostic hooks to comment classifier in triage.md`
3. `feat(diagnostics): add diagnostic hooks to all agent spawns in execute.md`
4. `feat(diagnostics): add diagnostic hooks to PR creator in pr-create.md`
5. `docs(diagnostics): document diagnostic hook pattern in gsd.md`
