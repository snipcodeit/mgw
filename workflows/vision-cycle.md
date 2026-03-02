# Vision Collaboration Cycle

## Precondition

`STATE_CLASS = Fresh` — set by `workflows/detect-state.md`. This workflow is entered only when
no existing GSD or GitHub project state is detected (no `.mgw/project.json`, no `.planning/ROADMAP.md`,
no GitHub milestones).

## Context Strategy

Rolling summary only. Agents receive Vision Brief + latest delta, never the full transcript.
Agents spawned: `vision-researcher` (produces `.mgw/vision-research.json`),
`vision-synthesizer` (produces `.mgw/vision-brief.json`),
`vision-condenser` (produces `.mgw/vision-handoff.md`).

## Postcondition

After this workflow completes:
- `.mgw/vision-handoff.md` exists with the condensed Vision Brief
- `.mgw/vision-draft.md` frontmatter shows `current_stage: complete`
- `gsd:new-project` has been spawned and has created `.planning/PROJECT.md` and `.planning/ROADMAP.md`
- `.mgw/alignment-report.json` has been synthesized from the fresh ROADMAP.md
- Ready to proceed to `milestone_mapper` step in project.md

---

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

4b. Synthesize alignment-report.json for milestone_mapper:

The Fresh path skips `align_from_gsd`, so `.mgw/alignment-report.json` does not exist yet.
Synthesize it from the freshly created ROADMAP.md and PROJECT.md so `milestone_mapper` has
consistent input regardless of which path was taken.

```bash
python3 << 'PYEOF'
import json, re, os

repo_root = os.environ.get("REPO_ROOT", ".")

# --- Parse PROJECT.md for name and description ---
project_path = os.path.join(repo_root, ".planning", "PROJECT.md")
with open(project_path, "r") as f:
    project_text = f.read()

# Extract H1 heading as project name
name_match = re.search(r"^#\s+(.+)$", project_text, re.MULTILINE)
project_name = name_match.group(1).strip() if name_match else "Untitled Project"

# Extract first paragraph after H1 as description
desc_match = re.search(r"^#\s+.+\n+(.+?)(?:\n\n|\n#)", project_text, re.MULTILINE | re.DOTALL)
project_description = desc_match.group(1).strip() if desc_match else ""

# --- Parse ROADMAP.md for phases ---
roadmap_path = os.path.join(repo_root, ".planning", "ROADMAP.md")
with open(roadmap_path, "r") as f:
    roadmap_text = f.read()

# Extract milestone name from first heading after any frontmatter
roadmap_body = re.sub(r"^---\n.*?\n---\n?", "", roadmap_text, flags=re.DOTALL)
milestone_heading = re.search(r"^#{1,2}\s+(.+)$", roadmap_body, re.MULTILINE)
milestone_name = milestone_heading.group(1).strip() if milestone_heading else "Milestone 1"

# Extract phases (### Phase N: Name or ## Phase N: Name)
phase_pattern = re.compile(r"^#{2,3}\s+Phase\s+(\d+)[:\s]+(.+)$", re.MULTILINE)
phases = []
for m in phase_pattern.finditer(roadmap_text):
    phases.append({
        "number": int(m.group(1)),
        "name": m.group(2).strip(),
        "status": "pending"
    })

if not phases:
    phases = [{"number": 1, "name": milestone_name, "status": "pending"}]

# Estimate ~2 issues per phase as a rough default
total_issues_estimated = len(phases) * 2

report = {
    "project_name": project_name,
    "project_description": project_description,
    "milestones": [
        {
            "name": milestone_name,
            "source": "ROADMAP",
            "state": "active",
            "phases": phases
        }
    ],
    "active_milestone": milestone_name,
    "total_phases": len(phases),
    "total_issues_estimated": total_issues_estimated
}

output_path = os.path.join(repo_root, ".mgw", "alignment-report.json")
os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, "w") as f:
    json.dump(report, f, indent=2)

print(f"Synthesized alignment-report.json: {len(phases)} phases, milestone='{milestone_name}'")
PYEOF
```

5. Proceed to milestone_mapper step:
   The ROADMAP.md now exists, so PATH A (HAS_ROADMAP=true) logic applies.
   Call the milestone_mapper step to read ROADMAP.md and create GitHub milestones/issues.
   (Note: at this point STATE_CLASS was Fresh but now GSD files exist — the milestone_mapper
   step was designed for the GSD-Only path but works identically here. Proceed to it directly.)
</step>
