# Commands Reference

Complete reference for all MGW commands. Each command is available as both a Claude Code slash command (`/mgw:command`) and a CLI command (`mgw command`).

---

## Command Overview

| Command | Description | Requires Claude? |
|---------|-------------|:---:|
| `/mgw:init` | Bootstrap repo for MGW | Yes |
| `/mgw:project` | Scaffold milestones and issues from description | Yes |
| `/mgw:issues` | Browse and filter GitHub issues | No |
| `/mgw:issue <n>` | Deep triage of a single issue | Yes |
| `/mgw:next` | Show next unblocked issue | Yes |
| `/mgw:run <n>` | Full autonomous pipeline: triage through PR | Yes |
| `/mgw:milestone [n]` | Execute a milestone's issues in dependency order | Yes |
| `/mgw:update <n>` | Post structured status comment | Yes |
| `/mgw:pr [n]` | Create PR from GSD artifacts | Yes |
| `/mgw:link <ref> <ref>` | Cross-reference issues, PRs, branches | No |
| `/mgw:status [n]` | Project dashboard | No |
| `/mgw:sync` | Reconcile local state with GitHub | No |
| `/mgw:ask <question>` | Route a question during work | Yes |
| `/mgw:review <n>` | Classify new comments on an issue | Yes |
| `/mgw:help` | Command reference display | No |

---

## Setup Commands

### `/mgw:init`

Bootstrap a repository for MGW. One-time setup, safe to re-run.

**Usage:**
```
/mgw:init
```

**What it creates:**
- `.mgw/` state directory (gitignored)
- `.mgw/cross-refs.json` for tracking links
- GitHub issue templates (bug report + enhancement)
- GitHub PR template
- Standard labels on the repository
- `.gitignore` entries for `.mgw/` and `.worktrees/`

**Notes:**
- Safe to re-run -- skips anything that already exists
- Does not require an existing `.mgw/` directory
- Does not touch any existing files

---

### `/mgw:project`

Scaffold an entire project from a description. Creates milestones, issues, dependency labels, and project state.

**Usage:**
```
/mgw:project
```

**What it does:**
1. Asks "What are you building?"
2. Generates project-specific milestones, phases, and issues using AI
3. Creates GitHub milestones with descriptions
4. Creates issues assigned to milestones with phase labels
5. Adds `blocked-by:#N` labels for dependency tracking
6. Writes `.mgw/project.json` with full project state

**Important:**
- Creates structure only -- does **not** trigger execution
- Run `/mgw:milestone` to begin working through issues
- Does not ask you to pick a template type -- the AI infers project structure from your description

---

## Browse and Triage Commands

### `/mgw:issues [filters]`

List open issues with optional filters. Works without Claude.

**Usage:**
```
/mgw:issues                        # Your open issues (default: @me, open)
/mgw:issues --label bug            # Filter by label
/mgw:issues --milestone "v2.0"     # Filter by milestone
/mgw:issues --assignee all         # All open issues (not just yours)
/mgw:issues --state closed         # Closed issues
/mgw:issues --json                 # JSON output for scripting
```

**CLI equivalent:**
```bash
mgw issues
mgw issues --label bug --json
```

---

### `/mgw:issue <number>`

Deep triage of a single issue against the codebase. Spawns an analysis agent that evaluates five dimensions.

**Usage:**
```
/mgw:issue 42
```

**Triage dimensions:**
- **Scope** -- Which files and systems are affected, estimated size
- **Validity** -- Can the issue be confirmed by reading the code?
- **Purpose** -- Who benefits, what is the impact of inaction?
- **Security** -- Does it touch auth, user data, external APIs?
- **Conflicts** -- Does it overlap with other in-progress work?

**Output:**
- A recommended GSD route (`quick`, `quick --full`, or `new-milestone`)
- A state file at `.mgw/active/<number>-<slug>.json`
- A triage comment posted on the GitHub issue

---

### `/mgw:next`

Show the next unblocked issue based on dependency order. Read-only -- does not start any work.

**Usage:**
```
/mgw:next
```

**Displays:**
- Recommended issue with full context (GSD route, phase, labels)
- Resolved dependencies (what had to finish first)
- What this issue unblocks (downstream issues)
- Alternative unblocked issues (if multiple are available)
- Offer to start `/mgw:run` for the recommended issue

---

## Pipeline Commands

### `/mgw:run <number>`

The main command. Runs the full autonomous pipeline for a single issue.

**Usage:**
```
/mgw:run 42
```

**Pipeline stages:**
1. **Validate** -- Load or create triage state
2. **Worktree** -- Create isolated git worktree (`issue/42-<slug>`)
3. **Pre-flight** -- Check for new comments since triage (classify as material/informational/blocking)
4. **Triage comment** -- Post structured triage results on the issue
5. **GSD execution** -- Run the appropriate GSD route
6. **Execution comment** -- Post commit count, file changes, test status
7. **PR creation** -- Push branch, create PR with milestone context
8. **PR-ready comment** -- Post PR link and pipeline summary
9. **Cleanup** -- Remove worktree, update state

**Notes:**
- If the issue has not been triaged yet, `/mgw:run` runs triage inline first
- All work happens in an isolated worktree -- your main workspace stays clean
- Posts structured status comments at every stage

**CLI equivalent:**
```bash
mgw run 42
mgw run 42 --dry-run    # Preview without executing
mgw run 42 --quiet      # Buffer output, show summary at end
```

---

### `/mgw:milestone [number] [--interactive] [--dry-run]`

Execute all issues in a milestone in dependency order. The most powerful command -- it chains multiple `/mgw:run` invocations with checkpointing.

**Usage:**
```
/mgw:milestone              # Current milestone (from project.json)
/mgw:milestone 2            # Specific milestone by number
/mgw:milestone --dry-run    # Show execution plan without running
/mgw:milestone --interactive  # Pause between issues for review
```

**What it does:**
1. Loads `project.json` and resolves the target milestone
2. Runs a batch staleness check against GitHub
3. Checks API rate limits (caps execution if limits are low)
4. Topologically sorts issues by dependency (Kahn's algorithm)
5. Filters out already-completed issues
6. For each issue: posts work-started comment, runs pipeline, posts result comment
7. Handles failures: marks failed issues, blocks dependents, continues with unblocked issues
8. On full completion: closes GitHub milestone, creates draft release, advances to next milestone

**Flags:**
- `--dry-run` -- Show execution order table with dependencies and rate limit estimates. Does not execute.
- `--interactive` -- Pause after each issue with options: Continue, Skip next, Abort.

**CLI equivalent:**
```bash
mgw milestone
mgw milestone 2 --interactive
mgw milestone --dry-run
```

---

## Query Commands

### `/mgw:status [milestone] [--json]`

Project dashboard showing milestone progress, issue pipeline stages, and open PRs.

**Usage:**
```
/mgw:status              # Current milestone
/mgw:status 2            # Specific milestone
/mgw:status --json       # Machine-readable output
```

**Displays:**
- Progress bar with percentage
- Per-issue pipeline stages with icons
- Open PRs matched to milestone issues
- Next milestone preview

Falls back gracefully when no `project.json` exists (shows GitHub-only status with open issues and PRs).

---

### `/mgw:ask <question>`

Route a question or observation during work. Classifies it against the current project context.

**Usage:**
```
/mgw:ask "The slug generation doesn't handle unicode characters"
```

**Classifications:**
- **In-scope** -- Relates to the current active issue. Include in current work.
- **Adjacent** -- Relates to a different issue in the same milestone. Suggest posting a comment.
- **Separate** -- No matching issue. Suggest filing a new one.
- **Duplicate** -- Matches an existing issue. Point to it.
- **Out-of-scope** -- Beyond the current milestone. Note for future planning.

---

### `/mgw:review <number>`

Review and classify new comments on a GitHub issue since last triage.

**Usage:**
```
/mgw:review 42
```

**What it does:**
- Fetches new comments posted since triage
- Classifies each as **material** (changes scope), **informational** (status update), or **blocking** (explicit "stop")
- Updates the state file accordingly

Use this when you want to check for stakeholder feedback before running the pipeline, or to review comments on a blocked issue before unblocking it.

---

## GitHub Operations

### `/mgw:update <number> [message]`

Post a structured status comment on an issue.

**Usage:**
```
/mgw:update 42                           # Auto-detect status from state
/mgw:update 42 "switching approach"      # Custom message
```

---

### `/mgw:pr [number] [--base branch]`

Create a PR from GSD artifacts.

**Usage:**
```
/mgw:pr                    # From current branch
/mgw:pr 42                 # Linked to issue #42
/mgw:pr 42 --base develop  # Custom base branch
```

**PR body includes:**
- Summary from GSD execution artifacts
- Milestone context (milestone name, phase, position in sequence)
- File-level changes grouped by module
- Testing procedures from verification artifacts
- Cross-references from `.mgw/cross-refs.json`

---

### `/mgw:link <ref> <ref>`

Create a bidirectional cross-reference between issues, PRs, and branches.

**Usage:**
```
/mgw:link 42 #43              # Issue-to-issue
/mgw:link 42 branch:fix/auth  # Issue-to-branch
```

Posts GitHub comments on both referenced issues (unless `--quiet`). Records the link in `.mgw/cross-refs.json`.

**CLI equivalent:**
```bash
mgw link 42 43
mgw link 42 43 --quiet    # Skip GitHub comments
mgw link 42 43 --dry-run  # Preview without creating
mgw link 42 43 --json     # JSON output
```

---

## Maintenance Commands

### `/mgw:sync`

Reconcile local `.mgw/` state with GitHub reality.

**Usage:**
```
/mgw:sync
mgw sync                # CLI equivalent
mgw sync --dry-run      # Preview what would change
mgw sync --json         # JSON output
```

**What it does:**
- Compares local issue state with GitHub issue state
- Archives completed issues (moves from `active/` to `completed/`)
- Flags stale branches and drift

---

### `/mgw:help`

Display the command reference. No side effects, works without Claude.

**Usage:**
```
/mgw:help
mgw help     # CLI equivalent
```

---

## Global CLI Flags

Every CLI subcommand supports these flags:

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would happen without executing |
| `--json` | Output structured JSON instead of formatted text |
| `-v, --verbose` | Show API calls and file writes |
| `--debug` | Full payloads, timings, and internal state |
| `--model <model>` | Override the Claude model for AI-dependent commands |

---

## Next Steps

- [[Workflow Guide]] -- End-to-end walkthroughs
- [[Architecture]] -- How the pipeline works internally
- [[Configuration]] -- Customize state, templates, and environment
