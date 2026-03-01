---
phase: quick-3
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - commands/project.md
  - .claude/commands/mgw/project.md
autonomous: true
requirements:
  - ISSUE-58
must_haves:
  truths:
    - "In extend mode, the template generator receives a <project_history> block listing previous milestone names, issue titles, and pipeline stages"
    - "In extend mode, the template generator receives a GSD history digest (if available) so it knows what was already built"
    - "Generated milestones build on existing architecture rather than re-suggesting completed work"
  artifacts:
    - path: "commands/project.md"
      provides: "Source-of-truth command — extend-mode gather_inputs step assembles HISTORY_CONTEXT"
      contains: "project_history"
    - path: ".claude/commands/mgw/project.md"
      provides: "Deployed command — identical change"
      contains: "project_history"
  key_links:
    - from: "gather_inputs extend-mode block"
      to: "generate_template AI prompt"
      via: "HISTORY_CONTEXT variable injected as <project_history> block"
      pattern: "HISTORY_CONTEXT"
---

<objective>
Inject project history context into the `generate_template` step when mgw:project runs in extend mode,
so the AI template generator knows what milestones, issues, and systems already exist.

Purpose: Prevents the generator from suggesting features already built in previous milestones,
and ensures new milestones build on existing architecture decisions.

Output: Updated `commands/project.md` and `.claude/commands/mgw/project.md` with history
assembly and `<project_history>` injection added to the extend-mode section of `gather_inputs`.
</objective>

<execution_context>
@/home/hat/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
## Pattern to copy: mgw:issue history injection

From `commands/issue.md` (spawn_analysis step), the established pattern is:

```bash
# Gather GSD project history for context (if available):
HISTORY=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs history-digest 2>/dev/null || echo "")
```

Then inject into the AI prompt as:
```
<project_history>
${HISTORY}
</project_history>
```

## Where to add it in project.md

The change goes inside the `gather_inputs` step's `EXTEND_MODE=true` block, after loading
existing metadata (PROJECT_NAME, STACK, PREFIX, EXISTING_MILESTONE_NAMES) and before
assembling the final DESCRIPTION variable. This new block assembles `HISTORY_CONTEXT` and
is later injected into the `generate_template` step's AI prompt.

### Current extend-mode block (lines ~130-148 in commands/project.md):

```bash
if [ "$EXTEND_MODE" = true ]; then
  PROJECT_NAME=$(python3 ...)
  STACK=$(python3 ...)
  PREFIX=$(python3 ...)
  EXISTING_MILESTONE_NAMES=$(python3 ...)

  # Ask only for the new work — different question for extend mode
  # Ask: "What new milestones should we add to ${PROJECT_NAME}?"
  # Capture as EXTENSION_DESCRIPTION

  DESCRIPTION="Extension of existing project. Existing milestones: ${EXISTING_MILESTONE_NAMES}. New work: ${EXTENSION_DESCRIPTION}"
fi
```

### After the change, extend-mode block becomes:

```bash
if [ "$EXTEND_MODE" = true ]; then
  PROJECT_NAME=$(python3 ...)
  STACK=$(python3 ...)
  PREFIX=$(python3 ...)
  EXISTING_MILESTONE_NAMES=$(python3 ...)

  # Assemble project history context for the template generator
  MILESTONE_HISTORY=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
lines = []
for m in p['milestones']:
    lines.append(f\"Milestone: {m['name']}\")
    for i in m.get('issues', []):
        lines.append(f\"  - {i['title']} ({i.get('pipeline_stage','unknown')})\")
print('\n'.join(lines))
")

  GSD_DIGEST=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs history-digest 2>/dev/null || echo "")

  HISTORY_CONTEXT="Previous milestones and issues built so far:
${MILESTONE_HISTORY}

GSD build history (phases and decisions already made):
${GSD_DIGEST:-No GSD history available.}"

  # Ask only for the new work — different question for extend mode
  # Ask: "What new milestones should we add to ${PROJECT_NAME}?"
  # Capture as EXTENSION_DESCRIPTION

  DESCRIPTION="Extension of existing project. Existing milestones: ${EXISTING_MILESTONE_NAMES}. New work: ${EXTENSION_DESCRIPTION}"
fi
```

### generate_template step: inject HISTORY_CONTEXT into the AI prompt

In the `generate_template` step, the project details block that currently reads:

```
The project details for generation:
- **Project name:** `$PROJECT_NAME`
- **Description:** `$DESCRIPTION`
- **Stack:** `$STACK`
- **Repo:** `$REPO`
- **Prefix:** `$PREFIX`
```

Becomes (add the history block after the project details — only rendered in extend mode):

```
The project details for generation:
- **Project name:** `$PROJECT_NAME`
- **Description:** `$DESCRIPTION`
- **Stack:** `$STACK`
- **Repo:** `$REPO`
- **Prefix:** `$PREFIX`

<project_history>
${HISTORY_CONTEXT:-No prior history available.}
</project_history>

When in extend mode (HISTORY_CONTEXT is populated): do NOT suggest features or systems that already
appear in the project history above. Build new milestones that complement and extend what exists.
```

`HISTORY_CONTEXT` is only set when `EXTEND_MODE=true`, so the block gracefully falls back to
"No prior history available." in normal (non-extend) mode — no conditional needed.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add history assembly to extend-mode block and inject into generate_template prompt</name>
  <files>
    commands/project.md
    .claude/commands/mgw/project.md
  </files>
  <action>
Make two targeted edits to `commands/project.md` (source of truth):

**Edit 1: gather_inputs step — add HISTORY_CONTEXT assembly inside the EXTEND_MODE block**

Find the line:
```
  DESCRIPTION="Extension of existing project. Existing milestones: ${EXISTING_MILESTONE_NAMES}. New work: ${EXTENSION_DESCRIPTION}"
```

Insert the following block immediately BEFORE that line (after EXISTING_MILESTONE_NAMES is set and before DESCRIPTION is assembled):

```bash
  # Assemble project history context for the template generator
  MILESTONE_HISTORY=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
lines = []
for m in p['milestones']:
    lines.append(f\"Milestone: {m['name']}\")
    for i in m.get('issues', []):
        lines.append(f\"  - {i['title']} ({i.get('pipeline_stage','unknown')})\")
print('\n'.join(lines))
")

  GSD_DIGEST=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs history-digest 2>/dev/null || echo "")

  HISTORY_CONTEXT="Previous milestones and issues built so far:
${MILESTONE_HISTORY}

GSD build history (phases and decisions already made):
${GSD_DIGEST:-No GSD history available.}"
```

**Edit 2: generate_template step — inject HISTORY_CONTEXT into the AI prompt**

Find the block that ends with:
```
- **Prefix:** `$PREFIX`
```
(just before "After generating the JSON, extract it and write to a temp file:")

Append after `- **Prefix:** \`$PREFIX\``:

```
<project_history>
${HISTORY_CONTEXT:-No prior history available.}
</project_history>

When in extend mode (HISTORY_CONTEXT is populated): do NOT suggest features or systems that already
appear in the project history above. Build new milestones that complement and extend what exists.
```

Then apply the IDENTICAL edits to `.claude/commands/mgw/project.md`.

Note: `.claude/commands/mgw/project.md` is an older version — apply the two targeted edits
to its equivalent locations (same step names: `gather_inputs` extend-mode block and
`generate_template` project details block). The exact line numbers may differ from the source file.
  </action>
  <verify>
    <automated>grep -n "HISTORY_CONTEXT" /hd1/repos/mgw/.worktrees/issue/58-template-generation-should-use-project-h/commands/project.md && grep -n "HISTORY_CONTEXT" /hd1/repos/mgw/.worktrees/issue/58-template-generation-should-use-project-h/.claude/commands/mgw/project.md && grep -n "project_history" /hd1/repos/mgw/.worktrees/issue/58-template-generation-should-use-project-h/commands/project.md && grep -n "project_history" /hd1/repos/mgw/.worktrees/issue/58-template-generation-should-use-project-h/.claude/commands/mgw/project.md</automated>
  </verify>
  <done>
    Both files contain HISTORY_CONTEXT assembly (MILESTONE_HISTORY + GSD_DIGEST) in the extend-mode block,
    and both contain a &lt;project_history&gt; injection in the generate_template prompt.
  </done>
</task>

</tasks>

<verification>
After task completion:
1. `grep -c "HISTORY_CONTEXT" commands/project.md` returns >= 3 (set, used in HISTORY_CONTEXT=, and referenced in prompt)
2. `grep -c "HISTORY_CONTEXT" .claude/commands/mgw/project.md` returns >= 3
3. `grep "project_history" commands/project.md` shows the XML tag in the generate_template section
4. `grep "project_history" .claude/commands/mgw/project.md` shows the XML tag in the generate_template section
5. `grep "MILESTONE_HISTORY" commands/project.md` confirms the python3 block that reads project.json milestones
6. `grep "history-digest" commands/project.md` confirms the gsd-tools call
</verification>

<success_criteria>
- extend mode assembles MILESTONE_HISTORY from project.json (milestone names + issue titles + pipeline stages)
- extend mode calls gsd-tools history-digest for GSD artifact context
- both are combined into HISTORY_CONTEXT variable
- HISTORY_CONTEXT is injected as &lt;project_history&gt; block in the generate_template AI prompt
- template generator receives explicit instruction not to re-suggest already-built features
- changes applied identically to both commands/project.md and .claude/commands/mgw/project.md
</success_criteria>

<output>
No SUMMARY.md required for quick plans. Changes go directly to the two command files.
</output>
