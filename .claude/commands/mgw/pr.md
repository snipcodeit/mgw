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
# Find SUMMARY and VERIFICATION files
find ${gsd_artifacts_path} -name "*SUMMARY*" -o -name "*VERIFICATION*" 2>/dev/null
```

**Standalone mode:** Search .planning/ for recent artifacts:
```bash
# Check quick tasks
ls -t .planning/quick/*/SUMMARY.md 2>/dev/null | head -1
# Check phase artifacts
ls -t .planning/phases/*/SUMMARY.md 2>/dev/null | head -1
```

If no GSD artifacts found → fall back to `git log ${base}..HEAD --oneline` for PR content.

Read found artifacts and extract key content.
</step>

<step name="build_pr_body">
**Build PR description:**

Spawn task agent to compose the PR body:

```
Task(
  prompt="
Build a GitHub PR description from these inputs.

<issue_context>
${issue_title_and_body_if_linked}
Issue: #${ISSUE_NUMBER} (or 'none — standalone')
</issue_context>

<gsd_summary>
${SUMMARY_MD_CONTENT}
</gsd_summary>

<gsd_verification>
${VERIFICATION_MD_CONTENT_IF_EXISTS}
</gsd_verification>

<cross_refs>
${CROSS_REFS_FOR_THIS_ISSUE}
</cross_refs>

<commits>
${GIT_LOG_BASE_TO_HEAD}
</commits>

<output_format>
Return EXACTLY two sections separated by ===TESTING===:

SECTION 1 — PR body:
## Summary
- [2-4 bullet points of what changed and why]

${if_linked: 'Closes #${ISSUE_NUMBER}'}

## Changes
- [File-level changes grouped by system/module]

## Cross-References
${cross_ref_list_or_omit_if_none}

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
</success_criteria>
