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

**GSD milestone consistency check (maps-to links):**

Read all maps-to links from .mgw/cross-refs.json:

```bash
MAPS_TO_LINKS=$(python3 -c "
import json
with open('.mgw/cross-refs.json') as f:
    data = json.load(f)
links = data.get('links', [])
maps_to = [l for l in links if l.get('type') == 'maps-to']
print(json.dumps(maps_to))
")
```

For each maps-to link (format: { "a": "milestone:N", "b": "gsd-milestone:id", "type": "maps-to" }):
1. Extract the GitHub milestone number from "a" (parse "milestone:N")
2. Extract the GSD milestone ID from "b" (parse "gsd-milestone:id")
3. Check if this GSD milestone ID appears in either:
   - .planning/ROADMAP.md header (active milestone)
   - .planning/MILESTONES.md (archived milestones)
4. If found in neither: flag as inconsistent

```bash
# Check each maps-to link
echo "$MAPS_TO_LINKS" | python3 -c "
import json, sys, os

links = json.load(sys.stdin)
inconsistent = []

for link in links:
    a = link.get('a', '')
    b = link.get('b', '')

    if not a.startswith('milestone:') or not b.startswith('gsd-milestone:'):
        continue

    github_num = a.split(':')[1]
    gsd_id = b.split(':', 1)[1]

    found = False

    # Check ROADMAP.md
    if os.path.exists('.planning/ROADMAP.md'):
        with open('.planning/ROADMAP.md') as f:
            content = f.read()
        if gsd_id in content:
            found = True

    # Check MILESTONES.md
    if not found and os.path.exists('.planning/MILESTONES.md'):
        with open('.planning/MILESTONES.md') as f:
            content = f.read()
        if gsd_id in content:
            found = True

    if not found:
        inconsistent.append({'github_milestone': github_num, 'gsd_id': gsd_id})

for i in inconsistent:
    print(f\"WARN: GitHub milestone #{i['github_milestone']} maps to GSD milestone '{i['gsd_id']}' which was not found in .planning/\")

if not inconsistent:
    print('GSD milestone links: all consistent')
"
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
${gsd_milestone_consistency ? 'GSD Milestone Links:\n' + gsd_milestone_consistency : ''}

```
</step>

</process>

<success_criteria>
- [ ] All .mgw/active/ files scanned
- [ ] GitHub state checked for each issue, PR, branch
- [ ] Comment delta checked for each active issue
- [ ] GSD milestone consistency checked for all maps-to links
- [ ] Completed items moved to .mgw/completed/
- [ ] Lingering worktrees cleaned up for completed items
- [ ] Branch deletion offered for completed items
- [ ] Stale/orphaned/drift items flagged (including comment drift and milestone inconsistencies)
- [ ] Summary presented
</success_criteria>
