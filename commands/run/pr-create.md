---
name: mgw:run/pr-create
description: Create PR from GSD artifacts and clean up worktree
---

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

**Verify execution evidence exists before creating PR:**
```bash
SUMMARY_COUNT=$(ls ${gsd_artifacts_path}/*SUMMARY* 2>/dev/null | wc -l)
if [ "$SUMMARY_COUNT" -eq 0 ]; then
  echo "MGW ERROR: No SUMMARY files found at ${gsd_artifacts_path}. Cannot create PR without execution evidence."
  echo "This usually means the executor agent failed silently. Check the execution logs."
  # Update pipeline_stage to "failed"
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

Clear MGW labels at completion:
```bash
# Pass empty string — removes all mgw: labels without applying a new one
remove_mgw_labels_and_apply ${ISSUE_NUMBER} ""
```

Post-completion label reconciliation:
```bash
# Post-completion label reconciliation — verify no stray MGW labels remain
LIVE_LABELS=$(gh issue view ${ISSUE_NUMBER} --json labels --jq '[.labels[].name]' 2>/dev/null || echo "[]")
STRAY_MGW=$(echo "$LIVE_LABELS" | python3 -c "
import json, sys
labels = json.load(sys.stdin)
stray = [l for l in labels if l.startswith('mgw:')]
print('\n'.join(stray))
" 2>/dev/null || echo "")

if [ -n "$STRAY_MGW" ]; then
  echo "MGW WARNING: unexpected MGW labels still on issue after completion: $STRAY_MGW" >&2
fi

# Sync live labels back to .mgw/active state file
LIVE_LABELS_LIST=$(gh issue view ${ISSUE_NUMBER} --json labels --jq '[.labels[].name]' 2>/dev/null || echo "[]")
# Update labels field in ${REPO_ROOT}/.mgw/active/${STATE_FILE} using python3 json patch:
python3 -c "
import json, sys
path = sys.argv[1]
live = json.loads(sys.argv[2])
with open(path) as f: state = json.load(f)
state['labels'] = live
with open(path, 'w') as f: json.dump(state, f, indent=2)
" "${REPO_ROOT}/.mgw/active/${STATE_FILE}" "$LIVE_LABELS_LIST" 2>/dev/null || true
```

Extract one-liner summary for concise comment:
```bash
ONE_LINER=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs summary-extract "${gsd_artifacts_path}/*SUMMARY*" --fields one_liner --raw 2>/dev/null || echo "")
```

Post structured PR-ready comment directly (no sub-agent — guarantees it happens):

```bash
DONE_TIMESTAMP=$(node -e "try{process.stdout.write(require('./lib/gsd-adapter.cjs').getTimestamp())}catch(e){process.stdout.write(new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'))}")

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
