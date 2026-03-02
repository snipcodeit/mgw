---
name: mgw:issues
description: List and filter GitHub issues, pick one to triage
argument-hint: "[--label &lt;label&gt;] [--milestone &lt;name&gt;] [--assignee &lt;user&gt;] [--state open|closed|all] [--search &lt;query&gt;]"
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

<objective>
Browse GitHub issues for the current repo. Presents a scannable table filtered by
assignment (defaults to @me), labels, milestone, or state. Pick an issue to route
into triage via /mgw:issue.

This is the Claude Code slash-command variant (table + AskUserQuestion). When running
from the CLI (`mgw issues`), an interactive TUI browser launches instead — see
`docs/TUI-DESIGN.md` and `lib/tui/index.cjs` for the TUI implementation.

No side effects — read-only GitHub access. Safe to run anytime.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/github.md
</execution_context>

<context>
$ARGUMENTS

Repo detected via: gh repo view --json nameWithOwner -q .nameWithOwner
</context>

<process>

<step name="parse_filters">
**Parse arguments into gh filters:**

Defaults if no arguments:
- `--assignee @me`
- `--state open`
- `--limit 25`

Override with explicit flags from $ARGUMENTS:
- `--label <label>` → `gh --label`
- `--milestone <name>` → `gh --milestone`
- `--assignee <user>` → `gh --assignee` (use "all" to skip filter)
- `--state <state>` → `gh --state`
</step>

<step name="fetch_issues">
**Fetch issues from GitHub:**

```bash
gh issue list --assignee @me --state open --limit 25 --json number,title,labels,createdAt,comments,assignees
```

Adjust flags based on parsed filters.

If result is empty:
```
No issues found matching filters.
Try: /mgw:issues --assignee all --state open
```
</step>

<step name="display_table">
**Present issues as a scannable table:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► ISSUES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| #  | Title                      | Labels       | Age  | Comments |
|----|----------------------------|--------------|------|----------|
| 42 | Fix auth bug in login flow | bug, auth    | 3d   | 2        |
| 38 | Add caching layer          | enhancement  | 1w   | 5        |
| ...                                                              |

Enter issue number to triage, or 'q' to quit.
```

Calculate age as human-readable relative time from createdAt.
Truncate title to 30 chars if needed.
Format labels as comma-separated.
</step>

<step name="pick_issue">
**User selects an issue:**

```
AskUserQuestion(
  header: "Select Issue",
  question: "Which issue number do you want to triage?",
  followUp: "Enter a number from the table above, or 'q' to quit"
)
```

If valid number → suggest: "Run /mgw:issue <number> to triage this issue."
If 'q' → exit cleanly.
If invalid → re-prompt.
</step>

</process>

<success_criteria>
- [ ] Issues fetched from current repo via gh CLI
- [ ] Filters applied correctly (defaults to @me + open)
- [ ] Table displayed with number, title, labels, age, comments
- [ ] User can pick an issue number
- [ ] Routes to /mgw:issue <number>
</success_criteria>

## TUI Mode (CLI only)

When `mgw issues` runs from the CLI entry point (`bin/mgw.cjs`) in an interactive
terminal, it launches a full TUI browser instead of a static table.

**Entry point:** `lib/tui/index.cjs` — `createIssuesBrowser(options)`

**CLI options:**
```
mgw issues [options]
  -l, --label <label>        Filter by label
  -m, --milestone <name>     Filter by milestone
  -a, --assignee <user>      Assignee filter (default: @me, 'all' = no filter)
  -s, --search <query>       Pre-populate the fuzzy search input
  --state <state>            Issue state: open|closed|all (default: open)
  --limit <n>                Max issues to load (default: 50)
```

**TUI keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down |
| `k` / `↑` | Scroll up |
| `/` | Focus search input |
| `Enter` | Select issue → prints `#N — Title` and exits |
| `q` / `Esc` | Quit |
| `Tab` | Cycle focus (list → detail → filter) |
| `g` / `Home` | Jump to top |
| `G` / `End` | Jump to bottom |
| `?` | Toggle keyboard help |

**Non-interactive fallback:**
When stdout is not a TTY (piped, CI, `MGW_NO_TUI=1`), the static table is printed
to stdout. Pipe-friendly — no ANSI codes, no interactive elements.

```bash
mgw issues | grep "auth"
```

**Implementation modules:**
```
lib/tui/
  index.cjs      — createIssuesBrowser(options) — entry point
  search.cjs     — FuzzySearch class — pure, no UI dependency
  keyboard.cjs   — KeyboardHandler (EventEmitter)
  renderer.cjs   — createRenderer() — blessed/neo-blessed adapter
  graceful.cjs   — isInteractive(), renderStaticTable()
```

**Design document:** `docs/TUI-DESIGN.md` — library selection rationale, wireframe, full interface contracts.

**Rendering library:** `neo-blessed` (optional dependency). Renderer is swappable via `lib/tui/renderer.cjs`.

**Slash command vs CLI:**
This slash command (`/mgw:issues`) uses the static table + `AskUserQuestion` pattern
because Claude Code sessions don't have raw TTY access. The TUI is CLI-only (`mgw issues`).
Both paths route to `/mgw:issue <number>` for triage.
