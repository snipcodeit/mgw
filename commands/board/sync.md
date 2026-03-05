---
name: board:sync
description: Reconcile all board items with current .mgw/active/ state
---

<step name="subcommand_sync">
**Execute 'sync' subcommand:**

Only run if `$SUBCOMMAND = "sync"`.

Reconcile all `.mgw/active/*.json` state files with their GitHub Projects v2 board items.
Adds missing issues to the board, then updates Status, AI Agent State, Phase, and
Milestone fields to match current local state. Prints a reconciliation diff table.

```bash
if [ "$SUBCOMMAND" = "sync" ]; then
  if [ "$BOARD_CONFIGURED" = "false" ]; then
    echo "No board configured. Run /mgw:board create first."
    exit 1
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " MGW ► BOARD SYNC: ${PROJECT_NAME}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
```

**Collect active state files:**

```bash
  ACTIVE_DIR="${MGW_DIR}/active"

  if ! ls "${ACTIVE_DIR}"/*.json 1>/dev/null 2>&1; then
    echo "No active issues found in ${ACTIVE_DIR}/"
    echo "Nothing to sync."
    exit 0
  fi

  ACTIVE_FILES=$(ls "${ACTIVE_DIR}"/*.json 2>/dev/null)
  ACTIVE_COUNT=$(echo "$ACTIVE_FILES" | wc -l)

  echo "Reconciling ${ACTIVE_COUNT} active issues against board..."
  echo ""
```

**Read field IDs from project.json:**

```bash
  STATUS_FIELD_ID=$(echo "$FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
print(fields.get('status', {}).get('field_id', ''))
" 2>/dev/null)

  AI_STATE_FIELD_ID=$(echo "$FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
print(fields.get('ai_agent_state', {}).get('field_id', ''))
" 2>/dev/null)

  PHASE_FIELD_ID=$(echo "$FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
print(fields.get('phase', {}).get('field_id', ''))
" 2>/dev/null)

  MILESTONE_FIELD_ID=$(echo "$FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
print(fields.get('milestone', {}).get('field_id', ''))
" 2>/dev/null)

  STATUS_OPTIONS=$(echo "$FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
print(json.dumps(fields.get('status', {}).get('options', {})))
" 2>/dev/null || echo "{}")
```

**Fetch all current board items in a single GraphQL call:**

```bash
  echo "Fetching current board items from GitHub..."

  BOARD_ITEMS_RESULT=$(gh api graphql -f query='
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100) {
            nodes {
              id
              content {
                ... on Issue {
                  number
                  id
                }
                ... on PullRequest {
                  number
                  id
                }
              }
              fieldValues(first: 10) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2SingleSelectField { name } }
                  }
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field { ... on ProjectV2Field { name } }
                  }
                }
              }
            }
          }
        }
      }
    }
  ' -f projectId="$BOARD_NODE_ID" 2>/dev/null)

  # Build: issue_number -> {item_id, current_status, current_ai_state, current_phase, current_milestone}
  BOARD_ITEM_MAP=$(echo "$BOARD_ITEMS_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
nodes = d.get('data', {}).get('node', {}).get('items', {}).get('nodes', [])
result = {}
for node in nodes:
    content = node.get('content', {})
    if not content:
        continue
    num = content.get('number')
    if num is None:
        continue
    item_id = node.get('id', '')
    status = ''
    ai_state = ''
    phase = ''
    milestone = ''
    for fv in node.get('fieldValues', {}).get('nodes', []):
        fname = fv.get('field', {}).get('name', '')
        if fname == 'Status':
            status = fv.get('name', '')
        elif fname == 'AI Agent State':
            ai_state = fv.get('text', '')
        elif fname == 'Phase':
            phase = fv.get('text', '')
        elif fname == 'Milestone':
            milestone = fv.get('text', '')
    result[str(num)] = {
        'item_id': item_id,
        'status': status,
        'ai_agent_state': ai_state,
        'phase': phase,
        'milestone': milestone
    }
print(json.dumps(result))
" 2>/dev/null || echo "{}")

  if [ "$BOARD_ITEM_MAP" = "{}" ] && [ -n "$BOARD_ITEMS_RESULT" ]; then
    echo "WARNING: Could not parse board items. Continuing with empty map."
  fi
```

**Reconcile each active state file:**

```bash
  SYNC_RESULTS=()
  UPDATED_COUNT=0
  ADDED_COUNT=0
  ERROR_COUNT=0

  for STATE_FILE in $ACTIVE_FILES; do
    # Parse state file
    ISSUE_DATA=$(python3 -c "
import json,sys
try:
    s = json.load(open('${STATE_FILE}'))
    num = str(s.get('issue', {}).get('number', ''))
    title = s.get('issue', {}).get('title', 'Unknown')[:45]
    stage = s.get('pipeline_stage', 'new')
    route = s.get('gsd_route', '') or ''
    labels = s.get('issue', {}).get('labels', [])
    # Extract phase from labels matching 'phase:*'
    phase_val = ''
    for lbl in labels:
        if isinstance(lbl, str) and lbl.startswith('phase:'):
            phase_val = lbl.replace('phase:', '')
            break
        elif isinstance(lbl, dict) and lbl.get('name', '').startswith('phase:'):
            phase_val = lbl['name'].replace('phase:', '')
            break
    print(json.dumps({'number': num, 'title': title, 'stage': stage, 'route': route, 'phase': phase_val}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
" 2>/dev/null || echo '{"error":"parse failed"}')

    ISSUE_NUMBER=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('number',''))" 2>/dev/null)
    ISSUE_TITLE=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('title','Unknown'))" 2>/dev/null)
    PIPELINE_STAGE=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('stage','new'))" 2>/dev/null)
    PHASE_VALUE=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('phase',''))" 2>/dev/null)

    if [ -z "$ISSUE_NUMBER" ]; then
      SYNC_RESULTS+=("| ? | (parse error: ${STATE_FILE##*/}) | — | ERROR: could not read state |")
      ERROR_COUNT=$((ERROR_COUNT + 1))
      continue
    fi

    # Look up board item
    ITEM_DATA=$(echo "$BOARD_ITEM_MAP" | python3 -c "
import json,sys
m = json.load(sys.stdin)
d = m.get('${ISSUE_NUMBER}', {})
print(json.dumps(d))
" 2>/dev/null || echo "{}")

    BOARD_ITEM_ID=$(echo "$ITEM_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('item_id',''))" 2>/dev/null)
    CURRENT_STATUS=$(echo "$ITEM_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
    CURRENT_PHASE=$(echo "$ITEM_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('phase',''))" 2>/dev/null)
    CURRENT_MILESTONE=$(echo "$ITEM_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('milestone',''))" 2>/dev/null)

    CHANGED_FIELDS=""

    # If issue is not on board, add it
    if [ -z "$BOARD_ITEM_ID" ]; then
      ISSUE_NODE_ID=$(gh issue view "$ISSUE_NUMBER" --json id -q .id 2>/dev/null || echo "")
      if [ -n "$ISSUE_NODE_ID" ]; then
        ADD_RESULT=$(gh api graphql -f query='
          mutation($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
              item { id }
            }
          }
        ' -f projectId="$BOARD_NODE_ID" -f contentId="$ISSUE_NODE_ID" \
          --jq '.data.addProjectV2ItemById.item.id' 2>/dev/null || echo "")

        if [ -n "$ADD_RESULT" ]; then
          BOARD_ITEM_ID="$ADD_RESULT"
          CHANGED_FIELDS="added to board"
          ADDED_COUNT=$((ADDED_COUNT + 1))
        else
          SYNC_RESULTS+=("| #${ISSUE_NUMBER} | ${ISSUE_TITLE} | ${PIPELINE_STAGE} | ERROR: could not add to board |")
          ERROR_COUNT=$((ERROR_COUNT + 1))
          continue
        fi
      else
        SYNC_RESULTS+=("| #${ISSUE_NUMBER} | ${ISSUE_TITLE} | ${PIPELINE_STAGE} | ERROR: could not resolve issue node ID |")
        ERROR_COUNT=$((ERROR_COUNT + 1))
        continue
      fi
    fi

    # Get milestone title from project.json for this issue's milestone
    MILESTONE_VALUE=$(python3 -c "
import json,sys
try:
    p = json.load(open('${MGW_DIR}/project.json'))
    current_ms = p.get('current_milestone', 1)
    for i, m in enumerate(p.get('milestones', []), 1):
        for issue in m.get('issues', []):
            if str(issue.get('github_number', '')) == '${ISSUE_NUMBER}':
                print(m.get('title', ''))
                sys.exit(0)
    print('')
except:
    print('')
" 2>/dev/null)

    # Update Status field if it differs
    if [ -n "$STATUS_FIELD_ID" ]; then
      DESIRED_OPTION_ID=$(echo "$STATUS_OPTIONS" | python3 -c "
import json,sys
opts = json.load(sys.stdin)
print(opts.get('${PIPELINE_STAGE}', ''))
" 2>/dev/null)

      if [ -n "$DESIRED_OPTION_ID" ]; then
        # Map current board status name back to stage for comparison
        CURRENT_STAGE=$(echo "$CURRENT_STATUS" | python3 -c "
import sys
stage_map = {
    'New': 'new', 'Triaged': 'triaged', 'Needs Info': 'needs-info',
    'Needs Security Review': 'needs-security-review', 'Discussing': 'discussing',
    'Approved': 'approved', 'Planning': 'planning', 'Executing': 'executing',
    'Verifying': 'verifying', 'PR Created': 'pr-created', 'Done': 'done',
    'Failed': 'failed', 'Blocked': 'blocked'
}
label = sys.stdin.read().strip()
print(stage_map.get(label, ''))
" 2>/dev/null)

        if [ "$CURRENT_STAGE" != "$PIPELINE_STAGE" ]; then
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
            -f itemId="$BOARD_ITEM_ID" \
            -f fieldId="$STATUS_FIELD_ID" \
            -f optionId="$DESIRED_OPTION_ID" 2>/dev/null || true

          if [ -n "$CHANGED_FIELDS" ]; then
            CHANGED_FIELDS="${CHANGED_FIELDS}, Status (${CURRENT_STATUS:-none}→${PIPELINE_STAGE})"
          else
            CHANGED_FIELDS="Status (${CURRENT_STATUS:-none}→${PIPELINE_STAGE})"
          fi
          UPDATED_COUNT=$((UPDATED_COUNT + 1))
        fi
      fi
    fi

    # Update AI Agent State field — sync always clears it (ephemeral during execution)
    if [ -n "$AI_STATE_FIELD_ID" ] && [ -n "$CURRENT_AI_STATE" ] && [ "$CURRENT_AI_STATE" != "" ]; then
      CURRENT_AI_STATE=$(echo "$ITEM_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ai_agent_state',''))" 2>/dev/null)
      if [ -n "$CURRENT_AI_STATE" ]; then
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
          -f itemId="$BOARD_ITEM_ID" \
          -f fieldId="$AI_STATE_FIELD_ID" \
          -f text="" 2>/dev/null || true

        if [ -n "$CHANGED_FIELDS" ]; then
          CHANGED_FIELDS="${CHANGED_FIELDS}, AI Agent State (cleared)"
        else
          CHANGED_FIELDS="AI Agent State (cleared)"
        fi
      fi
    fi

    # Update Phase field if it differs
    if [ -n "$PHASE_FIELD_ID" ] && [ -n "$PHASE_VALUE" ] && [ "$PHASE_VALUE" != "$CURRENT_PHASE" ]; then
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
        -f itemId="$BOARD_ITEM_ID" \
        -f fieldId="$PHASE_FIELD_ID" \
        -f text="$PHASE_VALUE" 2>/dev/null || true

      if [ -n "$CHANGED_FIELDS" ]; then
        CHANGED_FIELDS="${CHANGED_FIELDS}, Phase (${CURRENT_PHASE:-none}→${PHASE_VALUE})"
      else
        CHANGED_FIELDS="Phase (${CURRENT_PHASE:-none}→${PHASE_VALUE})"
      fi
    fi

    # Update Milestone field if it differs
    if [ -n "$MILESTONE_FIELD_ID" ] && [ -n "$MILESTONE_VALUE" ] && [ "$MILESTONE_VALUE" != "$CURRENT_MILESTONE" ]; then
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
        -f itemId="$BOARD_ITEM_ID" \
        -f fieldId="$MILESTONE_FIELD_ID" \
        -f text="$MILESTONE_VALUE" 2>/dev/null || true

      if [ -n "$CHANGED_FIELDS" ]; then
        CHANGED_FIELDS="${CHANGED_FIELDS}, Milestone (${CURRENT_MILESTONE:-none}→${MILESTONE_VALUE})"
      else
        CHANGED_FIELDS="Milestone (${CURRENT_MILESTONE:-none}→${MILESTONE_VALUE})"
      fi
    fi

    if [ -z "$CHANGED_FIELDS" ]; then
      CHANGED_FIELDS="no changes"
    fi

    SYNC_RESULTS+=("| #${ISSUE_NUMBER} | ${ISSUE_TITLE} | ${PIPELINE_STAGE} | ${CHANGED_FIELDS} |")
  done
```

**Print reconciliation diff table:**

```bash
  echo "| Issue | Title | Stage | Changes |"
  echo "|-------|-------|-------|---------|"
  for ROW in "${SYNC_RESULTS[@]}"; do
    echo "$ROW"
  done

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Sync complete: ${ACTIVE_COUNT} checked, ${UPDATED_COUNT} updated, ${ADDED_COUNT} added, ${ERROR_COUNT} errors"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [ "$ERROR_COUNT" -gt 0 ]; then
    echo ""
    echo "WARNING: ${ERROR_COUNT} issue(s) had errors. Check board manually: ${BOARD_URL}"
  fi

fi  # end sync subcommand
```
</step>
