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
  MILESTONE_NUM=$(python3 -c "import json; print(json.load(open('${MGW_DIR}/project.json'))['current_milestone'])")
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
    python3 -c "
import json
with open('${MGW_DIR}/project.json') as f:
    project = json.load(f)
milestone = project['milestones'][project['current_milestone'] - 1]
for issue in milestone['issues']:
    if issue['github_number'] == ${ISSUE_NUM}:
        issue['pipeline_stage'] = 'new'
        break
with open('${MGW_DIR}/project.json', 'w') as f:
    json.dump(project, f, indent=2)
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
BLOCKED_ISSUES=()
SKIPPED_ISSUES=()
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

  # 4. Display minimal terminal output
  echo "Running issue #${ISSUE_NUMBER}..."

  # 5. Spawn /mgw:run via Task()
  # The Task agent reads run.md and executes the full pipeline
  Task(
    prompt="
      <files_to_read>
      - ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
      - .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
      </files_to_read>

      Run the full MGW pipeline for issue #${ISSUE_NUMBER}.
      Read ~/.claude/commands/mgw/run.md for the complete workflow.
      Follow ALL steps: validate_and_load, create_worktree, post_start_update,
      execute_gsd_quick or execute_gsd_milestone (based on GSD route: ${GSD_ROUTE}),
      create_pr, cleanup_and_complete.

      Issue title: ${ISSUE_TITLE}
      GSD route: ${GSD_ROUTE}
    ",
    subagent_type="general-purpose",
    description="Run pipeline for #${ISSUE_NUMBER}"
  )

  # 6. Handle result
  # Check if Task succeeded (PR created) or failed
  # Success indicators: pipeline_stage updated to "done" or "pr-created" in .mgw/active/
  # Failure indicators: Task returned error, no PR created

  # On success:
  COMPLETED_ISSUES+=("$ISSUE_NUMBER")
  echo "Done."

  # Update project.json checkpoint (MLST-05)
  python3 -c "
import json
with open('${MGW_DIR}/project.json') as f:
    project = json.load(f)
milestone = project['milestones'][project['current_milestone'] - 1]
for issue in milestone['issues']:
    if issue['github_number'] == ${ISSUE_NUMBER}:
        issue['pipeline_stage'] = 'done'
        break
with open('${MGW_DIR}/project.json', 'w') as f:
    json.dump(project, f, indent=2)
"

  # On failure:
  # FAILED_ISSUES+=("$ISSUE_NUMBER")
  # echo "Failed."
  # Update project.json: pipeline_stage = "failed"
  # Add pipeline-failed label:
  #   gh issue edit ${ISSUE_NUMBER} --add-label "pipeline-failed"
  #   gh label create "pipeline-failed" --description "Pipeline execution failed" --color "d73a4a" --force 2>/dev/null
  # Post failure comment with collapsed milestone progress table:
  #   gh issue comment ${ISSUE_NUMBER} --body "$FAILURE_COMMENT"

  ISSUES_RUN=$((ISSUES_RUN + 1))

  # 7. If --interactive: pause between issues
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

  # 8. Build progress table for GitHub comments
  # Every comment includes collapsed milestone progress table
done
```

**Progress table format for GitHub comments:**

Every comment posted during milestone orchestration includes:
```markdown
**Issue #N — {Status}** {symbol}

{Status-specific detail (PR link, failure reason, etc.)}

<details>
<summary>Milestone Progress ({done}/{total} complete)</summary>

| # | Issue | Status | PR | Stage |
|---|-------|--------|----|-------|
| N | title | ✓ Done | #PR | done |
| M | title | ✗ Failed | — | failed |
| K | title | ○ Pending | — | new |
| J | title | ◆ Running | — | executing |
| L | title | ⊘ Blocked | — | blocked-by:#N |

</details>
```
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

3. Advance current_milestone in project.json:
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

4. Display completion banner:
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

5. Check if next milestone exists and offer auto-advance (only if no failures in current).

**If some issues failed:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► MILESTONE ${MILESTONE_NUM} INCOMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${MILESTONE_NAME}

| # | Issue | Status | PR |
|---|-------|--------|----|
${results_table}

Completed: ${TOTAL_DONE}/${TOTAL_ISSUES}
Failed: ${TOTAL_FAILED}
Blocked: ${TOTAL_BLOCKED}

Milestone NOT closed. Resolve failures and re-run:
  /mgw:milestone ${MILESTONE_NUM}
```

6. Post final results table as GitHub comment on the first issue in the milestone:
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
- [ ] Progress table in every GitHub comment
- [ ] Milestone close + draft release on full completion
- [ ] current_milestone pointer advanced on completion
- [ ] --interactive flag pauses between issues
- [ ] --dry-run flag shows plan without executing
- [ ] Terminal output is minimal during run
</success_criteria>
