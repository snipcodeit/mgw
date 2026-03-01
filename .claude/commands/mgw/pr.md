---
name: mgw:pr
description: Create a pull request from GSD artifacts and linked issue context
argument-hint: "[issue-number] [--base <branch>]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Task
---

<objective>
Create a PR with context pulled from GSD artifacts (SUMMARY.md, VERIFICATION.md)
and the linked GitHub issue. Builds a structured PR description with summary,
testing procedures, and cross-references.

Works in two modes:
1. **Linked mode:** Issue number provided or found in .mgw/active/ — pulls issue
   context, GSD artifacts, and cross-refs into the PR.
2. **Standalone mode:** No issue — builds PR from GSD artifacts in .planning/ or
   from the branch diff.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
@~/.claude/commands/mgw/workflows/board-sync.md
</execution_context>

<context>
$ARGUMENTS — optional: [issue-number] [--base <branch>]
</context>

<process>

<step name="detect_mode">
**Determine linked vs standalone mode:**

If issue number in $ARGUMENTS → linked mode.
Else if exactly one file in .mgw/active/ → linked mode with that issue.
Else → standalone mode.

Parse `--base <branch>` if provided, default to repo default branch:
```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
```
</step>

<step name="gather_gsd_artifacts">
**Gather GSD artifacts:**

**Linked mode:** Read state file for gsd_artifacts.path, then:
```bash
# Structured summary data via gsd-tools (returns JSON with one_liner, key_files, tech_added, patterns, decisions)
SUMMARY_DATA=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs summary-extract "${gsd_artifacts_path}/*SUMMARY*" 2>/dev/null || echo '{}')
# Also read raw artifacts for full context
SUMMARY_RAW=$(cat ${gsd_artifacts_path}/*SUMMARY* 2>/dev/null)
VERIFICATION=$(cat ${gsd_artifacts_path}/*VERIFICATION* 2>/dev/null)
# Progress table for details section
PROGRESS_TABLE=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs progress table --raw 2>/dev/null || echo "")

# Milestone/phase context for PR body
MILESTONE_TITLE=""
PHASE_INFO=""
DEPENDENCY_CHAIN=""
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
for m in p['milestones']:
  for i in m.get('issues', []):
    if i.get('github_number') == ${ISSUE_NUMBER}:
      total = len(m.get('issues', []))
      idx = [x['github_number'] for x in m['issues']].index(${ISSUE_NUMBER}) + 1
      print(f\"Phase {i['phase_number']}: {i['phase_name']} (issue {idx}/{total} in milestone)\")
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
print(' | '.join(parts) if parts else '')
" 2>/dev/null || echo "")
fi
```

**Standalone mode:** Search .planning/ for recent artifacts:
```bash
# Check quick tasks first, then phases
SUMMARY_PATH=$(ls -t .planning/quick/*/SUMMARY.md .planning/phases/*/SUMMARY.md 2>/dev/null | head -1)
if [ -n "$SUMMARY_PATH" ]; then
  SUMMARY_DATA=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs summary-extract "$SUMMARY_PATH" 2>/dev/null || echo '{}')
  SUMMARY_RAW=$(cat "$SUMMARY_PATH" 2>/dev/null)
fi
```

If no GSD artifacts found → fall back to `git log ${base}..HEAD --oneline` for PR content.
</step>

<step name="build_pr_body">
**Build PR description:**

Spawn task agent to compose the PR body:

```
Task(
  prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
</files_to_read>

Build a GitHub PR description from these inputs.

<issue_context>
${issue_title_and_body_if_linked}
Issue: #${ISSUE_NUMBER} (or 'none — standalone')
</issue_context>

<gsd_summary_structured>
${SUMMARY_DATA}
</gsd_summary_structured>

<gsd_summary_raw>
${SUMMARY_RAW}
</gsd_summary_raw>

<gsd_verification>
${VERIFICATION}
</gsd_verification>

<cross_refs>
${CROSS_REFS_FOR_THIS_ISSUE}
</cross_refs>

<commits>
${GIT_LOG_BASE_TO_HEAD}
</commits>

<milestone_context>
Milestone: ${MILESTONE_TITLE}
Phase: ${PHASE_INFO}
Dependencies: ${DEPENDENCY_CHAIN}
</milestone_context>

<output_format>
Return EXACTLY two sections separated by ===TESTING===:

SECTION 1 — PR body:
## Summary
- [2-4 bullet points of what changed and why]
- [Use one_liner from gsd_summary_structured if available]

${if_linked: 'Closes #${ISSUE_NUMBER}'}

${if MILESTONE_TITLE non-empty:
## Milestone Context
- **Milestone:** ${MILESTONE_TITLE}
- **Phase:** ${PHASE_INFO}
- **Dependencies:** ${DEPENDENCY_CHAIN}
}

## Changes
- [File-level changes grouped by system/module]
- [Use key_files from gsd_summary_structured if available]

## Cross-References
${cross_ref_list_or_omit_if_none}

${if PROGRESS_TABLE non-empty:
<details>
<summary>GSD Progress</summary>

${PROGRESS_TABLE}

</details>
}

===TESTING===

SECTION 2 — Testing procedures comment:
## Testing Procedures
- [ ] [Step-by-step verification checklist]
- [ ] [Derived from VERIFICATION.md if available]
- [ ] [Or from the changes themselves]
</output_format>
",
  subagent_type="general-purpose",
  model="sonnet",
  description="Build PR description for #${ISSUE_NUMBER}"
)
```

Split agent output on `===TESTING===` into $PR_BODY and $TESTING_COMMENT.
</step>

<step name="create_pr">
**Create the PR:**

Determine PR title:
- Linked: from issue title, prefixed with type (fix:, feat:, etc.)
- Standalone: from first commit message or branch name

```bash
CURRENT_BRANCH=$(git branch --show-current)
gh pr create --title "${PR_TITLE}" --base "${BASE_BRANCH}" --body "${PR_BODY}"
```

Capture PR number and URL from output.
</step>

<step name="post_testing">
**Post testing procedures as PR comment:**

```bash
gh pr comment ${PR_NUMBER} --body "${TESTING_COMMENT}"
```
</step>

<step name="update_state">
**Update .mgw/ state (linked mode only):**

Update state file:
- Set linked_pr to PR number
- Set pipeline_stage to "pr-created"

Add cross-ref: issue → PR link in cross-refs.json.

Sync PR to board (non-blocking):
```bash
sync_pr_to_board $ISSUE_NUMBER $PR_NUMBER  # non-blocking — add PR as board item
```
</step>

<step name="report">
**Report:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► PR CREATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PR #${PR_NUMBER}: ${PR_TITLE}
URL: ${PR_URL}
${if_linked: "Closes: #${ISSUE_NUMBER}"}
Testing procedures posted as PR comment.
```
</step>

</process>

<success_criteria>
- [ ] Mode detected correctly (linked vs standalone)
- [ ] GSD artifacts found and read (or fallback to git log)
- [ ] PR body includes summary, changes, cross-refs, and Closes #N
- [ ] PR created via gh pr create
- [ ] Testing procedures posted as separate PR comment
- [ ] State file updated with PR number (linked mode)
- [ ] Cross-ref added (linked mode)
- [ ] PR added to board as board item after creation (non-blocking, linked mode only)
</success_criteria>
