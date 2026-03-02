---
name: mgw:link
description: Cross-reference issues, PRs, and branches to each other
argument-hint: "<ref-a> <ref-b> [--quiet]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

<objective>
Track relationships between issues, PRs, and branches. Writes bidirectional links
to .mgw/cross-refs.json. Optionally posts comments on linked GitHub issues/PRs.

Future mgw:update and mgw:pr calls automatically include these references.

Reference formats:
- Issue: 42 or #42 or issue:42
- PR: pr:15 or pr:#15
- Branch: branch:fix/auth-42
- GitHub Milestone: milestone:N
- GSD Milestone: gsd-milestone:name
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
</execution_context>

<context>
$ARGUMENTS — expects: <ref-a> <ref-b> [--quiet]
</context>

<process>

<step name="parse_refs">
**Parse two references from arguments:**

Normalize reference formats:
- Bare number or #N → "issue:N"
- pr:N or pr:#N → "pr:N"
- branch:name → "branch:name"
- milestone:N → "milestone:N" (GitHub milestone by number)
- gsd-milestone:name → "gsd-milestone:name" (GSD milestone by id/name)

If fewer than 2 refs provided:
```
AskUserQuestion(
  header: "Link References",
  question: "Provide two references to link (e.g., 42 #43, or 42 branch:fix/auth)",
  followUp: null
)
```

Check for `--quiet` flag → skip GitHub comment posting if present.
</step>

<step name="init_state">
**Initialize .mgw/ if needed:**

Follow initialization from state.md workflow.
</step>

<step name="write_crossref">
**Write bidirectional link:**

Read `.mgw/cross-refs.json`.

Determine link type:
- issue + issue → "related"
- issue + pr → "implements"
- issue + branch → "tracks"
- pr + branch → "tracks"
- milestone + gsd-milestone → "maps-to" (maps GitHub milestone to GSD milestone)

Check for duplicate (same a+b pair exists). If duplicate, report and skip.

Append new link:
```json
{ "a": "${ref_a}", "b": "${ref_b}", "type": "${link_type}", "created": "$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw)" }
```

Write back to `.mgw/cross-refs.json`.

Also update any matching .mgw/active/ state files:
- If ref_a is an issue with a state file → add ref_b to appropriate linked_* array
- If ref_b is an issue with a state file → add ref_a to appropriate linked_* array
</step>

<step name="post_comments">
**Post GitHub comments (unless --quiet):**

For each reference that is an issue or PR:
```bash
gh issue comment ${NUMBER} --body "Linked to ${other_ref} (${link_type}) via MGW"
```

Or for PRs:
```bash
gh pr comment ${NUMBER} --body "Linked to ${other_ref} (${link_type}) via MGW"
```
</step>

<step name="report">
**Report:**

```
Linked ${ref_a} ↔ ${ref_b} (${link_type})
${comment_status}
```
</step>

</process>

<success_criteria>
- [ ] Two references parsed and normalized
- [ ] Duplicate detection works
- [ ] Bidirectional link written to cross-refs.json
- [ ] Active state files updated if matching
- [ ] GitHub comments posted (unless --quiet)
</success_criteria>
