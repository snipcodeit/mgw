---
phase: quick-8
plan: 8
type: quick-full
wave: 1
depends_on: []
files_modified:
  - lib/agent-diagnostics.cjs
autonomous: true
requirements:
  - Create lib/agent-diagnostics.cjs for structured diagnostic logging of agent executions
  - Capture agent type, prompt hash, start/end timestamps, turn count, exit reason, output size, failure classification
  - Write diagnostic entries to .mgw/diagnostics/<issue-number>-<timestamp>.json
  - Include prune function to remove entries older than 30 days
  - Logger must be non-blocking — failures in logging never halt the pipeline
  - Integrate with agent failure taxonomy from lib/agent-errors.cjs
must_haves:
  truths:
    - lib/agent-diagnostics.cjs exports createDiagnosticLogger, writeDiagnosticEntry, pruneDiagnostics, and getDiagnosticsDir
    - Diagnostic entries are JSON files at .mgw/diagnostics/<issue-number>-<timestamp>.json
    - Each entry captures agent_type, prompt_hash, start_time, end_time, duration_ms, turn_count, exit_reason, output_size, and failure_classification
    - The prune function removes entries older than 30 days
    - All logging operations are wrapped in try/catch — failures never propagate
    - The failure_classification field uses types from lib/agent-errors.cjs (AGENT_FAILURE_TYPES)
  artifacts:
    - lib/agent-diagnostics.cjs
  key_links:
    - lib/agent-errors.cjs (agent failure taxonomy — defines AGENT_FAILURE_TYPES, classifyAgentFailure)
    - lib/errors.cjs (MgwError base class)
    - lib/retry.cjs (pipeline retry infrastructure — classifyFailure)
    - lib/logger.cjs (existing structured logging — pattern reference)
---

## Objective

Build `lib/agent-diagnostics.cjs` — a structured diagnostic logger for GSD agent executions. The module captures per-agent-invocation telemetry (timing, turns, output size, exit reason, failure classification) and persists it as individual JSON files under `.mgw/diagnostics/`. All operations are non-blocking; logging failures are silently swallowed to ensure the pipeline is never halted by diagnostic infrastructure.

## Context

- **Dependency:** This builds on issue #229's agent failure taxonomy in `lib/agent-errors.cjs`, which defines `AGENT_FAILURE_TYPES` and `classifyAgentFailure()`. The diagnostics logger uses these to classify failures in diagnostic entries.
- **Pattern reference:** `lib/logger.cjs` demonstrates the existing non-blocking logging pattern (try/catch swallowing, `.mgw/` directory structure).
- **Integration point:** The diagnostics module will be consumed by future hooks (issue #231) that instrument agent spawns.

## Tasks

### Task 1: Create lib/agent-diagnostics.cjs

**files:** `lib/agent-diagnostics.cjs`
**action:** Create the diagnostic logger module with these exports:

1. **`getDiagnosticsDir(repoRoot?)`** — Returns `.mgw/diagnostics/` path, creates directory if needed. Pattern follows `getLogDir()` from `lib/logger.cjs`.

2. **`createDiagnosticLogger(opts)`** — Factory that returns a logger instance bound to a specific agent invocation. Accepts:
   - `agentType` (string) — GSD agent type (gsd-planner, gsd-executor, etc.)
   - `issueNumber` (number) — GitHub issue being worked
   - `promptHash` (string, optional) — Hash of the prompt sent to the agent
   - `repoRoot` (string, optional) — Repo root for diagnostics dir

   Returns an object with:
   - `start()` — Records start_time
   - `finish(result)` — Records end_time, calculates duration, writes entry
   - `result` fields: `exitReason` (string), `turnCount` (number), `outputSize` (number), `error` (Error, optional)

3. **`writeDiagnosticEntry(entry, opts?)`** — Low-level write function. Writes a single diagnostic JSON to `.mgw/diagnostics/<issueNumber>-<timestamp>.json`. Fields:
   - `agent_type`, `prompt_hash`, `start_time`, `end_time`, `duration_ms`
   - `turn_count`, `exit_reason`, `output_size`
   - `failure_classification` — null on success, or result of `classifyAgentFailure()` from `lib/agent-errors.cjs` on failure
   - `issue_number`, `timestamp`

4. **`pruneDiagnostics(opts?)`** — Removes diagnostic files older than `maxAgeDays` (default 30). Scans `.mgw/diagnostics/`, parses filenames for timestamps, removes expired entries. Non-blocking.

5. **`readDiagnostics(opts?)`** — Read diagnostic entries with optional filters (issueNumber, agentType, since). Returns parsed JSON array sorted by timestamp descending.

**verify:**
- Module loads without errors: `node -e "require('./lib/agent-diagnostics.cjs')"`
- All five exports exist and are functions
- Non-blocking: wrapping in try/catch is not needed by callers

**done:** Module file exists and exports all functions.

## Verification

- [ ] `lib/agent-diagnostics.cjs` exists and loads cleanly
- [ ] Exports: `getDiagnosticsDir`, `createDiagnosticLogger`, `writeDiagnosticEntry`, `pruneDiagnostics`, `readDiagnostics`
- [ ] Diagnostic entry JSON schema matches spec (agent_type, prompt_hash, start_time, end_time, duration_ms, turn_count, exit_reason, output_size, failure_classification, issue_number, timestamp)
- [ ] Prune function defaults to 30-day retention
- [ ] All I/O operations wrapped in try/catch — never throws
- [ ] References `classifyAgentFailure` from `lib/agent-errors.cjs` for failure classification (graceful fallback if module not available)
- [ ] Follows existing lib/ conventions (JSDoc, 'use strict', module.exports)

## Success Criteria

- The module is self-contained and requires no changes to existing files
- Callers can instrument agent executions with `createDiagnosticLogger()` start/finish pattern
- Diagnostic data persists across pipeline runs for observability
- The prune function prevents unbounded storage growth
- Zero risk of pipeline disruption from logging failures

## Output

- `lib/agent-diagnostics.cjs` — complete implementation
- `.planning/quick/8-issue-230-build-structured-diagnostic-lo/8-SUMMARY.md` — execution summary
