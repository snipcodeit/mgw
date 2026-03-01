<purpose>
Shared board sync utility for MGW pipeline commands. Called after any pipeline_stage
transition to update the corresponding board item's Status field via GitHub Projects v2
GraphQL API.

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

## Data Sources

| Field | Source |
|-------|--------|
| `BOARD_NODE_ID` | `project.json` → `project.project_board.node_id` |
| `ITEM_ID` | `project.json` → `milestones[*].issues[*].board_item_id` (set by #73) |
| `FIELD_ID` | `board-schema.json` or `project.json` → `fields.status.field_id` |
| `OPTION_ID` | `board-schema.json` or `project.json` → `fields.status.options.<stage>` |

## Non-Blocking Contract

Every failure case returns 0 (success) without printing to stderr. The caller is never
aware of board sync failures. This guarantees:

- Board not configured (no `node_id` in project.json) → silent no-op
- Issue has no `board_item_id` → silent no-op (not yet added to board)
- Status field not configured → silent no-op
- Stage has no mapped option ID → silent no-op
- GraphQL API error → silent no-op (`|| true` suppresses exit code)
- Network error → silent no-op

## Touch Points

Source or inline this utility in any MGW command that writes `pipeline_stage`.
Call `update_board_status` immediately after each stage transition write.

### In issue.md (triage stage transitions)

After writing `pipeline_stage` to the state file in the `write_state` step:
```bash
# After: pipeline_stage written to .mgw/active/<issue>.json
update_board_status $ISSUE_NUMBER "$pipeline_stage"  # non-blocking
```

Transitions in issue.md:
- `needs-info` — validity or detail gate blocked
- `needs-security-review` — security gate blocked
- `triaged` — all gates passed or user override

### In run.md (pipeline stage transitions)

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

## Consumers

| Command | When Called |
|---------|-------------|
| issue.md | After writing pipeline_stage in write_state step |
| run.md | After each pipeline_stage checkpoint write |
