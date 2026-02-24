---
phase: quick
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - .claude/commands/mgw/workflows/state.md
  - .claude/commands/mgw/issue.md
  - .claude/commands/mgw/update.md
  - .claude/commands/mgw/run.md
autonomous: true
requirements: [BLUF-01]

must_haves:
  truths:
    - "Triage analysis produces a BLUF paragraph that synthesizes issue + findings"
    - "Triage comment posted to GitHub includes the BLUF section"
    - "Work Started comment includes the BLUF section"
    - "BLUF fills in gaps when the original issue is sparse, not just parroting the title"
    - "Existing triage report structure (scope, validity, security, conflicts) is preserved"
  artifacts:
    - path: ".claude/commands/mgw/workflows/state.md"
      provides: "triage.bluf field in state schema"
      contains: "bluf"
    - path: ".claude/commands/mgw/issue.md"
      provides: "BLUF generation in analysis prompt and state write"
      contains: "bluf"
    - path: ".claude/commands/mgw/update.md"
      provides: "BLUF in triaged comment template"
      contains: "bluf"
    - path: ".claude/commands/mgw/run.md"
      provides: "BLUF in Work Started comment"
      contains: "bluf"
  key_links:
    - from: ".claude/commands/mgw/issue.md"
      to: ".claude/commands/mgw/workflows/state.md"
      via: "write_state step stores triage.bluf from analysis report"
      pattern: "triage.*bluf"
    - from: ".claude/commands/mgw/update.md"
      to: ".claude/commands/mgw/workflows/state.md"
      via: "reads triage.bluf from state file for comment template"
      pattern: "bluf"
    - from: ".claude/commands/mgw/run.md"
      to: ".claude/commands/mgw/workflows/state.md"
      via: "reads triage.bluf from state for Work Started comment"
      pattern: "bluf"
---

<objective>
Add a BLUF (Bottom Line Up Front) summary to MGW triage and work-started comments.

Purpose: When a human creates a sparse GitHub issue, the triage flow performs deep analysis but the comment posted back is a terse one-liner. A BLUF section restates the issue clearly, summarizes findings, and states the plan in 2-4 sentences so readers immediately understand what's happening without reading the full triage report.

Output: Updated command files with BLUF generation, storage, and rendering in GitHub comments.
</objective>

<execution_context>
@/home/hat/.claude/get-shit-done/workflows/execute-plan.md
@/home/hat/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.claude/commands/mgw/issue.md
@.claude/commands/mgw/update.md
@.claude/commands/mgw/run.md
@.claude/commands/mgw/workflows/state.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add BLUF to state schema and triage analysis output</name>
  <files>.claude/commands/mgw/workflows/state.md, .claude/commands/mgw/issue.md</files>
  <action>
**state.md changes:**

In the Issue State Schema JSON block, add a `"bluf"` field inside the `"triage"` object, after the existing `"conflicts"` field:

```json
"triage": {
    "scope": { "files": 0, "systems": [] },
    "validity": "pending|confirmed|invalid",
    "security_notes": "",
    "conflicts": [],
    "bluf": ""
}
```

Add a brief inline comment or description near the schema explaining: `bluf` is a 2-4 sentence BLUF summary synthesizing the issue description with triage findings. Generated during triage analysis.

**issue.md changes (spawn_analysis step):**

1. In the `<analysis_dimensions>` block inside the Task prompt (around line 101-128), add a new dimension **before** the existing numbered dimensions (make it dimension 0 or prepend it):

```
0. **BLUF (Bottom Line Up Front):** Write a 2-4 sentence paragraph that:
   - Restates what the issue is actually asking for (fill in gaps if the issue description is sparse)
   - Summarizes what the codebase analysis found (affected areas, complexity)
   - States the recommended approach in plain language
   Do NOT just parrot the issue title. If the issue says "fix auth" with no details, the BLUF should explain WHAT about auth is broken, WHERE in the codebase it lives, and HOW it should be fixed.
```

2. In the `<output_format>` block (around line 130-158), add a BLUF section at the TOP of the triage report, before `### Scope`:

```
## Triage Report: #${ISSUE_NUMBER}

### BLUF
[2-4 sentence summary: what the issue needs, what analysis found, recommended approach]

### Scope
...
```

3. In the `write_state` step (around line 194-214), in the "Populate" instructions, add a line:
```
- triage.bluf: the BLUF paragraph from the analysis report
```

This goes alongside the existing "triage: from analysis report" instruction. Make it explicit that the BLUF text should be extracted from the analysis report and stored in the state file's `triage.bluf` field.
  </action>
  <verify>
    <automated>grep -c "bluf" .claude/commands/mgw/workflows/state.md .claude/commands/mgw/issue.md | grep -v ":0$" | wc -l</automated>
    <manual>Verify: state.md has bluf field in triage object. issue.md has BLUF dimension in analysis, BLUF section in output format, and bluf storage in write_state step.</manual>
  </verify>
  <done>State schema includes triage.bluf field. Analysis prompt requests BLUF generation as a dimension. Output format includes BLUF section at top of triage report. write_state step stores bluf in state file. Both files show "bluf" references (automated check returns 2 = both files match).</done>
</task>

<task type="auto">
  <name>Task 2: Add BLUF to triage and work-started comment templates</name>
  <files>.claude/commands/mgw/update.md, .claude/commands/mgw/run.md</files>
  <action>
**update.md changes (build_comment step):**

In the pipeline_stage-to-comment template table (around line 71-77), replace the `triaged` row. Currently it reads:

```
| triaged | "**Triage Complete** — Scope: ${files} files across ${systems}. Route: `${gsd_route}`. Starting work." |
```

Replace with a multi-line template that includes the BLUF:

```
| triaged | See template below |
```

Then add the triaged template separately (below the table or as a clearly marked block) since it's now multi-line:

```markdown
**Triage Complete** -- #${ISSUE_NUMBER}

${triage.bluf}

**Scope:** ${files} files across ${systems} | **Route:** \`${gsd_route}\`
```

Key points:
- The BLUF paragraph comes right after the header, giving readers the summary first
- The scope/route details are compressed into a single metadata line below (not removed, just condensed)
- If `triage.bluf` is empty (legacy state files without it), fall back to the original one-liner format
- Keep all other pipeline_stage rows unchanged

**run.md changes (post_start_update step):**

In the `post_start_update` step (around line 124-143), the Task prompt currently builds this comment body:

```
**Work Started** — Triaged as \`${gsd_route}\`. Execution beginning on branch \`${BRANCH_NAME}\`.
```

Replace with a template that includes the BLUF read from the state file:

```
**Work Started** -- #${ISSUE_NUMBER}

${triage.bluf}

**Route:** \`${gsd_route}\` | **Branch:** \`${BRANCH_NAME}\`
```

Add an instruction in the Task prompt to read `triage.bluf` from the state file (`${REPO_ROOT}/.mgw/active/${ISSUE_NUMBER}-*.json`) and include it. If bluf is empty, omit the paragraph (don't print an empty line).

The state file is already loaded earlier in the `validate_and_load` step, so reference that the bluf value should come from the loaded $STATE variable.
  </action>
  <verify>
    <automated>grep -c "bluf" .claude/commands/mgw/update.md .claude/commands/mgw/run.md | grep -v ":0$" | wc -l</automated>
    <manual>Verify: update.md triaged template shows BLUF paragraph before scope/route line. run.md Work Started comment shows BLUF paragraph before route/branch line. Both have fallback behavior when bluf is empty.</manual>
  </verify>
  <done>Triage comment (update.md) renders BLUF as the lead paragraph with scope/route as a metadata line below. Work Started comment (run.md) renders BLUF as the lead paragraph with route/branch as a metadata line below. Both handle empty bluf gracefully. Automated check returns 2 = both files match.</done>
</task>

</tasks>

<verification>
All four files modified:
1. `grep "bluf" .claude/commands/mgw/workflows/state.md` -- shows bluf field in schema
2. `grep "bluf" .claude/commands/mgw/issue.md` -- shows BLUF in analysis dimensions, output format, and write_state
3. `grep "bluf" .claude/commands/mgw/update.md` -- shows BLUF in triaged comment template
4. `grep "bluf" .claude/commands/mgw/run.md` -- shows BLUF in Work Started comment template

Existing structure preserved:
5. `grep "### Scope" .claude/commands/mgw/issue.md` -- Scope section still present in output format
6. `grep "### Validity" .claude/commands/mgw/issue.md` -- Validity section still present
7. `grep "### Security" .claude/commands/mgw/issue.md` -- Security section still present
8. `grep "planning" .claude/commands/mgw/update.md` -- Other pipeline_stage templates unchanged
</verification>

<success_criteria>
- All four files contain "bluf" references
- State schema has triage.bluf field
- Triage analysis prompt includes BLUF as an analysis dimension with instructions to not parrot the title
- Triage report output format has BLUF section before Scope
- write_state step stores bluf in state file
- update.md triaged template renders BLUF as lead paragraph
- run.md Work Started template renders BLUF as lead paragraph
- Existing triage report structure (Scope, Validity, Purpose, Security, Conflicts) is preserved unchanged
- BLUF generation instructions emphasize gap-filling for sparse issues
</success_criteria>

<output>
After completion, create `.planning/quick/1-add-bluf-summary-to-mgw-triage-comment-t/1-SUMMARY.md`
</output>
