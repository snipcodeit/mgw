# Phase 5: Standalone Tools - Context

**Gathered:** 2026-02-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver `bin/mgw` as an npm-distributable CLI binary that mirrors all 12 slash commands and works independently of Claude Code. AI-dependent commands shell out to the `claude` CLI; non-AI commands (sync, help, issues, link) work without it. Shared `lib/` modules power both the CLI and slash commands — no logic duplication.

</domain>

<decisions>
## Implementation Decisions

### Command scope & parity
- All 12 slash commands get CLI equivalents (run, init, sync, project, milestone, next, issues, issue, update, pr, link, help)
- Subcommand names exactly match slash command names (e.g., `mgw run`, `mgw milestone`, `mgw sync`)
- Same autonomous chaining as slash commands — `mgw run 42` does the full pipeline (triage -> plan -> execute -> PR)
- Support `--auto` flag for phase chaining (discuss -> plan -> execute)
- Global `--dry-run` flag shows what would happen without executing

### AI invocation strategy
- Shell out to `claude` CLI (`claude -p "prompt"`) for AI-dependent operations
- Pass the original markdown command files directly to claude — CLI is a thin wrapper that feeds existing .md files
- Command .md files ship bundled in the npm package (resolved from install path, not `.claude/commands/`)
- Check for `claude` CLI only when an AI-dependent command is invoked, not at startup
- Non-AI commands (sync, help, issues, link) work without claude installed

### AI output & control
- Stream claude output in real-time by default
- `--quiet` flag collects output and displays summary instead
- `--model` flag overrides which Claude model is used for AI operations
- When `claude` is not installed/authenticated, AI commands fail with a clear error and install instructions

### Terminal experience
- Auto-detect TTY: colored output with Unicode icons in terminal, plain text when piped or in CI
- Global `--json` flag for structured JSON output on every command (enables scripting: `mgw next --json | jq .issue.number`)
- In non-TTY environments: all interactive inputs must be provided as flags; missing required flags = error with usage hint
- Verbosity levels: default (concise), `-v` (shows API calls, file writes), `--debug` (full payloads, timings)

### Distribution
- npm package name: `mgw` if available on npm, fall back to scoped `@snipcodeit/mgw`
- Independent semantic versioning (not tied to milestones)
- Bundle with pkgroll — zero runtime dependencies, `npx mgw` works instantly
- Updates via standard `npm update -g mgw` — no custom self-update mechanism

### Claude's Discretion
- Exact shared module boundaries (how to split lib/state, lib/github, lib/gsd, lib/templates)
- Commander.js command/option registration patterns
- pkgroll configuration and build pipeline
- How to resolve bundled .md command files from install path
- Error message formatting and exit codes
- Interactive prompt library choice (inquirer, prompts, etc.)

</decisions>

<specifics>
## Specific Ideas

- CLI should feel like modern tools (Vite, Turborepo) — colored status, Unicode icons, structured output
- `mgw run` should be watchable in real-time like a deployment pipeline
- Same mental model between `/mgw:run 42` in Claude Code and `mgw run 42` in terminal — no behavioral differences
- The existing `lib/template-loader.cjs` is the first shared module; others follow the same pattern

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-standalone-tools*
*Context gathered: 2026-02-25*
