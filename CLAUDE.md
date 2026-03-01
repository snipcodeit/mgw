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

### Key Directories

| Directory | Owner | Purpose |
|-----------|-------|---------|
| `.mgw/` | MGW | Pipeline state, cross-refs, project.json |
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
| `project` | Initialize project -- create GitHub milestones/issues from ROADMAP.md | Yes (.mgw/project.json) |
| `run` | Autonomous pipeline -- triage through execution to PR | Yes (.mgw/active/) |
| `issue` | Deep-triage a single issue | Yes (.mgw/active/) |
| `milestone` | Execute all issues in a milestone | Yes (.mgw/project.json) |
| `board` | Create/configure/sync GitHub Projects v2 board | Yes (.mgw/project.json) |
| `assign` | Claim/reassign issues | No |
| `ask` | Classify a question/observation | No |
| `init` | Bootstrap .mgw/ directory | Yes (.mgw/) |
| `next` | Find next unblocked issue | No |
| `pr` | Create PR from GSD artifacts | Yes (.mgw/active/) |
| `review` | Classify new comments | No |
| `status` | Project status dashboard | No |
| `sync` | Reconcile .mgw/ with GitHub | Yes (.mgw/) |
| `update` | Post structured status comment | No |
| `link` | Cross-reference issues/PRs/branches | Yes (.mgw/cross-refs.json) |
| `help` | Show commands | No |

### Testing

There are currently no automated tests. When adding new lib/ functions, verify they work by running them with `node` directly. For command changes, test by running the command against the MGW repo itself or a test repo.

### GSD Integration Points

- `gsd-tools.cjs` provides: slug generation, timestamps, model resolution, roadmap analysis, init contexts, commit utility, progress display, summary extraction, health checks
- GSD workflows live at `~/.claude/get-shit-done/workflows/`
- GSD agents are typed: `gsd-planner`, `gsd-executor`, `gsd-verifier`, `gsd-plan-checker`, `general-purpose`
- The GSD debug/diagnosis workflow is `diagnose-issues.md` (spawns parallel debug agents per UAT gap)
