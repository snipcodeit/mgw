---
name: mgw:sync
description: Reconcile local .mgw/ state with GitHub — archive completed, flag drift
argument-hint: ""
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

<objective>
Catch drift between GitHub and local .mgw/ state. For each active issue, checks
if the GitHub issue is still open, if linked PRs were merged/closed, and if tracked
branches still exist. Moves completed items to .mgw/completed/, cleans up branches
and lingering worktrees, flags inconsistencies.

Also pulls board state to reconstruct missing local state files — enabling multi-machine
workflows. On a fresh machine with no .mgw/active/ files, sync reads the GitHub Projects
v2 board's Status field and rebuilds local state for every in-progress issue, so work
can continue without re-triaging from scratch.

Run periodically or when starting a new session to get a clean view.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<process>

<step name="pull_board_state">
**Pull board state to reconstruct missing local .mgw/active/ files.**

This step runs first — before scan_active — so that any issues the board knows about
but this machine doesn't will be present by the time check_each runs. This is the
multi-machine sync mechanism: board is the distributed source of truth, .mgw/active/
is the local cache that sync rebuilds from it.

Two sub-operations, both non-blocking:
1. **Board discovery** — if project_board.node_id is missing, find and register it.
2. **Board pull** — fetch all board items, reconstruct .mgw/active/ for any issue not
   present locally, detect stage drift for issues that exist on both sides.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
MGW_DIR="${REPO_ROOT}/.mgw"
OWNER=$(gh repo view --json owner -q .owner.login 2>/dev/null)
ACTIVE_DIR="${MGW_DIR}/active"
mkdir -p "$ACTIVE_DIR"

BOARD_NODE_ID=$(python3 -c "
import json
try:
    p = json.load(open('${MGW_DIR}/project.json'))
    print(p.get('project', {}).get('project_board', {}).get('node_id', ''))
except: print('')
" 2>/dev/null || echo "")

BOARD_DISCOVERED=""
BOARD_PULL_CREATED=0
BOARD_PULL_DRIFT="[]"
BOARD_PULL_ERRORS="[]"

# Sub-operation 1: board discovery
if [ -z "$BOARD_NODE_ID" ] && [ -f "${MGW_DIR}/project.json" ]; then
  PROJECT_NAME=$(python3 -c "
import json
try:
    p = json.load(open('${MGW_DIR}/project.json'))
    print(p.get('project', {}).get('name', ''))
except: print('')
" 2>/dev/null || echo "")

  if [ -n "$PROJECT_NAME" ]; then
    DISCOVERED=$(node -e "
const { findExistingBoard, getProjectFields } = require('./lib/github.cjs');
const board = findExistingBoard('${OWNER}', '${PROJECT_NAME}');
if (!board) { process.stdout.write(''); process.exit(0); }
const fields = getProjectFields('${OWNER}', board.number) || {};
console.log(JSON.stringify({ ...board, fields }));
" 2>/dev/null || echo "")

    if [ -n "$DISCOVERED" ]; then
      python3 -c "
import json
with open('${MGW_DIR}/project.json') as f:
    project = json.load(f)
d = json.loads('${DISCOVERED}')
project['project']['project_board'] = {
    'number': d['number'], 'url': d['url'],
    'node_id': d['nodeId'], 'fields': d.get('fields', {})
}
with open('${MGW_DIR}/project.json', 'w') as f:
    json.dump(project, f, indent=2)
" 2>/dev/null
      BOARD_NODE_ID=$(echo "$DISCOVERED" | python3 -c "import json,sys; print(json.load(sys.stdin)['nodeId'])" 2>/dev/null)
      DISC_NUMBER=$(echo "$DISCOVERED" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])" 2>/dev/null)
      DISC_URL=$(echo "$DISCOVERED" | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])" 2>/dev/null)
      BOARD_DISCOVERED="#${DISC_NUMBER} — ${DISC_URL}"
    fi
  fi
fi

# Sub-operation 2: board pull
if [ -n "$BOARD_NODE_ID" ]; then
  echo "Pulling board state from GitHub..."

  BOARD_ITEMS=$(gh api graphql -f query='
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100) {
            nodes {
              id
              content {
                ... on Issue { number title url }
              }
              fieldValues(first: 10) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2SingleSelectField { name } }
                  }
                }
              }
            }
          }
        }
      }
    }
  ' -f projectId="$BOARD_NODE_ID" \
    --jq '.data.node.items.nodes' 2>/dev/null || echo "[]")

  # One Python call handles: map board items, detect missing local files,
  # reconstruct state from GitHub issue data, detect drift on existing files.
  PULL_RESULT=$(echo "$BOARD_ITEMS" | ACTIVE_DIR="$ACTIVE_DIR" MGW_DIR="$MGW_DIR" python3 << 'PYEOF'
import json, sys, os, subprocess, re

ACTIVE_DIR = os.environ['ACTIVE_DIR']
GSD_TOOLS = os.path.expanduser('~/.claude/get-shit-done/bin/gsd-tools.cjs')

STATUS_TO_STAGE = {
    'New': 'new', 'Triaged': 'triaged',
    'Needs Info': 'needs-info', 'Needs Security Review': 'needs-security-review',
    'Discussing': 'discussing', 'Approved': 'approved',
    'Planning': 'planning', 'Executing': 'executing',
    'Verifying': 'verifying', 'PR Created': 'pr-created',
    'Done': 'done', 'Failed': 'failed', 'Blocked': 'blocked'
}

nodes = json.load(sys.stdin)
created = []
drift = []
errors = []

for node in nodes:
    content = node.get('content', {})
    num = content.get('number')
    if num is None:
        continue

    status_label = ''
    route_label = ''
    for fv in node.get('fieldValues', {}).get('nodes', []):
        fname = fv.get('field', {}).get('name', '')
        if fname == 'Status':
            status_label = fv.get('name', '')
        elif fname == 'GSD Route':
            route_label = fv.get('name', '')

    board_stage = STATUS_TO_STAGE.get(status_label, 'new')

    # Done items belong in completed/, not active/ — skip
    if board_stage == 'done':
        continue

    # Check for existing local active file
    existing = None
    for fname in os.listdir(ACTIVE_DIR):
        if fname.startswith(f'{num}-') and fname.endswith('.json'):
            existing = os.path.join(ACTIVE_DIR, fname)
            break

    if existing is None:
        # No local file — reconstruct from GitHub issue data
        try:
            r = subprocess.run(
                ['gh', 'issue', 'view', str(num),
                 '--json', 'number,title,url,labels,assignees'],
                capture_output=True, text=True
            )
            issue = json.loads(r.stdout)
        except Exception as e:
            errors.append({'number': num, 'error': str(e)})
            continue

        title = issue.get('title', content.get('title', ''))

        try:
            slug = subprocess.run(
                ['node', GSD_TOOLS, 'generate-slug', title, '--raw'],
                capture_output=True, text=True
            ).stdout.strip()[:40]
        except:
            slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')[:40]

        try:
            ts = subprocess.run(
                ['node', GSD_TOOLS, 'current-timestamp', '--raw'],
                capture_output=True, text=True
            ).stdout.strip()
        except:
            from datetime import datetime
            ts = datetime.utcnow().isoformat() + 'Z'

        labels = [l.get('name', '') if isinstance(l, dict) else str(l)
                  for l in issue.get('labels', [])]
        assignees = issue.get('assignees', [])
        assignee = assignees[0].get('login') if assignees else None

        state = {
            'issue': {
                'number': num,
                'title': title,
                'url': issue.get('url', content.get('url', '')),
                'labels': labels,
                'assignee': assignee
            },
            'triage': {
                'scope': {'files': 0, 'systems': []},
                'validity': 'confirmed',
                'security_notes': '',
                'conflicts': [],
                'last_comment_count': 0,
                'last_comment_at': None,
                'gate_result': {
                    'status': 'passed',
                    'blockers': [],
                    'warnings': [f'Reconstructed from board state by mgw:sync — {ts}'],
                    'missing_fields': []
                }
            },
            'gsd_route': route_label or None,
            'gsd_artifacts': {'type': None, 'path': None},
            'pipeline_stage': board_stage,
            'reconstructed_from_board': True,
            'comments_posted': [],
            'linked_pr': None,
            'linked_issues': [],
            'linked_branches': []
        }

        state_path = os.path.join(ACTIVE_DIR, f'{num}-{slug}.json')
        with open(state_path, 'w') as f:
            json.dump(state, f, indent=2)

        created.append({'number': num, 'title': title, 'stage': board_stage})

    else:
        # Local file exists — detect stage drift
        try:
            local = json.load(open(existing))
            local_stage = local.get('pipeline_stage', 'new')
            if local_stage != board_stage:
                drift.append({
                    'number': num,
                    'title': content.get('title', ''),
                    'local': local_stage,
                    'board': board_stage
                })
        except:
            pass

print(json.dumps({'created': created, 'drift': drift, 'errors': errors}))
PYEOF
)

  BOARD_PULL_CREATED=$(echo "$PULL_RESULT" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('created', [])))" 2>/dev/null || echo "0")
  BOARD_PULL_DRIFT=$(echo "$PULL_RESULT" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('drift', [])))" 2>/dev/null || echo "[]")
  BOARD_PULL_ERRORS=$(echo "$PULL_RESULT" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('errors', [])))" 2>/dev/null || echo "[]")

  if [ "$BOARD_PULL_CREATED" -gt 0 ]; then
    echo "  Reconstructed ${BOARD_PULL_CREATED} issue(s) from board state"
    echo "$PULL_RESULT" | python3 -c "
import json, sys
for item in json.load(sys.stdin).get('created', []):
    print(f'  ✓ #{item[\"number\"]} ({item[\"stage\"]}): {item[\"title\"][:60]}')
" 2>/dev/null
  fi

  # Offer drift resolution if any issues have mismatched stages
  DRIFT_COUNT=$(echo "$BOARD_PULL_DRIFT" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

  if [ "$DRIFT_COUNT" -gt 0 ]; then
    echo ""
    echo "Stage drift detected (board vs local):"
    echo "$BOARD_PULL_DRIFT" | python3 -c "
import json, sys
for d in json.load(sys.stdin):
    print(f'  #{d[\"number\"]} {d[\"title\"][:45]}: local={d[\"local\"]} board={d[\"board\"]}')
" 2>/dev/null
    echo ""

    AskUserQuestion(
      header: "Stage Drift",
      question: "Board and local state disagree on pipeline stage for ${DRIFT_COUNT} issue(s). How should we resolve?",
      options: [
        { label: "Pull from board", description: "Update all local files to match board stages (board is source of truth)" },
        { label: "Keep local",      description: "Leave local stages as-is — board will be updated next time pipeline runs" },
        { label: "Skip",            description: "Ignore drift for now — flag in report only" }
      ]
    )

    if [ "$USER_CHOICE" = "Pull from board" ]; then
      echo "$BOARD_PULL_DRIFT" | python3 -c "
import json, sys, os

drift = json.load(sys.stdin)
active_dir = '${ACTIVE_DIR}'

for d in drift:
    num = d['number']
    board_stage = d['board']
    for fname in os.listdir(active_dir):
        if fname.startswith(f'{num}-') and fname.endswith('.json'):
            path = os.path.join(active_dir, fname)
            state = json.load(open(path))
            state['pipeline_stage'] = board_stage
            with open(path, 'w') as f:
                json.dump(state, f, indent=2)
            print(f'  Updated #{num}: {d[\"local\"]} → {board_stage}')
            break
" 2>/dev/null
      BOARD_PULL_DRIFT="[]"  # Resolved
    fi
  fi
fi
```

**Note:** `reconstructed_from_board: true` is set on any state file created this way.
Downstream commands (`/mgw:run`, `/mgw:issue`) will see this flag and know the state was
rebuilt from board data — triage results and GSD artifacts will need to be re-run if the
issue advances to `planning` or beyond.
</step>

<step name="scan_active">
**Scan all active issue states:**

```bash
ls .mgw/active/*.json 2>/dev/null
```

If no active issues → "No active MGW issues. Nothing to sync."

For each file, load the JSON state.
</step>

<step name="check_each">
**For each active issue, check GitHub state:**

```bash
# Issue state
gh issue view ${NUMBER} --json state,closed -q '{state: .state, closed: .closed}'

# PR state (if linked_pr exists)
gh pr view ${PR_NUMBER} --json state,mergedAt -q '{state: .state, mergedAt: .mergedAt}' 2>/dev/null

# Branch existence
git branch --list ${BRANCH_NAME} | grep -q . && echo "local" || echo "no-local"
git ls-remote --heads origin ${BRANCH_NAME} | grep -q . && echo "remote" || echo "no-remote"

# Worktree existence
git worktree list | grep -q "${BRANCH_NAME}" && echo "worktree" || echo "no-worktree"

# Comment delta (detect unreviewed comments since triage)
CURRENT_COMMENTS=$(gh issue view ${NUMBER} --json comments --jq '.comments | length' 2>/dev/null || echo "0")
STORED_COMMENTS="${triage.last_comment_count}"  # From state file, may be null/missing
if [ -n "$STORED_COMMENTS" ] && [ "$STORED_COMMENTS" != "null" ]; then
  COMMENT_DELTA=$(($CURRENT_COMMENTS - $STORED_COMMENTS))
else
  COMMENT_DELTA=0  # No baseline — skip comment drift
fi
```

**GSD milestone consistency check (maps-to links):**

Read all maps-to links from .mgw/cross-refs.json:

```bash
MAPS_TO_LINKS=$(python3 -c "
import json
with open('.mgw/cross-refs.json') as f:
    data = json.load(f)
links = data.get('links', [])
maps_to = [l for l in links if l.get('type') == 'maps-to']
print(json.dumps(maps_to))
")
```

For each maps-to link (format: { "a": "milestone:N", "b": "gsd-milestone:id", "type": "maps-to" }):
1. Extract the GitHub milestone number from "a" (parse "milestone:N")
2. Extract the GSD milestone ID from "b" (parse "gsd-milestone:id")
3. Check if this GSD milestone ID appears in either:
   - .planning/ROADMAP.md header (active milestone)
   - .planning/MILESTONES.md (archived milestones)
4. If found in neither: flag as inconsistent

```bash
# Check each maps-to link
echo "$MAPS_TO_LINKS" | python3 -c "
import json, sys, os

links = json.load(sys.stdin)
inconsistent = []

for link in links:
    a = link.get('a', '')
    b = link.get('b', '')

    if not a.startswith('milestone:') or not b.startswith('gsd-milestone:'):
        continue

    github_num = a.split(':')[1]
    gsd_id = b.split(':', 1)[1]

    found = False

    # Check ROADMAP.md
    if os.path.exists('.planning/ROADMAP.md'):
        with open('.planning/ROADMAP.md') as f:
            content = f.read()
        if gsd_id in content:
            found = True

    # Check MILESTONES.md
    if not found and os.path.exists('.planning/MILESTONES.md'):
        with open('.planning/MILESTONES.md') as f:
            content = f.read()
        if gsd_id in content:
            found = True

    if not found:
        inconsistent.append({'github_milestone': github_num, 'gsd_id': gsd_id})

for i in inconsistent:
    print(f\"WARN: GitHub milestone #{i['github_milestone']} maps to GSD milestone '{i['gsd_id']}' which was not found in .planning/\")

if not inconsistent:
    print('GSD milestone links: all consistent')
"
```

Classify each issue into:
- **Completed:** Issue closed AND (PR merged OR no PR expected)
- **Stale:** PR merged but issue still open (auto-close missed)
- **Orphaned:** Branch deleted but work incomplete
- **Active:** Still in progress, everything consistent
- **Drift:** State file says one thing, GitHub says another
- **Unreviewed comments:** COMMENT_DELTA > 0 — new comments posted since triage that haven't been classified
</step>

<step name="health_check">
**GSD health check (if .planning/ exists):**

For repos with GSD initialized, run a health check and include in the sync report:
```bash
if [ -d ".planning" ]; then
  HEALTH=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs validate health 2>/dev/null || echo '{"status":"unknown"}')
fi
```
This is read-only and additive — health status is included in the sync summary but does not block any reconciliation actions.
</step>

<step name="reconcile">
**Take action per classification:**

| Classification | Action |
|---------------|--------|
| Completed | Move state file to .mgw/completed/, clean up branch + worktree |
| Stale | Report: "Issue #N still open but PR #M merged — close issue?" |
| Orphaned | Report: "Branch deleted for #N but issue still open" |
| Active | No action, include in summary |
| Drift | Report specific mismatch, offer to update state |

**Branch cleanup for completed items:**

For each completed issue with linked branches:
```bash
# Remove any lingering worktree first
WORKTREE_DIR=".worktrees/${BRANCH_NAME}"
if [ -d "${WORKTREE_DIR}" ]; then
  git worktree remove "${WORKTREE_DIR}" 2>/dev/null
fi

# Clean up empty worktree parent dirs
rmdir .worktrees/issue 2>/dev/null
rmdir .worktrees 2>/dev/null
```

Ask user before deleting branches:
```
AskUserQuestion(
  header: "Branch Cleanup",
  question: "Delete merged branches for completed issues?",
  options: [
    { label: "Delete all", description: "Remove local + remote branches for all completed issues" },
    { label: "Local only", description: "Remove local branches, keep remote" },
    { label: "Skip", description: "Keep all branches" }
  ]
)
```

If user approves:
```bash
# Delete local branch
git branch -d ${BRANCH_NAME} 2>/dev/null

# Delete remote branch (if user chose "Delete all")
git push origin --delete ${BRANCH_NAME} 2>/dev/null
```
</step>

<step name="report">
**Present sync summary:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► SYNC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Active:    ${active_count} issues in progress
Pulled:    ${BOARD_PULL_CREATED} reconstructed from board  (0 if board not configured)
Completed: ${completed_count} archived
Stale:     ${stale_count} need attention
Orphaned:  ${orphaned_count} need attention
Comments:  ${comment_drift_count} issues with unreviewed comments
Branches:  ${deleted_count} cleaned up
${BOARD_DISCOVERED ? 'Board:     discovered + registered ' + BOARD_DISCOVERED : ''}
${HEALTH ? 'GSD Health: ' + HEALTH.status : ''}

${details_for_each_non_active_item}
${comment_drift_details ? 'Unreviewed comments:\n' + comment_drift_details : ''}
${gsd_milestone_consistency ? 'GSD Milestone Links:\n' + gsd_milestone_consistency : ''}

```
</step>

</process>

<success_criteria>
- [ ] pull_board_state runs before scan_active
- [ ] Board discovery: if project_board.node_id empty, findExistingBoard() + getProjectFields() called; if found, registered in project.json
- [ ] Board pull: all board items fetched in one GraphQL call; issues with no local .mgw/active/ file are reconstructed from GitHub issue data + board Status
- [ ] Reconstructed files have reconstructed_from_board:true, pipeline_stage from board Status, gsd_route from board GSD Route field
- [ ] "Done" board items are skipped (not written to active/)
- [ ] Stage drift detected and reported: local pipeline_stage differs from board Status
- [ ] Drift resolution offered: pull from board / keep local / skip
- [ ] Board pull errors (failed gh issue view calls) are collected and shown in report, never abort sync
- [ ] BOARD_PULL_CREATED count shown in sync report
- [ ] All .mgw/active/ files scanned (including any reconstructed by pull_board_state)
- [ ] GitHub state checked for each issue, PR, branch
- [ ] Comment delta checked for each active issue
- [ ] GSD milestone consistency checked for all maps-to links
- [ ] Completed items moved to .mgw/completed/
- [ ] Lingering worktrees cleaned up for completed items
- [ ] Branch deletion offered for completed items
- [ ] Stale/orphaned/drift items flagged (including comment drift and milestone inconsistencies)
- [ ] Summary presented
</success_criteria>
