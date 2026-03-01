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

Run periodically or when starting a new session to get a clean view.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
@~/.claude/commands/mgw/workflows/board-sync.md
</execution_context>

<process>

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

<step name="board_reconcile">
**Board reconciliation — ensure PR cross-refs are reflected on the board (non-blocking):**

If the project board is configured, check cross-refs for any issue→PR `implements` links
and ensure each linked PR exists as a board item. Uses `sync_pr_to_board` from
board-sync.md which is idempotent — adding a PR that's already on the board is a no-op.

```bash
# Non-blocking throughout — board sync failures never block reconciliation
if [ -f "${REPO_ROOT}/.mgw/project.json" ] && [ -f "${REPO_ROOT}/.mgw/cross-refs.json" ]; then
  BOARD_NODE_ID=$(python3 -c "
import json, sys
try:
    p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
    print(p.get('project', {}).get('project_board', {}).get('node_id', ''))
except:
    print('')
" 2>/dev/null || echo "")

  if [ -n "$BOARD_NODE_ID" ]; then
    # Find all issue→PR implements links in cross-refs
    PR_LINKS=$(python3 -c "
import json
refs = json.load(open('${REPO_ROOT}/.mgw/cross-refs.json'))
for link in refs.get('links', []):
    if link.get('type') == 'implements' and link['a'].startswith('issue:') and link['b'].startswith('pr:'):
        issue_num = link['a'].split(':')[1]
        pr_num = link['b'].split(':')[1]
        print(f'{issue_num} {pr_num}')
" 2>/dev/null || echo "")

    # For each issue→PR link, ensure the PR is on the board
    PR_SYNCED=0
    while IFS=' ' read -r LINKED_ISSUE LINKED_PR; do
      [ -z "$LINKED_PR" ] && continue
      sync_pr_to_board "$LINKED_ISSUE" "$LINKED_PR"  # non-blocking
      PR_SYNCED=$((PR_SYNCED + 1))
    done <<< "$PR_LINKS"

    if [ "$PR_SYNCED" -gt 0 ]; then
      echo "MGW: Board reconciliation — checked ${PR_SYNCED} PR cross-ref(s)"
    fi
  fi
fi
```
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
Completed: ${completed_count} archived
Stale:     ${stale_count} need attention
Orphaned:  ${orphaned_count} need attention
Comments:  ${comment_drift_count} issues with unreviewed comments
Branches:  ${deleted_count} cleaned up
${HEALTH ? 'GSD Health: ' + HEALTH.status : ''}

${details_for_each_non_active_item}
${comment_drift_details ? 'Unreviewed comments:\n' + comment_drift_details : ''}
```
</step>

</process>

<success_criteria>
- [ ] All .mgw/active/ files scanned
- [ ] GitHub state checked for each issue, PR, branch
- [ ] Comment delta checked for each active issue
- [ ] Completed items moved to .mgw/completed/
- [ ] Lingering worktrees cleaned up for completed items
- [ ] Branch deletion offered for completed items
- [ ] Stale/orphaned/drift items flagged (including comment drift)
- [ ] Board reconciliation run — all PR cross-refs checked against board (non-blocking)
- [ ] Summary presented
</success_criteria>
