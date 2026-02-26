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
Post professional, structured status comments on GitHub issues. These comments serve
as a machine-readable audit trail — MGW reads them back for resume detection, sync,
and progress tracking.

Called automatically by mgw:run at every pipeline checkpoint, or manually with a custom
message. Each comment follows a consistent format with metadata headers and collapsible
detail sections.

When called without a message, auto-detects update type from .mgw/ pipeline_stage.
When called with a message, posts that as a custom update.

Appends cross-references from .mgw/cross-refs.json if related work exists.
Logs comment ID in state file to prevent duplicates.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
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

Also load project.json if it exists (for milestone/phase context):
```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
MGW_DIR="${REPO_ROOT}/.mgw"
PROJECT_JSON=""
if [ -f "${MGW_DIR}/project.json" ]; then
  PROJECT_JSON=$(cat "${MGW_DIR}/project.json")
fi
```

Extract milestone and phase context:
```bash
if [ -n "$PROJECT_JSON" ]; then
  MILESTONE_CONTEXT=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
for m in p['milestones']:
  for i in m.get('issues', []):
    if i.get('github_number') == ${ISSUE_NUMBER}:
      print(f\"Milestone: {m['name']} | Phase {i['phase_number']}: {i['phase_name']}\")
      break
" 2>/dev/null || echo "")
fi
```
</step>

<step name="build_comment">
**Build comment body:**

If custom message provided → use it wrapped in the standard format:
```markdown
> **MGW** · `status-update` · ${timestamp}
> ${MILESTONE_CONTEXT}

${custom_message}
```

If no custom message → auto-detect from pipeline_stage and build structured comment:

**All comments follow this format:**
```markdown
> **MGW** · `${stage_label}` · ${timestamp}
> ${MILESTONE_CONTEXT}

### ${Stage Title}

${Stage-specific body with structured data}

<details>
<summary>Pipeline State</summary>

| Field | Value |
|-------|-------|
| Stage | `${pipeline_stage}` |
| Route | `${gsd_route}` |
| Branch | `${branch_name}` |
| Duration | ${elapsed} |

</details>
```

**Stage-specific templates:**

---

**`triaged`** — Posted after triage analysis completes:
```markdown
> **MGW** · `triage-complete` · ${timestamp}
> ${MILESTONE_CONTEXT}

### Triage Complete

| | |
|---|---|
| **Scope** | ${scope_size} — ${file_count} files across ${system_list} |
| **Validity** | ${validity_status} |
| **Security** | ${security_risk} |
| **Route** | \`${gsd_route}\` — ${route_reasoning} |
| **Conflicts** | ${conflicts_or_none} |

Work begins on branch \`${branch_name}\`.

<details>
<summary>Affected Files</summary>

${file_list_as_bullet_points}

</details>
```

---

**`planning`** — Posted after GSD planner completes:
```markdown
> **MGW** · `planning-complete` · ${timestamp}
> ${MILESTONE_CONTEXT}

### Planning Complete

Plan created via \`${gsd_route}\` with ${task_count} task(s).

| Task | Files | Action |
|------|-------|--------|
${task_table_from_plan}

Execution starting.
```

---

**`executing`** — Posted during/after GSD executor:
```markdown
> **MGW** · `execution-complete` · ${timestamp}
> ${MILESTONE_CONTEXT}

### Execution Complete

${commit_count} atomic commit(s) on branch \`${branch_name}\`.

**Changes:**
${file_changes_grouped_by_module}

**Tests:** ${test_status}

Preparing pull request.
```

---

**`verifying`** — Posted after GSD verifier (--full mode only):
```markdown
> **MGW** · `verification` · ${timestamp}
> ${MILESTONE_CONTEXT}

### Verification

${must_have_count}/${must_have_total} must-haves passed.

| Check | Status |
|-------|--------|
${verification_table}
```

---

**`pr-created`** — Posted after PR is created:
```markdown
> **MGW** · `pr-ready` · ${timestamp}
> ${MILESTONE_CONTEXT}

### PR Ready

**PR #${pr_number}** — [${pr_title}](${pr_url})

Testing procedures posted on the PR.
This issue will auto-close when the PR is merged.

<details>
<summary>Pipeline Summary</summary>

| Stage | Duration | Status |
|-------|----------|--------|
| Triage | ${triage_duration} | ✓ |
| Planning | ${planning_duration} | ✓ |
| Execution | ${execution_duration} | ✓ |
${verification_row}
| PR Creation | ${pr_duration} | ✓ |
| **Total** | **${total_duration}** | |

</details>
```

---

**Append cross-references** if .mgw/cross-refs.json has links for this issue:
```markdown

---
<sub>Related: ${cross_ref_list} · Managed by [MGW](https://github.com/snipcodeit/mgw)</sub>
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
- [ ] Milestone/phase context loaded from project.json if available
- [ ] Comment body built (auto-detected type or custom message)
- [ ] Comment follows structured format with metadata header
- [ ] Cross-references appended if present
- [ ] Comment posted via gh issue comment
- [ ] Comment ID logged in state file (no duplicates)
</success_criteria>
