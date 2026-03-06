# Verification: Add Diagnostic Capture Hooks to mgw:run Agent Spawns

## VERIFICATION PASSED

### Must-Haves Check

| # | Must-Have | Status | Evidence |
|---|----------|--------|----------|
| 1 | lib/diagnostic-hooks.cjs exists with wrapAgentSpawn/beforeAgentSpawn/afterAgentSpawn | PASS | File created, module loads successfully, exports verified: beforeAgentSpawn, afterAgentSpawn, wrapAgentSpawn, generateDiagId, pendingCount |
| 2 | commands/run/triage.md has diagnostic hooks around comment classifier Task() | PASS | Pre-spawn `DIAG_CLASSIFIER` and post-spawn `afterAgentSpawn` added around comment classifier spawn in `preflight_comment_check` step |
| 3 | commands/run/execute.md has diagnostic hooks around planner, checker, executor, verifier | PASS | 7 Task() spawns instrumented: planner (quick+milestone), plan-checker (quick), executor (quick+milestone), verifier (quick+milestone) |
| 4 | commands/run/pr-create.md has diagnostic hooks around PR creation Task() | PASS | Pre-spawn `DIAG_PR_CREATOR` and post-spawn added around PR creator spawn in `create_pr` step |
| 5 | commands/workflows/gsd.md documents the diagnostic hook pattern | PASS | New "Diagnostic Capture Hooks" section with pattern template, design principles, and 9-row instrumentation table |

### Non-Blocking Verification

| Check | Status | Detail |
|-------|--------|--------|
| All hook calls use `2>/dev/null \|\| true` | PASS | Every post-spawn afterAgentSpawn call has error suppression |
| All pre-spawn calls use `2>/dev/null \|\| echo ""` | PASS | Empty string fallback ensures pipeline continues if hooks fail |
| lib/diagnostic-hooks.cjs has try/catch on all exports | PASS | Every function in the module wraps logic in try/catch with warning logging |
| Graceful degradation without agent-diagnostics.cjs | PASS | Lazy-loaded via getDiagModule() with null fallback |

### Coverage Check

| Agent Type | File | Instrumented |
|------------|------|-------------|
| Comment classifier (general-purpose) | triage.md | Yes |
| Planner (gsd-planner) - quick | execute.md step 3 | Yes |
| Plan-checker (gsd-plan-checker) - quick | execute.md step 6 | Yes |
| Executor (gsd-executor) - quick | execute.md step 7 | Yes |
| Verifier (gsd-verifier) - quick | execute.md step 9 | Yes |
| Planner (gsd-planner) - milestone | execute.md step b | Yes |
| Executor (gsd-executor) - milestone | execute.md step d | Yes |
| Verifier (gsd-verifier) - milestone | execute.md step e | Yes |
| PR creator (general-purpose) | pr-create.md | Yes |

**All 9 agent spawns in mgw:run are instrumented.**
