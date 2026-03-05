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

<step name="route_subcommand">
**Route to subcommand implementation:**

Based on the parsed `$SUBCOMMAND`, execute the corresponding subcommand file.
Each subcommand file expects these variables from load_project:
`OWNER`, `REPO_NAME`, `MGW_DIR`, `PROJECT_JSON`, `PROJECT_NAME`,
`BOARD_NUMBER`, `BOARD_URL`, `BOARD_NODE_ID`, `FIELDS_JSON`, `BOARD_CONFIGURED`.

```bash
case "$SUBCOMMAND" in
  create)
    # @~/.claude/commands/mgw/board/create.md
    ;;
  show)
    # @~/.claude/commands/mgw/board/show.md
    ;;
  configure)
    # @~/.claude/commands/mgw/board/configure.md
    ;;
  views)
    # @~/.claude/commands/mgw/board/views.md
    ;;
  sync)
    # @~/.claude/commands/mgw/board/sync.md
    ;;
esac
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
