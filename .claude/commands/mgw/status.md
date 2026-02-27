---
name: mgw:status
description: Project status dashboard — milestone progress, issue pipeline stages, open PRs
argument-hint: "[milestone_number] [--json]"
allowed-tools:
  - Bash
  - Read
---

<objective>
Display a structured project status dashboard showing milestone progress, per-issue
pipeline stages, open PRs, and next milestone preview. Pure read-only — no state
mutations, no agent spawns, no GitHub writes.

Falls back gracefully when no project.json exists (lists active issues only via GitHub API).
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

for ARG in $ARGUMENTS; do
  case "$ARG" in
    --json) JSON_OUTPUT=true ;;
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

# Get current milestone pointer
CURRENT_MILESTONE=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['current_milestone'])")
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
```
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

Open PRs:
  #40  ← #36  comment-aware pipeline (review requested)

Next Milestone: ${next_name} (${next_done}/${next_total} done)
```

Rendering rules:
- Use stage icons from the issue table
- Right-align issue numbers
- Truncate titles to 50 chars
- If no open PRs matched to milestone, show "No open PRs for this milestone."
- If no next milestone, show "No more milestones planned."
- If `TARGET_MILESTONE != CURRENT_MILESTONE`, add "(viewing milestone ${TARGET_MILESTONE})" to header
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
    'current_milestone': ${CURRENT_MILESTONE},
    'viewing_milestone': ${TARGET_MILESTONE},
    'milestone': {
        'name': '${MILESTONE_NAME}',
        'total_issues': ${TOTAL_ISSUES},
        'done': done_count,
        'progress_pct': pct,
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
  "current_milestone": 2,
  "viewing_milestone": 2,
  "milestone": {
    "name": "v1 — Pipeline Intelligence",
    "total_issues": 4,
    "done": 2,
    "progress_pct": 50,
    "issues": [
      {
        "number": 35,
        "title": "refactor: remove .planning/ writes",
        "pipeline_stage": "done",
        "labels": ["refactor"]
      }
    ]
  },
  "open_prs": [
    {
      "number": 40,
      "title": "comment-aware pipeline",
      "linked_issue": 36,
      "review_status": "review_requested"
    }
  ],
  "next_milestone": {
    "name": "v1 — NPM Publishing & Distribution",
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
</success_criteria>
