---
name: mgw:project
description: Initialize a new project — create GitHub milestones, scaffold issues from template, write GSD ROADMAP and project state
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
issues scaffolded from an opinionated template, dependencies labeled, GSD ROADMAP.md
written, and state persisted. The developer never leaves Claude Code and never does
project management manually.

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

**Check for existing project initialization:**

```bash
if [ -f "${REPO_ROOT}/.mgw/project.json" ]; then
  echo "Project already initialized. Run /mgw:milestone to continue."
  exit 0
fi
```

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

<step name="gather_inputs">
**Gather project inputs conversationally:**

Ask the following questions in sequence:

**Question 1:** "What are you building?"
- Capture the project description as `$DESCRIPTION`

**Auto-detect template type from description (keyword matching, not LLM analysis):**

```bash
detect_template_type() {
  local DESC="${1,,}"  # lowercase
  if echo "$DESC" | grep -qiE '\b(cli|command.line|command-line|terminal|binary|tool)\b'; then
    echo "cli-tool"
  elif echo "$DESC" | grep -qiE '\b(dashboard|web|app|frontend|ui|site|portal)\b'; then
    echo "web-app"
  elif echo "$DESC" | grep -qiE '\b(library|lib|sdk|package|module|npm|framework)\b'; then
    echo "library"
  else
    echo "unknown"
  fi
}

DETECTED_TYPE=$(detect_template_type "$DESCRIPTION")
```

**Question 2:** Confirm detected type (or ask user to pick):
- If detected (not "unknown"): "Detected template: **{detected_type}**. Correct? (or specify: web-app, cli-tool, library)"
- If unknown: "I couldn't auto-detect the project type. Available templates:
  - **web-app** — Dashboard, web application, frontend/UI
  - **cli-tool** — Command-line tool, terminal binary
  - **library** — npm package, SDK, framework, reusable module
  Which fits best?"
- If user can't pick any: refuse and explain: "The available templates are web-app, cli-tool, and library. Pick the closest match, or wait for custom templates (planned for v2)."
- Store result as `$TEMPLATE_TYPE`

**Question 3 (optional):** "Any specific details to include in the project description? (press Enter to skip)"
- Append any additional context to `$DESCRIPTION`

**Infer parameters from environment (only ask for what cannot be inferred):**

```bash
# Project name: last segment of owner/repo
PROJECT_NAME=$(echo "$REPO" | cut -d'/' -f2)

# Stack: detect from existing files
if [ -f "${REPO_ROOT}/package.json" ]; then
  STACK="node"
elif [ -f "${REPO_ROOT}/Cargo.toml" ]; then
  STACK="rust"
elif [ -f "${REPO_ROOT}/go.mod" ]; then
  STACK="go"
elif [ -f "${REPO_ROOT}/requirements.txt" ] || [ -f "${REPO_ROOT}/pyproject.toml" ]; then
  STACK="python"
else
  STACK="unknown"
fi

# Prefix: default v1
PREFIX="v1"
```
</step>

<step name="load_template">
**Load and fill the template using template-loader.cjs:**

```bash
TEMPLATE_JSON=$(node "${REPO_ROOT}/lib/template-loader.cjs" load "$TEMPLATE_TYPE" \
  --project_name "$PROJECT_NAME" \
  --description "$DESCRIPTION" \
  --repo "$REPO" \
  --stack "$STACK" \
  --prefix "$PREFIX")
```

**Check for success:**
```bash
echo "$TEMPLATE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)"
```

If validation fails:
```bash
echo "$TEMPLATE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(e) for e in d.get('errors',[])]"
```
Display the errors and stop. Do not continue if template loading fails.

Parse key values from successful template output:
```bash
MILESTONE_COUNT=$(echo "$TEMPLATE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['template']['milestones']))")
TOTAL_PHASES=$(echo "$TEMPLATE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(len(m['phases']) for m in d['template']['milestones']))")
```
</step>

<step name="create_milestones">
**Pass 1a: Create GitHub milestones**

For each milestone in `template.milestones` (iterate by index):

```bash
# Iterate over milestones in the template output
MILESTONE_MAP=()  # bash array: index -> "number:id:url"

for MILESTONE_INDEX in $(seq 0 $((MILESTONE_COUNT - 1))); do
  MILESTONE_NAME=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['template']['milestones'][${MILESTONE_INDEX}]['name'])
")
  MILESTONE_DESC=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['template']['milestones'][${MILESTONE_INDEX}].get('description',''))
")

  MILESTONE_JSON_RESP=$(gh api "repos/${REPO}/milestones" --method POST \
    -f title="$MILESTONE_NAME" \
    -f description="$MILESTONE_DESC" \
    -f state="open" 2>&1)

  if echo "$MILESTONE_JSON_RESP" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    M_NUMBER=$(echo "$MILESTONE_JSON_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])")
    M_ID=$(echo "$MILESTONE_JSON_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    M_URL=$(echo "$MILESTONE_JSON_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['html_url'])")
    MILESTONE_MAP+=("${MILESTONE_INDEX}:${M_NUMBER}:${M_ID}:${M_URL}")
    echo "  Created milestone: #${M_NUMBER} ${MILESTONE_NAME}"
  else
    echo "  WARNING: Failed to create milestone '${MILESTONE_NAME}': ${MILESTONE_JSON_RESP}"
    MILESTONE_MAP+=("${MILESTONE_INDEX}:FAILED:0:")
  fi
done
```
</step>

<step name="create_issues">
**Pass 1b: Create GitHub issues for each phase**

Build a slug-to-issue-number mapping as issues are created for Pass 2 dependency resolution.

```bash
SLUG_TO_NUMBER=()  # bash array: "slug:number"
ISSUE_RECORDS=()   # for project.json
PHASE_MAP_JSON="{}"
TOTAL_ISSUES_CREATED=0
FAILED_SLUGS=()

# Global phase counter across milestones
GLOBAL_PHASE_NUM=0

for MILESTONE_INDEX in $(seq 0 $((MILESTONE_COUNT - 1))); do
  # Get this milestone's GitHub number from MILESTONE_MAP
  M_ENTRY="${MILESTONE_MAP[$MILESTONE_INDEX]}"
  M_NUMBER=$(echo "$M_ENTRY" | cut -d':' -f2)

  if [ "$M_NUMBER" = "FAILED" ]; then
    echo "  Skipping issues for failed milestone at index ${MILESTONE_INDEX}"
    continue
  fi

  PHASE_COUNT=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(len(d['template']['milestones'][${MILESTONE_INDEX}]['phases']))
")

  for PHASE_INDEX in $(seq 0 $((PHASE_COUNT - 1))); do
    GLOBAL_PHASE_NUM=$((GLOBAL_PHASE_NUM + 1))

    PHASE_NAME=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['template']['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['name'])
")
    PHASE_DESC=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['template']['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}].get('description',''))
")
    GSD_ROUTE=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['template']['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}].get('gsd_route','plan-phase'))
")
    MILESTONE_NAME=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['template']['milestones'][${MILESTONE_INDEX}]['name'])
")

    # Generate phase slug for label
    PHASE_SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${PHASE_NAME}" --raw 2>/dev/null | head -c 40 || echo "${PHASE_NAME,,}" | tr ' ' '-' | cut -c1-40)

    # Create phase label (idempotent)
    gh label create "phase:${GLOBAL_PHASE_NUM}-${PHASE_SLUG}" \
      --description "Phase ${GLOBAL_PHASE_NUM}: ${PHASE_NAME}" \
      --color "0075ca" \
      --force 2>/dev/null

    ISSUE_COUNT=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(len(d['template']['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues']))
")

    for ISSUE_INDEX in $(seq 0 $((ISSUE_COUNT - 1))); do
      ISSUE_TITLE=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['template']['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}]['title'])
")
      ISSUE_DESC=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['template']['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}].get('description',''))
")
      ISSUE_LABELS_JSON=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
labels=d['template']['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}].get('labels',[])
print(','.join(labels))
")
      DEPENDS_ON_JSON=$(echo "$TEMPLATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
deps=d['template']['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}].get('depends_on',[])
print(','.join(deps))
")

      # Generate slug for this issue (for dependency resolution)
      ISSUE_SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${ISSUE_TITLE}" --raw 2>/dev/null | head -c 40 || echo "${ISSUE_TITLE,,}" | tr ' ' '-' | cut -c1-40)

      # Build structured issue body (heredoc — preserves newlines)
      DEPENDS_DISPLAY="${DEPENDS_ON_JSON:-_none_}"
      if [ -z "$DEPENDS_ON_JSON" ]; then
        DEPENDS_DISPLAY="_none_"
      fi

      ISSUE_BODY=$(printf '## Description\n%s\n\n## Acceptance Criteria\n- [ ] %s\n\n## GSD Route\n%s\n\n## Phase Context\nPhase %s: %s of %s\n\n## Depends on\n%s' \
        "$ISSUE_DESC" \
        "$ISSUE_TITLE" \
        "$GSD_ROUTE" \
        "$GLOBAL_PHASE_NUM" \
        "$PHASE_NAME" \
        "$MILESTONE_NAME" \
        "$DEPENDS_DISPLAY")

      # Build label args
      LABEL_ARGS=(-f "labels[]=phase:${GLOBAL_PHASE_NUM}-${PHASE_SLUG}")
      if [ -n "$ISSUE_LABELS_JSON" ]; then
        for LBL in $(echo "$ISSUE_LABELS_JSON" | tr ',' '\n'); do
          LABEL_ARGS+=(-f "labels[]=${LBL}")
        done
      fi

      ISSUE_API_JSON=$(gh api "repos/${REPO}/issues" --method POST \
        -f title="$ISSUE_TITLE" \
        -f body="$ISSUE_BODY" \
        -F milestone="$M_NUMBER" \
        "${LABEL_ARGS[@]}" 2>&1)

      if echo "$ISSUE_API_JSON" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
        ISSUE_NUMBER=$(echo "$ISSUE_API_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])")
        SLUG_TO_NUMBER+=("${ISSUE_SLUG}:${ISSUE_NUMBER}")
        ISSUE_RECORDS+=("${MILESTONE_INDEX}:${ISSUE_NUMBER}:${ISSUE_TITLE}:${GLOBAL_PHASE_NUM}:${PHASE_NAME}:${GSD_ROUTE}:${DEPENDS_ON_JSON}")
        TOTAL_ISSUES_CREATED=$((TOTAL_ISSUES_CREATED + 1))
        echo "    Created issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}"
      else
        echo "    WARNING: Failed to create issue '${ISSUE_TITLE}': ${ISSUE_API_JSON}"
        FAILED_SLUGS+=("$ISSUE_SLUG")
      fi
    done

    # Record phase in phase_map
    PHASE_MAP_JSON=$(echo "$PHASE_MAP_JSON" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
d['${GLOBAL_PHASE_NUM}']={'milestone_index':${MILESTONE_INDEX},'gsd_route':'${GSD_ROUTE}','name':'${PHASE_NAME}'}
print(json.dumps(d))
")
  done
done
```
</step>

<step name="apply_dependencies">
**Pass 2: Apply dependency labels**

For each issue with `depends_on` entries, resolve slug → issue number, create
blocked-by labels, and record in cross-refs.json.

```bash
DEPENDENCY_ENTRIES=()
DEPENDENCY_DISPLAY=()

for RECORD in "${ISSUE_RECORDS[@]}"; do
  DEPENDENT_NUMBER=$(echo "$RECORD" | cut -d':' -f2)
  DEPENDS_ON_SLUGS=$(echo "$RECORD" | cut -d':' -f7)

  if [ -z "$DEPENDS_ON_SLUGS" ]; then
    continue
  fi

  for BLOCKING_SLUG in $(echo "$DEPENDS_ON_SLUGS" | tr ',' '\n'); do
    BLOCKING_SLUG=$(echo "$BLOCKING_SLUG" | tr -d ' ')
    if [ -z "$BLOCKING_SLUG" ]; then continue; fi

    # Resolve slug to issue number
    BLOCKING_NUMBER=""
    for MAPPING in "${SLUG_TO_NUMBER[@]}"; do
      MAP_SLUG=$(echo "$MAPPING" | cut -d':' -f1)
      MAP_NUM=$(echo "$MAPPING" | cut -d':' -f2)
      if [ "$MAP_SLUG" = "$BLOCKING_SLUG" ]; then
        BLOCKING_NUMBER="$MAP_NUM"
        break
      fi
    done

    if [ -z "$BLOCKING_NUMBER" ]; then
      echo "  WARNING: Cannot resolve dependency slug '${BLOCKING_SLUG}' for issue #${DEPENDENT_NUMBER} — skipping"
      continue
    fi

    # Create label (idempotent)
    gh label create "blocked-by:#${BLOCKING_NUMBER}" \
      --description "Blocked by issue #${BLOCKING_NUMBER}" \
      --color "e4e669" \
      --force 2>/dev/null

    # Apply label to dependent issue
    gh issue edit "${DEPENDENT_NUMBER}" --add-label "blocked-by:#${BLOCKING_NUMBER}" 2>/dev/null
    echo "  Applied: #${DEPENDENT_NUMBER} blocked-by:#${BLOCKING_NUMBER}"
    DEPENDENCY_DISPLAY+=("#${DEPENDENT_NUMBER} blocked-by:#${BLOCKING_NUMBER}")

    # Build cross-refs.json entry
    TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
    DEPENDENCY_ENTRIES+=("{\"a\":\"issue:${DEPENDENT_NUMBER}\",\"b\":\"issue:${BLOCKING_NUMBER}\",\"type\":\"blocked-by\",\"created\":\"${TIMESTAMP}\"}")
  done
done

# Write new entries to cross-refs.json
if [ ${#DEPENDENCY_ENTRIES[@]} -gt 0 ]; then
  EXISTING_LINKS=$(python3 -c "
import json
try:
  with open('${MGW_DIR}/cross-refs.json') as f:
    d=json.load(f)
  print(json.dumps(d.get('links',[])))
except:
  print('[]')
")
  ENTRIES_JSON=$(printf '%s\n' "${DEPENDENCY_ENTRIES[@]}" | python3 -c "
import json,sys
entries=[json.loads(line) for line in sys.stdin if line.strip()]
print(json.dumps(entries))
")
  python3 -c "
import json
existing=json.loads('''${EXISTING_LINKS}''')
new_entries=json.loads('''${ENTRIES_JSON}''')
combined={'links': existing + new_entries}
with open('${MGW_DIR}/cross-refs.json','w') as f:
  json.dump(combined, f, indent=2)
print('cross-refs.json updated with',len(new_entries),'entries')
"
fi
```
</step>

<step name="write_roadmap">
**Write GSD ROADMAP.md to the target project's .planning/ directory**

```bash
mkdir -p "${REPO_ROOT}/.planning"
ROADMAP_PATH="${REPO_ROOT}/.planning/ROADMAP.md"

if [ -f "$ROADMAP_PATH" ]; then
  echo "ROADMAP.md already exists — skipping (won't overwrite existing GSD work)"
  ROADMAP_STATUS="skipped (exists)"
else
  ROADMAP_STATUS="written"
fi
```

If ROADMAP.md does not exist, construct and write it using template data:

The ROADMAP.md must follow the GSD format from `/home/hat/.claude/get-shit-done/templates/roadmap.md`:

**Structure:**

```markdown
# Roadmap: {PROJECT_NAME}

## Overview

{DESCRIPTION}. This project follows the {TEMPLATE_TYPE} pipeline.

## Phases

- [ ] **Phase 1: {phase_name}** - {phase_description}
- [ ] **Phase 2: {phase_name}** - {phase_description}
...

## Phase Details

### Phase 1: {phase_name}
**Goal**: {phase_description}
**Depends on**: Nothing (first phase)
**Requirements**: (tracked in GitHub — see milestone "{milestone_name}")
**Success Criteria** (what must be TRUE):
  1. {issue_title_1}
  2. {issue_title_2}
  3. {issue_title_3}
**Plans**: TBD

Plans:
- [ ] 01-01: TBD

### Phase 2: {phase_name}
**Goal**: {phase_description}
**Depends on**: Phase 1
**Requirements**: (tracked in GitHub — see milestone "{milestone_name}")
**Success Criteria** (what must be TRUE):
  1. {issue_title_1}
  ...
**Plans**: TBD

Plans:
- [ ] 02-01: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. {phase_name} | 0/1 | Not started | - |
| 2. {phase_name} | 0/1 | Not started | - |
...
```

Generate this content using the template data from `$TEMPLATE_JSON`. Iterate over
milestones → phases → issues to build each section. Use the Write tool to create
the file at `$ROADMAP_PATH`.

**Mapping rules:**
- Each template phase → one GSD phase (numbered globally across milestones)
- Phase `description` → `**Goal**`
- Phase `issues[].title` → success criteria bullets (one per issue, as observable behaviors)
- First phase → `**Depends on**: Nothing (first phase)`, others → `**Depends on**: Phase N-1`
- Milestone name → Requirements milestone reference
- Plans section: always `TBD` initially with placeholder `{NN}-01: TBD`
</step>

<step name="write_project_json">
**Write .mgw/project.json with project state**

Build and write the project.json using the schema from 03-RESEARCH.md Pattern 4:

```bash
CREATED=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
```

Construct the JSON using python3 (to handle proper JSON encoding):

```python
import json, sys

template_data = json.loads('''TEMPLATE_JSON_HERE''')
template = template_data['template']

milestones_out = []
global_phase_num = 0

for m_idx, milestone in enumerate(template['milestones']):
    # Find GitHub data from MILESTONE_MAP
    m_entry = MILESTONE_MAP[m_idx]  # "idx:number:id:url"
    m_number = int(m_entry.split(':')[1]) if m_entry.split(':')[1] != 'FAILED' else None
    m_id_val = int(m_entry.split(':')[2]) if m_entry.split(':')[1] != 'FAILED' else None
    m_url = m_entry.split(':',3)[3] if m_entry.split(':')[1] != 'FAILED' else ''

    issues_out = []
    for phase in milestone.get('phases', []):
        global_phase_num += 1
        for issue in phase.get('issues', []):
            # Find github number from SLUG_TO_NUMBER
            slug = slugify(issue['title'])[:40]
            gh_num = SLUG_TO_NUMBER_MAP.get(slug)
            issues_out.append({
                "github_number": gh_num,
                "title": issue['title'],
                "phase_number": global_phase_num,
                "phase_name": phase['name'],
                "gsd_route": phase.get('gsd_route', 'plan-phase'),
                "labels": issue.get('labels', []),
                "depends_on_slugs": issue.get('depends_on', []),
                "pipeline_stage": "new"
            })

    milestones_out.append({
        "github_number": m_number,
        "github_id": m_id_val,
        "github_url": m_url,
        "name": milestone['name'],
        "template_milestone_index": m_idx,
        "issues": issues_out
    })

project_json = {
    "project": {
        "name": PROJECT_NAME,
        "description": DESCRIPTION,
        "repo": REPO,
        "template": TEMPLATE_TYPE,
        "created": CREATED
    },
    "milestones": milestones_out,
    "current_milestone": 1,
    "phase_map": PHASE_MAP
}
print(json.dumps(project_json, indent=2))
```

Write the output to `${MGW_DIR}/project.json`.

**In practice** (bash + python3 inline): construct the full project.json by assembling
data from `$TEMPLATE_JSON`, the milestone map built in create_milestones, the slug-to-number
map from create_issues, and the phase_map built during create_issues. Write using:

```bash
python3 << 'PYEOF' > "${MGW_DIR}/project.json"
import json, sys

# Read template data (passed via environment or inline)
template_data = json.loads(open('/dev/stdin').read() if False else '{}')
# ... (construct from available bash variables)
PYEOF
```

The simplest implementation: build the JSON structure incrementally during the
issue/milestone creation steps (maintaining bash arrays), then assemble them into
a python3 dictionary and write with `json.dumps(indent=2)` at this step.
</step>

<step name="report">
**Display post-init summary:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► PROJECT INIT — {PROJECT_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Template:  {TEMPLATE_TYPE} ({MILESTONE_COUNT} milestones, {TOTAL_PHASES} phases)
Repo:      {REPO}

Milestones created:
  #{number} {name}      → {url}
  ...

Issues scaffolded: {TOTAL_ISSUES_CREATED} total across {TOTAL_PHASES} phases

Dependencies:
  {list of "#{dependent} blocked-by:#{blocking}" entries}
  (or: "None declared in template")

GSD scaffold:
  .planning/ROADMAP.md      {written|skipped (exists)}

State:
  .mgw/project.json         written
  .mgw/cross-refs.json      {updated with N entries|unchanged}

Next:
  /mgw:milestone start      Execute first milestone
```

If any milestones or issues failed to create, include:
```
Warnings:
  Failed to create milestone: {name}
  Failed to create issue: {title}
  (review above and create missing items manually or re-run)
```

**CRITICAL BOUNDARY (PROJ-05):** This command ends here. It does NOT:
- Trigger /mgw:milestone or any execution workflow
- Spawn a GSD agent for ROADMAP.md (writes directly — fast and deterministic)
- Execute any issues or plans
</step>

</process>

<success_criteria>
- [ ] Verified git repo with GitHub remote
- [ ] .mgw/project.json does not exist (or exits cleanly if it does)
- [ ] Conversational input gathered (description, template type confirmed)
- [ ] Template loaded successfully via template-loader.cjs
- [ ] All milestones created on GitHub (Pass 1a)
- [ ] All issues created on GitHub with milestone assignment and phase labels (Pass 1b)
- [ ] Slug-to-number mapping built during Pass 1b
- [ ] Dependency labels applied (Pass 2) — blocked-by:#N on dependent issues
- [ ] cross-refs.json updated with dependency entries
- [ ] .planning/ROADMAP.md written in GSD format (or skipped if exists)
- [ ] .mgw/project.json written with full project state
- [ ] Post-init summary displayed
- [ ] Command does NOT trigger execution (PROJ-05)
</success_criteria>
