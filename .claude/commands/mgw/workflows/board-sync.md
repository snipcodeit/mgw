<purpose>
Shared board sync utilities for MGW pipeline commands. Two functions are exported:

- update_board_status — Called after any pipeline_stage transition to update the board
  item's Status (single-select) field.
- update_board_agent_state — Called around GSD agent spawns to surface the active agent
  in the board item's "AI Agent State" (text) field. Cleared after PR creation.

All board updates are non-blocking: if the board is not configured, if the issue has no
board_item_id, or if the API call fails, the function returns silently. A board sync
failure MUST NEVER block pipeline execution.
</purpose>

## update_board_status

Call this function after any `pipeline_stage` transition in any MGW command.

```bash
# update_board_status — Update board Status field after a pipeline_stage transition
# Args: ISSUE_NUMBER, NEW_PIPELINE_STAGE
# Non-blocking: all failures are silent no-ops
update_board_status() {
  local ISSUE_NUMBER="$1"
  local NEW_STAGE="$2"

  if [ -z "$ISSUE_NUMBER" ] || [ -z "$NEW_STAGE" ]; then
    return 0
  fi

  # Read board project node ID from project.json (non-blocking — if not configured, skip)
  BOARD_NODE_ID=$(python3 -c "
import json, sys
try:
    p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
    print(p.get('project', {}).get('project_board', {}).get('node_id', ''))
except:
    print('')
" 2>/dev/null || echo "")
  if [ -z "$BOARD_NODE_ID" ]; then return 0; fi

  # Get board_item_id for this issue from project.json
  ITEM_ID=$(python3 -c "
import json, sys
try:
    p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
    for m in p.get('milestones', []):
        for i in m.get('issues', []):
            if i.get('github_number') == ${ISSUE_NUMBER}:
                print(i.get('board_item_id', ''))
                sys.exit(0)
    print('')
except:
    print('')
" 2>/dev/null || echo "")
  if [ -z "$ITEM_ID" ]; then return 0; fi

  # Map pipeline_stage to Status field option ID
  # Reads from board-schema.json first, falls back to project.json fields
  FIELD_ID=$(python3 -c "
import json, sys, os
try:
    schema_path = '${REPO_ROOT}/.mgw/board-schema.json'
    if os.path.exists(schema_path):
        s = json.load(open(schema_path))
        print(s.get('fields', {}).get('status', {}).get('field_id', ''))
    else:
        p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
        fields = p.get('project', {}).get('project_board', {}).get('fields', {})
        print(fields.get('status', {}).get('field_id', ''))
except:
    print('')
" 2>/dev/null || echo "")
  if [ -z "$FIELD_ID" ]; then return 0; fi

  OPTION_ID=$(python3 -c "
import json, sys, os
try:
    stage = '${NEW_STAGE}'
    schema_path = '${REPO_ROOT}/.mgw/board-schema.json'
    if os.path.exists(schema_path):
        s = json.load(open(schema_path))
        options = s.get('fields', {}).get('status', {}).get('options', {})
        print(options.get(stage, ''))
    else:
        p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
        fields = p.get('project', {}).get('project_board', {}).get('fields', {})
        options = fields.get('status', {}).get('options', {})
        print(options.get(stage, ''))
except:
    print('')
" 2>/dev/null || echo "")
  if [ -z "$OPTION_ID" ]; then return 0; fi

  # Update the Status field on the board item (non-blocking)
  gh api graphql -f query='
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }
  ' -f projectId="$BOARD_NODE_ID" \
    -f itemId="$ITEM_ID" \
    -f fieldId="$FIELD_ID" \
    -f optionId="$OPTION_ID" 2>/dev/null || true
}
```

## update_board_agent_state

Call this function before spawning each GSD agent and after PR creation to surface
real-time agent activity in the board item's "AI Agent State" text field.

```bash
# update_board_agent_state — Update AI Agent State text field on the board item
# Args: ISSUE_NUMBER, STATE_TEXT (empty string to clear the field)
# Non-blocking: all failures are silent no-ops
update_board_agent_state() {
  local ISSUE_NUMBER="$1"
  local STATE_TEXT="$2"

  if [ -z "$ISSUE_NUMBER" ]; then return 0; fi

  # Read board project node ID from project.json (non-blocking — if not configured, skip)
  BOARD_NODE_ID=$(python3 -c "
import json, sys
try:
    p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
    print(p.get('project', {}).get('project_board', {}).get('node_id', ''))
except:
    print('')
" 2>/dev/null || echo "")
  if [ -z "$BOARD_NODE_ID" ]; then return 0; fi

  # Get board_item_id for this issue from project.json
  ITEM_ID=$(python3 -c "
import json, sys
try:
    p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
    for m in p.get('milestones', []):
        for i in m.get('issues', []):
            if i.get('github_number') == ${ISSUE_NUMBER}:
                print(i.get('board_item_id', ''))
                sys.exit(0)
    print('')
except:
    print('')
" 2>/dev/null || echo "")
  if [ -z "$ITEM_ID" ]; then return 0; fi

  # Get the AI Agent State field ID from board-schema.json or project.json
  FIELD_ID=$(python3 -c "
import json, sys, os
try:
    schema_path = '${REPO_ROOT}/.mgw/board-schema.json'
    if os.path.exists(schema_path):
        s = json.load(open(schema_path))
        print(s.get('fields', {}).get('ai_agent_state', {}).get('field_id', ''))
    else:
        p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
        fields = p.get('project', {}).get('project_board', {}).get('fields', {})
        print(fields.get('ai_agent_state', {}).get('field_id', ''))
except:
    print('')
" 2>/dev/null || echo "")
  if [ -z "$FIELD_ID" ]; then return 0; fi

  # Update the AI Agent State text field on the board item (non-blocking)
  gh api graphql -f query='
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { text: $text }
      }) { projectV2Item { id } }
    }
  ' -f projectId="$BOARD_NODE_ID" \
    -f itemId="$ITEM_ID" \
    -f fieldId="$FIELD_ID" \
    -f text="$STATE_TEXT" 2>/dev/null || true
}
```

## Stage-to-Status Mapping

The Status field options correspond to pipeline_stage values:

| pipeline_stage | Board Status Option |
|----------------|-------------------|
| `new` | New |
| `triaged` | Triaged |
| `needs-info` | Needs Info |
| `needs-security-review` | Needs Security Review |
| `discussing` | Discussing |
| `approved` | Approved |
| `planning` | Planning |
| `executing` | Executing |
| `verifying` | Verifying |
| `pr-created` | PR Created |
| `done` | Done |
| `failed` | Failed |
| `blocked` | Blocked |

Option IDs for each stage are looked up at runtime from:
1. `.mgw/board-schema.json` → `fields.status.options.<stage>` (preferred)
2. `.mgw/project.json` → `project.project_board.fields.status.options.<stage>` (fallback)

## AI Agent State Values

The AI Agent State text field is set before each GSD agent spawn and cleared after PR creation:

| Trigger | Value |
|---------|-------|
| Before gsd-planner spawn (quick route) | `"Planning"` |
| Before gsd-executor spawn (quick route) | `"Executing"` |
| Before gsd-verifier spawn (quick route) | `"Verifying"` |
| Before gsd-planner spawn (milestone, phase N) | `"Planning phase N"` |
| Before gsd-executor spawn (milestone, phase N) | `"Executing phase N"` |
| Before gsd-verifier spawn (milestone, phase N) | `"Verifying phase N"` |
| After PR created | `""` (clears the field) |

## Data Sources

| Field | Source |
|-------|--------|
| `BOARD_NODE_ID` | `project.json` → `project.project_board.node_id` |
| `ITEM_ID` | `project.json` → `milestones[*].issues[*].board_item_id` (set by #73) |
| `FIELD_ID` (status) | `board-schema.json` or `project.json` → `fields.status.field_id` |
| `OPTION_ID` | `board-schema.json` or `project.json` → `fields.status.options.<stage>` |
| `FIELD_ID` (agent state) | `board-schema.json` or `project.json` → `fields.ai_agent_state.field_id` |

## Non-Blocking Contract

Every failure case returns 0 (success) without printing to stderr. The caller is never
aware of board sync failures. This guarantees:

- Board not configured (no `node_id` in project.json) → silent no-op
- Issue has no `board_item_id` → silent no-op (not yet added to board)
- Status field not configured → silent no-op
- AI Agent State field not configured → silent no-op
- Stage has no mapped option ID → silent no-op
- GraphQL API error → silent no-op (`|| true` suppresses exit code)
- Network error → silent no-op

## Touch Points

Source or inline both utilities in any MGW command that spawns GSD agents.

### update_board_status — in issue.md (triage stage transitions)

After writing `pipeline_stage` to the state file in the `write_state` step:
```bash
# After: pipeline_stage written to .mgw/active/<issue>.json
update_board_status $ISSUE_NUMBER "$pipeline_stage"  # non-blocking
```

Transitions in issue.md:
- `needs-info` — validity or detail gate blocked
- `needs-security-review` — security gate blocked
- `triaged` — all gates passed or user override

### update_board_status — in run.md (pipeline stage transitions)

After each `pipeline_stage` checkpoint write to project.json and state file:
```bash
# After: pipeline_stage checkpoint written (state.md "Update Issue Pipeline Stage" pattern)
update_board_status $ISSUE_NUMBER "$NEW_STAGE"  # non-blocking
```

Transitions in run.md:
- `planning` — GSD execution begins
- `executing` — executor agent active
- `verifying` — verifier agent active
- `pr-created` — PR created
- `done` — pipeline complete
- `blocked` — blocking comment detected in preflight_comment_check

### update_board_agent_state — in run.md (around agent spawns)

Called immediately before spawning each GSD agent and after PR creation:
```bash
# Before spawning gsd-planner
update_board_agent_state $ISSUE_NUMBER "Planning phase ${PHASE_NUM}"

# Before spawning gsd-executor
update_board_agent_state $ISSUE_NUMBER "Executing phase ${PHASE_NUM}"

# Before spawning gsd-verifier
update_board_agent_state $ISSUE_NUMBER "Verifying phase ${PHASE_NUM}"

# After PR created (clear the field)
update_board_agent_state $ISSUE_NUMBER ""
```

## Consumers

| Command | Function | When Called |
|---------|----------|-------------|
| issue.md | update_board_status | After writing pipeline_stage in write_state step |
| run.md | update_board_status | After each pipeline_stage checkpoint write |
| run.md | update_board_agent_state | Before each GSD agent spawn, and after PR creation |
