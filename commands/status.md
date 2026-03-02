---
name: mgw:status
description: Project status dashboard — milestone progress, issue pipeline stages, open PRs
argument-hint: "[milestone_number] [--json] [--board] [--watch [--interval N]]"
allowed-tools:
  - Bash
  - Read
---

<objective>
Display a structured project status dashboard showing milestone progress, per-issue
pipeline stages, open PRs, and next milestone preview. Pure read-only — no state
mutations, no agent spawns, no GitHub writes.

Falls back gracefully when no project.json exists (lists active issues only via GitHub API).

When `--watch` is passed, enters live-refresh mode: clears the terminal and redraws the
dashboard every N seconds (default 30). Displays a "Last refreshed" timestamp and a
countdown to next refresh. User exits by pressing 'q' or Ctrl+C.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
</execution_context>

<context>
$ARGUMENTS

Repo detected via: gh repo view --json nameWithOwner -q .nameWithOwner
</context>

<process>

<step name="parse_arguments">
**Parse $ARGUMENTS for milestone number and flags:**

```bash
MILESTONE_NUM=""
JSON_OUTPUT=false
OPEN_BOARD=false
WATCH_MODE=false
WATCH_INTERVAL=30
NEXT_IS_INTERVAL=false

for ARG in $ARGUMENTS; do
  if [ "$NEXT_IS_INTERVAL" = true ]; then
    WATCH_INTERVAL="$ARG"
    NEXT_IS_INTERVAL=false
    continue
  fi
  case "$ARG" in
    --json) JSON_OUTPUT=true ;;
    --board) OPEN_BOARD=true ;;
    --watch) WATCH_MODE=true ;;
    --interval) NEXT_IS_INTERVAL=true ;;
    [0-9]*) MILESTONE_NUM="$ARG" ;;
  esac
done
```
</step>

<step name="detect_project">
**Check if project.json exists:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
MGW_DIR="${REPO_ROOT}/.mgw"
REPO_NAME=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || basename "$REPO_ROOT")

BOARD_URL=""
if [ ! -f "${MGW_DIR}/project.json" ]; then
  # No project.json — fall back to GitHub-only mode
  FALLBACK_MODE=true
else
  FALLBACK_MODE=false
fi
```
</step>

<step name="fallback_github_only">
**If no project.json — display GitHub-only status:**

When `FALLBACK_MODE=true`, skip all project.json logic and show active issues from GitHub:

```bash
if [ "$FALLBACK_MODE" = true ]; then
  OPEN_ISSUES=$(gh issue list --state open --limit 50 --json number,title,labels,assignees,state,createdAt)
  OPEN_PRS=$(gh pr list --state open --limit 20 --json number,title,headRefName,isDraft,reviewDecision,url)
fi
```

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW > PROJECT STATUS: ${REPO_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

No project.json found. Showing GitHub state only.

Open Issues (${issue_count}):
  #N  title                                    [labels]
  #M  title                                    [labels]

Open PRs (${pr_count}):
  #P  title                                    (draft|review requested|approved)

Run /mgw:project to initialize project tracking.
```

If `--json` flag: output as JSON with `{ "mode": "github-only", "issues": [...], "prs": [...] }`

Exit after display.
</step>

<step name="load_project">
**Load project.json and milestone data:**

```bash
PROJECT_JSON=$(cat "${MGW_DIR}/project.json")

# Resolve active milestone index (0-based) via state resolution (supports both schema versions)
ACTIVE_IDX=$(node -e "
const { loadProjectState, resolveActiveMilestoneIndex } = require('./lib/state.cjs');
const state = loadProjectState();
const idx = resolveActiveMilestoneIndex(state);
const milestone = state.milestones ? state.milestones[idx] : null;
const gsdId = state.active_gsd_milestone || ('legacy:' + state.current_milestone);
console.log(JSON.stringify({ idx, gsd_id: gsdId, name: milestone ? milestone.name : 'unknown' }));
")
CURRENT_MILESTONE_IDX=$(echo "$ACTIVE_IDX" | python3 -c "import json,sys; print(json.load(sys.stdin)['idx'])")
# Convert 0-based index to 1-indexed milestone number for display and compatibility
CURRENT_MILESTONE=$((CURRENT_MILESTONE_IDX + 1))
TOTAL_MILESTONES=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['milestones']))")

# Use specified milestone or current
TARGET_MILESTONE=${MILESTONE_NUM:-$CURRENT_MILESTONE}

# Load target milestone data
MILESTONE_DATA=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
idx = ${TARGET_MILESTONE} - 1
if idx < 0 or idx >= len(p['milestones']):
    print(json.dumps({'error': 'Milestone ${TARGET_MILESTONE} not found'}))
    sys.exit(1)
m = p['milestones'][idx]
print(json.dumps(m))
")

MILESTONE_NAME=$(echo "$MILESTONE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])")
ISSUES_JSON=$(echo "$MILESTONE_DATA" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['issues']))")
TOTAL_ISSUES=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")

# Extract board URL from project.json (top-level board_url or nested board.url)
BOARD_URL=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
# Check top-level board_url first, then board.url (nested)
url = p.get('board_url') or (p.get('board') or {}).get('url', '')
print(url or '')
" 2>/dev/null || echo "")
```
</step>

<step name="open_board">
**Handle --board flag — open board in browser and exit early:**

```bash
if [ "$OPEN_BOARD" = true ]; then
  if [ -z "$BOARD_URL" ]; then
    echo "No board configured in project.json. Run /mgw:board create first." >&2
    exit 1
  fi
  echo "Opening board: ${BOARD_URL}"
  xdg-open "${BOARD_URL}" 2>/dev/null \
    || open "${BOARD_URL}" 2>/dev/null \
    || echo "Could not open browser. Board URL: ${BOARD_URL}"
  exit 0
fi
```

This step exits early — do not continue to the dashboard display.
</step>

<step name="compute_progress">
**Compute pipeline stage counts and progress:**

```bash
STAGE_COUNTS=$(echo "$ISSUES_JSON" | python3 -c "
import json, sys
issues = json.load(sys.stdin)

counts = {'done': 0, 'executing': 0, 'new': 0, 'blocked': 0, 'failed': 0, 'other': 0}
stage_map = {
    'done': 'done',
    'pr-created': 'done',
    'new': 'new',
    'triaged': 'executing',
    'planning': 'executing',
    'executing': 'executing',
    'verifying': 'executing',
    'failed': 'failed',
    'blocked': 'blocked'
}

for issue in issues:
    stage = issue.get('pipeline_stage', 'new')
    category = stage_map.get(stage, 'other')
    counts[category] += 1

total = len(issues)
done = counts['done']
pct = int((done / total) * 100) if total > 0 else 0

# Build progress bar (16 chars wide)
filled = int(pct / 100 * 16)
bar = chr(9608) * filled + chr(9617) * (16 - filled)

print(json.dumps({
    'counts': counts,
    'total': total,
    'done': done,
    'pct': pct,
    'bar': bar
}))
")
```
</step>

<step name="compute_health">
**Compute milestone health metrics — velocity, done count, blocked count:**

```bash
HEALTH_DATA=$(echo "$ISSUES_JSON" | python3 -c "
import json, sys, os, glob

issues = json.load(sys.stdin)
repo_root = os.environ.get('REPO_ROOT', os.getcwd())
mgw_dir = os.path.join(repo_root, '.mgw')

done_stages = {'done', 'pr-created'}
blocked_stages = {'blocked'}

done_count = 0
blocked_count = 0
done_timestamps = []

for issue in issues:
    stage = issue.get('pipeline_stage', 'new')
    num = issue.get('github_number', 0)

    if stage in done_stages:
        done_count += 1
        # Use .mgw/active/ or .mgw/completed/ file mtime as done timestamp proxy
        for subdir in ['active', 'completed']:
            pattern = os.path.join(mgw_dir, subdir, str(num) + '-*.json')
            matches = glob.glob(pattern)
            if matches:
                try:
                    done_timestamps.append(os.path.getmtime(matches[0]))
                except Exception:
                    pass
                break
    elif stage in blocked_stages:
        blocked_count += 1

# Compute velocity (issues completed per day)
if done_count == 0:
    velocity_str = '0/day'
elif len(done_timestamps) >= 2:
    span_days = (max(done_timestamps) - min(done_timestamps)) / 86400.0
    if span_days >= 0.1:
        velocity_str = '{:.1f}/day'.format(done_count / span_days)
    else:
        velocity_str = str(done_count) + ' (same day)'
elif done_count == 1:
    velocity_str = '1 (single)'
else:
    velocity_str = str(done_count) + '/day'

import json as json2
print(json2.dumps({
    'done_count': done_count,
    'blocked_count': blocked_count,
    'velocity': velocity_str
}))
")

HEALTH_DONE=$(echo "$HEALTH_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['done_count'])" 2>/dev/null || echo "0")
HEALTH_BLOCKED=$(echo "$HEALTH_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['blocked_count'])" 2>/dev/null || echo "0")
HEALTH_VELOCITY=$(echo "$HEALTH_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['velocity'])" 2>/dev/null || echo "N/A")
```
</step>

<step name="build_issue_table">
**Build per-issue status lines:**

```bash
ISSUE_LINES=$(echo "$ISSUES_JSON" | python3 -c "
import json, sys
issues = json.load(sys.stdin)

stage_icons = {
    'done': ('done', chr(9989)),
    'pr-created': ('done', chr(9989)),
    'new': ('new', chr(9203)),
    'triaged': ('executing', chr(128260)),
    'planning': ('executing', chr(128260)),
    'executing': ('executing', chr(128260)),
    'verifying': ('executing', chr(128260)),
    'failed': ('failed', chr(10060)),
    'blocked': ('blocked', chr(128274))
}

lines = []
for issue in issues:
    num = issue['github_number']
    title = issue['title'][:50]
    stage = issue.get('pipeline_stage', 'new')
    label, icon = stage_icons.get(stage, ('other', '?'))
    lines.append({
        'number': num,
        'title': title,
        'stage': stage,
        'label': label,
        'icon': icon
    })

print(json.dumps(lines))
")
```
</step>

<step name="fetch_open_prs">
**Fetch open PRs from GitHub:**

```bash
OPEN_PRS=$(gh pr list --state open --limit 20 --json number,title,headRefName,isDraft,reviewDecision,url 2>/dev/null || echo "[]")
```

Match PRs to milestone issues by branch name pattern (`issue/N-*`) or PR body (`Closes #N`).
</step>

<step name="load_next_milestone">
**Load next milestone preview (if exists):**

```bash
NEXT_MILESTONE=""
if [ "$TARGET_MILESTONE" -lt "$TOTAL_MILESTONES" ]; then
  NEXT_IDX=$((TARGET_MILESTONE))
  NEXT_MILESTONE=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
m = p['milestones'][${NEXT_IDX}]
total = len(m['issues'])
done = sum(1 for i in m['issues'] if i.get('pipeline_stage') in ('done', 'pr-created'))
print(json.dumps({'name': m['name'], 'total': total, 'done': done}))
")
fi
```
</step>

<step name="display_dashboard">
**Display the status dashboard:**

```bash
# Print board URL prominently at top if configured
if [ -n "$BOARD_URL" ]; then
  echo " Board: ${BOARD_URL}"
fi
```

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW > PROJECT STATUS: ${REPO_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Current Milestone: ${MILESTONE_NAME} (${done}/${total} done)
Progress: ${bar} ${pct}%

  #35  ✅ done       refactor: remove .planning/ writes
  #36  🔄 executing   comment-aware pipeline
  #37  ⏳ new         /mgw:status dashboard
  #38  🔒 blocked     contextual routing (blocked by #37)

Milestone Health:
  Completed: ${HEALTH_DONE}/${TOTAL_ISSUES}
  Velocity:  ${HEALTH_VELOCITY}
  Blocked:   ${HEALTH_BLOCKED}

Open PRs:
  #40  ← #36  comment-aware pipeline (review requested)

Next Milestone: ${next_name} (${next_done}/${next_total} done)
```

Full display example with board configured:
```
 Board: https://github.com/orgs/snipcodeit/projects/1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW > PROJECT STATUS: snipcodeit/mgw
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Current Milestone: v2 — Team Collaboration (3/6 done)
Progress: ████████░░░░░░░░ 50%

  #80  ✅ done       Add mgw:assign command
  #81  ✅ done       Post board link to Discussions
  #82  ✅ done       Add mgw:board sync
  #83  🔄 executing   Add milestone health report
  #84  ⏳ new         Create mgw:roadmap command
  #85  ⏳ new         Add growth analytics

Milestone Health:
  Completed: 3/6
  Velocity:  2.1/day
  Blocked:   0

Open PRs:
  (none matched to this milestone)

Next Milestone: v3 — Analytics & Extensions (0/5 done)
```

Rendering rules:
- Print board URL line (` Board: ${BOARD_URL}`) only when BOARD_URL is non-empty
- Use stage icons from the issue table
- Right-align issue numbers
- Truncate titles to 50 chars
- Milestone Health section always appears in project mode (after issue table, before Open PRs)
- If no open PRs matched to milestone, show "No open PRs for this milestone."
- If no next milestone, show "No more milestones planned."
- If `TARGET_MILESTONE != CURRENT_MILESTONE`, add "(viewing milestone ${TARGET_MILESTONE})" to header
- In watch mode, append the footer: `[ Refreshing every ${WATCH_INTERVAL}s — next in Xs | press q to quit ]`
</step>

<step name="watch_mode">
**If --watch flag: enter live-refresh loop:**

`--watch` is incompatible with `--json`. If both are passed, print an error and exit 1.

The watch loop is implemented as a Node.js one-shot script executed via `node -e` (or saved
to a temp file). It wraps the full dashboard render cycle with `setInterval`, clears the
terminal before each redraw, and uses `process.stdin.setRawMode(true)` to detect a 'q'
keypress for clean exit.

```javascript
// watch-mode runner (pseudocode — shows the pattern)
const { execSync } = require('child_process');
const INTERVAL = parseInt(process.env.WATCH_INTERVAL || '30', 10) * 1000;
const REPO_ROOT = process.env.REPO_ROOT;

function renderDashboard() {
  // Re-run all data collection and dashboard build steps synchronously
  // (same logic as the non-watch single-shot path above, but called in a loop)
  const output = buildDashboardOutput();  // all the python/gh calls assembled into a string
  const now = new Date().toLocaleTimeString();
  process.stdout.write('\x1B[2J\x1B[H');  // clear terminal, cursor home
  process.stdout.write(output);
  process.stdout.write(`\n[ Refreshing every ${INTERVAL / 1000}s — last refreshed ${now} | press q to quit ]\n`);
}

// Initial render
renderDashboard();

// Poll on interval
const timer = setInterval(renderDashboard, INTERVAL);

// Detect 'q' to exit
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === 'q' || key === '\u0003') {  // 'q' or Ctrl+C
      clearInterval(timer);
      process.stdin.setRawMode(false);
      process.stdout.write('\nWatch mode exited.\n');
      process.exit(0);
    }
  });
}
```

Implementation notes for the executor:
- The watch runner re-executes the full data fetch on each interval tick (re-reads
  project.json, re-calls `gh pr list`, etc.) so the display reflects live GitHub state.
- `process.stdout.write('\x1B[2J\x1B[H')` clears the screen without spawning `clear`.
- The footer line replaces "next in Xs" with a live countdown: update it on each second
  using a secondary `setInterval` (1000ms) that only updates the footer line, not the
  full dashboard. Alternatively, show only "last refreshed HH:MM:SS" without a countdown
  if a countdown adds excessive complexity.
- SIGINT (Ctrl+C) should also trigger clean exit — the `'\u0003'` check above handles it,
  but also register `process.on('SIGINT', ...)` as a fallback when `setRawMode` is false
  (non-TTY or piped stdin).
- `--watch` is silently ignored when `--json` is also present; `--json` takes precedence
  and produces single-shot JSON output (no loop).

Watch mode is not available in `--json` mode. If both flags are supplied, emit:
```
Error: --watch and --json are mutually exclusive.
```
and exit 1.
</step>

<step name="json_output">
**If --json flag: output machine-readable JSON instead:**

```bash
if [ "$JSON_OUTPUT" = true ]; then
  # Build structured JSON output
  OUTPUT=$(python3 -c "
import json

result = {
    'repo': '${REPO_NAME}',
    'board_url': '${BOARD_URL}',
    'current_milestone': ${CURRENT_MILESTONE},  # 1-indexed (legacy compat)
    'active_milestone_idx': ${CURRENT_MILESTONE_IDX},  # 0-based resolved index
    'viewing_milestone': ${TARGET_MILESTONE},
    'milestone': {
        'name': '${MILESTONE_NAME}',
        'total_issues': ${TOTAL_ISSUES},
        'done': done_count,
        'progress_pct': pct,
        'health': {
            'done': int('${HEALTH_DONE}' or '0'),
            'total': ${TOTAL_ISSUES},
            'blocked': int('${HEALTH_BLOCKED}' or '0'),
            'velocity': '${HEALTH_VELOCITY}'
        },
        'issues': issues_with_stages
    },
    'open_prs': matched_prs,
    'next_milestone': next_milestone_data
}
print(json.dumps(result, indent=2))
")
  echo "$OUTPUT"
  # Exit — do not display the formatted dashboard
fi
```

The JSON structure:
```json
{
  "repo": "owner/repo",
  "board_url": "https://github.com/orgs/snipcodeit/projects/1",
  "current_milestone": 2,
  "active_milestone_idx": 1,
  "viewing_milestone": 2,
  "milestone": {
    "name": "v2 — Team Collaboration & Lifecycle Orchestration",
    "total_issues": 6,
    "done": 3,
    "progress_pct": 50,
    "health": {
      "done": 3,
      "total": 6,
      "blocked": 0,
      "velocity": "2.1/day"
    },
    "issues": [
      {
        "number": 80,
        "title": "Add mgw:assign command",
        "pipeline_stage": "done",
        "labels": ["enhancement"]
      }
    ]
  },
  "open_prs": [
    {
      "number": 95,
      "title": "Add mgw:assign command",
      "linked_issue": 80,
      "review_status": "approved"
    }
  ],
  "next_milestone": {
    "name": "v3 — Analytics & Extensions",
    "total_issues": 5,
    "done": 0
  }
}
```
</step>

</process>

<success_criteria>
- [ ] project.json loaded and target milestone identified
- [ ] Graceful fallback when project.json missing (GitHub-only mode)
- [ ] Progress bar rendered with correct percentage
- [ ] Per-issue status shown with pipeline stage icons
- [ ] Open PRs fetched and matched to milestone issues
- [ ] Next milestone preview displayed (if exists)
- [ ] --json flag outputs machine-readable JSON
- [ ] Milestone number argument selects non-current milestone
- [ ] Read-only: no state modifications, no GitHub writes
- [ ] No agent spawns, no side effects
- [ ] Board URL displayed before header when board_url is set in project.json
- [ ] --board flag opens board URL via xdg-open (open on macOS fallback) and exits 0
- [ ] --board flag exits 1 with helpful error when no board configured
- [ ] Milestone Health section shows Completed N/total, Velocity, and Blocked count
- [ ] Velocity computed from .mgw/active/ and .mgw/completed/ file mtimes
- [ ] --json output includes board_url and milestone.health object
- [ ] Board URL line omitted when board_url is not set in project.json
- [ ] --watch flag enters live-refresh loop, refreshing every N seconds (default 30)
- [ ] --interval N overrides the default 30s refresh interval
- [ ] Watch mode clears terminal before each redraw
- [ ] Watch mode footer shows last refresh time
- [ ] 'q' keypress exits watch mode cleanly (stdin raw mode)
- [ ] Ctrl+C (SIGINT) exits watch mode cleanly
- [ ] --watch and --json are mutually exclusive — error + exit 1 if both supplied
- [ ] Watch mode re-fetches all data on each tick (live GitHub state)
</success_criteria>
