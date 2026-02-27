<purpose>
Delegation boundary rule for MGW commands. Provides a mechanical check and review
checklist to enforce that MGW orchestrates but never codes. Any developer reviewing
or writing an MGW command can apply this rule to get a clear yes/no answer.
</purpose>

## The Delegation Boundary Rule

**MGW orchestrates. MGW never codes.**

MGW's job is to connect GitHub issues to GSD's execution engine and manage the
pipeline state between them. MGW reads state, writes state, talks to GitHub, and
spawns agents. It never reads application code, writes application code, or makes
implementation decisions.

## Mechanical Check

For any logic in an MGW command, ask:

> "If GSD improved this tomorrow, would MGW automatically benefit?"

- **YES** -- Logic is correctly delegated. It lives in a Task() agent or in GSD itself, and MGW references the result.
- **NO** -- Logic is misplaced in MGW. It should be moved into a Task() agent that MGW spawns.

### Examples

| Logic | Answer | Reasoning |
|-------|--------|-----------|
| "Fetch issue from GitHub" | N/A | This is GitHub API, not GSD. MGW may do this directly. |
| "Analyze which files are affected" | YES | GSD's executor reads code. If GSD got better at analysis, MGW benefits because it spawns an analysis agent. |
| "Parse the issue body for triage" | NO (violation) | If MGW inlines body parsing, GSD improvements don't help. Spawn a triage agent instead. |
| "Spawn a planner agent" | YES | The planner is a GSD agent. Improvements flow through. |
| "Write .mgw/active/42-fix.json" | N/A | State management is MGW's domain, not GSD's. |

## What MGW May Do Directly (Allowlist)

These operations are within MGW's boundary:

```
- Read/write .mgw/ state files (JSON)
- Read/write GitHub metadata (via gh CLI — patterns in workflows/github.md)
- Parse command arguments ($ARGUMENTS)
- Display user-facing output (banners, tables, prompts, reports)
- Spawn Task() agents (via templates in workflows/gsd.md)
- Call gsd-tools.cjs for utilities (slugs, timestamps, model resolution)
- Initialize state (via validate_and_load in workflows/state.md)
- Manage worktrees (git worktree add/remove)
- Check/set git branches (git checkout, git push)
```

## What MGW Must NEVER Do Directly (Denylist)

These operations cross the delegation boundary:

```
- Read application source code (even for "quick" scope analysis)
- Write application source code
- Make architecture or implementation decisions
- Analyze code for scope, security, or conflicts
- Generate PR descriptions from code analysis (not from GSD artifacts)
- Choose libraries or implementation patterns
- Run application tests or interpret test results
- Any operation that requires understanding the project's implementation
```

**If you find yourself needing to do something on the denylist:** Spawn an agent for it.

## Review Checklist

For each block of logic in an MGW command, check:

- [ ] Does it read/write .mgw/ state? -- **ALLOWED**
- [ ] Does it call gh CLI? -- **ALLOWED** (should match a pattern in workflows/github.md)
- [ ] Does it spawn a Task()? -- **ALLOWED** (must match template in workflows/gsd.md, must include CLAUDE.md injection)
- [ ] Does it call gsd-tools.cjs? -- **ALLOWED**
- [ ] Does it display output to the user? -- **ALLOWED**
- [ ] Does it manage git worktrees/branches? -- **ALLOWED**
- [ ] Does it parse $ARGUMENTS? -- **ALLOWED**
- [ ] Does it read application code? -- **VIOLATION** — spawn an analysis agent
- [ ] Does it write application code? -- **VIOLATION** — spawn an executor agent
- [ ] Does it make implementation decisions? -- **VIOLATION** — spawn a planner agent
- [ ] Does it analyze code for scope/security? -- **VIOLATION** — spawn a triage agent
- [ ] Does it generate content from code analysis? -- **VIOLATION** — spawn a content agent

## Applying the Rule: Concrete Example

**Before (issue.md inline analysis — VIOLATION):**
```
# BAD: MGW reading code directly
Search the codebase for files related to "${issue_title}"
grep -r "auth" src/
# Then MGW decides: "3 files affected, medium scope"
```

**After (issue.md delegated analysis — CORRECT):**
```
# GOOD: MGW spawns an agent that reads code
Task(
  prompt="
    <files_to_read>
    - ./CLAUDE.md (Project instructions)
    - .agents/skills/ (Project skills)
    </files_to_read>

    Analyze GitHub issue #${ISSUE_NUMBER} against this codebase.
    Search for affected files and systems.
    Return: scope (files, systems, size), validity, security, conflicts.
  ",
  subagent_type="general-purpose",
  description="Triage issue #${ISSUE_NUMBER}"
)
```

The agent reads code and returns structured results. MGW reads the structured results,
writes them to .mgw/active/, and presents them to the user. MGW never touched the code.

## When In Doubt

If you're unsure whether a piece of logic belongs in MGW or in an agent:

1. Apply the mechanical check: "If GSD improved this, would MGW benefit?"
2. Check if it's on the allowlist (state, GitHub, display, spawn, utilities)
3. If neither gives a clear answer, default to **spawning an agent**

Over-delegation (spawning agents for trivial work) wastes tokens but doesn't break anything.
Under-delegation (MGW reading code) violates the architecture and creates maintenance debt.

## Consumers

This rule applies to ALL MGW commands:

| Command | Key Boundary Points |
|---------|-------------------|
| run.md | Spawns planner, executor, verifier, comment classifier — never reads code |
| issue.md | Spawns analysis agent — never analyzes code itself |
| review.md | Spawns comment classification agent — reads comments, not code |
| pr.md | Spawns PR body builder — never reads code for description |
| sync.md | Reads state + GitHub API only — never reads code |
| update.md | Reads state only — posts comments |
| link.md | Reads/writes cross-refs only |
| init.md | Creates structure + GitHub labels only |
| issues.md | Reads GitHub API only |
| help.md | Display only |
