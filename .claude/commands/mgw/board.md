---
name: mgw:board
description: Create, show, and configure the GitHub Projects v2 board for this repo
argument-hint: "<create|show|configure>"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

<objective>
Manage the GitHub Projects v2 board for the current MGW project. Three subcommands:

- `create` — Idempotent: creates the board and custom fields if not yet in project.json.
  If board already exists in project.json, exits cleanly with the board URL.
- `show` — Displays current board state: board URL, field IDs, and a summary of items
  grouped by pipeline_stage.
- `configure` — Updates board field options (add new pipeline stages, GSD routes, etc.)
  based on the current board-schema definitions.

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
  echo "Usage: /mgw:board <create|show|configure>"
  echo ""
  echo "  create     Create board and custom fields (idempotent)"
  echo "  show       Display board state and item counts"
  echo "  configure  Update board field options"
  exit 1
fi

case "$SUBCOMMAND" in
  create|show|configure) ;;
  *)
    echo "Unknown subcommand: ${SUBCOMMAND}"
    echo "Valid: create, show, configure"
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
</success_criteria>
