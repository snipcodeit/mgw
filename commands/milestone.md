---
name: mgw:milestone
description: Execute a milestone's issues in dependency order — auto-sync, rate-limit guard, per-issue checkpoint
argument-hint: "[milestone-number] [--interactive] [--dry-run]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Task
  - AskUserQuestion
---

<objective>
Orchestrate execution of all issues in a milestone by delegating each to `/mgw:run`
in dependency order. Sequential execution (one issue at a time), autonomous by default.

Handles: dependency resolution (topological sort), pre-sync against GitHub, rate limit
guard, per-issue checkpointing to project.json, failure cascading (skip failed, block
dependents, continue unblocked), resume detection, milestone close + draft release on
completion, and auto-advance to next milestone.

The `--interactive` flag pauses between issues for user confirmation.
The `--dry-run` flag shows the execution plan without running anything.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<context>
Milestone number: $ARGUMENTS (optional — defaults to current_milestone from project.json)
Flags: --interactive, --dry-run
</context>

<process>

<step name="parse_arguments">
**Parse $ARGUMENTS for milestone number and flags:**

```bash
MILESTONE_NUM=""
INTERACTIVE=false
DRY_RUN=false

for ARG in $ARGUMENTS; do
  case "$ARG" in
    --interactive) INTERACTIVE=true ;;
    --dry-run) DRY_RUN=true ;;
    [0-9]*) MILESTONE_NUM="$ARG" ;;
  esac
done
```

If no milestone number provided, read from project.json:
```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
MGW_DIR="${REPO_ROOT}/.mgw"

if [ -z "$MILESTONE_NUM" ]; then
  if [ ! -f "${MGW_DIR}/project.json" ]; then
    echo "No project initialized. Run /mgw:project first."
    exit 1
  fi
  # Resolve active milestone index (0-based) and convert to 1-indexed milestone number
  ACTIVE_IDX=$(node -e "
const { loadProjectState, resolveActiveMilestoneIndex } = require('./lib/state.cjs');
const state = loadProjectState();
console.log(resolveActiveMilestoneIndex(state));
")
  if [ "$ACTIVE_IDX" -lt 0 ]; then
    echo "No active milestone set. Run /mgw:project to initialize or set active_gsd_milestone."
    exit 1
  fi
  MILESTONE_NUM=$((ACTIVE_IDX + 1))
fi
```
</step>

<step name="validate_and_sync">
**Run validate_and_load then batch staleness check (MLST-03):**

Follow initialization procedure from @~/.claude/commands/mgw/workflows/state.md:
- Ensure .mgw/, active/, completed/ exist
- Ensure .gitignore entries
- Initialize cross-refs.json if missing

Run batch staleness check (non-blocking):
```bash
# Batch staleness check from state.md
# If check fails (network error, API limit), log warning and continue
check_batch_staleness "${MGW_DIR}" 2>/dev/null || echo "MGW: Staleness check skipped (network unavailable)"
```

This satisfies MLST-03: pre-sync before starting.
</step>

<step name="load_milestone">
**Load project.json and extract milestone data:**

```bash
PROJECT_JSON=$(cat "${MGW_DIR}/project.json")
MILESTONE_NAME=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
idx = ${MILESTONE_NUM} - 1
if idx < 0 or idx >= len(p['milestones']):
    print('ERROR: Milestone ${MILESTONE_NUM} not found')
    sys.exit(1)
m = p['milestones'][idx]
print(m['name'])
")

MILESTONE_GH_NUMBER=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
print(p['milestones'][${MILESTONE_NUM} - 1].get('github_number', ''))
")

ISSUES_JSON=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
m = p['milestones'][${MILESTONE_NUM} - 1]
print(json.dumps(m['issues']))
")

TOTAL_ISSUES=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
```

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► MILESTONE ${MILESTONE_NUM}: ${MILESTONE_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Issues: ${TOTAL_ISSUES}
Mode: ${INTERACTIVE ? "Interactive" : "Autonomous"}
```

Then print the initial milestone progress bar (0 done, TOTAL_ISSUES total):
```bash
ISSUES_WITH_STAGES=$(echo "$ISSUES_JSON" | python3 -c "
import json,sys
issues = json.load(sys.stdin)
result = [{'number': i['github_number'], 'pipeline_stage': i.get('pipeline_stage', 'new')} for i in issues]
print(json.dumps(result))
")

node -e "
const { printMilestoneProgress } = require('./lib/progress.cjs');
const issues = JSON.parse(process.env.ISSUES_WITH_STAGES || '[]');
const doneCount = issues.filter(i => i.pipeline_stage === 'done' || i.pipeline_stage === 'pr-created').length;
printMilestoneProgress({
  done: doneCount,
  total: issues.length,
  label: process.env.MILESTONE_NAME,
  issues
});
" MILESTONE_NAME="$MILESTONE_NAME" ISSUES_WITH_STAGES="$ISSUES_WITH_STAGES"
```
</step>

<step name="resolve_execution_order">
**Topological sort of issues by dependency (Kahn's algorithm):**

```bash
SORTED_ISSUES=$(echo "$ISSUES_JSON" | python3 -c "
import json, sys
from collections import defaultdict, deque

issues = json.load(sys.stdin)

# Build slug-to-issue mapping
slug_to_issue = {}
num_to_issue = {}
for issue in issues:
    title = issue.get('title', '')
    slug = title.lower().replace(' ', '-')[:40]
    slug_to_issue[slug] = issue
    num_to_issue[issue['github_number']] = issue

# Build adjacency list and in-degree map
in_degree = defaultdict(int)
graph = defaultdict(list)
all_slugs = set()

for issue in issues:
    title = issue.get('title', '')
    slug = title.lower().replace(' ', '-')[:40]
    all_slugs.add(slug)
    for dep_slug in issue.get('depends_on_slugs', []):
        if dep_slug in slug_to_issue:
            graph[dep_slug].append(slug)
            in_degree[slug] += 1

# Kahn's algorithm with phase_number tiebreak
queue = [s for s in all_slugs if in_degree[s] == 0]
order = []
while queue:
    # Stable sort: prefer lower phase_number
    current = min(queue, key=lambda s: slug_to_issue[s].get('phase_number', 999))
    queue.remove(current)
    order.append(current)
    for neighbor in graph[current]:
        in_degree[neighbor] -= 1
        if in_degree[neighbor] == 0:
            queue.append(neighbor)

# Cycle detection
if len(order) < len(all_slugs):
    cycled = [s for s in all_slugs if s not in order]
    print(json.dumps({'error': 'cycle', 'involved': cycled}))
    sys.exit(1)

# Output ordered issues
result = [slug_to_issue[s] for s in order]
print(json.dumps(result))
")
```

**If cycle detected:** Error with cycle details and refuse to proceed:
```
Circular dependency detected in milestone issues.
Involved: ${cycled_slugs}
Resolve the circular dependency in project.json or GitHub labels before running.
```

**Filter out completed issues:**
```bash
UNFINISHED=$(echo "$SORTED_ISSUES" | python3 -c "
import json,sys
issues = json.load(sys.stdin)
unfinished = [i for i in issues if i.get('pipeline_stage') not in ('done',)]
print(json.dumps(unfinished))
")

UNFINISHED_COUNT=$(echo "$UNFINISHED" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
DONE_COUNT=$((TOTAL_ISSUES - UNFINISHED_COUNT))
```

If all done:
```
All ${TOTAL_ISSUES} issues complete. Milestone already finished.
Run /mgw:sync to finalize.
```
</step>

<step name="rate_limit_guard">
**Check API rate limit before starting loop (MLST-04):**

```bash
# From github.md Rate Limit pattern
RATE_JSON=$(gh api rate_limit --jq '.resources.core' 2>/dev/null)

if [ -n "$RATE_JSON" ]; then
  REMAINING=$(echo "$RATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['remaining'])")
  RESET_EPOCH=$(echo "$RATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['reset'])")
  RESET_TIME=$(date -d "@${RESET_EPOCH}" '+%H:%M:%S' 2>/dev/null || echo "unknown")

  # Conservative: 25 calls per issue
  ESTIMATED_CALLS=$((UNFINISHED_COUNT * 25))
  SAFE_ISSUES=$((REMAINING / 25))

  if [ "$REMAINING" -lt "$ESTIMATED_CALLS" ]; then
    echo "Rate limit: ${REMAINING} calls remaining, need ~${ESTIMATED_CALLS} for ${UNFINISHED_COUNT} issues."
    echo "Can safely run ${SAFE_ISSUES} of ${UNFINISHED_COUNT} issues."
    echo "Limit resets at ${RESET_TIME}."
    # Cap loop at safe count
    MAX_ISSUES=$SAFE_ISSUES
  else
    MAX_ISSUES=$UNFINISHED_COUNT
  fi
else
  echo "MGW: Rate limit check unavailable — proceeding without cap"
  MAX_ISSUES=$UNFINISHED_COUNT
fi
```
</step>

<step name="post_start_hook">
**Post milestone-start announcement to GitHub Discussions (or first-issue comment fallback):**

Runs once before the execute loop. Skipped if --dry-run is set. Failure is non-blocking — a warning is logged and execution continues.

```bash
if [ "$DRY_RUN" = true ]; then
  echo "MGW: Skipping milestone-start announcement (dry-run mode)"
else
  # Gather board URL from project.json if present (non-blocking)
  BOARD_URL=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
m = p['milestones'][${MILESTONE_NUM} - 1]
print(m.get('board_url', ''))
" 2>/dev/null || echo "")

  # Build issues JSON array with assignee and gsd_route per issue
  ISSUES_PAYLOAD=$(echo "$ISSUES_JSON" | python3 -c "
import json,sys
issues = json.load(sys.stdin)
result = []
for i in issues:
    result.append({
        'number': i.get('github_number', 0),
        'title': i.get('title', '')[:60],
        'assignee': i.get('assignee') or None,
        'gsdRoute': i.get('gsd_route', 'plan-phase')
    })
print(json.dumps(result))
" 2>/dev/null || echo "[]")

  # Get first issue number for fallback comment (non-blocking)
  FIRST_ISSUE_NUM=$(echo "$ISSUES_JSON" | python3 -c "
import json,sys
issues = json.load(sys.stdin)
print(issues[0]['github_number'] if issues else '')
" 2>/dev/null || echo "")

  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")

  REPO="$REPO" \
  MILESTONE_NAME="$MILESTONE_NAME" \
  BOARD_URL="$BOARD_URL" \
  ISSUES_PAYLOAD="$ISSUES_PAYLOAD" \
  FIRST_ISSUE_NUM="$FIRST_ISSUE_NUM" \
  node -e "
const { postMilestoneStartAnnouncement } = require('./lib/index.cjs');
const result = postMilestoneStartAnnouncement({
  repo: process.env.REPO,
  milestoneName: process.env.MILESTONE_NAME,
  boardUrl: process.env.BOARD_URL || undefined,
  issues: JSON.parse(process.env.ISSUES_PAYLOAD || '[]'),
  firstIssueNumber: process.env.FIRST_ISSUE_NUM ? parseInt(process.env.FIRST_ISSUE_NUM) : undefined
});
if (result.posted) {
  const detail = result.url ? ': ' + result.url : '';
  console.log('MGW: Milestone-start announcement posted via ' + result.method + detail);
} else {
  console.log('MGW: Milestone-start announcement skipped (Discussions unavailable, no fallback)');
}
" 2>/dev/null || echo "MGW: Announcement step failed (non-blocking) — continuing"
fi
```
</step>

<step name="dry_run">
**If --dry-run flag: display execution plan and exit:**

```bash
if [ "$DRY_RUN" = true ]; then
  # Build execution plan table
  # Show: order, issue number, title, status, depends on, blocks
fi
```

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► DRY RUN — Milestone ${MILESTONE_NUM}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Order | Issue | Title | Status | Depends On | Blocks |
|-------|-------|-------|--------|------------|--------|
| 1 | #N | title | ○ Pending | — | #M, #K |
| 2 | #M | title | ○ Pending | #N | #K |
| 3 | #K | title | ○ Pending | #N, #M | — |

Issues: ${TOTAL_ISSUES} total, ${DONE_COUNT} done, ${UNFINISHED_COUNT} remaining
Rate limit: ${REMAINING} calls available (~${SAFE_ISSUES} issues safe)
Estimated API calls: ~${ESTIMATED_CALLS}

No issues executed. Remove --dry-run to start.
```

Exit after display.
</step>

<step name="resume_detection">
**Check for in-progress issues and clean up partial state:**

```bash
IN_PROGRESS=$(echo "$UNFINISHED" | python3 -c "
import json,sys
issues = json.load(sys.stdin)
in_prog = [i for i in issues if i.get('pipeline_stage') not in ('new', 'done', 'failed')]
print(json.dumps(in_prog))
")

IN_PROGRESS_COUNT=$(echo "$IN_PROGRESS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
```

If in-progress issues exist:
```bash
if [ "$IN_PROGRESS_COUNT" -gt 0 ]; then
  echo "Resuming milestone — ${IN_PROGRESS_COUNT} in-progress issue(s) detected"

  # For each in-progress issue:
  # 1. Check if worktree exists
  for ISSUE_NUM in $(echo "$IN_PROGRESS" | python3 -c "
    import json,sys
    for i in json.load(sys.stdin):
      print(i['github_number'])
  "); do
    # Clean up lingering worktree (restart from scratch per design decision)
    WORKTREE_PATH=$(git worktree list --porcelain 2>/dev/null | grep -B1 "issue/${ISSUE_NUM}" | head -1 | sed 's/worktree //')
    if [ -n "$WORKTREE_PATH" ] && [ -d "$WORKTREE_PATH" ]; then
      git worktree remove "$WORKTREE_PATH" --force 2>/dev/null
      echo "  Cleaned up partial worktree for #${ISSUE_NUM}"
    fi

    # Reset pipeline_stage to 'new' (will be re-run from scratch)
    node -e "
const { loadProjectState, resolveActiveMilestoneIndex, writeProjectState } = require('./lib/state.cjs');
const state = loadProjectState();
const idx = resolveActiveMilestoneIndex(state);
if (idx < 0) { console.error('No active milestone'); process.exit(1); }
const milestone = state.milestones[idx];
const issue = (milestone.issues || []).find(i => i.github_number === ${ISSUE_NUM});
if (issue) { issue.pipeline_stage = 'new'; }
writeProjectState(state);
"
  done
fi
```
</step>

<step name="execute_loop">
**Sequential loop over sorted issues (MLST-01, MLST-05):**

Track state for progress table:
```bash
COMPLETED_ISSUES=()
FAILED_ISSUES=()
FAILED_ISSUES_WITH_CLASS=()  # Entries: "issue_number:failure_class" for results display
BLOCKED_ISSUES=()
SKIPPED_ISSUES=()
LABEL_DRIFT_ISSUES=()         # Issues where label reconciliation detected drift
ISSUES_RUN=0
```

For each issue in sorted order:
```bash
for ISSUE_DATA in $(echo "$UNFINISHED" | python3 -c "
  import json,sys
  for i in json.load(sys.stdin):
    # Output as compact JSON per line
    print(json.dumps(i))
"); do
  ISSUE_NUMBER=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['github_number'])")
  ISSUE_TITLE=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['title'])")
  GSD_ROUTE=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('gsd_route','plan-phase'))")

  # 1. Check if blocked by a failed issue
  IS_BLOCKED=false
  for FAILED_NUM in "${FAILED_ISSUES[@]}"; do
    DEPS=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(','.join(json.load(sys.stdin).get('depends_on_slugs',[])))")
    # Check if any dependency maps to a failed issue
    # If blocked: IS_BLOCKED=true
  done

  if [ "$IS_BLOCKED" = true ]; then
    BLOCKED_ISSUES+=("$ISSUE_NUMBER")
    echo "  ⊘ #${ISSUE_NUMBER} — Blocked (dependency failed)"
    # Update project.json: pipeline_stage = "blocked" (treat as skipped)
    continue
  fi

  # 2. Check rate limit still OK
  if [ "$ISSUES_RUN" -ge "$MAX_ISSUES" ]; then
    echo "Rate limit cap reached. Stopping after ${ISSUES_RUN} issues."
    echo "${REMAINING} API calls remaining. Limit resets at ${RESET_TIME}."
    break
  fi

  # 3. Quick GitHub check — is issue still open?
  ISSUE_STATE=$(gh issue view ${ISSUE_NUMBER} --json state -q .state 2>/dev/null || echo "OPEN")
  if [ "$ISSUE_STATE" != "OPEN" ]; then
    echo "  ⊘ #${ISSUE_NUMBER} — Skipped (issue ${ISSUE_STATE})"
    SKIPPED_ISSUES+=("$ISSUE_NUMBER")
    continue
  fi

  # 4. Display terminal output
  echo "Running issue #${ISSUE_NUMBER}..."

  # ── PRE-WORK: Post triage/work-started comment on issue ──
  # The ORCHESTRATOR posts this, not the inner agent. This guarantees it happens.
  PHASE_NUM=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('phase_number','?'))")
  PHASE_NAME=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('phase_name',''))")
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Build milestone progress table for this comment
  PROGRESS_TABLE=$(echo "$SORTED_ISSUES" | python3 -c "
import json, sys
issues = json.load(sys.stdin)
completed = set(${COMPLETED_ISSUES_JSON:-'[]'})
current = ${ISSUE_NUMBER}
lines = ['| # | Issue | Status | PR |', '|---|-------|--------|----|']
for i in issues:
    num = i['github_number']
    title = i['title'][:45]
    if num in completed:
        lines.append(f'| {num} | {title} | ✓ Done | — |')
    elif num == current:
        lines.append(f'| **{num}** | **{title}** | ◆ In Progress | — |')
    else:
        lines.append(f'| {num} | {title} | ○ Pending | — |')
print('\n'.join(lines))
")

  WORK_STARTED_BODY=$(cat <<COMMENTEOF
> **MGW** · \`work-started\` · ${TIMESTAMP}
> Milestone: ${MILESTONE_NAME} | Phase ${PHASE_NUM}: ${PHASE_NAME}

### Work Started

| | |
|---|---|
| **Issue** | #${ISSUE_NUMBER} — ${ISSUE_TITLE} |
| **Route** | \`${GSD_ROUTE}\` |
| **Phase** | ${PHASE_NUM} of ${TOTAL_PHASES} — ${PHASE_NAME} |
| **Milestone** | ${MILESTONE_NAME} |

<details>
<summary>Milestone Progress (${#COMPLETED_ISSUES[@]}/${TOTAL_ISSUES} complete)</summary>

${PROGRESS_TABLE}

</details>
COMMENTEOF
)

  gh issue comment ${ISSUE_NUMBER} --body "$WORK_STARTED_BODY" 2>/dev/null || true
  gh issue edit ${ISSUE_NUMBER} --add-assignee @me 2>/dev/null || true

  # ── MAIN WORK: Spawn /mgw:run via Task() ──
  # The agent focuses on: worktree → GSD execution → PR creation
  # Comment posting is handled by THIS orchestrator, not the agent.
  Task(
    prompt="
      <files_to_read>
      - ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
      - .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
      </files_to_read>

      Run the MGW pipeline for issue #${ISSUE_NUMBER}.
      Read ~/.claude/commands/mgw/run.md for the workflow steps.

      **Your responsibilities (the orchestrator handles status comments):**
      1. validate_and_load — load issue state from .mgw/active/
      2. create_worktree — create isolated git worktree for issue branch
      3. execute_gsd_quick or execute_gsd_milestone (route: ${GSD_ROUTE})
      4. create_pr — push branch and create PR with this EXACT body structure:

      PR BODY MUST include these sections IN ORDER:
      ## Summary
      - 2-4 bullets of what was built and why

      Closes #${ISSUE_NUMBER}

      ## Milestone Context
      - **Milestone:** ${MILESTONE_NAME}
      - **Phase:** ${PHASE_NUM} — ${PHASE_NAME}
      - **Issue:** ${ISSUES_RUN + 1} of ${TOTAL_ISSUES} in milestone

      ## Changes
      - File-level changes grouped by module

      ## Test Plan
      - Verification checklist

      5. cleanup_and_complete — clean up worktree, update .mgw/ state

      **Do NOT post issue comments** — the orchestrator handles all GitHub comments.

      Issue title: ${ISSUE_TITLE}
      GSD route: ${GSD_ROUTE}
    ",
    subagent_type="general-purpose",
    description="Run pipeline for #${ISSUE_NUMBER}"
  )

  # ── POST-WORK: Post-subagent label verification ──
  # Read the pipeline_stage from the issue's active state file after Task() returns
  ISSUE_STAGE=$(node -e "
const { loadActiveIssue } = require('./lib/state.cjs');
const state = loadActiveIssue(${ISSUE_NUMBER});
console.log((state && state.pipeline_stage) ? state.pipeline_stage : 'unknown');
" 2>/dev/null || echo "unknown")

  # Determine the expected MGW label for this pipeline stage
  EXPECTED_LABEL=$(python3 -c "
stage_to_label = {
  'done': '',
  'pr-created': '',
  'verifying': 'mgw:in-progress',
  'executing': 'mgw:in-progress',
  'planning': 'mgw:in-progress',
  'blocked': 'mgw:blocked',
  'failed': '',
}
print(stage_to_label.get('${ISSUE_STAGE}', ''))
")

  # Compare expected label against live GitHub labels
  LIVE_LABELS=$(gh issue view ${ISSUE_NUMBER} --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null || echo "")

  if [ -n "$EXPECTED_LABEL" ] && ! echo "$LIVE_LABELS" | grep -q "$EXPECTED_LABEL"; then
    echo "MGW WARNING: label drift on #${ISSUE_NUMBER} — expected $EXPECTED_LABEL, live: $LIVE_LABELS" >&2
    LABEL_DRIFT="drift"
  else
    LABEL_DRIFT="ok"
  fi

  # Track drifted issues for milestone summary
  if [ "$LABEL_DRIFT" = "drift" ]; then
    LABEL_DRIFT_ISSUES+=("$ISSUE_NUMBER")
  fi

  # ── POST-WORK: Detect result and post completion comment ──
  # Check if PR was created by looking for state file or PR
  PR_NUMBER=$(gh pr list --head "issue/${ISSUE_NUMBER}-*" --json number -q '.[0].number' 2>/dev/null || echo "")
  PR_URL=""
  if [ -z "$PR_NUMBER" ]; then
    # Try broader search
    PR_NUMBER=$(gh pr list --state all --search "Closes #${ISSUE_NUMBER}" --json number -q '.[0].number' 2>/dev/null || echo "")
  fi
  if [ -n "$PR_NUMBER" ]; then
    PR_URL=$(gh pr view "$PR_NUMBER" --json url -q .url 2>/dev/null || echo "")
  fi

  DONE_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  if [ -n "$PR_NUMBER" ]; then
    # Success — post PR-ready comment
    COMPLETED_ISSUES+=("$ISSUE_NUMBER")
    COMPLETED_ISSUES_JSON=$(printf '%s\n' "${COMPLETED_ISSUES[@]}" | python3 -c "import json,sys; print(json.dumps([int(x.strip()) for x in sys.stdin if x.strip()]))")

    # Rebuild progress table with updated state
    DONE_PROGRESS=$(echo "$SORTED_ISSUES" | python3 -c "
import json, sys
issues = json.load(sys.stdin)
completed = set(${COMPLETED_ISSUES_JSON})
lines = ['| # | Issue | Status | PR |', '|---|-------|--------|----|']
for i in issues:
    num = i['github_number']
    title = i['title'][:45]
    if num in completed:
        lines.append(f'| {num} | {title} | ✓ Done | — |')
    else:
        lines.append(f'| {num} | {title} | ○ Pending | — |')
print('\n'.join(lines))
")

    PR_READY_BODY=$(cat <<COMMENTEOF
> **MGW** · \`pr-ready\` · ${DONE_TIMESTAMP}
> Milestone: ${MILESTONE_NAME} | Phase ${PHASE_NUM}: ${PHASE_NAME}

### PR Ready

**PR #${PR_NUMBER}** — ${PR_URL}

Testing procedures posted on the PR.
This issue will auto-close when the PR is merged.

<details>
<summary>Milestone Progress (${#COMPLETED_ISSUES[@]}/${TOTAL_ISSUES} complete)</summary>

${DONE_PROGRESS}

</details>
COMMENTEOF
)

    gh issue comment ${ISSUE_NUMBER} --body "$PR_READY_BODY" 2>/dev/null || true
    echo "  ✓ #${ISSUE_NUMBER} — PR #${PR_NUMBER} created"

  else
    # Failure — read failure_class from active issue state, then post failure comment
    FAILED_ISSUES+=("$ISSUE_NUMBER")

    # Read failure_class and dead_letter from the active issue state file
    ISSUE_FAILURE_CLASS=$(node -e "
const { loadActiveIssue } = require('./lib/state.cjs');
const state = loadActiveIssue(${ISSUE_NUMBER});
console.log((state && state.last_failure_class) ? state.last_failure_class : 'unknown');
" 2>/dev/null || echo "unknown")

    ISSUE_DEAD_LETTER=$(node -e "
const { loadActiveIssue } = require('./lib/state.cjs');
const state = loadActiveIssue(${ISSUE_NUMBER});
console.log(state && state.dead_letter === true ? 'true' : 'false');
" 2>/dev/null || echo "false")

    ISSUE_RETRY_COUNT=$(node -e "
const { loadActiveIssue } = require('./lib/state.cjs');
const state = loadActiveIssue(${ISSUE_NUMBER});
console.log((state && typeof state.retry_count === 'number') ? state.retry_count : 0);
" 2>/dev/null || echo "0")

    FAILED_ISSUES_WITH_CLASS+=("${ISSUE_NUMBER}:${ISSUE_FAILURE_CLASS}")

    FAIL_BODY=$(cat <<COMMENTEOF
> **MGW** · \`pipeline-failed\` · ${DONE_TIMESTAMP}
> Milestone: ${MILESTONE_NAME} | Phase ${PHASE_NUM}: ${PHASE_NAME}

### Pipeline Failed

Issue #${ISSUE_NUMBER} did not produce a PR.

| | |
|---|---|
| **Failure class** | \`${ISSUE_FAILURE_CLASS}\` |
| **Retries attempted** | ${ISSUE_RETRY_COUNT} of 3 |
| **Dead-lettered** | ${ISSUE_DEAD_LETTER} |

Dependents of this issue will be skipped.
To retry after resolving root cause: \`/mgw:run ${ISSUE_NUMBER} --retry\`
COMMENTEOF
)

    gh issue comment ${ISSUE_NUMBER} --body "$FAIL_BODY" 2>/dev/null || true
    gh issue edit ${ISSUE_NUMBER} --add-label "pipeline-failed" 2>/dev/null || true
    gh label create "pipeline-failed" --description "Pipeline execution failed" --color "d73a4a" --force 2>/dev/null || true
    echo "  ✗ #${ISSUE_NUMBER} — Failed (class: ${ISSUE_FAILURE_CLASS}, no PR created)"
  fi

  # Update project.json checkpoint (MLST-05)
  STAGE=$([ -n "$PR_NUMBER" ] && echo "done" || echo "failed")
  node -e "
const { loadProjectState, resolveActiveMilestoneIndex, writeProjectState } = require('./lib/state.cjs');
const state = loadProjectState();
const idx = resolveActiveMilestoneIndex(state);
if (idx < 0) { console.error('No active milestone'); process.exit(1); }
const milestone = state.milestones[idx];
const issue = (milestone.issues || []).find(i => i.github_number === ${ISSUE_NUMBER});
if (issue) { issue.pipeline_stage = '${STAGE}'; }
writeProjectState(state);
"

  ISSUES_RUN=$((ISSUES_RUN + 1))

  # Update and print milestone progress bar after each issue completes
  DONE_SO_FAR=$((DONE_COUNT + ${#COMPLETED_ISSUES[@]}))
  ISSUES_WITH_STAGES=$(node -e "
const { loadProjectState, resolveActiveMilestoneIndex } = require('./lib/state.cjs');
const state = loadProjectState();
const idx = resolveActiveMilestoneIndex(state);
if (idx < 0) { console.log('[]'); process.exit(0); }
const issues = state.milestones[idx].issues || [];
console.log(JSON.stringify(issues.map(i => ({ number: i.github_number, pipeline_stage: i.pipeline_stage || 'new' }))));
" 2>/dev/null || echo "[]")

  node -e "
const { printMilestoneProgress } = require('./lib/progress.cjs');
const issues = JSON.parse(process.env.ISSUES_WITH_STAGES || '[]');
const doneCount = issues.filter(i => i.pipeline_stage === 'done' || i.pipeline_stage === 'pr-created').length;
printMilestoneProgress({
  done: doneCount,
  total: issues.length,
  issues
});
" ISSUES_WITH_STAGES="$ISSUES_WITH_STAGES"

  # If --interactive: pause between issues
  if [ "$INTERACTIVE" = true ]; then
    AskUserQuestion(
      header: "Issue Complete",
      question: "#${ISSUE_NUMBER} done. Continue to next issue?",
      options: [
        { label: "Continue", description: "Proceed to next unblocked issue" },
        { label: "Skip next", description: "Skip next issue and continue" },
        { label: "Abort", description: "Stop milestone execution here" }
      ]
    )
    # Handle response: Continue → proceed, Skip → skip next, Abort → break
  fi
done
```

**Progress table format for GitHub comments:**

Every comment posted during milestone orchestration includes:
```markdown
**Issue #N — {Status}** {symbol}

{Status-specific detail (PR link, failure reason, etc.)}

<details>
<summary>Milestone Progress ({done}/{total} complete)</summary>

| # | Issue | Status | PR | Failure Class | Label Drift |
|---|-------|--------|----|---------------|-------------|
| N | title | ✓ Done | #PR | — | ok |
| M | title | ✗ Failed | — | `permanent` | — |
| K | title | ○ Pending | — | — | — |
| J | title | ◆ Running | — | — | ok |
| L | title | ⊘ Blocked | — | — | — |

</details>
```

The **Failure Class** column surfaces `last_failure_class` from the active issue state file.
The **Label Drift** column shows the result of post-subagent label reconciliation: `ok` (labels matched expected), `drift` (label mismatch detected — MGW WARNING logged), or `—` (not checked / issue not run).
Values: `transient` (retried and exhausted), `permanent` (unrecoverable), `needs-info` (ambiguous issue), `unknown` (no state file or pre-retry issue), `—` (not failed).
</step>

<step name="post_loop">
**After loop completes — finalize milestone:**

Build final results table:
```bash
TOTAL_DONE=$((DONE_COUNT + ${#COMPLETED_ISSUES[@]}))
TOTAL_FAILED=${#FAILED_ISSUES[@]}
TOTAL_BLOCKED=${#BLOCKED_ISSUES[@]}
TOTAL_SKIPPED=${#SKIPPED_ISSUES[@]}
```

**If ALL issues completed (pipeline_stage == 'done' for all):**

1. Close GitHub milestone:
```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/${REPO}/milestones/${MILESTONE_GH_NUMBER}" --method PATCH \
  -f state="closed" 2>/dev/null
```

2. Create draft release:
```bash
RELEASE_TAG="milestone-${MILESTONE_NUM}-complete"
# Build release body with: milestone name, issues completed, PR links, stats
RELEASE_BODY="## Milestone ${MILESTONE_NUM}: ${MILESTONE_NAME}

### Issues Completed
${issues_completed_list}

### Pull Requests
${pr_links_list}

### Stats
- Issues: ${TOTAL_ISSUES}
- PRs created: ${pr_count}

---
*Auto-generated by MGW milestone orchestration*"

gh release create "$RELEASE_TAG" --draft \
  --title "Milestone ${MILESTONE_NUM}: ${MILESTONE_NAME}" \
  --notes "$RELEASE_BODY" 2>/dev/null
```

3. Finalize GSD milestone state (archive phases, clean up):
```bash
# Only run if .planning/phases exists (GSD was used for this milestone)
if [ -d ".planning/phases" ]; then
  EXECUTOR_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-executor --raw)
  Task(
    prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions -- if exists, follow all guidelines)
- .planning/ROADMAP.md (Current roadmap to archive)
- .planning/REQUIREMENTS.md (Requirements to archive)
</files_to_read>

Complete the GSD milestone. Follow the complete-milestone workflow:
@~/.claude/get-shit-done/workflows/complete-milestone.md

This archives the milestone's ROADMAP and REQUIREMENTS to .planning/milestones/,
cleans up ROADMAP.md for the next milestone, and tags the release in git.

Milestone: ${MILESTONE_NAME}
",
    subagent_type="gsd-executor",
    model="${EXECUTOR_MODEL}",
    description="Complete GSD milestone: ${MILESTONE_NAME}"
  )
fi
```

4. Advance active milestone pointer in project.json:
```bash
node -e "
const { loadProjectState, resolveActiveMilestoneIndex, writeProjectState } = require('./lib/state.cjs');
const state = loadProjectState();
const currentIdx = resolveActiveMilestoneIndex(state);
const nextMilestone = (state.milestones || [])[currentIdx + 1];
if (nextMilestone) {
  // New schema: point active_gsd_milestone at the next milestone's gsd_milestone_id
  state.active_gsd_milestone = nextMilestone.gsd_milestone_id || null;
  // Backward compat: if next milestone has no gsd_milestone_id, fall back to legacy integer
  if (!state.active_gsd_milestone) {
    state.current_milestone = currentIdx + 2; // next 1-indexed
  }
} else {
  // All milestones complete — clear the active pointer
  state.active_gsd_milestone = null;
  state.current_milestone = currentIdx + 2; // past end, signals completion
}
writeProjectState(state);
"
```

5. Milestone mapping verification:

After advancing to the next milestone, check its GSD linkage using `getGsdState()`
from `lib/gsd-adapter.cjs` to read current GSD execution state (.planning/STATE.md
and ROADMAP.md) alongside the project.json milestone map:

```bash
# Read current GSD state from .planning/ via the adapter
GSD_STATE=$(node -e "
const { getGsdState } = require('./lib/gsd-adapter.cjs');
const state = getGsdState();
console.log(JSON.stringify(state));
" 2>/dev/null || echo "null")

NEXT_MILESTONE_CHECK=$(node -e "
const { loadProjectState, resolveActiveMilestoneIndex } = require('./lib/state.cjs');
const state = loadProjectState();
const activeIdx = resolveActiveMilestoneIndex(state);

if (activeIdx < 0 || activeIdx >= state.milestones.length) {
  console.log('none');
  process.exit(0);
}

const nextMilestone = state.milestones[activeIdx];
if (!nextMilestone) {
  console.log('none');
  process.exit(0);
}

const gsdId = nextMilestone.gsd_milestone_id;
const name = nextMilestone.name;

if (!gsdId) {
  console.log('unlinked:' + name);
} else {
  console.log('linked:' + name + ':' + gsdId);
}
")

case "$NEXT_MILESTONE_CHECK" in
  none)
    echo "All milestones complete — project is done!"
    ;;
  unlinked:*)
    NEXT_NAME=$(echo "$NEXT_MILESTONE_CHECK" | cut -d':' -f2-)
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " Next milestone '${NEXT_NAME}' has no GSD milestone linked."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Before running /mgw:milestone for the next milestone:"
    echo "  1) Run /gsd:new-milestone to create GSD state for '${NEXT_NAME}'"
    echo "  2) Run /mgw:project extend to link the new GSD milestone"
    echo ""
    ;;
  linked:*)
    NEXT_NAME=$(echo "$NEXT_MILESTONE_CHECK" | cut -d':' -f2)
    GSD_ID=$(echo "$NEXT_MILESTONE_CHECK" | cut -d':' -f3)
    # Verify ROADMAP.md matches expected GSD milestone
    ROADMAP_CHECK=$(python3 -c "
import os, sys
if not os.path.exists('.planning/ROADMAP.md'):
    print('no_roadmap')
    sys.exit()
with open('.planning/ROADMAP.md') as f:
    content = f.read()
if '${GSD_ID}' in content:
    print('match')
else:
    print('mismatch')
" 2>/dev/null || echo "no_roadmap")

    case "$ROADMAP_CHECK" in
      match)
        echo "Next milestone '${NEXT_NAME}' (GSD: ${GSD_ID}) — ROADMAP.md is ready."
        ;;
      mismatch)
        echo "Next milestone '${NEXT_NAME}' links to GSD milestone '${GSD_ID}'"
        echo "    but .planning/ROADMAP.md does not contain that milestone ID."
        echo "    Run /gsd:new-milestone to update ROADMAP.md before proceeding."
        ;;
      no_roadmap)
        echo "NOTE: Next milestone '${NEXT_NAME}' (GSD: ${GSD_ID}) linked."
        echo "      No .planning/ROADMAP.md found — run /gsd:new-milestone when ready."
        ;;
    esac
    ;;
esac
```

6. Display completion banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► MILESTONE ${MILESTONE_NUM} COMPLETE ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${MILESTONE_NAME}

| # | Issue | Status | PR |
|---|-------|--------|----|
${results_table}

Issues: ${TOTAL_ISSUES} | PRs: ${pr_count}
Milestone closed on GitHub.
Draft release created: ${RELEASE_TAG}

───────────────────────────────────────────────────────────────

## ▶ Next Up

**Milestone ${NEXT_MILESTONE_NUM}** — next milestone

/mgw:milestone ${NEXT_MILESTONE_NUM}

<sub>/clear first → fresh context window</sub>

───────────────────────────────────────────────────────────────
```

7. Check if next milestone exists and offer auto-advance (only if no failures in current).

**If some issues failed:**

Build failure class lookup from `FAILED_ISSUES_WITH_CLASS` array for display:
```bash
# Build failure class map: { issue_number → failure_class }
FAILURE_CLASS_MAP=$(python3 -c "
import json, sys

entries = '${FAILED_ISSUES_WITH_CLASS[@]}'.split()
result = {}
for entry in entries:
    if ':' in entry:
        num, cls = entry.split(':', 1)
        result[num] = cls
print(json.dumps(result))
" 2>/dev/null || echo "{}")
```

Display results table including failure_class for each failed issue:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► MILESTONE ${MILESTONE_NUM} INCOMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${MILESTONE_NAME}

| # | Issue | Status | PR | Failure Class |
|---|-------|--------|----|---------------|
${results_table_with_failure_class}

Completed: ${TOTAL_DONE}/${TOTAL_ISSUES}
Failed: ${TOTAL_FAILED}
Blocked: ${TOTAL_BLOCKED}
```

For each failed issue, present recovery options:
```bash
for ENTRY in "${FAILED_ISSUES_WITH_CLASS[@]}"; do
  FAIL_NUM=$(echo "$ENTRY" | cut -d':' -f1)
  FAIL_CLASS=$(echo "$ENTRY" | cut -d':' -f2)

  echo ""
  echo "  Failed: #${FAIL_NUM} (class: ${FAIL_CLASS})"
  AskUserQuestion(
    header: "Recovery — Issue #${FAIL_NUM}",
    question: "Issue #${FAIL_NUM} failed (failure class: ${FAIL_CLASS}). What would you like to do?",
    options: [
      {
        label: "Retry",
        description: "Reset retry state via resetRetryState() and re-run /mgw:run #${FAIL_NUM} --retry"
      },
      {
        label: "Skip",
        description: "Mark as skipped and continue to next issue (dependents will remain blocked)"
      },
      {
        label: "Abort",
        description: "Stop milestone recovery here"
      }
    ]
  )

  case "$RECOVERY_CHOICE" in
    Retry)
      # Call resetRetryState() to clear retry_count, last_failure_class, dead_letter
      node -e "
const { resetRetryState } = require('./lib/retry.cjs');
const fs = require('fs'), path = require('path');
const activeDir = path.join(process.cwd(), '.mgw', 'active');
const files = fs.readdirSync(activeDir);
const file = files.find(f => f.startsWith('${FAIL_NUM}-') && f.endsWith('.json'));
if (!file) { console.error('No state file for #${FAIL_NUM}'); process.exit(1); }
const filePath = path.join(activeDir, file);
const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
const reset = resetRetryState(state);
reset.pipeline_stage = 'triaged';
fs.writeFileSync(filePath, JSON.stringify(reset, null, 2));
console.log('Retry state cleared for #${FAIL_NUM}');
"
      # Remove pipeline-failed label before re-run
      gh issue edit ${FAIL_NUM} --remove-label "pipeline-failed" 2>/dev/null || true
      # Re-run the pipeline for this issue
      /mgw:run ${FAIL_NUM} --retry
      ;;
    Skip)
      echo "  ⊘ #${FAIL_NUM} — Skipped (will not retry)"
      ;;
    Abort)
      echo "Milestone recovery aborted at #${FAIL_NUM}."
      break
      ;;
  esac
done
```

After recovery loop:
```
Milestone NOT closed. Re-run after resolving remaining failures:
  /mgw:milestone ${MILESTONE_NUM}
```

8. Post final results table as GitHub comment on the first issue in the milestone:
```bash
gh issue comment ${FIRST_ISSUE_NUMBER} --body "$FINAL_RESULTS_COMMENT"
```
</step>

</process>

<success_criteria>
- [ ] project.json loaded and milestone validated (MLST-01)
- [ ] Batch staleness check run before execution (MLST-03)
- [ ] Rate limit checked and execution capped if needed (MLST-04)
- [ ] Dependency resolution via topological sort (MLST-01)
- [ ] Cycle detection with clear error reporting
- [ ] Resume detection with partial state cleanup
- [ ] Sequential execution via /mgw:run Task() delegation (MLST-01)
- [ ] Per-issue checkpoint to project.json after completion (MLST-05)
- [ ] Failure handling: skip failed, label, comment, block dependents
- [ ] failure_class surfaced in results table and failure comment for each failed issue
- [ ] Retry option calls resetRetryState() then re-invokes /mgw:run --retry for failed issues
- [ ] FAILED_ISSUES_WITH_CLASS tracks "number:class" for display in results table
- [ ] Progress table in every GitHub comment
- [ ] Post-subagent label reconciliation run per issue after Task() returns
- [ ] LABEL_DRIFT tracked per issue (ok/drift) and shown in progress table Label Drift column
- [ ] Label drift issues logged as MGW WARNING to stderr
- [ ] Milestone close + draft release on full completion
- [ ] current_milestone pointer advanced on completion
- [ ] --interactive flag pauses between issues
- [ ] --dry-run flag shows plan without executing
- [ ] Terminal output is minimal during run
</success_criteria>
