# MGW — My GSD Workflow

> Issue in. PR out. No excuses.

**GitHub-native issue-to-PR automation for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), powered by [Get Shit Done](https://github.com/glittercowboy/get-shit-done).**

MGW bridges GitHub Issues and the GSD planning framework into a single pipeline. Point it at an issue, and it triages, plans, executes, and opens a PR — posting structured status updates along the way. No context switching, no tab juggling, no copy-pasting between GitHub and your terminal.

```
/mgw:run 42
```

That's it. One command takes an issue from open to PR-ready.

---

## What It Does

MGW is a suite of [Claude Code slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands) that automate the lifecycle of a GitHub issue:

```
  Issue opened
       |
  /mgw:issue 42         Triage: scope, validity, security, conflicts
       |
  /mgw:run 42           Plan → Execute → Verify → PR (autonomous)
       |
  PR created + status comments posted
       |
  Merge → issue auto-closes
```

Each step is composable. Use the full pipeline or pick individual commands.

## Why I Built This

I'm a solo developer. On any given day I might be writing a game server, reverse-engineering a VM, building a mobile app, or reorganizing my entire dotfiles setup for the third time this week. My brain has one mode: *build*. The part where you go back and update the issue, post a comment, open a PR with a nice description, cross-reference the other thing you broke — that part doesn't exist in my workflow. It's not that I don't care. It's that by the time the feature works, I've already mentally moved on to the next thing.

The result is a graveyard of GitHub issues that say "Fix auth" with zero follow-up, branches named things only I understand, and PRs that my past self apparently thought were self-documenting. They were not.

So I built MGW to be the responsible adult in the room. I point it at an issue, it does all the paperwork I was never going to do, and my GitHub history finally looks like a person who has their life together. It's the professional version of me that answers emails on time and keeps a clean desk — except it's nine Markdown files and Claude doing all the work.

## Commands

| Command | What it does |
|---------|-------------|
| `/mgw:init` | Bootstrap repo for MGW — creates .mgw/ state, GitHub templates, gitignore entries |
| `/mgw:issues` | Browse and filter your GitHub issues |
| `/mgw:issue <n>` | Deep triage — scope analysis, security review, GSD route recommendation |
| `/mgw:run <n>` | Full autonomous pipeline: triage through PR creation |
| `/mgw:update <n>` | Post structured status comments on issues |
| `/mgw:pr [n]` | Create PR from GSD artifacts with testing procedures |
| `/mgw:link <ref> <ref>` | Cross-reference issues, PRs, and branches |
| `/mgw:sync` | Reconcile local state with GitHub |
| `/mgw:help` | Command reference |

## How Triage Works

`/mgw:issue` spawns an analysis agent that reads your codebase and evaluates the issue across five dimensions:

- **Scope** — which files and systems are affected, estimated size
- **Validity** — can the issue be confirmed by reading the code?
- **Purpose** — who benefits, what's the impact of inaction?
- **Security** — does it touch auth, user data, external APIs?
- **Conflicts** — does it overlap with other in-progress work?

Based on scope, MGW recommends a GSD route:

| Issue Size | GSD Route | What Happens |
|-----------|-----------|--------------|
| Small (1-2 files) | `gsd:quick` | Single-pass plan + execute |
| Medium (3-8 files) | `gsd:quick --full` | Plan with verification loop |
| Large (9+ files) | `gsd:new-milestone` | Full milestone with phased execution |

## State Management

MGW tracks pipeline state in a local `.mgw/` directory (gitignored, per-developer):

```
.mgw/
  active/              In-progress issue pipelines
    42-fix-auth.json   Issue state: triage results, pipeline stage, artifacts
  completed/           Archived after PR merge
  cross-refs.json      Bidirectional issue/PR/branch links
  config.json          User preferences
```

Pipeline stages flow: `new` → `triaged` → `planning` → `executing` → `verifying` → `pr-created` → `done`

The `/mgw:sync` command reconciles local state with GitHub reality — archiving completed work, flagging stale branches, and catching drift.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) (CLI)
- [Get Shit Done](https://github.com/glittercowboy/get-shit-done) (GSD) installed in Claude Code
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated
- A GitHub repository with issues enabled

## Installation

### Quick Install (copy)

```bash
mkdir -p ~/.claude/commands/mgw/workflows
cp -r .claude/commands/mgw/* ~/.claude/commands/mgw/
```

### GNU Stow (recommended for dotfile managers)

The repo is structured as a stow package. From the **parent directory** of this repo:

```bash
# Clone
git clone https://github.com/snipcodeit/mgw.git

# Deploy (creates symlinks at ~/.claude/commands/mgw/)
stow -v -t ~ mgw
```

To update after pulling changes:

```bash
cd mgw && git pull && cd ..
stow -v -R -t ~ mgw
```

### Verify

```bash
ls ~/.claude/commands/mgw/
# help.md  init.md  issue.md  issues.md  link.md  pr.md  run.md  sync.md  update.md  workflows/
```

Then in Claude Code:

```
/mgw:help
```

## Typical Workflow

```bash
# 1. See what's assigned to you
/mgw:issues

# 2. Pick an issue and triage it
/mgw:issue 42

# 3. Run the full pipeline
/mgw:run 42
# → Creates branch, triages (if needed), plans via GSD, executes,
#   verifies, opens PR, posts status comments on the issue

# 4. Review the PR, merge when ready
```

Or go manual for more control:

```bash
/mgw:issue 42                          # Triage
/mgw:link 42 #43                       # Cross-reference related issue
/mgw:update 42 "blocked on #43"        # Post custom status
/mgw:pr 42 --base develop              # Create PR to specific base
/mgw:sync                              # Clean up stale state
```

## Project Structure

```
.claude/
  commands/
    mgw/
      help.md              Command reference display
      init.md               One-time repo bootstrap (state, templates, labels)
      issues.md            Issue browser with filters
      issue.md             Deep triage with agent analysis
      update.md            Structured GitHub comments
      link.md              Cross-referencing system
      pr.md                PR creation from GSD artifacts
      sync.md              State reconciliation
      run.md               Autonomous pipeline orchestrator
      workflows/
        state.md           Shared state schema and initialization
```

## Acknowledgments

MGW wouldn't exist without **[Get Shit Done](https://github.com/glittercowboy/get-shit-done)** by [Lex Christopherson](https://github.com/glittercowboy) — a structured project management framework for Claude Code that handles planning, execution, and verification. GSD does the heavy lifting; MGW just connects it to GitHub so the rest of the world can see what you actually accomplished.

Seriously, if you're using Claude Code for development, go install GSD. MGW is just the GitHub layer on top.

## Contributing

MGW is young and there's plenty of room to make it better:

- **Smarter triage heuristics** — better scope estimation, label-based routing
- **Multi-repo support** — monorepo and cross-repo issue tracking
- **GitHub Actions integration** — trigger MGW from CI events
- **Review cycle automation** — handle PR review comments → fix → re-request
- **Dashboard** — terminal UI for pipeline visualization
- **Webhook support** — react to issue assignments and label changes in real-time

The skill files are plain Markdown with a simple frontmatter + process structure — easy to read, easy to modify. If any of the above interests you, open an issue or submit a PR. I promise MGW will keep mine updated even if I won't.

## License

[MIT](LICENSE)
