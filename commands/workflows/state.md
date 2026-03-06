<purpose>
Shared state management for MGW commands. Handles .mgw/ directory initialization,
issue state read/write, cross-ref management, and staleness detection against GitHub.
Every command that touches .mgw/ state references this file.
</purpose>

## Directory Structure

`.mgw/` lives at repo root, is gitignored, and is local-only per developer.

```
.mgw/
  config.json        # User prefs (github username, default filters)
  active/            # In-progress issue pipelines
    <number>-<slug>.json
  completed/         # Archived after PR merged/issue closed
  cross-refs.json    # Bidirectional issue/PR/branch links
```

## validate_and_load

Single entry point for state initialization. Every command that touches .mgw/ calls
this pattern at startup. It ensures directory structure, gitignore entries, cross-refs,
and runs a lightweight staleness check.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
MGW_DIR="${REPO_ROOT}/.mgw"

# 1. Ensure directory structure
mkdir -p "${MGW_DIR}/active" "${MGW_DIR}/completed"

# 2. Ensure gitignore entries
for ENTRY in ".mgw/" ".worktrees/"; do
  if ! grep -q "^\\${ENTRY}\$" "${REPO_ROOT}/.gitignore" 2>/dev/null; then
    echo "${ENTRY}" >> "${REPO_ROOT}/.gitignore"
  fi
done

# 3. Initialize cross-refs if missing
if [ ! -f "${MGW_DIR}/cross-refs.json" ]; then
  echo '{"links":[]}' > "${MGW_DIR}/cross-refs.json"
fi

# 4. Migrate project.json schema (idempotent — adds new fields without overwriting)
# This ensures all commands see gsd_milestone_id, gsd_state, active_gsd_milestone, etc.
# Non-blocking: if migration fails for any reason, continue silently.
if [ -f "${MGW_DIR}/project.json" ]; then
  node -e "
const { migrateProjectState } = require('./lib/state.cjs');
try { migrateProjectState(); } catch(e) { /* non-blocking */ }
" 2>/dev/null || true
fi

# 5. Run staleness check (see Staleness Detection below)
# Only if active issues exist — skip for commands that don't need it (e.g., init, help)
if ls "${MGW_DIR}/active/"*.json 1>/dev/null 2>&1; then
  check_staleness "${MGW_DIR}"
fi
```

## Staleness Detection

Lightweight check comparing GitHub `updatedAt` timestamps with local state file
modification times. Runs on every MGW command that touches state. Non-blocking:
if the check fails (network error, API limit), log a warning and continue.

### Per-Issue Check
For commands that operate on a specific issue:

```bash
# Non-blocking: if check fails, continue with warning
check_issue_staleness() {
  local ISSUE_NUMBER="$1"
  local STATE_FILE="$2"

  # Get GitHub's last update timestamp
  GH_UPDATED=$(gh issue view "$ISSUE_NUMBER" --json updatedAt -q .updatedAt 2>/dev/null)
  if [ -z "$GH_UPDATED" ]; then
    return 0  # Can't check — don't block
  fi

  # Compare with local state file modification time
  LOCAL_MTIME=$(stat -c %Y "$STATE_FILE" 2>/dev/null || echo "0")
  GH_EPOCH=$(date -d "$GH_UPDATED" +%s 2>/dev/null || echo "0")

  if [ "$GH_EPOCH" -gt "$LOCAL_MTIME" ]; then
    echo "MGW: Stale state detected for #${ISSUE_NUMBER} — auto-syncing..."
    # Re-fetch issue data and update local state
    FRESH_DATA=$(gh issue view "$ISSUE_NUMBER" --json number,title,body,labels,assignees,state,comments,url,milestone 2>/dev/null)
    if [ -n "$FRESH_DATA" ]; then
      # Update the issue section of the state file (preserve pipeline_stage, triage, etc.)
      # Implementation: read state JSON, update .issue fields, write back
      touch "$STATE_FILE"  # Update mtime to prevent re-triggering
    fi
    return 1  # Stale — caller can react
  fi
  return 0  # Fresh
}
```

### Batch Check (Milestone-Level)
For commands that check across all active issues in a single API call:

```bash
# Single GraphQL call for all open issues — use for milestone operations
check_batch_staleness() {
  local MGW_DIR="$1"

  OWNER=$(gh repo view --json owner -q .owner.login 2>/dev/null)
  REPO=$(gh repo view --json name -q .name 2>/dev/null)

  if [ -z "$OWNER" ] || [ -z "$REPO" ]; then
    return 0  # Can't check — don't block
  fi

  ISSUES_JSON=$(gh api graphql -f query='
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        issues(first: 50, states: OPEN) {
          nodes { number updatedAt }
        }
      }
    }
  ' -f owner="$OWNER" -f repo="$REPO" --jq '.data.repository.issues.nodes' 2>/dev/null)

  if [ -z "$ISSUES_JSON" ]; then
    return 0  # Can't check — don't block
  fi

  # Compare each issue's updatedAt with local state file mtime
  # Flag any stale issues for sync
  echo "$ISSUES_JSON"
}
```

### Staleness Behavior
- When stale state is detected: **auto-sync with notice** — sync automatically, print one line telling the user it happened, do not block
- When the check fails (network, API limit, error): **continue silently** — never let staleness detection prevent command execution
- Scope: covers **both milestone-level and issue-level state**

## Comment Tracking

Comment tracking detects new comments posted on an issue between triage and execution.
The `triage.last_comment_count` and `triage.last_comment_at` fields are populated during
triage (issue.md) and checked before GSD execution begins (run.md).

### Comment Tracking Fields

| Field | Type | Set By | Description |
|-------|------|--------|-------------|
| `triage.last_comment_count` | number | issue.md | Total comment count at triage time |
| `triage.last_comment_at` | string\|null | issue.md | ISO timestamp of most recent comment at triage time |

### Pre-Flight Comment Check

Before GSD execution starts, run.md compares current comment count against the stored
count. If new comments are detected, they are classified before proceeding:

```bash
# Fetch current comment state from GitHub
CURRENT_COMMENTS=$(gh issue view $ISSUE_NUMBER --json comments --jq '.comments | length')
STORED_COMMENTS="${triage.last_comment_count}"

if [ "$CURRENT_COMMENTS" -gt "$STORED_COMMENTS" ]; then
  # New comments detected — fetch and classify
  NEW_COMMENT_BODIES=$(gh issue view $ISSUE_NUMBER --json comments \
    --jq "[.comments[-$(($CURRENT_COMMENTS - $STORED_COMMENTS)):]] | .[].body")
fi
```

### Comment Classification

New comments are classified by a general-purpose agent into one of three categories:

| Classification | Meaning | Pipeline Action |
|---------------|---------|-----------------|
| **material** | Changes scope, requirements, or acceptance criteria | Flag for re-triage — update state, re-run triage analysis |
| **informational** | Status update, +1, question, acknowledgment | Log and continue — no pipeline impact |
| **blocking** | Explicit "don't work on this yet", "hold", "wait" | Pause pipeline — set pipeline_stage to "blocked" |

The classification agent receives the new comment bodies and the issue context, and returns
a JSON result:

```json
{
  "classification": "material|informational|blocking",
  "reasoning": "Brief explanation",
  "new_requirements": ["list of new requirements if material"],
  "blocking_reason": "reason if blocking"
}
```

### Comment Delta in Drift Detection

sync.md includes comment delta as a drift signal. If the current comment count differs
from `triage.last_comment_count`, the issue is flagged as having unreviewed comments
in the sync report.

## Issue State Schema

File: `.mgw/active/<number>-<slug>.json`

```json
{
  "issue": {
    "number": 42,
    "title": "Short title",
    "url": "https://github.com/owner/repo/issues/42",
    "labels": ["bug"],
    "assignee": "username"
  },
  "triage": {
    "scope": { "files": 0, "systems": [] },
    "validity": "pending|confirmed|invalid",
    "security_notes": "",
    "conflicts": [],
    "last_comment_count": 0,
    "last_comment_at": null,
    "gate_result": {
      "status": "passed|blocked",
      "blockers": [],
      "warnings": [],
      "missing_fields": []
    }
  },
  "gsd_route": null,
  "gsd_artifacts": { "type": null, "path": null },
  "pipeline_stage": "new|triaged|needs-info|needs-security-review|discussing|approved|planning|diagnosing|executing|verifying|pr-created|done|failed|blocked",
  "checkpoint": null,
  "comments_posted": [],
  "linked_pr": null,
  "linked_issues": [],
  "linked_branches": [],
  "checkpoint": null
}
```

## Checkpoint Schema

The `checkpoint` field in `.mgw/active/<number>-<slug>.json` tracks fine-grained pipeline
execution progress. It enables resume after failures, context switches, or multi-session
execution. The field is `null` until pipeline execution begins (set during the triage-to-
executing transition).

### Checkpoint Object Structure

```json
{
  "checkpoint": {
    "schema_version": 1,
    "pipeline_step": "triage|plan|execute|verify|pr",
    "step_progress": {},
    "last_agent_output": null,
    "artifacts": [],
    "resume": {
      "action": null,
      "context": {}
    },
    "started_at": "2026-03-06T12:00:00Z",
    "updated_at": "2026-03-06T12:05:00Z",
    "step_history": []
  }
}
```

### Checkpoint Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `schema_version` | integer | `1` | Schema version for forward-compatibility. Consumers check this before parsing. New fields can be added without bumping; bump only for breaking structural changes. |
| `pipeline_step` | string | `"triage"` | Current high-level pipeline step. Values: `"triage"`, `"plan"`, `"execute"`, `"verify"`, `"pr"`. Maps to GSD lifecycle stages but at a coarser grain than `pipeline_stage`. |
| `step_progress` | object | `{}` | Step-specific progress data. Shape varies by `pipeline_step` (see Step Progress Shapes below). Unknown keys are preserved on read -- consumers must not strip unrecognized fields. |
| `last_agent_output` | string\|null | `null` | File path (relative to repo root) of the last successful agent output. Updated after each agent spawn completes. Used for resume context injection. |
| `artifacts` | array | `[]` | Accumulated artifact paths produced during this pipeline run. Each entry is `{ "path": "relative/path", "type": "plan\|summary\|verification\|commit", "created_at": "ISO" }`. Append-only -- never remove entries. |
| `resume` | object | `{ "action": null, "context": {} }` | Instructions for resuming execution. `action` is a string describing what to do next (e.g., `"spawn-executor"`, `"retry-verifier"`, `"create-pr"`). `context` carries step-specific data needed for resume (e.g., `{ "phase_number": 3, "plan_path": ".planning/..." }`). |
| `started_at` | string | ISO timestamp | When checkpoint tracking began for this pipeline run. |
| `updated_at` | string | ISO timestamp | When the checkpoint was last modified. Updated on every checkpoint write. |
| `step_history` | array | `[]` | Ordered log of completed steps. Each entry: `{ "step": "plan", "completed_at": "ISO", "agent_type": "gsd-planner", "output_path": "..." }`. Append-only. |

### Step Progress Shapes

The `step_progress` object has a different shape depending on the current `pipeline_step`.
These are the documented shapes; future pipeline steps can define their own without breaking
existing consumers (unknown keys are preserved).

**When `pipeline_step` is `"triage"`:**
```json
{
  "comment_check_done": false,
  "route_selected": null
}
```

**When `pipeline_step` is `"plan"`:**
```json
{
  "plan_path": null,
  "plan_checked": false,
  "revision_count": 0
}
```

**When `pipeline_step` is `"execute"`:**
```json
{
  "gsd_phase": null,
  "total_phases": null,
  "current_task": null,
  "tasks_completed": 0,
  "tasks_total": null,
  "commits": []
}
```

**When `pipeline_step` is `"verify"`:**
```json
{
  "verification_path": null,
  "must_haves_checked": false,
  "artifact_check_done": false,
  "keylink_check_done": false
}
```

**When `pipeline_step` is `"pr"`:**
```json
{
  "branch_pushed": false,
  "pr_number": null,
  "pr_url": null
}
```

### Forward Compatibility Contract

1. **New fields can be added** to the checkpoint object at any level without incrementing
   `schema_version`. Consumers must tolerate unknown fields (preserve on read-modify-write,
   ignore on read-only access).

2. **New `pipeline_step` values** can be introduced freely. Existing step_progress shapes
   are not affected. The `step_progress` for an unrecognized step should be treated as an
   opaque object (pass through unchanged).

3. **`schema_version` bump** is required only when an existing field changes its type,
   semantics, or is removed. When bumped, `migrateProjectState()` in `lib/state.cjs` must
   handle the migration.

4. **`artifacts` and `step_history` are append-only**. Consumers should never modify or
   remove entries from these arrays. They may be compacted during archival (when pipeline
   reaches `done` stage and state moves to `.mgw/completed/`).

5. **`resume.context` is opaque** to all consumers except the specific resume handler for
   the given `resume.action`. This allows step-specific resume data to evolve independently.

### Checkpoint Lifecycle

```
triage (checkpoint initialized, pipeline_step="triage")
  |
  v
plan (pipeline_step="plan", step_progress tracks planning state)
  |
  v
execute (pipeline_step="execute", step_progress tracks GSD phase/task progress)
  |
  v
verify (pipeline_step="verify", step_progress tracks verification checks)
  |
  v
pr (pipeline_step="pr", step_progress tracks PR creation)
  |
  v
done (checkpoint frozen — archived to .mgw/completed/)
```

### Checkpoint Update Pattern

```bash
# Update checkpoint at key pipeline stages using updateCheckpoint()
node -e "
const { updateCheckpoint } = require('./lib/state.cjs');
updateCheckpoint(${ISSUE_NUMBER}, {
  pipeline_step: 'execute',
  step_progress: {
    gsd_phase: ${PHASE_NUMBER},
    tasks_completed: ${COMPLETED},
    tasks_total: ${TOTAL}
  },
  last_agent_output: '${OUTPUT_PATH}',
  resume: {
    action: 'continue-execution',
    context: { phase_number: ${PHASE_NUMBER} }
  }
});
"
```

### Consumers

| Consumer | Access Pattern |
|----------|---------------|
| run/triage.md | Initialize checkpoint at triage (`pipeline_step: "triage"`) |
| run/execute.md | Update checkpoint after each agent spawn (`pipeline_step: "plan"\|"execute"\|"verify"`) |
| run/pr-create.md | Update checkpoint at PR creation (`pipeline_step: "pr"`) |
| milestone.md | Read checkpoint to determine resume point for failed issues |
| status.md | Read checkpoint for detailed progress display |
| sync.md | Compare checkpoint state against GitHub for drift detection |

## Stage Flow Diagram

```
new --> triaged         (triage passes all gates)
new --> needs-info      (validity=invalid OR insufficient detail)
new --> needs-security-review  (security=high)

needs-info --> triaged  (re-triage after info provided)
needs-security-review --> triaged  (re-triage after security ack)

triaged --> discussing  (new-milestone route, large scope)
triaged --> approved    (discussion complete, ready for execution)
triaged --> planning    (direct route, skip discussion)
triaged --> diagnosing  (gsd:diagnose-issues route)

discussing --> approved (stakeholder approval)
approved --> planning

planning --> executing
diagnosing --> planning  (root cause found, proceeding to fix)
diagnosing --> blocked   (investigation inconclusive)
executing --> verifying
verifying --> pr-created
pr-created --> done

Any stage --> blocked   (blocking comment detected)
blocked --> triaged     (re-triage after blocker resolved)
Any stage --> failed    (unrecoverable error)
```

## Pipeline Checkpoints

Fine-grained pipeline progress tracking within `.mgw/active/<number>-<slug>.json`.
The `checkpoint` field starts as `null` and is initialized when the pipeline first
transitions past triage. Each subsequent stage writes an atomic checkpoint update.

### Checkpoint Schema

```json
{
  "checkpoint": {
    "schema_version": 1,
    "pipeline_step": "triage|plan|execute|verify|pr",
    "step_progress": {},
    "last_agent_output": null,
    "artifacts": [],
    "resume": { "action": null, "context": {} },
    "started_at": "ISO timestamp",
    "updated_at": "ISO timestamp",
    "step_history": []
  }
}
```

| Field | Type | Merge Strategy | Description |
|-------|------|---------------|-------------|
| `schema_version` | number | — | Checkpoint format version (currently 1) |
| `pipeline_step` | string | overwrite | Current pipeline step: `triage`, `plan`, `execute`, `verify`, `pr` |
| `step_progress` | object | shallow merge | Step-specific progress (e.g., `{ plan_path: "...", plan_checked: false }`) |
| `last_agent_output` | string\|null | overwrite | Path or URL of the last agent's output |
| `artifacts` | array | append-only | `[{ path, type, created_at }]` — never removed, only appended |
| `resume` | object | full replace | `{ action, context }` — what to do if pipeline restarts |
| `started_at` | string | — | ISO timestamp when checkpoint was first created |
| `updated_at` | string | auto | ISO timestamp of last update (set automatically) |
| `step_history` | array | append-only | `[{ step, completed_at, agent_type, output_path }]` — audit trail |

### Atomic Writes

All checkpoint writes use `atomicWriteJson()` from `lib/state.cjs`:

```bash
# atomicWriteJson(filePath, data) — write to .tmp then rename.
# POSIX rename is atomic on the same filesystem, so a crash mid-write
# never leaves a corrupt state file.
```

The `updateCheckpoint()` function uses `atomicWriteJson()` internally. Commands
should always use `updateCheckpoint()` rather than writing checkpoints directly:

```bash
node -e "
const { updateCheckpoint } = require('./lib/state.cjs');
updateCheckpoint(${ISSUE_NUMBER}, {
  pipeline_step: 'plan',
  step_progress: { plan_path: '...', plan_checked: false },
  artifacts: [{ path: '...', type: 'plan', created_at: new Date().toISOString() }],
  step_history: [{ step: 'plan', completed_at: new Date().toISOString(), agent_type: 'gsd-planner', output_path: '...' }],
  resume: { action: 'spawn-executor', context: { quick_dir: '...' } }
});
" 2>/dev/null || true
```

### Checkpoint Lifecycle

| Pipeline Step | Checkpoint `pipeline_step` | Resume Action |
|--------------|---------------------------|---------------|
| Triage complete | `triage` | `begin-execution` |
| Planner complete | `plan` | `run-plan-checker` or `spawn-executor` |
| Executor complete | `execute` | `spawn-verifier` or `create-pr` |
| Verifier complete | `verify` | `create-pr` |
| PR created | `pr` | `cleanup` |

### Migration

`migrateProjectState()` adds the `checkpoint: null` field to any issue state
files that predate checkpoint support. The field is initialized lazily — it
stays `null` until the pipeline actually runs.

## Slug Generation

Use gsd-tools for consistent slug generation:
```bash
SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${issue_title}" --raw)
SLUG="${SLUG:0:40}"  # gsd-tools doesn't truncate; MGW enforces 40-char limit
```

## Timestamps

Use gsd-tools for ISO timestamp generation:
```bash
TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw)
```

## Cross-Refs Schema

File: `.mgw/cross-refs.json`

```json
{
  "links": [
    { "a": "issue:42", "b": "issue:43", "type": "related", "created": "2026-02-24T10:00:00Z" },
    { "a": "issue:42", "b": "pr:15", "type": "implements", "created": "2026-02-24T12:00:00Z" },
    { "a": "issue:42", "b": "branch:fix/auth-42", "type": "tracks", "created": "2026-02-24T10:00:00Z" }
  ]
}
```

### Link Types
| a | b | type |
|---|---|------|
| issue | issue | related |
| issue | pr | implements |
| issue | branch | tracks |
| pr | branch | tracks |

## Project State (project.json)

File: `.mgw/project.json` — Created by `/mgw:project`, read/updated by `/mgw:milestone` and `/mgw:next`.

### Read Project State
```bash
MGW_DIR="${REPO_ROOT}/.mgw"
PROJECT_JSON=$(cat "${MGW_DIR}/project.json" 2>/dev/null)
if [ -z "$PROJECT_JSON" ]; then
  echo "No project initialized. Run /mgw:project first."
  exit 1
fi

# Resolve active milestone index — supports both new schema (active_gsd_milestone string)
# and legacy schema (current_milestone 1-indexed integer).
ACTIVE_IDX=$(node -e "
const { loadProjectState, resolveActiveMilestoneIndex } = require('./lib/state.cjs');
const state = loadProjectState();
console.log(resolveActiveMilestoneIndex(state));
")
CURRENT_MILESTONE=$((ACTIVE_IDX + 1))  # 1-indexed for display/legacy compat
```

### Read Milestone Issues
```bash
MILESTONE_ISSUES=$(node -e "
const { loadProjectState, resolveActiveMilestoneIndex } = require('./lib/state.cjs');
const state = loadProjectState();
const idx = resolveActiveMilestoneIndex(state);
if (idx < 0) { console.error('No active milestone'); process.exit(1); }
console.log(JSON.stringify(state.milestones[idx].issues || [], null, 2));
")
```

### Update Issue Pipeline Stage
Used after each `/mgw:run` completion to checkpoint progress.
```bash
node -e "
const { loadProjectState, resolveActiveMilestoneIndex, writeProjectState } = require('./lib/state.cjs');
const state = loadProjectState();
const idx = resolveActiveMilestoneIndex(state);
if (idx < 0) { console.error('No active milestone'); process.exit(1); }
const issue = (state.milestones[idx].issues || []).find(i => i.github_number === ${ISSUE_NUMBER});
if (issue) { issue.pipeline_stage = '${NEW_STAGE}'; }
writeProjectState(state);
"
```

Valid stages: `new`, `triaged`, `planning`, `diagnosing`, `executing`, `verifying`, `pr-created`, `done`, `failed`, `blocked`.

### Advance Current Milestone
Used after milestone completion to move pointer to next milestone.
```bash
node -e "
const { loadProjectState, resolveActiveMilestoneIndex, writeProjectState } = require('./lib/state.cjs');
const state = loadProjectState();
const currentIdx = resolveActiveMilestoneIndex(state);
const next = (state.milestones || [])[currentIdx + 1];
if (next) {
  state.active_gsd_milestone = next.gsd_milestone_id || null;
  if (!state.active_gsd_milestone) {
    state.current_milestone = currentIdx + 2; // legacy fallback
  }
} else {
  state.active_gsd_milestone = null;
  state.current_milestone = currentIdx + 2; // past end, signals completion
}
writeProjectState(state);
"
```

Only advance if ALL issues in current milestone completed successfully.

### Phase Map Usage

The `phase_map` in project.json maps GSD phase numbers to their metadata. This is the
bridge between MGW's issue tracking and GSD's phase-based execution:

```json
{
  "phase_map": {
    "1": {"milestone_index": 0, "gsd_route": "plan-phase", "name": "Core Data Models"},
    "2": {"milestone_index": 0, "gsd_route": "plan-phase", "name": "API Endpoints"},
    "3": {"milestone_index": 1, "gsd_route": "plan-phase", "name": "Frontend Components"}
  }
}
```

Each issue in project.json has a `phase_number` field that indexes into this map.
When `/mgw:run` picks up an issue, it reads the `phase_number` to determine which
GSD phase directory (`.planning/phases/{NN}-{slug}/`) to operate in.

Issues created outside of `/mgw:project` (e.g., manually filed bugs) will not have
a `phase_number`. In this case, `/mgw:run` falls back to the quick pipeline.

## Consumers

| Pattern | Referenced By |
|---------|-------------|
| validate_and_load | init.md, issue.md, run.md, update.md, link.md, pr.md, sync.md, milestone.md, ask.md |
| Per-issue staleness | run.md, issue.md, update.md |
| Batch staleness | sync.md (full reconciliation), milestone.md |
| Comment tracking | issue.md (populate), run.md (pre-flight check), sync.md (drift detection) |
| Issue state schema | issue.md, run.md, update.md, sync.md |
| Cross-refs schema | link.md, run.md, pr.md, sync.md |
| Slug generation | issue.md, run.md |
| Project state | milestone.md, next.md, ask.md |
| Gate result schema | issue.md (populate), run.md (validate) |
| Board status sync | board-sync.md (utility), issue.md (triage transitions), run.md (pipeline transitions) |
| Checkpoint writes | triage.md (init), execute.md (plan/execute/verify), pr-create.md (pr) |
| Atomic writes | lib/state.cjs (`atomicWriteJson`, `updateCheckpoint`) |
