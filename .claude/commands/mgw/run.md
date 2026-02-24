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

<step name="post_start_update">
**Post "work started" comment (task agent):**

```
Task(
  prompt="Post a GitHub issue comment.
Issue: ${ISSUE_NUMBER}
Comment body:
**Work Started** — Triaged as \`${gsd_route}\`. Execution beginning on branch \`${BRANCH_NAME}\`.

Command: gh issue comment ${ISSUE_NUMBER} --body '<comment_body>'
",
  subagent_type="general-purpose",
  model="haiku",
  description="Post start comment on #${ISSUE_NUMBER}"
)
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

Read the issue description to use as the GSD task description:
```
$TASK_DESCRIPTION = "Issue #${ISSUE_NUMBER}: ${issue_title}\n\n${issue_body_truncated_to_500_chars}"
```

Execute the GSD quick workflow. Read and follow the quick workflow steps:

1. **Init:** `node ~/.claude/get-shit-done/bin/gsd-tools.cjs init quick "$DESCRIPTION"`
   Parse JSON for: planner_model, executor_model, checker_model, verifier_model, next_num, slug, date, quick_dir, task_dir.

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

<files_to_read>
- .planning/STATE.md (Project State)
- ./CLAUDE.md (if exists — follow project-specific guidelines)
</files_to_read>

**Project skills:** Check .agents/skills/ directory (if exists) — read SKILL.md files, plans should account for project skill rules

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

5. **(If --full) Spawn plan-checker, handle revision loop (max 2 iterations):**
```
Task(
  prompt="
<verification_context>
**Mode:** quick-full
**Task Description:** ${TASK_DESCRIPTION}

<files_to_read>
- ${QUICK_DIR}/${next_num}-PLAN.md (Plan to verify)
</files_to_read>

**Scope:** This is a quick task, not a full phase. Skip checks that require a ROADMAP phase goal.
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

6. **Spawn executor (task agent):**
```
Task(
  prompt="
Execute quick task ${next_num}.

<files_to_read>
- ${QUICK_DIR}/${next_num}-PLAN.md (Plan)
- .planning/STATE.md (Project state)
- ./CLAUDE.md (Project instructions, if exists)
- .agents/skills/ (Project skills, if exists — list skills, read SKILL.md for each, follow relevant rules during implementation)
</files_to_read>

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

7. **Verify summary exists** at `${QUICK_DIR}/${next_num}-SUMMARY.md`

8. **(If --full) Spawn verifier:**
```
Task(
  prompt="Verify quick task goal achievement.
Task directory: ${QUICK_DIR}
Task goal: ${TASK_DESCRIPTION}

<files_to_read>
- ${QUICK_DIR}/${next_num}-PLAN.md (Plan)
</files_to_read>

Check must_haves against actual codebase. Create VERIFICATION.md at ${QUICK_DIR}/${next_num}-VERIFICATION.md.",
  subagent_type="gsd-verifier",
  model="{verifier_model}",
  description="Verify: ${issue_title}"
)
```

9. **Update STATE.md** with quick task row in "Quick Tasks Completed" table.

10. **Commit artifacts:**
```bash
node ~/.claude/get-shit-done/bin/gsd-tools.cjs commit "docs(quick-${next_num}): ${issue_title}" --files ${file_list}
```

Update state (at `${REPO_ROOT}/.mgw/active/`): gsd_artifacts.path = $QUICK_DIR, pipeline_stage = "verifying".
</step>

<step name="execute_gsd_milestone">
**Execute GSD pipeline (new-milestone route):**

Only run this step if gsd_route is "gsd:new-milestone".

This is the most complex path. The orchestrator needs to:

1. **Create milestone:** Guide user through /gsd:new-milestone interactively.
   This requires user input for requirements and scope, so it cannot be fully
   automated. Present:
   ```
   The new-milestone route requires interactive input for requirements and scope.
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
   d. Post phase update comment:
   ```
   Task(
     prompt="Post GitHub comment on issue ${ISSUE_NUMBER}:
   **Phase ${phase_num} Complete** — ${phase_name}
   ${brief_summary_from_executor}
   Verification: ${verification_status}

   Command: gh issue comment ${ISSUE_NUMBER} --body '<body>'",
     subagent_type="general-purpose",
     model="haiku",
     description="Post phase ${phase_num} update"
   )
   ```

   After all phases complete → update pipeline_stage to "verifying" (at `${REPO_ROOT}/.mgw/active/`).
</step>

<step name="create_pr">
**Create PR (task agent):**

After GSD execution completes (any route):

Push branch and gather artifacts:
```bash
git push -u origin ${BRANCH_NAME}

SUMMARY=$(cat ${gsd_artifacts_path}/*SUMMARY* 2>/dev/null)
VERIFICATION=$(cat ${gsd_artifacts_path}/*VERIFICATION* 2>/dev/null)
COMMITS=$(git log ${DEFAULT_BRANCH}..HEAD --oneline)
CROSS_REFS=$(cat ${REPO_ROOT}/.mgw/cross-refs.json 2>/dev/null)
```

Read issue state for context.

```
Task(
  prompt="Create a GitHub PR for issue #${ISSUE_NUMBER}.

<issue>
Title: ${issue_title}
Body: ${issue_body}
</issue>

<summary>
${SUMMARY}
</summary>

<verification>
${VERIFICATION}
</verification>

<commits>
${COMMITS}
</commits>

<cross_refs>
${CROSS_REFS}
</cross_refs>

<instructions>
1. Build PR title: short, prefixed with fix:/feat:/refactor: based on issue labels
2. Build PR body with:
   - ## Summary (2-4 bullets)
   - Closes #${ISSUE_NUMBER}
   - ## Changes (file-level grouped by system)
   - ## Cross-References (if any)
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

Post completion comment:
```
Task(
  prompt="Post GitHub issue comment.
Issue: ${ISSUE_NUMBER}
Comment: **PR Ready** — PR #${PR_NUMBER} created: ${PR_URL}\nTesting procedures posted on the PR.\n\nThis issue will auto-close when the PR is merged.

Command: gh issue comment ${ISSUE_NUMBER} --body '<body>'",
  subagent_type="general-purpose",
  model="haiku",
  description="Post completion on #${ISSUE_NUMBER}"
)
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
- [ ] "Work started" comment posted on issue
- [ ] GSD pipeline executed in worktree (quick or milestone route)
- [ ] PR created with summary, testing procedures, cross-refs
- [ ] "PR ready" comment posted on issue
- [ ] Worktree cleaned up, user returned to main workspace
- [ ] State file updated through all pipeline stages
- [ ] User prompted to run /mgw:sync after merge
</success_criteria>
