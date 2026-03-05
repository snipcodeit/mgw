---
name: board:show
description: Display board state, field IDs, item counts grouped by pipeline stage, and configured views
---

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
