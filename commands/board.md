---
name: mgw:board
description: Create, show, configure, and sync the GitHub Projects v2 board for this repo
argument-hint: "<create|show|configure|views|sync>"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

<objective>
Manage the GitHub Projects v2 board for the current MGW project. Five subcommands:

- `create` — Idempotent: creates the board and custom fields if not yet in project.json.
  If board already exists in project.json, exits cleanly with the board URL.
- `show` — Displays current board state: board URL, field IDs, and a summary of items
  grouped by pipeline_stage. Also shows configured views.
- `configure` — Updates board field options (add new pipeline stages, GSD routes, etc.)
  based on the current board-schema definitions.
- `views` — Creates GitHub Projects v2 layout views (Board/Kanban, Table, Roadmap).
  Subcommands: `views kanban`, `views table`, `views roadmap`. Creates the view and
  outputs instructions for manual group-by configuration in the GitHub UI.
- `sync` — Reconciles all board items with current `.mgw/active/` state. Iterates every
  active state file, looks up the corresponding board item by issue number, adds missing
  items, and updates Status, AI Agent State, Phase, and Milestone fields to match local
  state. Designed for use after context resets or board drift. Prints a reconciliation
  diff table.

All board API calls use GitHub GraphQL v4. Board metadata is stored in project.json
under `project.project_board.fields`. Board item sync (adding issues as board items)
is handled by issue #73 — this command only creates the board structure.

Command reads `.mgw/project.json` for context. Never hardcodes IDs. Follows delegation
boundary: board API calls in MGW, never application code reads.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
</execution_context>

<context>
Subcommand: $ARGUMENTS

Repo detected via: gh repo view --json nameWithOwner -q .nameWithOwner
State: .mgw/project.json
Board schema: .mgw/board-schema.json (if exists) or embedded defaults from docs/BOARD-SCHEMA.md
</context>

<process>

<step name="parse_and_validate">
**Parse $ARGUMENTS and validate environment:**

```bash
SUBCOMMAND=$(echo "$ARGUMENTS" | awk '{print $1}')

if [ -z "$SUBCOMMAND" ]; then
  echo "Usage: /mgw:board <create|show|configure|views|sync>"
  echo ""
  echo "  create          Create board and custom fields (idempotent)"
  echo "  show            Display board state and item counts"
  echo "  configure       Update board field options"
  echo "  views <layout>  Create layout views (kanban, table, roadmap)"
  echo "  sync            Reconcile all board items with current .mgw/ state"
  exit 1
fi

case "$SUBCOMMAND" in
  create|show|configure|views|sync) ;;
  *)
    echo "Unknown subcommand: ${SUBCOMMAND}"
    echo "Valid: create, show, configure, views, sync"
    exit 1
    ;;
esac
```

**Validate environment:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "Not a git repository. Run from a repo root."
  exit 1
fi

MGW_DIR="${REPO_ROOT}/.mgw"
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
if [ -z "$REPO" ]; then
  echo "No GitHub remote found. MGW requires a GitHub repo."
  exit 1
fi

if [ ! -f "${MGW_DIR}/project.json" ]; then
  echo "No project initialized. Run /mgw:project first."
  exit 1
fi

OWNER=$(echo "$REPO" | cut -d'/' -f1)
REPO_NAME=$(echo "$REPO" | cut -d'/' -f2)
```
</step>

<step name="load_project">
**Load project.json and extract board state:**

```bash
PROJECT_JSON=$(cat "${MGW_DIR}/project.json")

PROJECT_NAME=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['project']['name'])")

# Check for existing board in project.json
BOARD_NUMBER=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
board = p.get('project', {}).get('project_board', {})
print(board.get('number', ''))
" 2>/dev/null)

BOARD_URL=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
board = p.get('project', {}).get('project_board', {})
print(board.get('url', ''))
" 2>/dev/null)

BOARD_NODE_ID=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
board = p.get('project', {}).get('project_board', {})
print(board.get('node_id', ''))
" 2>/dev/null)

FIELDS_JSON=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
board = p.get('project', {}).get('project_board', {})
print(json.dumps(board.get('fields', {})))
" 2>/dev/null || echo "{}")

# Board exists if it has a node_id stored
BOARD_CONFIGURED=$([ -n "$BOARD_NODE_ID" ] && echo "true" || echo "false")
```
</step>

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

<step name="subcommand_show">
**Execute 'show' subcommand:**

Only run if `$SUBCOMMAND = "show"`.

```bash
if [ "$SUBCOMMAND" = "show" ]; then
  if [ "$BOARD_CONFIGURED" = "false" ]; then
    echo "No board configured. Run /mgw:board create first."
    exit 1
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " MGW ► BOARD STATE: ${PROJECT_NAME}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Board:   #${BOARD_NUMBER} — ${BOARD_URL}"
  echo "Node ID: ${BOARD_NODE_ID}"
  echo ""
  echo "Custom Fields:"
  echo "$FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
for name, data in fields.items():
    fid = data.get('field_id', 'unknown')
    ftype = data.get('type', 'unknown')
    fname = data.get('field_name', name)
    if ftype == 'SINGLE_SELECT':
        opts = len(data.get('options', {}))
        print(f'  {fname:<20} {fid}  ({ftype}, {opts} options)')
    else:
        print(f'  {fname:<20} {fid}  ({ftype})')
" 2>/dev/null
  echo ""
```

**Fetch board items from GitHub to show current state:**

```bash
  echo "Fetching board items from GitHub..."

  ITEMS_RESULT=$(gh api graphql -f query='
    query($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) {
          title
          items(first: 50) {
            totalCount
            nodes {
              id
              content {
                ... on Issue {
                  number
                  title
                  state
                }
                ... on PullRequest {
                  number
                  title
                  state
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
  ' -f owner="$OWNER" -F number="$BOARD_NUMBER" 2>/dev/null)

  # Fall back to org query if user query fails
  if echo "$ITEMS_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); _ = d['data']['user']['projectV2']" 2>/dev/null; then
    ITEM_NODES=$(echo "$ITEMS_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(json.dumps(d['data']['user']['projectV2']['items']['nodes']))
" 2>/dev/null || echo "[]")
    TOTAL_ITEMS=$(echo "$ITEMS_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['user']['projectV2']['items']['totalCount'])
" 2>/dev/null || echo "0")
  else
    # Try organization lookup
    ITEMS_RESULT=$(gh api graphql -f query='
      query($owner: String!, $number: Int!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            title
            items(first: 50) {
              totalCount
              nodes {
                id
                content {
                  ... on Issue { number title state }
                  ... on PullRequest { number title state }
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
    ' -f owner="$OWNER" -F number="$BOARD_NUMBER" 2>/dev/null)

    ITEM_NODES=$(echo "$ITEMS_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
org_data = d.get('data', {}).get('organization') or d.get('data', {}).get('user', {})
proj = org_data.get('projectV2', {})
print(json.dumps(proj.get('items', {}).get('nodes', [])))
" 2>/dev/null || echo "[]")
    TOTAL_ITEMS=$(echo "$ITEMS_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
org_data = d.get('data', {}).get('organization') or d.get('data', {}).get('user', {})
proj = org_data.get('projectV2', {})
print(proj.get('items', {}).get('totalCount', 0))
" 2>/dev/null || echo "0")
  fi

  echo "Board Items (${TOTAL_ITEMS} total):"
  echo ""

  echo "$ITEM_NODES" | python3 -c "
import json,sys
nodes = json.load(sys.stdin)

if not nodes:
    print('  No items on board yet.')
    print('  Run /mgw:run 73 to sync issues as board items (#73).')
    sys.exit(0)

# Group by Status field
by_status = {}
for node in nodes:
    content = node.get('content', {})
    num = content.get('number', '?')
    title = content.get('title', 'Unknown')[:45]
    status = 'No Status'
    for fv in node.get('fieldValues', {}).get('nodes', []):
        field = fv.get('field', {})
        if field.get('name') == 'Status':
            status = fv.get('name', 'No Status')
            break
    by_status.setdefault(status, []).append((num, title))

order = ['Executing', 'Planning', 'Verifying', 'PR Created', 'Triaged', 'Approved',
         'Discussing', 'New', 'Needs Info', 'Needs Security Review', 'Blocked', 'Failed', 'Done', 'No Status']

for status in order:
    items = by_status.pop(status, [])
    if items:
        print(f'  {status} ({len(items)}):')
        for num, title in items:
            print(f'    #{num}  {title}')

for status, items in by_status.items():
    print(f'  {status} ({len(items)}):')
    for num, title in items:
        print(f'    #{num}  {title}')
" 2>/dev/null

  echo ""

  # Show configured views if any
  VIEWS_JSON=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
board = p.get('project', {}).get('project_board', {})
views = board.get('views', {})
print(json.dumps(views))
" 2>/dev/null || echo "{}")

  if [ "$VIEWS_JSON" != "{}" ] && [ -n "$VIEWS_JSON" ]; then
    echo "Configured Views:"
    echo "$VIEWS_JSON" | python3 -c "
import json,sys
views = json.load(sys.stdin)
for key, v in views.items():
    print(f'  {v[\"name\"]:<40} {v[\"layout\"]:<16} (ID: {v[\"view_id\"]})')
" 2>/dev/null
    echo ""
  else
    echo "Views: none configured"
    echo "  Run /mgw:board views kanban to create the kanban view"
    echo ""
  fi

  echo "Open board: ${BOARD_URL}"

fi  # end show subcommand
```
</step>

<step name="subcommand_configure">
**Execute 'configure' subcommand:**

Only run if `$SUBCOMMAND = "configure"`.

Reads current field options from GitHub and compares to the canonical schema in
docs/BOARD-SCHEMA.md / .mgw/board-schema.json. Adds any missing options.

```bash
if [ "$SUBCOMMAND" = "configure" ]; then
  if [ "$BOARD_CONFIGURED" = "false" ]; then
    echo "No board configured. Run /mgw:board create first."
    exit 1
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " MGW ► BOARD CONFIGURE: ${PROJECT_NAME}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Board: #${BOARD_NUMBER} — ${BOARD_URL}"
  echo ""
```

**Fetch current field state from GitHub:**

```bash
  FIELDS_STATE=$(gh api graphql -f query='
    query($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name color description }
              }
              ... on ProjectV2Field {
                id
                name
                dataType
              }
            }
          }
        }
      }
    }
  ' -f owner="$OWNER" -F number="$BOARD_NUMBER" 2>/dev/null)

  # Try org if user fails
  if ! echo "$FIELDS_STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); _ = d['data']['user']['projectV2']" 2>/dev/null; then
    FIELDS_STATE=$(gh api graphql -f query='
      query($owner: String!, $number: Int!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            fields(first: 20) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name color description }
                }
                ... on ProjectV2Field {
                  id
                  name
                  dataType
                }
              }
            }
          }
        }
      }
    ' -f owner="$OWNER" -F number="$BOARD_NUMBER" 2>/dev/null)
  fi

  echo "Current fields on board:"
  echo "$FIELDS_STATE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
data = d.get('data', {})
proj = (data.get('user') or data.get('organization', {})).get('projectV2', {})
nodes = proj.get('fields', {}).get('nodes', [])
for node in nodes:
    name = node.get('name', 'unknown')
    nid = node.get('id', 'unknown')
    opts = node.get('options')
    if opts is not None:
        print(f'  {name} (SINGLE_SELECT, {len(opts)} options): {nid}')
        for opt in opts:
            print(f'    - {opt[\"name\"]} ({opt[\"color\"]}) [{opt[\"id\"]}]')
    else:
        dtype = node.get('dataType', 'TEXT')
        print(f'  {name} ({dtype}): {nid}')
" 2>/dev/null || echo "  (could not fetch field details)"

  echo ""
```

**Compare with canonical schema and identify missing options:**

```bash
  # Canonical Status options from BOARD-SCHEMA.md
  CANONICAL_STATUS_OPTIONS='["New","Triaged","Needs Info","Needs Security Review","Discussing","Approved","Planning","Executing","Verifying","PR Created","Done","Failed","Blocked"]'

  # Get current Status option names
  CURRENT_STATUS_OPTIONS=$(echo "$FIELDS_STATE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
data = d.get('data', {})
proj = (data.get('user') or data.get('organization', {})).get('projectV2', {})
nodes = proj.get('fields', {}).get('nodes', [])
for node in nodes:
    if node.get('name') == 'Status' and 'options' in node:
        print(json.dumps([o['name'] for o in node['options']]))
        sys.exit(0)
print('[]')
" 2>/dev/null || echo "[]")

  MISSING_STATUS=$(python3 -c "
import json
canonical = json.loads('${CANONICAL_STATUS_OPTIONS}')
current = json.loads('''${CURRENT_STATUS_OPTIONS}''')
missing = [o for o in canonical if o not in current]
if missing:
    print('Missing Status options: ' + ', '.join(missing))
else:
    print('Status field: all options present')
" 2>/dev/null)

  echo "Schema comparison:"
  echo "  ${MISSING_STATUS}"

  # Canonical GSD Route options
  CANONICAL_GSD_OPTIONS='["quick","quick --full","plan-phase","new-milestone"]'

  CURRENT_GSD_OPTIONS=$(echo "$FIELDS_STATE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
data = d.get('data', {})
proj = (data.get('user') or data.get('organization', {})).get('projectV2', {})
nodes = proj.get('fields', {}).get('nodes', [])
for node in nodes:
    if node.get('name') == 'GSD Route' and 'options' in node:
        print(json.dumps([o['name'] for o in node['options']]))
        sys.exit(0)
print('[]')
" 2>/dev/null || echo "[]")

  MISSING_GSD=$(python3 -c "
import json
canonical = json.loads('${CANONICAL_GSD_OPTIONS}')
current = json.loads('''${CURRENT_GSD_OPTIONS}''')
missing = [o for o in canonical if o not in current]
if missing:
    print('Missing GSD Route options: ' + ', '.join(missing))
else:
    print('GSD Route field: all options present')
" 2>/dev/null)

  echo "  ${MISSING_GSD}"
  echo ""

  # Check for missing text fields
  CURRENT_FIELD_NAMES=$(echo "$FIELDS_STATE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
data = d.get('data', {})
proj = (data.get('user') or data.get('organization', {})).get('projectV2', {})
nodes = proj.get('fields', {}).get('nodes', [])
print(json.dumps([n.get('name') for n in nodes]))
" 2>/dev/null || echo "[]")

  REQUIRED_TEXT_FIELDS='["AI Agent State","Milestone","Phase"]'
  MISSING_TEXT=$(python3 -c "
import json
required = json.loads('${REQUIRED_TEXT_FIELDS}')
current = json.loads('''${CURRENT_FIELD_NAMES}''')
missing = [f for f in required if f not in current]
if missing:
    print('Missing text fields: ' + ', '.join(missing))
else:
    print('Text fields: all present')
" 2>/dev/null)

  echo "  ${MISSING_TEXT}"
  echo ""

  # Report: no automated field addition (GitHub Projects v2 API does not support
  # updating existing single-select field options — must delete and recreate)
  echo "Note: GitHub Projects v2 GraphQL does not support adding options to an"
  echo "existing single-select field. To add new pipeline stages:"
  echo "  1. Delete the existing Status field on the board UI"
  echo "  2. Run /mgw:board create (idempotency check will be skipped for fields)"
  echo "  Or: manually add options via GitHub Projects UI at ${BOARD_URL}"
  echo ""
  echo "For missing text fields, run /mgw:board create (it will create missing fields)."

fi  # end configure subcommand
```
</step>

<step name="subcommand_views">
**Execute 'views' subcommand:**

Only run if `$SUBCOMMAND = "views"`.

Creates GitHub Projects v2 layout views. Subcommand argument is the view type:
`kanban`, `table`, or `roadmap`. GitHub's API supports creating views but does NOT
support programmatic configuration of board grouping — that must be set in the UI.

```bash
if [ "$SUBCOMMAND" = "views" ]; then
  if [ "$BOARD_CONFIGURED" = "false" ]; then
    echo "No board configured. Run /mgw:board create first."
    exit 1
  fi

  VIEW_TYPE=$(echo "$ARGUMENTS" | awk '{print $2}')

  if [ -z "$VIEW_TYPE" ]; then
    echo "Usage: /mgw:board views <kanban|table|roadmap>"
    echo ""
    echo "  kanban   Create Board layout view (swimlanes by Status)"
    echo "  table    Create Table layout view (flat list with all fields)"
    echo "  roadmap  Create Roadmap layout view (timeline grouped by Milestone)"
    exit 1
  fi

  case "$VIEW_TYPE" in
    kanban|table|roadmap) ;;
    *)
      echo "Unknown view type: ${VIEW_TYPE}"
      echo "Valid: kanban, table, roadmap"
      exit 1
      ;;
  esac
```

**Map view type to layout and name:**

```bash
  case "$VIEW_TYPE" in
    kanban)
      VIEW_NAME="Kanban — Pipeline Stages"
      VIEW_LAYOUT="BOARD_LAYOUT"
      VIEW_KEY="kanban"
      ;;
    table)
      VIEW_NAME="Triage Table — Team Planning"
      VIEW_LAYOUT="TABLE_LAYOUT"
      VIEW_KEY="table"
      ;;
    roadmap)
      VIEW_NAME="Roadmap — Milestone Timeline"
      VIEW_LAYOUT="ROADMAP_LAYOUT"
      VIEW_KEY="roadmap"
      ;;
  esac

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " MGW ► BOARD VIEWS: ${VIEW_NAME}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Board: #${BOARD_NUMBER} — ${BOARD_URL}"
  echo "Creating ${VIEW_LAYOUT} view: '${VIEW_NAME}'..."
  echo ""
```

**Create the view via GraphQL:**

```bash
  CREATE_VIEW_RESULT=$(gh api graphql -f query='
    mutation($projectId: ID!, $name: String!, $layout: ProjectV2ViewLayout!) {
      createProjectV2View(input: {
        projectId: $projectId
        name: $name
        layout: $layout
      }) {
        projectV2View {
          id
          name
          layout
        }
      }
    }
  ' -f projectId="$BOARD_NODE_ID" \
    -f name="$VIEW_NAME" \
    -f layout="$VIEW_LAYOUT" 2>&1)

  VIEW_ID=$(echo "$CREATE_VIEW_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2View']['projectV2View']['id'])
" 2>/dev/null)

  VIEW_LAYOUT_RETURNED=$(echo "$CREATE_VIEW_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d['data']['createProjectV2View']['projectV2View']['layout'])
" 2>/dev/null)

  if [ -z "$VIEW_ID" ]; then
    echo "ERROR: Failed to create view."
    echo "GraphQL response: ${CREATE_VIEW_RESULT}"
    exit 1
  fi

  echo "View created:"
  echo "  Name:   ${VIEW_NAME}"
  echo "  Layout: ${VIEW_LAYOUT_RETURNED}"
  echo "  ID:     ${VIEW_ID}"
  echo ""
```

**Store view ID in project.json:**

```bash
  python3 << PYEOF
import json

with open('${MGW_DIR}/project.json') as f:
    project = json.load(f)

# Ensure views dict exists under project_board
board = project.setdefault('project', {}).setdefault('project_board', {})
views = board.setdefault('views', {})

views['${VIEW_KEY}'] = {
    'view_id': '${VIEW_ID}',
    'name': '${VIEW_NAME}',
    'layout': '${VIEW_LAYOUT}'
}

with open('${MGW_DIR}/project.json', 'w') as f:
    json.dump(project, f, indent=2)

print('project.json updated with view ID')
PYEOF
```

**Output instructions and next steps:**

```bash
  echo "View ID stored in .mgw/project.json under project.project_board.views.${VIEW_KEY}"
  echo ""

  case "$VIEW_TYPE" in
    kanban)
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo " NEXT STEP: Configure Group By in GitHub UI"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo ""
      echo "GitHub's API does not support setting board grouping programmatically."
      echo "To create swimlanes by pipeline stage:"
      echo ""
      echo "  1. Open the board: ${BOARD_URL}"
      echo "  2. Click '${VIEW_NAME}' in the view tabs"
      echo "  3. Click the view settings (down-arrow next to view name)"
      echo "  4. Select 'Group by' -> 'Status'"
      echo ""
      echo "Each pipeline stage will become a swimlane column:"
      echo "  New / Triaged / Planning / Executing / Verifying / PR Created / Done"
      echo "  + Needs Info / Needs Security Review / Discussing / Approved / Failed / Blocked"
      echo ""
      echo "See docs/BOARD-SCHEMA.md for full view configuration reference."
      ;;
    table)
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo " NEXT STEP: Configure Columns in GitHub UI"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo ""
      echo "Triage Table view created for team planning visibility."
      echo "GitHub's API does not support setting table columns or sort order"
      echo "programmatically — configure in the GitHub UI:"
      echo ""
      echo "  1. Open the board: ${BOARD_URL}"
      echo "  2. Click '${VIEW_NAME}' in the view tabs"
      echo "  3. Click the view settings (down-arrow next to view name)"
      echo "  4. Add these columns in order:"
      echo "       Status      (sort ascending — pipeline order)"
      echo "       Milestone"
      echo "       Phase"
      echo "       GSD Route"
      echo "       AI Agent State"
      echo "  5. Set 'Sort by' -> 'Status' ascending"
      echo ""
      echo "This column order surfaces triage planning context:"
      echo "  Status first shows pipeline position at a glance."
      echo "  Milestone + Phase + GSD Route give scope and routing context."
      echo "  AI Agent State shows live execution activity."
      echo ""
      echo "See docs/BOARD-SCHEMA.md for full column and sort configuration reference."
      ;;
    roadmap)
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo " NEXT STEP: Configure Roadmap in GitHub UI"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo ""
      echo "Roadmap view created for milestone-based timeline visualization."
      echo "GitHub's API does not support setting roadmap grouping or date fields"
      echo "programmatically — configure in the GitHub UI:"
      echo ""
      echo "  1. Open the board: ${BOARD_URL}"
      echo "  2. Click '${VIEW_NAME}' in the view tabs"
      echo "  3. Click the view settings (down-arrow next to view name)"
      echo "  4. Set 'Group by' -> 'Milestone'"
      echo "     Items will be grouped by the Milestone field value."
      echo ""
      echo "Timeline date field limitation:"
      echo "  GitHub Roadmap requires date fields (start date + end date) to render"
      echo "  items on the timeline. MGW uses iteration-based tracking without"
      echo "  explicit date fields — items will appear in the roadmap grouped by"
      echo "  Milestone but without timeline bars unless date fields are added."
      echo ""
      echo "  To enable timeline bars, set milestone due dates via:"
      echo "    gh api repos/{owner}/{repo}/milestones/{number} --method PATCH \\"
      echo "      -f due_on='YYYY-MM-DDT00:00:00Z'"
      echo "  GitHub Projects v2 can read milestone due dates as a date source."
      echo ""
      echo "See docs/BOARD-SCHEMA.md for full roadmap configuration reference."
      ;;
  esac

fi  # end views subcommand
```
</step>

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

  # Build: issue_number → {item_id, current_status, current_ai_state, current_phase, current_milestone}
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

</process>

<success_criteria>
- [ ] parse_and_validate: subcommand parsed, git repo and GitHub remote confirmed, project.json exists
- [ ] load_project: project.json loaded, board state extracted (number, url, node_id, fields)
- [ ] create: idempotency check — exits cleanly if board already configured (board_node_id present)
- [ ] create: owner node ID resolved via GraphQL (user or org fallback)
- [ ] create: createProjectV2 mutation succeeds — board number, URL, node_id captured
- [ ] create: all 5 custom fields created (Status, AI Agent State, Milestone, Phase, GSD Route)
- [ ] create: Status field has 13 single-select options matching pipeline_stage values
- [ ] create: GSD Route field has 4 single-select options
- [ ] create: field IDs and option IDs stored in project.json under project.project_board.fields
- [ ] create: success report shows board URL, node ID, and field IDs
- [ ] show: board not configured → clear error message
- [ ] show: board URL and node ID displayed
- [ ] show: custom fields listed with IDs and types
- [ ] show: board items fetched from GitHub and grouped by Status field value
- [ ] show: handles empty board (no items) with helpful next-step message
- [ ] show: user/org GraphQL fallback handles both account types
- [ ] configure: board not configured → clear error message
- [ ] configure: fetches current field state from GitHub
- [ ] configure: compares against canonical schema, reports missing options
- [ ] configure: lists all missing Status options, GSD Route options, and text fields
- [ ] configure: explains GitHub Projects v2 limitation on adding options to existing fields
- [ ] show: displays configured views (name, layout, ID) if any views exist
- [ ] show: prompts to run views kanban if no views are configured
- [ ] views: board not configured → clear error message
- [ ] views: no view type argument → usage message listing kanban, table, roadmap
- [ ] views: unknown view type → clear error message
- [ ] views: createProjectV2View mutation succeeds — view ID captured
- [ ] views: view ID stored in project.json under project.project_board.views
- [ ] views kanban: outputs step-by-step instructions for setting Group by Status in GitHub UI
- [ ] views kanban: lists all 13 pipeline stage columns user will see after configuring
- [ ] views table: view name is "Triage Table — Team Planning"
- [ ] views table: outputs step-by-step instructions for adding triage planning columns in GitHub UI
- [ ] views table: column order is Status, Milestone, Phase, GSD Route, AI Agent State
- [ ] views table: outputs instructions for sorting by Status ascending
- [ ] views roadmap: view name is "Roadmap — Milestone Timeline"
- [ ] views roadmap: outputs step-by-step instructions for setting Group by Milestone in GitHub UI
- [ ] views roadmap: explains date field limitation — MGW uses iteration-based tracking without explicit dates
- [ ] views roadmap: documents milestone due date workaround via gh api PATCH
- [ ] views: references docs/BOARD-SCHEMA.md for full view configuration documentation
- [ ] sync: board not configured → clear error message directing to /mgw:board create
- [ ] sync: no active state files → "Nothing to sync" message, clean exit
- [ ] sync: fetches all board items in a single GraphQL query (node-based, by BOARD_NODE_ID)
- [ ] sync: builds issue_number → {item_id, current field values} map from GraphQL result
- [ ] sync: for each active state file, parses issue.number, pipeline_stage, labels (for Phase)
- [ ] sync: issues not yet on board are added via addProjectV2ItemById mutation
- [ ] sync: Status field updated when pipeline_stage differs from current board Status value
- [ ] sync: AI Agent State field cleared (set to empty) when it has a stale value
- [ ] sync: Phase field updated when phase label value differs from current board Phase value
- [ ] sync: Milestone field updated when project.json milestone title differs from board value
- [ ] sync: only differing fields are updated (no-op for fields already matching)
- [ ] sync: per-item errors are logged in diff table rows as ERROR entries, reconciliation continues
- [ ] sync: prints reconciliation diff table with columns: Issue, Title, Stage, Changes
- [ ] sync: prints summary line: "N checked, M updated, K added, 0 errors"
- [ ] sync: if any errors occurred, prints warning with board URL for manual inspection
</success_criteria>
