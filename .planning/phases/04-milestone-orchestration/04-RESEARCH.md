# Phase 4: Milestone Orchestration - Research

**Researched:** 2026-02-25
**Domain:** Orchestration layer — dependency-ordered milestone execution and next-issue surfacing
**Confidence:** HIGH

## Summary

Phase 4 builds two slash commands (`/mgw:milestone` and `/mgw:next`) that sit on top of the existing per-issue pipeline (`/mgw:run`) and coordinate execution across an entire milestone's issue backlog. The core challenge is not technical complexity but careful state management: reading dependency graphs from `project.json` and GitHub labels, determining execution order via topological sort, checkpointing after each issue completes, and resuming cleanly after interruption.

The project already has all the building blocks: `project.json` stores issue metadata with `depends_on_slugs` and `pipeline_stage` fields, `cross-refs.json` tracks issue-to-issue relationships, `state.md` defines staleness detection patterns, `github.md` documents all `gh` CLI patterns for milestone and issue operations, and `/mgw:run` handles the full per-issue pipeline. Phase 4 is a thin orchestration layer that sequences calls to `/mgw:run` and manages milestone-level state.

**Primary recommendation:** Build `/mgw:milestone` as a sequential loop over topologically-sorted issues, delegating each to `/mgw:run` via Task() spawn, with pre-loop sync and rate-limit check, per-issue checkpoint writes to `project.json`, and post-completion milestone close + release creation. Build `/mgw:next` as a read-only command that computes the same dependency graph and returns the first unblocked issue.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Sequential execution of issues, even when multiple are unblocked (phase order, not parallel)
- Autonomous by default — runs all issues back-to-back without pausing. `--interactive` flag pauses between issues for user confirmation
- Smart start: reads project.json + GitHub state, skips completed issues, starts from first unfinished unblocked issue
- Auto-detect resume — no separate "start" vs "resume" subcommand. `/mgw:milestone` always checks for in-progress state
- Current milestone by default from project.json, optional argument to target a specific milestone number
- Auto-advance to next milestone after completion, but block if any issues failed/were skipped in the current milestone
- `--dry-run` flag shows execution plan (dependency graph, issue order, estimated scope) without running anything
- Pre-sync via `/mgw:sync` before starting (MLST-03). Skip rate limit estimation (MLST-04 simplified)
- Auto-close GitHub milestone on completion and advance `current_milestone` pointer in project.json
- When an issue's `/mgw:run` pipeline fails: skip it, mark dependents as blocked, continue with remaining unblocked issues
- Failed issues get both a `pipeline-failed` label AND a detailed comment
- Failure comments include the full milestone progress table (collapsed) showing all issues and their statuses
- Every GitHub comment posted by milestone orchestration includes a collapsed milestone progress table — serves as a status snapshot
- GitHub is the source of truth for MGW-level orchestration; GSD is the source of truth for individual issue execution within a milestone
- Dual-source resume: check GSD artifacts for in-progress phase state, cross-reference with GitHub milestone issues
- If an issue was mid-pipeline (partial worktree/commits), restart that issue from scratch — clean up partial state and re-run `/mgw:run`
- If no resumable state found (no GSD artifacts, no in-progress GitHub issues), treat as fresh — assume project needs planning or is brand new
- Per-issue checkpoint: update project.json pipeline_stage after each issue completes (MLST-05)
- GitHub-first progress: all detailed progress lives in GitHub issue comments, not terminal
- Terminal output is minimal during run: "Running issue #N..." and "Done." or "Failed."
- Every comment on every issue includes the current issue status prominently, with a collapsed `<details>` block containing the full milestone progress table (all issues, status, PR links, agent/stage info)
- Final output (milestone complete): full result table printed in terminal AND posted to GitHub
- On milestone completion: create a draft GitHub Release with auto-generated summary (milestone name, issues completed, PRs merged, failures, stats)
- Release tag format: milestone-based (e.g., `milestone-1-complete`)
- /mgw:next returns single recommended next issue (dependency order, then phase order) plus brief list of other unblocked alternatives
- Full brief for the recommended issue: number, title, GSD route, description, labels, dependencies (what it depends on — all done), what it unblocks, milestone context
- Local-first with live verification: read project.json for fast answer, quick `gh` API check to verify issue is still open and unblocked
- Offers to run: after displaying the brief, asks "Run /mgw:run #N now?" — one confirmation to start
- When nothing unblocked: shows what's blocking and by what — "No unblocked issues. #44 blocked by #42 (in progress), #45 blocked by #43 (failed). Resolve #43 to unblock #45."

### Claude's Discretion
- Terminal banner formatting and styling
- Exact tag naming convention for milestone releases
- GitHub comment markdown formatting details
- How to calculate "estimated scope" for --dry-run
- Whether to include timing/duration info in progress tables

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MLST-01 | User can run `/mgw:milestone` to execute a milestone's issues in dependency order, delegating each to `/mgw:run` | Topological sort of dependency graph from project.json, sequential Task() spawns following gsd.md patterns |
| MLST-02 | `/mgw:next` surfaces the next unblocked issue across the project based on dependency declarations | Same dependency graph algorithm, read-only evaluation, first-unblocked selection |
| MLST-03 | Milestone orchestration runs `/mgw:sync` automatically before starting to prevent stale-state operations | Pre-loop sync call using existing sync.md patterns, non-blocking staleness check |
| MLST-04 | Rate limit check runs before milestone orchestration starts, with session-level API call caching | `gh api rate_limit` check before loop, estimate calls-per-issue, stop if insufficient |
| MLST-05 | Per-issue completion state persists to `project.json` after each issue completes (restart checkpoint) | Write `pipeline_stage` update to project.json after each `/mgw:run` return |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `gh` CLI | installed | All GitHub API operations (issues, milestones, labels, releases) | Already used throughout MGW; patterns in github.md |
| `python3` | installed | JSON manipulation, data transformation | Already used throughout MGW for inline JSON processing |
| `gsd-tools.cjs` | local | Slug generation, timestamps, model resolution, commit | Already the utility layer for all MGW commands |
| Task() subagents | N/A | Per-issue pipeline delegation via `/mgw:run` pattern | Delegation boundary rule — MGW orchestrates, never codes |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `jq` / `python3 -c` | installed | JSON field extraction from gh CLI output | When parsing gh API responses inline |
| `AskUserQuestion` | built-in | Interactive mode pauses, confirmations | `--interactive` flag, post-milestone next-milestone prompt |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Sequential bash loop | Parallel Task() spawns | User explicitly chose sequential; parallel adds complexity without benefit for single-developer workflow |
| Custom dependency resolver | External graph library | Unnecessary — issue count per milestone is small (5-15), simple Kahn's algorithm in bash/python3 inline is sufficient |
| Persistent rate limit cache | Per-invocation check | User simplified MLST-04 — single pre-loop check is sufficient |

## Architecture Patterns

### Recommended Command Structure
```
.claude/commands/mgw/
├── milestone.md          # /mgw:milestone — the orchestration loop
├── next.md               # /mgw:next — read-only next-issue surfacing
├── workflows/
│   └── github.md         # Extended with: close milestone, create release, rate limit check
│   └── state.md          # Extended with: project.json read/write helpers
└── help.md               # Updated with new commands
```

### Pattern 1: Dependency Graph Resolution (Topological Sort)
**What:** Compute execution order from `depends_on_slugs` in project.json
**When to use:** Both `/mgw:milestone` (to determine loop order) and `/mgw:next` (to find first unblocked)
**Example:**
```python
# Inline python3 — Kahn's algorithm for topological sort
import json, sys
from collections import defaultdict, deque

project = json.load(open('.mgw/project.json'))
milestone_idx = project['current_milestone'] - 1
issues = project['milestones'][milestone_idx]['issues']

# Build slug-to-issue and adjacency
slug_to_issue = {}
for issue in issues:
    slug = issue['title'].lower().replace(' ', '-')[:40]
    slug_to_issue[slug] = issue

# Build in-degree map
in_degree = defaultdict(int)
graph = defaultdict(list)
all_slugs = set()

for issue in issues:
    slug = issue['title'].lower().replace(' ', '-')[:40]
    all_slugs.add(slug)
    for dep_slug in issue.get('depends_on_slugs', []):
        graph[dep_slug].append(slug)
        in_degree[slug] += 1

# Kahn's algorithm
queue = deque(s for s in all_slugs if in_degree[s] == 0)
order = []
while queue:
    # Stable sort: prefer lower phase_number when multiple are unblocked
    current = min(queue, key=lambda s: slug_to_issue[s]['phase_number'])
    queue.remove(current)
    order.append(current)
    for neighbor in graph[current]:
        in_degree[neighbor] -= 1
        if in_degree[neighbor] == 0:
            queue.append(neighbor)

# order now contains issues in dependency-respecting, phase-ordered sequence
print(json.dumps([slug_to_issue[s] for s in order], indent=2))
```

### Pattern 2: Pre-Loop Sync + Rate Limit Guard
**What:** Run `/mgw:sync` equivalent and check API rate limit before starting the loop
**When to use:** At the start of every `/mgw:milestone` invocation
**Example:**
```bash
# Step 1: Sync (reuse sync.md patterns)
# Non-blocking — log warnings but don't halt

# Step 2: Rate limit check
RATE_JSON=$(gh api rate_limit --jq '.resources.core')
REMAINING=$(echo "$RATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['remaining'])")
RESET=$(echo "$RATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['reset'])")

# Estimate: each /mgw:run uses ~15-25 API calls (triage + comments + PR creation)
# Conservative: 25 calls per issue
ISSUE_COUNT=$UNFINISHED_ISSUES
ESTIMATED_CALLS=$((ISSUE_COUNT * 25))

if [ "$REMAINING" -lt "$ESTIMATED_CALLS" ]; then
  SAFE_ISSUES=$((REMAINING / 25))
  echo "Rate limit: ${REMAINING} calls remaining, need ~${ESTIMATED_CALLS}."
  echo "Can safely run ${SAFE_ISSUES} of ${ISSUE_COUNT} issues before limit."
  echo "Limit resets at $(date -d @${RESET})."
  # Proceed with SAFE_ISSUES cap, not total abort
fi
```

### Pattern 3: Per-Issue Checkpoint Write
**What:** Update `project.json` after each issue completes (or fails)
**When to use:** In the main loop body, after each `/mgw:run` Task() returns
**Example:**
```bash
# After /mgw:run for issue #N returns:
python3 -c "
import json
with open('.mgw/project.json') as f:
    project = json.load(f)

milestone = project['milestones'][project['current_milestone'] - 1]
for issue in milestone['issues']:
    if issue['github_number'] == ${ISSUE_NUMBER}:
        issue['pipeline_stage'] = '${STATUS}'  # 'done' or 'failed'
        break

with open('.mgw/project.json', 'w') as f:
    json.dump(project, f, indent=2)
"
```

### Pattern 4: Milestone Progress Table (GitHub Comment)
**What:** Collapsed table of all issues and their statuses, included in every comment
**When to use:** Every GitHub comment posted during milestone orchestration
**Example:**
```markdown
**Issue #42 — Complete** ✓

PR: #55 | Branch: `issue/42-fix-auth`

<details>
<summary>Milestone Progress (3/5 complete)</summary>

| # | Issue | Status | PR | Stage |
|---|-------|--------|----|-------|
| 40 | Setup auth module | ✓ Done | #50 | done |
| 41 | Add login flow | ✓ Done | #52 | done |
| 42 | Fix token refresh | ✓ Done | #55 | done |
| 43 | Add session mgmt | ○ Pending | — | new |
| 44 | E2E auth tests | ○ Blocked | — | blocked-by:#43 |

</details>
```

### Pattern 5: Resume Detection
**What:** On `/mgw:milestone` invocation, detect whether to start fresh or resume
**When to use:** At the beginning of milestone command, before the loop
**Example:**
```bash
# Check project.json for any issue with pipeline_stage != 'new' and != 'done'
IN_PROGRESS=$(python3 -c "
import json
with open('.mgw/project.json') as f:
    p = json.load(f)
m = p['milestones'][p['current_milestone'] - 1]
in_prog = [i for i in m['issues'] if i['pipeline_stage'] not in ('new', 'done', 'failed')]
print(len(in_prog))
")

if [ "$IN_PROGRESS" -gt 0 ]; then
  echo "Resuming milestone — found in-progress issues"
  # Clean up partial state for in-progress issues (restart from scratch)
  # Then continue loop from first unfinished unblocked issue
fi
```

### Anti-Patterns to Avoid
- **Parallel issue execution:** User explicitly chose sequential. Even if multiple issues are unblocked, execute them in phase order.
- **Separate start/resume subcommands:** `/mgw:milestone` always auto-detects whether to start fresh or resume.
- **Inline code analysis in milestone command:** Delegate everything to `/mgw:run` via Task(). Milestone only manages the loop and state.
- **Blocking on rate limit check failure:** If `gh api rate_limit` fails (network error), log warning and proceed — never block on non-critical checks.
- **Re-executing completed issues:** Always skip issues with `pipeline_stage == 'done'` — this is the core resume mechanism.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Dependency ordering | Custom graph traversal | Kahn's algorithm (5-15 nodes, inline python3) | Well-understood O(V+E) algorithm, issues per milestone is tiny |
| Per-issue pipeline | Inline execution logic | `/mgw:run` via Task() spawn | Delegation boundary: run.md already handles the full pipeline |
| Staleness detection | Custom GitHub polling | `workflows/state.md` batch staleness check | Already built and tested in Phase 1 |
| Slug generation | Manual string processing | `gsd-tools.cjs generate-slug` | Consistent with all other MGW commands |
| Timestamp generation | `date` command | `gsd-tools.cjs current-timestamp` | ISO format consistency |
| GitHub API calls | Raw curl/API patterns | `gh` CLI patterns from `workflows/github.md` | Centralized, tested patterns |

**Key insight:** Phase 4 creates NO new infrastructure. It composes existing patterns (state.md, github.md, gsd.md, run.md) into two new commands. The dependency graph is the only "algorithm" — everything else is plumbing.

## Common Pitfalls

### Pitfall 1: Circular Dependencies in Issue Graph
**What goes wrong:** If `depends_on_slugs` contain cycles, topological sort never completes
**Why it happens:** User or template error during `/mgw:project` init
**How to avoid:** Detect cycles before starting the loop (Kahn's algorithm naturally detects this — if output length < input length, there's a cycle). Report the cycle and refuse to proceed.
**Warning signs:** Topological sort produces fewer items than input issues

### Pitfall 2: Stale project.json After Manual GitHub Changes
**What goes wrong:** User closes/reopens issues on GitHub directly, project.json doesn't reflect reality
**Why it happens:** GitHub is truth for MGW-level state, but project.json is used for fast reads
**How to avoid:** Pre-sync (MLST-03) reconciles before loop. Also verify each issue is still open via `gh issue view` before running `/mgw:run` on it.
**Warning signs:** `/mgw:run` fails because issue is already closed

### Pitfall 3: Rate Limit Exhaustion Mid-Loop
**What goes wrong:** Milestone loop exhausts API rate limit partway through, causing `gh` CLI failures
**Why it happens:** Each `/mgw:run` makes ~15-25 API calls; a 10-issue milestone could use 250 calls
**How to avoid:** Pre-loop rate limit check (MLST-04). Re-check remaining calls after each issue. Stop gracefully when approaching limit.
**Warning signs:** `gh` commands returning 403 or rate limit error responses

### Pitfall 4: Partial Worktree State on Resume
**What goes wrong:** Previous session was interrupted mid-`/mgw:run`, leaving a half-finished worktree
**Why it happens:** `/mgw:run` creates worktrees; if interrupted, worktree exists but work is incomplete
**How to avoid:** On resume, detect partial worktrees for in-progress issues, clean them up (`git worktree remove`), and restart the issue from scratch via `/mgw:run`.
**Warning signs:** `git worktree list` shows worktrees for issues that aren't "done"

### Pitfall 5: Slug Mismatch Between project.json and GitHub Labels
**What goes wrong:** `depends_on_slugs` don't match actual slugs used during `/mgw:project` issue creation
**Why it happens:** Slug generation is done by `gsd-tools.cjs generate-slug` which may produce different results depending on input normalization
**How to avoid:** Use the same slug generation function when resolving dependencies. Also resolve via `github_number` (which is authoritative) rather than slugs when possible.
**Warning signs:** Dependency resolution fails to find blocking issues

## Code Examples

### Milestone Command Execution Flow
```bash
# 1. Parse arguments
MILESTONE_NUM=${1:-$(python3 -c "import json; print(json.load(open('.mgw/project.json'))['current_milestone'])")}
FLAGS="$2"  # --interactive, --dry-run

# 2. Pre-sync (MLST-03)
# Run sync logic inline (batch staleness check from state.md)

# 3. Rate limit guard (MLST-04)
RATE_REMAINING=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo "5000")

# 4. Load and sort issues
SORTED_ISSUES=$(python3 -c "
import json
from collections import defaultdict, deque

p = json.load(open('.mgw/project.json'))
m = p['milestones'][${MILESTONE_NUM} - 1]
issues = m['issues']

# ... topological sort (Kahn's) ...
# Filter: skip pipeline_stage == 'done'
# Output: ordered list of github_numbers
")

# 5. Main loop
for ISSUE_NUMBER in $SORTED_ISSUES; do
  echo "Running issue #${ISSUE_NUMBER}..."

  # Check if blocked by a failed issue
  # Check rate limit still OK
  # Spawn /mgw:run via Task()
  # On success: update project.json pipeline_stage = "done"
  # On failure: update pipeline_stage = "failed", add label, post comment, mark dependents blocked

  echo "Done." # or "Failed."
done

# 6. Post-loop: close milestone, create release, advance pointer
```

### /mgw:next Read-Only Flow
```bash
# 1. Load project.json
# 2. Run dependency resolution
# 3. Find first issue where:
#    - pipeline_stage == 'new' (not done, not failed, not in-progress)
#    - All depends_on issues have pipeline_stage == 'done'
# 4. Quick gh API verify (still open?)
# 5. Display brief
# 6. Offer to run
```

### GitHub Milestone Close + Release
```bash
# Close milestone
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/${REPO}/milestones/${MILESTONE_NUMBER}" --method PATCH \
  -f state="closed"

# Create draft release
RELEASE_TAG="milestone-${MILESTONE_NUM}-complete"
RELEASE_BODY="## Milestone ${MILESTONE_NUM}: ${MILESTONE_NAME}\n\n..."
gh release create "$RELEASE_TAG" --draft --title "Milestone ${MILESTONE_NUM}: ${MILESTONE_NAME}" --notes "$RELEASE_BODY"
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual issue sequencing | Dependency-ordered automation | This phase | Developer never manually tracks what's blocked |
| Separate start/resume commands | Auto-detect resume | This phase | Single entry point, no cognitive overhead |
| No project-level orchestration | `/mgw:milestone` + `/mgw:next` | This phase | Full project lifecycle from Day 1 to Go Live |

**Deprecated/outdated:**
- None — this is new functionality built on existing patterns

## Open Questions

1. **GitHub Release body format for milestone completion**
   - What we know: User wants draft release with auto-generated summary
   - What's unclear: Exact markdown structure for the release body
   - Recommendation: Use a template similar to the milestone progress table — list issues completed, PRs merged, failures, stats. Claude's discretion per CONTEXT.md.

2. **Rate limit re-check frequency during loop**
   - What we know: Pre-loop check is required (MLST-04). User simplified to skip estimation.
   - What's unclear: Should we re-check after each issue or just pre-loop?
   - Recommendation: Re-check after each issue (one extra API call) — cheap insurance against mid-loop exhaustion. If remaining < 25, stop gracefully.

3. **Cross-milestone dependency resolution**
   - What we know: User said auto-advance to next milestone after completion
   - What's unclear: Can issues in milestone 2 depend on issues in milestone 1?
   - Recommendation: For v1, assume no cross-milestone dependencies. Each milestone is self-contained. Cross-milestone deps are v2 (MLST-06).

## Sources

### Primary (HIGH confidence)
- Project codebase: `.claude/commands/mgw/` — all existing command patterns
- `workflows/github.md` — GitHub CLI patterns for milestones, issues, labels, releases
- `workflows/state.md` — State management, project.json schema, staleness detection
- `workflows/gsd.md` — Task() spawn templates, model resolution, utility patterns
- `run.md` — Per-issue pipeline that `/mgw:milestone` delegates to
- `project.md` — Project initialization that creates `project.json` structure
- `.planning/phases/04-milestone-orchestration/04-CONTEXT.md` — User decisions

### Secondary (MEDIUM confidence)
- GitHub API documentation for milestone close and release creation (standard REST API)
- Kahn's algorithm for topological sort (well-established CS algorithm)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all tools already exist in the project; no new dependencies
- Architecture: HIGH — composition of existing patterns; user decisions fully constrain the design
- Pitfalls: HIGH — derived from analysis of existing codebase state management patterns

**Research date:** 2026-02-25
**Valid until:** Indefinite — this is project-internal orchestration, not dependent on external library versions
