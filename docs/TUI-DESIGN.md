# TUI Design: MGW Issues Browser

**Phase:** 27 — TUI Issue Browser with Fuzzy Search
**Milestone:** v4 — Interactive CLI & TUI
**Status:** Architecture Complete
**Date:** 2026-03-02

---

## Library Selection

### Decision: `blessed` (neo-blessed fork)

**Selected library:** `neo-blessed` (CommonJS-native terminal widget library)

### Evaluation Matrix

| Criterion | Ink | blessed/neo-blessed | inquirer v9+ | @inquirer/core |
|-----------|-----|---------------------|--------------|----------------|
| CJS compat | ❌ Requires JSX/Babel | ✅ Pure CJS | ⚠️ ESM-first in v9 | ⚠️ ESM-first |
| Fuzzy search | Plugin needed | Plugin needed | ✅ via prompt | ✅ Built-in |
| Split pane | ✅ (React layout) | ✅ Native boxes | ❌ No layout | ❌ No layout |
| TTY degrade | ❌ Crashes without TTY | ✅ Detect+skip | ✅ Detects non-TTY | ✅ Detects non-TTY |
| Maintained | ✅ Active | ✅ neo-blessed active | ✅ Active | ✅ Active |
| Bundle size | Large (React) | Medium (~300KB) | Small (~150KB) | Small (~80KB) |
| KB shortcuts | ✅ Full | ✅ Full | ⚠️ Limited | ⚠️ Limited |

### Rationale

1. **CommonJS compatibility is non-negotiable** for `lib/` — Ink and @inquirer/core are ESM-first and require a build step to use in CJS. MGW's lib files are `.cjs` without transpilation.
2. **Split-pane layout** is required for the detail preview pane. inquirer and @inquirer/core have no layout system — they render single prompts only.
3. **blessed/neo-blessed** is the only library that satisfies all hard requirements: CJS-native, split-pane support, full keyboard customization, and TTY detection.
4. The fuzzy search is implemented as a pure JavaScript module (`lib/tui/search.cjs`) that runs before rendering — no library dependency for search logic.

**Installation:** `npm install neo-blessed` (added as optional dependency to avoid hard failure in non-TTY installs)

---

## Component Architecture

### Component Tree

```
IssuesBrowser (root — lib/tui/index.cjs)
├── SearchBar       — fuzzy input, top strip
│   └── KeyboardHandler — routes '/' key to focus search
├── IssueList       — main scrollable panel (60% width)
│   ├── IssueRow × N — number, title (truncated), labels, age
│   └── SelectionCursor — highlighted current row
├── DetailPane      — right panel (40% width)
│   ├── IssueHeader — number, title, state, assignees
│   ├── BodyScroll  — scrollable markdown-ish body
│   └── MetaBar     — labels, milestone, URL
├── FilterBar       — bottom strip: label | milestone | assignee toggles
└── StatusBar       — "N issues  [/] search  [Enter] select  [q] quit"
```

### Layout (80-column terminal, 24-row)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ MGW ISSUES                                     [/] search  [q] quit  [?] help│
├─────────── Search: ___________________________┤                               │
├──────────────────────────────────┬────────────────────────────────────────────┤
│ # 117  Design TUI issue browser  │ #117 — Design TUI issue browser component  │
│ # 118  Implement fuzzy search    │                                             │
│ # 119  Add label filter pane     │ Labels: enhancement, cli, ui/ux             │
│ # 120  Add per-stage spinners    │ Assignee: snipcodeit                        │
│ # 121  Add milestone progress    │ Milestone: v4 — Interactive CLI & TUI       │
│ # 122  Add --watch flag          │                                             │
│ # 123  Generate completions      │ ## Description                              │
│ # 124  Completion install step   │ Design the interactive TUI layout: list     │
│ # 125  Config wizard             │ with fuzzy search, detail preview pane,     │
│                                  │ keyboard shortcuts. Choose rendering         │
│                                  │ library (Ink or blessed). Produce           │
│                                  │ wireframe and component spec.               │
│                                  │                                             │
│                                  │ https://github.com/snipcodeit/mgw/117       │
├──────────────────────────────────┴────────────────────────────────────────────┤
│ Filter: [All labels ▾] [All milestones ▾] [Assignee: @me ▾]   9 issues        │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Interface Contracts

### `createIssuesBrowser(options)` — `lib/tui/index.cjs`

```typescript
interface IssuesBrowserOptions {
  issues: GitHubIssue[];       // Pre-fetched issue objects
  onSelect: (issue: GitHubIssue) => void;  // Called on Enter
  onQuit: () => void;          // Called on q/Escape
  initialQuery?: string;       // Pre-populate search (default: '')
  initialFilter?: {
    label?: string;
    milestone?: string;
    assignee?: string;
  };
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  createdAt: string;        // ISO 8601
  comments: number | Array;
  state: 'OPEN' | 'CLOSED';
  milestone?: { title: string };
}

// Returns Promise<void> — resolves when user selects or quits
function createIssuesBrowser(options: IssuesBrowserOptions): Promise<void>;
```

### `FuzzySearch` — `lib/tui/search.cjs`

```typescript
class FuzzySearch {
  constructor(items: object[], options?: { keys?: string[] });
  search(query: string): object[];  // Returns filtered+scored items
}
```

### `KeyboardHandler` — `lib/tui/keyboard.cjs`

```typescript
class KeyboardHandler extends EventEmitter {
  constructor(bindings?: Record<string, string>);
  dispatch(key: string): void;  // Emits action event for matching key
}

// Events emitted: 'scroll-down', 'scroll-up', 'search-focus',
//                 'select', 'quit', 'tab-focus', 'help'
```

### `createRenderer()` — `lib/tui/renderer.cjs`

```typescript
interface Renderer {
  render(state: BrowserState): void | Promise<void>;
  destroy(): void | Promise<void>;
}

interface BrowserState {
  filtered: GitHubIssue[];
  selectedIndex: number;
  query: string;
  focusPane: 'list' | 'detail' | 'filter';
}

function createRenderer(): Renderer;
```

---

## Keyboard Map

| Key | Action | Context |
|-----|--------|---------|
| `j` / `↓` | Scroll list down | Always |
| `k` / `↑` | Scroll list up | Always |
| `/` | Focus search input | Always |
| `Enter` | Select current issue | List focused |
| `q` / `Escape` | Quit / clear search | Always |
| `Tab` | Cycle focus: list → detail → filter | Always |
| `Shift+Tab` | Reverse cycle focus | Always |
| `?` | Toggle help overlay | Always |
| `g` / `Home` | Jump to top of list | List focused |
| `G` / `End` | Jump to bottom of list | List focused |
| `PgUp` | Scroll up 10 items | List focused |
| `PgDn` | Scroll down 10 items | List focused |
| `Ctrl+C` | Force quit (no cleanup) | Always |

---

## Module Structure

```
lib/tui/
  index.cjs      — createIssuesBrowser(options): Promise<void>
                   Orchestrates state, search, renderer, keyboard
  search.cjs     — FuzzySearch class (pure, no UI dependency)
  keyboard.cjs   — KeyboardHandler (EventEmitter, configurable bindings)
  renderer.cjs   — createRenderer(): Renderer (library adapter, swappable)
  graceful.cjs   — isInteractive(): bool, renderStaticTable(issues): void
```

---

## CLI Integration

`mgw issues` (via `bin/mgw.cjs`):

```
mgw issues [options]

Options:
  -l, --label <label>        Filter by label
  -m, --milestone <name>     Filter by milestone
  -a, --assignee <user>      Filter by assignee (default: @me, use 'all' for no filter)
  -s, --search <query>       Pre-populate search input
  --state <state>            Issue state: open|closed|all (default: open)
  --limit <n>                Max issues to fetch (default: 50)
  -h, --help                 Show help
```

**Behavior:**
- Interactive TTY → launches `IssuesBrowser` TUI
- Non-interactive (pipe/CI) → calls `renderStaticTable()` — pipe-friendly
- On issue selection: prints `#N — Title` + `Run: mgw issue N` then exits
- On quit: exits cleanly (exit code 0)

---

## Integration with mgw:issues Slash Command

The slash command (`commands/issues.md`) is the Claude Code-session variant of `mgw issues`. It uses `AskUserQuestion` for selection because Claude's context doesn't have a real TTY.

The TUI component is CLI-only (`bin/mgw.cjs`). The slash command continues to use the table + `AskUserQuestion` pattern. Both paths converge at `mgw issue <number>` / `/mgw:issue <number>` for triage.

---

## Non-Goals (This Phase)

- Full blessed rendering (deferred to issue #118)
- Live refresh / `--watch` mode (issue #122)
- Filter pane implementation (issue #119)
- Shell completions (issue #123)
- Actual blessed/neo-blessed installation in package.json (approval gate)

---

## Future: Renderer Swap

The `renderer.cjs` adapter pattern allows swapping the TUI library without changing any other module. To switch from blessed to a different library:
1. Implement `createRenderer()` in `renderer.cjs` using the new library
2. No other files change

This was a deliberate design decision to isolate library coupling.
