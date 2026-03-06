---
phase: quick-8
plan: 1
type: quick-full
wave: 1
depends_on: []
files_modified:
  - workflows/state.md
  - lib/state.cjs
  - templates/schema.json
  - commands/run/execute.md
  - commands/run/triage.md
autonomous: true
requirements:
  - Design checkpoint schema stored in .mgw/active/<issue>.json
  - Record current pipeline step (triage/plan/execute/verify/pr)
  - Record step-specific progress (e.g., which GSD phase is executing)
  - Record last successful agent output path
  - Record accumulated artifacts
  - Record resume instructions
  - Forward-compatible: new pipeline steps can be added without breaking existing checkpoints
must_haves:
  truths:
    - Checkpoint schema is a new "checkpoint" field on existing issue state JSON
    - Schema includes pipeline_step, step_progress, last_agent_output, artifacts, and resume fields
    - migrateProjectState() in lib/state.cjs handles migration of existing state files (adds checkpoint with defaults)
    - workflows/state.md documents the checkpoint schema alongside existing Issue State Schema
    - commands/run/execute.md references checkpoint updates at key pipeline stages
    - commands/run/triage.md references checkpoint initialization at triage time
    - Schema is forward-compatible via additionalProperties pattern
  artifacts:
    - workflows/state.md (modified — checkpoint schema documentation added)
    - lib/state.cjs (modified — migration adds checkpoint field defaults)
    - templates/schema.json (modified — checkpoint field added to template schema if applicable)
    - commands/run/execute.md (modified — checkpoint update pseudocode at key stages)
    - commands/run/triage.md (modified — checkpoint initialization pseudocode)
  key_links:
    - lib/state.cjs
    - workflows/state.md
    - lib/pipeline.cjs
    - commands/run/execute.md
    - commands/run/triage.md
---

# Plan: Design checkpoint schema for pipeline execution state

## Objective
Design and implement a checkpoint schema that extends the existing `.mgw/active/<issue>.json` issue state format. The checkpoint tracks pipeline execution progress at a granular level, enabling resume after failures, context switches, or multi-session execution.

## Context
The existing issue state schema (defined in `workflows/state.md`) tracks high-level pipeline_stage but lacks fine-grained execution progress. When a pipeline fails mid-execution, there is no record of which GSD phase was running, what artifacts were produced, or how to resume. This issue adds a `checkpoint` field to the existing state object to fill that gap.

## Tasks

### Task 1: Define checkpoint schema and document in workflows/state.md
- **files:** `commands/workflows/state.md`
- **action:** Add a new "## Checkpoint Schema" section to workflows/state.md documenting the checkpoint field structure. The checkpoint field is a nested object within the existing issue state JSON. Document each sub-field with types, defaults, and usage notes. Include a "Forward Compatibility" subsection explaining the extensibility contract.
- **verify:** The new section exists in state.md with complete field documentation.
- **done:** [ ]

### Task 2: Add checkpoint migration to lib/state.cjs
- **files:** `lib/state.cjs`
- **action:** Extend `migrateProjectState()` to add a `checkpoint` field with sensible defaults to active issue state files that lack it. The default checkpoint should be `null` (checkpoint is only populated when pipeline execution begins). Add a helper function `updateCheckpoint(issueNumber, checkpointData)` that merges checkpoint data into an active issue state file (partial updates, preserves existing fields).
- **verify:** Run `node -e "const {migrateProjectState}=require('./lib/state.cjs'); migrateProjectState();"` and verify existing state files get the checkpoint field. Test `updateCheckpoint()` with a simple merge.
- **done:** [ ]

### Task 3: Add checkpoint update pseudocode to pipeline command files
- **files:** `commands/run/execute.md`, `commands/run/triage.md`
- **action:** Add checkpoint initialization at triage (step validate_and_load) and checkpoint update calls at key pipeline stages in execute.md (after planner, after executor, after verifier). These are pseudocode annotations showing where `updateCheckpoint()` should be called and what data to record. Do NOT change actual executable logic — these are documentation annotations for future implementation.
- **verify:** The pseudocode blocks exist at the correct locations in the command files.
- **done:** [ ]

## Verification
- [ ] `checkpoint` field is documented in workflows/state.md with all sub-fields
- [ ] `migrateProjectState()` adds checkpoint field to existing active issue files
- [ ] `updateCheckpoint()` function exists in lib/state.cjs
- [ ] Forward-compatibility contract is documented
- [ ] Pipeline command files reference checkpoint updates at appropriate stages

## Success Criteria
- The checkpoint schema is fully defined and documented
- Existing state files are migrated cleanly (no breaking changes)
- The schema design supports adding new pipeline steps without breaking existing checkpoints
- Pipeline commands show where checkpoints should be updated

## Output
- Modified: workflows/state.md, lib/state.cjs, commands/run/execute.md, commands/run/triage.md
