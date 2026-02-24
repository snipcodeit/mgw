---
name: mgw:sync
description: Reconcile local .mgw/ state with GitHub — archive completed, flag drift
argument-hint: ""
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

<objective>
Catch drift between GitHub and local .mgw/ state. For each active issue, checks
if the GitHub issue is still open, if linked PRs were merged/closed, and if tracked
branches still exist. Moves completed items to .mgw/completed/, flags inconsistencies.

Run periodically or when starting a new session to get a clean view.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
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
gh pr view ${PR_NUMBER} --json state,merged -q '{state: .state, merged: .merged}' 2>/dev/null

# Branch existence
git branch --list ${BRANCH_NAME} | grep -q . && echo "exists" || echo "gone"
git ls-remote --heads origin ${BRANCH_NAME} | grep -q . && echo "remote" || echo "no-remote"
```

Classify each issue into:
- **Completed:** Issue closed AND (PR merged OR no PR expected)
- **Stale:** PR merged but issue still open (auto-close missed)
- **Orphaned:** Branch deleted but work incomplete
- **Active:** Still in progress, everything consistent
- **Drift:** State file says one thing, GitHub says another
</step>

<step name="reconcile">
**Take action per classification:**

| Classification | Action |
|---------------|--------|
| Completed | Move state file to .mgw/completed/, report |
| Stale | Report: "Issue #N still open but PR #M merged — close issue?" |
| Orphaned | Report: "Branch deleted for #N but issue still open" |
| Active | No action, include in summary |
| Drift | Report specific mismatch, offer to update state |
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

${details_for_each_non_active_item}
```
</step>

</process>

<success_criteria>
- [ ] All .mgw/active/ files scanned
- [ ] GitHub state checked for each issue, PR, branch
- [ ] Completed items moved to .mgw/completed/
- [ ] Stale/orphaned/drift items flagged
- [ ] Summary presented
</success_criteria>
