## Summary

**One-liner:** Created `lib/agent-diagnostics.cjs` — a non-blocking diagnostic logger that captures per-agent-invocation telemetry and writes structured JSON entries to `.mgw/diagnostics/`.

### What Was Built

1. **`lib/agent-diagnostics.cjs`** — Complete diagnostic logger module with 7 exports:
   - `getDiagnosticsDir(repoRoot?)` — Returns/creates `.mgw/diagnostics/` directory
   - `createDiagnosticLogger(opts)` — Factory returning `{ start(), finish(result) }` logger bound to an agent invocation
   - `writeDiagnosticEntry(entry, opts?)` — Low-level JSON file writer for diagnostic entries
   - `pruneDiagnostics(opts?)` — Removes entries older than 30 days (configurable)
   - `readDiagnostics(opts?)` — Query entries with filters (issueNumber, agentType, since, limit)
   - `shortHash(input)` — SHA-256 utility for prompt hashing (12 hex chars)
   - `DEFAULT_MAX_AGE_DAYS` — Constant (30)

### Diagnostic Entry Schema

Each JSON file at `.mgw/diagnostics/<issueNumber>-<timestamp>.json` contains:
- `agent_type` — GSD agent type (gsd-planner, gsd-executor, etc.)
- `prompt_hash` — 12-char SHA-256 hash of the prompt
- `start_time` / `end_time` — ISO timestamps
- `duration_ms` — Wall-clock execution time
- `turn_count` — Number of agent turns/iterations
- `exit_reason` — Why the agent stopped (success, error, timeout, etc.)
- `output_size` — Agent output size in bytes
- `failure_classification` — null on success, or classification from agent-errors.cjs
- `issue_number` — GitHub issue number
- `timestamp` — Entry creation timestamp

### Key Design Decisions

1. **Graceful fallback for agent-errors.cjs:** Since PR #238 (issue #229) isn't merged yet, the classification function falls back through `lib/retry.cjs` then to a minimal classification if neither module is available.

2. **Non-blocking guarantees:** Every public function wraps all I/O in try/catch blocks. `writeDiagnosticEntry()` returns `boolean`, `pruneDiagnostics()` returns a result object with error counts, `readDiagnostics()` returns empty arrays on failure. No function ever throws.

3. **File-per-entry storage:** Individual JSON files (not JSONL) enable per-entry deletion for pruning and straightforward reads without parsing.

4. **Filesystem-safe timestamps:** ISO timestamps in filenames have colons and dots replaced with hyphens.

### Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `lib/agent-diagnostics.cjs` | 451 | Diagnostic logger module |

### Testing

Verified with 19 assertions covering:
- Hash generation (correct length, null handling)
- Directory creation
- Entry write/read round-trip
- Logger factory start/finish pattern
- Error classification integration (fallback path)
- Prune function (no false positives on recent entries)
- Non-blocking behavior on invalid inputs
- Filter functionality (agentType, issueNumber, limit)

### Integration Notes

- Ready for issue #231 (diagnostic capture hooks) to instrument agent spawns
- When PR #238 merges, failure classification will automatically upgrade to use `classifyAgentFailure()` from `lib/agent-errors.cjs`
- Follows existing lib/ conventions: `'use strict'`, JSDoc, `module.exports` pattern
