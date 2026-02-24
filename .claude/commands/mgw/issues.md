---
name: mgw:issues
description: List and filter GitHub issues, pick one to triage
argument-hint: "[--label &lt;label&gt;] [--milestone &lt;name&gt;] [--assignee &lt;user&gt;] [--state open|closed|all]"
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

<objective>
Browse GitHub issues for the current repo. Presents a scannable table filtered by
assignment (defaults to @me), labels, milestone, or state. Pick an issue to route
into triage via /mgw:issue.

No side effects — read-only GitHub access. Safe to run anytime.
</objective>

<context>
$ARGUMENTS

Repo detected via: gh repo view --json nameWithOwner -q .nameWithOwner
</context>

<process>

<step name="parse_filters">
**Parse arguments into gh filters:**

Defaults if no arguments:
- `--assignee @me`
- `--state open`
- `--limit 25`

Override with explicit flags from $ARGUMENTS:
- `--label <label>` → `gh --label`
- `--milestone <name>` → `gh --milestone`
- `--assignee <user>` → `gh --assignee` (use "all" to skip filter)
- `--state <state>` → `gh --state`
</step>

<step name="fetch_issues">
**Fetch issues from GitHub:**

```bash
gh issue list --assignee @me --state open --limit 25 --json number,title,labels,createdAt,comments,assignees
```

Adjust flags based on parsed filters.

If result is empty:
```
No issues found matching filters.
Try: /mgw:issues --assignee all --state open
```
</step>

<step name="display_table">
**Present issues as a scannable table:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► ISSUES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| #  | Title                      | Labels       | Age  | Comments |
|----|----------------------------|--------------|------|----------|
| 42 | Fix auth bug in login flow | bug, auth    | 3d   | 2        |
| 38 | Add caching layer          | enhancement  | 1w   | 5        |
| ...                                                              |

Enter issue number to triage, or 'q' to quit.
```

Calculate age as human-readable relative time from createdAt.
Truncate title to 30 chars if needed.
Format labels as comma-separated.
</step>

<step name="pick_issue">
**User selects an issue:**

```
AskUserQuestion(
  header: "Select Issue",
  question: "Which issue number do you want to triage?",
  followUp: "Enter a number from the table above, or 'q' to quit"
)
```

If valid number → suggest: "Run /mgw:issue <number> to triage this issue."
If 'q' → exit cleanly.
If invalid → re-prompt.
</step>

</process>

<success_criteria>
- [ ] Issues fetched from current repo via gh CLI
- [ ] Filters applied correctly (defaults to @me + open)
- [ ] Table displayed with number, title, labels, age, comments
- [ ] User can pick an issue number
- [ ] Routes to /mgw:issue <number>
</success_criteria>
