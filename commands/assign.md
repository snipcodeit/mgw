---
name: mgw:assign
description: Claim an issue for a user — assigns via GitHub and updates board + state
argument-hint: "<issue-number> [username]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

<objective>
Claim a GitHub issue for yourself or another team member. Three operations in one call:

1. **GitHub assignment** — `gh issue edit --add-assignee` to set the issue assignee
2. **State update** — write assignee to `.mgw/active/<issue>.json` (creates minimal entry
   if not yet triaged)
3. **Board confirmation** — if a board is configured, emit the board URL so the team
   can verify the assignment is reflected on the board item

Usage:
- `mgw:assign 42` — assign issue #42 to yourself (@me)
- `mgw:assign 42 alice` — assign issue #42 to @alice

GitHub Projects v2 automatically syncs issue assignees to board items, so no direct
GraphQL mutation is needed for the board Assignees field.

Follows delegation boundary: only state and GitHub operations — no application code reads.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/board-sync.md
</execution_context>

<context>
Arguments: $ARGUMENTS

State: .mgw/active/ (issue state — created if missing)
Board: .mgw/project.json (if configured — read for board URL only)
</context>

<process>

<step name="parse_args">
**Parse $ARGUMENTS into issue number and optional username:**

```bash
ISSUE_NUMBER=$(echo "$ARGUMENTS" | awk '{print $1}')
USERNAME=$(echo "$ARGUMENTS" | awk '{print $2}')

# Validate issue number
if [ -z "$ISSUE_NUMBER" ]; then
  echo "Usage: /mgw:assign <issue-number> [username]"
  echo ""
  echo "  mgw:assign 42          — assign #42 to yourself"
  echo "  mgw:assign 42 alice    — assign #42 to @alice"
  exit 1
fi

if ! echo "$ISSUE_NUMBER" | grep -qE '^[0-9]+$'; then
  echo "ERROR: Issue number must be numeric. Got: '${ISSUE_NUMBER}'"
  exit 1
fi
```
</step>

<step name="validate_and_load">
**Initialize .mgw/ and load existing state (from state.md):**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: Not a git repository."
  exit 1
fi

MGW_DIR="${REPO_ROOT}/.mgw"

# Ensure directory structure
mkdir -p "${MGW_DIR}/active" "${MGW_DIR}/completed"

# Ensure gitignore entries
for ENTRY in ".mgw/" ".worktrees/"; do
  if ! grep -qF "${ENTRY}" "${REPO_ROOT}/.gitignore" 2>/dev/null; then
    echo "${ENTRY}" >> "${REPO_ROOT}/.gitignore"
  fi
done

# Initialize cross-refs if missing
if [ ! -f "${MGW_DIR}/cross-refs.json" ]; then
  echo '{"links":[]}' > "${MGW_DIR}/cross-refs.json"
fi

# Find state file for this issue
STATE_FILE=$(ls "${MGW_DIR}/active/${ISSUE_NUMBER}-"*.json 2>/dev/null | head -1)
STATE_EXISTS=$( [ -n "$STATE_FILE" ] && echo "true" || echo "false" )
```
</step>

<step name="resolve_user">
**Resolve the assignee username:**

```bash
# If no username provided, use the authenticated user
if [ -z "$USERNAME" ]; then
  RESOLVED_USER=$(gh api user -q .login 2>/dev/null)
  if [ -z "$RESOLVED_USER" ]; then
    echo "ERROR: Cannot resolve current GitHub user. Check your gh auth status."
    exit 1
  fi
else
  RESOLVED_USER="$USERNAME"
  # Validate user exists on GitHub
  USER_EXISTS=$(gh api "users/${RESOLVED_USER}" -q .login 2>/dev/null)
  if [ -z "$USER_EXISTS" ]; then
    echo "ERROR: GitHub user '${RESOLVED_USER}' not found."
    exit 1
  fi
fi

echo "MGW: Assigning #${ISSUE_NUMBER} to @${RESOLVED_USER}..."
```
</step>

<step name="fetch_issue">
**Fetch issue metadata from GitHub:**

```bash
ISSUE_DATA=$(gh issue view "$ISSUE_NUMBER" --json number,title,url,labels,assignees,state 2>/dev/null)
if [ -z "$ISSUE_DATA" ]; then
  echo "ERROR: Issue #${ISSUE_NUMBER} not found in this repo."
  exit 1
fi

ISSUE_TITLE=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['title'])" 2>/dev/null)
ISSUE_URL=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])" 2>/dev/null)
ISSUE_STATE=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['state'])" 2>/dev/null)

# Check if user is already assigned (idempotent)
ALREADY_ASSIGNED=$(echo "$ISSUE_DATA" | python3 -c "
import json,sys
d = json.load(sys.stdin)
assignees = [a['login'] for a in d.get('assignees', [])]
print('true' if '${RESOLVED_USER}' in assignees else 'false')
" 2>/dev/null)
```
</step>

<step name="assign_github">
**Assign the issue on GitHub:**

```bash
if [ "$ALREADY_ASSIGNED" = "true" ]; then
  echo "MGW: @${RESOLVED_USER} is already assigned to #${ISSUE_NUMBER} — confirming state."
else
  if ! gh issue edit "$ISSUE_NUMBER" --add-assignee "$RESOLVED_USER" 2>/dev/null; then
    echo "ERROR: Failed to assign @${RESOLVED_USER} to #${ISSUE_NUMBER}."
    echo "       Check that the user has access to this repo."
    exit 1
  fi
  echo "MGW: Assigned @${RESOLVED_USER} to #${ISSUE_NUMBER}."
fi
```
</step>

<step name="update_state">
**Write assignee to .mgw/active/ state (create minimal entry if needed):**

```bash
TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null \
  || date -u +"%Y-%m-%dT%H:%M:%S.000Z")

if [ "$STATE_EXISTS" = "true" ]; then
  # Update existing state file: set issue.assignee field
  python3 -c "
import json
with open('${STATE_FILE}') as f:
    state = json.load(f)
state['issue']['assignee'] = '${RESOLVED_USER}'
state['updated_at'] = '${TIMESTAMP}'
with open('${STATE_FILE}', 'w') as f:
    json.dump(state, f, indent=2)
print('updated')
" 2>/dev/null

else
  # No state file — generate slug and create minimal entry
  SLUG=\$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${ISSUE_TITLE}" --raw 2>/dev/null | cut -c1-40 \
    || echo "issue-${ISSUE_NUMBER}")

  NEW_STATE_FILE="${MGW_DIR}/active/${ISSUE_NUMBER}-${SLUG}.json"

  python3 -c "
import json
state = {
  'issue': {
    'number': ${ISSUE_NUMBER},
    'title': '${ISSUE_TITLE}',
    'url': '${ISSUE_URL}',
    'labels': [],
    'assignee': '${RESOLVED_USER}'
  },
  'triage': {
    'scope': { 'size': 'unknown', 'file_count': 0, 'files': [], 'systems': [] },
    'validity': 'pending',
    'security_risk': 'unknown',
    'security_notes': '',
    'conflicts': [],
    'last_comment_count': 0,
    'last_comment_at': None,
    'gate_result': { 'status': 'pending', 'blockers': [], 'warnings': [], 'missing_fields': [] }
  },
  'gsd_route': None,
  'gsd_artifacts': { 'type': None, 'path': None },
  'pipeline_stage': 'new',
  'comments_posted': [],
  'linked_pr': None,
  'linked_issues': [],
  'linked_branches': [],
  'created_at': '${TIMESTAMP}',
  'updated_at': '${TIMESTAMP}'
}
with open('${NEW_STATE_FILE}', 'w') as f:
    json.dump(state, f, indent=2)
print('created')
" 2>/dev/null

  STATE_FILE="$NEW_STATE_FILE"
  echo "MGW: Created minimal state entry at ${STATE_FILE}"
fi
```
</step>

<step name="check_board">
**Check if board is configured and emit board URL:**

GitHub Projects v2 automatically syncs issue assignees to board items. No direct
GraphQL mutation is needed — the board will reflect the new assignee when refreshed.

```bash
BOARD_URL=$(python3 -c "
import json, sys, os
try:
    p = json.load(open('${MGW_DIR}/project.json'))
    board = p.get('project', {}).get('project_board', {})
    print(board.get('url', ''))
except:
    print('')
" 2>/dev/null || echo "")

BOARD_ITEM_ID=$(python3 -c "
import json, sys
try:
    p = json.load(open('${MGW_DIR}/project.json'))
    for m in p.get('milestones', []):
        for i in m.get('issues', []):
            if i.get('github_number') == ${ISSUE_NUMBER}:
                print(i.get('board_item_id', ''))
                sys.exit(0)
    print('')
except:
    print('')
" 2>/dev/null || echo "")

BOARD_CONFIGURED=$( [ -n "$BOARD_URL" ] && echo "true" || echo "false" )
```
</step>

<step name="confirm">
**Emit assignment confirmation:**

```bash
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " MGW ► ISSUE ASSIGNED"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Issue  : #${ISSUE_NUMBER} — ${ISSUE_TITLE}"
echo " URL    : ${ISSUE_URL}"
echo " Assignee: @${RESOLVED_USER}"
echo " State  : ${ISSUE_STATE}"
if [ "$BOARD_CONFIGURED" = "true" ]; then
  echo " Board  : ${BOARD_URL}"
  if [ -n "$BOARD_ITEM_ID" ]; then
    echo "          (board item updated automatically by GitHub)"
  else
    echo "          (issue not yet added to board — run /mgw:board show)"
  fi
fi
echo ""
if [ "$ALREADY_ASSIGNED" = "true" ]; then
  echo " Note: @${RESOLVED_USER} was already the assignee — state confirmed."
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```
</step>

</process>
