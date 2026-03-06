---
name: mgw:project
description: Initialize a new project — generate AI-driven milestones and issues from project description, persist project state
argument-hint: ""
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

<objective>
Turn a project description into a fully structured GitHub project: milestones created,
issues scaffolded from AI-generated project-specific content, dependencies labeled, and
state persisted. The developer never leaves Claude Code and never does project management
manually.

MGW does NOT write to .planning/ directly — that directory is owned by GSD. For Fresh
projects, MGW spawns a gsd:new-project Task agent (spawn_gsd_new_project step) which creates
.planning/PROJECT.md and .planning/ROADMAP.md as part of the vision cycle. For non-Fresh
projects with existing GSD state, .planning/ is already populated before this command runs.

This command creates structure only. It does NOT trigger execution.
Run /mgw:milestone to begin executing the first milestone.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<process>

<step name="verify_repo">
**Verify we're in a git repo with a GitHub remote:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

If not a git repo → error: "Not a git repository. Run from a repo root."
If no GitHub remote → error: "No GitHub remote found. MGW requires a GitHub repo."

**Initialize .mgw/ state (from state.md validate_and_load):**

```bash
MGW_DIR="${REPO_ROOT}/.mgw"
mkdir -p "${MGW_DIR}/active" "${MGW_DIR}/completed"

for ENTRY in ".mgw/" ".worktrees/"; do
  if ! grep -q "^${ENTRY}$" "${REPO_ROOT}/.gitignore" 2>/dev/null; then
    echo "${ENTRY}" >> "${REPO_ROOT}/.gitignore"
  fi
done

if [ ! -f "${MGW_DIR}/cross-refs.json" ]; then
  echo '{"links":[]}' > "${MGW_DIR}/cross-refs.json"
fi
```
</step>

<step name="detect_state">
@workflows/detect-state.md
</step>

<step name="align_from_gsd">
@workflows/align-from-gsd.md
</step>

<step name="milestone_mapper">
@workflows/milestone-mapper.md
</step>

<step name="reconcile_drift">
@workflows/drift-reconcile.md
</step>

<step name="vision_cycle">
**Vision Collaboration Cycle: 6-stage Fresh project onboarding (Fresh path only)**

If STATE_CLASS != Fresh: skip this step.

@workflows/vision-cycle.md
</step>

<step name="gather_inputs">
**Gather project inputs (non-extend path only):**

If STATE_CLASS = Fresh: skip (handled by vision_cycle — proceed to milestone_mapper).
If EXTEND_MODE = true: @workflows/extend-project.md

Otherwise, ask conversationally:

**Question 1:** "What are you building?"
- Capture as `$DESCRIPTION`. Encourage detail about domain, purpose, and target users.

**Question 2 (optional):** "Anything else I should know? (tech stack, audience, constraints — or Enter to skip)"
- Append any additional context to `$DESCRIPTION` if provided.

Do NOT ask the user to pick a template type.

**Infer parameters from environment:**

```bash
PROJECT_NAME=$(echo "$REPO" | cut -d'/' -f2)

if [ -f "${REPO_ROOT}/package.json" ]; then STACK="node"
elif [ -f "${REPO_ROOT}/Cargo.toml" ]; then STACK="rust"
elif [ -f "${REPO_ROOT}/go.mod" ]; then STACK="go"
elif [ -f "${REPO_ROOT}/requirements.txt" ] || [ -f "${REPO_ROOT}/pyproject.toml" ]; then STACK="python"
else STACK="unknown"; fi

PREFIX="v1"
```
</step>

<step name="generate_template">
@workflows/generate-template.md
</step>

<step name="discover_board">
**Non-blocking board discovery before GitHub structure creation:**

If `project.project_board.node_id` is empty, search GitHub for an existing board whose
title contains the project name. If found, register it in project.json so the board sync
step inside `create-github-structure.md` can use it immediately without requiring a
separate `/mgw:board create` run.

Silently skipped if board is already registered or if the API call fails.

```bash
EXISTING_NODE_ID=$(python3 -c "
import json
try:
    p = json.load(open('${MGW_DIR}/project.json'))
    print(p.get('project', {}).get('project_board', {}).get('node_id', ''))
except:
    print('')
" 2>/dev/null || echo "")

if [ -z "$EXISTING_NODE_ID" ]; then
  DISCOVERED=$(node -e "
const { findExistingBoard, getProjectFields } = require('./lib/github.cjs');
const board = findExistingBoard('${OWNER}', '${PROJECT_NAME}');
if (!board) { process.stdout.write(''); process.exit(0); }
const fields = getProjectFields('${OWNER}', board.number) || {};
console.log(JSON.stringify({ ...board, fields }));
" 2>/dev/null || echo "")

  if [ -n "$DISCOVERED" ]; then
    python3 << PYEOF
import json

with open('${MGW_DIR}/project.json') as f:
    project = json.load(f)

d = json.loads('${DISCOVERED}')
project['project']['project_board'] = {
    'number': d['number'],
    'url': d['url'],
    'node_id': d['nodeId'],
    'fields': d.get('fields', {})
}

with open('${MGW_DIR}/project.json', 'w') as f:
    json.dump(project, f, indent=2)

print(f"Board auto-discovered and registered: #{d['number']} — {d['url']}")
PYEOF
  fi
fi
```
</step>

<step name="create_github_structure">
@workflows/create-github-structure.md
</step>

<step name="populate_project_readme">
**Populate Project README on GitHub Projects v2 board (non-blocking):**

After GitHub structure creation, if a board is configured, populate the Project README
with project vision and milestone overview. This gives developers a landing page
when they open the board. Uses the shared `updateProjectReadme()` function from
`lib/issue-context.cjs` — the same function called by `mgw:milestone` and `mgw:sync --full`
to keep the README current.

```bash
node -e "
const ic = require('${REPO_ROOT}/lib/issue-context.cjs');
ic.updateProjectReadme()
  .then(ok => { if (ok) console.log('Project README populated on board'); })
  .catch(() => {});
" 2>/dev/null || true
```
</step>

</process>

<success_criteria>
- [ ] Verified git repo with GitHub remote
- [ ] .mgw/project.json does not exist (or exits cleanly if it does)
- [ ] Conversational input gathered (description only — no template type selection)
- [ ] AI-generated project template validates against schema.json
- [ ] All milestones created on GitHub (Pass 1a)
- [ ] All issues created on GitHub with milestone assignment and phase labels (Pass 1b)
- [ ] Slug-to-number mapping built during Pass 1b
- [ ] Dependency labels applied (Pass 2) — blocked-by:#N on dependent issues
- [ ] cross-refs.json updated with dependency entries
- [ ] Board discovery: if project_board.node_id empty before create_github_structure runs, findExistingBoard() called; if found, registered silently in project.json
- [ ] Board sync: if board configured (PROJECT_NUMBER + BOARD_NODE_ID in project.json), each new issue added as board item
- [ ] Board sync: Milestone, Phase, and GSD Route fields set on each board item where field IDs are available
- [ ] Board sync: board_item_id stored per issue in project.json (null if board sync skipped or failed)
- [ ] Board sync: non-blocking — GraphQL errors logged as warnings, pipeline continues
- [ ] Board sync: skipped silently if board not configured or custom fields not set up
- [ ] .mgw/project.json written with full project state (including board_item_id per issue)
- [ ] Post-init summary displayed
- [ ] Command does NOT trigger execution (PROJ-05)
- [ ] Extend mode: all milestones complete detected, new milestones appended, existing data preserved
</success_criteria>
