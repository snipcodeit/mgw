# Align From GSD

## Precondition

`STATE_CLASS = GSD-Only` or `STATE_CLASS = GSD-Mid-Exec` — set by `workflows/detect-state.md`.
GSD artifacts exist (`.planning/PROJECT.md` and optionally `.planning/ROADMAP.md`) but MGW
has not been initialized (no `.mgw/project.json`, no GitHub milestones).

## Postcondition

After this workflow completes:
- `.mgw/alignment-report.json` exists with extracted GSD milestone and phase data
- User has confirmed import (Y/N prompt)
- If confirmed: ready to proceed to `milestone_mapper` step in project.md
- If declined: command exits cleanly

---

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
