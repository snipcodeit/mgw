---
phase: quick
plan: 9
type: feature
wave: 1
depends_on: []
files_modified:
  - lib/diagnostic-hooks.cjs
  - commands/run/triage.md
  - commands/run/execute.md
  - commands/run/pr-create.md
  - commands/workflows/gsd.md
autonomous: true
requirements:
  - Instrument all Task() agent spawns in mgw:run with diagnostic capture
  - Capture agent prompt hash, result summary, and errors
  - Non-blocking: failures log warnings and continue pipeline
must_haves:
  truths:
    - lib/diagnostic-hooks.cjs exists with withDiagnostics() wrapper function
    - commands/run/triage.md has diagnostic hooks around comment classifier Task()
    - commands/run/execute.md has diagnostic hooks around planner, checker, executor, verifier Task() spawns
    - commands/run/pr-create.md has diagnostic hooks around PR creation Task()
    - commands/workflows/gsd.md documents the diagnostic hook pattern
  artifacts:
    - lib/diagnostic-hooks.cjs
    - commands/run/triage.md (modified)
    - commands/run/execute.md (modified)
    - commands/run/pr-create.md (modified)
    - commands/workflows/gsd.md (modified)
  key_links:
    - lib/agent-diagnostics.cjs (dependency from #230)
    - lib/diagnostic-hooks.cjs (new)
---

## Objective

Add diagnostic capture hooks to all Task() agent spawns in the mgw:run pipeline
(triage, planner, plan-checker, executor, verifier, PR creator, comment classifier).
Create a helper wrapper in lib/ that makes instrumentation easy and non-blocking.

## Context

Issue #230 created `lib/agent-diagnostics.cjs` with `createDiagnosticLogger()`,
`shortHash()`, and `writeDiagnosticEntry()`. This issue adds the instrumentation
patterns to the command pseudocode files so that each Task() spawn captures
timing, prompt hash, exit reason, and failure classification.

The key design principle: all diagnostic capture is non-blocking. If it fails,
the pipeline logs a warning and continues normally.

## Tasks

### Task 1: Create lib/diagnostic-hooks.cjs helper

- **files:** lib/diagnostic-hooks.cjs
- **action:** Create a helper module that wraps Task() agent spawns with diagnostic
  capture. Provides `wrapAgentSpawn()` which handles before/after timing, prompt
  hashing, result capture, and error handling. All operations are non-blocking
  (try/catch with warning logs). Exports pseudocode-compatible patterns for use
  in command markdown files.
- **verify:** `node -e "require('./lib/diagnostic-hooks.cjs')"` succeeds
- **done:** false

### Task 2: Instrument commands/run/triage.md

- **files:** commands/run/triage.md
- **action:** Add diagnostic capture hooks around the comment classifier Task()
  spawn in the preflight_comment_check step. Add pre-spawn diagnostic logger
  creation and post-spawn finish call.
- **verify:** File contains diagnostic hook pseudocode around classifier Task()
- **done:** false

### Task 3: Instrument commands/run/execute.md

- **files:** commands/run/execute.md
- **action:** Add diagnostic capture hooks around all Task() spawns:
  planner (step 3), plan-checker (step 6), executor (step 7), and verifier
  (step 9). Each gets a pre-spawn logger and post-spawn finish call.
- **verify:** File contains diagnostic hooks around all 4 agent Task() spawns
- **done:** false

### Task 4: Instrument commands/run/pr-create.md

- **files:** commands/run/pr-create.md
- **action:** Add diagnostic capture hook around the PR creation Task() spawn
  in the create_pr step.
- **verify:** File contains diagnostic hook around PR creator Task()
- **done:** false

### Task 5: Document diagnostic hook pattern in workflows/gsd.md

- **files:** commands/workflows/gsd.md
- **action:** Add a section documenting the diagnostic hook pattern for agent
  spawns, referencing lib/diagnostic-hooks.cjs and lib/agent-diagnostics.cjs.
  This ensures future agent spawn additions follow the same pattern.
- **verify:** File contains diagnostic hook pattern documentation
- **done:** false

## Verification

- All Task() spawns in triage.md, execute.md, and pr-create.md are wrapped with diagnostic hooks
- lib/diagnostic-hooks.cjs loads without errors
- Non-blocking pattern is consistent (try/catch, warning log, continue)
- workflows/gsd.md documents the pattern

## Success Criteria

- Every agent spawn point in mgw:run has diagnostic capture
- Capture includes: prompt hash, timing, exit reason, failure classification
- All diagnostic operations are non-blocking
- Pattern is documented for future agent additions
