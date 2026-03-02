# Extend Project

## Precondition

`EXTEND_MODE = true` — set by `workflows/detect-state.md` when `STATE_CLASS = Extend` (all
milestones in project.json completed) or when the user chooses extend in the `Aligned` route.

Required variables already set:
- `REPO` — GitHub owner/repo slug
- `REPO_ROOT` — absolute path to repo root
- `MGW_DIR` — path to `.mgw/` directory
- `EXISTING_MILESTONE_COUNT` — number of milestones already in project.json
- `EXISTING_PHASE_COUNT` — highest phase number already used

## Postcondition

After this workflow completes:
- `PROJECT_NAME`, `STACK`, `PREFIX`, `DESCRIPTION` are set for the template generator
- `HISTORY_CONTEXT` is populated with existing milestone/issue history
- Growth Analytics banner has been displayed with AI-suggested next areas
- User has provided `EXTENSION_DESCRIPTION` describing the new milestones to add
- Ready to proceed to `generate_template` step in project.md

---

<step name="gather_inputs_extend">
**Load existing project metadata and gather extension description:**

When `EXTEND_MODE=true`, skip the fresh project questions and instead load existing metadata:

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

  # ── Growth Analytics ────────────────────────────────────────────────────────
  # Compute milestone completion stats and issue velocity from project.json.
  # Query open blockers from GitHub API. Spawn an AI suggester agent.
  # Display a summary banner BEFORE asking for the extension description.

  ANALYTICS=$(python3 -c "
import json, sys

p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
milestones = p.get('milestones', [])
total_milestones = len(milestones)
completed_milestones = sum(1 for m in milestones if m.get('gsd_state') == 'completed')

# Issue velocity: avg closed issues per completed milestone
total_closed = sum(
    sum(1 for i in m.get('issues', []) if i.get('pipeline_stage') in ('done', 'pr-created'))
    for m in milestones if m.get('gsd_state') == 'completed'
)
velocity = round(total_closed / completed_milestones, 1) if completed_milestones > 0 else 0

print(f'{completed_milestones}|{total_milestones}|{velocity}|{total_closed}')
")

  COMPLETED_COUNT=$(echo "$ANALYTICS" | cut -d'|' -f1)
  TOTAL_COUNT=$(echo "$ANALYTICS"    | cut -d'|' -f2)
  VELOCITY=$(echo "$ANALYTICS"       | cut -d'|' -f3)
  TOTAL_CLOSED=$(echo "$ANALYTICS"   | cut -d'|' -f4)

  # Count open issues labeled blocked-by:* or with a "blocked" status
  OPEN_BLOCKERS=$(gh api "repos/${REPO}/issues" \
    --jq '[.[] | select(.state=="open") | select(.labels[].name | test("^blocked-by:"))] | length' \
    2>/dev/null || echo "0")

  # Spawn growth-suggester agent — reads milestone names + completed issue titles
  # and produces natural next-area suggestions. No application code reads.
  COMPLETED_ISSUE_TITLES=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
titles = []
for m in p.get('milestones', []):
    if m.get('gsd_state') == 'completed':
        for i in m.get('issues', []):
            if i.get('pipeline_stage') in ('done', 'pr-created'):
                titles.append(f\"  - [{m['name']}] {i['title']}\")
print('\n'.join(titles) if titles else '  (no completed issues recorded)')
")

  MILESTONE_LIST=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
for m in p.get('milestones', []):
    state = m.get('gsd_state', 'unknown')
    print(f\"  {m['name']} ({state})\")
")

  MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model general-purpose 2>/dev/null || echo "claude-sonnet-4-5")

  SUGGESTER_OUTPUT=$(Task(
    description="Suggest natural next milestone areas for project extension",
    subagent_type="general-purpose",
    prompt="
You are a growth-suggester agent for a software project planning tool.

Project: ${PROJECT_NAME}
Repo: ${REPO}

Milestones built so far:
${MILESTONE_LIST}

Completed issues (represents what has been built):
${COMPLETED_ISSUE_TITLES}

Based ONLY on the above context — what has been built and what the project does —
suggest 3-5 natural next areas for extension milestones. Each suggestion should:
- Build on or complement existing milestones (no overlap)
- Be a coherent milestone-sized body of work (not a single feature)
- Be expressed as a short label (5-10 words) with a 1-sentence rationale

Output format — plain text only, one suggestion per line:
  1. {Milestone Area Name}: {one-sentence rationale}
  2. ...

Do not add preamble, headers, or closing text. Output ONLY the numbered list.
"
  ))

  AI_SUGGESTIONS="${SUGGESTER_OUTPUT:-  (AI suggestions unavailable)}"

  # Display growth analytics banner
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " ${PROJECT_NAME} — Growth Analytics"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Milestones completed : ${COMPLETED_COUNT} of ${TOTAL_COUNT}"
  echo "  Issue velocity       : ${VELOCITY} issues/milestone avg (${TOTAL_CLOSED} total closed)"
  echo "  Open blockers        : ${OPEN_BLOCKERS}"
  echo ""
  echo "  AI-suggested next areas:"
  echo "${AI_SUGGESTIONS}" | sed 's/^/  /'
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  # ── End Growth Analytics ────────────────────────────────────────────────────

  # Ask only for the new work — different question for extend mode
  # Ask: "What new milestones should we add to ${PROJECT_NAME}?"
  # Capture as EXTENSION_DESCRIPTION

  DESCRIPTION="Extension of existing project. Existing milestones: ${EXISTING_MILESTONE_NAMES}. New work: ${EXTENSION_DESCRIPTION}"
fi
```
</step>
