---
name: mgw:update
description: Post a structured status comment on a GitHub issue
argument-hint: "<issue-number> [message]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

<objective>
Post a structured status comment on a GitHub issue. Called automatically by
mgw:run at pipeline checkpoints, or manually with a custom message.

When called without a message, auto-detects update type from .mgw/ pipeline_stage.
When called with a message, posts that as a custom update.

Appends cross-references from .mgw/cross-refs.json if related work exists.
Logs comment ID in state file to prevent duplicates.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
</execution_context>

<context>
$ARGUMENTS — expects: <issue-number> [optional message]
</context>

<process>

<step name="parse_args">
**Parse issue number and optional message:**

First token: issue number (required).
Remaining tokens: custom message (optional).

If no issue number, check .mgw/active/ for exactly one active issue. If exactly one, use it. If zero or multiple, prompt:
```
AskUserQuestion(
  header: "Which Issue?",
  question: "Which issue number do you want to update?",
  followUp: null
)
```
</step>

<step name="read_state">
**Read issue state:**

Find state file: `.mgw/active/${ISSUE_NUMBER}-*.json`

If not found → error: "No active MGW state for issue #${ISSUE_NUMBER}. Run /mgw:issue ${ISSUE_NUMBER} first."

Load state as $STATE.
</step>

<step name="build_comment">
**Build comment body:**

If custom message provided → use it directly, wrapped in status block:
```markdown
**MGW Status Update** — #${ISSUE_NUMBER}

${custom_message}
```

If no custom message → auto-detect from pipeline_stage:

| pipeline_stage | Comment template |
|----------------|-----------------|
| triaged | "**Triage Complete** — Scope: ${files} files across ${systems}. Route: `${gsd_route}`. Starting work." |
| planning | "**Planning Complete** — Plan created via ${gsd_route}. Execution starting." |
| executing | "**Execution in Progress** — ${summary from GSD artifacts if available}" |
| verifying | "**Verification** — Running post-execution checks." |
| pr-created | "**PR Ready** — PR #${linked_pr} created. See PR for testing procedures." |

Append cross-references section if .mgw/cross-refs.json has links for this issue:
```markdown

---
**Related work:**
- Linked to #43 (related)
- Branch: `fix/auth-42`
- PR: #15
```
</step>

<step name="post_comment">
**Post comment and log:**

```bash
gh issue comment $ISSUE_NUMBER --body "$COMMENT_BODY"
```

Capture comment URL from output.

Update state file: append to comments_posted array:
```json
{ "type": "${update_type}", "timestamp": "$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw)", "url": "${comment_url}" }
```

Write updated state back to `.mgw/active/${filename}.json`.
</step>

<step name="report">
**Report to user:**

```
Posted ${update_type} comment on #${ISSUE_NUMBER}: ${comment_url}
```
</step>

</process>

<success_criteria>
- [ ] Issue number parsed from args or auto-detected from single active issue
- [ ] State file read from .mgw/active/
- [ ] Comment body built (auto-detected type or custom message)
- [ ] Cross-references appended if present
- [ ] Comment posted via gh issue comment
- [ ] Comment ID logged in state file (no duplicates)
</success_criteria>
