# MGW -- My GSD Workflow

## What This Is

MGW is a GitHub-native issue-to-PR automation system for Claude Code. It orchestrates GSD (Get Shit Done) agents to triage issues, plan work, execute code changes, and create pull requests.

## Architecture

MGW is an orchestration layer. It NEVER touches application code directly.

```
GitHub (issues, PRs, milestones, labels)
  ^
  |  reads/writes metadata
MGW (orchestration layer -- .mgw/ state, pipeline stages, agent spawning)
  |
  |  spawns agents, passes context
  v
GSD (execution layer -- .planning/ state, PLAN.md, code changes, SUMMARY.md)
  |
  v
Target Codebase
```

### The Delegation Boundary

MGW orchestrates. MGW never codes. See `workflows/validation.md` for the full rule.

**MGW may do directly:**
- Read/write `.mgw/` state files
- Read/write GitHub metadata via `gh` CLI
- Spawn `Task()` agents
- Manage git worktrees and branches
- Display output to users

**MGW must NEVER do directly:**
- Read application source code
- Write application source code
- Make implementation decisions
- Analyze code for scope or security (spawn an agent for this)

### Vision Collaboration Cycle (Fresh Projects)

When `mgw:project` detects a Fresh state (no existing GSD or GitHub state), it runs a 6-stage vision cycle before creating any GitHub structure:

1. **Intake** — freeform project description from user
2. **Domain Expansion** — `vision-researcher` Task agent produces `.mgw/vision-research.json`
3. **Structured Questioning** — 3-8 rounds (soft cap), 15 max (hard cap); decisions appended to `.mgw/vision-draft.md`
4. **Vision Synthesis** — `vision-synthesizer` Task agent produces `.mgw/vision-brief.json` (schema: `templates/vision-brief-schema.json`)
5. **Review** — user accepts or requests revisions (loops back to synthesis)
6. **Condense** — `vision-condenser` Task agent produces `.mgw/vision-handoff.md` for `gsd:new-project` spawn

Context strategy: rolling summary only. Agents receive Vision Brief + latest delta, never full transcript.

### Key Directories

| Directory | Owner | Purpose |
|-----------|-------|---------|
| `.mgw/` | MGW | Pipeline state, cross-refs, project.json |
| `.mgw/vision-*.json` | Vision Brief artifacts (runtime, gitignored): `vision-research.json`, `vision-brief.json`, `vision-handoff.md`, `vision-draft.md`, `alignment-report.json`, `drift-report.json` |
| `.planning/` | GSD | ROADMAP.md, STATE.md, config.json, phase plans |
| `commands/` | MGW | Slash command definitions (mirrored to .claude/commands/mgw/) |
| `workflows/` | MGW | Shared workflow patterns referenced by commands |
| `lib/` | MGW | Node.js utilities (template-loader, github, state, etc.) |
| `templates/` | MGW | JSON schema for project templates |

### Coding Conventions

- Commands are markdown files with XML structure (`<objective>`, `<process>`, `<step>`)
- All bash in commands is pseudocode -- it shows the pattern, not runnable scripts
- Every `Task()` spawn MUST include the CLAUDE.md injection block (see `workflows/gsd.md`)
- Model names are NEVER hardcoded -- resolve via `gsd-tools.cjs resolve-model`
- State files use JSON format
- Slug generation uses `gsd-tools.cjs generate-slug` with 40-char truncation
- Timestamps use `gsd-tools.cjs current-timestamp`

### Command Surface

| Command | Purpose | Modifies State? |
|---------|---------|-----------------|
| `project` | State-aware project init — 5-signal detection routes to Vision Cycle, alignment, drift reconciliation, or extend | Yes (.mgw/project.json, vision-*.json) |
| `run` | Autonomous pipeline -- triage through execution to PR; cross-milestone detection enforced | Yes (.mgw/active/) |
| `issue` | Deep-triage a single issue | Yes (.mgw/active/) |
| `milestone` | Execute all issues in a milestone; failed-issue recovery (Retry/Skip/Abort); next-milestone GSD linkage check | Yes (.mgw/project.json) |
| `board` | Create/configure/sync GitHub Projects v2 board | Yes (.mgw/project.json) |
| `assign` | Claim/reassign issues; resolves GitHub noreply coauthor tag | No |
| `ask` | Classify a question/observation | No |
| `init` | Bootstrap .mgw/ directory | Yes (.mgw/) |
| `next` | Find next unblocked issue; surfaces failed issues as advisory | No |
| `pr` | Create PR from GSD artifacts; includes Phase Context and PLAN.md (collapsed) | Yes (.mgw/active/) |
| `review` | Classify new comments | No |
| `status` | Project status dashboard | No |
| `sync` | Reconcile .mgw/ with GitHub; checks maps-to GSD milestone consistency | Yes (.mgw/) |
| `update` | Post structured status comment | No |
| `link` | Cross-reference issues/PRs/branches; supports maps-to (milestone ↔ gsd-milestone) | Yes (.mgw/cross-refs.json) |
| `help` | Show commands | No |

### State Detection Matrix (mgw:project)

`mgw:project` reads five signals before deciding what to do:

| Signal | Meaning |
|--------|---------|
| `P` | `.mgw/project.json` exists |
| `R` | `.planning/ROADMAP.md` exists |
| `S` | GitHub milestones exist |
| `M` | `maps-to` links in cross-refs.json |
| `G` | GSD phase state exists (.planning/ non-empty) |

Signals map to routing states:

| State | Signals | Action |
|-------|---------|--------|
| Fresh | none | 6-stage Vision Collaboration Cycle → gsd:new-project → milestone_mapper |
| GSD-Only | R+G, no P/S | alignment-analyzer agent → milestone_mapper (backfill GitHub structure) |
| GSD-Mid-Exec | R+G+partial S | alignment with partial execution state |
| Aligned | P+R+S+M | Status report + interactive extend option |
| Diverged | P+S, R mismatch | drift-analyzer agent → reconciliation table |
| Extend | explicit flag | Add new milestones to existing project |

### Pipeline Stages

Valid `pipeline_stage` values (in `.mgw/active/*.json` and `project.json`):

```
new → triaged → planning → executing → verifying → pr-created → done
triaged → diagnosing → planning  (gsd:diagnose-issues route)
any → blocked | failed
```

Stages: `new`, `triaged`, `needs-info`, `needs-security-review`, `discussing`, `approved`, `planning`, `diagnosing`, `executing`, `verifying`, `pr-created`, `done`, `failed`, `blocked`

### Cross-Ref Link Types

| a | b | type |
|---|---|------|
| issue | issue | related |
| issue | pr | implements |
| issue | branch | tracks |
| pr | branch | tracks |
| milestone:N | gsd-milestone:id | maps-to |

### Testing

There are currently no automated tests. When adding new lib/ functions, verify they work by running them with `node` directly. For command changes, test by running the command against the MGW repo itself or a test repo.

### GSD Integration Points

- `gsd-tools.cjs` provides: slug generation, timestamps, model resolution, roadmap analysis, init contexts, commit utility, progress display, summary extraction, health checks
- `lib/state.cjs` provides: `migrateProjectState()` (idempotent schema migration, called at every validate_and_load), `resolveActiveMilestoneIndex()` (dual-mode: resolves `active_gsd_milestone` string OR legacy `current_milestone` integer)
- `lib/template-loader.cjs` provides: `parseRoadmap()` (parses GSD ROADMAP.md phase sections into structured JSON), `parse-roadmap` CLI subcommand
- GSD workflows live at `~/.claude/get-shit-done/workflows/`
- GSD agents are typed: `gsd-planner`, `gsd-executor`, `gsd-verifier`, `gsd-plan-checker`, `general-purpose`
- Vision agents (spawned by mgw:project Fresh path): `vision-researcher`, `vision-synthesizer`, `vision-condenser`
- The GSD debug/diagnosis workflow is `diagnose-issues.md` (spawns parallel debug agents per UAT gap)

### project.json Schema (key fields)

| Field | Type | Notes |
|-------|------|-------|
| `current_milestone` | integer (1-indexed) | Legacy — kept for backward compat |
| `active_gsd_milestone` | string \| null | Canonical active pointer (e.g. `"v1.1"`) |
| `milestones[].gsd_milestone_id` | string \| null | GSD milestone ID (e.g. `"v1.0"`) |
| `milestones[].gsd_state` | `"active"\|"completed"\|"planned"\|null` | GSD execution state |
| `milestones[].roadmap_archived_at` | ISO timestamp \| null | Set on milestone completion |
| `milestones[].issues[].board_item_id` | string \| null | GitHub Projects v2 item ID |

Always use `resolveActiveMilestoneIndex(state)` from `lib/state.cjs` to resolve the active milestone — never read `current_milestone` directly.
