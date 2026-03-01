# MGW Board Schema

This document describes the GitHub Projects v2 board structure used by MGW, including
custom fields, option values, and layout views.

---

## Overview

The MGW pipeline board is a GitHub Projects v2 project created by `/mgw:board create`.
It tracks all issues managed by the MGW pipeline, with custom fields reflecting the
pipeline state stored in `.mgw/active/` and `.mgw/project.json`.

---

## Custom Fields

| Field Name | Type | Description |
|------------|------|-------------|
| Status | SINGLE_SELECT | Maps to `pipeline_stage` in issue state |
| AI Agent State | TEXT | Current GSD agent activity or last action |
| Milestone | TEXT | Milestone title (e.g. "v2 — GitHub Projects Board Management") |
| Phase | TEXT | Phase number and name (e.g. "15 — Multi-Layout Views") |
| GSD Route | SINGLE_SELECT | GSD execution route for the issue |

---

## Status Field Options

The Status field maps directly to MGW `pipeline_stage` values. The 13 options are:

| Option Name | Color | pipeline_stage | Description |
|-------------|-------|---------------|-------------|
| New | GRAY | `new` | Issue created, not yet triaged |
| Triaged | BLUE | `triaged` | Triage complete, ready for execution |
| Needs Info | YELLOW | `needs-info` | Blocked at triage gate — needs more detail |
| Needs Security Review | RED | `needs-security-review` | High security risk flagged |
| Discussing | PURPLE | `discussing` | Awaiting stakeholder scope approval |
| Approved | GREEN | `approved` | Discussion complete, cleared for execution |
| Planning | BLUE | `planning` | GSD planner agent active |
| Executing | ORANGE | `executing` | GSD executor agent active |
| Verifying | BLUE | `verifying` | GSD verifier agent active |
| PR Created | GREEN | `pr-created` | PR open, awaiting review |
| Done | GREEN | `done` | PR merged, issue closed |
| Failed | RED | `failed` | Unrecoverable pipeline error |
| Blocked | RED | `blocked` | Blocking comment detected |

---

## GSD Route Field Options

| Option Name | Route | Description |
|-------------|-------|-------------|
| quick | `gsd:quick` | Small/atomic task, direct execution |
| quick --full | `gsd:quick --full` | Small task with plan-checker and verifier |
| plan-phase | `gsd:plan-phase` | Medium task with phase planning |
| new-milestone | `gsd:new-milestone` | Large task with full milestone lifecycle |

---

## Views

GitHub Projects v2 supports multiple layout views: Board (kanban), Table, and Roadmap.
MGW creates and configures these views using `/mgw:board views`.

### Intended Views

| View Name | Layout | Group By | Sort By | Purpose |
|-----------|--------|----------|---------|---------|
| Kanban — Pipeline Stages | BOARD_LAYOUT | Status | — | Swimlane view per pipeline stage |
| Triage Table — Team Planning | TABLE_LAYOUT | — | Status (asc) | Triage planning surface sorted by pipeline status |
| Roadmap | ROADMAP_LAYOUT | — | Milestone | Timeline view for milestone planning |

### View Configuration Notes

**Kanban — Pipeline Stages (Board Layout)**

- Created by `/mgw:board views kanban`
- Group By must be set to "Status" in the GitHub Projects UI after creation
- Each pipeline stage becomes a swimlane column
- GitHub's API does not support programmatic configuration of board grouping —
  use the view's settings menu in the GitHub UI after the view is created

**Triage Table — Team Planning (Table Layout)**

- Created by `/mgw:board views table`
- Primary planning surface for team triage and routing visibility
- Column order for triage planning (configure in GitHub Projects UI):

  | Order | Column | Purpose |
  |-------|--------|---------|
  | 1 | Status | Pipeline position — sort ascending for pipeline order |
  | 2 | Milestone | Which milestone the issue belongs to |
  | 3 | Phase | Phase number and name within the milestone |
  | 4 | GSD Route | Execution route (quick, plan-phase, new-milestone) |
  | 5 | AI Agent State | Live agent activity or last action |

- Sort By: **Status ascending** — surfaces active work (Executing, Planning, Verifying)
  at top, done work (Done, PR Created) at bottom
- GitHub's API does not support setting column order or sort programmatically —
  configure via the view settings menu in the GitHub UI after creation

**Roadmap**

- Created by `/mgw:board views roadmap`
- Requires start date and target date fields on items for full timeline view
- Group by Milestone to see milestone-level progress

---

## API Reference

### Creating Views

```graphql
mutation {
  createProjectV2View(input: {
    projectId: $projectId
    name: "Kanban — Pipeline Stages"
    layout: BOARD_LAYOUT
  }) {
    projectV2View { id name layout }
  }
}
```

Valid layout values: `BOARD_LAYOUT`, `TABLE_LAYOUT`, `ROADMAP_LAYOUT`

### Limitation: Board Grouping

GitHub's Projects v2 GraphQL API does not expose a mutation for setting the
"Group by" field on a board view. The grouping (which field creates swimlanes)
must be configured manually in the GitHub UI:

1. Open the board at the project URL
2. Click the view name to open view settings
3. Set "Group by: Status"

This limitation is documented in the GitHub Projects v2 API changelog.
The `/mgw:board views` command creates the view and outputs these instructions.

---

## Storage

Board metadata is stored in `.mgw/project.json` under `project.project_board`:

```json
{
  "project": {
    "project_board": {
      "number": 1,
      "url": "https://github.com/orgs/owner/projects/1",
      "node_id": "PVT_...",
      "fields": {
        "status": {
          "field_id": "PVTSSF_...",
          "field_name": "Status",
          "type": "SINGLE_SELECT",
          "options": {
            "new": "option-id-1",
            "triaged": "option-id-2"
          }
        }
      },
      "views": {
        "kanban": {
          "view_id": "PVTV_...",
          "name": "Kanban — Pipeline Stages",
          "layout": "BOARD_LAYOUT"
        },
        "table": {
          "view_id": "PVTV_...",
          "name": "Triage Table — Team Planning",
          "layout": "TABLE_LAYOUT"
        }
      }
    }
  }
}
```
