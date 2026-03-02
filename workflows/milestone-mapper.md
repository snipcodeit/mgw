# Milestone Mapper

## Precondition

`.mgw/alignment-report.json` must exist — produced either by `workflows/align-from-gsd.md`
(GSD-Only / GSD-Mid-Exec path) or synthesized inline during the Fresh path after
`spawn_gsd_new_project` completes. The alignment report contains the list of milestones and
phases to map to GitHub structure.

Required variables:
- `REPO` — GitHub owner/repo slug (e.g. `owner/repo`)
- `MGW_DIR` — path to `.mgw/` directory

## Postcondition

After this workflow completes:
- All milestones from the alignment report exist on GitHub (created or matched)
- GitHub issues created for each phase (one issue per phase)
- `.mgw/project.json` updated with new milestone entries including `github_number`, `gsd_milestone_id`, `gsd_state`
- `.mgw/cross-refs.json` updated with `maps-to` entries linking GitHub milestones to GSD milestones
- Ready to proceed to `create_project_board` step in project.md

---

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
