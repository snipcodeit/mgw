---
name: mgw:issue
description: Triage a GitHub issue — analyze against codebase, validate scope/security, recommend GSD route
argument-hint: "<issue-number>"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Task
  - AskUserQuestion
---

<objective>
Deep analysis of a single GitHub issue against the codebase. Fetches the issue,
assigns to self if needed, spawns a task agent for full analysis (scope, validity,
purpose, security, conflicts), presents a triage report, and recommends a GSD route.

Creates .mgw/ state file for the issue. Optionally routes to /mgw:run.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<context>
Issue number: $ARGUMENTS

Active issues context: .mgw/active/ (check for conflicts)
</context>

<process>

<step name="validate_input">
**Validate issue number provided:**

Parse $ARGUMENTS for a numeric issue number. If missing:
```
AskUserQuestion(
  header: "Issue Number Required",
  question: "Which issue number do you want to triage?",
  followUp: "Enter the GitHub issue number (e.g., 42)"
)
```
</step>

<step name="init_state">
**Initialize .mgw/ directory:**

Follow initialization procedure from @~/.claude/commands/mgw/workflows/state.md.
Ensure .mgw/, active/, completed/ exist and .gitignore includes .mgw/.
</step>

<step name="fetch_issue">
**Fetch issue from GitHub:**

```bash
gh issue view $ISSUE_NUMBER --json number,title,body,labels,assignees,state,comments,url,milestone
```

If issue not found → error: "Issue #$ISSUE_NUMBER not found in this repo."

Store as $ISSUE_DATA.

**Capture comment tracking snapshot:**

Record the current comment count and timestamp of the most recent comment. These
are stored in the triage state and used by run.md's pre-flight comment check to
detect new comments posted between triage and execution.

```bash
COMMENT_COUNT=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('comments', [])))")
LAST_COMMENT_AT=$(echo "$ISSUE_DATA" | python3 -c "
import json,sys
d = json.load(sys.stdin)
comments = d.get('comments', [])
if comments:
    print(comments[-1].get('createdAt', ''))
else:
    print('')
" 2>/dev/null || echo "")
```

Store $COMMENT_COUNT and $LAST_COMMENT_AT for use in the write_state step.
</step>

<step name="assign_self">
**Assign to self if unassigned:**

Check if current user is in assignees list:
```bash
GH_USER=$(gh api user -q .login)
```

If not assigned:
```bash
gh issue edit $ISSUE_NUMBER --add-assignee @me
```

Report: "Assigned #$ISSUE_NUMBER to $GH_USER"
</step>

<step name="spawn_analysis">
**Spawn task agent for codebase analysis:**

Gather GSD project history for context (if available):
```bash
HISTORY=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs history-digest 2>/dev/null || echo "")
```

Build analysis prompt from issue data and spawn:

```
Task(
  prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
</files_to_read>

Analyze GitHub issue #${ISSUE_NUMBER} against this codebase.

<issue>
Title: ${title}
Body: ${body}
Labels: ${labels}
Comments: ${comments_summary}
</issue>

<project_history>
${HISTORY}
</project_history>

<analysis_dimensions>

1. **Scope:** Search the codebase for files and systems related to this issue.
   - List affected files with paths
   - List affected systems/modules
   - Estimate: small (1-2 files), medium (3-8 files), large (9+ files or new system)

2. **Validity:** Based on the codebase, is this a real problem?
   - Can the issue be confirmed by reading the code?
   - Are there existing tests that cover this area?
   - Is the described behavior actually a bug or expected?

3. **Purpose/Benefit:** What does resolving this achieve?
   - Who benefits (users, developers, ops)?
   - What's the impact of NOT doing this?

4. **Security:** Does this touch sensitive areas?
   - Authentication/authorization
   - User data handling
   - External API calls
   - Input validation/sanitization
   - If yes to any: note specific concerns

5. **Conflicts:** Read all JSON files in .mgw/active/ directory.
   - Do any active issues touch the same files/systems?
   - Note overlaps with file paths and issue numbers

</analysis_dimensions>

<output_format>
Return a structured report:

## Triage Report: #${ISSUE_NUMBER}

### Scope
- Files: [list]
- Systems: [list]
- Size: small|medium|large

### Validity
- Status: confirmed|questionable|invalid
- Evidence: [explanation]

### Purpose
- Benefit: [who and how]
- Impact if skipped: [consequence]

### Security
- Risk: none|low|medium|high
- Notes: [specific concerns or 'none']

### Conflicts
- Active overlaps: [list or 'none']

### Recommended GSD Route
- Route: gsd:quick | gsd:quick --full | gsd:new-milestone
- Reasoning: [why this route]
</output_format>
",
  subagent_type="general-purpose",
  description="Triage issue #${ISSUE_NUMBER}"
)
```
</step>

<step name="evaluate_gates">
**Evaluate triage quality gates:**

After the analysis agent returns, evaluate three quality gates against the triage report
and the original issue data. This determines whether the issue can proceed to pipeline
execution or requires additional information/review.

Initialize gate result:
```
gate_result = {
  "status": "passed",
  "blockers": [],
  "warnings": [],
  "missing_fields": []
}
```

**Gate 1: Validity**
```
if triage.validity == "invalid":
  gate_result.blockers.push("Validity gate failed: issue could not be confirmed against codebase")
  gate_result.status = "blocked"
```

**Gate 2: Security**
```
if triage.security_risk == "high":
  gate_result.blockers.push("Security gate: high-risk issue requires security review before execution")
  gate_result.status = "blocked"
```

**Gate 3: Detail Sufficiency**
Evaluate the original issue body (not the triage report):
```
BODY_LENGTH = len(issue_body.strip())
HAS_AC = issue has acceptance criteria field filled OR body contains "- [ ]" checklist items
IS_FEATURE = "enhancement" in issue_labels OR issue template is feature_request

if BODY_LENGTH < 200:
  gate_result.blockers.push("Insufficient detail: issue body is ${BODY_LENGTH} characters (minimum 200)")
  gate_result.missing_fields.push("Expand issue description with more detail")
  gate_result.status = "blocked"

if IS_FEATURE and not HAS_AC:
  gate_result.blockers.push("Feature requests require acceptance criteria")
  gate_result.missing_fields.push("Add acceptance criteria (checklist of testable conditions)")
  gate_result.status = "blocked"
```

**Gate warnings (non-blocking):**
```
if triage.security_risk == "medium":
  gate_result.warnings.push("Medium security risk — consider review before execution")

if triage.scope.size == "large" and gsd_route != "gsd:new-milestone":
  gate_result.warnings.push("Large scope detected but not routed to new-milestone")
```

Set `gate_result.status = "passed"` if no blockers. Store gate_result for state file.
</step>

<step name="post_triage_github">
**Post immediate triage feedback to GitHub:**

This step posts a comment on the GitHub issue IMMEDIATELY during /mgw:issue, not
deferred to /mgw:run. This gives stakeholders visibility into triage results as
soon as they happen.

Generate timestamp:
```bash
TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
```

**If gates blocked (gate_result.status == "blocked"):**

Build gate table rows from gate_result.blockers:
```
GATE_TABLE_ROWS = gate_result.blockers formatted as "| ${blocker} | Blocked |" rows
```

Build missing fields list from gate_result.missing_fields:
```
MISSING_FIELDS_LIST = gate_result.missing_fields formatted as "- ${field}" list
```

Use the "Gate Blocked Comment" template from @~/.claude/commands/mgw/workflows/github.md.
Post comment and apply label using the highest-severity blocker (security > detail > validity):
```bash
# For validity or detail failures:
remove_mgw_labels_and_apply ${ISSUE_NUMBER} "mgw:needs-info"

# For security failures (highest severity — takes precedence over needs-info):
remove_mgw_labels_and_apply ${ISSUE_NUMBER} "mgw:needs-security-review"

# If multiple blockers, apply security label if security gate failed; otherwise needs-info.
```

**If gates passed (gate_result.status == "passed"):**

Use the "Gate Passed Comment" template from @~/.claude/commands/mgw/workflows/github.md.

Populate template variables:
```
SCOPE_SIZE = triage.scope.size
FILE_COUNT = triage.scope.file_count
SYSTEM_LIST = triage.scope.systems joined with ", "
VALIDITY = triage.validity
SECURITY_RISK = triage.security_notes
gsd_route = recommended route
ROUTE_REASONING = triage reasoning
```

Post comment and apply label:
```bash
remove_mgw_labels_and_apply ${ISSUE_NUMBER} "mgw:triaged"
```
</step>

<step name="present_report">
**Present triage report to user:**

Display the analysis agent's report verbatim, then display gate results:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► TRIAGE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Recommended route: ${recommended_route}
Reasoning: ${reasoning}
```

Then display gate results:

```
${if gate_result.status == "blocked":}
 GATES: BLOCKED
  ${for blocker in gate_result.blockers:}
  - ${blocker}
  ${end}

  ${if gate_result.missing_fields:}
  Missing information:
    ${for field in gate_result.missing_fields:}
    - ${field}
    ${end}
  ${end}

  The issue needs updates before pipeline execution.
  Options:
    1) Wait for updates → issue stays in needs-info/needs-security-review
    2) Override → proceed despite gate failures (adds acknowledgment to state)
    3) Reject → issue is invalid or out of scope

${else:}
  GATES: PASSED ${if gate_result.warnings: '(with warnings)'}
  ${for warning in gate_result.warnings:}
  - Warning: ${warning}
  ${end}

  Options:
    1) Accept recommendation → proceed with ${recommended_route}
    2) Override route → choose different GSD entry point
    3) Reject → issue is invalid or out of scope
${end}
```

```
AskUserQuestion(
  header: "Triage Decision",
  question: "${gate_result.status == 'blocked' ? 'Override gates (1), wait for updates (2), or reject (3)?' : 'Accept recommendation (1), override (2), or reject (3)?'}",
  followUp: "${gate_result.status == 'blocked' ? 'Override will log acknowledgment. Wait keeps issue in blocked state.' : 'If overriding, specify: quick, quick --full, or new-milestone'}"
)
```
</step>

<step name="write_state">
**Write issue state file:**

If accepted, overridden, or gates blocked but user overrides (not rejected, not "wait"):

Generate slug from title using gsd-tools:
```bash
SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${issue_title}" --raw)
SLUG="${SLUG:0:40}"  # gsd-tools doesn't truncate; MGW enforces 40-char limit
```
Write to `.mgw/active/${ISSUE_NUMBER}-${slug}.json` using the schema from state.md.

Populate:
- issue: from $ISSUE_DATA
- triage: from analysis report
- triage.last_comment_count: from $COMMENT_COUNT (captured in fetch_issue step)
- triage.last_comment_at: from $LAST_COMMENT_AT (captured in fetch_issue step, null if no comments)
- triage.gate_result: from gate_result evaluation (status, blockers, warnings, missing_fields)
- gsd_route: confirmed or overridden route
- pipeline_stage: set based on gate outcome:
  - Gates blocked + validity failure (and not overridden): `"needs-info"`
  - Gates blocked + security failure (and not overridden): `"needs-security-review"`
  - Gates blocked + user overrides: `"triaged"` (with override_log entry noting acknowledged gate failures)
  - Gates passed: `"triaged"`
- All other fields: defaults (empty arrays, null)

Also add branch cross-ref:
```bash
BRANCH=$(git branch --show-current)
```
Add to linked_branches if not main/master.
</step>

<step name="offer_next">
**Offer next steps:**

If accepted/overridden (gates passed):
```
Issue #${ISSUE_NUMBER} triaged and tracked in .mgw/active/${filename}.

Next steps:
  → /mgw:run ${ISSUE_NUMBER}  — Start autonomous pipeline
  → /mgw:update ${ISSUE_NUMBER} — Post triage comment to GitHub
```

If gates blocked and user chose "wait" (no state file written):
```
Issue #${ISSUE_NUMBER} is blocked pending more information.
A comment has been posted to GitHub explaining what's needed.

When the issue is updated:
  → /mgw:issue ${ISSUE_NUMBER}  — Re-triage with updated context
```

If gates blocked and user overrode:
```
Issue #${ISSUE_NUMBER} triaged with gate override. Tracked in .mgw/active/${filename}.

Note: Gate failures acknowledged. Override logged in state.

Next steps:
  → /mgw:run ${ISSUE_NUMBER}  — Start autonomous pipeline
```

If rejected:
```
Issue #${ISSUE_NUMBER} rejected. No state file created.
Consider closing or commenting on the issue with your reasoning.
```
</step>

</process>

<success_criteria>
- [ ] Issue fetched from GitHub via gh CLI
- [ ] Comment tracking snapshot captured (count + last timestamp)
- [ ] Self-assigned if not already
- [ ] Analysis agent spawned and returned structured report
- [ ] Scope, validity, security, conflicts all assessed
- [ ] GSD route recommended with reasoning
- [ ] Triage gates evaluated (validity, security, detail sufficiency)
- [ ] Gate result stored in state file
- [ ] Triage comment posted IMMEDIATELY to GitHub
- [ ] Blocked issues get appropriate mgw: label (mgw:needs-info or mgw:needs-security-review)
- [ ] Passed issues get mgw:triaged label
- [ ] User confirms, overrides, or rejects
- [ ] State file written to .mgw/active/ (if accepted) with comment tracking fields and gate_result
- [ ] Next steps offered
</success_criteria>
