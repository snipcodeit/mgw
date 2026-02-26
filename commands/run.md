---
name: mgw:run
description: Autonomous pipeline — triage issue through GSD execution to PR creation
argument-hint: "<issue-number>"
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
The autonomous orchestrator. Takes an issue number, ensures it's triaged, then runs
the full GSD pipeline through to PR creation with minimal user interaction.

All work happens in an isolated git worktree — the user's main workspace stays on
the default branch throughout. The worktree is cleaned up after PR creation.

For quick/quick --full: runs entire pipeline in one session.
For new-milestone: runs full milestone flow, posting updates after each phase.

The orchestrator stays thin — all heavy work (analysis, GSD execution, GitHub
operations) happens in task agents with fresh context.

Checkpoints requiring user input:
- Triage confirmation (if not already triaged)
- GSD route confirmation
- Non-autonomous plan checkpoints
- Milestone scope decisions
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<context>
Issue number: $ARGUMENTS

State: .mgw/active/ (if triaged already)
</context>

<process>

<step name="validate_and_load">
**Validate input and load state:**

Store repo root and default branch (used throughout):
```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
DEFAULT=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
```

Parse $ARGUMENTS for issue number. If missing:
```
AskUserQuestion(
  header: "Issue Number Required",
  question: "Which issue number do you want to run the pipeline for?",
  followUp: null
)
```

Check for existing state: `${REPO_ROOT}/.mgw/active/${ISSUE_NUMBER}-*.json`

If no state file exists → issue not triaged yet. Run triage inline:
  - Inform user: "Issue #${ISSUE_NUMBER} hasn't been triaged. Running triage first."
  - Execute the mgw:issue triage flow (steps from issue.md) inline.
  - After triage, reload state file.

If state file exists → load it. Check pipeline_stage:
  - "triaged" → proceed to GSD execution
  - "planning" / "executing" → resume from where we left off
  - "pr-created" / "done" → "Pipeline already completed for #${ISSUE_NUMBER}. Run /mgw:sync to reconcile."
</step>

<step name="create_worktree">
**Create isolated worktree for issue work:**

Derive branch and worktree path:
```bash
BRANCH_NAME="issue/${ISSUE_NUMBER}-${slug}"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/${BRANCH_NAME}"
```

Ensure .worktrees/ is gitignored:
```bash
mkdir -p "$(dirname "${WORKTREE_DIR}")"
if ! git check-ignore -q .worktrees 2>/dev/null; then
  echo ".worktrees/" >> "${REPO_ROOT}/.gitignore"
fi
```

Create worktree with feature branch:
```bash
# If worktree already exists (resume in same session), skip creation
if [ -d "${WORKTREE_DIR}" ]; then
  echo "Worktree exists, reusing"
# If branch already exists (resume from prior session)
elif git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  git worktree add "${WORKTREE_DIR}" "${BRANCH_NAME}"
# New branch (first run)
else
  git worktree add "${WORKTREE_DIR}" -b "${BRANCH_NAME}"
fi
```

**Switch working directory to worktree:**
```bash
cd "${WORKTREE_DIR}"
```

Update state (at `${REPO_ROOT}/.mgw/active/`): add branch to linked_branches.
Add cross-ref (at `${REPO_ROOT}/.mgw/cross-refs.json`): issue → branch.

**PATH CONVENTION for remaining steps:**
- File operations, git commands, and agent work use **relative paths** (CWD = worktree)
- `.mgw/` state operations use **absolute paths**: `${REPO_ROOT}/.mgw/`
  (`.mgw/` is gitignored — it only exists in the main repo, not the worktree)
</step>

<step name="post_triage_update">
**Post structured triage comment on issue:**

Gather enrichment data from triage state:
```bash
SCOPE_SIZE="${triage.scope.size}"  # small|medium|large
FILE_COUNT="${triage.scope.file_count}"
SYSTEM_LIST="${triage.scope.systems}"
FILE_LIST="${triage.scope.files}"
VALIDITY="${triage.validity}"
SECURITY_RISK="${triage.security_notes}"
CONFLICTS="${triage.conflicts}"
ROUTE_REASONING="${triage.route_reasoning}"
TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

# Load milestone/phase context from project.json if available
MILESTONE_CONTEXT=""
if [ -f "${REPO_ROOT}/.mgw/project.json" ]; then
  MILESTONE_CONTEXT=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
for m in p['milestones']:
  for i in m.get('issues', []):
    if i.get('github_number') == ${ISSUE_NUMBER}:
      print(f\"Milestone: {m['name']} | Phase {i['phase_number']}: {i['phase_name']}\")
      break
" 2>/dev/null || echo "")
fi
```

Post the triage comment directly (no sub-agent — guarantees it happens):

```bash
TRIAGE_BODY=$(cat <<COMMENTEOF
> **MGW** · \`triage-complete\` · ${TIMESTAMP}
> ${MILESTONE_CONTEXT}

### Triage Complete

| | |
|---|---|
| **Scope** | ${SCOPE_SIZE} — ${FILE_COUNT} files across ${SYSTEM_LIST} |
| **Validity** | ${VALIDITY} |
| **Security** | ${SECURITY_RISK} |
| **Route** | \`${gsd_route}\` — ${ROUTE_REASONING} |
| **Conflicts** | ${CONFLICTS} |

Work begins on branch \`${BRANCH_NAME}\`.

<details>
<summary>Affected Files</summary>

${FILE_LIST as bullet points}

</details>
COMMENTEOF
)

gh issue comment ${ISSUE_NUMBER} --body "$TRIAGE_BODY" 2>/dev/null || true
```

Log comment in state file (at `${REPO_ROOT}/.mgw/active/`).
</step>

<step name="execute_gsd_quick">
**Execute GSD pipeline (quick / quick --full route):**

Only run this step if gsd_route is "gsd:quick" or "gsd:quick --full".

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

   **Handle missing ROADMAP.md:** Check `roadmap_exists` from init output. If false, create minimal GSD scaffolding so quick workflow has valid state:
   ```bash
   if [ "$roadmap_exists" = "false" ]; then
     mkdir -p .planning/quick
     echo '{"model_profile":"balanced","commit_docs":true}' > .planning/config.json
     cat > .planning/ROADMAP.md << 'HEREDOC'
   # Roadmap
   ## v1.0: MGW-Managed
   Issue-driven development managed by MGW.
   HEREDOC
   fi
   ```
   This creates valid GSD state that survives if someone later uses native GSD commands.

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
- .planning/STATE.md (Project State)
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
- .planning/STATE.md (Project state)
</files_to_read>

Execute quick task ${next_num}.

<constraints>
- Execute all tasks in the plan
- Commit each task atomically
- Create summary at: ${QUICK_DIR}/${next_num}-SUMMARY.md
- Do NOT update ROADMAP.md (quick tasks are separate from planned phases)
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

11. **Update STATE.md** with quick task row in "Quick Tasks Completed" table.

12. **Commit artifacts:**
```bash
node ~/.claude/get-shit-done/bin/gsd-tools.cjs commit "docs(quick-${next_num}): ${issue_title}" --files ${file_list}
```

Update state (at `${REPO_ROOT}/.mgw/active/`): gsd_artifacts.path = $QUICK_DIR, pipeline_stage = "verifying".
</step>

<step name="execute_gsd_milestone">
**Execute GSD pipeline (new-milestone route):**

Only run this step if gsd_route is "gsd:new-milestone".

This is the most complex path. The orchestrator needs to:

**Resolve models for milestone agents:**
```bash
PLANNER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-planner --raw)
EXECUTOR_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-executor --raw)
VERIFIER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-verifier --raw)
```

1. **Create milestone:** Use `gsd-tools init new-milestone` to gather context, then attempt autonomous roadmap creation from issue data:

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

2. **If resuming with pipeline_stage = "planning" and ROADMAP.md exists:**
   Read ROADMAP.md to find phases. For each phase:

   a. Spawn discuss + plan via task agents (following gsd:plan-phase workflow)
   b. Spawn executor(s) via task agents (following gsd:execute-phase workflow)
   c. Spawn verifier
   d. Post phase update comment directly (no sub-agent):
   ```bash
   PHASE_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
   PHASE_BODY=$(cat <<COMMENTEOF
> **MGW** · \`phase-complete\` · ${PHASE_TIMESTAMP}
> ${MILESTONE_CONTEXT}

### Phase ${phase_num} Complete — ${phase_name}

${brief_summary_from_executor}

**Verification:** ${verification_status}
COMMENTEOF
)
   gh issue comment ${ISSUE_NUMBER} --body "$PHASE_BODY" 2>/dev/null || true
   ```

   After all phases complete → update pipeline_stage to "verifying" (at `${REPO_ROOT}/.mgw/active/`).
</step>

<step name="post_execution_update">
**Post execution-complete comment on issue:**

After GSD execution completes, post a structured update before creating the PR:

```bash
COMMIT_COUNT=$(git rev-list ${DEFAULT_BRANCH}..HEAD --count 2>/dev/null || echo "0")
TEST_STATUS=$(npm test 2>&1 >/dev/null && echo "passing" || echo "failing")
FILE_CHANGES=$(git diff --stat ${DEFAULT_BRANCH}..HEAD 2>/dev/null | tail -1)
EXEC_TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
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

<step name="create_pr">
**Create PR (task agent):**

After GSD execution completes (any route):

Push branch and gather artifacts:
```bash
git push -u origin ${BRANCH_NAME}

# Structured summary data via gsd-tools (returns JSON with one_liner, key_files, tech_added, patterns, decisions)
SUMMARY_DATA=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs summary-extract "${gsd_artifacts_path}/*SUMMARY*" 2>/dev/null || echo '{}')
# Also keep raw summary for full context
SUMMARY=$(cat ${gsd_artifacts_path}/*SUMMARY* 2>/dev/null)
VERIFICATION=$(cat ${gsd_artifacts_path}/*VERIFICATION* 2>/dev/null)
COMMITS=$(git log ${DEFAULT_BRANCH}..HEAD --oneline)
CROSS_REFS=$(cat ${REPO_ROOT}/.mgw/cross-refs.json 2>/dev/null)
# Progress table for PR details section
PROGRESS_TABLE=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs progress table --raw 2>/dev/null || echo "")

# Milestone/phase context for PR body
MILESTONE_TITLE=""
PHASE_INFO=""
DEPENDENCY_CHAIN=""
PROJECT_BOARD_URL=""
if [ -f "${REPO_ROOT}/.mgw/project.json" ]; then
  MILESTONE_TITLE=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
for m in p['milestones']:
  for i in m.get('issues', []):
    if i.get('github_number') == ${ISSUE_NUMBER}:
      print(m['name'])
      break
" 2>/dev/null || echo "")

  PHASE_INFO=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
total_phases = sum(len(m.get('issues', [])) for m in p['milestones'])
for m in p['milestones']:
  for i in m.get('issues', []):
    if i.get('github_number') == ${ISSUE_NUMBER}:
      total_in_milestone = len(m.get('issues', []))
      idx = [x['github_number'] for x in m['issues']].index(${ISSUE_NUMBER}) + 1
      print(f\"Phase {i['phase_number']}: {i['phase_name']} (issue {idx}/{total_in_milestone} in milestone)\")
      break
" 2>/dev/null || echo "")

  DEPENDENCY_CHAIN=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
refs = json.load(open('${REPO_ROOT}/.mgw/cross-refs.json'))
blockers = [l['b'].split(':')[1] for l in refs.get('links', [])
            if l.get('type') == 'blocked-by' and l['a'] == 'issue:${ISSUE_NUMBER}']
blocks = [l['a'].split(':')[1] for l in refs.get('links', [])
          if l.get('type') == 'blocked-by' and l['b'] == 'issue:${ISSUE_NUMBER}']
parts = []
if blockers: parts.append('Blocked by: ' + ', '.join(f'#{b}' for b in blockers))
if blocks: parts.append('Unblocks: ' + ', '.join(f'#{b}' for b in blocks))
print(' | '.join(parts) if parts else 'No dependencies')
" 2>/dev/null || echo "")

  PROJECT_BOARD_URL=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
print(p.get('project', {}).get('project_board', {}).get('url', ''))
" 2>/dev/null || echo "")
fi
```

Read issue state for context.

```
Task(
  prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
</files_to_read>

Create a GitHub PR for issue #${ISSUE_NUMBER}.

<issue>
Title: ${issue_title}
Body: ${issue_body}
</issue>

<milestone_context>
Milestone: ${MILESTONE_TITLE}
Phase: ${PHASE_INFO}
Dependencies: ${DEPENDENCY_CHAIN}
Board: ${PROJECT_BOARD_URL}
</milestone_context>

<summary_structured>
${SUMMARY_DATA}
</summary_structured>

<summary_raw>
${SUMMARY}
</summary_raw>

<verification>
${VERIFICATION}
</verification>

<artifact_warnings>
${ARTIFACT_CHECK}
${KEYLINK_CHECK}
</artifact_warnings>

<commits>
${COMMITS}
</commits>

<cross_refs>
${CROSS_REFS}
</cross_refs>

<instructions>
1. Build PR title: short, prefixed with fix:/feat:/refactor: based on issue labels. Under 70 characters.

2. Build PR body using this EXACT structure (fill in from data above):

## Summary
- 2-4 bullets of what was built and why (use one_liner from summary_structured if available)

Closes #${ISSUE_NUMBER}

## Milestone Context
- **Milestone:** ${MILESTONE_TITLE}
- **Phase:** ${PHASE_INFO}
- **Dependencies:** ${DEPENDENCY_CHAIN}
(Skip this section entirely if MILESTONE_TITLE is empty)

## Changes
- File-level changes grouped by module (use key_files from summary_structured)

## Test Plan
- Verification checklist from VERIFICATION artifact

## Cross-References
- ${CROSS_REFS entries as bullet points}
(Skip if no cross-refs)

<details>
<summary>GSD Progress</summary>

${PROGRESS_TABLE}
</details>
(Skip if PROGRESS_TABLE is empty)

3. Create PR: gh pr create --title '<title>' --base '${DEFAULT_BRANCH}' --head '${BRANCH_NAME}' --body '<body>'
4. Post testing procedures as separate PR comment: gh pr comment <pr_number> --body '<testing>'
5. Return: PR number, PR URL
</instructions>
",
  subagent_type="general-purpose",
  description="Create PR for #${ISSUE_NUMBER}"
)
```

Parse PR number and URL from agent response.

Update state (at `${REPO_ROOT}/.mgw/active/`):
- linked_pr = PR number
- pipeline_stage = "pr-created"

Add cross-ref (at `${REPO_ROOT}/.mgw/cross-refs.json`): issue → PR.
</step>

<step name="cleanup_and_complete">
**Clean up worktree, post completion, and prompt sync:**

Return to main repo and remove worktree (branch persists for PR):
```bash
cd "${REPO_ROOT}"
git worktree remove "${WORKTREE_DIR}" 2>/dev/null
rmdir "${REPO_ROOT}/.worktrees/issue" 2>/dev/null
rmdir "${REPO_ROOT}/.worktrees" 2>/dev/null
```

Extract one-liner summary for concise comment:
```bash
ONE_LINER=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs summary-extract "${gsd_artifacts_path}/*SUMMARY*" --fields one_liner --raw 2>/dev/null || echo "")
```

Post structured PR-ready comment directly (no sub-agent — guarantees it happens):

```bash
DONE_TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

PR_READY_BODY=$(cat <<COMMENTEOF
> **MGW** · \`pr-ready\` · ${DONE_TIMESTAMP}
> ${MILESTONE_CONTEXT}

### PR Ready

**PR #${PR_NUMBER}** — ${PR_URL}

${ONE_LINER}

Testing procedures posted on the PR.
This issue will auto-close when the PR is merged.

<details>
<summary>Pipeline Summary</summary>

| Stage | Status |
|-------|--------|
| Triage | ✓ |
| Planning | ✓ |
| Execution | ✓ |
| PR Creation | ✓ |

</details>
COMMENTEOF
)

gh issue comment ${ISSUE_NUMBER} --body "$PR_READY_BODY" 2>/dev/null || true
```

Update pipeline_stage to "done" (at `${REPO_ROOT}/.mgw/active/`).

Report to user:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► PIPELINE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Issue:  #${ISSUE_NUMBER} — ${issue_title}
Route:  ${gsd_route}
PR:     #${PR_NUMBER} — ${PR_URL}
Branch: ${BRANCH_NAME} (worktree cleaned up)

Status comments posted. PR includes testing procedures.
Issue will auto-close on merge.

Next:
  → Review the PR, then merge
  → After merge: /mgw:sync to archive state and clean up branches
```
</step>

</process>

<success_criteria>
- [ ] Issue number validated and state loaded (or triage run first)
- [ ] Isolated worktree created (.worktrees/ gitignored)
- [ ] Structured triage comment posted on issue (scope, route, files, security)
- [ ] GSD pipeline executed in worktree (quick or milestone route)
- [ ] Execution-complete comment posted on issue (commits, changes, test status)
- [ ] PR created with summary, milestone context, testing procedures, cross-refs
- [ ] Structured PR-ready comment posted on issue (PR link, pipeline summary)
- [ ] Worktree cleaned up, user returned to main workspace
- [ ] State file updated through all pipeline stages
- [ ] User prompted to run /mgw:sync after merge
</success_criteria>
