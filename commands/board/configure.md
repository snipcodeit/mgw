---
name: board:configure
description: Update board field options by comparing current state against canonical schema
---

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
