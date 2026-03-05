---
name: board:create
description: Create the GitHub Projects v2 board and custom fields (idempotent)
---

<step name="subcommand_create">
**Execute 'create' subcommand:**

Only run if `$SUBCOMMAND = "create"`.

**Idempotency check:**

```bash
if [ "$SUBCOMMAND" = "create" ]; then
  if [ "$BOARD_CONFIGURED" = "true" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " MGW ► BOARD ALREADY CONFIGURED"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Board: #${BOARD_NUMBER} — ${BOARD_URL}"
    echo "Node ID: ${BOARD_NODE_ID}"
    echo ""
    echo "Custom fields:"
    echo "$FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
for name, data in fields.items():
    print(f\"  {name}: {data.get('field_id', 'unknown')} ({data.get('type','?')})\")
" 2>/dev/null
    echo ""
    echo "To update field options: /mgw:board configure"
    echo "To see board items: /mgw:board show"
    exit 0
  fi
```

**Board discovery: check GitHub for an existing board before creating a new one:**

One lightweight GraphQL list call. Searches the first 20 user/org projects for a title
containing the project name. If found, registers it in project.json and exits — no fields
created, no board duplicated. Only runs when `BOARD_CONFIGURED = false`.

```bash
  echo "Checking GitHub for existing boards..."
  DISCOVERED=$(node -e "
const { findExistingBoard, getProjectFields } = require('./lib/github.cjs');
const board = findExistingBoard('${OWNER}', '${PROJECT_NAME}');
if (!board) { process.stdout.write(''); process.exit(0); }
const fields = getProjectFields('${OWNER}', board.number) || {};
console.log(JSON.stringify({ ...board, fields }));
" 2>/dev/null || echo "")

  if [ -n "$DISCOVERED" ]; then
    DISC_NUMBER=$(echo "$DISCOVERED" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])")
    DISC_URL=$(echo "$DISCOVERED" | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
    DISC_NODE_ID=$(echo "$DISCOVERED" | python3 -c "import json,sys; print(json.load(sys.stdin)['nodeId'])")
    DISC_TITLE=$(echo "$DISCOVERED" | python3 -c "import json,sys; print(json.load(sys.stdin)['title'])")
    DISC_FIELDS=$(echo "$DISCOVERED" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('fields', {})))")

    echo "  Found existing board: #${DISC_NUMBER} \"${DISC_TITLE}\" — ${DISC_URL}"

    python3 << PYEOF
import json

with open('${MGW_DIR}/project.json') as f:
    project = json.load(f)

fields = json.loads('''${DISC_FIELDS}''') if '${DISC_FIELDS}' not in ('', '{}') else {}

project['project']['project_board'] = {
    'number': int('${DISC_NUMBER}'),
    'url': '${DISC_URL}',
    'node_id': '${DISC_NODE_ID}',
    'fields': fields
}

with open('${MGW_DIR}/project.json', 'w') as f:
    json.dump(project, f, indent=2)

print('project.json updated')
PYEOF

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " MGW ► EXISTING BOARD REGISTERED"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Board:    #${DISC_NUMBER} — ${DISC_URL}"
    echo "Node ID:  ${DISC_NODE_ID}"
    echo ""
    if [ "$DISC_FIELDS" != "{}" ] && [ -n "$DISC_FIELDS" ]; then
      echo "Fields registered:"
      echo "$DISC_FIELDS" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
for name, data in fields.items():
    ftype = data.get('type', '?')
    print(f'  {name}: {data.get(\"field_id\",\"?\")} ({ftype})')
" 2>/dev/null
    else
      echo "  (no custom fields found — run /mgw:board configure to add them)"
    fi
    echo ""
    echo "To see board items: /mgw:board show"
    exit 0
  fi

  echo "  No existing board found — creating new board..."
  echo ""
```

**Get owner and repo node IDs (required for GraphQL mutations):**

```bash
  OWNER_ID=$(gh api graphql -f query='
    query($login: String!) {
      user(login: $login) { id }
    }
  ' -f login="$OWNER" --jq '.data.user.id' 2>/dev/null)

  # Fall back to org if user lookup fails
  if [ -z "$OWNER_ID" ]; then
    OWNER_ID=$(gh api graphql -f query='
      query($login: String!) {
        organization(login: $login) { id }
      }
    ' -f login="$OWNER" --jq '.data.organization.id' 2>/dev/null)
  fi

  if [ -z "$OWNER_ID" ]; then
    echo "ERROR: Cannot resolve owner ID for '${OWNER}'. Check your GitHub token permissions."
    exit 1
  fi

  REPO_NODE_ID=$(gh api graphql -f query='
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id }
    }
  ' -f owner="$OWNER" -f name="$REPO_NAME" --jq '.data.repository.id' 2>/dev/null)
```

**Create the project board:**

```bash
  BOARD_TITLE="${PROJECT_NAME} — MGW Pipeline Board"
  echo "Creating GitHub Projects v2 board: '${BOARD_TITLE}'..."

  CREATE_RESULT=$(gh api graphql -f query='
    mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: {
        ownerId: $ownerId
        title: $title
      }) {
        projectV2 {
          id
          number
          url
        }
      }
    }
  ' -f ownerId="$OWNER_ID" -f title="$BOARD_TITLE" 2>&1)

  NEW_PROJECT_ID=$(echo "$CREATE_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2']['projectV2']['id'])
" 2>/dev/null)

  NEW_PROJECT_NUMBER=$(echo "$CREATE_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2']['projectV2']['number'])
" 2>/dev/null)

  NEW_PROJECT_URL=$(echo "$CREATE_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2']['projectV2']['url'])
" 2>/dev/null)

  if [ -z "$NEW_PROJECT_ID" ]; then
    echo "ERROR: Failed to create project board."
    echo "GraphQL response: ${CREATE_RESULT}"
    exit 1
  fi

  echo "  Created board: #${NEW_PROJECT_NUMBER} — ${NEW_PROJECT_URL}"
  echo "  Board node ID: ${NEW_PROJECT_ID}"
```

**Create custom fields (Status, AI Agent State, Milestone, Phase, GSD Route):**

Field definitions follow docs/BOARD-SCHEMA.md from issue #71.

```bash
  echo ""
  echo "Creating custom fields..."

  # Field 1: Status (SINGLE_SELECT — maps to pipeline_stage)
  STATUS_RESULT=$(gh api graphql -f query='
    mutation($projectId: ID!) {
      createProjectV2Field(input: {
        projectId: $projectId
        dataType: SINGLE_SELECT
        name: "Status"
        singleSelectOptions: [
          { name: "New", color: GRAY, description: "Issue created, not yet triaged" }
          { name: "Triaged", color: BLUE, description: "Triage complete, ready for execution" }
          { name: "Needs Info", color: YELLOW, description: "Blocked at triage gate" }
          { name: "Needs Security Review", color: RED, description: "High security risk flagged" }
          { name: "Discussing", color: PURPLE, description: "Awaiting stakeholder scope approval" }
          { name: "Approved", color: GREEN, description: "Cleared for execution" }
          { name: "Planning", color: BLUE, description: "GSD planner agent active" }
          { name: "Executing", color: ORANGE, description: "GSD executor agent active" }
          { name: "Verifying", color: BLUE, description: "GSD verifier agent active" }
          { name: "PR Created", color: GREEN, description: "PR open, awaiting review" }
          { name: "Done", color: GREEN, description: "PR merged, issue closed" }
          { name: "Failed", color: RED, description: "Unrecoverable pipeline error" }
          { name: "Blocked", color: RED, description: "Blocking comment detected" }
        ]
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  ' -f projectId="$NEW_PROJECT_ID" 2>&1)

  STATUS_FIELD_ID=$(echo "$STATUS_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2Field']['projectV2Field']['id'])
" 2>/dev/null)

  # Build option ID map from result
  STATUS_OPTIONS=$(echo "$STATUS_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
options = d['data']['createProjectV2Field']['projectV2Field']['options']
# Map lowercase pipeline_stage keys to option IDs
stage_map = {
  'new': 'New', 'triaged': 'Triaged', 'needs-info': 'Needs Info',
  'needs-security-review': 'Needs Security Review', 'discussing': 'Discussing',
  'approved': 'Approved', 'planning': 'Planning', 'executing': 'Executing',
  'verifying': 'Verifying', 'pr-created': 'PR Created', 'done': 'Done',
  'failed': 'Failed', 'blocked': 'Blocked'
}
name_to_id = {o['name']: o['id'] for o in options}
result = {stage: name_to_id.get(display, '') for stage, display in stage_map.items()}
print(json.dumps(result))
" 2>/dev/null || echo "{}")

  if [ -n "$STATUS_FIELD_ID" ]; then
    echo "  Status field created: ${STATUS_FIELD_ID}"
  else
    echo "  WARNING: Status field creation failed: ${STATUS_RESULT}"
  fi

  # Field 2: AI Agent State (TEXT)
  AI_STATE_RESULT=$(gh api graphql -f query='
    mutation($projectId: ID!) {
      createProjectV2Field(input: {
        projectId: $projectId
        dataType: TEXT
        name: "AI Agent State"
      }) {
        projectV2Field {
          ... on ProjectV2Field {
            id
            name
          }
        }
      }
    }
  ' -f projectId="$NEW_PROJECT_ID" 2>&1)

  AI_STATE_FIELD_ID=$(echo "$AI_STATE_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2Field']['projectV2Field']['id'])
" 2>/dev/null)

  if [ -n "$AI_STATE_FIELD_ID" ]; then
    echo "  AI Agent State field created: ${AI_STATE_FIELD_ID}"
  else
    echo "  WARNING: AI Agent State field creation failed"
  fi

  # Field 3: Milestone (TEXT)
  MILESTONE_FIELD_RESULT=$(gh api graphql -f query='
    mutation($projectId: ID!) {
      createProjectV2Field(input: {
        projectId: $projectId
        dataType: TEXT
        name: "Milestone"
      }) {
        projectV2Field {
          ... on ProjectV2Field {
            id
            name
          }
        }
      }
    }
  ' -f projectId="$NEW_PROJECT_ID" 2>&1)

  MILESTONE_FIELD_ID=$(echo "$MILESTONE_FIELD_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2Field']['projectV2Field']['id'])
" 2>/dev/null)

  if [ -n "$MILESTONE_FIELD_ID" ]; then
    echo "  Milestone field created: ${MILESTONE_FIELD_ID}"
  else
    echo "  WARNING: Milestone field creation failed"
  fi

  # Field 4: Phase (TEXT)
  PHASE_FIELD_RESULT=$(gh api graphql -f query='
    mutation($projectId: ID!) {
      createProjectV2Field(input: {
        projectId: $projectId
        dataType: TEXT
        name: "Phase"
      }) {
        projectV2Field {
          ... on ProjectV2Field {
            id
            name
          }
        }
      }
    }
  ' -f projectId="$NEW_PROJECT_ID" 2>&1)

  PHASE_FIELD_ID=$(echo "$PHASE_FIELD_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2Field']['projectV2Field']['id'])
" 2>/dev/null)

  if [ -n "$PHASE_FIELD_ID" ]; then
    echo "  Phase field created: ${PHASE_FIELD_ID}"
  else
    echo "  WARNING: Phase field creation failed"
  fi

  # Field 5: GSD Route (SINGLE_SELECT)
  GSD_ROUTE_RESULT=$(gh api graphql -f query='
    mutation($projectId: ID!) {
      createProjectV2Field(input: {
        projectId: $projectId
        dataType: SINGLE_SELECT
        name: "GSD Route"
        singleSelectOptions: [
          { name: "quick", color: BLUE, description: "Small/atomic task, direct execution" }
          { name: "quick --full", color: BLUE, description: "Small task with plan-checker and verifier" }
          { name: "plan-phase", color: PURPLE, description: "Medium task with phase planning" }
          { name: "new-milestone", color: ORANGE, description: "Large task with full milestone lifecycle" }
        ]
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  ' -f projectId="$NEW_PROJECT_ID" 2>&1)

  GSD_ROUTE_FIELD_ID=$(echo "$GSD_ROUTE_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2Field']['projectV2Field']['id'])
" 2>/dev/null)

  GSD_ROUTE_OPTIONS=$(echo "$GSD_ROUTE_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
options = d['data']['createProjectV2Field']['projectV2Field']['options']
route_map = {
  'gsd:quick': 'quick', 'gsd:quick --full': 'quick --full',
  'gsd:plan-phase': 'plan-phase', 'gsd:new-milestone': 'new-milestone'
}
name_to_id = {o['name']: o['id'] for o in options}
result = {route: name_to_id.get(display, '') for route, display in route_map.items()}
print(json.dumps(result))
" 2>/dev/null || echo "{}")

  if [ -n "$GSD_ROUTE_FIELD_ID" ]; then
    echo "  GSD Route field created: ${GSD_ROUTE_FIELD_ID}"
  else
    echo "  WARNING: GSD Route field creation failed"
  fi
```

**Update project.json with board metadata:**

```bash
  echo ""
  echo "Updating project.json with board metadata..."

  python3 << PYEOF
import json

with open('${MGW_DIR}/project.json') as f:
    project = json.load(f)

# Build field schema
status_options = json.loads('''${STATUS_OPTIONS}''') if '${STATUS_OPTIONS}' != '{}' else {}
gsd_route_options = json.loads('''${GSD_ROUTE_OPTIONS}''') if '${GSD_ROUTE_OPTIONS}' != '{}' else {}

fields = {}

if '${STATUS_FIELD_ID}':
    fields['status'] = {
        'field_id': '${STATUS_FIELD_ID}',
        'field_name': 'Status',
        'type': 'SINGLE_SELECT',
        'options': status_options
    }

if '${AI_STATE_FIELD_ID}':
    fields['ai_agent_state'] = {
        'field_id': '${AI_STATE_FIELD_ID}',
        'field_name': 'AI Agent State',
        'type': 'TEXT'
    }

if '${MILESTONE_FIELD_ID}':
    fields['milestone'] = {
        'field_id': '${MILESTONE_FIELD_ID}',
        'field_name': 'Milestone',
        'type': 'TEXT'
    }

if '${PHASE_FIELD_ID}':
    fields['phase'] = {
        'field_id': '${PHASE_FIELD_ID}',
        'field_name': 'Phase',
        'type': 'TEXT'
    }

if '${GSD_ROUTE_FIELD_ID}':
    fields['gsd_route'] = {
        'field_id': '${GSD_ROUTE_FIELD_ID}',
        'field_name': 'GSD Route',
        'type': 'SINGLE_SELECT',
        'options': gsd_route_options
    }

# Update project_board section
project['project']['project_board'] = {
    'number': int('${NEW_PROJECT_NUMBER}') if '${NEW_PROJECT_NUMBER}'.isdigit() else None,
    'url': '${NEW_PROJECT_URL}',
    'node_id': '${NEW_PROJECT_ID}',
    'fields': fields
}

with open('${MGW_DIR}/project.json', 'w') as f:
    json.dump(project, f, indent=2)

print('project.json updated')
PYEOF

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " MGW ► BOARD CREATED"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Board:    #${NEW_PROJECT_NUMBER} — ${NEW_PROJECT_URL}"
  echo "Node ID:  ${NEW_PROJECT_ID}"
  echo ""
  echo "Custom fields created:"
  echo "  status            ${STATUS_FIELD_ID:-FAILED} (SINGLE_SELECT, 13 options)"
  echo "  ai_agent_state    ${AI_STATE_FIELD_ID:-FAILED} (TEXT)"
  echo "  milestone         ${MILESTONE_FIELD_ID:-FAILED} (TEXT)"
  echo "  phase             ${PHASE_FIELD_ID:-FAILED} (TEXT)"
  echo "  gsd_route         ${GSD_ROUTE_FIELD_ID:-FAILED} (SINGLE_SELECT, 4 options)"
  echo ""
  echo "Field IDs stored in .mgw/project.json"
  echo ""
  echo "Next:"
  echo "  /mgw:board show      Display board state"
  echo "  /mgw:run 73          Sync issues onto board items (#73)"

fi  # end create subcommand
```
</step>
