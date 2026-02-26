# Roadmap: MGW — Project Orchestration Layer

## Overview

MGW expands from issue-level pipeline automation to full project orchestration — from Day 1 idea to Go Live. The build order is fixed by dependency: shared workflows first (the foundation everything else touches), then the template engine that makes initialization opinionated, then the project initialization command (the core differentiator), then milestone orchestration (the coordination layer), and finally the standalone binary (the distribution and format-independent fallback). Each phase delivers a discrete, testable capability and unlocks the next.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Shared Workflow Hardening** - Extract duplicated logic into reusable shared workflows and enforce delegation boundaries
- [x] **Phase 2: Template Engine** - Build parameterized pipeline templates for web app, CLI tool, and library project types (completed 2026-02-25)
- [x] **Phase 3: Project Initialization** - Deliver `/mgw:project` — the Day 1 command that creates a complete GitHub milestone structure from a description (completed 2026-02-25)
- [x] **Phase 4: Milestone Orchestration** - Deliver `/mgw:milestone` and `/mgw:next` — dependency-ordered execution of milestone issues (completed 2026-02-26)
- [ ] **Phase 5: Standalone Tools** - Deliver `bin/mgw` CLI binary that mirrors the slash command surface and works independently of Claude Code

## Phase Details

### Phase 1: Shared Workflow Hardening
**Goal**: Shared workflows exist that every MGW command can reference, eliminating the duplicated `gh` CLI patterns and GSD spawn logic that currently lives in each command individually — and enforcing correct CLAUDE.md injection for all subagents.
**Depends on**: Nothing (first phase)
**Requirements**: WKFL-01, WKFL-02, WKFL-03, WKFL-04
**Success Criteria** (what must be TRUE):
  1. A developer adding a new MGW command can reference `workflows/github.md` instead of copying `gh` CLI patterns from an existing command
  2. Every GSD subagent spawned by MGW commands receives `CLAUDE.md` and `.agents/skills/` — enforced by `workflows/gsd.md`, not by individual command authors
  3. Before any milestone operation, `validate_and_load` checks GitHub for staleness without the developer doing anything extra
  4. A developer reviewing a new MGW command can apply the delegation boundary rule from a single documented source and get a clear yes/no answer
**Plans**: 2 plans in 2 waves

Plans:
- [x] 01-01-PLAN.md — Create all 4 shared workflow files (github.md, gsd.md, state.md, validation.md)
- [x] 01-02-PLAN.md — Migrate all 10 existing commands to reference shared workflows

### Phase 2: Template Engine
**Goal**: Three opinionated pipeline templates (web app, CLI tool, library) exist and a template loader can fill their parameters and validate the output — so `/mgw:project` can be opinionated rather than free-form.
**Depends on**: Phase 1
**Requirements**: TMPL-01, TMPL-02, TMPL-03, TMPL-04
**Success Criteria** (what must be TRUE):
  1. Running the template loader with a project type and up to 5 parameters produces a valid, filled project structure (phases, milestone names, GSD route recommendations) without errors
  2. Each template's output references valid GSD route identifiers — a developer can follow a template recommendation directly to a GSD workflow
  3. Providing more than 5 parameters to the template loader produces a validation error, not silent truncation
**Plans**: 2 plans in 2 waves

Plans:
- [ ] 02-01-PLAN.md — Create shared JSON Schema and author all 3 pipeline templates (web-app, cli-tool, library)
- [ ] 02-02-PLAN.md — Build template loader module with parameter filling, validation, and 5-parameter enforcement

### Phase 3: Project Initialization
**Goal**: A developer with a GitHub repo and a project idea can run `/mgw:project` and receive a fully structured GitHub project — milestones created, issue backlog scaffolded, dependency labels applied, GSD ROADMAP.md scaffolded, and state persisted to `.mgw/project.json`.
**Depends on**: Phase 2
**Requirements**: PROJ-01, PROJ-02, PROJ-03, PROJ-04, PROJ-05
**Success Criteria** (what must be TRUE):
  1. After running `/mgw:project init`, GitHub contains the milestones and issue backlog defined by the selected template — the developer does not create these manually
  2. `.mgw/project.json` exists with milestone IDs, phase map, current milestone pointer, and template used — a subsequent command can read project state without hitting GitHub
  3. Issue dependencies declared during init appear as GitHub labels on the dependent issues
  4. Running `/mgw:project init` and then immediately running `/mgw:milestone start` are two distinct operations — init does not trigger execution
**Plans**: 2 plans in 2 waves

Plans:
- [ ] 03-01-PLAN.md — Extend template schema with depends_on field and add milestone/label API patterns to github.md workflow
- [ ] 03-02-PLAN.md — Create /mgw:project command with input gathering, template loading, GitHub creation, ROADMAP generation, and state persistence

### Phase 4: Milestone Orchestration
**Goal**: A developer can run `/mgw:milestone` to execute a milestone's issues in dependency order — and `/mgw:next` to surface what to work on next — without manually tracking what is blocked, in progress, or done.
**Depends on**: Phase 3
**Requirements**: MLST-01, MLST-02, MLST-03, MLST-04, MLST-05
**Success Criteria** (what must be TRUE):
  1. Running `/mgw:milestone` executes each unblocked issue in the milestone by delegating to `/mgw:run`, in declared dependency order, without the developer manually sequencing them
  2. Running `/mgw:next` returns a single actionable answer: which issue to work on now, based on declared dependencies — not a guess
  3. A milestone run that is interrupted mid-way can be resumed in a new session; the completed issues are not re-executed
  4. A milestone run that would exceed the GitHub API rate limit stops before hitting the limit and tells the developer how many issues it completed
**Plans**: 2 plans in 1 wave

Plans:
- [x] 04-01-PLAN.md — Build /mgw:milestone command with dependency sequencing, pre-sync, rate limit guard, per-issue checkpointing, failure handling, resume detection, and milestone completion (close + release)
- [x] 04-02-PLAN.md — Build /mgw:next command with dependency-aware issue surfacing, live GitHub verification, and offer to run

### Phase 5: Standalone Tools
**Goal**: A developer can install `mgw` as a global npm package and run `mgw run`, `mgw project`, `mgw milestone`, `mgw next`, and other commands from any terminal — with the same behavior as the slash commands — without Claude Code.
**Depends on**: Phase 4
**Requirements**: TOOL-01, TOOL-02, TOOL-03, TOOL-04
**Success Criteria** (what must be TRUE):
  1. `npm install -g mgw` succeeds and `mgw --version` prints a version string
  2. `mgw run`, `mgw project`, `mgw milestone`, and `mgw next` all execute their corresponding slash command logic using shared `lib/` modules — no logic is duplicated between the binary and slash commands
  3. The binary functions correctly when the Claude Code slash command format is unavailable — it does not rely on Claude Code command discovery
**Plans**: 2 plans in 2 waves

Plans:
- [ ] 05-01-PLAN.md — Create shared lib/ modules (state, github, gsd, templates, output, claude), bundled commands/ directory, and package.json with pkgroll build pipeline
- [ ] 05-02-PLAN.md — Build bin/mgw.cjs entry point with Commander.js routing for all 12 commands, pkgroll build verification, and npm pack validation

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Shared Workflow Hardening | 2/2 | Complete | 2026-02-25 |
| 2. Template Engine | 2/2 | Complete | 2026-02-25 |
| 3. Project Initialization | 2/2 | Complete    | 2026-02-25 |
| 4. Milestone Orchestration | 2/2 | Complete    | 2026-02-26 |
| 5. Standalone Tools | 0/2 | Not started | - |
