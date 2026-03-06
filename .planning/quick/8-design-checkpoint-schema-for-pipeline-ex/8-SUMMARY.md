# Summary: Design checkpoint schema for pipeline execution state

## One-Liner
Added a forward-compatible checkpoint schema to the MGW issue state format that tracks fine-grained pipeline progress, accumulated artifacts, and resume instructions for failure recovery.

## Changes Made

### 1. Checkpoint Schema Documentation (workflows/state.md)
- Added comprehensive "Checkpoint Schema" section documenting the new `checkpoint` field
- Defined all sub-fields: `schema_version`, `pipeline_step`, `step_progress`, `last_agent_output`, `artifacts`, `resume`, `started_at`, `updated_at`, `step_history`
- Documented step-specific `step_progress` shapes for each pipeline step (triage, plan, execute, verify, pr)
- Established Forward Compatibility Contract (5 rules: unknown-field preservation, new step extensibility, schema_version bump criteria, append-only arrays, opaque resume.context)
- Added checkpoint lifecycle diagram and update pattern example
- Added consumer reference table showing which commands read/write checkpoints

### 2. Checkpoint Migration & API (lib/state.cjs)
- Extended `migrateProjectState()` to add `checkpoint: null` to active issue files lacking the field (idempotent migration)
- Added `initCheckpoint(pipelineStep)` — creates a fresh checkpoint object with correct defaults and schema_version
- Added `updateCheckpoint(issueNumber, data)` — partial merge updater that:
  - Shallow-merges scalar fields (pipeline_step, last_agent_output)
  - Shallow-merges step_progress (preserves existing keys)
  - Replaces resume entirely (per opaque context contract)
  - Appends to artifacts and step_history arrays (never replaces)
  - Auto-initializes checkpoint if absent
  - Always updates the `updated_at` timestamp
- Exported `CHECKPOINT_SCHEMA_VERSION`, `initCheckpoint`, `updateCheckpoint`

### 3. Pipeline Command Annotations (commands/run/triage.md, commands/run/execute.md)
- Added checkpoint initialization pseudocode in triage.md (validate_and_load step)
- Added checkpoint update calls at three key pipeline stages in execute.md:
  - After planner agent completes (step 4 — records plan path and sets resume to plan-checker/executor)
  - After executor agent completes (step 8 — records summary and sets resume to verifier/PR)
  - After verifier agent completes (step 10 — records verification and sets resume to PR creation)

## Key Files
- `commands/workflows/state.md` — 172 lines added (schema docs, lifecycle, consumers)
- `lib/state.cjs` — 135 lines added (migration, initCheckpoint, updateCheckpoint)
- `commands/run/triage.md` — 16 lines added (checkpoint init pseudocode)
- `commands/run/execute.md` — 64 lines added (checkpoint update pseudocode at 3 stages)

## Technical Decisions
- **checkpoint: null default** — checkpoint is only populated when pipeline execution begins, keeping triage-only state files lightweight
- **schema_version field** — enables future migration without parsing ambiguity
- **Append-only arrays** — artifacts and step_history never lose data, supporting audit trails
- **Opaque resume.context** — step-specific resume data evolves independently without cross-step coupling
- **Shallow merge in step_progress** — allows incremental updates without requiring full progress state on every call

## Verification
- [x] migrateProjectState() adds checkpoint field to existing active issue files
- [x] initCheckpoint() creates valid checkpoint structure with schema_version=1
- [x] updateCheckpoint() correctly merges partial data (tested: scalar merge, append-only arrays, step_progress merge)
- [x] Forward-compatibility contract documented with 5 explicit rules
- [x] Pipeline command files reference checkpoint updates at appropriate stages
