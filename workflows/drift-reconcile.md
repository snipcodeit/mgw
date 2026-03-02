# Drift Reconcile

## Precondition

`STATE_CLASS = Diverged` — set by `workflows/detect-state.md`. Both `.mgw/project.json` and
GitHub milestones exist, but they are inconsistent (milestone count mismatch > 1, or less than
50% name overlap between local and GitHub milestones).

Required variables:
- `REPO` — GitHub owner/repo slug (e.g. `owner/repo`)
- `MGW_DIR` — path to `.mgw/` directory

## Postcondition

After this workflow completes, one of:
- Drift resolved: `.mgw/project.json` updated, mismatches corrected, state reclassified as Aligned
- No drift found: state reclassified as Aligned (no action needed)
- Drift deferred: user chose "None" — command exits, user runs `/mgw:sync` later

---

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
