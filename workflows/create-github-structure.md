# Create GitHub Structure

## Precondition

`/tmp/mgw-template.json` exists and is valid — produced by `workflows/generate-template.md`.
`MILESTONE_COUNT`, `TOTAL_PHASES`, `GENERATED_TYPE` are set. `EXTEND_MODE`, `EXISTING_PHASE_COUNT`
are set (EXTEND_MODE=false and EXISTING_PHASE_COUNT=0 for fresh projects).

Required variables:
- `REPO` — GitHub owner/repo slug
- `REPO_ROOT` — absolute path to repo root
- `MGW_DIR` — path to `.mgw/` directory
- `EXTEND_MODE` — true if adding to an existing project

## Postcondition

After this workflow completes:
- All milestones created on GitHub (Pass 1a): `MILESTONE_MAP` array populated
- All issues created on GitHub (Pass 1b): `SLUG_TO_NUMBER`, `ISSUE_RECORDS` arrays populated
- Dependency labels applied (Pass 2): `cross-refs.json` updated with blocked-by entries
- GitHub Projects v2 board created or reused: `PROJECT_NUMBER`, `PROJECT_URL` set
- Board items synced with field values: `ITEM_ID_MAP` populated (may be empty if board not configured)
- `.mgw/project.json` written with full project state
- Summary report displayed

---

<step name="create_milestones">
**Pass 1a: Create GitHub milestones**

For each milestone in the generated template (iterate by index):

```bash
# Iterate over milestones in the generated template
MILESTONE_MAP=()  # bash array: index -> "number:id:url"

for MILESTONE_INDEX in $(seq 0 $((MILESTONE_COUNT - 1))); do
  MILESTONE_NAME=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['name'])
")
  MILESTONE_DESC=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}].get('description',''))
")

  MILESTONE_JSON_RESP=$(gh api "repos/${REPO}/milestones" --method POST \
    -f title="$MILESTONE_NAME" \
    -f description="$MILESTONE_DESC" \
    -f state="open" 2>&1)

  if echo "$MILESTONE_JSON_RESP" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    M_NUMBER=$(echo "$MILESTONE_JSON_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])")
    M_ID=$(echo "$MILESTONE_JSON_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    M_URL=$(echo "$MILESTONE_JSON_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['html_url'])")
    MILESTONE_MAP+=("${MILESTONE_INDEX}:${M_NUMBER}:${M_ID}:${M_URL}")
    echo "  Created milestone: #${M_NUMBER} ${MILESTONE_NAME}"
  else
    echo "  WARNING: Failed to create milestone '${MILESTONE_NAME}': ${MILESTONE_JSON_RESP}"
    MILESTONE_MAP+=("${MILESTONE_INDEX}:FAILED:0:")
  fi
done
```
</step>

<step name="create_issues">
**Pass 1b: Create GitHub issues for each phase**

Build a slug-to-issue-number mapping as issues are created for Pass 2 dependency resolution.

```bash
SLUG_TO_NUMBER=()  # bash array: "slug:number"
ISSUE_RECORDS=()   # for project.json
PHASE_MAP_JSON="{}"
TOTAL_ISSUES_CREATED=0
FAILED_SLUGS=()

# Global phase counter across milestones
# In extend mode, continue numbering from last existing phase
if [ "$EXTEND_MODE" = true ]; then
  GLOBAL_PHASE_NUM=$EXISTING_PHASE_COUNT
else
  GLOBAL_PHASE_NUM=0
fi

for MILESTONE_INDEX in $(seq 0 $((MILESTONE_COUNT - 1))); do
  # Get this milestone's GitHub number from MILESTONE_MAP
  M_ENTRY="${MILESTONE_MAP[$MILESTONE_INDEX]}"
  M_NUMBER=$(echo "$M_ENTRY" | cut -d':' -f2)

  if [ "$M_NUMBER" = "FAILED" ]; then
    echo "  Skipping issues for failed milestone at index ${MILESTONE_INDEX}"
    continue
  fi

  PHASE_COUNT=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(len(d['milestones'][${MILESTONE_INDEX}]['phases']))
")

  for PHASE_INDEX in $(seq 0 $((PHASE_COUNT - 1))); do
    GLOBAL_PHASE_NUM=$((GLOBAL_PHASE_NUM + 1))

    PHASE_NAME=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['name'])
")
    PHASE_DESC=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}].get('description',''))
")
    GSD_ROUTE=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}].get('gsd_route','plan-phase'))
")
    MILESTONE_NAME=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['name'])
")

    # Generate phase slug for label
    PHASE_SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${PHASE_NAME}" --raw 2>/dev/null | head -c 40)
    if [ -z "$PHASE_SLUG" ] && [ -n "$PHASE_NAME" ]; then
      PHASE_SLUG=$(echo "$PHASE_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | cut -c1-40)
    fi

    # Create phase label (idempotent)
    gh label create "phase:${GLOBAL_PHASE_NUM}-${PHASE_SLUG}" \
      --description "Phase ${GLOBAL_PHASE_NUM}: ${PHASE_NAME}" \
      --color "0075ca" \
      --force 2>/dev/null

    ISSUE_COUNT=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(len(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues']))
")

    for ISSUE_INDEX in $(seq 0 $((ISSUE_COUNT - 1))); do
      ISSUE_TITLE=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}]['title'])
")
      ISSUE_DESC=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}].get('description',''))
")
      ISSUE_LABELS_JSON=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
labels=d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}].get('labels',[])
print(','.join(labels))
")
      DEPENDS_ON_JSON=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
deps=d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}].get('depends_on',[])
print(','.join(deps))
")

      # Generate slug for this issue (for dependency resolution)
      ISSUE_SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${ISSUE_TITLE}" --raw 2>/dev/null | head -c 40)
      if [ -z "$ISSUE_SLUG" ] && [ -n "$ISSUE_TITLE" ]; then
        ISSUE_SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | cut -c1-40)
      fi

      # Build structured issue body (heredoc — preserves newlines)
      DEPENDS_DISPLAY="${DEPENDS_ON_JSON:-_none_}"
      if [ -z "$DEPENDS_ON_JSON" ]; then
        DEPENDS_DISPLAY="_none_"
      fi

      ISSUE_BODY=$(printf '## Description\n%s\n\n## Acceptance Criteria\n- [ ] %s\n\n## GSD Route\n%s\n\n## Phase Context\nPhase %s: %s of %s\n\n## Depends on\n%s' \
        "$ISSUE_DESC" \
        "$ISSUE_TITLE" \
        "$GSD_ROUTE" \
        "$GLOBAL_PHASE_NUM" \
        "$PHASE_NAME" \
        "$MILESTONE_NAME" \
        "$DEPENDS_DISPLAY")

      # Build label args
      LABEL_ARGS=(-f "labels[]=phase:${GLOBAL_PHASE_NUM}-${PHASE_SLUG}")
      if [ -n "$ISSUE_LABELS_JSON" ]; then
        for LBL in $(echo "$ISSUE_LABELS_JSON" | tr ',' '\n'); do
          LABEL_ARGS+=(-f "labels[]=${LBL}")
        done
      fi

      ISSUE_API_JSON=$(gh api "repos/${REPO}/issues" --method POST \
        -f title="$ISSUE_TITLE" \
        -f body="$ISSUE_BODY" \
        -F milestone="$M_NUMBER" \
        "${LABEL_ARGS[@]}" 2>&1)

      if echo "$ISSUE_API_JSON" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
        ISSUE_NUMBER=$(echo "$ISSUE_API_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])")
        SLUG_TO_NUMBER+=("${ISSUE_SLUG}:${ISSUE_NUMBER}")
        ISSUE_RECORDS+=("${MILESTONE_INDEX}:${ISSUE_NUMBER}:${ISSUE_TITLE}:${GLOBAL_PHASE_NUM}:${PHASE_NAME}:${GSD_ROUTE}:${DEPENDS_ON_JSON}")
        TOTAL_ISSUES_CREATED=$((TOTAL_ISSUES_CREATED + 1))
        echo "    Created issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}"
      else
        echo "    WARNING: Failed to create issue '${ISSUE_TITLE}': ${ISSUE_API_JSON}"
        FAILED_SLUGS+=("$ISSUE_SLUG")
      fi
    done

    # Record phase in phase_map
    PHASE_MAP_JSON=$(echo "$PHASE_MAP_JSON" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
d['${GLOBAL_PHASE_NUM}']={'milestone_index':${MILESTONE_INDEX},'gsd_route':'${GSD_ROUTE}','name':'${PHASE_NAME}'}
print(json.dumps(d))
")
  done
done
```
</step>

<step name="apply_dependencies">
**Pass 2: Apply dependency labels**

For each issue with `depends_on` entries, resolve slug → issue number, create
blocked-by labels, and record in cross-refs.json.

```bash
DEPENDENCY_ENTRIES=()
DEPENDENCY_DISPLAY=()

for RECORD in "${ISSUE_RECORDS[@]}"; do
  DEPENDENT_NUMBER=$(echo "$RECORD" | cut -d':' -f2)
  DEPENDS_ON_SLUGS=$(echo "$RECORD" | cut -d':' -f7)

  if [ -z "$DEPENDS_ON_SLUGS" ]; then
    continue
  fi

  for BLOCKING_SLUG in $(echo "$DEPENDS_ON_SLUGS" | tr ',' '\n'); do
    BLOCKING_SLUG=$(echo "$BLOCKING_SLUG" | tr -d ' ')
    if [ -z "$BLOCKING_SLUG" ]; then continue; fi

    # Resolve slug to issue number
    BLOCKING_NUMBER=""
    for MAPPING in "${SLUG_TO_NUMBER[@]}"; do
      MAP_SLUG=$(echo "$MAPPING" | cut -d':' -f1)
      MAP_NUM=$(echo "$MAPPING" | cut -d':' -f2)
      if [ "$MAP_SLUG" = "$BLOCKING_SLUG" ]; then
        BLOCKING_NUMBER="$MAP_NUM"
        break
      fi
    done

    if [ -z "$BLOCKING_NUMBER" ]; then
      echo "  WARNING: Cannot resolve dependency slug '${BLOCKING_SLUG}' for issue #${DEPENDENT_NUMBER} — skipping"
      continue
    fi

    # Create label (idempotent)
    gh label create "blocked-by:#${BLOCKING_NUMBER}" \
      --description "Blocked by issue #${BLOCKING_NUMBER}" \
      --color "e4e669" \
      --force 2>/dev/null

    # Apply label to dependent issue
    gh issue edit "${DEPENDENT_NUMBER}" --add-label "blocked-by:#${BLOCKING_NUMBER}" 2>/dev/null
    echo "  Applied: #${DEPENDENT_NUMBER} blocked-by:#${BLOCKING_NUMBER}"
    DEPENDENCY_DISPLAY+=("#${DEPENDENT_NUMBER} blocked-by:#${BLOCKING_NUMBER}")

    # Build cross-refs.json entry
    TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
    DEPENDENCY_ENTRIES+=("{\"a\":\"issue:${DEPENDENT_NUMBER}\",\"b\":\"issue:${BLOCKING_NUMBER}\",\"type\":\"blocked-by\",\"created\":\"${TIMESTAMP}\"}")
  done
done

# Write new entries to cross-refs.json
if [ ${#DEPENDENCY_ENTRIES[@]} -gt 0 ]; then
  EXISTING_LINKS=$(python3 -c "
import json
try:
  with open('${MGW_DIR}/cross-refs.json') as f:
    d=json.load(f)
  print(json.dumps(d.get('links',[])))
except:
  print('[]')
")
  ENTRIES_JSON=$(printf '%s\n' "${DEPENDENCY_ENTRIES[@]}" | python3 -c "
import json,sys
entries=[json.loads(line) for line in sys.stdin if line.strip()]
print(json.dumps(entries))
")
  python3 -c "
import json
existing=json.loads('''${EXISTING_LINKS}''')
new_entries=json.loads('''${ENTRIES_JSON}''')
combined={'links': existing + new_entries}
with open('${MGW_DIR}/cross-refs.json','w') as f:
  json.dump(combined, f, indent=2)
print('cross-refs.json updated with',len(new_entries),'entries')
"
fi
```
</step>

<step name="create_project_board">
**Create GitHub Projects v2 board, custom fields, and prepare field metadata for sync:**

Initialize all board field variables. These are populated either from an existing board
(extend mode) or from newly created fields (new board). They are consumed by
`sync_milestone_to_board` and `write_project_json` — project.json has not been written yet
at this point, so fields are passed via bash variables rather than read from disk.

```bash
# Board field variables — set below, consumed by sync_milestone_to_board and write_project_json
BOARD_NODE_ID=""
BOARD_STATUS_FIELD_ID=""
BOARD_STATUS_OPTIONS="{}"
BOARD_AI_STATE_FIELD_ID=""
BOARD_MILESTONE_FIELD_ID=""
BOARD_PHASE_FIELD_ID=""
BOARD_GSD_ROUTE_FIELD_ID=""
BOARD_GSD_ROUTE_OPTIONS="{}"

OWNER=$(echo "$REPO" | cut -d'/' -f1)
REPO_NAME=$(echo "$REPO" | cut -d'/' -f2)
```

**Extend mode — reuse existing board and load its field metadata into bash variables:**

```bash
if [ "$EXTEND_MODE" = true ]; then
  EXISTING_BOARD=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
board = p.get('project', {}).get('project_board', {})
print(json.dumps(board))
")
  PROJECT_NUMBER=$(echo "$EXISTING_BOARD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('number',''))")
  PROJECT_URL=$(echo "$EXISTING_BOARD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('url',''))")
  BOARD_NODE_ID=$(echo "$EXISTING_BOARD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('node_id',''))")

  if [ -n "$PROJECT_NUMBER" ]; then
    echo "  Reusing existing project board: #${PROJECT_NUMBER} — ${PROJECT_URL}"

    # Load existing field IDs into bash variables for sync_milestone_to_board
    if [ -n "$BOARD_NODE_ID" ]; then
      EXISTING_FIELDS=$(echo "$EXISTING_BOARD" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('fields',{})))")
      BOARD_STATUS_FIELD_ID=$(echo "$EXISTING_FIELDS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',{}).get('field_id',''))")
      BOARD_STATUS_OPTIONS=$(echo "$EXISTING_FIELDS" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('status',{}).get('options',{})))")
      BOARD_AI_STATE_FIELD_ID=$(echo "$EXISTING_FIELDS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ai_agent_state',{}).get('field_id',''))")
      BOARD_MILESTONE_FIELD_ID=$(echo "$EXISTING_FIELDS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('milestone',{}).get('field_id',''))")
      BOARD_PHASE_FIELD_ID=$(echo "$EXISTING_FIELDS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('phase',{}).get('field_id',''))")
      BOARD_GSD_ROUTE_FIELD_ID=$(echo "$EXISTING_FIELDS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('gsd_route',{}).get('field_id',''))")
      BOARD_GSD_ROUTE_OPTIONS=$(echo "$EXISTING_FIELDS" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('gsd_route',{}).get('options',{})))")
    fi
  else
    # Board not found — fall through to create a new one
    EXTEND_MODE_BOARD=false
  fi
fi
```

**New board — create via GraphQL (returns node_id) and provision all custom fields:**

The GraphQL `createProjectV2` mutation returns `id` (node_id) in one call — no separate
lookup needed. Custom fields are created immediately so `sync_milestone_to_board` can
set field values on every newly added item. Items are NOT added here; they are added
with field values in `sync_milestone_to_board` via `addProjectV2ItemById`.

```bash
if [ "$EXTEND_MODE" != true ] || [ "$EXTEND_MODE_BOARD" = false ]; then
  # Resolve owner node ID for GraphQL createProjectV2
  OWNER_ID=$(gh api graphql -f query='query($login: String!) { user(login: $login) { id } }' \
    -f login="$OWNER" --jq '.data.user.id' 2>/dev/null)
  if [ -z "$OWNER_ID" ]; then
    OWNER_ID=$(gh api graphql -f query='query($login: String!) { organization(login: $login) { id } }' \
      -f login="$OWNER" --jq '.data.organization.id' 2>/dev/null)
  fi

  if [ -z "$OWNER_ID" ]; then
    echo "  WARNING: Cannot resolve owner node ID — board creation skipped"
    echo "           Run /mgw:board create after project init to provision the board"
    PROJECT_NUMBER=""
    PROJECT_URL=""
  else
    BOARD_TITLE="${PROJECT_NAME} Roadmap"
    CREATE_RESULT=$(gh api graphql -f query='
      mutation($ownerId: ID!, $title: String!) {
        createProjectV2(input: { ownerId: $ownerId title: $title }) {
          projectV2 { id number url }
        }
      }
    ' -f ownerId="$OWNER_ID" -f title="$BOARD_TITLE" 2>&1)

    PROJECT_NUMBER=$(echo "$CREATE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['createProjectV2']['projectV2']['number'])" 2>/dev/null || echo "")
    PROJECT_URL=$(echo "$CREATE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['createProjectV2']['projectV2']['url'])" 2>/dev/null || echo "")
    BOARD_NODE_ID=$(echo "$CREATE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['createProjectV2']['projectV2']['id'])" 2>/dev/null || echo "")

    if [ -z "$BOARD_NODE_ID" ]; then
      echo "  WARNING: Failed to create project board: ${CREATE_RESULT}"
      PROJECT_NUMBER=""
      PROJECT_URL=""
    else
      echo "  Created board: #${PROJECT_NUMBER} — ${PROJECT_URL}"
      echo "  Board node ID: ${BOARD_NODE_ID}"
      echo "  Provisioning custom fields..."

      # Field 1: Status (SINGLE_SELECT — 13 pipeline stages)
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
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      ' -f projectId="$BOARD_NODE_ID" 2>&1)
      BOARD_STATUS_FIELD_ID=$(echo "$STATUS_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['createProjectV2Field']['projectV2Field']['id'])" 2>/dev/null || echo "")
      BOARD_STATUS_OPTIONS=$(echo "$STATUS_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
opts = d['data']['createProjectV2Field']['projectV2Field']['options']
stage_map = {
  'new':'New','triaged':'Triaged','needs-info':'Needs Info',
  'needs-security-review':'Needs Security Review','discussing':'Discussing',
  'approved':'Approved','planning':'Planning','executing':'Executing',
  'verifying':'Verifying','pr-created':'PR Created','done':'Done',
  'failed':'Failed','blocked':'Blocked'
}
name_to_id = {o['name']: o['id'] for o in opts}
print(json.dumps({s: name_to_id.get(l,'') for s,l in stage_map.items()}))
" 2>/dev/null || echo "{}")
      [ -n "$BOARD_STATUS_FIELD_ID" ] && echo "    Status: ${BOARD_STATUS_FIELD_ID}" \
        || echo "    WARNING: Status field creation failed"

      # Field 2: AI Agent State (TEXT)
      AI_RESULT=$(gh api graphql -f query='
        mutation($projectId: ID!) {
          createProjectV2Field(input: { projectId: $projectId dataType: TEXT name: "AI Agent State" }) {
            projectV2Field { ... on ProjectV2Field { id name } }
          }
        }
      ' -f projectId="$BOARD_NODE_ID" 2>&1)
      BOARD_AI_STATE_FIELD_ID=$(echo "$AI_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['createProjectV2Field']['projectV2Field']['id'])" 2>/dev/null || echo "")
      [ -n "$BOARD_AI_STATE_FIELD_ID" ] && echo "    AI Agent State: ${BOARD_AI_STATE_FIELD_ID}" \
        || echo "    WARNING: AI Agent State field creation failed"

      # Field 3: Milestone (TEXT)
      MS_RESULT=$(gh api graphql -f query='
        mutation($projectId: ID!) {
          createProjectV2Field(input: { projectId: $projectId dataType: TEXT name: "Milestone" }) {
            projectV2Field { ... on ProjectV2Field { id name } }
          }
        }
      ' -f projectId="$BOARD_NODE_ID" 2>&1)
      BOARD_MILESTONE_FIELD_ID=$(echo "$MS_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['createProjectV2Field']['projectV2Field']['id'])" 2>/dev/null || echo "")
      [ -n "$BOARD_MILESTONE_FIELD_ID" ] && echo "    Milestone: ${BOARD_MILESTONE_FIELD_ID}" \
        || echo "    WARNING: Milestone field creation failed"

      # Field 4: Phase (TEXT)
      PH_RESULT=$(gh api graphql -f query='
        mutation($projectId: ID!) {
          createProjectV2Field(input: { projectId: $projectId dataType: TEXT name: "Phase" }) {
            projectV2Field { ... on ProjectV2Field { id name } }
          }
        }
      ' -f projectId="$BOARD_NODE_ID" 2>&1)
      BOARD_PHASE_FIELD_ID=$(echo "$PH_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['createProjectV2Field']['projectV2Field']['id'])" 2>/dev/null || echo "")
      [ -n "$BOARD_PHASE_FIELD_ID" ] && echo "    Phase: ${BOARD_PHASE_FIELD_ID}" \
        || echo "    WARNING: Phase field creation failed"

      # Field 5: GSD Route (SINGLE_SELECT — 4 route options)
      GSD_RESULT=$(gh api graphql -f query='
        mutation($projectId: ID!) {
          createProjectV2Field(input: {
            projectId: $projectId
            dataType: SINGLE_SELECT
            name: "GSD Route"
            singleSelectOptions: [
              { name: "quick", color: GREEN, description: "gsd:quick" }
              { name: "quick --full", color: BLUE, description: "gsd:quick --full" }
              { name: "plan-phase", color: YELLOW, description: "gsd:plan-phase" }
              { name: "new-milestone", color: ORANGE, description: "gsd:new-milestone" }
            ]
          }) {
            projectV2Field {
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      ' -f projectId="$BOARD_NODE_ID" 2>&1)
      BOARD_GSD_ROUTE_FIELD_ID=$(echo "$GSD_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['createProjectV2Field']['projectV2Field']['id'])" 2>/dev/null || echo "")
      BOARD_GSD_ROUTE_OPTIONS=$(echo "$GSD_RESULT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
opts = d['data']['createProjectV2Field']['projectV2Field']['options']
route_map = {
  'gsd:quick':'quick','gsd:quick --full':'quick --full',
  'gsd:plan-phase':'plan-phase','gsd:new-milestone':'new-milestone'
}
name_to_id = {o['name']: o['id'] for o in opts}
print(json.dumps({r: name_to_id.get(l,'') for r,l in route_map.items()}))
" 2>/dev/null || echo "{}")
      [ -n "$BOARD_GSD_ROUTE_FIELD_ID" ] && echo "    GSD Route: ${BOARD_GSD_ROUTE_FIELD_ID}" \
        || echo "    WARNING: GSD Route field creation failed"
    fi
  fi
fi
```

Store `PROJECT_NUMBER`, `PROJECT_URL`, `BOARD_NODE_ID`, and field ID variables for use in
`sync_milestone_to_board` and `write_project_json`.
</step>

<step name="sync_milestone_to_board">
**Sync newly created issues onto the board as items with field values (non-blocking):**

This step runs after `create_project_board` (both init and extend modes). It adds each
newly created issue as a board item and sets Status, Milestone, Phase, and GSD Route field
values. Board item IDs are collected here and stored in project.json (as `board_item_id`
per issue).

Field metadata is consumed from the bash variables set during `create_project_board`
(BOARD_NODE_ID, BOARD_STATUS_FIELD_ID, BOARD_MILESTONE_FIELD_ID, etc.). These variables
are available in-process — project.json has NOT been written yet at this point, so
reading field IDs from disk is not possible here.

If no board was created or provisioned (BOARD_NODE_ID is empty), skip silently.

Non-blocking: any GraphQL error is logged as a WARNING and does not halt the pipeline.

```bash
# Use field IDs set during create_project_board — already in scope as bash variables.
# BOARD_NODE_ID, BOARD_STATUS_FIELD_ID, BOARD_STATUS_OPTIONS, BOARD_AI_STATE_FIELD_ID,
# BOARD_MILESTONE_FIELD_ID, BOARD_PHASE_FIELD_ID, BOARD_GSD_ROUTE_FIELD_ID,
# BOARD_GSD_ROUTE_OPTIONS are all set (possibly empty) by the previous step.
MILESTONE_FIELD_ID="${BOARD_MILESTONE_FIELD_ID}"
PHASE_FIELD_ID="${BOARD_PHASE_FIELD_ID}"
GSD_ROUTE_FIELD_ID="${BOARD_GSD_ROUTE_FIELD_ID}"
GSD_ROUTE_OPTIONS="${BOARD_GSD_ROUTE_OPTIONS}"

# Determine if sync is possible
BOARD_SYNC_ENABLED=false
if [ -n "$PROJECT_NUMBER" ] && [ -n "$BOARD_NODE_ID" ]; then
  BOARD_SYNC_ENABLED=true
  echo ""
  echo "Syncing ${TOTAL_ISSUES_CREATED} issues onto board #${PROJECT_NUMBER}..."
elif [ -n "$PROJECT_NUMBER" ] && [ -z "$BOARD_NODE_ID" ]; then
  echo ""
  echo "NOTE: Board #${PROJECT_NUMBER} exists but node_id not available."
  echo "      Run /mgw:board create to provision custom fields and enable board sync."
fi

# ISSUE_RECORD format: "milestone_index:issue_number:title:phase_num:phase_name:gsd_route:depends_on"
# ITEM_ID_MAP accumulates: "issue_number:item_id" for project.json storage
ITEM_ID_MAP=()
BOARD_SYNC_WARNINGS=()

if [ "$BOARD_SYNC_ENABLED" = "true" ]; then
  for RECORD in "${ISSUE_RECORDS[@]}"; do
    ISSUE_NUM=$(echo "$RECORD" | cut -d':' -f2)
    ISSUE_PHASE_NUM=$(echo "$RECORD" | cut -d':' -f4)
    ISSUE_PHASE_NAME=$(echo "$RECORD" | cut -d':' -f5)
    ISSUE_GSD_ROUTE=$(echo "$RECORD" | cut -d':' -f6)
    ISSUE_MILESTONE_IDX=$(echo "$RECORD" | cut -d':' -f1)

    # Get milestone name for this issue
    ISSUE_MILESTONE_NAME=$(python3 -c "
import json
try:
  d = json.load(open('/tmp/mgw-template.json'))
  print(d['milestones'][${ISSUE_MILESTONE_IDX}]['name'])
except:
  print('')
" 2>/dev/null || echo "")

    # Resolve GitHub issue node ID (needed for addProjectV2ItemById)
    ISSUE_NODE_ID=$(gh api graphql -f query='
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) { id }
        }
      }
    ' -f owner="$OWNER" -f repo="$REPO_NAME" -F number="${ISSUE_NUM}" \
      --jq '.data.repository.issue.id' 2>/dev/null || echo "")

    if [ -z "$ISSUE_NODE_ID" ]; then
      BOARD_SYNC_WARNINGS+=("WARNING: Could not resolve node ID for issue #${ISSUE_NUM} — skipping board sync for this issue")
      continue
    fi

    # Add issue to board
    ADD_RESULT=$(gh api graphql -f query='
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {
          projectId: $projectId
          contentId: $contentId
        }) {
          item { id }
        }
      }
    ' -f projectId="$BOARD_NODE_ID" -f contentId="$ISSUE_NODE_ID" 2>/dev/null)

    ITEM_ID=$(echo "$ADD_RESULT" | python3 -c "
import json,sys
try:
  d = json.load(sys.stdin)
  print(d['data']['addProjectV2ItemById']['item']['id'])
except:
  print('')
" 2>/dev/null || echo "")

    if [ -z "$ITEM_ID" ]; then
      BOARD_SYNC_WARNINGS+=("WARNING: Failed to add issue #${ISSUE_NUM} to board")
      continue
    fi

    echo "  Added #${ISSUE_NUM} to board (item: ${ITEM_ID})"
    ITEM_ID_MAP+=("${ISSUE_NUM}:${ITEM_ID}")

    # Set Milestone field (TEXT)
    if [ -n "$MILESTONE_FIELD_ID" ] && [ -n "$ISSUE_MILESTONE_NAME" ]; then
      gh api graphql -f query='
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { text: $value }
          }) { projectV2Item { id } }
        }
      ' -f projectId="$BOARD_NODE_ID" -f itemId="$ITEM_ID" \
        -f fieldId="$MILESTONE_FIELD_ID" -f value="$ISSUE_MILESTONE_NAME" \
        2>/dev/null || BOARD_SYNC_WARNINGS+=("WARNING: Failed to set Milestone field on board item for #${ISSUE_NUM}")
    fi

    # Set Phase field (TEXT) — "Phase N: Phase Name"
    if [ -n "$PHASE_FIELD_ID" ]; then
      PHASE_DISPLAY="Phase ${ISSUE_PHASE_NUM}: ${ISSUE_PHASE_NAME}"
      gh api graphql -f query='
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { text: $value }
          }) { projectV2Item { id } }
        }
      ' -f projectId="$BOARD_NODE_ID" -f itemId="$ITEM_ID" \
        -f fieldId="$PHASE_FIELD_ID" -f value="$PHASE_DISPLAY" \
        2>/dev/null || BOARD_SYNC_WARNINGS+=("WARNING: Failed to set Phase field on board item for #${ISSUE_NUM}")
    fi

    # Set GSD Route field (SINGLE_SELECT) — look up option ID from stored map
    if [ -n "$GSD_ROUTE_FIELD_ID" ]; then
      # Map template gsd_route to board option key (e.g. "plan-phase" → "gsd:plan-phase")
      # GSD_ROUTE_OPTIONS stores keys like "gsd:quick", "gsd:plan-phase", etc.
      ROUTE_OPTION_ID=$(echo "$GSD_ROUTE_OPTIONS" | python3 -c "
import json,sys
opts = json.load(sys.stdin)
# Try exact match on gsd: prefix first, then plain match
route = '${ISSUE_GSD_ROUTE}'
for key, val in opts.items():
    if key == 'gsd:' + route or key == route:
        print(val)
        sys.exit(0)
# Fallback: plain match on the route name without prefix
for key, val in opts.items():
    if key.endswith(':' + route) or key == route:
        print(val)
        sys.exit(0)
print('')
" 2>/dev/null || echo "")

      if [ -n "$ROUTE_OPTION_ID" ]; then
        gh api graphql -f query='
          mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
            updateProjectV2ItemFieldValue(input: {
              projectId: $projectId
              itemId: $itemId
              fieldId: $fieldId
              value: { singleSelectOptionId: $optionId }
            }) { projectV2Item { id } }
          }
        ' -f projectId="$BOARD_NODE_ID" -f itemId="$ITEM_ID" \
          -f fieldId="$GSD_ROUTE_FIELD_ID" -f optionId="$ROUTE_OPTION_ID" \
          2>/dev/null || BOARD_SYNC_WARNINGS+=("WARNING: Failed to set GSD Route field on board item for #${ISSUE_NUM}")
      fi
    fi

    # Set Status field to "new" (pipeline_stage for all newly created issues)
    if [ -n "$BOARD_STATUS_FIELD_ID" ]; then
      STATUS_NEW_OPTION_ID=$(echo "$BOARD_STATUS_OPTIONS" | python3 -c "
import json,sys
opts = json.load(sys.stdin)
print(opts.get('new', ''))
" 2>/dev/null || echo "")
      if [ -n "$STATUS_NEW_OPTION_ID" ]; then
        gh api graphql -f query='
          mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
            updateProjectV2ItemFieldValue(input: {
              projectId: $projectId
              itemId: $itemId
              fieldId: $fieldId
              value: { singleSelectOptionId: $optionId }
            }) { projectV2Item { id } }
          }
        ' -f projectId="$BOARD_NODE_ID" -f itemId="$ITEM_ID" \
          -f fieldId="$BOARD_STATUS_FIELD_ID" -f optionId="$STATUS_NEW_OPTION_ID" \
          2>/dev/null || BOARD_SYNC_WARNINGS+=("WARNING: Failed to set Status field on board item for #${ISSUE_NUM}")
      fi
    fi
  done

  if [ ${#BOARD_SYNC_WARNINGS[@]} -gt 0 ]; then
    echo ""
    echo "Board sync warnings:"
    for W in "${BOARD_SYNC_WARNINGS[@]}"; do
      echo "  $W"
    done
  fi

  BOARD_SYNC_COUNT=$((${#ITEM_ID_MAP[@]}))
  echo "  Board sync complete: ${BOARD_SYNC_COUNT}/${TOTAL_ISSUES_CREATED} issues synced"
fi
```
</step>

<step name="write_project_json">
**Write .mgw/project.json with project state**

Build and write the project.json using the schema from 03-RESEARCH.md Pattern 4:

```bash
CREATED=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
```

Construct the JSON using python3 (to handle proper JSON encoding):

```python
import json, sys

template_data = json.load(open('/tmp/mgw-template.json'))

milestones_out = []
global_phase_num = 0

for m_idx, milestone in enumerate(template_data['milestones']):
    # Find GitHub data from MILESTONE_MAP
    m_entry = MILESTONE_MAP[m_idx]  # "idx:number:id:url"
    m_number = int(m_entry.split(':')[1]) if m_entry.split(':')[1] != 'FAILED' else None
    m_id_val = int(m_entry.split(':')[2]) if m_entry.split(':')[1] != 'FAILED' else None
    m_url = m_entry.split(':',3)[3] if m_entry.split(':')[1] != 'FAILED' else ''

    issues_out = []
    for phase in milestone.get('phases', []):
        global_phase_num += 1
        for issue in phase.get('issues', []):
            # Find github number from SLUG_TO_NUMBER
            slug = slugify(issue['title'])[:40]
            gh_num = SLUG_TO_NUMBER_MAP.get(slug)
            # Look up board_item_id from ITEM_ID_MAP if available
            item_id = ITEM_ID_MAP_DICT.get(gh_num, None)
            issues_out.append({
                "github_number": gh_num,
                "title": issue['title'],
                "phase_number": global_phase_num,
                "phase_name": phase['name'],
                "gsd_route": phase.get('gsd_route', 'plan-phase'),
                "labels": issue.get('labels', []),
                "depends_on_slugs": issue.get('depends_on', []),
                "pipeline_stage": "new",
                "board_item_id": item_id
            })

    milestones_out.append({
        "github_number": m_number,
        "github_id": m_id_val,
        "github_url": m_url,
        "name": milestone['name'],
        "template_milestone_index": m_idx,
        "issues": issues_out
    })

project_json = {
    "project": {
        "name": PROJECT_NAME,
        "description": DESCRIPTION,
        "repo": REPO,
        "template": GENERATED_TYPE,
        "created": CREATED,
        "project_board": {
            "number": PROJECT_NUMBER or None,
            "url": PROJECT_URL or None,
            "node_id": BOARD_NODE_ID or None,
            "fields": BOARD_FIELDS_DICT
        }
    },
    "milestones": milestones_out,
    "current_milestone": 1,
    "phase_map": PHASE_MAP
}
print(json.dumps(project_json, indent=2))
```

Write the output to `${MGW_DIR}/project.json`.

**In practice** (bash + python3 inline): construct the full project.json by assembling
data from `/tmp/mgw-template.json`, the milestone map built in create_milestones, the slug-to-number
map from create_issues, and the phase_map built during create_issues. Write using:

Before writing, build `BOARD_FIELDS_DICT` from the bash field variables set in
`create_project_board`. This is passed into the heredoc via shell variable expansion:

```bash
# Build board fields JSON from bash variables set during create_project_board
BOARD_FIELDS_DICT_JSON=$(python3 -c "
import json, sys, os
fields = {}
status_fid = os.environ.get('BOARD_STATUS_FIELD_ID', '')
status_opts_raw = os.environ.get('BOARD_STATUS_OPTIONS', '{}')
ai_fid = os.environ.get('BOARD_AI_STATE_FIELD_ID', '')
ms_fid = os.environ.get('BOARD_MILESTONE_FIELD_ID', '')
ph_fid = os.environ.get('BOARD_PHASE_FIELD_ID', '')
gsd_fid = os.environ.get('BOARD_GSD_ROUTE_FIELD_ID', '')
gsd_opts_raw = os.environ.get('BOARD_GSD_ROUTE_OPTIONS', '{}')

try:
    status_opts = json.loads(status_opts_raw)
except Exception:
    status_opts = {}
try:
    gsd_opts = json.loads(gsd_opts_raw)
except Exception:
    gsd_opts = {}

if status_fid:
    fields['status'] = {'field_id': status_fid, 'field_name': 'Status', 'type': 'SINGLE_SELECT', 'options': status_opts}
if ai_fid:
    fields['ai_agent_state'] = {'field_id': ai_fid, 'field_name': 'AI Agent State', 'type': 'TEXT'}
if ms_fid:
    fields['milestone'] = {'field_id': ms_fid, 'field_name': 'Milestone', 'type': 'TEXT'}
if ph_fid:
    fields['phase'] = {'field_id': ph_fid, 'field_name': 'Phase', 'type': 'TEXT'}
if gsd_fid:
    fields['gsd_route'] = {'field_id': gsd_fid, 'field_name': 'GSD Route', 'type': 'SINGLE_SELECT', 'options': gsd_opts}
print(json.dumps(fields))
" 2>/dev/null || echo "{}")
```

Then write project.json using:

```bash
python3 << 'PYEOF' > "${MGW_DIR}/project.json"
import json, sys

# Read template data from the validated generated file
template_data = json.load(open('/tmp/mgw-template.json'))

# Build ITEM_ID_MAP_DICT from bash ITEM_ID_MAP array ("issue_num:item_id" entries)
# This dict maps github_number (int) -> board_item_id (str)
ITEM_ID_MAP_DICT = {}
for entry in [x for x in '''${ITEM_ID_MAP[*]}'''.split() if ':' in x]:
    parts = entry.split(':', 1)
    try:
        ITEM_ID_MAP_DICT[int(parts[0])] = parts[1]
    except (ValueError, IndexError):
        pass

# Board fields dict — built from bash env vars above
try:
    BOARD_FIELDS_DICT = json.loads('''${BOARD_FIELDS_DICT_JSON}''')
except Exception:
    BOARD_FIELDS_DICT = {}

# ... (construct from available bash variables — see pseudocode above)
PYEOF
```

The simplest implementation: build the JSON structure incrementally during the
issue/milestone creation steps (maintaining bash arrays), then assemble them into
a python3 dictionary and write with `json.dumps(indent=2)` at this step.

The `ITEM_ID_MAP` bash array (populated in `sync_milestone_to_board`) contains entries
in `"issue_number:board_item_id"` format. Decode it into `ITEM_ID_MAP_DICT` (as shown
above) and use it when building each issue record so `board_item_id` is stored.
If board sync was skipped (ITEM_ID_MAP is empty), `board_item_id` is null for all issues.

Note: use `GENERATED_TYPE` (read from `/tmp/mgw-template.json`) for the `template` field in project.json,
not a hardcoded template name.

**In extend mode, use mergeProjectState instead of full write:**

When `EXTEND_MODE=true`, do NOT write a full project.json. Instead, build only the new milestones
and phase_map entries (with `template_milestone_index` offset by `EXISTING_MILESTONE_COUNT`), then call:

```bash
# Compute the current_milestone pointer for the first new milestone (1-indexed)
NEW_CURRENT_MILESTONE=$((EXISTING_MILESTONE_COUNT + 1))

# Call mergeProjectState via Node — appends without overwriting existing data
node -e "
const { mergeProjectState } = require('${REPO_ROOT}/lib/state.cjs');
const newMilestones = JSON.parse(process.argv[1]);
const newPhaseMap = JSON.parse(process.argv[2]);
const newCurrentMilestone = parseInt(process.argv[3]);
const merged = mergeProjectState(newMilestones, newPhaseMap, newCurrentMilestone);
console.log('project.json updated: ' + merged.milestones.length + ' total milestones');
" "$NEW_MILESTONES_JSON" "$NEW_PHASE_MAP_JSON" "$NEW_CURRENT_MILESTONE"
```

Where `NEW_MILESTONES_JSON` and `NEW_PHASE_MAP_JSON` are JSON-encoded strings built from only
the newly created milestones/phases (matching the existing project.json schema). The
`template_milestone_index` for each new milestone should be offset by `EXISTING_MILESTONE_COUNT`
so indices remain globally unique.

When `EXTEND_MODE` is false, the existing write logic (full project.json from scratch) is unchanged.

**Extend mode: verify new milestone GSD linkage**

After writing the updated project.json in extend mode, report the GSD linkage status for each newly added milestone:

```bash
if [ "$EXTEND_MODE" = true ]; then
  echo ""
  echo "New milestone linkage status:"
  for MILESTONE in "${NEW_MILESTONES[@]}"; do
    MILE_NAME=$(echo "$MILESTONE" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])" 2>/dev/null || echo "unknown")
    echo "  o '${MILE_NAME}' — no GSD milestone linked yet"
    echo "    -> Run /gsd:new-milestone after completing the previous milestone to link"
  done
  echo ""
fi
```
</step>

<step name="report">
**Display post-init summary:**

In extend mode, show the extended banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► PROJECT EXTENDED — {PROJECT_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Extended with {NEW_MILESTONE_COUNT} new milestones (total: {TOTAL_MILESTONES})
Phase numbering: continued from {EXISTING_PHASE_COUNT} (new phases: {EXISTING_PHASE_COUNT+1}–{NEW_MAX_PHASE})
Board: reused #{PROJECT_NUMBER}

(remaining output follows the same format as project init for the new milestones/issues)
```

In standard (non-extend) mode, show the original init banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► PROJECT INIT — {PROJECT_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Type:      {GENERATED_TYPE} ({MILESTONE_COUNT} milestones, {TOTAL_PHASES} phases)
Repo:      {REPO}
Board:     ${PROJECT_URL ? PROJECT_URL : '(not created)'}

Milestones created:
  #{number} {name}      → {url}
  ...

Issues scaffolded: {TOTAL_ISSUES_CREATED} total across {TOTAL_PHASES} phases

Dependencies:
  {list of "#{dependent} blocked-by:#{blocking}" entries}
  (or: "None declared in template")

State:
  .mgw/project.json         written
  .mgw/cross-refs.json      {updated with N entries|unchanged}

Next:
  /gsd:new-milestone         Create GSD ROADMAP.md (if needed)
  /mgw:milestone start       Execute first milestone
```

If any milestones or issues failed to create, include:
```
Warnings:
  Failed to create milestone: {name}
  Failed to create issue: {title}
  (review above and create missing items manually or re-run)
```

**CRITICAL BOUNDARY (PROJ-05):** This command ends here. It does NOT:
- Trigger /mgw:milestone or any execution workflow
- Write to .planning/ (GSD owns that directory — run /gsd:new-milestone to scaffold)
- Execute any issues or plans
</step>
