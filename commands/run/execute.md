---
name: mgw:run/execute
description: Execute GSD pipeline (quick or milestone route) and post execution update
---

<step name="execute_gsd_quick">
**Execute GSD pipeline (quick / quick --full route):**

Only run this step if gsd_route is "gsd:quick" or "gsd:quick --full".

**Retry loop initialization:**
```bash
# Load retry state from .mgw/active/ state file
RETRY_COUNT=$(node -e "
const { loadActiveIssue } = require('./lib/state.cjs');
const state = loadActiveIssue(${ISSUE_NUMBER});
console.log((state && typeof state.retry_count === 'number') ? state.retry_count : 0);
" 2>/dev/null || echo "0")
EXECUTION_SUCCEEDED=false
```

**Begin retry loop** — wraps the GSD quick execution (steps 1–11 below) with transient-failure retry:

```
RETRY_LOOP:
  while canRetry(issue_state) AND NOT EXECUTION_SUCCEEDED:
```

Update pipeline_stage to "executing" in state file (at `${REPO_ROOT}/.mgw/active/`).

Determine flags:
- "gsd:quick" → $QUICK_FLAGS = ""
- "gsd:quick --full" → $QUICK_FLAGS = "--full"

Read the issue description to use as the GSD task description (full body, capped at 5000 chars for pathological issues):
```
$TASK_DESCRIPTION = "Issue #${ISSUE_NUMBER}: ${issue_title}\n\n${issue_body}"  # full body, max 5000 chars
```

Execute the GSD quick workflow. Read and follow the quick workflow steps:

1. **Init:** `node ~/.claude/get-shit-done/bin/gsd-tools.cjs init quick "$DESCRIPTION"`
   Parse JSON for: planner_model, executor_model, checker_model, verifier_model, next_num, slug, date, quick_dir, task_dir.

   **Handle missing .planning/:** Check `roadmap_exists` from init output. If false, do NOT
   create GSD state files — .planning/ is owned by GSD. Only create the quick task
   directory (GSD agents need it to store plans/summaries):
   ```bash
   if [ "$roadmap_exists" = "false" ]; then
     echo "NOTE: No .planning/ directory found. GSD manages its own state files."
     echo "      To create a ROADMAP.md, run /gsd:new-milestone after this pipeline."
     mkdir -p .planning/quick
   fi
   ```
   MGW never writes config.json, ROADMAP.md, or STATE.md — those are GSD-owned files.

2. **Create task directory:**
```bash
QUICK_DIR=".planning/quick/${next_num}-${slug}"
mkdir -p "$QUICK_DIR"
```

3. **Spawn planner (task agent):**
```
Task(
  prompt="
<planning_context>

**Mode:** ${FULL_MODE ? 'quick-full' : 'quick'}
**Directory:** ${QUICK_DIR}
**Description:** ${TASK_DESCRIPTION}

<triage_context>
Scope: ${triage.scope.files} files across systems: ${triage.scope.systems}
Validity: ${triage.validity}
Security: ${triage.security_notes}
Conflicts: ${triage.conflicts}
GSD Route: ${gsd_route}
</triage_context>

<issue_comments>
${recent_comments}
</issue_comments>

<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
</files_to_read>

</planning_context>

<constraints>
- Create a SINGLE plan with 1-3 focused tasks
- Quick tasks should be atomic and self-contained
- No research phase
${FULL_MODE ? '- Target ~40% context usage (structured for verification)' : '- Target ~30% context usage (simple, focused)'}
${FULL_MODE ? '- MUST generate must_haves in plan frontmatter (truths, artifacts, key_links)' : ''}
${FULL_MODE ? '- Each task MUST have files, action, verify, done fields' : ''}
</constraints>

<output>
Write plan to: ${QUICK_DIR}/${next_num}-PLAN.md
Return: ## PLANNING COMPLETE with plan path
</output>
",
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Plan: ${issue_title}"
)
```

4. **Verify plan exists** at `${QUICK_DIR}/${next_num}-PLAN.md`

5. **Pre-flight plan structure check (gsd-tools):**
```bash
PLAN_CHECK=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs verify plan-structure "${QUICK_DIR}/${next_num}-PLAN.md")
```
Parse the JSON result. If structural issues found, include them in the plan-checker prompt below so it has concrete problems to evaluate rather than searching from scratch.

6. **(If --full) Spawn plan-checker, handle revision loop (max 2 iterations):**
```
Task(
  prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
- ${QUICK_DIR}/${next_num}-PLAN.md (Plan to verify)
</files_to_read>

<verification_context>
**Mode:** quick-full
**Task Description:** ${TASK_DESCRIPTION}

<structural_preflight>
${PLAN_CHECK}
</structural_preflight>

**Scope:** This is a quick task, not a full phase. Skip checks that require a ROADMAP phase goal. If structural_preflight flagged issues, prioritize evaluating those.
</verification_context>

<check_dimensions>
- Requirement coverage: Does the plan address the task description?
- Task completeness: Do tasks have files, action, verify, done fields?
- Key links: Are referenced files real?
- Scope sanity: Is this appropriately sized for a quick task (1-3 tasks)?
- must_haves derivation: Are must_haves traceable to the task description?

Skip: context compliance (no CONTEXT.md), cross-plan deps (single plan), ROADMAP alignment
</check_dimensions>

<expected_output>
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
",
  subagent_type="gsd-plan-checker",
  model="{checker_model}",
  description="Check quick plan: ${issue_title}"
)
```

If issues found and iteration < 2: spawn planner revision, then re-check.
If iteration >= 2: offer force proceed or abort.

7. **Spawn executor (task agent):**
```
Task(
  prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
- ${QUICK_DIR}/${next_num}-PLAN.md (Plan)
</files_to_read>

Execute quick task ${next_num}.

<constraints>
- Execute all tasks in the plan
- Commit each task atomically
- Create summary at: ${QUICK_DIR}/${next_num}-SUMMARY.md
- Do NOT update ROADMAP.md or STATE.md (GSD owns .planning/ files)
</constraints>
",
  subagent_type="gsd-executor",
  model="{executor_model}",
  description="Execute: ${issue_title}"
)
```

8. **Verify summary (gsd-tools):**
```bash
VERIFY_RESULT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs verify-summary "${QUICK_DIR}/${next_num}-SUMMARY.md")
```
Parse JSON result. Use `passed` field for go/no-go. Checks summary existence, files created, and commits.

9. **(If --full) Spawn verifier:**
```
Task(
  prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
- ${QUICK_DIR}/${next_num}-PLAN.md (Plan)
</files_to_read>

Verify quick task goal achievement.
Task directory: ${QUICK_DIR}
Task goal: ${TASK_DESCRIPTION}

Check must_haves against actual codebase. Create VERIFICATION.md at ${QUICK_DIR}/${next_num}-VERIFICATION.md.",
  subagent_type="gsd-verifier",
  model="{verifier_model}",
  description="Verify: ${issue_title}"
)
```

10. **Post-execution artifact verification (non-blocking):**
```bash
ARTIFACT_CHECK=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs verify artifacts "${QUICK_DIR}/${next_num}-PLAN.md" 2>/dev/null || echo '{"passed":true}')
KEYLINK_CHECK=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs verify key-links "${QUICK_DIR}/${next_num}-PLAN.md" 2>/dev/null || echo '{"passed":true}')
```
Non-blocking: if either check flags issues, include them in the PR description as warnings. Do not halt the pipeline.

11. **Commit artifacts:**
```bash
node ~/.claude/get-shit-done/bin/gsd-tools.cjs commit "docs(quick-${next_num}): ${issue_title}" --files ${file_list}
```

Update state (at `${REPO_ROOT}/.mgw/active/`): gsd_artifacts.path = $QUICK_DIR, pipeline_stage = "verifying".

**Retry loop — on execution failure:**

If any step above fails (executor or verifier agent returns error, summary missing, etc.), capture the error and apply retry logic:

```bash
# On failure — classify and decide whether to retry
FAILURE_CLASS=$(node -e "
const { classifyFailure, canRetry, incrementRetry, getBackoffMs } = require('./lib/retry.cjs');
const { loadActiveIssue } = require('./lib/state.cjs');
const fs = require('fs'), path = require('path');

const activeDir = path.join(process.cwd(), '.mgw', 'active');
const files = fs.readdirSync(activeDir);
const file = files.find(f => f.startsWith('${ISSUE_NUMBER}-') && f.endsWith('.json'));
const filePath = path.join(activeDir, file);
let issueState = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

// Classify the failure from the error context
const error = { message: '${EXECUTION_ERROR_MESSAGE}' };
const result = classifyFailure(error);
console.error('Failure classified as: ' + result.class + ' — ' + result.reason);

// Persist failure class to state
issueState.last_failure_class = result.class;

if (result.class === 'transient' && canRetry(issueState)) {
  const backoff = getBackoffMs(issueState.retry_count || 0);
  issueState = incrementRetry(issueState);
  fs.writeFileSync(filePath, JSON.stringify(issueState, null, 2));
  // Output: backoff ms so shell can sleep
  console.log('retry:' + backoff + ':' + result.class);
} else {
  // Permanent failure or retries exhausted — dead-letter
  issueState.dead_letter = true;
  fs.writeFileSync(filePath, JSON.stringify(issueState, null, 2));
  console.log('dead_letter:' + result.class);
}
")

case "$FAILURE_CLASS" in
  retry:*)
    BACKOFF_MS=$(echo "$FAILURE_CLASS" | cut -d':' -f2)
    BACKOFF_SEC=$(( (BACKOFF_MS + 999) / 1000 ))
    echo "MGW: Transient failure detected — retrying in ${BACKOFF_SEC}s (retry ${RETRY_COUNT})..."
    sleep "$BACKOFF_SEC"
    RETRY_COUNT=$((RETRY_COUNT + 1))
    # Loop back to retry
    ;;
  dead_letter:*)
    FAILURE_CLASS_NAME=$(echo "$FAILURE_CLASS" | cut -d':' -f2)
    EXECUTION_SUCCEEDED=false
    # Break out of retry loop — handled in post_execution_update
    break
    ;;
esac
```

On successful execution (EXECUTION_SUCCEEDED=true): break out of retry loop, clear last_failure_class:
```bash
node -e "
const fs = require('fs'), path = require('path');
const activeDir = path.join(process.cwd(), '.mgw', 'active');
const files = fs.readdirSync(activeDir);
const file = files.find(f => f.startsWith('${ISSUE_NUMBER}-') && f.endsWith('.json'));
const filePath = path.join(activeDir, file);
const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
state.last_failure_class = null;
fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
" 2>/dev/null || true
```
</step>

<step name="execute_gsd_milestone">
**Execute GSD pipeline (new-milestone route):**

Only run this step if gsd_route is "gsd:new-milestone".

**Retry loop initialization** (same pattern as execute_gsd_quick):
```bash
RETRY_COUNT=$(node -e "
const { loadActiveIssue } = require('./lib/state.cjs');
const state = loadActiveIssue(${ISSUE_NUMBER});
console.log((state && typeof state.retry_count === 'number') ? state.retry_count : 0);
" 2>/dev/null || echo "0")
EXECUTION_SUCCEEDED=false
```

**Begin retry loop** — wraps the phase-execution loop (steps 2b–2e below) with transient-failure retry. Step 2 (milestone roadmap creation) is NOT wrapped in the retry loop — roadmap creation failures are always treated as permanent (require human intervention).

This is the most complex path. The orchestrator needs to:

**Resolve models for milestone agents:**
```bash
PLANNER_MODEL=$(node -e "process.stdout.write(require('./lib/gsd-adapter.cjs').resolveModel('gsd-planner'))")
EXECUTOR_MODEL=$(node -e "process.stdout.write(require('./lib/gsd-adapter.cjs').resolveModel('gsd-executor'))")
VERIFIER_MODEL=$(node -e "process.stdout.write(require('./lib/gsd-adapter.cjs').resolveModel('gsd-verifier'))")
```

1. **Discussion phase trigger for large-scope issues:**

If the issue was triaged with large scope and `gsd_route == "gsd:new-milestone"`, post
a scope proposal comment and set the discussing stage before proceeding to phase execution:

```bash
DISCUSS_TIMESTAMP=$(node -e "try{process.stdout.write(require('./lib/gsd-adapter.cjs').getTimestamp())}catch(e){process.stdout.write(new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'))}")

# Build scope breakdown from triage data
SCOPE_SIZE="${triage.scope.size}"
SCOPE_BREAKDOWN="${triage.scope.files formatted as table rows}"
PHASE_COUNT="TBD (determined by roadmapper)"

# Post scope proposal comment using template from github.md
# Use Scope Proposal Comment template from @~/.claude/commands/mgw/workflows/github.md
```

Set pipeline_stage to "discussing" and apply "mgw:discussing" label:
```bash
remove_mgw_labels_and_apply ${ISSUE_NUMBER} "mgw:discussing"
```

Present to user:
```
AskUserQuestion(
  header: "Scope Proposal Posted",
  question: "A scope proposal has been posted to GitHub. Proceed with autonomous roadmap creation, or wait for stakeholder feedback?",
  options: [
    { label: "Proceed", description: "Continue with roadmap creation now" },
    { label: "Wait", description: "Pipeline paused until stakeholder approves scope" }
  ]
)
```

If wait: stop here. User will re-run /mgw:run after scope is approved.
If proceed: apply "mgw:approved" label and continue.

2. **Create milestone:** Use `gsd-tools init new-milestone` to gather context, then attempt autonomous roadmap creation from issue data:

   ```bash
   MILESTONE_INIT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs init new-milestone 2>/dev/null)
   ```

   Extract requirements from structured issue template fields (BLUF, What's Needed, What's Involved) if present.

   If issue body contains sufficient detail (has clear requirements/scope):
   - Spawn roadmapper agent with issue-derived requirements
   - After roadmap generation, present to user for confirmation checkpoint:
     ```
     AskUserQuestion(
       header: "Milestone Roadmap Generated",
       question: "Review the generated ROADMAP.md. Proceed with execution, revise, or switch to interactive mode?",
       followUp: "Enter: proceed, revise, or interactive"
     )
     ```

   If issue body lacks sufficient detail (no clear structure or too vague):
   - Fall back to interactive mode:
     ```
     The new-milestone route requires more detail than the issue provides.
     Please run: /gsd:new-milestone

     After the milestone is created, run /mgw:run ${ISSUE_NUMBER} again to
     continue the pipeline through execution.
     ```

   Update pipeline_stage to "planning" (at `${REPO_ROOT}/.mgw/active/`).

**Verify ROADMAP.md was created:**
```bash
if [ ! -f ".planning/ROADMAP.md" ]; then
  echo "MGW ERROR: Roadmapper agent did not produce ROADMAP.md. Cannot proceed with milestone execution."
  FAIL_TS=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
  gh issue comment ${ISSUE_NUMBER} --body "> **MGW** · \`pipeline-failed\` · ${FAIL_TS}
> Roadmapper agent did not produce ROADMAP.md. Pipeline cannot continue.
> Re-run with \`/mgw:run ${ISSUE_NUMBER}\` after investigating." 2>/dev/null || true
  # Update pipeline_stage to failed (same pattern as post_execution_update dead_letter block)
  node -e "
const fs = require('fs'), path = require('path');
const activeDir = path.join(process.cwd(), '.mgw', 'active');
const files = fs.readdirSync(activeDir);
const file = files.find(f => f.startsWith('${ISSUE_NUMBER}-') && f.endsWith('.json'));
if (file) {
  const filePath = path.join(activeDir, file);
  const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  state.pipeline_stage = 'failed';
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}
" 2>/dev/null || true
  exit 1
fi
```

2. **If resuming with pipeline_stage = "planning" and ROADMAP.md exists:**
   Discover phases from ROADMAP and run the full per-phase GSD lifecycle:

   ```bash
   ROADMAP_ANALYSIS=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs roadmap analyze)
   # Parse ROADMAP_ANALYSIS JSON for list of phases:
   # Each phase has: phase_number, phase_name, phase_slug
   PHASE_LIST=$(echo "$ROADMAP_ANALYSIS" | python3 -c "
   import json, sys
   data = json.load(sys.stdin)
   for p in data.get('phases', []):
       print(f\"{p['number']}|{p['name']}|{p.get('slug', '')}\")
   ")
   ```

   For each phase in order:

   **a. Scaffold phase directory, then init:**

   `init plan-phase` requires the phase directory to exist before it can locate it.
   Use `scaffold phase-dir` first (which creates the directory from ROADMAP data),
   then call `init plan-phase` to get planner/checker model assignments.

   ```bash
   # Generate slug from phase name (lowercase, hyphens, no special chars)
   PHASE_SLUG=$(echo "${PHASE_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')

   # Scaffold creates the directory and returns the path
   SCAFFOLD=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs scaffold phase-dir --phase "${PHASE_NUMBER}" --name "${PHASE_SLUG}")
   phase_dir=$(echo "$SCAFFOLD" | python3 -c "import json,sys; print(json.load(sys.stdin)['directory'])")

   # Now init plan-phase can find the directory for model resolution
   PHASE_INIT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs init plan-phase "${PHASE_NUMBER}")
   # Parse PHASE_INIT JSON for: planner_model, checker_model
   ```

   **b. Spawn planner agent (gsd:plan-phase):**
   ```
   Task(
     prompt="
   <files_to_read>
   - ./CLAUDE.md (Project instructions -- if exists, follow all guidelines)
   - .agents/skills/ (Project skills -- if dir exists, list skills, read SKILL.md for each, follow relevant rules)
   - .planning/ROADMAP.md (Phase definitions and requirements)
   - .planning/STATE.md (If exists -- project state)
   </files_to_read>

   You are the GSD planner. Plan phase ${PHASE_NUMBER}: ${PHASE_NAME}.

   Read and follow the plan-phase workflow:
   @~/.claude/get-shit-done/workflows/plan-phase.md

   Phase directory: ${phase_dir}
   Phase number: ${PHASE_NUMBER}

   Create PLAN.md file(s) in the phase directory. Each plan must have:
   - Frontmatter with phase, plan, type, wave, depends_on, files_modified, autonomous, requirements, must_haves
   - Objective, context, tasks, verification, success criteria, output sections
   - Each task with files, action, verify, done fields

   Commit the plan files when done.
   ",
     subagent_type="gsd-planner",
     model="${PLANNER_MODEL}",
     description="Plan phase ${PHASE_NUMBER}: ${PHASE_NAME}"
   )
   ```

   **c. Verify plans exist:**
   ```bash
   PLAN_COUNT=$(ls ${phase_dir}/*-PLAN.md 2>/dev/null | wc -l)
   if [ "$PLAN_COUNT" -eq 0 ]; then
     echo "ERROR: No plans created for phase ${PHASE_NUMBER}. Skipping phase execution."
     # Post error comment and continue to next phase
     gh issue comment ${ISSUE_NUMBER} --body "> **MGW** \`phase-error\` Phase ${PHASE_NUMBER} planning produced no plans. Skipping." 2>/dev/null || true
     continue
   fi
   ```

   **d. Init execute-phase and spawn executor agent (gsd:execute-phase):**
   ```bash
   EXEC_INIT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs init execute-phase "${PHASE_NUMBER}")
   # Parse EXEC_INIT JSON for: executor_model, verifier_model, phase_dir, plans, incomplete_plans, plan_count
   ```
   ```
   Task(
     prompt="
   <files_to_read>
   - ./CLAUDE.md (Project instructions -- if exists, follow all guidelines)
   - .agents/skills/ (Project skills -- if dir exists, list skills, read SKILL.md for each, follow relevant rules)
   - ${phase_dir}/*-PLAN.md (Plans to execute)
   </files_to_read>

   You are the GSD executor. Execute all plans for phase ${PHASE_NUMBER}: ${PHASE_NAME}.

   Read and follow the execute-phase workflow:
   @~/.claude/get-shit-done/workflows/execute-phase.md

   Phase: ${PHASE_NUMBER}
   Phase directory: ${phase_dir}

   Execute each plan's tasks in wave order. For each plan:
   1. Execute all tasks
   2. Commit each task atomically
   3. Create SUMMARY.md in the phase directory

   Do NOT update ROADMAP.md or STATE.md directly -- those are managed by GSD tools.
   ",
     subagent_type="gsd-executor",
     model="${EXECUTOR_MODEL}",
     description="Execute phase ${PHASE_NUMBER}: ${PHASE_NAME}"
   )
   ```

   **e. Spawn verifier agent (gsd:verify-phase):**
   ```
   Task(
     prompt="
   <files_to_read>
   - ./CLAUDE.md (Project instructions -- if exists, follow all guidelines)
   - .agents/skills/ (Project skills -- if dir exists, list skills, read SKILL.md for each, follow relevant rules)
   - ${phase_dir}/*-PLAN.md (Plans with must_haves)
   - ${phase_dir}/*-SUMMARY.md (Execution summaries)
   </files_to_read>

   Verify phase ${PHASE_NUMBER}: ${PHASE_NAME} goal achievement.

   Read and follow the verify-phase workflow:
   @~/.claude/get-shit-done/workflows/verify-phase.md

   Phase: ${PHASE_NUMBER}
   Phase directory: ${phase_dir}

   Check must_haves from plan frontmatter against actual codebase.
   Create VERIFICATION.md in the phase directory.
   ",
     subagent_type="gsd-verifier",
     model="${VERIFIER_MODEL}",
     description="Verify phase ${PHASE_NUMBER}: ${PHASE_NAME}"
   )
   ```

   **f. Post phase-complete comment directly (no sub-agent):**
   ```bash
   PHASE_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
   VERIFICATION_STATUS=$(grep -m1 "^## " "${phase_dir}/"*-VERIFICATION.md 2>/dev/null | head -1 || echo "Verification complete")
   PHASE_BODY=$(cat <<COMMENTEOF
> **MGW** · \`phase-complete\` · ${PHASE_TIMESTAMP}
> ${MILESTONE_CONTEXT}

### Phase ${PHASE_NUMBER} Complete — ${PHASE_NAME}

Execution complete. See ${phase_dir} for plans, summaries, and verification.

**Verification:** ${VERIFICATION_STATUS}
COMMENTEOF
)
   gh issue comment ${ISSUE_NUMBER} --body "$PHASE_BODY" 2>/dev/null || true
   ```

   **Retry loop — on phase execution failure** (apply same pattern as execute_gsd_quick):

   If a phase's executor or verifier fails, capture the error and apply retry logic via `classifyFailure()`, `canRetry()`, `incrementRetry()`, and `getBackoffMs()` from `lib/retry.cjs`. Only the failing phase is retried (restart from step 2b for that phase). If the failure is transient and `canRetry()` is true: sleep backoff, call `incrementRetry()`, loop. If permanent or retries exhausted: set `dead_letter = true`, set `last_failure_class`, break the retry loop.

   On successful completion of all phases: clear `last_failure_class`, set `EXECUTION_SUCCEEDED=true`.

   After ALL phases complete → update pipeline_stage to "verifying" (at `${REPO_ROOT}/.mgw/active/`).
</step>

<step name="post_execution_update">
**Post execution-complete comment on issue (or failure comment if dead_letter):**

Read `dead_letter` and `last_failure_class` from current issue state:
```bash
DEAD_LETTER=$(node -e "
const { loadActiveIssue } = require('./lib/state.cjs');
const state = loadActiveIssue(${ISSUE_NUMBER});
console.log(state && state.dead_letter === true ? 'true' : 'false');
" 2>/dev/null || echo "false")

LAST_FAILURE_CLASS=$(node -e "
const { loadActiveIssue } = require('./lib/state.cjs');
const state = loadActiveIssue(${ISSUE_NUMBER});
console.log((state && state.last_failure_class) ? state.last_failure_class : 'unknown');
" 2>/dev/null || echo "unknown")
```

**If dead_letter === true — post failure comment and halt:**
```bash
if [ "$DEAD_LETTER" = "true" ]; then
  FAIL_TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
  RETRY_COUNT_CURRENT=$(node -e "
const { loadActiveIssue } = require('./lib/state.cjs');
const state = loadActiveIssue(${ISSUE_NUMBER});
console.log((state && typeof state.retry_count === 'number') ? state.retry_count : 0);
" 2>/dev/null || echo "0")

  FAIL_BODY=$(cat <<COMMENTEOF
> **MGW** · \`pipeline-failed\` · ${FAIL_TIMESTAMP}
> ${MILESTONE_CONTEXT}

### Pipeline Failed

Issue #${ISSUE_NUMBER} — ${issue_title}

| | |
|---|---|
| **Failure class** | \`${LAST_FAILURE_CLASS}\` |
| **Retries attempted** | ${RETRY_COUNT_CURRENT} of 3 |
| **Status** | Dead-lettered — requires human intervention |

**Failure class meaning:**
- \`transient\` — retry exhausted (rate limit, network, or overload)
- \`permanent\` — unrecoverable (auth, missing deps, bad config)
- \`needs-info\` — issue is ambiguous or incomplete

**To retry after resolving root cause:**
\`\`\`
/mgw:run ${ISSUE_NUMBER} --retry
\`\`\`
COMMENTEOF
)

  gh issue comment ${ISSUE_NUMBER} --body "$FAIL_BODY" 2>/dev/null || true
  gh issue edit ${ISSUE_NUMBER} --add-label "pipeline-failed" 2>/dev/null || true
  gh label create "pipeline-failed" --description "Pipeline execution failed" --color "d73a4a" --force 2>/dev/null || true

  # Update pipeline_stage to failed
  node -e "
const fs = require('fs'), path = require('path');
const activeDir = path.join(process.cwd(), '.mgw', 'active');
const files = fs.readdirSync(activeDir);
const file = files.find(f => f.startsWith('${ISSUE_NUMBER}-') && f.endsWith('.json'));
const filePath = path.join(activeDir, file);
const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
state.pipeline_stage = 'failed';
fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
" 2>/dev/null || true

  echo "MGW: Pipeline dead-lettered for #${ISSUE_NUMBER} (class: ${LAST_FAILURE_CLASS}). Use --retry after fixing root cause."
  exit 1
fi
```

**Otherwise — post execution-complete comment:**

After GSD execution completes successfully, post a structured update before creating the PR:

```bash
COMMIT_COUNT=$(git rev-list ${DEFAULT_BRANCH}..HEAD --count 2>/dev/null || echo "0")
TEST_STATUS=$(npm test 2>&1 >/dev/null && echo "passing" || echo "failing")
FILE_CHANGES=$(git diff --stat ${DEFAULT_BRANCH}..HEAD 2>/dev/null | tail -1)
EXEC_TIMESTAMP=$(node -e "try{process.stdout.write(require('./lib/gsd-adapter.cjs').getTimestamp())}catch(e){process.stdout.write(new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'))}")
```

Post the execution-complete comment directly (no sub-agent — guarantees it happens):

```bash
EXEC_BODY=$(cat <<COMMENTEOF
> **MGW** · \`execution-complete\` · ${EXEC_TIMESTAMP}
> ${MILESTONE_CONTEXT}

### Execution Complete

${COMMIT_COUNT} atomic commit(s) on branch \`${BRANCH_NAME}\`.

**Changes:** ${FILE_CHANGES}

**Tests:** ${TEST_STATUS}

Preparing pull request.
COMMENTEOF
)

gh issue comment ${ISSUE_NUMBER} --body "$EXEC_BODY" 2>/dev/null || true
```

Update pipeline_stage to "pr-pending" (at `${REPO_ROOT}/.mgw/active/`).
</step>
