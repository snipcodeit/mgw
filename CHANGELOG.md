# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
