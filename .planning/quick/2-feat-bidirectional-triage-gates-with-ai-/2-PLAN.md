---
phase: quick-2
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .claude/commands/mgw/workflows/state.md
  - .claude/commands/mgw/workflows/github.md
  - commands/init.md
  - .claude/commands/mgw/init.md
  - .github/ISSUE_TEMPLATE/bug_report.yml
  - .github/ISSUE_TEMPLATE/feature_request.yml
  - .github/ISSUE_TEMPLATE/architecture_refactor.yml
  - .github/PULL_REQUEST_TEMPLATE.md
  - .github/labeler.yml
  - commands/issue.md
  - .claude/commands/mgw/issue.md
  - commands/run.md
  - .claude/commands/mgw/run.md
  - commands/review.md
  - .claude/commands/mgw/review.md
autonomous: true
requirements: [TRIAGE-GATES, TEMPLATES, PIPELINE-VALIDATION, COMMENT-CLASSIFICATION, STATE-LABELS]

must_haves:
  truths:
    - "Triage agent evaluates quality gates (validity, security, detail sufficiency) and blocks on failure"
    - "validity=invalid issues get pipeline_stage=needs-info, mgw:needs-info label, and structured comment"
    - "security=high issues get pipeline_stage=needs-security-review, label, and comment"
    - "Insufficient detail (body < 200 chars, no AC on features) results in needs-info"
    - "Triage comment is posted IMMEDIATELY during /mgw:issue (not deferred to /mgw:run)"
    - "/mgw:run on needs-info without --force refuses to execute"
    - "/mgw:run on needs-security-review without --security-ack refuses to execute"
    - "bug_report.yml includes acceptance criteria, scope estimate, security checkboxes, whats-involved, related issues"
    - "feature_request.yml includes acceptance criteria (required), scope estimate, priority, security, whats-involved, non-functional, related issues"
    - "architecture_refactor.yml template exists with current state, target state, migration strategy, risk areas, breaking changes"
    - "PR template has milestone context table, design decisions, security/performance, artifacts table, breaking changes, cross-references"
    - "review.md supports resolution classification type with re-triage prompt"
    - "7 new MGW pipeline labels defined in github.md and created by init.md"
    - "state.md has new pipeline stages: needs-info, needs-security-review, discussing, approved"
    - "state.md triage schema includes gate_result with passed, blockers, warnings, missing_fields"
  artifacts:
    - path: ".claude/commands/mgw/workflows/state.md"
      provides: "Extended pipeline stages and gate_result schema"
      contains: "needs-info"
    - path: ".claude/commands/mgw/workflows/github.md"
      provides: "Label ops, triage gate comment template, scope proposal template"
      contains: "mgw:needs-info"
    - path: ".github/ISSUE_TEMPLATE/architecture_refactor.yml"
      provides: "NEW architecture refactor issue template"
      contains: "architecture_refactor"
    - path: ".github/PULL_REQUEST_TEMPLATE.md"
      provides: "Redesigned PR template with 10 sections"
      contains: "Milestone Context"
    - path: "commands/issue.md"
      provides: "Triage gates and immediate GitHub feedback"
      contains: "evaluate_gates"
    - path: "commands/run.md"
      provides: "Pipeline validation gates"
      contains: "needs-info"
    - path: "commands/review.md"
      provides: "Resolution classification"
      contains: "resolution"
  key_links:
    - from: "commands/issue.md"
      to: ".claude/commands/mgw/workflows/state.md"
      via: "gate_result schema reference"
      pattern: "gate_result"
    - from: "commands/issue.md"
      to: ".claude/commands/mgw/workflows/github.md"
      via: "triage gate comment template"
      pattern: "triage.*gate.*comment"
    - from: "commands/run.md"
      to: ".claude/commands/mgw/workflows/state.md"
      via: "pipeline_stage validation"
      pattern: "needs-info|needs-security-review"
    - from: "commands/init.md"
      to: ".claude/commands/mgw/workflows/github.md"
      via: "label definitions"
      pattern: "mgw:"
---

<objective>
Implement bidirectional triage quality gates with AI-optimized templates for the MGW pipeline.

Purpose: Close six gaps in MGW's linear pipeline: (1) no gates preventing invalid/insecure issues from executing, (2) no immediate triage feedback on GitHub, (3) no discussion phase for large scope, (4) weak issue templates, (5) weak PR template, (6) no engagement loops for resolved blockers.

Output: Extended state schema, 7 new pipeline labels, enhanced issue/PR templates, triage gate evaluation in issue.md, pipeline validation in run.md, resolution classification in review.md, synced deployed copies.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/quick/2-feat-bidirectional-triage-gates-with-ai-/2-PLAN.md

Source files (commands/ is source of truth, .claude/commands/mgw/ are deployed copies):
@commands/issue.md
@commands/run.md
@commands/review.md
@commands/init.md
@.claude/commands/mgw/workflows/state.md
@.claude/commands/mgw/workflows/github.md
@.github/ISSUE_TEMPLATE/bug_report.yml
@.github/ISSUE_TEMPLATE/feature_request.yml
@.github/PULL_REQUEST_TEMPLATE.md
@.github/labeler.yml
</context>

<tasks>

<task type="auto">
  <name>Task 1: Extend state schema, GitHub label/comment operations, and init bootstrapper</name>
  <files>
    .claude/commands/mgw/workflows/state.md
    .claude/commands/mgw/workflows/github.md
    commands/init.md
    .claude/commands/mgw/init.md
  </files>
  <action>
**state.md changes:**

1. Extend the `pipeline_stage` enum in the Issue State Schema section. Current value:
   ```
   "pipeline_stage": "new|triaged|planning|executing|verifying|pr-created|done"
   ```
   Change to:
   ```
   "pipeline_stage": "new|triaged|needs-info|needs-security-review|discussing|approved|planning|executing|verifying|pr-created|done|failed|blocked"
   ```
   (The `failed` and `blocked` already appear in the Project State section's valid stages list but not in the Issue State Schema enum -- unify them.)

2. Add `gate_result` to the triage object in the Issue State Schema. After the existing `last_comment_at` field, add:
   ```json
   "gate_result": {
     "status": "passed|blocked",
     "blockers": [],
     "warnings": [],
     "missing_fields": []
   }
   ```

3. Add a new section "## Stage Flow Diagram" after the Issue State Schema section:
   ```
   ## Stage Flow Diagram

   ```
   new --> triaged         (triage passes all gates)
   new --> needs-info      (validity=invalid OR insufficient detail)
   new --> needs-security-review  (security=high)

   needs-info --> triaged  (re-triage after info provided)
   needs-security-review --> triaged  (re-triage after security ack)

   triaged --> discussing  (new-milestone route, large scope)
   triaged --> approved    (discussion complete, ready for execution)
   triaged --> planning    (direct route, skip discussion)

   discussing --> approved (stakeholder approval)
   approved --> planning

   planning --> executing
   executing --> verifying
   verifying --> pr-created
   pr-created --> done

   Any stage --> blocked   (blocking comment detected)
   blocked --> triaged     (re-triage after blocker resolved)
   Any stage --> failed    (unrecoverable error)
   ```
   ```

4. Update the Consumers table at the bottom to add entries for the new gate_result field:
   Add row: `| Gate result schema | issue.md (populate), run.md (validate) |`

**github.md changes:**

1. Add a new section "## Label Lifecycle Operations" after the existing "### Manage Labels" subsection. Add:

   ```markdown
   ## Label Lifecycle Operations

   ### MGW Pipeline Labels
   Seven labels for pipeline stage tracking. Created by init.md, managed by issue.md and run.md.

   | Label | Color | Description |
   |-------|-------|-------------|
   | `mgw:triaged` | `0e8a16` | Issue triaged and ready for pipeline |
   | `mgw:needs-info` | `e4e669` | Blocked — needs more detail or clarification |
   | `mgw:needs-security-review` | `d93f0b` | Blocked — requires security review |
   | `mgw:discussing` | `c5def5` | Under discussion — not yet approved |
   | `mgw:approved` | `0e8a16` | Discussion complete — approved for execution |
   | `mgw:in-progress` | `1d76db` | Pipeline actively executing |
   | `mgw:blocked` | `b60205` | Pipeline blocked by stakeholder comment |

   ### Remove MGW Labels and Apply New
   Used when transitioning pipeline stages. Removes all `mgw:*` pipeline labels, then applies the target label.
   ```bash
   # Remove all mgw: pipeline labels from issue, then apply new one
   remove_mgw_labels_and_apply() {
     local ISSUE_NUMBER="$1"
     local NEW_LABEL="$2"

     # Get current labels
     CURRENT_LABELS=$(gh issue view "$ISSUE_NUMBER" --json labels --jq '.labels[].name' 2>/dev/null)

     # Remove any mgw: pipeline labels
     for LABEL in $CURRENT_LABELS; do
       case "$LABEL" in
         mgw:triaged|mgw:needs-info|mgw:needs-security-review|mgw:discussing|mgw:approved|mgw:in-progress|mgw:blocked)
           gh issue edit "$ISSUE_NUMBER" --remove-label "$LABEL" 2>/dev/null
           ;;
       esac
     done

     # Apply new label
     if [ -n "$NEW_LABEL" ]; then
       gh issue edit "$ISSUE_NUMBER" --add-label "$NEW_LABEL" 2>/dev/null
     fi
   }
   ```
   ```

2. Add a new section "## Triage Comment Templates" after Label Lifecycle Operations:

   ```markdown
   ## Triage Comment Templates

   ### Gate Blocked Comment
   Posted immediately during /mgw:issue when triage gates fail.
   ```bash
   GATE_BLOCKED_BODY=$(cat <<COMMENTEOF
   > **MGW** . \`triage-blocked\` . ${TIMESTAMP}

   ### Triage: Action Required

   | Gate | Result |
   |------|--------|
   ${GATE_TABLE_ROWS}

   **What's needed:**
   ${MISSING_FIELDS_LIST}

   Please update the issue with the required information, then re-run \`/mgw:issue ${ISSUE_NUMBER}\`.
   COMMENTEOF
   )
   gh issue comment ${ISSUE_NUMBER} --body "$GATE_BLOCKED_BODY" 2>/dev/null || true
   ```

   ### Gate Passed Comment
   Posted immediately during /mgw:issue when all triage gates pass.
   ```bash
   GATE_PASSED_BODY=$(cat <<COMMENTEOF
   > **MGW** . \`triage-complete\` . ${TIMESTAMP}

   ### Triage Complete

   | | |
   |---|---|
   | **Scope** | ${SCOPE_SIZE} -- ${FILE_COUNT} files across ${SYSTEM_LIST} |
   | **Validity** | ${VALIDITY} |
   | **Security** | ${SECURITY_RISK} |
   | **Route** | \`${gsd_route}\` -- ${ROUTE_REASONING} |
   | **Gates** | All passed |

   Ready for pipeline execution.
   COMMENTEOF
   )
   gh issue comment ${ISSUE_NUMBER} --body "$GATE_PASSED_BODY" 2>/dev/null || true
   ```

   ### Scope Proposal Comment
   Posted when new-milestone route triggers discussion phase.
   ```bash
   SCOPE_PROPOSAL_BODY=$(cat <<COMMENTEOF
   > **MGW** . \`scope-proposal\` . ${TIMESTAMP}

   ### Scope Proposal: Discussion Requested

   This issue was triaged as **${SCOPE_SIZE}** scope requiring the \`new-milestone\` route.

   **Proposed breakdown:**
   ${SCOPE_BREAKDOWN}

   **Estimated phases:** ${PHASE_COUNT}

   Please review and confirm scope, or suggest changes. Once approved, run \`/mgw:run ${ISSUE_NUMBER}\` to begin execution.
   COMMENTEOF
   )
   gh issue comment ${ISSUE_NUMBER} --body "$SCOPE_PROPOSAL_BODY" 2>/dev/null || true
   ```
   ```

3. Update the Consumers table to add new entries:
   Add rows:
   - `| Label Lifecycle | issue.md, run.md, init.md |`
   - `| Triage Comment Templates | issue.md |`
   - `| Scope Proposal Template | run.md (new-milestone discussion) |`

**init.md changes:**

1. In the `ensure_labels` step, add 7 new MGW pipeline label creation commands after the existing `bug` and `enhancement` labels:

   ```bash
   # MGW pipeline labels
   gh label create "mgw:triaged" --description "Issue triaged and ready for pipeline" --color "0e8a16" --force
   gh label create "mgw:needs-info" --description "Blocked — needs more detail or clarification" --color "e4e669" --force
   gh label create "mgw:needs-security-review" --description "Blocked — requires security review" --color "d93f0b" --force
   gh label create "mgw:discussing" --description "Under discussion — not yet approved" --color "c5def5" --force
   gh label create "mgw:approved" --description "Discussion complete — approved for execution" --color "0e8a16" --force
   gh label create "mgw:in-progress" --description "Pipeline actively executing" --color "1d76db" --force
   gh label create "mgw:blocked" --description "Pipeline blocked by stakeholder comment" --color "b60205" --force
   ```

2. Update the report step to include the new labels in the status display:
   ```
     MGW pipeline labels    synced (7 labels)
   ```

3. Update success_criteria to add: `- [ ] MGW pipeline labels ensured (7 mgw:* labels)`

4. After writing commands/init.md, copy it to .claude/commands/mgw/init.md (deployed copy).
  </action>
  <verify>
    grep -q "needs-info" .claude/commands/mgw/workflows/state.md && \
    grep -q "needs-security-review" .claude/commands/mgw/workflows/state.md && \
    grep -q "gate_result" .claude/commands/mgw/workflows/state.md && \
    grep -q "Stage Flow Diagram" .claude/commands/mgw/workflows/state.md && \
    grep -q "mgw:needs-info" .claude/commands/mgw/workflows/github.md && \
    grep -q "remove_mgw_labels_and_apply" .claude/commands/mgw/workflows/github.md && \
    grep -q "Gate Blocked Comment" .claude/commands/mgw/workflows/github.md && \
    grep -q "Scope Proposal Comment" .claude/commands/mgw/workflows/github.md && \
    grep -q "mgw:triaged" commands/init.md && \
    grep -q "mgw:blocked" commands/init.md && \
    diff commands/init.md .claude/commands/mgw/init.md && \
    echo "PASS" || echo "FAIL"
  </verify>
  <done>
    - state.md pipeline_stage enum includes needs-info, needs-security-review, discussing, approved
    - state.md triage schema has gate_result object (status, blockers, warnings, missing_fields)
    - state.md has stage flow diagram showing all transitions
    - github.md has 7 MGW pipeline label definitions in a table
    - github.md has remove_mgw_labels_and_apply function
    - github.md has triage gate comment templates (blocked + passed)
    - github.md has scope proposal comment template
    - init.md ensure_labels creates all 7 mgw:* labels
    - Deployed copy .claude/commands/mgw/init.md matches source
  </done>
</task>

<task type="auto">
  <name>Task 2: Redesign GitHub issue and PR templates</name>
  <files>
    .github/ISSUE_TEMPLATE/bug_report.yml
    .github/ISSUE_TEMPLATE/feature_request.yml
    .github/ISSUE_TEMPLATE/architecture_refactor.yml
    .github/PULL_REQUEST_TEMPLATE.md
    .github/labeler.yml
  </files>
  <action>
**bug_report.yml -- Add 5 new fields to the existing template:**

Keep existing fields (bluf, mgw-version, runtime, description, reproduction-steps, expected-behavior, error-logs). Add the following NEW fields after the existing ones:

1. `acceptance-criteria` (textarea, required: false):
   - label: "Acceptance Criteria"
   - description: "Specific conditions that must be true for the fix to be considered complete"
   - placeholder: "- [ ] User is returned to main branch after pipeline completion\n- [ ] Worktree is fully cleaned up"

2. `scope-estimate` (dropdown, required: false):
   - label: "Scope Estimate"
   - description: "Rough estimate of the work involved"
   - options: ["Small (1-2 files)", "Medium (3-8 files)", "Large (9+ files or new system)"]

3. `security-impact` (checkboxes):
   - label: "Security Impact"
   - description: "Does this bug have security implications?"
   - options:
     - label: "Touches authentication/authorization"
     - label: "Involves user data handling"
     - label: "Affects input validation/sanitization"
     - label: "Involves external API calls"
     - label: "No security impact"

4. `whats-involved` (textarea, required: false):
   - label: "What's Involved"
   - description: "Files and systems that need changes (helps triage)"
   - placeholder: "| File | What Changes |\n|------|-------------|\n| `commands/run.md` | Fix worktree cleanup logic |"

5. `related-issues` (input, required: false):
   - label: "Related Issues"
   - description: "Other issues related to this bug"
   - placeholder: "#42, #43"

**feature_request.yml -- Add 7 new fields:**

Keep existing fields (bluf, problem-motivation, proposed-solution, alternatives-considered, context). Add NEW fields:

1. `acceptance-criteria` (textarea, required: true):
   - label: "Acceptance Criteria"
   - description: "Specific, testable conditions that define 'done' for this feature"
   - placeholder: "- [ ] New command `/mgw:init` creates .mgw/ directory\n- [ ] GitHub templates are generated\n- [ ] .gitignore entries added"

2. `scope-estimate` (dropdown, required: false):
   - label: "Scope Estimate"
   - options: ["Small (1-2 files)", "Medium (3-8 files)", "Large (9+ files or new system)"]

3. `priority` (dropdown, required: false):
   - label: "Priority"
   - description: "How urgent is this feature?"
   - options: ["Nice to have", "Should have", "Must have", "Critical"]

4. `security-impact` (checkboxes):
   - label: "Security Impact"
   - description: "Does this feature have security implications?"
   - options:
     - label: "Touches authentication/authorization"
     - label: "Involves user data handling"
     - label: "Affects input validation/sanitization"
     - label: "Involves external API calls"
     - label: "No security impact"

5. `whats-involved` (textarea, required: false):
   - label: "What's Involved"
   - description: "Files, systems, and estimated scope of changes"
   - placeholder: "| File | What Changes |\n|------|-------------|\n| `commands/init.md` | New command implementation |"

6. `non-functional` (textarea, required: false):
   - label: "Non-Functional Requirements"
   - description: "Performance, scalability, accessibility, or other non-functional concerns"
   - placeholder: "- Should complete in under 30 seconds\n- Must work offline (except GitHub API calls)"

7. `related-issues` (input, required: false):
   - label: "Related Issues"
   - description: "Other issues related to this feature"
   - placeholder: "#42, #43"

**architecture_refactor.yml -- NEW FILE:**

Create `.github/ISSUE_TEMPLATE/architecture_refactor.yml`:
```yaml
name: Architecture Refactor
description: Propose an architectural change or system refactoring
labels: ["refactor"]
body:
  - type: textarea
    id: bluf
    attributes:
      label: BLUF
      description: Bottom Line Up Front -- one sentence summary of the refactor
      placeholder: "Migrate from file-based state to SQLite for concurrent access support"
    validations:
      required: true

  - type: textarea
    id: current-state
    attributes:
      label: Current State
      description: How the system works today. Include architecture decisions, file paths, and pain points.
      placeholder: |
        - State stored in `.mgw/active/*.json` files
        - No locking mechanism for concurrent access
        - JSON parsing on every read
    validations:
      required: true

  - type: textarea
    id: target-state
    attributes:
      label: Target State
      description: How the system should work after this refactor. Be specific about the new architecture.
      placeholder: |
        - State stored in `.mgw/state.db` (SQLite)
        - WAL mode for concurrent readers
        - Typed schema with migrations
    validations:
      required: true

  - type: textarea
    id: migration-strategy
    attributes:
      label: Migration Strategy
      description: How to get from current state to target state. Include phasing if needed.
      placeholder: |
        1. Add SQLite dependency and schema
        2. Create migration tool for existing JSON files
        3. Update state.md patterns to use SQLite
        4. Deprecate JSON file access
    validations:
      required: true

  - type: textarea
    id: risk-areas
    attributes:
      label: Risk Areas
      description: Where could this go wrong? What are the highest-risk changes?
      placeholder: |
        - Data loss during migration if JSON files are malformed
        - Performance regression on large state files
    validations:
      required: true

  - type: textarea
    id: breaking-changes
    attributes:
      label: Breaking Changes
      description: What existing behavior or interfaces will change?
      placeholder: |
        - `.mgw/active/*.json` file format changes
        - Commands that directly read JSON will need updating
    validations:
      required: true

  - type: textarea
    id: acceptance-criteria
    attributes:
      label: Acceptance Criteria
      description: Specific conditions that define 'done'
      placeholder: |
        - [ ] All existing state operations work with new backend
        - [ ] Migration tool handles all existing JSON formats
        - [ ] No performance regression on typical workloads
    validations:
      required: true

  - type: dropdown
    id: scope-estimate
    attributes:
      label: Scope Estimate
      options:
        - Small (1-2 files)
        - Medium (3-8 files)
        - Large (9+ files or new system)
    validations:
      required: false

  - type: textarea
    id: whats-involved
    attributes:
      label: What's Involved
      description: Files, systems, and dependencies affected
      placeholder: |
        | File | What Changes |
        |------|-------------|
        | `.claude/commands/mgw/workflows/state.md` | New SQLite patterns |
    validations:
      required: false

  - type: input
    id: related-issues
    attributes:
      label: Related Issues
      placeholder: "#42, #43"
    validations:
      required: false
```

**PULL_REQUEST_TEMPLATE.md -- Full redesign with 10 sections:**

Replace the existing 3-section template with:
```markdown
## Summary
<!-- 2-4 bullets: what changed and why -->

-

Closes #<!-- issue number -->

## Milestone Context
<!-- Delete this section if not part of a milestone -->

| | |
|---|---|
| **Milestone** | <!-- milestone name --> |
| **Phase** | <!-- phase number and name --> |
| **Dependencies** | <!-- blocked-by or unblocks --> |

## Changes
<!-- Group by system/module -->

### Commands
-

### Workflows
-

### Templates
-

## Design Decisions
<!-- Key architectural or implementation decisions made -->

| Decision | Rationale |
|----------|-----------|
| <!-- decision --> | <!-- why --> |

## Security & Performance
<!-- Delete this section if no security/performance implications -->

- **Security:** <!-- impact assessment or "No security changes" -->
- **Performance:** <!-- impact assessment or "No performance changes" -->

## Artifacts
<!-- Files created or significantly modified -->

| File | Change Type | Description |
|------|------------|-------------|
| <!-- path --> | <!-- added/modified/deleted --> | <!-- brief --> |

## Breaking Changes
<!-- Delete this section if no breaking changes -->

- [ ] <!-- breaking change with migration path -->

## Test Plan
<!-- How to verify these changes work -->

- [ ]

## Cross-References
<!-- Related issues, PRs, or discussions -->

-

## Checklist
- [ ] Source commands/ match deployed .claude/commands/mgw/
- [ ] New labels documented in github.md
- [ ] State schema changes reflected in state.md
```

**labeler.yml -- Add triage-pipeline rule:**

Add a new label rule at the end of the file:
```yaml
triage-pipeline:
  - changed-files:
      - any-glob-to-any-file:
          - 'commands/issue.md'
          - 'commands/run.md'
          - 'commands/review.md'
          - '.claude/commands/mgw/workflows/state.md'
          - '.claude/commands/mgw/workflows/github.md'
```
  </action>
  <verify>
    test -f .github/ISSUE_TEMPLATE/architecture_refactor.yml && \
    grep -q "acceptance-criteria" .github/ISSUE_TEMPLATE/bug_report.yml && \
    grep -q "scope-estimate" .github/ISSUE_TEMPLATE/bug_report.yml && \
    grep -q "security-impact" .github/ISSUE_TEMPLATE/bug_report.yml && \
    grep -q "whats-involved" .github/ISSUE_TEMPLATE/bug_report.yml && \
    grep -q "related-issues" .github/ISSUE_TEMPLATE/bug_report.yml && \
    grep -q "acceptance-criteria" .github/ISSUE_TEMPLATE/feature_request.yml && \
    grep -q "scope-estimate" .github/ISSUE_TEMPLATE/feature_request.yml && \
    grep -q "priority" .github/ISSUE_TEMPLATE/feature_request.yml && \
    grep -q "security-impact" .github/ISSUE_TEMPLATE/feature_request.yml && \
    grep -q "whats-involved" .github/ISSUE_TEMPLATE/feature_request.yml && \
    grep -q "non-functional" .github/ISSUE_TEMPLATE/feature_request.yml && \
    grep -q "related-issues" .github/ISSUE_TEMPLATE/feature_request.yml && \
    grep -q "current-state" .github/ISSUE_TEMPLATE/architecture_refactor.yml && \
    grep -q "migration-strategy" .github/ISSUE_TEMPLATE/architecture_refactor.yml && \
    grep -q "breaking-changes" .github/ISSUE_TEMPLATE/architecture_refactor.yml && \
    grep -q "Milestone Context" .github/PULL_REQUEST_TEMPLATE.md && \
    grep -q "Design Decisions" .github/PULL_REQUEST_TEMPLATE.md && \
    grep -q "Security & Performance" .github/PULL_REQUEST_TEMPLATE.md && \
    grep -q "Artifacts" .github/PULL_REQUEST_TEMPLATE.md && \
    grep -q "Breaking Changes" .github/PULL_REQUEST_TEMPLATE.md && \
    grep -q "Cross-References" .github/PULL_REQUEST_TEMPLATE.md && \
    grep -q "triage-pipeline" .github/labeler.yml && \
    echo "PASS" || echo "FAIL"
  </verify>
  <done>
    - bug_report.yml has 5 new fields: acceptance-criteria, scope-estimate, security-impact, whats-involved, related-issues
    - feature_request.yml has 7 new fields: acceptance-criteria (required), scope-estimate, priority, security-impact, whats-involved, non-functional, related-issues
    - architecture_refactor.yml is a NEW file with: bluf, current-state, target-state, migration-strategy, risk-areas, breaking-changes, acceptance-criteria, scope-estimate, whats-involved, related-issues
    - PULL_REQUEST_TEMPLATE.md redesigned with 10 sections: Summary, Milestone Context, Changes, Design Decisions, Security and Performance, Artifacts, Breaking Changes, Test Plan, Cross-References, Checklist
    - labeler.yml has triage-pipeline rule covering issue.md, run.md, review.md, state.md, github.md
  </done>
</task>

<task type="auto">
  <name>Task 3: Implement triage gates, pipeline validation, resolution classification, and sync deployed copies</name>
  <files>
    commands/issue.md
    .claude/commands/mgw/issue.md
    commands/run.md
    .claude/commands/mgw/run.md
    commands/review.md
    .claude/commands/mgw/review.md
  </files>
  <action>
**commands/issue.md -- Add triage gates and immediate GitHub feedback:**

1. Add a NEW step `evaluate_gates` between the existing `spawn_analysis` step and `present_report` step:

```xml
<step name="evaluate_gates">
**Evaluate triage quality gates:**

After the analysis agent returns, evaluate three quality gates against the triage report
and the original issue data. This determines whether the issue can proceed to pipeline
execution or requires additional information/review.

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

if IS_FEATURE and not HAS_AC:
  gate_result.blockers.push("Feature requests require acceptance criteria")
  gate_result.missing_fields.push("Add acceptance criteria (checklist of testable conditions)")
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
```

2. Add a NEW step `post_triage_github` immediately after `evaluate_gates` and before `present_report`:

```xml
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

Build gate table rows from gate_result.blockers.
Build missing fields list from gate_result.missing_fields.

Use the "Gate Blocked Comment" template from @~/.claude/commands/mgw/workflows/github.md.
Post comment and apply label:
```bash
# Use remove_mgw_labels_and_apply pattern from github.md
# For validity failures:
#   pipeline_stage = "needs-info", label = "mgw:needs-info"
# For security failures:
#   pipeline_stage = "needs-security-review", label = "mgw:needs-security-review"
# For detail failures:
#   pipeline_stage = "needs-info", label = "mgw:needs-info"
# If multiple blockers, use the highest-severity label (security > detail > validity)
```

**If gates passed (gate_result.status == "passed"):**

Use the "Gate Passed Comment" template from @~/.claude/commands/mgw/workflows/github.md.
Post comment and apply label:
```bash
gh issue edit ${ISSUE_NUMBER} --add-label "mgw:triaged" 2>/dev/null
```
</step>
```

3. Modify the `present_report` step to display gate results after the triage report:

After the existing report display, add gate result display:
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

Update the AskUserQuestion to handle the blocked scenario:
```
AskUserQuestion(
  header: "Triage Decision",
  question: "${gate_result.status == 'blocked' ? 'Override gates (1), wait for updates (2), or reject (3)?' : 'Accept recommendation (1), override (2), or reject (3)?'}",
  followUp: "${gate_result.status == 'blocked' ? 'Override will log acknowledgment. Wait keeps issue in blocked state.' : 'If overriding, specify: quick, quick --full, or new-milestone'}"
)
```

4. Modify `write_state` step to:
   - Store `gate_result` in the triage object
   - Set `pipeline_stage` based on gate result:
     - Gates blocked + validity failure: `"needs-info"`
     - Gates blocked + security failure: `"needs-security-review"`
     - Gates blocked + user overrides: `"triaged"` (with override acknowledgment logged)
     - Gates passed: `"triaged"` (same as current behavior)

5. Modify `offer_next` step:
   - If gates blocked and user chose "wait": report the blocked status and suggest updating the issue, no state file written
   - If gates blocked and user overrode: proceed as normal but log override in state
   - If gates passed: same as current behavior

6. Update `success_criteria` to add:
   ```
   - [ ] Triage gates evaluated (validity, security, detail sufficiency)
   - [ ] Gate result stored in state file
   - [ ] Triage comment posted IMMEDIATELY to GitHub
   - [ ] Blocked issues get appropriate mgw: label
   - [ ] Passed issues get mgw:triaged label
   ```

**commands/run.md -- Add pipeline validation gates:**

1. Modify the `validate_and_load` step. After loading the state file and checking pipeline_stage, add NEW gate validation checks before proceeding:

After the existing stage checks (triaged, planning, executing, blocked, pr-created, done), add:
```
  - "needs-info" → Check for --force flag in $ARGUMENTS:
    If --force NOT present:
      "Pipeline for #${ISSUE_NUMBER} is blocked by triage gate (needs-info).
       The issue requires more detail before execution can begin.

       To override: /mgw:run ${ISSUE_NUMBER} --force
       To review:   /mgw:issue ${ISSUE_NUMBER} (re-triage after updating the issue)"
      STOP.
    If --force present:
      Log warning: "MGW: WARNING — Overriding needs-info gate for #${ISSUE_NUMBER}. Proceeding with --force."
      Update state: pipeline_stage = "triaged", add override_log entry.
      Continue pipeline.

  - "needs-security-review" → Check for --security-ack flag in $ARGUMENTS:
    If --security-ack NOT present:
      "Pipeline for #${ISSUE_NUMBER} requires security review.
       This issue was flagged as high security risk during triage.

       To acknowledge and proceed: /mgw:run ${ISSUE_NUMBER} --security-ack
       To review:                  /mgw:issue ${ISSUE_NUMBER} (re-triage)"
      STOP.
    If --security-ack present:
      Log warning: "MGW: WARNING — Acknowledging security risk for #${ISSUE_NUMBER}. Proceeding with --security-ack."
      Update state: pipeline_stage = "triaged", add override_log entry.
      Continue pipeline.
```

2. In the `create_worktree` step, after worktree creation succeeds, add label application:
```bash
# Apply in-progress label
# Use remove_mgw_labels_and_apply pattern from github.md
gh issue edit ${ISSUE_NUMBER} --remove-label "mgw:triaged" 2>/dev/null
gh issue edit ${ISSUE_NUMBER} --add-label "mgw:in-progress" 2>/dev/null
```

3. In the `preflight_comment_check` step, add security keyword detection to the material classification:
After the existing comment classification, if classification is "material", also check:
```
# Check for security keywords in material comments
SECURITY_KEYWORDS="security|vulnerability|CVE|exploit|injection|XSS|CSRF|auth bypass"
if echo "$NEW_COMMENTS" | grep -qiE "$SECURITY_KEYWORDS"; then
  gate_result.warnings.push("Material comment contains security keywords — consider re-triage")
  # Prompt user: "Security-related comment detected. Re-triage recommended. Continue or re-triage?"
fi
```

Also update the blocking classification handling to apply the "mgw:blocked" label:
```bash
# When blocking comment detected:
gh issue edit ${ISSUE_NUMBER} --remove-label "mgw:in-progress" 2>/dev/null
gh issue edit ${ISSUE_NUMBER} --add-label "mgw:blocked" 2>/dev/null
```

4. For the `execute_gsd_milestone` step (new-milestone route), add a discussion phase trigger:
After step 1 (Create milestone), if the route is new-milestone, add:
```
# Post scope proposal comment using template from github.md
# Set pipeline_stage to "discussing"
# Apply "mgw:discussing" label
# Wait for user approval before proceeding to phase execution
```

5. Modify the `post_triage_update` step: change comment tag from `triage-complete` to `work-starting` since triage comment is now posted during /mgw:issue. Update the header to "### Work Starting" instead of "### Triage Complete".

6. In the `cleanup_and_complete` step, add label cleanup:
```bash
# Remove in-progress label at completion
gh issue edit ${ISSUE_NUMBER} --remove-label "mgw:in-progress" 2>/dev/null
```

7. Update success_criteria to add:
   ```
   - [ ] Pipeline refuses needs-info without --force
   - [ ] Pipeline refuses needs-security-review without --security-ack
   - [ ] mgw:in-progress label applied during execution
   - [ ] mgw:in-progress label removed at completion
   - [ ] mgw:blocked label applied when blocking comments detected
   - [ ] New-milestone route triggers discussion phase
   ```

**commands/review.md -- Add resolution classification:**

1. In the `classify_comments` step, add "resolution" as a fourth classification type in the classification_rules:

Update the classification_rules section to add:
```
- **resolution** — Comment indicates a previously identified blocker or issue has been resolved.
  Examples: 'The dependency has been updated', 'Security review complete — approved',
  'Added the missing acceptance criteria', 'Updated the issue with more detail',
  'Fixed the blocking issue in #42'.
```

Update the priority logic:
```
If ANY comment in the batch is blocking, overall classification is blocking.
If ANY comment is resolution (and none blocking), overall classification is resolution.
If ANY comment is material (and none blocking/resolution), overall classification is material.
Otherwise, informational.
```

Update the output_format JSON to include resolution fields:
```json
{
  "classification": "material|informational|blocking|resolution",
  "reasoning": "Brief explanation",
  "per_comment": [...],
  "new_requirements": [],
  "blocking_reason": "",
  "resolved_blocker": "description of what was resolved, empty string otherwise"
}
```

2. In the `present_and_act` step, add a new block for resolution classification:

```
**If resolution:**
```
AskUserQuestion(
  header: "Blocker Resolution Detected",
  question: "A previous blocker appears to be resolved. Re-triage this issue?",
  options: [
    { label: "Re-triage", description: "Run /mgw:issue to re-analyze with updated context" },
    { label: "Acknowledge", description: "Update comment count, keep current pipeline stage" },
    { label: "Ignore", description: "Don't update state" }
  ]
)
```
If re-triage:
  - Update `triage.last_comment_count`
  - Suggest: "Run `/mgw:issue ${ISSUE_NUMBER}` to re-triage with the resolved context."
  - If pipeline_stage is "blocked" or "needs-info" or "needs-security-review", note: "Re-triage will re-evaluate gates and may unblock the pipeline."
If acknowledge:
  - Update `triage.last_comment_count`
  - Keep current pipeline_stage
```

3. Update success_criteria to add: `- [ ] Resolution classification type supported with re-triage prompt`

**After all source files are updated, sync deployed copies:**

Copy each modified source command to its deployed location:
```bash
cp commands/issue.md .claude/commands/mgw/issue.md
cp commands/run.md .claude/commands/mgw/run.md
cp commands/review.md .claude/commands/mgw/review.md
```

Verify each copy matches:
```bash
diff commands/issue.md .claude/commands/mgw/issue.md
diff commands/run.md .claude/commands/mgw/run.md
diff commands/review.md .claude/commands/mgw/review.md
```
  </action>
  <verify>
    grep -q "evaluate_gates" commands/issue.md && \
    grep -q "post_triage_github" commands/issue.md && \
    grep -q "gate_result" commands/issue.md && \
    grep -q "needs-info" commands/run.md && \
    grep -q "needs-security-review" commands/run.md && \
    grep -q "\-\-force" commands/run.md && \
    grep -q "\-\-security-ack" commands/run.md && \
    grep -q "mgw:in-progress" commands/run.md && \
    grep -q "resolution" commands/review.md && \
    grep -q "resolved_blocker" commands/review.md && \
    diff commands/issue.md .claude/commands/mgw/issue.md && \
    diff commands/run.md .claude/commands/mgw/run.md && \
    diff commands/review.md .claude/commands/mgw/review.md && \
    echo "PASS" || echo "FAIL"
  </verify>
  <done>
    - issue.md has evaluate_gates step between spawn_analysis and present_report
    - issue.md has post_triage_github step that posts comment IMMEDIATELY
    - issue.md evaluate_gates checks validity, security (high), and detail sufficiency (body < 200 chars, no AC on features)
    - issue.md present_report shows gate results and offers override option
    - issue.md write_state stores gate_result and sets pipeline_stage based on gate outcome
    - issue.md applies mgw:needs-info, mgw:needs-security-review, or mgw:triaged label
    - run.md refuses needs-info without --force flag
    - run.md refuses needs-security-review without --security-ack flag
    - run.md applies mgw:in-progress label during execution
    - run.md applies mgw:blocked label on blocking comments
    - run.md removes mgw:in-progress label at completion
    - run.md new-milestone route triggers discussion phase with mgw:discussing label
    - run.md post_triage_update changed to work-starting (triage comment now in issue.md)
    - run.md preflight_comment_check detects security keywords in material comments
    - review.md supports "resolution" classification type
    - review.md offers re-triage prompt when resolution detected
    - All 3 source commands synced to .claude/commands/mgw/ deployed copies
  </done>
</task>

</tasks>

<verification>
Run all verification commands in sequence:

```bash
# Task 1: State and GitHub workflow foundations
grep -q "needs-info" .claude/commands/mgw/workflows/state.md
grep -q "gate_result" .claude/commands/mgw/workflows/state.md
grep -q "Stage Flow Diagram" .claude/commands/mgw/workflows/state.md
grep -q "mgw:needs-info" .claude/commands/mgw/workflows/github.md
grep -q "remove_mgw_labels_and_apply" .claude/commands/mgw/workflows/github.md
grep -q "mgw:triaged" commands/init.md
diff commands/init.md .claude/commands/mgw/init.md

# Task 2: GitHub templates
test -f .github/ISSUE_TEMPLATE/architecture_refactor.yml
grep -q "acceptance-criteria" .github/ISSUE_TEMPLATE/bug_report.yml
grep -q "acceptance-criteria" .github/ISSUE_TEMPLATE/feature_request.yml
grep -q "Milestone Context" .github/PULL_REQUEST_TEMPLATE.md
grep -q "triage-pipeline" .github/labeler.yml

# Task 3: Pipeline logic
grep -q "evaluate_gates" commands/issue.md
grep -q "post_triage_github" commands/issue.md
grep -q "\-\-force" commands/run.md
grep -q "\-\-security-ack" commands/run.md
grep -q "resolution" commands/review.md
diff commands/issue.md .claude/commands/mgw/issue.md
diff commands/run.md .claude/commands/mgw/run.md
diff commands/review.md .claude/commands/mgw/review.md
```
</verification>

<success_criteria>
- state.md pipeline_stage enum extended with 4 new stages (needs-info, needs-security-review, discussing, approved)
- state.md triage schema has gate_result object
- state.md has stage flow diagram
- github.md defines 7 MGW pipeline labels with lifecycle operations
- github.md has 3 comment templates (gate blocked, gate passed, scope proposal)
- init.md creates 7 mgw:* labels
- bug_report.yml has 5 new fields
- feature_request.yml has 7 new fields
- architecture_refactor.yml exists as new template
- PR template redesigned with 10 sections
- labeler.yml has triage-pipeline rule
- issue.md evaluates 3 quality gates and posts immediate feedback
- run.md validates gate status with --force and --security-ack overrides
- run.md manages mgw:in-progress and mgw:blocked labels
- review.md supports resolution classification with re-triage prompt
- All source commands/ synced to .claude/commands/mgw/ deployed copies
</success_criteria>

<output>
After completion, create `.planning/quick/2-feat-bidirectional-triage-gates-with-ai-/2-SUMMARY.md`
</output>
