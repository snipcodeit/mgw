# MGW GitHub Projects v2 Board Schema

This document defines the GitHub Projects v2 board schema used by MGW to surface pipeline
state, AI agent activity, and milestone context to teams.

## Board Overview

MGW manages a GitHub Projects v2 board for each project. The board is created and
configured by the `mgw:board` command and stored in `.mgw/project.json` under the `board`
key. Board items are synced from project.json milestones and issues.

**Purpose:** Give teams real-time visibility into the AI-driven pipeline — which issues
are being worked on, what GSD route is executing, which milestone phase is active, and
whether the pipeline is healthy.

**Board URL format:** `https://github.com/users/<owner>/projects/<number>`

## Custom Field Schema

### 1. Status (Single Select)

**Type:** `SINGLE_SELECT`
**Description:** Mirrors the `pipeline_stage` value in `.mgw/active/<n>-<slug>.json`. Updated automatically by `mgw:run` on each stage transition.

**Options (maps 1:1 to pipeline_stage values):**

| Option | Color | Description |
|--------|-------|-------------|
| `New` | `GRAY` | Issue created, not yet triaged |
| `Triaged` | `BLUE` | Triage complete, ready for execution |
| `Needs Info` | `YELLOW` | Blocked at triage gate — insufficient detail |
| `Needs Security Review` | `RED` | Blocked — high security risk flagged |
| `Discussing` | `PURPLE` | Scope proposal posted, awaiting stakeholder input |
| `Approved` | `GREEN` | Discussion complete, cleared for execution |
| `Planning` | `BLUE` | GSD planner agent active |
| `Executing` | `ORANGE` | GSD executor agent active |
| `Verifying` | `BLUE` | GSD verifier agent active |
| `PR Created` | `GREEN` | Pull request open and ready for review |
| `Done` | `GREEN` | PR merged, issue closed |
| `Failed` | `RED` | Unrecoverable pipeline error |
| `Blocked` | `RED` | Blocking comment detected — pipeline paused |

**pipeline_stage → Status mapping:**
```
new                   → New
triaged               → Triaged
needs-info            → Needs Info
needs-security-review → Needs Security Review
discussing            → Discussing
approved              → Approved
planning              → Planning
executing             → Executing
verifying             → Verifying
pr-created            → PR Created
done                  → Done
failed                → Failed
blocked               → Blocked
```

**GraphQL mutation to create:**
```graphql
mutation {
  createProjectV2Field(input: {
    projectId: "<PROJECT_ID>"
    dataType: SINGLE_SELECT
    name: "Status"
    singleSelectOptions: [
      { name: "New", color: GRAY, description: "Issue created, not yet triaged" }
      { name: "Triaged", color: BLUE, description: "Triage complete, ready for execution" }
      { name: "Needs Info", color: YELLOW, description: "Blocked at triage gate" }
      { name: "Needs Security Review", color: RED, description: "High security risk flagged" }
      { name: "Discussing", color: PURPLE, description: "Awaiting stakeholder scope approval" }
      { name: "Approved", color: GREEN, description: "Cleared for execution" }
      { name: "Planning", color: BLUE, description: "GSD planner agent active" }
      { name: "Executing", color: ORANGE, description: "GSD executor agent active" }
      { name: "Verifying", color: BLUE, description: "GSD verifier agent active" }
      { name: "PR Created", color: GREEN, description: "PR open, awaiting review" }
      { name: "Done", color: GREEN, description: "PR merged, issue closed" }
      { name: "Failed", color: RED, description: "Unrecoverable pipeline error" }
      { name: "Blocked", color: RED, description: "Blocking comment detected" }
    ]
  }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        id
        name
        options { id name }
      }
    }
  }
}
```

---

### 2. AI Agent State (Text)

**Type:** `TEXT`
**Description:** Shows the current GSD agent activity during pipeline execution. Updated at each agent spawn. Cleared when pipeline reaches `pr-created`.

**Values (written programmatically):**
- `planner:running` — GSD planner agent spawned
- `executor:running` — GSD executor agent spawned
- `verifier:running` — GSD verifier agent active
- `plan-checker:running` — GSD plan-checker agent active
- `idle` — No agent active (between stages)
- `blocked` — Pipeline blocked (see Status field)

**GraphQL mutation to create:**
```graphql
mutation {
  createProjectV2Field(input: {
    projectId: "<PROJECT_ID>"
    dataType: TEXT
    name: "AI Agent State"
  }) {
    projectV2Field {
      ... on ProjectV2Field {
        id
        name
      }
    }
  }
}
```

---

### 3. Milestone (Text)

**Type:** `TEXT`
**Description:** The milestone name from `project.json`. Set when an issue is added to a milestone via `mgw:project` or `mgw:milestone`. Not auto-updated — reflects the milestone at issue creation time.

**Value format:** Milestone title string (e.g., `v2 — GitHub Projects Board Management`)

**GraphQL mutation to create:**
```graphql
mutation {
  createProjectV2Field(input: {
    projectId: "<PROJECT_ID>"
    dataType: TEXT
    name: "Milestone"
  }) {
    projectV2Field {
      ... on ProjectV2Field {
        id
        name
      }
    }
  }
}
```

---

### 4. Phase (Text)

**Type:** `TEXT`
**Description:** The phase name and number from `project.json`. Format: `<number> — <name>`. Set when the issue enters the pipeline. Not auto-updated.

**Value format:** `13 — Board Foundation & Field Schema`

**GraphQL mutation to create:**
```graphql
mutation {
  createProjectV2Field(input: {
    projectId: "<PROJECT_ID>"
    dataType: TEXT
    name: "Phase"
  }) {
    projectV2Field {
      ... on ProjectV2Field {
        id
        name
      }
    }
  }
}
```

---

### 5. GSD Route (Single Select)

**Type:** `SINGLE_SELECT`
**Description:** The GSD execution route assigned during triage. Determines how the pipeline executes the issue. Set during triage, does not change.

**Options:**

| Option | Color | Description |
|--------|-------|-------------|
| `quick` | `BLUE` | Small/atomic tasks — no plan file, direct execution |
| `quick --full` | `BLUE` | Small tasks with plan-checker and verifier |
| `plan-phase` | `PURPLE` | Medium tasks — structured phase planning |
| `new-milestone` | `ORANGE` | Large tasks — full milestone lifecycle |

**GSD route name → option mapping:**
```
gsd:quick           → quick
gsd:quick --full    → quick --full
gsd:plan-phase      → plan-phase
gsd:new-milestone   → new-milestone
```

**GraphQL mutation to create:**
```graphql
mutation {
  createProjectV2Field(input: {
    projectId: "<PROJECT_ID>"
    dataType: SINGLE_SELECT
    name: "GSD Route"
    singleSelectOptions: [
      { name: "quick", color: BLUE, description: "Small/atomic task, direct execution" }
      { name: "quick --full", color: BLUE, description: "Small task with plan-checker and verifier" }
      { name: "plan-phase", color: PURPLE, description: "Medium task with phase planning" }
      { name: "new-milestone", color: ORANGE, description: "Large task with full milestone lifecycle" }
    ]
  }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        id
        name
        options { id name }
      }
    }
  }
}
```

---

## project.json Board Key Schema

The `mgw:board` command (#72) writes board metadata to `.mgw/project.json` under the `project.board` key. This schema defines what that key should contain:

```json
{
  "project": {
    "name": "my-project",
    "repo": "owner/repo",
    "project_board": {
      "number": 9,
      "url": "https://github.com/users/owner/projects/9",
      "node_id": "PVT_kwDOABC123",
      "fields": {
        "status": {
          "field_id": "PVTSSF_...",
          "field_name": "Status",
          "type": "SINGLE_SELECT",
          "options": {
            "new": "option_id_1",
            "triaged": "option_id_2",
            "needs-info": "option_id_3",
            "needs-security-review": "option_id_4",
            "discussing": "option_id_5",
            "approved": "option_id_6",
            "planning": "option_id_7",
            "executing": "option_id_8",
            "verifying": "option_id_9",
            "pr-created": "option_id_10",
            "done": "option_id_11",
            "failed": "option_id_12",
            "blocked": "option_id_13"
          }
        },
        "ai_agent_state": {
          "field_id": "PVTF_...",
          "field_name": "AI Agent State",
          "type": "TEXT"
        },
        "milestone": {
          "field_id": "PVTF_...",
          "field_name": "Milestone",
          "type": "TEXT"
        },
        "phase": {
          "field_id": "PVTF_...",
          "field_name": "Phase",
          "type": "TEXT"
        },
        "gsd_route": {
          "field_id": "PVTSSF_...",
          "field_name": "GSD Route",
          "type": "SINGLE_SELECT",
          "options": {
            "gsd:quick": "option_id_a",
            "gsd:quick --full": "option_id_b",
            "gsd:plan-phase": "option_id_c",
            "gsd:new-milestone": "option_id_d"
          }
        }
      }
    }
  }
}
```

## Board Creation Workflow (for mgw:board — #72)

The `mgw:board` command will use this schema to:

1. **Fetch or create the board** via GraphQL `createProjectV2`
2. **Create each custom field** using the mutations above
3. **Store field IDs** in `project.json` under `project.project_board.fields`
4. **Add existing milestone issues** as board items
5. **Set initial field values** from `project.json` milestone data

### GraphQL: Create Project Board
```graphql
mutation {
  createProjectV2(input: {
    ownerId: "<OWNER_ID>"
    title: "<PROJECT_NAME> — MGW Pipeline Board"
    repositoryId: "<REPO_ID>"
  }) {
    projectV2 {
      id
      number
      url
    }
  }
}
```

### GraphQL: Add Issue to Board
```graphql
mutation {
  addProjectV2ItemById(input: {
    projectId: "<PROJECT_ID>"
    contentId: "<ISSUE_NODE_ID>"
  }) {
    item {
      id
    }
  }
}
```

### GraphQL: Update Field Value (Single Select)
```graphql
mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "<PROJECT_ID>"
    itemId: "<ITEM_ID>"
    fieldId: "<FIELD_ID>"
    value: {
      singleSelectOptionId: "<OPTION_ID>"
    }
  }) {
    projectV2Item {
      id
    }
  }
}
```

### GraphQL: Update Field Value (Text)
```graphql
mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "<PROJECT_ID>"
    itemId: "<ITEM_ID>"
    fieldId: "<FIELD_ID>"
    value: {
      text: "<TEXT_VALUE>"
    }
  }) {
    projectV2Item {
      id
    }
  }
}
```

## Board Views (Planned — #77, #78, #79)

Three views will be configured after fields are created:

| View | Type | Primary Group | Purpose |
|------|------|---------------|---------|
| **Pipeline** | Board (kanban) | Status field | See issues flowing through pipeline stages |
| **Team Planning** | Table | Milestone + Phase | Sort/filter by milestone, route, assignee |
| **Roadmap** | Roadmap | GitHub Milestone dates | Timeline view of milestone delivery |

## Dependencies

| Issue | Title | Depends On |
|-------|-------|------------|
| #72 | Add mgw:board command | This schema (#71) |
| #73 | Sync project.json milestones into board | This schema (#71) |
| #74 | Auto-update board Status on pipeline_stage | This schema (#71) |
| #77 | Configure Board layout (kanban) | Board creation (#72) |
| #78 | Configure Table layout | Board creation (#72) |
| #79 | Configure Roadmap layout | Board creation (#72) |
