---
name: board:views
description: Create GitHub Projects v2 layout views (kanban, table, roadmap)
---

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
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " VIEW SETUP GUIDE"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Open your project board and create these views:"
    echo ""
    echo "1. Pipeline (Board)"
    echo "   - Layout: Board | Column field: Status"
    echo "   - Visible fields: Phase, GSD Route, Milestone, Priority"
    echo ""
    echo "2. Sprint Table (Table)"
    echo "   - Layout: Table | Group by: Milestone"
    echo "   - Columns: Status, Phase, Priority, Plan Summary, Assignees"
    echo "   - Sort by: Priority (ascending)"
    echo ""
    echo "3. Roadmap (Roadmap)"
    echo "   - Layout: Roadmap | Date field: Start Date -> Target Date"
    echo "   - Group by: Milestone"
    echo ""
    echo "4. My Work (Table)"
    echo "   - Layout: Table | Filter: assignee:@me"
    echo "   - Columns: Status, Phase, Plan Summary, Priority"
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
