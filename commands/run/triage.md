---
name: mgw:run/triage
description: Validate input, load state, preflight comment check, and post triage update
---

<step name="validate_and_load">
**Validate input and load state:**

Store repo root and default branch (used throughout):
```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
DEFAULT=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
```

Parse $ARGUMENTS for issue number and flags. If issue number missing:
```
AskUserQuestion(
  header: "Issue Number Required",
  question: "Which issue number do you want to run the pipeline for?",
  followUp: null
)
```

Extract flags from $ARGUMENTS:
```bash
RETRY_FLAG=false
for ARG in $ARGUMENTS; do
  case "$ARG" in
    --retry) RETRY_FLAG=true ;;
  esac
done
```

Check for existing state: `${REPO_ROOT}/.mgw/active/${ISSUE_NUMBER}-*.json`

If no state file exists → issue not triaged yet. Run triage inline:
  - Inform user: "Issue #${ISSUE_NUMBER} hasn't been triaged. Running triage first."
  - Execute the mgw:issue triage flow (steps from issue.md) inline.
  - After triage, reload state file.

If state file exists → load it. **Run migrateProjectState() to ensure retry and checkpoint fields exist:**
```bash
node -e "
const { migrateProjectState } = require('./lib/state.cjs');
migrateProjectState();
" 2>/dev/null || true
```

**Checkpoint detection — check for resumable progress before stage routing:**

After loading state and running migration, detect whether a prior pipeline run left
a checkpoint with meaningful progress (beyond triage). If found, present the user
with Resume/Fresh/Skip options before proceeding.

```bash
# Detect checkpoint with progress beyond triage
CHECKPOINT_DATA=$(node -e "
const { detectCheckpoint, resumeFromCheckpoint } = require('./lib/state.cjs');
const cp = detectCheckpoint(${ISSUE_NUMBER});
if (!cp) {
  console.log('none');
} else {
  const resume = resumeFromCheckpoint(${ISSUE_NUMBER});
  console.log(JSON.stringify(resume));
}
" 2>/dev/null || echo "none")
```

If checkpoint is found (`CHECKPOINT_DATA !== "none"`):

Parse the checkpoint data and display to the user:
```bash
CHECKPOINT_STEP=$(echo "$CHECKPOINT_DATA" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
console.log(d.checkpoint.pipeline_step);
")
RESUME_ACTION=$(echo "$CHECKPOINT_DATA" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
console.log(d.resumeAction);
")
RESUME_STAGE=$(echo "$CHECKPOINT_DATA" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
console.log(d.resumeStage);
")
COMPLETED_STEPS=$(echo "$CHECKPOINT_DATA" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
console.log(d.completedSteps.join(', '));
")
ARTIFACTS_COUNT=$(echo "$CHECKPOINT_DATA" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
console.log(d.checkpoint.artifacts.length);
")
STARTED_AT=$(echo "$CHECKPOINT_DATA" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
console.log(d.checkpoint.started_at || 'unknown');
")
UPDATED_AT=$(echo "$CHECKPOINT_DATA" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
console.log(d.checkpoint.updated_at || 'unknown');
")
```

Display checkpoint state and prompt user:
```
AskUserQuestion(
  header: "Checkpoint Detected for #${ISSUE_NUMBER}",
  question: "A prior pipeline run left progress at step '${CHECKPOINT_STEP}'.

| | |
|---|---|
| **Last step** | ${CHECKPOINT_STEP} |
| **Completed steps** | ${COMPLETED_STEPS} |
| **Artifacts** | ${ARTIFACTS_COUNT} file(s) |
| **Resume action** | ${RESUME_ACTION} → stage: ${RESUME_STAGE} |
| **Started** | ${STARTED_AT} |
| **Last updated** | ${UPDATED_AT} |

How would you like to proceed?",
  options: [
    { label: "Resume", description: "Resume from checkpoint — skip completed steps (${COMPLETED_STEPS}), jump to ${RESUME_STAGE}" },
    { label: "Fresh", description: "Discard checkpoint and re-run pipeline from scratch" },
    { label: "Skip", description: "Skip this issue entirely" }
  ]
)
```

Handle user choice:

| Choice | Action |
|--------|--------|
| **Resume** | Load checkpoint context. Set `pipeline_stage` in state to `${RESUME_STAGE}`. Log: "MGW: Resuming #${ISSUE_NUMBER} from checkpoint (step: ${CHECKPOINT_STEP}, action: ${RESUME_ACTION})." Skip triage/worktree stages that already completed and jump directly to the resume stage in the pipeline. The `resume.context` object carries step-specific data (e.g., `quick_dir`, `plan_num`, `phase_number`) needed by the target stage. |
| **Fresh** | Clear checkpoint via `clearCheckpoint()`. Reset `pipeline_stage` to `"triaged"`. Log: "MGW: Checkpoint cleared for #${ISSUE_NUMBER}. Starting fresh." Continue with normal pipeline flow. |
| **Skip** | Log: "MGW: Skipping #${ISSUE_NUMBER} per user request." STOP pipeline. |

```bash
case "$USER_CHOICE" in
  Resume)
    # Load resume context and jump to the appropriate stage
    node -e "
    const fs = require('fs'), path = require('path');
    const activeDir = path.join(process.cwd(), '.mgw', 'active');
    const files = fs.readdirSync(activeDir);
    const file = files.find(f => f.startsWith('${ISSUE_NUMBER}-') && f.endsWith('.json'));
    const filePath = path.join(activeDir, file);
    const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // The pipeline_stage already reflects prior progress — do not overwrite
    // unless the resume target is more advanced than current stage
    console.log('Resuming from checkpoint: ' + JSON.stringify(state.checkpoint.resume));
    " 2>/dev/null || true
    # Set RESUME_MODE=true — downstream stages check this flag to skip completed work
    RESUME_MODE=true
    RESUME_CONTEXT="${CHECKPOINT_DATA}"
    ;;
  Fresh)
    node -e "
    const { clearCheckpoint } = require('./lib/state.cjs');
    clearCheckpoint(${ISSUE_NUMBER});
    console.log('Checkpoint cleared for #${ISSUE_NUMBER}');
    " 2>/dev/null || true
    # Reset pipeline_stage to triaged for fresh start
    node -e "
    const fs = require('fs'), path = require('path');
    const activeDir = path.join(process.cwd(), '.mgw', 'active');
    const files = fs.readdirSync(activeDir);
    const file = files.find(f => f.startsWith('${ISSUE_NUMBER}-') && f.endsWith('.json'));
    const filePath = path.join(activeDir, file);
    const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    state.pipeline_stage = 'triaged';
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    " 2>/dev/null || true
    RESUME_MODE=false
    ;;
  Skip)
    echo "MGW: Skipping #${ISSUE_NUMBER} per user request."
    exit 0
    ;;
esac
```

If no checkpoint found (or checkpoint is at triage step only), continue with
normal pipeline stage routing below.

**Initialize checkpoint** when pipeline first transitions past triage:
```bash
# Checkpoint initialization — called once when pipeline execution begins.
# Sets pipeline_step to "triage" with route selection progress.
# Subsequent stages update the checkpoint via updateCheckpoint().
# All checkpoint writes are atomic (write to .tmp then rename).
node -e "
const { updateCheckpoint } = require('./lib/state.cjs');
updateCheckpoint(${ISSUE_NUMBER}, {
  pipeline_step: 'triage',
  step_progress: {
    comment_check_done: true,
    route_selected: '${GSD_ROUTE}'
  },
  resume: {
    action: 'begin-execution',
    context: { gsd_route: '${GSD_ROUTE}', branch: '${BRANCH_NAME}' }
  }
});
" 2>/dev/null || true
```
Check pipeline_stage:
  - "triaged" → proceed to GSD execution
  - "planning" / "executing" → resume from where we left off
  - "blocked" → "Pipeline for #${ISSUE_NUMBER} is blocked by a stakeholder comment. Review the issue comments, resolve the blocker, then re-run."
  - "pr-created" / "done" → "Pipeline already completed for #${ISSUE_NUMBER}. Run /mgw:sync to reconcile."
  - "failed" → Check for --retry flag:
    - If --retry NOT present:
      ```
      Pipeline for #${ISSUE_NUMBER} has failed (failure class: ${last_failure_class || "unknown"}).
      dead_letter: ${dead_letter}

      To retry:   /mgw:run ${ISSUE_NUMBER} --retry
      To inspect: /mgw:issue ${ISSUE_NUMBER}
      ```
      STOP.
    - If --retry present and dead_letter === true:
      ```bash
      # Clear dead_letter and reset retry state via resetRetryState()
      node -e "
      const { loadActiveIssue } = require('./lib/state.cjs');
      const { resetRetryState } = require('./lib/retry.cjs');
      const fs = require('fs'), path = require('path');
      const activeDir = path.join(process.cwd(), '.mgw', 'active');
      const files = fs.readdirSync(activeDir);
      const file = files.find(f => f.startsWith('${ISSUE_NUMBER}-') && f.endsWith('.json'));
      if (!file) { console.error('No state file for #${ISSUE_NUMBER}'); process.exit(1); }
      const filePath = path.join(activeDir, file);
      const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const reset = resetRetryState(state);
      reset.pipeline_stage = 'triaged';
      fs.writeFileSync(filePath, JSON.stringify(reset, null, 2));
      console.log('Retry state cleared for #${ISSUE_NUMBER}');
      "
      # Remove pipeline-failed label
      gh issue edit ${ISSUE_NUMBER} --remove-label "pipeline-failed" 2>/dev/null || true
      ```
      Log: "MGW: dead_letter cleared for #${ISSUE_NUMBER} via --retry flag. Re-queuing."
      Continue pipeline (treat as triaged).
    - If --retry present and dead_letter !== true (manual retry of non-dead-lettered failure):
      ```bash
      node -e "
      const { resetRetryState } = require('./lib/retry.cjs');
      const fs = require('fs'), path = require('path');
      const activeDir = path.join(process.cwd(), '.mgw', 'active');
      const files = fs.readdirSync(activeDir);
      const file = files.find(f => f.startsWith('${ISSUE_NUMBER}-') && f.endsWith('.json'));
      if (!file) { console.error('No state file'); process.exit(1); }
      const filePath = path.join(activeDir, file);
      const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const reset = resetRetryState(state);
      reset.pipeline_stage = 'triaged';
      fs.writeFileSync(filePath, JSON.stringify(reset, null, 2));
      console.log('Retry state reset for #${ISSUE_NUMBER}');
      "
      gh issue edit ${ISSUE_NUMBER} --remove-label "pipeline-failed" 2>/dev/null || true
      ```
      Continue pipeline.
  - "needs-info" → Check for --force flag in $ARGUMENTS:
    If --force NOT present:
      ```
      Pipeline for #${ISSUE_NUMBER} is blocked by triage gate (needs-info).
      The issue requires more detail before execution can begin.

      To override: /mgw:run ${ISSUE_NUMBER} --force
      To review:   /mgw:issue ${ISSUE_NUMBER} (re-triage after updating the issue)
      ```
      STOP.
    If --force present:
      Log warning: "MGW: WARNING — Overriding needs-info gate for #${ISSUE_NUMBER}. Proceeding with --force."
      Update state: pipeline_stage = "triaged", add override_log entry.
      Continue pipeline.
  - "needs-security-review" → Check for --security-ack flag in $ARGUMENTS:
    If --security-ack NOT present:
      ```
      Pipeline for #${ISSUE_NUMBER} requires security review.
      This issue was flagged as high security risk during triage.

      To acknowledge and proceed: /mgw:run ${ISSUE_NUMBER} --security-ack
      To review:                  /mgw:issue ${ISSUE_NUMBER} (re-triage)
      ```
      STOP.
    If --security-ack present:
      Log warning: "MGW: WARNING — Acknowledging security risk for #${ISSUE_NUMBER}. Proceeding with --security-ack."
      Update state: pipeline_stage = "triaged", add override_log entry.
      Continue pipeline.

**Route selection via gsd-adapter (runs after loading issue state):**

Use `selectGsdRoute()` from `lib/gsd-adapter.cjs` to determine the GSD execution
path. This centralizes the routing decision so it is auditable and consistent
across all pipeline commands:

```bash
GSD_ROUTE=$(node -e "
const { selectGsdRoute } = require('./lib/gsd-adapter.cjs');
const issue = $(cat ${REPO_ROOT}/.mgw/active/${STATE_FILE});
const { loadProjectState } = require('./lib/state.cjs');
const projectState = loadProjectState() || {};
const route = selectGsdRoute(issue, projectState);
console.log(route);
")
# GSD_ROUTE is one of: quick | plan-phase | diagnose | execute-only | verify-only
```

**Cross-milestone detection (runs after loading issue state):**

Check if this issue belongs to a non-active GSD milestone:

```bash
CROSS_MILESTONE_WARN=$(node -e "
const { loadProjectState, resolveActiveMilestoneIndex } = require('./lib/state.cjs');
const state = loadProjectState();
if (!state) { console.log('none'); process.exit(0); }

const activeGsdId = state.active_gsd_milestone;

// Find this issue's milestone in project.json
const issueNum = ${ISSUE_NUMBER};
let issueMilestone = null;
for (const m of (state.milestones || [])) {
  if ((m.issues || []).some(i => i.github_number === issueNum)) {
    issueMilestone = m;
    break;
  }
}

if (!issueMilestone) { console.log('none'); process.exit(0); }

const issueGsdId = issueMilestone.gsd_milestone_id;

// No active_gsd_milestone set (legacy schema): no warning
if (!activeGsdId) { console.log('none'); process.exit(0); }

// Issue is in the active milestone: no warning
if (issueGsdId === activeGsdId) { console.log('none'); process.exit(0); }

// Issue is in a different milestone
const gsdRoute = '${GSD_ROUTE}';
if (gsdRoute === 'quick' || gsdRoute === 'gsd:quick') {
  console.log('isolation:' + issueMilestone.name + ':' + (issueGsdId || 'unlinked'));
} else {
  console.log('warn:' + issueMilestone.name + ':' + (issueGsdId || 'unlinked') + ':' + activeGsdId);
}
")

case "$CROSS_MILESTONE_WARN" in
  none)
    # No cross-milestone issue — proceed normally
    ;;
  isolation:*)
    MILESTONE_NAME=$(echo "$CROSS_MILESTONE_WARN" | cut -d':' -f2)
    GSD_ID=$(echo "$CROSS_MILESTONE_WARN" | cut -d':' -f3)

    # Re-validate route against live GitHub labels (project.json may be stale from triage time)
    LIVE_LABELS=$(gh issue view ${ISSUE_NUMBER} --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null || echo "")
    QUICK_CONFIRMED=false
    if echo "$LIVE_LABELS" | grep -qiE "gsd-route:quick|gsd:quick|quick"; then
      QUICK_CONFIRMED=true
    fi

    if [ "$QUICK_CONFIRMED" = "true" ]; then
      echo ""
      echo "NOTE: Issue #${ISSUE_NUMBER} belongs to milestone '${MILESTONE_NAME}' (GSD: ${GSD_ID})"
      echo "      Confirmed gsd:quick via live labels — running in isolation."
      echo ""
    else
      # Route mismatch: project.json says quick but labels don't confirm it
      echo ""
      echo "⚠️  Route mismatch for cross-milestone issue #${ISSUE_NUMBER}:"
      echo "   project.json route: quick (set at triage time)"
      echo "   Live GitHub labels: ${LIVE_LABELS:-none}"
      echo "   Labels do not confirm gsd:quick — treating as plan-phase (requires milestone context)."
      echo ""
      echo "Options:"
      echo "  1) Switch active milestone to '${GSD_ID}' and continue"
      echo "  2) Re-triage this issue (/mgw:issue ${ISSUE_NUMBER}) to update its route"
      echo "  3) Abort"
      echo ""
      read -p "Choice [1/2/3]: " ROUTE_MISMATCH_CHOICE
      case "$ROUTE_MISMATCH_CHOICE" in
        1)
          node -e "
const { loadProjectState, writeProjectState } = require('./lib/state.cjs');
const state = loadProjectState();
state.active_gsd_milestone = '${GSD_ID}';
writeProjectState(state);
console.log('Switched active_gsd_milestone to: ${GSD_ID}');
"
          # Validate ROADMAP.md matches (same check as option 1 in warn case)
          ROADMAP_VALID=$(python3 -c "
import os
if not os.path.exists('.planning/ROADMAP.md'):
    print('missing')
else:
    with open('.planning/ROADMAP.md') as f:
        content = f.read()
    print('match' if '${GSD_ID}' in content else 'mismatch')
" 2>/dev/null || echo "missing")
          if [ "$ROADMAP_VALID" != "match" ]; then
            node -e "
const { loadProjectState, writeProjectState } = require('./lib/state.cjs');
const state = loadProjectState();
state.active_gsd_milestone = '$(echo "$CROSS_MILESTONE_WARN" | cut -d':' -f4)';
writeProjectState(state);
" 2>/dev/null || true
            echo "Switch rolled back — ROADMAP.md does not match '${GSD_ID}'."
            echo "Run /gsd:new-milestone to update ROADMAP.md first."
            exit 0
          fi
          ;;
        2)
          echo "Re-triage with: /mgw:issue ${ISSUE_NUMBER}"
          exit 0
          ;;
        *)
          echo "Aborted."
          exit 0
          ;;
      esac
    fi
    ;;
  warn:*)
    ISSUE_MILESTONE=$(echo "$CROSS_MILESTONE_WARN" | cut -d':' -f2)
    ISSUE_GSD=$(echo "$CROSS_MILESTONE_WARN" | cut -d':' -f3)
    ACTIVE_GSD=$(echo "$CROSS_MILESTONE_WARN" | cut -d':' -f4)
    echo ""
    echo "⚠️  Cross-milestone issue detected:"
    echo "   Issue #${ISSUE_NUMBER} belongs to: '${ISSUE_MILESTONE}' (GSD: ${ISSUE_GSD})"
    echo "   Active GSD milestone:              ${ACTIVE_GSD}"
    echo ""
    echo "This issue requires plan-phase work that depends on ROADMAP.md context."
    echo "Running it against the wrong active milestone may produce incorrect plans."
    echo ""
    echo "Options:"
    echo "  1) Switch active milestone to '${ISSUE_GSD}' and continue"
    echo "  2) Continue anyway (not recommended)"
    echo "  3) Abort — run /gsd:new-milestone to set up the correct milestone first"
    echo ""
    read -p "Choice [1/2/3]: " MILESTONE_CHOICE
    case "$MILESTONE_CHOICE" in
      1)
        node -e "
const { loadProjectState, writeProjectState } = require('./lib/state.cjs');
const state = loadProjectState();
state.active_gsd_milestone = '${ISSUE_GSD}';
writeProjectState(state);
console.log('Switched active_gsd_milestone to: ${ISSUE_GSD}');
"
        # Validate ROADMAP.md matches the new active milestone
        ROADMAP_VALID=$(python3 -c "
import os
if not os.path.exists('.planning/ROADMAP.md'):
    print('missing')
else:
    with open('.planning/ROADMAP.md') as f:
        content = f.read()
    print('match' if '${ISSUE_GSD}' in content else 'mismatch')
" 2>/dev/null || echo "missing")
        if [ "$ROADMAP_VALID" = "match" ]; then
          echo "Active milestone updated. ROADMAP.md confirmed for '${ISSUE_GSD}'."
        else
          # Roll back — ROADMAP.md doesn't match
          node -e "
const { loadProjectState, writeProjectState } = require('./lib/state.cjs');
const state = loadProjectState();
state.active_gsd_milestone = '${ACTIVE_GSD}';
writeProjectState(state);
" 2>/dev/null || true
          echo "Switch rolled back — ROADMAP.md does not match '${ISSUE_GSD}'."
          echo "Run /gsd:new-milestone to update ROADMAP.md first."
          exit 0
        fi
        ;;
      2)
        echo "Proceeding with cross-milestone issue (may affect plan quality)."
        ;;
      *)
        echo "Aborted. Run /gsd:new-milestone then /mgw:project to align milestones."
        exit 0
        ;;
    esac
    ;;
esac
```
</step>

<step name="preflight_comment_check">
**Pre-flight comment check — detect new comments since triage:**

Before GSD execution begins, check if new comments have been posted on the issue
since triage. This prevents executing against a stale plan when stakeholders have
posted material changes, blockers, or scope updates.

```bash
# Fetch current comment count from GitHub
CURRENT_COMMENTS=$(gh issue view $ISSUE_NUMBER --json comments --jq '.comments | length' 2>/dev/null || echo "0")
STORED_COMMENTS="${triage.last_comment_count}"  # From state file

# If stored count is missing (pre-comment-tracking state), skip check
if [ -z "$STORED_COMMENTS" ] || [ "$STORED_COMMENTS" = "null" ] || [ "$STORED_COMMENTS" = "0" ]; then
  STORED_COMMENTS=0
fi
```

If new comments detected (`CURRENT_COMMENTS > STORED_COMMENTS`):

1. **Fetch new comment bodies:**
```bash
NEW_COUNT=$(($CURRENT_COMMENTS - $STORED_COMMENTS))
NEW_COMMENTS=$(gh issue view $ISSUE_NUMBER --json comments \
  --jq "[.comments[-${NEW_COUNT}:]] | .[] | {author: .author.login, body: .body, createdAt: .createdAt}" 2>/dev/null)
```

2. **Spawn classification agent (with diagnostic capture):**

<!-- mgw:criticality=advisory  spawn_point=comment-classifier -->
<!-- Advisory: comment classification failure does not block the pipeline.
     If this agent fails, log a warning and treat all new comments as
     informational (safe default — pipeline continues with stale data).

     Graceful degradation pattern:
     ```
     CLASSIFICATION_RESULT=$(wrapAdvisoryAgent(Task(...), 'comment-classifier', {
       issueNumber: ISSUE_NUMBER,
       fallback: '{"classification":"informational","reasoning":"comment classifier unavailable","new_requirements":[],"blocking_reason":""}'
     }))
     ```
-->

**Pre-spawn diagnostic hook:**
```bash
CLASSIFIER_PROMPT="<full classifier prompt assembled above>"
DIAG_CLASSIFIER=$(node -e "
const dh = require('${REPO_ROOT}/lib/diagnostic-hooks.cjs');
const id = dh.beforeAgentSpawn({
  agentType: 'general-purpose',
  issueNumber: ${ISSUE_NUMBER},
  prompt: process.argv[1],
  repoRoot: '${REPO_ROOT}'
});
process.stdout.write(id);
" "$CLASSIFIER_PROMPT" 2>/dev/null || echo "")
```

```
Task(
  prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
</files_to_read>

Classify new comments on GitHub issue #${ISSUE_NUMBER}.

<issue_context>
Title: ${issue_title}
Current pipeline stage: ${pipeline_stage}
GSD Route: ${gsd_route}
Triage scope: ${triage.scope}
</issue_context>

<new_comments>
${NEW_COMMENTS}
</new_comments>

<classification_rules>
Classify each comment (and the overall batch) into ONE of:

- **material** — Comment changes scope, requirements, acceptance criteria, or design.
  Examples: 'Actually we also need to handle X', 'Changed the requirement to Y',
  'Don't forget about edge case Z'.

- **informational** — Status update, acknowledgment, question that doesn't change scope, +1.
  Examples: 'Looks good', 'Thanks for picking this up', 'What's the ETA?', '+1'.

- **blocking** — Explicit instruction to stop or wait. Must contain clear hold language.
  Examples: 'Don't work on this yet', 'Hold off', 'Blocked by external dependency',
  'Wait for design review'.

If ANY comment in the batch is blocking, overall classification is blocking.
If ANY comment is material (and none blocking), overall classification is material.
Otherwise, informational.
</classification_rules>

<output_format>
Return ONLY valid JSON:
{
  \"classification\": \"material|informational|blocking\",
  \"reasoning\": \"Brief explanation of why this classification was chosen\",
  \"new_requirements\": [\"list of new requirements if material, empty array otherwise\"],
  \"blocking_reason\": \"reason if blocking, empty string otherwise\"
}
</output_format>
",
  subagent_type="general-purpose",
  description="Classify comments on #${ISSUE_NUMBER}"
)
```

**Post-spawn diagnostic hook:**
```bash
node -e "
const dh = require('${REPO_ROOT}/lib/diagnostic-hooks.cjs');
dh.afterAgentSpawn({
  diagId: '${DIAG_CLASSIFIER}',
  exitReason: '${CLASSIFICATION_RESULT ? \"success\" : \"error\"}',
  repoRoot: '${REPO_ROOT}'
});
" 2>/dev/null || true
```

3. **React based on classification:**

| Classification | Action |
|---------------|--------|
| **informational** | Log: "MGW: ${NEW_COUNT} new comment(s) reviewed — informational, continuing." Update `triage.last_comment_count` in state file. Continue pipeline. |
| **material** | Log: "MGW: Material comment(s) detected — scope may have changed." Update state: add new_requirements to triage context. Update `triage.last_comment_count`. Re-read issue body for updated requirements. Continue with enriched context (pass new_requirements to planner). Check for security keywords in material comments (see below). |
| **blocking** | Log: "MGW: Blocking comment detected — pipeline paused." Update state: `pipeline_stage = "blocked"`. Apply mgw:blocked label. Post comment on issue: `> **MGW** . \`pipeline-blocked\` . Blocked by stakeholder comment. Reason: ${blocking_reason}`. Stop pipeline execution. |

**Security keyword check for material comments:**
```bash
SECURITY_KEYWORDS="security|vulnerability|CVE|exploit|injection|XSS|CSRF|auth bypass"
if echo "$NEW_COMMENTS" | grep -qiE "$SECURITY_KEYWORDS"; then
  # Add warning to gate_result and prompt user
  echo "MGW: Security-related comment detected. Re-triage recommended."
  # Prompt: "Security-related comment detected. Re-triage recommended. Continue or re-triage?"
fi
```

**When blocking comment detected — apply label:**
```bash
remove_mgw_labels_and_apply ${ISSUE_NUMBER} "mgw:blocked"
```

If no new comments detected, continue normally.
</step>

<step name="post_triage_update">
**Post work-starting comment on issue:**

Note: The triage gate evaluation and triage-complete/triage-blocked comment are now
posted IMMEDIATELY during /mgw:issue. This step posts a separate work-starting
notification when pipeline execution actually begins in run.md.

Gather enrichment data from triage state:
```bash
SCOPE_SIZE="${triage.scope.size}"  # small|medium|large
FILE_COUNT="${triage.scope.file_count}"
SYSTEM_LIST="${triage.scope.systems}"
FILE_LIST="${triage.scope.files}"
CONFLICTS="${triage.conflicts}"
ROUTE_REASONING="${triage.route_reasoning}"
TIMESTAMP=$(node -e "try{process.stdout.write(require('./lib/gsd-adapter.cjs').getTimestamp())}catch(e){process.stdout.write(new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'))}")

# Load milestone/phase context from project.json if available
MILESTONE_CONTEXT=""
if [ -f "${REPO_ROOT}/.mgw/project.json" ]; then
  MILESTONE_CONTEXT=$(node -e "
const { loadProjectState, resolveActiveMilestoneIndex } = require('./lib/state.cjs');
const state = loadProjectState();
if (!state) process.exit(0);
// Search all milestones for the issue (not just active) to handle cross-milestone lookups
for (const m of (state.milestones || [])) {
  for (const i of (m.issues || [])) {
    if (i.github_number === ${ISSUE_NUMBER}) {
      console.log('Milestone: ' + m.name + ' | Phase ' + i.phase_number + ': ' + i.phase_name);
      process.exit(0);
    }
  }
}
" 2>/dev/null || echo "")
fi
```

Post the work-starting comment directly (no sub-agent — guarantees it happens):

```bash
WORK_STARTING_BODY=$(cat <<COMMENTEOF
> **MGW** · \`work-starting\` · ${TIMESTAMP}
> ${MILESTONE_CONTEXT}

### Work Starting

| | |
|---|---|
| **Route** | \`${gsd_route}\` — ${ROUTE_REASONING} |
| **Scope** | ${SCOPE_SIZE} — ${FILE_COUNT} files across ${SYSTEM_LIST} |
| **Conflicts** | ${CONFLICTS} |

Work begins on branch \`${BRANCH_NAME}\`.

<details>
<summary>Affected Files</summary>

${FILE_LIST as bullet points}

</details>
COMMENTEOF
)

gh issue comment ${ISSUE_NUMBER} --body "$WORK_STARTING_BODY" 2>/dev/null || true
```

Log comment in state file (at `${REPO_ROOT}/.mgw/active/`).
</step>
