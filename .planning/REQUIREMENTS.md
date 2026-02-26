# Requirements: MGW — Project Orchestration Layer

**Defined:** 2026-02-25
**Core Value:** Any GitHub repo can go from Day 1 idea to Go Live with a fully tracked, quality-assured pipeline — without the developer ever leaving Claude Code or doing project management manually.

## v1 Requirements

Requirements for the project-level orchestration expansion. Each maps to roadmap phases.

### Workflow Foundation

- [ ] **WKFL-01**: Shared GitHub workflow file extracts all duplicated `gh` CLI patterns from existing commands into a single reusable reference
- [ ] **WKFL-02**: Shared GSD workflow file extracts all subagent spawn patterns with mandatory CLAUDE.md injection
- [ ] **WKFL-03**: State validation includes staleness check against GitHub before milestone operations
- [ ] **WKFL-04**: Delegation boundary rule is documented and mechanically enforced ("Would GSD benefiting here mean MGW should delegate?")

### Templates

- [ ] **TMPL-01**: Web app pipeline template defines phases, milestone names, and GSD route recommendations
- [ ] **TMPL-02**: CLI tool pipeline template defines phases, milestone names, and GSD route recommendations
- [ ] **TMPL-03**: Library pipeline template defines phases, milestone names, and GSD route recommendations
- [ ] **TMPL-04**: Template loader fills parameters (max 5 per template) and validates output structure

### Project Initialization

- [x] **PROJ-01**: User can run `/mgw:project` with a project description and receive a complete GitHub milestone structure with scaffolded issues
- [x] **PROJ-02**: Project initialization creates GSD ROADMAP.md scaffold via GSD tooling (not MGW-invented format)
- [x] **PROJ-03**: Project state is persisted in `.mgw/project.json` with milestone IDs, phase map, and template used
- [x] **PROJ-04**: Dependency declarations between issues are stored in `.mgw/cross-refs.json` and reflected as GitHub labels
- [x] **PROJ-05**: Project initialization and execution are separate commands (init creates structure; milestone starts execution)

### Milestone Orchestration

- [x] **MLST-01**: User can run `/mgw:milestone` to execute a milestone's issues in dependency order, delegating each to `/mgw:run`
- [x] **MLST-02**: `/mgw:next` surfaces the next unblocked issue across the project based on dependency declarations
- [x] **MLST-03**: Milestone orchestration runs `/mgw:sync` automatically before starting to prevent stale-state operations
- [x] **MLST-04**: Rate limit check runs before milestone orchestration starts, with session-level API call caching
- [x] **MLST-05**: Per-issue completion state persists to `project.json` after each issue completes (restart checkpoint)

### Standalone Tools

- [ ] **TOOL-01**: `bin/mgw` CLI binary mirrors slash command surface (run, init, sync, project, milestone, next)
- [ ] **TOOL-02**: Shared `lib/` modules (state, github, gsd, templates) are used by both slash commands and binary
- [ ] **TOOL-03**: Binary is distributable via `npm install -g mgw` or `npm link` for local development
- [ ] **TOOL-04**: Binary works independently of Claude Code command format (format-independent fallback)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Visualization & Reporting

- **VIZ-01**: Pipeline visualization shows milestone progress bars in terminal without leaving Claude Code
- **VIZ-02**: Go Live readiness checklist validates tests, CI, changelog, docs, and blocking issues before ship

### Extended Templates

- **TMPL-05**: Mobile app pipeline template
- **TMPL-06**: API service pipeline template
- **TMPL-07**: Documentation site pipeline template
- **TMPL-08**: User can create custom pipeline templates

### Advanced Orchestration

- **MLST-06**: Multi-repo orchestration coordinates milestones across related repositories
- **MLST-07**: GitHub Actions integration triggers MGW commands from CI events

## Out of Scope

| Feature | Reason |
|---------|--------|
| Code execution / implementation | GSD handles this; MGW orchestrates, never codes |
| PRD → epic → issue decomposition | CCPM already does this; prefer interop over duplication |
| GitLab / Bitbucket support | GitHub-first; dilutes focus and doubles surface area |
| Team management / permissions | Solo-developer focus for v1 |
| CI/CD pipeline creation | MGW tracks progress through pipelines, doesn't create them |
| Real-time webhooks | Requires running server; breaks zero-config value prop |
| Custom reporting dashboards / TUI | High complexity, low ROI for solo dev in Claude Code |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| WKFL-01 | Phase 1 | Pending |
| WKFL-02 | Phase 1 | Pending |
| WKFL-03 | Phase 1 | Pending |
| WKFL-04 | Phase 1 | Pending |
| TMPL-01 | Phase 2 | Pending |
| TMPL-02 | Phase 2 | Pending |
| TMPL-03 | Phase 2 | Pending |
| TMPL-04 | Phase 2 | Pending |
| PROJ-01 | Phase 3 | Complete |
| PROJ-02 | Phase 3 | Complete |
| PROJ-03 | Phase 3 | Complete |
| PROJ-04 | Phase 3 | Complete |
| PROJ-05 | Phase 3 | Complete |
| MLST-01 | Phase 4 | Complete |
| MLST-02 | Phase 4 | Complete |
| MLST-03 | Phase 4 | Complete |
| MLST-04 | Phase 4 | Complete |
| MLST-05 | Phase 4 | Complete |
| TOOL-01 | Phase 5 | Pending |
| TOOL-02 | Phase 5 | Pending |
| TOOL-03 | Phase 5 | Pending |
| TOOL-04 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 22 total
- Mapped to phases: 22
- Unmapped: 0

---
*Requirements defined: 2026-02-25*
*Last updated: 2026-02-25 after roadmap creation*
