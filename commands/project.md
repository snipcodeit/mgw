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

MGW does NOT write to .planning/ — that directory is owned by GSD. If a project needs
a ROADMAP.md or other GSD files, run the appropriate GSD command (e.g., /gsd:new-milestone)
after project initialization.

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
  # Check if all milestones are complete
  ALL_COMPLETE=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
milestones = p.get('milestones', [])
current = p.get('current_milestone', 1)
# All complete when current_milestone exceeds array length
# (milestone.md increments current_milestone after completing each)
all_done = current > len(milestones) and len(milestones) > 0
print('true' if all_done else 'false')
")

  if [ "$ALL_COMPLETE" = "true" ]; then
    EXTEND_MODE=true
    EXISTING_MILESTONE_COUNT=$(python3 -c "import json; print(len(json.load(open('${REPO_ROOT}/.mgw/project.json'))['milestones']))")
    EXISTING_PHASE_COUNT=$(python3 -c "import json; print(max((int(k) for k in json.load(open('${REPO_ROOT}/.mgw/project.json')).get('phase_map',{}).keys()), default=0))")
    echo "All ${EXISTING_MILESTONE_COUNT} milestones complete. Entering extend mode."
    echo "Phase numbering will continue from phase ${EXISTING_PHASE_COUNT}."
  else
    echo "Project already initialized. Run /mgw:milestone to continue."
    exit 0
  fi
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
- Capture the project description as `$DESCRIPTION`. Be conversational and encourage detail about the domain, purpose, and target users.

**Question 2 (optional):** "Anything else I should know? (tech stack preferences, target audience, key constraints — or press Enter to skip)"
- Append any additional context to `$DESCRIPTION` if provided.

Do NOT ask the user to pick a template type. Do NOT present a list of web-app/cli-tool/library options. The AI will generate project-specific content directly from the description.

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

**In extend mode, load existing metadata and ask for new milestones:**

When `EXTEND_MODE=true`, skip the questions above and instead:

```bash
if [ "$EXTEND_MODE" = true ]; then
  # Load existing project metadata — name, repo, stack, prefix are already known
  PROJECT_NAME=$(python3 -c "import json; print(json.load(open('${REPO_ROOT}/.mgw/project.json'))['project']['name'])")
  STACK=$(python3 -c "import json; print(json.load(open('${REPO_ROOT}/.mgw/project.json'))['project'].get('stack','unknown'))")
  PREFIX=$(python3 -c "import json; print(json.load(open('${REPO_ROOT}/.mgw/project.json'))['project'].get('prefix','v1'))")
  EXISTING_MILESTONE_NAMES=$(python3 -c "import json; p=json.load(open('${REPO_ROOT}/.mgw/project.json')); print(', '.join(m['name'] for m in p['milestones']))")

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
</step>

<step name="generate_template">
**Generate a project-specific template using AI:**

First, read the schema to understand the required output structure:

```bash
SCHEMA=$(node "${REPO_ROOT}/lib/template-loader.cjs" schema)
```

Now, as the AI executing this command, generate a complete project template JSON for this specific project. The JSON must:

1. Match the schema structure: milestones > phases > issues with all required fields
2. Use a descriptive `type` value that fits the project (e.g., "game", "mobile-app", "saas-platform", "data-pipeline", "api-service", "developer-tool", "browser-extension", etc. — NOT limited to web-app/cli-tool/library)
3. Contain 2-4 milestones with 1-3 phases each, each phase having 2-4 issues
4. Have issue titles that are specific and actionable — referencing the actual project domain, not generic placeholders like "Implement primary feature set"
5. Have issue descriptions that reference the actual project context
6. Use `depends_on` slugs following the convention: lowercase title, spaces-to-hyphens, truncated to 40 chars (e.g., "design-core-game-loop-and-player-mechanic")
7. Choose `gsd_route` values appropriately:
   - `plan-phase` for complex multi-step implementation work
   - `quick` for small well-defined tasks
   - `research-phase` for unknowns requiring investigation
   - `execute-phase` for straightforward mechanical execution
8. Use specific, relevant labels (not just "phase-N") — e.g., "backend", "frontend", "game-design", "ml", "database", "ui/ux", "performance", "security"
9. Set `version` to "1.0.0"
10. Include the standard `parameters` section with `project_name` and `description` as required params, and `repo`, `stack`, `prefix` as optional params
11. Include a `project` object with `name`, `description`, `repo`, `stack`, and `prefix` fields filled from the gathered inputs

Output the generated JSON as a fenced code block (```json ... ```).

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

After generating the JSON, extract it and write to a temp file:

```bash
# Write AI-generated JSON to temp file
# (Claude writes the JSON using the Write tool to /tmp/mgw-template.json)
```

**Validate the generated JSON:**

```bash
node "${REPO_ROOT}/lib/template-loader.cjs" validate < /tmp/mgw-template.json
```

If validation fails, review the errors and regenerate with corrections. Repeat until validation passes.

If validation passes, parse key metrics:

```bash
MILESTONE_COUNT=$(python3 -c "import json; d=json.load(open('/tmp/mgw-template.json')); print(len(d['milestones']))")
TOTAL_PHASES=$(python3 -c "import json; d=json.load(open('/tmp/mgw-template.json')); print(sum(len(m['phases']) for m in d['milestones']))")
GENERATED_TYPE=$(python3 -c "import json; d=json.load(open('/tmp/mgw-template.json')); print(d['type'])")
```
</step>

<step name="create_milestones">
**Pass 1a: Create GitHub milestones**

For each milestone in the generated template (iterate by index):

```bash
# Iterate over milestones in the generated template
MILESTONE_MAP=()  # bash array: index -> "number:id:url"

for MILESTONE_INDEX in $(seq 0 $((MILESTONE_COUNT - 1))); do
  MILESTONE_NAME=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['name'])
")
  MILESTONE_DESC=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}].get('description',''))
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
# In extend mode, continue numbering from last existing phase
if [ "$EXTEND_MODE" = true ]; then
  GLOBAL_PHASE_NUM=$EXISTING_PHASE_COUNT
else
  GLOBAL_PHASE_NUM=0
fi

for MILESTONE_INDEX in $(seq 0 $((MILESTONE_COUNT - 1))); do
  # Get this milestone's GitHub number from MILESTONE_MAP
  M_ENTRY="${MILESTONE_MAP[$MILESTONE_INDEX]}"
  M_NUMBER=$(echo "$M_ENTRY" | cut -d':' -f2)

  if [ "$M_NUMBER" = "FAILED" ]; then
    echo "  Skipping issues for failed milestone at index ${MILESTONE_INDEX}"
    continue
  fi

  PHASE_COUNT=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(len(d['milestones'][${MILESTONE_INDEX}]['phases']))
")

  for PHASE_INDEX in $(seq 0 $((PHASE_COUNT - 1))); do
    GLOBAL_PHASE_NUM=$((GLOBAL_PHASE_NUM + 1))

    PHASE_NAME=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['name'])
")
    PHASE_DESC=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}].get('description',''))
")
    GSD_ROUTE=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}].get('gsd_route','plan-phase'))
")
    MILESTONE_NAME=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['name'])
")

    # Generate phase slug for label
    PHASE_SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${PHASE_NAME}" --raw 2>/dev/null | head -c 40 || echo "${PHASE_NAME,,}" | tr ' ' '-' | cut -c1-40)

    # Create phase label (idempotent)
    gh label create "phase:${GLOBAL_PHASE_NUM}-${PHASE_SLUG}" \
      --description "Phase ${GLOBAL_PHASE_NUM}: ${PHASE_NAME}" \
      --color "0075ca" \
      --force 2>/dev/null

    ISSUE_COUNT=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(len(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues']))
")

    for ISSUE_INDEX in $(seq 0 $((ISSUE_COUNT - 1))); do
      ISSUE_TITLE=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}]['title'])
")
      ISSUE_DESC=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
print(d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}].get('description',''))
")
      ISSUE_LABELS_JSON=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
labels=d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}].get('labels',[])
print(','.join(labels))
")
      DEPENDS_ON_JSON=$(python3 -c "
import json
d=json.load(open('/tmp/mgw-template.json'))
deps=d['milestones'][${MILESTONE_INDEX}]['phases'][${PHASE_INDEX}]['issues'][${ISSUE_INDEX}].get('depends_on',[])
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

<step name="create_project_board">
**Create GitHub Projects v2 board and add all issues:**

```bash
OWNER=$(echo "$REPO" | cut -d'/' -f1)

if [ "$EXTEND_MODE" = true ]; then
  # Reuse existing project board — load number and URL from project.json
  EXISTING_BOARD=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
board = p.get('project', {}).get('project_board', {})
print(json.dumps(board))
")
  PROJECT_NUMBER=$(echo "$EXISTING_BOARD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('number',''))")
  PROJECT_URL=$(echo "$EXISTING_BOARD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('url',''))")

  if [ -n "$PROJECT_NUMBER" ]; then
    echo "  Reusing existing project board: #${PROJECT_NUMBER} — ${PROJECT_URL}"

    # Add only NEW issues to the existing board
    for RECORD in "${ISSUE_RECORDS[@]}"; do
      ISSUE_NUM=$(echo "$RECORD" | cut -d':' -f2)
      ISSUE_URL="https://github.com/${REPO}/issues/${ISSUE_NUM}"
      gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$ISSUE_URL" 2>/dev/null || true
    done
    echo "  Added ${TOTAL_ISSUES_CREATED} new issues to existing project board"
  else
    # Board not found — fall through to create a new one
    EXTEND_MODE_BOARD=false
  fi
fi

if [ "$EXTEND_MODE" != true ] || [ "$EXTEND_MODE_BOARD" = false ]; then
  # Create a new project board (standard flow or extend fallback)
  PROJECT_RESP=$(gh project create --owner "$OWNER" --title "${PROJECT_NAME} Roadmap" --format json 2>&1)
  PROJECT_NUMBER=$(echo "$PROJECT_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])" 2>/dev/null || echo "")
  PROJECT_URL=$(echo "$PROJECT_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])" 2>/dev/null || echo "")

  if [ -n "$PROJECT_NUMBER" ]; then
    echo "  Created project board: #${PROJECT_NUMBER} — ${PROJECT_URL}"

    # Add all issues to the board
    for RECORD in "${ISSUE_RECORDS[@]}"; do
      ISSUE_NUM=$(echo "$RECORD" | cut -d':' -f2)
      ISSUE_URL="https://github.com/${REPO}/issues/${ISSUE_NUM}"
      gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$ISSUE_URL" 2>/dev/null || true
    done
    echo "  Added ${TOTAL_ISSUES_CREATED} issues to project board"
  else
    echo "  WARNING: Failed to create project board: ${PROJECT_RESP}"
    PROJECT_NUMBER=""
    PROJECT_URL=""
  fi
fi
```

Store `PROJECT_NUMBER` and `PROJECT_URL` for inclusion in project.json and the summary report.
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

template_data = json.load(open('/tmp/mgw-template.json'))

milestones_out = []
global_phase_num = 0

for m_idx, milestone in enumerate(template_data['milestones']):
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
        "template": GENERATED_TYPE,
        "created": CREATED,
        "project_board": {
            "number": PROJECT_NUMBER or None,
            "url": PROJECT_URL or None
        }
    },
    "milestones": milestones_out,
    "current_milestone": 1,
    "phase_map": PHASE_MAP
}
print(json.dumps(project_json, indent=2))
```

Write the output to `${MGW_DIR}/project.json`.

**In practice** (bash + python3 inline): construct the full project.json by assembling
data from `/tmp/mgw-template.json`, the milestone map built in create_milestones, the slug-to-number
map from create_issues, and the phase_map built during create_issues. Write using:

```bash
python3 << 'PYEOF' > "${MGW_DIR}/project.json"
import json, sys

# Read template data from the validated generated file
template_data = json.load(open('/tmp/mgw-template.json'))
# ... (construct from available bash variables)
PYEOF
```

The simplest implementation: build the JSON structure incrementally during the
issue/milestone creation steps (maintaining bash arrays), then assemble them into
a python3 dictionary and write with `json.dumps(indent=2)` at this step.

Note: use `GENERATED_TYPE` (read from `/tmp/mgw-template.json`) for the `template` field in project.json,
not a hardcoded template name.

**In extend mode, use mergeProjectState instead of full write:**

When `EXTEND_MODE=true`, do NOT write a full project.json. Instead, build only the new milestones
and phase_map entries (with `template_milestone_index` offset by `EXISTING_MILESTONE_COUNT`), then call:

```bash
# Compute the current_milestone pointer for the first new milestone (1-indexed)
NEW_CURRENT_MILESTONE=$((EXISTING_MILESTONE_COUNT + 1))

# Call mergeProjectState via Node — appends without overwriting existing data
node -e "
const { mergeProjectState } = require('${REPO_ROOT}/lib/state.cjs');
const newMilestones = JSON.parse(process.argv[1]);
const newPhaseMap = JSON.parse(process.argv[2]);
const newCurrentMilestone = parseInt(process.argv[3]);
const merged = mergeProjectState(newMilestones, newPhaseMap, newCurrentMilestone);
console.log('project.json updated: ' + merged.milestones.length + ' total milestones');
" "$NEW_MILESTONES_JSON" "$NEW_PHASE_MAP_JSON" "$NEW_CURRENT_MILESTONE"
```

Where `NEW_MILESTONES_JSON` and `NEW_PHASE_MAP_JSON` are JSON-encoded strings built from only
the newly created milestones/phases (matching the existing project.json schema). The
`template_milestone_index` for each new milestone should be offset by `EXISTING_MILESTONE_COUNT`
so indices remain globally unique.

When `EXTEND_MODE` is false, the existing write logic (full project.json from scratch) is unchanged.
</step>

<step name="report">
**Display post-init summary:**

In extend mode, show the extended banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► PROJECT EXTENDED — {PROJECT_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Extended with {NEW_MILESTONE_COUNT} new milestones (total: {TOTAL_MILESTONES})
Phase numbering: continued from {EXISTING_PHASE_COUNT} (new phases: {EXISTING_PHASE_COUNT+1}–{NEW_MAX_PHASE})
Board: reused #{PROJECT_NUMBER}

(remaining output follows the same format as project init for the new milestones/issues)
```

In standard (non-extend) mode, show the original init banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► PROJECT INIT — {PROJECT_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Type:      {GENERATED_TYPE} ({MILESTONE_COUNT} milestones, {TOTAL_PHASES} phases)
Repo:      {REPO}
Board:     ${PROJECT_URL ? PROJECT_URL : '(not created)'}

Milestones created:
  #{number} {name}      → {url}
  ...

Issues scaffolded: {TOTAL_ISSUES_CREATED} total across {TOTAL_PHASES} phases

Dependencies:
  {list of "#{dependent} blocked-by:#{blocking}" entries}
  (or: "None declared in template")

State:
  .mgw/project.json         written
  .mgw/cross-refs.json      {updated with N entries|unchanged}

Next:
  /gsd:new-milestone         Create GSD ROADMAP.md (if needed)
  /mgw:milestone start       Execute first milestone
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
- Write to .planning/ (GSD owns that directory — run /gsd:new-milestone to scaffold)
- Execute any issues or plans
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
- [ ] .mgw/project.json written with full project state
- [ ] Post-init summary displayed
- [ ] Command does NOT trigger execution (PROJ-05)
- [ ] Extend mode: all milestones complete detected, new milestones appended, existing data preserved
</success_criteria>
