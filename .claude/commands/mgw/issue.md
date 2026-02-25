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

<step name="present_report">
**Present triage report to user:**

Display the analysis agent's report verbatim, then:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► TRIAGE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Recommended route: ${recommended_route}
Reasoning: ${reasoning}

Options:
  1) Accept recommendation → proceed with ${recommended_route}
  2) Override route → choose different GSD entry point
  3) Reject → issue is invalid or out of scope
```

```
AskUserQuestion(
  header: "Triage Decision",
  question: "Accept recommendation (1), override (2), or reject (3)?",
  followUp: "If overriding, specify: quick, quick --full, or new-milestone"
)
```
</step>

<step name="write_state">
**Write issue state file:**

If accepted or overridden (not rejected):

Generate slug from title using gsd-tools:
```bash
SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${issue_title}" --raw)
SLUG="${SLUG:0:40}"  # gsd-tools doesn't truncate; MGW enforces 40-char limit
```
Write to `.mgw/active/${ISSUE_NUMBER}-${slug}.json` using the schema from state.md.

Populate:
- issue: from $ISSUE_DATA
- triage: from analysis report
- gsd_route: confirmed or overridden route
- pipeline_stage: "triaged"
- All other fields: defaults (empty arrays, null)

Also add branch cross-ref:
```bash
BRANCH=$(git branch --show-current)
```
Add to linked_branches if not main/master.
</step>

<step name="offer_next">
**Offer next steps:**

If accepted/overridden:
```
Issue #${ISSUE_NUMBER} triaged and tracked in .mgw/active/${filename}.

Next steps:
  → /mgw:run ${ISSUE_NUMBER}  — Start autonomous pipeline
  → /mgw:update ${ISSUE_NUMBER} — Post triage comment to GitHub
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
- [ ] Self-assigned if not already
- [ ] Analysis agent spawned and returned structured report
- [ ] Scope, validity, security, conflicts all assessed
- [ ] GSD route recommended with reasoning
- [ ] User confirms, overrides, or rejects
- [ ] State file written to .mgw/active/ (if accepted)
- [ ] Next steps offered
</success_criteria>
