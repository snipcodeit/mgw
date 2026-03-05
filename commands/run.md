---
name: mgw:run
description: Autonomous pipeline — triage issue through GSD execution to PR creation
argument-hint: "<issue-number>"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Task
  - AskUserQuestion
---

<objective>
The autonomous orchestrator. Takes an issue number, ensures it's triaged, then runs
the full GSD pipeline through to PR creation with minimal user interaction.

All work happens in an isolated git worktree — the user's main workspace stays on
the default branch throughout. The worktree is cleaned up after PR creation.

For quick/quick --full: runs entire pipeline in one session.
For new-milestone: runs full milestone flow, posting updates after each phase.

The orchestrator stays thin — all heavy work (analysis, GSD execution, GitHub
operations) happens in task agents with fresh context.

Checkpoints requiring user input:
- Triage confirmation (if not already triaged)
- GSD route confirmation
- Non-autonomous plan checkpoints
- Milestone scope decisions
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<context>
Issue number: $ARGUMENTS

State: .mgw/active/ (if triaged already)
</context>

<process>

<!-- ═══════════════════════════════════════════════════════════ -->
<!-- Stage 1: TRIAGE                                           -->
<!-- Validate input, load/create state, preflight comment       -->
<!-- check, post work-starting comment                          -->
<!-- ═══════════════════════════════════════════════════════════ -->

@~/.claude/commands/mgw/run/triage.md

<!-- ═══════════════════════════════════════════════════════════ -->
<!-- Stage 2: WORKTREE                                         -->
<!-- Create isolated worktree, set up branch, apply labels      -->
<!-- ═══════════════════════════════════════════════════════════ -->

@~/.claude/commands/mgw/run/worktree.md

<!-- ═══════════════════════════════════════════════════════════ -->
<!-- Stage 3: EXECUTE                                          -->
<!-- Run GSD pipeline (quick or milestone), handle retries,     -->
<!-- post execution update or failure comment                   -->
<!-- ═══════════════════════════════════════════════════════════ -->

@~/.claude/commands/mgw/run/execute.md

<!-- ═══════════════════════════════════════════════════════════ -->
<!-- Stage 4: PR-CREATE                                        -->
<!-- Create PR from artifacts, clean up worktree, post          -->
<!-- completion comment, prompt sync                            -->
<!-- ═══════════════════════════════════════════════════════════ -->

@~/.claude/commands/mgw/run/pr-create.md

</process>

<success_criteria>
- [ ] Issue number validated and state loaded (or triage run first)
- [ ] Pipeline refuses needs-info without --force
- [ ] Pipeline refuses needs-security-review without --security-ack
- [ ] --retry flag clears dead_letter state, removes pipeline-failed label, and re-queues issue
- [ ] migrateProjectState() called at load time to ensure retry fields exist on active issue files
- [ ] Isolated worktree created (.worktrees/ gitignored)
- [ ] mgw:in-progress label applied during execution
- [ ] Pre-flight comment check performed (new comments classified before execution)
- [ ] mgw:blocked label applied when blocking comments detected
- [ ] Work-starting comment posted on issue (route, scope, branch)
- [ ] GSD pipeline executed in worktree (quick or milestone route)
- [ ] Transient execution failures retried up to 3 times with exponential backoff
- [ ] Failure comment includes failure_class from classifyFailure()
- [ ] dead_letter=true set when retries exhausted or failure is permanent
- [ ] New-milestone route triggers discussion phase with mgw:discussing label
- [ ] Execution-complete comment posted on issue (commits, changes, test status)
- [ ] PR created with summary, milestone context, testing procedures, cross-refs
- [ ] Structured PR-ready comment posted on issue (PR link, pipeline summary)
- [ ] Worktree cleaned up, user returned to main workspace
- [ ] mgw:in-progress label removed at completion
- [ ] State file updated through all pipeline stages
- [ ] User prompted to run /mgw:sync after merge
</success_criteria>
