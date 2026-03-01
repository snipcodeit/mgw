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
**Detect existing project state from five signal sources:**

Check five signals to determine what already exists for this project:

```bash
# Signal checks
P=false  # .planning/PROJECT.md exists
R=false  # .planning/ROADMAP.md exists
S=false  # .planning/STATE.md exists
M=false  # .mgw/project.json exists
G=0      # GitHub milestone count

[ -f "${REPO_ROOT}/.planning/PROJECT.md" ] && P=true
[ -f "${REPO_ROOT}/.planning/ROADMAP.md" ] && R=true
[ -f "${REPO_ROOT}/.planning/STATE.md" ] && S=true
[ -f "${REPO_ROOT}/.mgw/project.json" ] && M=true

G=$(gh api "repos/${REPO}/milestones" --jq 'length' 2>/dev/null || echo 0)
```

**Classify into STATE_CLASS:**

| State | P | R | S | M | G | Meaning |
|---|---|---|---|---|---|---|
| Fresh | false | false | false | false | 0 | Clean slate — no GSD, no MGW |
| GSD-Only | true | false | false | false | 0 | PROJECT.md present but no roadmap yet |
| GSD-Mid-Exec | true | true | true | false | 0 | GSD in progress, MGW not yet linked |
| Aligned | true | — | — | true | >0 | Both MGW + GitHub consistent with each other |
| Diverged | — | — | — | true | >0 | MGW + GitHub present but inconsistent |
| Extend | true | — | — | true | >0 | All milestones in project.json are done |

```bash
# Classification logic
STATE_CLASS="Fresh"
EXTEND_MODE=false

if [ "$M" = "true" ] && [ "$G" -gt 0 ]; then
  # Check if all milestones are complete (Extend detection)
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
    STATE_CLASS="Extend"
    EXTEND_MODE=true
    EXISTING_MILESTONE_COUNT=$(python3 -c "import json; print(len(json.load(open('${REPO_ROOT}/.mgw/project.json'))['milestones']))")
    EXISTING_PHASE_COUNT=$(python3 -c "import json; print(max((int(k) for k in json.load(open('${REPO_ROOT}/.mgw/project.json')).get('phase_map',{}).keys()), default=0))")
  else
    # M=true, G>0, not all done — check consistency (Aligned vs Diverged)
    GH_MILESTONE_COUNT=$G
    LOCAL_MILESTONE_COUNT=$(python3 -c "import json; print(len(json.load(open('${REPO_ROOT}/.mgw/project.json')).get('milestones', [])))")

    # Consistency: milestone counts match and names overlap
    CONSISTENCY_OK=$(python3 -c "
import json, subprocess, sys
local = json.load(open('${REPO_ROOT}/.mgw/project.json'))
local_names = set(m['name'] for m in local.get('milestones', []))
local_count = len(local_names)
gh_count = ${GH_MILESTONE_COUNT}

# Count mismatch is a drift signal (allow off-by-one for in-flight)
if abs(local_count - gh_count) > 1:
    print('false')
    sys.exit(0)

# Name overlap check: at least 50% of local milestone names found on GitHub
result = subprocess.run(
    ['gh', 'api', 'repos/${REPO}/milestones', '--jq', '[.[].title]'],
    capture_output=True, text=True
)
try:
    gh_names = set(json.loads(result.stdout))
    overlap = len(local_names & gh_names)
    print('true' if overlap >= max(1, local_count // 2) else 'false')
except Exception:
    print('false')
")

    if [ "$CONSISTENCY_OK" = "true" ]; then
      STATE_CLASS="Aligned"
    else
      STATE_CLASS="Diverged"
    fi
  fi
elif [ "$M" = "false" ] && [ "$G" -eq 0 ]; then
  # No MGW state, no GitHub milestones — GSD signals determine class
  if [ "$P" = "true" ] && [ "$R" = "true" ] && [ "$S" = "true" ]; then
    STATE_CLASS="GSD-Mid-Exec"
  elif [ "$P" = "true" ] && [ "$R" = "true" ]; then
    STATE_CLASS="GSD-Mid-Exec"
  elif [ "$P" = "true" ]; then
    STATE_CLASS="GSD-Only"
  else
    STATE_CLASS="Fresh"
  fi
fi

echo "State detected: ${STATE_CLASS} (P=${P} R=${R} S=${S} M=${M} G=${G})"
```

**Route by STATE_CLASS:**

```bash
case "$STATE_CLASS" in
  "Fresh")
    # Proceed to gather_inputs (standard flow)
    ;;

  "GSD-Only"|"GSD-Mid-Exec")
    # GSD artifacts exist but MGW not initialized — delegate to align_from_gsd
    # (proceed to align_from_gsd step)
    ;;

  "Aligned")
    # MGW + GitHub consistent — display status and offer extend mode
    TOTAL_ISSUES=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
print(sum(len(m.get('issues', [])) for m in p.get('milestones', [])))
")
    echo ""
    echo "Project already initialized and aligned with GitHub."
    echo "  Milestones: ${LOCAL_MILESTONE_COUNT} local / ${GH_MILESTONE_COUNT} on GitHub"
    echo "  Issues: ${TOTAL_ISSUES} tracked in project.json"
    echo ""
    echo "Options:"
    echo "  /mgw:milestone       Execute the next milestone"
    echo "  /mgw:status          View project status dashboard"
    echo "  /mgw:project         Re-run with description to extend (adds new milestones)"
    echo ""
    echo "To add new milestones to this project, describe the new work you want to add."
    echo "Otherwise, run /mgw:milestone to continue executing existing work."
    exit 0
    ;;

  "Diverged")
    # MGW + GitHub inconsistent — delegate to reconcile_drift
    # (proceed to reconcile_drift step)
    ;;

  "Extend")
    # All milestones done — entering extend mode
    echo "All ${EXISTING_MILESTONE_COUNT} milestones complete. Entering extend mode."
    echo "Phase numbering will continue from phase ${EXISTING_PHASE_COUNT}."
    # Proceed to gather_inputs in extend mode (EXTEND_MODE=true already set)
    ;;
esac
```
</step>

<step name="align_from_gsd">
**Align MGW state from existing GSD artifacts (STATE_CLASS = GSD-Only or GSD-Mid-Exec):**

Spawn alignment-analyzer agent:

Task(
  description="Analyze GSD state for alignment",
  subagent_type="general-purpose",
  prompt="
<files_to_read>
- ./CLAUDE.md
- .planning/PROJECT.md (if exists)
- .planning/ROADMAP.md (if exists)
- .planning/MILESTONES.md (if exists)
- .planning/STATE.md (if exists)
</files_to_read>

Analyze existing GSD project state and produce an alignment report.

Read each file that exists. Extract:
- Project name and description from PROJECT.md (H1 heading, description paragraph)
- Active milestone: from ROADMAP.md header or STATE.md current milestone name
- Archived milestones: from MILESTONES.md — list each milestone with name and phase count
- Phases per milestone: from ROADMAP.md sections (### Phase N:) and MILESTONES.md

For each milestone found:
- name: milestone name string
- source: 'ROADMAP' (if from current ROADMAP.md) or 'MILESTONES' (if archived)
- state: 'active' (ROADMAP source), 'completed' (archived in MILESTONES.md), 'planned' (referenced but not yet created)
- phases: array of { number, name, status } objects

<output>
Write JSON to .mgw/alignment-report.json:
{
  \"project_name\": \"extracted from PROJECT.md\",
  \"project_description\": \"extracted from PROJECT.md\",
  \"milestones\": [
    {
      \"name\": \"milestone name\",
      \"source\": \"ROADMAP|MILESTONES\",
      \"state\": \"active|completed|planned\",
      \"phases\": [{ \"number\": N, \"name\": \"...\", \"status\": \"...\" }]
    }
  ],
  \"active_milestone\": \"name of currently active milestone or null\",
  \"total_phases\": N,
  \"total_issues_estimated\": N
}
</output>
"
)

After agent completes:
1. Read .mgw/alignment-report.json
2. Display alignment summary to user:
   - Project: {project_name}
   - Milestones found: {count} ({active_milestone} active, N completed)
   - Phases: {total_phases} total, ~{total_issues_estimated} issues estimated
3. Ask: "Import this GSD state into MGW? This will create GitHub milestones and issues, and build project.json. (Y/N)"
4. If Y: proceed to step milestone_mapper
5. If N: exit with message "Run /mgw:project again when ready to import."
</step>

<step name="milestone_mapper">
**Map GSD milestones to GitHub milestones:**

Read .mgw/alignment-report.json produced by the alignment-analyzer agent.

```bash
ALIGNMENT=$(python3 -c "
import json
with open('.mgw/alignment-report.json') as f:
    data = json.load(f)
print(json.dumps(data))
")
```

For each milestone in the alignment report:
1. Check if a GitHub milestone with a matching title already exists:
   ```bash
   gh api repos/${REPO}/milestones --jq '.[].title'
   ```
2. If not found: create it:
   ```bash
   gh api repos/${REPO}/milestones -X POST \
     -f title="${MILESTONE_NAME}" \
     -f description="Imported from GSD: ${MILESTONE_SOURCE}" \
     -f state="open"
   ```
   Capture the returned `number` as GITHUB_MILESTONE_NUMBER.
3. If found: use the existing milestone's number.
4. For each phase in the milestone: create GitHub issues (one per phase, title = phase name, body includes phase goals and gsd_route). Use the same issue creation pattern as the existing `create_issues` step.
5. Add project.json entry for this milestone using the new schema fields:
   ```json
   {
     "github_number": GITHUB_MILESTONE_NUMBER,
     "name": milestone_name,
     "gsd_milestone_id": null,
     "gsd_state": "active|completed based on alignment report state",
     "roadmap_archived_at": null
   }
   ```
6. Add maps-to cross-ref entry:
   ```bash
   # Append to .mgw/cross-refs.json
   TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
   # Add entry: { "a": "milestone:${GITHUB_NUMBER}", "b": "gsd-milestone:${GSD_ID}", "type": "maps-to", "created": "${TIMESTAMP}" }
   ```

After all milestones are mapped:
- Write updated project.json with all milestone entries and new schema fields
- Set active_gsd_milestone to the name of the 'active' milestone from alignment report
- Display mapping summary:
  ```
  Mapped N GSD milestones → GitHub milestones:
    ✓ "Milestone Name" → #N (created/existing)
    ...
  cross-refs.json updated with N maps-to entries
  ```
- Proceed to create_project_board step (existing step — reused for new project)
</step>

<step name="reconcile_drift">
**Reconcile diverged state (STATE_CLASS = Diverged):**

Spawn drift-analyzer agent:

Task(
  description="Analyze project state drift",
  subagent_type="general-purpose",
  prompt="
<files_to_read>
- ./CLAUDE.md
- .mgw/project.json
</files_to_read>

Compare .mgw/project.json with live GitHub state.

1. Read project.json: parse milestones array, get repo name from project.repo
2. Query GitHub milestones:
   gh api repos/{REPO}/milestones --jq '.[] | {number, title, state, open_issues, closed_issues}'
3. For each milestone in project.json:
   - Does a GitHub milestone with matching title exist? (fuzzy: case-insensitive, strip emoji)
   - If no match: flag as missing_github
   - If match: compare issue count (open + closed GitHub vs issues array length)
4. For each GitHub milestone NOT matched to project.json entry: flag as missing_local
5. For issues: check pipeline_stage vs GitHub issue state
   - GitHub closed + local not 'done' or 'pr-created': flag as stage_mismatch

<output>
Write JSON to .mgw/drift-report.json:
{
  \"mismatches\": [
    {\"type\": \"missing_github\", \"milestone_name\": \"...\", \"local_issue_count\": N, \"action\": \"create_github_milestone\"},
    {\"type\": \"missing_local\", \"github_number\": N, \"github_title\": \"...\", \"action\": \"import_to_project_json\"},
    {\"type\": \"count_mismatch\", \"milestone_name\": \"...\", \"local\": N, \"github\": M, \"action\": \"review_manually\"},
    {\"type\": \"stage_mismatch\", \"issue\": N, \"local_stage\": \"...\", \"github_state\": \"closed\", \"action\": \"update_local_stage\"}
  ],
  \"summary\": \"N mismatches found across M milestones\"
}
</output>
"
)

After agent completes:
1. Read .mgw/drift-report.json
2. Display mismatches as a table:

   | Type | Detail | Suggested Action |
   |------|--------|-----------------|
   | missing_github | Milestone: {name} ({N} local issues) | Create GitHub milestone |
   | missing_local | GitHub #N: {title} | Import to project.json |
   | count_mismatch | {name}: local={N}, github={M} | Review manually |
   | stage_mismatch | Issue #{N}: local={stage}, github=closed | Update local stage to done |

3. If no mismatches: echo "No drift detected — state is consistent. Reclassifying as Aligned." and proceed to report alignment status.
4. If mismatches: Ask "Apply auto-fixes? Options: (A)ll / (S)elective / (N)one"
   - All: apply each action (create missing milestones, update stages in project.json)
   - Selective: present each fix individually, Y/N per item
   - None: exit with "Drift noted. Run /mgw:sync to reconcile later."
5. After applying fixes: write updated project.json and display summary.
</step>

<step name="vision_intake">
**Intake: capture the raw project idea (Fresh path only)**

If STATE_CLASS != Fresh: skip this step.

Display to user:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► VISION CYCLE — Let's Build Your Project
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tell me about the project you want to build. Don't worry
about being complete or precise — just describe the idea,
the problem you're solving, and who it's for.
```

Capture freeform user input as RAW_IDEA.

```bash
TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
```

Save to `.mgw/vision-draft.md`:
```markdown
---
current_stage: intake
rounds_completed: 0
soft_cap_reached: false
---

# Vision Draft

## Intake
**Raw Idea:** {RAW_IDEA}
**Captured:** {TIMESTAMP}
```

Proceed to vision_research step.
</step>

<step name="vision_research">
**Domain Expansion: spawn vision-researcher agent (silent)**

If STATE_CLASS != Fresh: skip this step.

Spawn vision-researcher Task agent:

Task(
  description="Research project domain and platform requirements",
  subagent_type="general-purpose",
  prompt="
You are a domain research agent for a new software project.

Raw idea from user:
{RAW_IDEA}

Research this project idea and produce a domain analysis. Write your output to .mgw/vision-research.json.

Your analysis must include:

1. **domain_analysis**: What does this domain actually require to succeed?
   - Core capabilities users expect
   - Table stakes vs differentiators
   - Common failure modes in this domain

2. **platform_requirements**: Specific technical/integration needs
   - APIs, third-party services the domain typically needs
   - Compliance or regulatory considerations
   - Platform targets (mobile, web, desktop, API-only)

3. **competitive_landscape**: What similar solutions exist?
   - 2-3 examples with their key approaches
   - Gaps in existing solutions that this could fill

4. **risk_factors**: Common failure modes for this type of project
   - Technical risks
   - Business/adoption risks
   - Scope creep patterns in this domain

5. **suggested_questions**: 6-10 targeted questions to ask the user
   - Prioritized by most impactful for scoping
   - Each question should clarify a decision that affects architecture or milestone structure
   - Format: [{\"question\": \"...\", \"why_it_matters\": \"...\"}, ...]

Output format — write to .mgw/vision-research.json:
{
  \"domain_analysis\": {\"core_capabilities\": [...], \"differentiators\": [...], \"failure_modes\": [...]},
  \"platform_requirements\": [...],
  \"competitive_landscape\": [{\"name\": \"...\", \"approach\": \"...\"}],
  \"risk_factors\": [...],
  \"suggested_questions\": [{\"question\": \"...\", \"why_it_matters\": \"...\"}]
}
"
)

After agent completes:
- Read .mgw/vision-research.json
- Append research summary to .mgw/vision-draft.md:
  ```markdown
  ## Domain Research (silent)
  - Domain: {domain from analysis}
  - Key platform requirements: {top 3}
  - Risks identified: {count}
  - Questions generated: {count}
  ```
- Update vision-draft.md frontmatter: current_stage: questioning
- Proceed to vision_questioning step.
</step>

<step name="vision_questioning">
**Structured Questioning Loop (Fresh path only)**

If STATE_CLASS != Fresh: skip this step.

Read .mgw/vision-research.json to get suggested_questions.
Read .mgw/vision-draft.md to get current state.

Initialize loop:
```bash
ROUND=0
SOFT_CAP=8
HARD_CAP=15
SOFT_CAP_REACHED=false
```

**Questioning loop:**

Each round:

1. Load questions remaining from .mgw/vision-research.json suggested_questions (dequeue used ones).
   Also allow orchestrator to generate follow-up questions based on previous answers.

2. Present 2-4 questions to user (never more than 4 per round):
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Vision Cycle — Round {N} of {SOFT_CAP}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   1) {question_1}
   2) {question_2}
   3) {question_3}

   (Answer all, some, or type 'done' to proceed to synthesis)
   ```

3. Capture user answers as ANSWERS_ROUND_N.

4. Append round to .mgw/vision-draft.md:
   ```markdown
   ## Round {N} — {TIMESTAMP}
   **Questions asked:**
   1. {q1}
   2. {q2}

   **Answers:**
   {ANSWERS_ROUND_N}

   **Key decisions extracted:**
   - {decision_1}
   - {decision_2}
   ```
   (Key decisions: orchestrator extracts 1-3 concrete decisions from answers inline — no agent spawn needed)

5. Increment ROUND.
   Update .mgw/vision-draft.md frontmatter: rounds_completed={ROUND}

6. **Soft cap check** (after round {SOFT_CAP}):
   If ROUND >= SOFT_CAP and !SOFT_CAP_REACHED:
     Set SOFT_CAP_REACHED=true
     Update vision-draft.md frontmatter: soft_cap_reached=true
     Display:
     ```
     ─────────────────────────────────────
     We've covered {ROUND} rounds of questions.

     Options:
       D) Dig deeper — continue questioning (up to {HARD_CAP} rounds total)
       S) Synthesize — proceed to Vision Brief generation
     ─────────────────────────────────────
     ```
     If user chooses S: exit loop and proceed to vision_synthesis
     If user chooses D: continue loop

7. **Hard cap** (ROUND >= HARD_CAP): automatically exit loop with notice:
   ```
   Reached {HARD_CAP}-round limit. Proceeding to synthesis.
   ```

8. **User 'done'**: if user types 'done' as answer: exit loop immediately.

After loop exits:
- Update vision-draft.md frontmatter: current_stage: synthesizing
- Display: "Questioning complete ({ROUND} rounds). Generating Vision Brief..."
- Proceed to vision_synthesis step.
</step>

<step name="vision_synthesis">
**Vision Synthesis: spawn vision-synthesizer agent and review loop (Fresh path only)**

If STATE_CLASS != Fresh: skip this step.

Display: "Generating Vision Brief from {rounds_completed} rounds of input..."

**Synthesizer spawn:**

Task(
  description="Synthesize Vision Brief from research and questioning",
  subagent_type="general-purpose",
  prompt="
You are the vision-synthesizer agent for a software project planning cycle.

Read these files:
- .mgw/vision-draft.md — all rounds of user questions and answers, raw idea
- .mgw/vision-research.json — domain research, platform requirements, risks

Synthesize a comprehensive Vision Brief. Write it to .mgw/vision-brief.json using this schema (templates/vision-brief-schema.json):

{
  \"project_identity\": { \"name\": \"...\", \"tagline\": \"...\", \"domain\": \"...\" },
  \"target_users\": [{ \"persona\": \"...\", \"needs\": [...], \"pain_points\": [...] }],
  \"core_value_proposition\": \"1-2 sentences: who, what, why different\",
  \"feature_categories\": {
    \"must_have\": [{ \"name\": \"...\", \"description\": \"...\", \"rationale\": \"why non-negotiable\" }],
    \"should_have\": [{ \"name\": \"...\", \"description\": \"...\" }],
    \"could_have\": [{ \"name\": \"...\", \"description\": \"...\" }],
    \"wont_have\": [{ \"name\": \"...\", \"reason\": \"explicit out-of-scope reasoning\" }]
  },
  \"technical_constraints\": [...],
  \"success_metrics\": [...],
  \"estimated_scope\": { \"milestones\": N, \"phases\": N, \"complexity\": \"small|medium|large|enterprise\" },
  \"recommended_milestone_structure\": [{ \"name\": \"...\", \"focus\": \"...\", \"deliverables\": [...] }]
}

Be specific and concrete. Use the user's actual answers from vision-draft.md. Do NOT pad with generic content.
"
)

After synthesizer completes:
1. Read .mgw/vision-brief.json
2. Display the Vision Brief to user in structured format:
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Vision Brief: {project_identity.name}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Tagline: {tagline}
   Domain: {domain}

   Target Users:
     • {persona_1}: {needs summary}
     • {persona_2}: ...

   Core Value: {core_value_proposition}

   Must-Have Features ({count}):
     • {feature_1}: {rationale}
     • ...

   Won't Have ({count}): {list}

   Estimated Scope: {complexity} — {milestones} milestones, ~{phases} phases

   Recommended Milestones:
     1. {name}: {focus}
     2. ...
   ```

3. Present review options:
   ```
   ─────────────────────────────────────────
   Review Options:
     A) Accept — proceed to condensing and project creation
     R) Revise — tell me what to change, regenerate
     D) Dig deeper on: [specify area]
   ─────────────────────────────────────────
   ```

4. If Accept: proceed to vision_condense step
5. If Revise: capture correction, spawn vision-synthesizer again with correction appended to vision-draft.md, loop back to step 2
6. If Dig deeper: append "Deeper exploration of {area}" to vision-draft.md, spawn vision-synthesizer again
</step>

<step name="vision_condense">
**Vision Condense: produce gsd:new-project handoff document (Fresh path only)**

If STATE_CLASS != Fresh: skip this step.

Display: "Condensing Vision Brief into project handoff..."

Task(
  description="Condense Vision Brief into gsd:new-project handoff",
  subagent_type="general-purpose",
  prompt="
You are the vision-condenser agent. Your job is to produce a handoff document
that will be passed as context to a gsd:new-project spawn.

Read .mgw/vision-brief.json.

Produce a structured handoff document at .mgw/vision-handoff.md that:

1. Opens with a context block that gsd:new-project can use directly to produce PROJECT.md:
   - Project name, tagline, domain
   - Target users and their core needs
   - Core value proposition
   - Must-have feature list with rationale
   - Won't-have list (explicit out-of-scope)
   - Technical constraints
   - Success metrics

2. Includes recommended milestone structure as a numbered list:
   - Each milestone: name, focus area, key deliverables

3. Closes with an instruction for gsd:new-project:
   'Use the above as the full project context when creating PROJECT.md.
   The project name, scope, users, and milestones above reflect decisions
   made through {rounds_completed} rounds of collaborative planning.
   Do not hallucinate scope beyond what is specified.'

Format as clean markdown. This document becomes the prompt prefix for gsd:new-project.
"
)

After condenser completes:
1. Verify .mgw/vision-handoff.md exists and has content
2. Display: "Vision Brief condensed. Ready to initialize project structure."
3. Update .mgw/vision-draft.md frontmatter: current_stage: spawning
4. Proceed to spawn_gsd_new_project step.
</step>

<step name="spawn_gsd_new_project">
**Spawn gsd:new-project with Vision Brief context (Fresh path only)**

If STATE_CLASS != Fresh: skip this step.

Read .mgw/vision-handoff.md:
```bash
HANDOFF_CONTENT=$(cat .mgw/vision-handoff.md)
```

Display: "Spawning gsd:new-project with full vision context..."

Spawn gsd:new-project as a Task agent, passing the handoff document as context prefix:

Task(
  description="Initialize GSD project from Vision Brief",
  subagent_type="general-purpose",
  prompt="
${HANDOFF_CONTENT}

---

You are now running gsd:new-project. Using the Vision Brief above as your full project context, create:

1. .planning/PROJECT.md — Complete project definition following GSD format:
   - Project name and one-line description from vision brief
   - Vision and goals aligned with the value proposition
   - Target users from the personas
   - Core requirements mapping to the must-have features
   - Non-goals matching the wont-have list
   - Success criteria from success_metrics
   - Technical constraints listed explicitly

2. .planning/ROADMAP.md — First milestone plan following GSD format:
   - Use the first milestone from recommended_milestone_structure
   - Break it into 3-8 phases
   - Each phase has: number, name, goal, requirements, success criteria
   - Phase numbering starts at 1
   - Include a progress table at the top

Write both files. Do not create additional files. Do not deviate from the Vision Brief scope.
"
)

After agent completes:
1. Verify .planning/PROJECT.md exists:
   ```bash
   if [ ! -f .planning/PROJECT.md ]; then
     echo "ERROR: gsd:new-project did not create .planning/PROJECT.md"
     echo "Check the agent output and retry, or create PROJECT.md manually."
     exit 1
   fi
   ```

2. Verify .planning/ROADMAP.md exists:
   ```bash
   if [ ! -f .planning/ROADMAP.md ]; then
     echo "ERROR: gsd:new-project did not create .planning/ROADMAP.md"
     echo "Check the agent output and retry, or create ROADMAP.md manually."
     exit 1
   fi
   ```

3. Display success:
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    GSD Project Initialized
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   .planning/PROJECT.md  created
   .planning/ROADMAP.md  created (first milestone phases ready)

   Vision cycle: {rounds_completed} rounds -> Vision Brief -> PROJECT.md
   ```

4. Update .mgw/vision-draft.md frontmatter: current_stage: complete

5. Proceed to milestone_mapper step:
   The ROADMAP.md now exists, so PATH A (HAS_ROADMAP=true) logic applies.
   Call the milestone_mapper step to read ROADMAP.md and create GitHub milestones/issues.
   (Note: at this point STATE_CLASS was Fresh but now GSD files exist — the milestone_mapper
   step was designed for the GSD-Only path but works identically here. Proceed to it directly.)
</step>

<step name="gather_inputs">
**Gather project inputs conversationally:**

If STATE_CLASS = Fresh: skip this step (handled by vision_intake through spawn_gsd_new_project above — proceed directly to milestone_mapper).

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

<step name="sync_milestone_to_board">
**Sync newly created issues onto the board as items with field values (non-blocking):**

This step runs after `create_project_board` (both init and extend modes). It adds each
newly created issue as a board item and sets Milestone, Phase, and GSD Route field values.
Board item IDs are collected here and stored in project.json (as `board_item_id` per issue).

If no board is configured (PROJECT_NUMBER is empty) or the board has no custom fields
configured (node_id or fields missing from project.json), skip silently.

Non-blocking: any GraphQL error is logged as a WARNING and does not halt the pipeline.

```bash
# Load board field metadata from project.json
BOARD_NODE_ID=$(python3 -c "
import json
try:
  p = json.load(open('${MGW_DIR}/project.json'))
  print(p.get('project', {}).get('project_board', {}).get('node_id', ''))
except:
  print('')
" 2>/dev/null || echo "")

BOARD_FIELDS_JSON=$(python3 -c "
import json
try:
  p = json.load(open('${MGW_DIR}/project.json'))
  fields = p.get('project', {}).get('project_board', {}).get('fields', {})
  print(json.dumps(fields))
except:
  print('{}')
" 2>/dev/null || echo "{}")

# Resolve field IDs from stored metadata
MILESTONE_FIELD_ID=$(echo "$BOARD_FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
print(fields.get('milestone', {}).get('field_id', ''))
" 2>/dev/null || echo "")

PHASE_FIELD_ID=$(echo "$BOARD_FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
print(fields.get('phase', {}).get('field_id', ''))
" 2>/dev/null || echo "")

GSD_ROUTE_FIELD_ID=$(echo "$BOARD_FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
print(fields.get('gsd_route', {}).get('field_id', ''))
" 2>/dev/null || echo "")

GSD_ROUTE_OPTIONS=$(echo "$BOARD_FIELDS_JSON" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
print(json.dumps(fields.get('gsd_route', {}).get('options', {})))
" 2>/dev/null || echo "{}")

# Determine if sync is possible
BOARD_SYNC_ENABLED=false
if [ -n "$PROJECT_NUMBER" ] && [ -n "$BOARD_NODE_ID" ]; then
  BOARD_SYNC_ENABLED=true
  echo ""
  echo "Syncing ${TOTAL_ISSUES_CREATED} issues onto board #${PROJECT_NUMBER}..."
elif [ -n "$PROJECT_NUMBER" ] && [ -z "$BOARD_NODE_ID" ]; then
  echo ""
  echo "NOTE: Board #${PROJECT_NUMBER} exists but custom fields not configured."
  echo "      Run /mgw:board create to set up fields, then board sync will be available."
fi

# ISSUE_RECORD format: "milestone_index:issue_number:title:phase_num:phase_name:gsd_route:depends_on"
# ITEM_ID_MAP accumulates: "issue_number:item_id" for project.json storage
ITEM_ID_MAP=()
BOARD_SYNC_WARNINGS=()

if [ "$BOARD_SYNC_ENABLED" = "true" ]; then
  for RECORD in "${ISSUE_RECORDS[@]}"; do
    ISSUE_NUM=$(echo "$RECORD" | cut -d':' -f2)
    ISSUE_PHASE_NUM=$(echo "$RECORD" | cut -d':' -f4)
    ISSUE_PHASE_NAME=$(echo "$RECORD" | cut -d':' -f5)
    ISSUE_GSD_ROUTE=$(echo "$RECORD" | cut -d':' -f6)
    ISSUE_MILESTONE_IDX=$(echo "$RECORD" | cut -d':' -f1)

    # Get milestone name for this issue
    ISSUE_MILESTONE_NAME=$(python3 -c "
import json
try:
  d = json.load(open('/tmp/mgw-template.json'))
  print(d['milestones'][${ISSUE_MILESTONE_IDX}]['name'])
except:
  print('')
" 2>/dev/null || echo "")

    # Resolve GitHub issue node ID (needed for addProjectV2ItemById)
    ISSUE_NODE_ID=$(gh api graphql -f query='
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) { id }
        }
      }
    ' -f owner="$OWNER" -f repo="$REPO_NAME" -F number="${ISSUE_NUM}" \
      --jq '.data.repository.issue.id' 2>/dev/null || echo "")

    if [ -z "$ISSUE_NODE_ID" ]; then
      BOARD_SYNC_WARNINGS+=("WARNING: Could not resolve node ID for issue #${ISSUE_NUM} — skipping board sync for this issue")
      continue
    fi

    # Add issue to board
    ADD_RESULT=$(gh api graphql -f query='
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {
          projectId: $projectId
          contentId: $contentId
        }) {
          item { id }
        }
      }
    ' -f projectId="$BOARD_NODE_ID" -f contentId="$ISSUE_NODE_ID" 2>/dev/null)

    ITEM_ID=$(echo "$ADD_RESULT" | python3 -c "
import json,sys
try:
  d = json.load(sys.stdin)
  print(d['data']['addProjectV2ItemById']['item']['id'])
except:
  print('')
" 2>/dev/null || echo "")

    if [ -z "$ITEM_ID" ]; then
      BOARD_SYNC_WARNINGS+=("WARNING: Failed to add issue #${ISSUE_NUM} to board")
      continue
    fi

    echo "  Added #${ISSUE_NUM} to board (item: ${ITEM_ID})"
    ITEM_ID_MAP+=("${ISSUE_NUM}:${ITEM_ID}")

    # Set Milestone field (TEXT)
    if [ -n "$MILESTONE_FIELD_ID" ] && [ -n "$ISSUE_MILESTONE_NAME" ]; then
      gh api graphql -f query='
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { text: $value }
          }) { projectV2Item { id } }
        }
      ' -f projectId="$BOARD_NODE_ID" -f itemId="$ITEM_ID" \
        -f fieldId="$MILESTONE_FIELD_ID" -f value="$ISSUE_MILESTONE_NAME" \
        2>/dev/null || BOARD_SYNC_WARNINGS+=("WARNING: Failed to set Milestone field on board item for #${ISSUE_NUM}")
    fi

    # Set Phase field (TEXT) — "Phase N: Phase Name"
    if [ -n "$PHASE_FIELD_ID" ]; then
      PHASE_DISPLAY="Phase ${ISSUE_PHASE_NUM}: ${ISSUE_PHASE_NAME}"
      gh api graphql -f query='
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { text: $value }
          }) { projectV2Item { id } }
        }
      ' -f projectId="$BOARD_NODE_ID" -f itemId="$ITEM_ID" \
        -f fieldId="$PHASE_FIELD_ID" -f value="$PHASE_DISPLAY" \
        2>/dev/null || BOARD_SYNC_WARNINGS+=("WARNING: Failed to set Phase field on board item for #${ISSUE_NUM}")
    fi

    # Set GSD Route field (SINGLE_SELECT) — look up option ID from stored map
    if [ -n "$GSD_ROUTE_FIELD_ID" ]; then
      # Map template gsd_route to board option key (e.g. "plan-phase" → "gsd:plan-phase")
      # GSD_ROUTE_OPTIONS stores keys like "gsd:quick", "gsd:plan-phase", etc.
      ROUTE_OPTION_ID=$(echo "$GSD_ROUTE_OPTIONS" | python3 -c "
import json,sys
opts = json.load(sys.stdin)
# Try exact match on gsd: prefix first, then plain match
route = '${ISSUE_GSD_ROUTE}'
for key, val in opts.items():
    if key == 'gsd:' + route or key == route:
        print(val)
        sys.exit(0)
# Fallback: plain match on the route name without prefix
for key, val in opts.items():
    if key.endswith(':' + route) or key == route:
        print(val)
        sys.exit(0)
print('')
" 2>/dev/null || echo "")

      if [ -n "$ROUTE_OPTION_ID" ]; then
        gh api graphql -f query='
          mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
            updateProjectV2ItemFieldValue(input: {
              projectId: $projectId
              itemId: $itemId
              fieldId: $fieldId
              value: { singleSelectOptionId: $optionId }
            }) { projectV2Item { id } }
          }
        ' -f projectId="$BOARD_NODE_ID" -f itemId="$ITEM_ID" \
          -f fieldId="$GSD_ROUTE_FIELD_ID" -f optionId="$ROUTE_OPTION_ID" \
          2>/dev/null || BOARD_SYNC_WARNINGS+=("WARNING: Failed to set GSD Route field on board item for #${ISSUE_NUM}")
      fi
    fi
  done

  if [ ${#BOARD_SYNC_WARNINGS[@]} -gt 0 ]; then
    echo ""
    echo "Board sync warnings:"
    for W in "${BOARD_SYNC_WARNINGS[@]}"; do
      echo "  $W"
    done
  fi

  BOARD_SYNC_COUNT=$((${#ITEM_ID_MAP[@]}))
  echo "  Board sync complete: ${BOARD_SYNC_COUNT}/${TOTAL_ISSUES_CREATED} issues synced"
fi
```
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
            # Look up board_item_id from ITEM_ID_MAP if available
            item_id = ITEM_ID_MAP_DICT.get(gh_num, None)
            issues_out.append({
                "github_number": gh_num,
                "title": issue['title'],
                "phase_number": global_phase_num,
                "phase_name": phase['name'],
                "gsd_route": phase.get('gsd_route', 'plan-phase'),
                "labels": issue.get('labels', []),
                "depends_on_slugs": issue.get('depends_on', []),
                "pipeline_stage": "new",
                "board_item_id": item_id
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

# Build ITEM_ID_MAP_DICT from bash ITEM_ID_MAP array ("issue_num:item_id" entries)
# This dict maps github_number (int) -> board_item_id (str)
ITEM_ID_MAP_DICT = {}
for entry in [x for x in '''${ITEM_ID_MAP[*]}'''.split() if ':' in x]:
    parts = entry.split(':', 1)
    try:
        ITEM_ID_MAP_DICT[int(parts[0])] = parts[1]
    except (ValueError, IndexError):
        pass

# ... (construct from available bash variables — see pseudocode above)
PYEOF
```

The simplest implementation: build the JSON structure incrementally during the
issue/milestone creation steps (maintaining bash arrays), then assemble them into
a python3 dictionary and write with `json.dumps(indent=2)` at this step.

The `ITEM_ID_MAP` bash array (populated in `sync_milestone_to_board`) contains entries
in `"issue_number:board_item_id"` format. Decode it into `ITEM_ID_MAP_DICT` (as shown
above) and use it when building each issue record so `board_item_id` is stored.
If board sync was skipped (ITEM_ID_MAP is empty), `board_item_id` is null for all issues.

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

**Extend mode: verify new milestone GSD linkage**

After writing the updated project.json in extend mode, report the GSD linkage status for each newly added milestone:

```bash
if [ "$EXTEND_MODE" = true ]; then
  echo ""
  echo "New milestone linkage status:"
  for MILESTONE in "${NEW_MILESTONES[@]}"; do
    MILE_NAME=$(echo "$MILESTONE" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])" 2>/dev/null || echo "unknown")
    echo "  o '${MILE_NAME}' — no GSD milestone linked yet"
    echo "    -> Run /gsd:new-milestone after completing the previous milestone to link"
  done
  echo ""
fi
```
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
