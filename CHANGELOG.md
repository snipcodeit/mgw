# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-03-05

### Added

- `lib/pipeline.cjs` — single source of truth for all 14 pipeline stages, valid transitions, icons, labels
- `lib/errors.cjs` — typed error hierarchy: `MgwError`, `GitHubApiError`, `GsdToolError`, `StateError`, `TimeoutError`, `ClaudeNotAvailableError`
- `withRetry()` async wrapper in `lib/retry.cjs` — exponential backoff with jitter for transient failures
- Cross-refs validation on load (`loadCrossRefs()` in `lib/state.cjs`) with link-type enforcement
- Timeouts on all `execSync` calls: `gh` CLI (30s), GSD tools (15s), Claude availability check (10s)
- CI workflow (`.github/workflows/ci.yml`) — Node 18/20/22 matrix, test + build + lint
- Dependabot configuration for npm and GitHub Actions dependencies
- ESLint flat config targeting `.cjs` files with practical rules
- Test suites for `pipeline.cjs`, `errors.cjs`, `retry.cjs`, `gsd-adapter.cjs` (108 new tests)

### Changed

- `lib/github.cjs` — all public functions are now async; transient failures (429, 5xx, network errors) are retried automatically via `withRetry()`
- `lib/claude.cjs` — `assertClaudeAvailable()` now throws `ClaudeNotAvailableError` instead of calling `process.exit(1)`; added SIGINT forwarding to child process
- `lib/gsd-adapter.cjs` — errors now throw typed `GsdToolError` or `TimeoutError`
- `lib/state.cjs` — `migrateProjectState()` returns `{ state, warnings }` instead of just state object

## [0.2.2] - 2026-03-02

### Fixed

- `review` command: restore issue comment classification alongside new deep PR analysis mode
- Address all PR #170 review feedback

## [0.2.1] - 2026-03-02

### Fixed

- Pass fallback prompt to `claude -p` for no-arg commands

## [0.2.0] - 2026-03-02

### Added

- TUI issue browser for `mgw:issues` with neo-blessed — keyboard navigation, search, label/milestone filters
- Per-stage spinner utility and pipeline progress indicators for `mgw:run`
- Milestone progress bar for `mgw:milestone` output
- `--watch` flag with live-refresh panel for `mgw:status`
- Bash, zsh, and fish shell completion scripts
- Interactive config wizard for `mgw:init` first-time setup
- `/mgw:review` deep PR analysis command with file-level annotations
- `/mgw:roadmap` command for rendering milestone roadmap tables
- `lib/gsd-adapter.cjs` — GSD tool invocation and route selection extracted from commands
- `lib/retry.cjs` — failure taxonomy (transient/permanent/needs-info), backoff constants, issue-state helpers
- Retry logic integration into `run.md` and `milestone.md` workflows

### Changed

- `mgw:status` registered as a CLI command in `bin/mgw.cjs`
- Vision cycle workflow extracted from `project.md` into `workflows/vision-cycle.md`
- Remaining workflow logic extracted from `project.md` into shared workflow files
- Route selection and state reading migrated to `lib/gsd-adapter.cjs`

### Fixed

- Harden MGW label lifecycle — atomic transitions, return-code checking, drift detection
- TUI search bar keyboard input handling
- Filter persistence and `searchIn` TypeError in TUI
- `isTTY` guard added to config wizard
- Dead `DONE_SO_FAR` variable removed; `stageIcon` coverage for intermediate stages
- `__dirname` resolution for completions; zsh `fpath` requirement clarified

## [0.1.3] - 2026-03-02

### Fixed

- Hardened label lifecycle with atomic transitions and drift detection

## [0.1.2] - 2026-03-02

### Added

- Board discovery, field hydration, and multi-machine sync via `board pull`
- npm publish workflow on version tags (`.github/workflows/npm-deploy.yml`)

### Fixed

- Provision board fields and set Status on issue creation

## [0.1.1] - 2026-03-01

### Added

- Scoped package to `@snipcodeit/mgw`
- `bin/mgw-install.cjs` — idempotent postinstall slash command installer
- Board and workflow files migrated into `commands/` directory

### Changed

- README install commands updated for scoped package name

## [0.1.0] - 2026-02-24

### Added

- CLI entry point (`bin/mgw.cjs`) with 12 subcommands: `ask`, `help`, `init`, `issue`, `issues`, `link`, `milestone`, `next`, `project`, `review`, `run`, `sync`
- Slash command suite for Claude Code (`.claude/commands/mgw/`) with matching prompt files for each subcommand
- `/mgw:run` orchestrator pipeline — end-to-end issue execution with triage, worktree isolation, implementation, PR creation, and cleanup
- `/mgw:project` AI-driven project scaffolding — generates milestones, phases, and issue graphs from a repository description
- `/mgw:milestone` and `/mgw:next` milestone orchestration with dependency ordering and phase-aware sequencing
- GitHub Projects v2 integration via `gh` CLI for issue, PR, milestone, and label management
- Worktree isolation — each issue branch runs in its own `git worktree` under `.worktrees/`
- Structured status comments on GitHub issues with pipeline stage tracking
- State management system (`.mgw/active/` JSON files) for tracking issue lifecycle
- `/mgw:ask` contextual question routing command
- `/mgw:status` project dashboard command for at-a-glance milestone and issue progress
- `/mgw:init` command for initializing MGW in a new repository with GitHub templates and labels
- `/mgw:sync` post-merge cleanup for merged PRs (worktree removal, state archival)
- `/mgw:review` PR review command and `/mgw:link` for linking related issues
- Comment-aware pipeline — detects and reacts to new GitHub issue comments during execution
- Shared workflow reference files (`workflows/github.md`, `workflows/state.md`) for consistent patterns across commands
- JSON Schema-based pipeline templates with parameter validation
- Template loader with parameter filling and validation (later refactored to validation-only)
- `pkgroll` build pipeline producing CommonJS output in `dist/`
- Shared `lib/` modules (`github.js`, `state.js`, `template-loader.js`) for code reuse across CLI commands
- GitHub issue templates upgraded to YAML forms with structured fields
- GitHub Actions auto-label workflow for PRs
- CONTRIBUTING.md with development setup and PR process documentation
- CODEOWNERS file and branch protection guidance
- README.md with project overview, command reference, and installation instructions
- `.npmignore` for clean package output
- `npx` support for zero-install usage

### Changed

- Refactored `/mgw:project` from hardcoded JSON templates to AI-driven scaffolding
- Refactored template loader to validation-only role after removing hardcoded template JSONs
- Removed all `.planning/` writes from MGW commands (moved to external tooling)
- Migrated all 10 original commands to reference shared workflow files

### Fixed

- Corrected `gh pr` JSON field from `merged` to `mergedAt` in sync command
- Fixed `optsWithGlobals()` usage and `pkgroll` source path for successful builds
- Fixed pipeline audit issues: 3 bugs, stale README content, and drifted `project.md`
- Fixed orchestrator-owned status comments with prescriptive PR templates and milestone context
