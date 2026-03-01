<purpose>
Shared state management for MGW commands. Handles .mgw/ directory initialization,
issue state read/write, cross-ref management, and staleness detection against GitHub.
Every command that touches .mgw/ state references this file.
</purpose>

## Directory Structure

`.mgw/` lives at repo root, is gitignored, and is local-only per developer.

```
.mgw/
  config.json        # User prefs (github username, default filters)
  active/            # In-progress issue pipelines
    <number>-<slug>.json
  completed/         # Archived after PR merged/issue closed
  cross-refs.json    # Bidirectional issue/PR/branch links
```

## validate_and_load

Single entry point for state initialization. Every command that touches .mgw/ calls
this pattern at startup. It ensures directory structure, gitignore entries, cross-refs,
and runs a lightweight staleness check.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
MGW_DIR="${REPO_ROOT}/.mgw"

# 1. Ensure directory structure
mkdir -p "${MGW_DIR}/active" "${MGW_DIR}/completed"

# 2. Ensure gitignore entries
for ENTRY in ".mgw/" ".worktrees/"; do
  if ! grep -q "^\\${ENTRY}\$" "${REPO_ROOT}/.gitignore" 2>/dev/null; then
    echo "${ENTRY}" >> "${REPO_ROOT}/.gitignore"
  fi
done

# 3. Initialize cross-refs if missing
if [ ! -f "${MGW_DIR}/cross-refs.json" ]; then
  echo '{"links":[]}' > "${MGW_DIR}/cross-refs.json"
fi

# 4. Run staleness check (see Staleness Detection below)
# Only if active issues exist — skip for commands that don't need it (e.g., init, help)
if ls "${MGW_DIR}/active/"*.json 1>/dev/null 2>&1; then
  check_staleness "${MGW_DIR}"
fi
```

## Staleness Detection

Lightweight check comparing GitHub `updatedAt` timestamps with local state file
modification times. Runs on every MGW command that touches state. Non-blocking:
if the check fails (network error, API limit), log a warning and continue.

### Per-Issue Check
For commands that operate on a specific issue:

```bash
# Non-blocking: if check fails, continue with warning
check_issue_staleness() {
  local ISSUE_NUMBER="$1"
  local STATE_FILE="$2"

  # Get GitHub's last update timestamp
  GH_UPDATED=$(gh issue view "$ISSUE_NUMBER" --json updatedAt -q .updatedAt 2>/dev/null)
  if [ -z "$GH_UPDATED" ]; then
    return 0  # Can't check — don't block
  fi

  # Compare with local state file modification time
  LOCAL_MTIME=$(stat -c %Y "$STATE_FILE" 2>/dev/null || echo "0")
  GH_EPOCH=$(date -d "$GH_UPDATED" +%s 2>/dev/null || echo "0")

  if [ "$GH_EPOCH" -gt "$LOCAL_MTIME" ]; then
    echo "MGW: Stale state detected for #${ISSUE_NUMBER} — auto-syncing..."
    # Re-fetch issue data and update local state
    FRESH_DATA=$(gh issue view "$ISSUE_NUMBER" --json number,title,body,labels,assignees,state,comments,url,milestone 2>/dev/null)
    if [ -n "$FRESH_DATA" ]; then
      # Update the issue section of the state file (preserve pipeline_stage, triage, etc.)
      # Implementation: read state JSON, update .issue fields, write back
      touch "$STATE_FILE"  # Update mtime to prevent re-triggering
    fi
    return 1  # Stale — caller can react
  fi
  return 0  # Fresh
}
```

### Batch Check (Milestone-Level)
For commands that check across all active issues in a single API call:

```bash
# Single GraphQL call for all open issues — use for milestone operations
check_batch_staleness() {
  local MGW_DIR="$1"

  OWNER=$(gh repo view --json owner -q .owner.login 2>/dev/null)
  REPO=$(gh repo view --json name -q .name 2>/dev/null)

  if [ -z "$OWNER" ] || [ -z "$REPO" ]; then
    return 0  # Can't check — don't block
  fi

  ISSUES_JSON=$(gh api graphql -f query='
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        issues(first: 50, states: OPEN) {
          nodes { number updatedAt }
        }
      }
    }
  ' -f owner="$OWNER" -f repo="$REPO" --jq '.data.repository.issues.nodes' 2>/dev/null)

  if [ -z "$ISSUES_JSON" ]; then
    return 0  # Can't check — don't block
  fi

  # Compare each issue's updatedAt with local state file mtime
  # Flag any stale issues for sync
  echo "$ISSUES_JSON"
}
```

### Staleness Behavior
- When stale state is detected: **auto-sync with notice** — sync automatically, print one line telling the user it happened, do not block
- When the check fails (network, API limit, error): **continue silently** — never let staleness detection prevent command execution
- Scope: covers **both milestone-level and issue-level state**

## Comment Tracking

Comment tracking detects new comments posted on an issue between triage and execution.
The `triage.last_comment_count` and `triage.last_comment_at` fields are populated during
triage (issue.md) and checked before GSD execution begins (run.md).

### Comment Tracking Fields

| Field | Type | Set By | Description |
|-------|------|--------|-------------|
| `triage.last_comment_count` | number | issue.md | Total comment count at triage time |
| `triage.last_comment_at` | string\|null | issue.md | ISO timestamp of most recent comment at triage time |

### Pre-Flight Comment Check

Before GSD execution starts, run.md compares current comment count against the stored
count. If new comments are detected, they are classified before proceeding:

```bash
# Fetch current comment state from GitHub
CURRENT_COMMENTS=$(gh issue view $ISSUE_NUMBER --json comments --jq '.comments | length')
STORED_COMMENTS="${triage.last_comment_count}"

if [ "$CURRENT_COMMENTS" -gt "$STORED_COMMENTS" ]; then
  # New comments detected — fetch and classify
  NEW_COMMENT_BODIES=$(gh issue view $ISSUE_NUMBER --json comments \
    --jq "[.comments[-$(($CURRENT_COMMENTS - $STORED_COMMENTS)):]] | .[].body")
fi
```

### Comment Classification

New comments are classified by a general-purpose agent into one of three categories:

| Classification | Meaning | Pipeline Action |
|---------------|---------|-----------------|
| **material** | Changes scope, requirements, or acceptance criteria | Flag for re-triage — update state, re-run triage analysis |
| **informational** | Status update, +1, question, acknowledgment | Log and continue — no pipeline impact |
| **blocking** | Explicit "don't work on this yet", "hold", "wait" | Pause pipeline — set pipeline_stage to "blocked" |

The classification agent receives the new comment bodies and the issue context, and returns
a JSON result:

```json
{
  "classification": "material|informational|blocking",
  "reasoning": "Brief explanation",
  "new_requirements": ["list of new requirements if material"],
  "blocking_reason": "reason if blocking"
}
```

### Comment Delta in Drift Detection

sync.md includes comment delta as a drift signal. If the current comment count differs
from `triage.last_comment_count`, the issue is flagged as having unreviewed comments
in the sync report.

## Issue State Schema

File: `.mgw/active/<number>-<slug>.json`

```json
{
  "issue": {
    "number": 42,
    "title": "Short title",
    "url": "https://github.com/owner/repo/issues/42",
    "labels": ["bug"],
    "assignee": "username"
  },
  "triage": {
    "scope": { "files": 0, "systems": [] },
    "validity": "pending|confirmed|invalid",
    "security_notes": "",
    "conflicts": [],
    "last_comment_count": 0,
    "last_comment_at": null,
    "gate_result": {
      "status": "passed|blocked",
      "blockers": [],
      "warnings": [],
      "missing_fields": []
    }
  },
  "gsd_route": null,
  "gsd_artifacts": { "type": null, "path": null },
  "pipeline_stage": "new|triaged|needs-info|needs-security-review|discussing|approved|planning|executing|verifying|pr-created|done|failed|blocked",
  "comments_posted": [],
  "linked_pr": null,
  "linked_issues": [],
  "linked_branches": []
}
```

## Stage Flow Diagram

```
new --> triaged         (triage passes all gates)
new --> needs-info      (validity=invalid OR insufficient detail)
new --> needs-security-review  (security=high)

needs-info --> triaged  (re-triage after info provided)
needs-security-review --> triaged  (re-triage after security ack)

triaged --> discussing  (new-milestone route, large scope)
triaged --> approved    (discussion complete, ready for execution)
triaged --> planning    (direct route, skip discussion)

discussing --> approved (stakeholder approval)
approved --> planning

planning --> executing
executing --> verifying
verifying --> pr-created
pr-created --> done

Any stage --> blocked   (blocking comment detected)
blocked --> triaged     (re-triage after blocker resolved)
Any stage --> failed    (unrecoverable error)
```

## Slug Generation

Use gsd-tools for consistent slug generation:
```bash
SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${issue_title}" --raw)
SLUG="${SLUG:0:40}"  # gsd-tools doesn't truncate; MGW enforces 40-char limit
```

## Timestamps

Use gsd-tools for ISO timestamp generation:
```bash
TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw)
```

## Cross-Refs Schema

File: `.mgw/cross-refs.json`

```json
{
  "links": [
    { "a": "issue:42", "b": "issue:43", "type": "related", "created": "2026-02-24T10:00:00Z" },
    { "a": "issue:42", "b": "pr:15", "type": "implements", "created": "2026-02-24T12:00:00Z" },
    { "a": "issue:42", "b": "branch:fix/auth-42", "type": "tracks", "created": "2026-02-24T10:00:00Z" }
  ]
}
```

### Link Types
| a | b | type |
|---|---|------|
| issue | issue | related |
| issue | pr | implements |
| issue | branch | tracks |
| pr | branch | tracks |

## Project State (project.json)

File: `.mgw/project.json` — Created by `/mgw:project`, read/updated by `/mgw:milestone` and `/mgw:next`.

### Read Project State
```bash
MGW_DIR="${REPO_ROOT}/.mgw"
PROJECT_JSON=$(cat "${MGW_DIR}/project.json" 2>/dev/null)
if [ -z "$PROJECT_JSON" ]; then
  echo "No project initialized. Run /mgw:project first."
  exit 1
fi

CURRENT_MILESTONE=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['current_milestone'])")
```

### Read Milestone Issues
```bash
MILESTONE_ISSUES=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
m = p['milestones'][p['current_milestone'] - 1]
print(json.dumps(m['issues'], indent=2))
")
```

### Update Issue Pipeline Stage
Used after each `/mgw:run` completion to checkpoint progress.
```bash
python3 -c "
import json
with open('${MGW_DIR}/project.json') as f:
    project = json.load(f)
milestone = project['milestones'][project['current_milestone'] - 1]
for issue in milestone['issues']:
    if issue['github_number'] == ${ISSUE_NUMBER}:
        issue['pipeline_stage'] = '${NEW_STAGE}'
        break
with open('${MGW_DIR}/project.json', 'w') as f:
    json.dump(project, f, indent=2)
"
```

Valid stages: `new`, `triaged`, `planning`, `executing`, `verifying`, `pr-created`, `done`, `failed`, `blocked`.

### Advance Current Milestone
Used after milestone completion to move pointer to next milestone.
```bash
python3 -c "
import json
with open('${MGW_DIR}/project.json') as f:
    project = json.load(f)
project['current_milestone'] += 1
with open('${MGW_DIR}/project.json', 'w') as f:
    json.dump(project, f, indent=2)
"
```

Only advance if ALL issues in current milestone completed successfully.

## Consumers

| Pattern | Referenced By |
|---------|-------------|
| validate_and_load | init.md, issue.md, run.md, update.md, link.md, pr.md, sync.md, milestone.md, ask.md |
| Per-issue staleness | run.md, issue.md, update.md |
| Batch staleness | sync.md (full reconciliation), milestone.md |
| Comment tracking | issue.md (populate), run.md (pre-flight check), sync.md (drift detection) |
| Issue state schema | issue.md, run.md, update.md, sync.md |
| Cross-refs schema | link.md, run.md, pr.md, sync.md |
| Slug generation | issue.md, run.md |
| Project state | milestone.md, next.md, ask.md |
| Gate result schema | issue.md (populate), run.md (validate) |
| Board status sync | board-sync.md (utility), issue.md (triage transitions), run.md (pipeline transitions) |
