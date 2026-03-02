---
name: mgw:roadmap
description: Render project milestones as a roadmap — completion table, due dates, and optional Discussion post
argument-hint: "[--set-dates] [--post-discussion] [--json]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

<objective>
Render the current MGW project's milestones as a roadmap view. Three capabilities:

- **Table** (always) — Prints a markdown table of milestone name, issue count, completion
  percentage, and board URL for each milestone in project.json.
- **Due dates** (`--set-dates`) — Interactively prompts for a due date per milestone and
  sets it on the corresponding GitHub milestone via the REST API. Enables the Roadmap
  layout timeline in GitHub Projects v2.
- **Discussion post** (`--post-discussion`) — Posts the roadmap table as a new Discussion
  in the repo's roadmap category (creates the category if it doesn't exist). Intended as
  a persistent, pinnable roadmap artifact.

Reads `.mgw/project.json` and calls GitHub API only. Never reads application source code.
Follows delegation boundary: no Task() spawns needed — all operations are metadata-only.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
</execution_context>

<context>
Flags: $ARGUMENTS

Repo detected via: gh repo view --json nameWithOwner -q .nameWithOwner
State: .mgw/project.json
</context>

<process>

<step name="parse_arguments">
**Parse $ARGUMENTS for flags:**

```bash
SET_DATES=false
POST_DISCUSSION=false
JSON_OUTPUT=false

for ARG in $ARGUMENTS; do
  case "$ARG" in
    --set-dates)       SET_DATES=true ;;
    --post-discussion) POST_DISCUSSION=true ;;
    --json)            JSON_OUTPUT=true ;;
  esac
done
```
</step>

<step name="validate_environment">
**Validate git repo and GitHub remote:**

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
**Load project.json and extract milestone data:**

```bash
PROJECT_JSON=$(cat "${MGW_DIR}/project.json")

PROJECT_NAME=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
print(p.get('project', {}).get('name', 'unknown'))
")

# Extract board URL (top-level board_url or nested project_board.url)
BOARD_URL=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
url = (p.get('project', {}).get('project_board', {}).get('url', '')
       or p.get('board_url', ''))
print(url or '')
" 2>/dev/null || echo "")

# Extract all milestones with computed stats
MILESTONES_DATA=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys

p = json.load(sys.stdin)
milestones = p.get('milestones', [])
out = []
for m in milestones:
    issues = m.get('issues', [])
    total = len(issues)
    done = sum(1 for i in issues if i.get('pipeline_stage') in ('done', 'pr-created'))
    pct = int((done / total) * 100) if total > 0 else 0
    out.append({
        'github_number': m.get('github_number'),
        'name': m.get('name', 'Unnamed'),
        'gsd_state': m.get('gsd_state'),
        'total': total,
        'done': done,
        'pct': pct,
        'github_url': m.get('github_url', ''),
    })
print(json.dumps(out))
")

TOTAL_MILESTONES=$(echo "$MILESTONES_DATA" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
```
</step>

<step name="fetch_github_milestone_due_dates">
**Fetch current due dates from GitHub for each milestone:**

```bash
# Fetch all GitHub milestones for this repo once (avoids N+1 API calls)
GH_MILESTONES=$(gh api "repos/${REPO}/milestones?state=all&per_page=100" 2>/dev/null || echo "[]")

# Build map: github_number -> due_on
DUE_DATE_MAP=$(echo "$GH_MILESTONES" | python3 -c "
import json, sys
milestones = json.load(sys.stdin)
result = {}
for m in milestones:
    due = m.get('due_on', '') or ''
    # Trim to date only (GitHub returns ISO datetime)
    if due:
        due = due[:10]
    result[str(m['number'])] = due
print(json.dumps(result))
")
```
</step>

<step name="build_roadmap_table">
**Compute per-milestone rows for the roadmap table:**

```bash
TABLE_DATA=$(echo "$MILESTONES_DATA" | python3 -c "
import json, sys, os

milestones = json.load(sys.stdin)
due_map = json.loads(os.environ.get('DUE_DATE_MAP', '{}'))
board_url = os.environ.get('BOARD_URL', '')

rows = []
for m in milestones:
    num = str(m.get('github_number', ''))
    due = due_map.get(num, '')
    bar_filled = int(m['pct'] / 100 * 8)
    bar = chr(9608) * bar_filled + chr(9617) * (8 - bar_filled)

    # Status indicator
    if m.get('gsd_state') == 'completed':
        status = 'done'
    elif m.get('gsd_state') == 'active':
        status = 'active'
    else:
        status = 'planned'

    rows.append({
        'number': num,
        'name': m['name'],
        'status': status,
        'done': m['done'],
        'total': m['total'],
        'pct': m['pct'],
        'bar': bar,
        'due': due or 'not set',
        'github_url': m.get('github_url', ''),
    })

print(json.dumps(rows))
")

# Export for use in due-date and discussion steps
export DUE_DATE_MAP BOARD_URL TABLE_DATA
```
</step>

<step name="display_roadmap_table">
**Print the roadmap table to the terminal:**

```bash
echo "$TABLE_DATA" | python3 -c "
import json, sys

rows = json.load(sys.stdin)

print()
print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
print(' MGW > ROADMAP: ${PROJECT_NAME}')
if '${BOARD_URL}':
    print(' Board: ${BOARD_URL}')
print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
print()

# Header
print(f'{\"Milestone\":<48}  {\"Status\":<8}  {\"Issues\":<10}  {\"Progress\":<14}  {\"Due Date\":<12}')
print('-' * 98)

for r in rows:
    name_cell = r['name'][:47]
    issues_cell = f\"{r['done']}/{r['total']}\"
    progress_cell = f\"{r['bar']} {r['pct']}%\"
    print(f\"{name_cell:<48}  {r['status']:<8}  {issues_cell:<10}  {progress_cell:<14}  {r['due']:<12}\")

print()
total_issues = sum(r['total'] for r in rows)
done_issues  = sum(r['done']  for r in rows)
overall_pct  = int((done_issues / total_issues) * 100) if total_issues > 0 else 0
print(f'Overall: {done_issues}/{total_issues} issues done ({overall_pct}%)')
print()
"
```

**If `--json` flag:** emit JSON instead of formatted table and exit:

```bash
if [ "$JSON_OUTPUT" = true ]; then
  echo "$TABLE_DATA" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
result = {
    'repo': '${REPO}',
    'project_name': '${PROJECT_NAME}',
    'board_url': '${BOARD_URL}',
    'milestones': rows
}
print(json.dumps(result, indent=2))
"
  exit 0
fi
```
</step>

<step name="set_due_dates">
**If `--set-dates`: interactively set GitHub milestone due dates:**

This step runs only when `SET_DATES=true`. It prompts for a date per milestone and
calls the GitHub REST API to set `due_on`. Setting due dates enables the Roadmap layout
timeline in GitHub Projects v2.

```bash
if [ "$SET_DATES" = true ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " SET DUE DATES"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Enter due dates for each milestone (YYYY-MM-DD format, or press Enter to skip)."
  echo ""

  # Iterate each milestone and prompt
  echo "$TABLE_DATA" | python3 -c "import json,sys; [print(r['number'], r['name']) for r in json.load(sys.stdin) if r['number']]" | \
  while read -r MILESTONE_NUM MILESTONE_NAME; do
    CURRENT_DUE=$(echo "$DUE_DATE_MAP" | python3 -c "
import json,sys
m = json.load(sys.stdin)
print(m.get('${MILESTONE_NUM}', 'not set'))
")
    echo -n "  ${MILESTONE_NAME} (current: ${CURRENT_DUE}): "
    read -r INPUT_DATE

    if [ -z "$INPUT_DATE" ]; then
      echo "    → skipped"
      continue
    fi

    # Validate date format
    if ! echo "$INPUT_DATE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
      echo "    → invalid format (expected YYYY-MM-DD), skipped"
      continue
    fi

    # GitHub requires ISO 8601 with time: append T07:00:00Z (noon UTC)
    DUE_ISO="${INPUT_DATE}T07:00:00Z"

    RESULT=$(gh api "repos/${REPO}/milestones/${MILESTONE_NUM}" \
      --method PATCH \
      -f due_on="$DUE_ISO" \
      --jq '.due_on' 2>&1)

    if echo "$RESULT" | grep -q "^[0-9]"; then
      echo "    → set to ${INPUT_DATE}"
    else
      echo "    → error setting date: ${RESULT}"
    fi
  done

  echo ""
  echo "Due dates updated. Roadmap timeline is now enabled in GitHub Projects v2."
  echo "Open the board and switch to Roadmap view to see the timeline."
  echo ""
fi
```

Note: `due_on` is set via the GitHub REST API at `PATCH /repos/{owner}/{repo}/milestones/{milestone_number}`.
The milestone number here is the GitHub milestone number (integer), not the project.json index.
</step>

<step name="post_discussion">
**If `--post-discussion`: post the roadmap table as a GitHub Discussion:**

This step runs only when `POST_DISCUSSION=true`. It creates (or finds) a "Roadmap"
Discussion category and posts the markdown table as a new Discussion titled
"Project Roadmap — {project_name}".

```bash
if [ "$POST_DISCUSSION" = true ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " POST DISCUSSION"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Get repo node ID (needed for GraphQL Discussion mutation)
  REPO_NODE_ID=$(gh api graphql -f query='
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id }
    }
  ' -f owner="$OWNER" -f name="$REPO_NAME" --jq '.data.repository.id')

  # Find or create the Roadmap discussion category
  CATEGORY_ID=$(gh api graphql -f query='
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        discussionCategories(first: 25) {
          nodes { id name }
        }
      }
    }
  ' -f owner="$OWNER" -f name="$REPO_NAME" \
    --jq '.data.repository.discussionCategories.nodes[] | select(.name == "Roadmap") | .id' 2>/dev/null)

  if [ -z "$CATEGORY_ID" ]; then
    echo "No 'Roadmap' discussion category found."
    echo "Please create a 'Roadmap' category in GitHub Discussions settings, then re-run."
    echo "Path: https://github.com/${REPO}/settings -> Discussions -> Categories"
    echo ""
    echo "Alternatively, posting to the 'Announcements' category (first available)..."

    # Fallback: use the first available category
    CATEGORY_ID=$(gh api graphql -f query='
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          discussionCategories(first: 1) {
            nodes { id name }
          }
        }
      }
    ' -f owner="$OWNER" -f name="$REPO_NAME" \
      --jq '.data.repository.discussionCategories.nodes[0].id' 2>/dev/null)

    CATEGORY_NAME=$(gh api graphql -f query='
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          discussionCategories(first: 1) {
            nodes { id name }
          }
        }
      }
    ' -f owner="$OWNER" -f name="$REPO_NAME" \
      --jq '.data.repository.discussionCategories.nodes[0].name' 2>/dev/null)

    echo "Using category: ${CATEGORY_NAME}"
    echo ""
  fi

  if [ -z "$CATEGORY_ID" ]; then
    echo "Could not find a discussion category. Discussions may not be enabled."
    echo "Enable Discussions at: https://github.com/${REPO}/settings"
  else
    # Build discussion body (markdown table)
    DISCUSSION_BODY=$(echo "$TABLE_DATA" | python3 -c "
import json, sys, os

rows = json.load(sys.stdin)
board_url = os.environ.get('BOARD_URL', '')
project_name = os.environ.get('PROJECT_NAME', 'MGW')

lines = []
lines.append('## Project Roadmap')
lines.append('')
if board_url:
    lines.append(f'> Board: {board_url}')
    lines.append('')
lines.append('| Milestone | Status | Issues | Progress | Due Date |')
lines.append('|-----------|--------|--------|----------|----------|')

for r in rows:
    name_link = f\"[{r['name']}]({r['github_url']})\" if r.get('github_url') else r['name']
    issues_cell = f\"{r['done']}/{r['total']}\"
    progress_cell = f\"{r['bar']} {r['pct']}%\"
    lines.append(f\"| {name_link} | {r['status']} | {issues_cell} | {progress_cell} | {r['due']} |\")

lines.append('')
total_issues = sum(r['total'] for r in rows)
done_issues  = sum(r['done']  for r in rows)
overall_pct  = int((done_issues / total_issues) * 100) if total_issues > 0 else 0
lines.append(f'**Overall:** {done_issues}/{total_issues} issues done ({overall_pct}%)')
lines.append('')
lines.append('---')
lines.append('*Auto-generated by [MGW](https://github.com/snipcodeit/mgw) — `/mgw:roadmap --post-discussion`*')

print('\n'.join(lines))
")

    DISCUSSION_TITLE="Project Roadmap — ${PROJECT_NAME}"

    # Create the Discussion via GraphQL
    DISCUSSION_RESULT=$(gh api graphql -f query='
      mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
        createDiscussion(input: {
          repositoryId: $repoId,
          categoryId: $categoryId,
          title: $title,
          body: $body
        }) {
          discussion { url number }
        }
      }
    ' \
      -f repoId="$REPO_NODE_ID" \
      -f categoryId="$CATEGORY_ID" \
      -f title="$DISCUSSION_TITLE" \
      -f body="$DISCUSSION_BODY" 2>&1)

    DISCUSSION_URL=$(echo "$DISCUSSION_RESULT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d['data']['createDiscussion']['discussion']['url'])
except Exception:
    print('')
" 2>/dev/null)

    if [ -n "$DISCUSSION_URL" ]; then
      echo "Discussion posted: ${DISCUSSION_URL}"
      echo ""
      echo "To pin this roadmap: open the discussion and click 'Pin discussion'."
    else
      echo "Failed to post discussion. Response:"
      echo "$DISCUSSION_RESULT" | python3 -m json.tool 2>/dev/null || echo "$DISCUSSION_RESULT"
    fi
  fi
fi
```
</step>

</process>

<success_criteria>
- [ ] project.json loaded; graceful error when missing
- [ ] Milestone table printed with name, status, done/total issues, progress bar + percentage, due date
- [ ] Overall summary line (total done/total across all milestones)
- [ ] --json flag outputs machine-readable JSON and exits 0
- [ ] --set-dates: prompts for date per milestone, sets GitHub milestone due_on via REST API
- [ ] --set-dates: skips milestones where Enter is pressed with no input
- [ ] --set-dates: validates YYYY-MM-DD format before API call; reports invalid format without exiting
- [ ] --post-discussion: finds or falls back from Roadmap category; creates Discussion with markdown table
- [ ] --post-discussion: outputs Discussion URL on success
- [ ] --post-discussion: error message when Discussions not enabled, no exit failure
- [ ] Board URL shown in header when present in project.json
- [ ] Read-only by default: no GitHub writes unless --set-dates or --post-discussion passed
- [ ] Delegation boundary respected: no application source reads, no Task() spawns needed
</success_criteria>
