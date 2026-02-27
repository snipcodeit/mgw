---
name: mgw:review
description: Review and classify new comments on a GitHub issue since last triage
argument-hint: "<issue-number>"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Task
  - AskUserQuestion
---

<objective>
Standalone comment review for a triaged issue. Fetches new comments posted since
triage, classifies them (material/informational/blocking), and updates the state
file accordingly.

Use this when you want to check for stakeholder feedback before running the pipeline,
or to review comments on a blocked issue before unblocking it.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<context>
Issue number: $ARGUMENTS

State: .mgw/active/ (must exist — issue must be triaged first)
</context>

<process>

<step name="validate_and_load">
**Validate input and load state:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
```

Parse $ARGUMENTS for issue number. If missing:
```
AskUserQuestion(
  header: "Issue Number Required",
  question: "Which issue number do you want to review comments for?",
  followUp: "Enter the GitHub issue number (e.g., 42)"
)
```

Load state file: `${REPO_ROOT}/.mgw/active/${ISSUE_NUMBER}-*.json`

If no state file exists:
```
Issue #${ISSUE_NUMBER} hasn't been triaged yet.
Run /mgw:issue ${ISSUE_NUMBER} first, then review comments.
```
</step>

<step name="fetch_comments">
**Fetch current comment state from GitHub:**

```bash
CURRENT_COMMENTS=$(gh issue view $ISSUE_NUMBER --json comments --jq '.comments | length' 2>/dev/null || echo "0")
STORED_COMMENTS="${triage.last_comment_count}"

if [ -z "$STORED_COMMENTS" ] || [ "$STORED_COMMENTS" = "null" ]; then
  STORED_COMMENTS=0
fi

NEW_COUNT=$(($CURRENT_COMMENTS - $STORED_COMMENTS))
```

If no new comments (`NEW_COUNT <= 0`):
```
No new comments on #${ISSUE_NUMBER} since triage (${STORED_COMMENTS} comments at triage, ${CURRENT_COMMENTS} now).
```
Stop.

If new comments exist, fetch them:
```bash
NEW_COMMENTS=$(gh issue view $ISSUE_NUMBER --json comments \
  --jq "[.comments[-${NEW_COUNT}:]] | .[] | {author: .author.login, body: .body, createdAt: .createdAt}" 2>/dev/null)
```
</step>

<step name="classify_comments">
**Spawn classification agent:**

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
  \"per_comment\": [
    {
      \"author\": \"username\",
      \"snippet\": \"first 100 chars of comment\",
      \"classification\": \"material|informational|blocking\"
    }
  ],
  \"new_requirements\": [\"list of new requirements if material, empty array otherwise\"],
  \"blocking_reason\": \"reason if blocking, empty string otherwise\"
}
</output_format>
",
  subagent_type="general-purpose",
  description="Classify comments on #${ISSUE_NUMBER}"
)
```
</step>

<step name="present_and_act">
**Present classification and offer actions:**

Display the classification result:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► COMMENT REVIEW — #${ISSUE_NUMBER}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

New comments: ${NEW_COUNT} since triage
Classification: ${classification}
Reasoning: ${reasoning}

${per_comment_table}

${if material: 'New requirements detected:\n' + new_requirements}
${if blocking: 'Blocking reason: ' + blocking_reason}
```

Offer actions based on classification:

**If informational:**
```
AskUserQuestion(
  header: "Informational Comments",
  question: "Mark comments as reviewed and update state?",
  options: [
    { label: "Yes", description: "Update last_comment_count, continue" },
    { label: "No", description: "Keep current state, don't update count" }
  ]
)
```
If yes: update `triage.last_comment_count` to $CURRENT_COMMENTS in state file.

**If material:**
```
AskUserQuestion(
  header: "Material Comments Detected",
  question: "How should MGW handle the scope change?",
  options: [
    { label: "Acknowledge and continue", description: "Update state with new requirements, keep current route" },
    { label: "Re-triage", description: "Run /mgw:issue to re-analyze with new context" },
    { label: "Ignore", description: "Don't update state" }
  ]
)
```
If acknowledge: update `triage.last_comment_count` and store new_requirements in state.
If re-triage: suggest running `/mgw:issue ${ISSUE_NUMBER}` to re-triage.

**If blocking:**
```
AskUserQuestion(
  header: "Blocking Comment Detected",
  question: "Block the pipeline for this issue?",
  options: [
    { label: "Block", description: "Set pipeline_stage to 'blocked'" },
    { label: "Override", description: "Ignore blocker, keep current stage" },
    { label: "Review", description: "I'll review the comments manually" }
  ]
)
```
If block: update `pipeline_stage = "blocked"` and `triage.last_comment_count` in state.
If override: update `triage.last_comment_count` only, keep pipeline_stage.
</step>

</process>

<success_criteria>
- [ ] Issue state loaded from .mgw/active/
- [ ] Current comment count fetched from GitHub
- [ ] New comments identified (delta from stored count)
- [ ] Classification agent spawned and returned structured result
- [ ] Classification presented to user with per-comment breakdown
- [ ] User chose action (acknowledge/re-triage/block/ignore)
- [ ] State file updated according to user choice
</success_criteria>
