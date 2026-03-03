<purpose>
Shared GSD agent spawn patterns for MGW commands. Every Task() spawn MUST use
these templates to ensure CLAUDE.md injection and consistent subagent configuration.
MGW delegates all code-touching work to GSD agents — this file defines how.
</purpose>

## Mandatory Context Injection

Every Task() spawn from an MGW command MUST include project context in its prompt.
No exceptions. This ensures every subagent operates within the project's conventions,
security requirements, and coding standards.

**Copy this block into every Task() prompt:**

```markdown
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
</files_to_read>
```

This block MUST appear at the START of the Task() prompt, before any agent-specific content.

## Standard Task() Spawn Template

All GSD agent spawns MUST use Task() with explicit subagent_type. Never use Skill
invocation or inline execution.

```
Task(
  prompt="
    <files_to_read>
    - ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
    - .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
    {additional files specific to this agent}
    </files_to_read>

    {agent-specific prompt here}
  ",
  subagent_type="{type}",
  model="{resolved_model}",
  description="{short description}"
)
```

## Model Resolution

Resolve model strings before spawning agents. Never hardcode model names.

```bash
PLANNER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-planner --raw)
EXECUTOR_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-executor --raw)
VERIFIER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-verifier --raw)
CHECKER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-plan-checker --raw)
```

## Valid subagent_types

| Type | Use For | Example |
|------|---------|---------|
| `gsd-planner` | Planning agents that create PLAN.md files | Issue-to-plan in /mgw:run |
| `gsd-executor` | Agents that write application code | Plan task execution |
| `gsd-verifier` | Post-execution verification agents | Goal achievement checks |
| `gsd-plan-checker` | Plan quality review agents | Plan structure and coverage review |
| `general-purpose` | Utility agents (no code execution) | Comments, PR body, analysis, triage, comment classification |

## Comment Classification Pattern

Used by `/mgw:run` (pre-flight check) and `/mgw:review` (standalone) to classify
new comments as material, informational, or blocking.

```
Task(
  prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
</files_to_read>

Classify new comments on GitHub issue #${ISSUE_NUMBER}.

<issue_context>
Title: ${issue_title}
Current pipeline stage: ${pipeline_stage}
GSD Route: ${gsd_route}
Triage scope: ${triage.scope}
</issue_context>

<new_comments>
${NEW_COMMENTS}
</new_comments>

<classification_rules>
- material — changes scope, requirements, acceptance criteria, or design
- informational — status update, acknowledgment, question, +1
- blocking — explicit instruction to stop or wait

Priority: blocking > material > informational
</classification_rules>

<output_format>
Return ONLY valid JSON with: classification, reasoning, new_requirements, blocking_reason
</output_format>
",
  subagent_type="general-purpose",
  description="Classify comments on #${ISSUE_NUMBER}"
)
```

## GSD Quick Pipeline Pattern

Used by `/mgw:run` for small/medium issues (gsd:quick and gsd:quick --full routes).

```bash
# 1. Init quick task
INIT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs init quick "$DESCRIPTION")
# Parse: planner_model, executor_model, checker_model, verifier_model,
#        next_num, slug, date, quick_dir, task_dir, roadmap_exists

# 2. Handle missing .planning/ (quick tasks in non-GSD repos)
#    MGW never writes config.json, ROADMAP.md, or STATE.md — those are GSD-owned.
#    Only create the quick task directory (GSD agents need it).
if [ "$roadmap_exists" = "false" ]; then
  echo "NOTE: No .planning/ directory found. GSD manages its own state files."
  echo "      To create a ROADMAP.md, run /gsd:new-milestone after this pipeline."
  mkdir -p .planning/quick
fi

# 3. Create task directory
QUICK_DIR=".planning/quick/${next_num}-${slug}"
mkdir -p "$QUICK_DIR"

# 4. Spawn planner → (if --full) checker → executor → (if --full) verifier
# See run.md for full spawn sequence with templates
```

## GSD Milestone Pipeline Pattern

Used by `/mgw:run` for large issues (gsd:new-milestone route) and `/mgw:milestone` for
milestone-level orchestration. This is the full lifecycle — each phase goes through
plan -> execute -> verify before moving to the next.

```bash
# 1. Init milestone
MILESTONE_INIT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs init new-milestone 2>/dev/null)

# 2. Create ROADMAP (autonomous from issue data, or interactive fallback)
# Spawn roadmapper agent -> user confirmation checkpoint -> proceed

# 3. Resolve models
PLANNER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-planner --raw)
EXECUTOR_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-executor --raw)
VERIFIER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-verifier --raw)

# 4. Discover phases from ROADMAP
ROADMAP_ANALYSIS=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs roadmap analyze)
# Extract: phase list with numbers, names, slugs

# 5. Per-phase lifecycle loop:
# for each phase:
  # a. Init phase and create directory
  PHASE_INIT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs init plan-phase "${PHASE_NUM}")
  mkdir -p "${phase_dir}"

  # b. Spawn planner (gsd-planner) -> creates PLAN.md files
  # Task(subagent_type="gsd-planner", ...)

  # c. Init execute-phase
  EXEC_INIT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs init execute-phase "${PHASE_NUM}")

  # d. Spawn executor (gsd-executor) -> creates SUMMARY.md files
  # Task(subagent_type="gsd-executor", ...)

  # e. Spawn verifier (gsd-verifier) -> creates VERIFICATION.md
  # Task(subagent_type="gsd-verifier", ...)

  # f. Post phase-complete comment on issue
  # gh issue comment ...

# 6. Complete milestone (archive phases, clean ROADMAP, tag release)
# Called from milestone.md post_loop when all issues finish
# Follows gsd:complete-milestone workflow
```

**Artifacts created per phase:**
```
.planning/phases/{NN}-{slug}/
  {phase}-{plan}-PLAN.md        (from planner)
  {phase}-{plan}-SUMMARY.md     (from executor)
  {phase}-VERIFICATION.md       (from verifier)
```

**Artifacts created on milestone completion:**
```
.planning/milestones/
  v{X.Y}-ROADMAP.md             (archived roadmap)
  v{X.Y}-REQUIREMENTS.md        (archived requirements)
```

## GSD Debug Pipeline Pattern

Used by `/mgw:run` when triage recommends `gsd:diagnose-issues`. This route investigates
a bug's root cause before planning a fix. It is a two-step process: diagnose, then fix.

The GSD debug workflow is `diagnose-issues.md` -- it spawns parallel debug agents per
symptom/gap, each investigating autonomously, returning root causes.

```bash
# 1. Gather symptoms from the issue body
# Extract: what's broken, error messages, reproduction steps, expected vs actual

# 2. Create debug directory
mkdir -p .planning/debug

# 3. Spawn diagnosis agent
Task(
  prompt="
    <files_to_read>
    - ./CLAUDE.md (Project instructions -- if exists, follow all guidelines)
    - .planning/STATE.md (if exists)
    </files_to_read>

    Diagnose the root cause of this bug.

    <issue>
    Title: ${issue_title}
    Body: ${issue_body}
    </issue>

    <instructions>
    Read the GSD diagnose-issues workflow for your process:
    @~/.claude/get-shit-done/workflows/diagnose-issues.md

    Create a debug session file at .planning/debug/${slug}.md
    Investigate the codebase to find the root cause.
    Return: root cause, evidence, files involved, suggested fix direction.
    </instructions>
  ",
  subagent_type="general-purpose",
  description="Diagnose bug: ${issue_title}"
)

# 4. After diagnosis, route to quick fix
# Read the debug session file for root cause
# If root cause found: spawn gsd:quick executor with the root cause as context
# If inconclusive: report to user, suggest manual investigation
```

**Artifacts created:**
```
.planning/debug/
  {slug}.md              (debug session with root cause)
```

After diagnosis, the pipeline continues to the quick execution flow (task 3 in the
existing Quick Pipeline Pattern) with the root cause informing the plan.

## Utility Patterns

GSD tools used by MGW for common operations.

### Slug Generation
```bash
SLUG=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs generate-slug "${title}" --raw)
SLUG="${SLUG:0:40}"  # MGW enforces 40-char limit
```

### Timestamps
```bash
TIMESTAMP=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw)
```

### Progress Display
```bash
PROGRESS=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs progress bar --raw 2>/dev/null || echo "")
PROGRESS_TABLE=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs progress table --raw 2>/dev/null || echo "")
```

### Summary Extraction
```bash
# Structured extraction (returns JSON with one_liner, key_files, tech_added, patterns, decisions)
SUMMARY_DATA=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs summary-extract "${path}" 2>/dev/null || echo '{}')

# Specific fields
ONE_LINER=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs summary-extract "${path}" --fields one_liner --raw 2>/dev/null || echo "")
```

### GSD History Context
```bash
# Brief digest for providing project history to agents
HISTORY=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs history-digest 2>/dev/null || echo "")
```

### GSD Health Check
```bash
# Read-only health validation
HEALTH=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs validate health 2>/dev/null || echo '{"status":"unknown"}')
```

### Commit via GSD
```bash
node ~/.claude/get-shit-done/bin/gsd-tools.cjs commit "${message}" --files ${file_list}
```

### Plan Structure Verification
```bash
# Pre-flight check for plan quality
PLAN_CHECK=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs verify plan-structure "${PLAN_PATH}")
```

### Summary Verification
```bash
VERIFY_RESULT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs verify-summary "${SUMMARY_PATH}")
```

### Post-Execution Artifact Checks
```bash
# Non-blocking — include warnings in PR if issues found
ARTIFACT_CHECK=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs verify artifacts "${PLAN_PATH}" 2>/dev/null || echo '{"passed":true}')
KEYLINK_CHECK=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs verify key-links "${PLAN_PATH}" 2>/dev/null || echo '{"passed":true}')
```

## Question Classification Agent Pattern

Used by `/mgw:ask` to classify questions/observations during milestone execution.
Spawns a general-purpose agent with full project context — milestone, all issues,
active state, and recent git diff — to determine if a question is in-scope,
adjacent, separate, duplicate, or out-of-scope.

```
Task(
  prompt="
    <files_to_read>
    - ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
    - .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
    </files_to_read>

    You are a question classification agent for the MGW pipeline.

    <question>${QUESTION}</question>
    <current_milestone>${MILESTONE_CONTEXT}</current_milestone>
    <milestone_issues>${ALL_ISSUES_CONTEXT}</milestone_issues>
    <issue_bodies>${ISSUE_BODIES}</issue_bodies>
    <active_work>${ACTIVE_STATE}</active_work>
    <recent_changes>${RECENT_DIFF}</recent_changes>

    Classify into: in-scope | adjacent | separate | duplicate | out-of-scope
    Return: classification, analysis, related issue, recommendation.
  ",
  subagent_type="general-purpose",
  description="Classify question: ${QUESTION}"
)
```

The agent is read-only (general-purpose, no code execution). It reads project state
and codebase to classify, then MGW presents the result and offers follow-up actions
(file new issue, post comment on related issue, etc.).

## Anti-Patterns

- **NEVER** use Skill invocation from within a Task() agent — Skills don't resolve inside subagents
- **NEVER** spawn a Task() without the mandatory CLAUDE.md injection block
- **NEVER** hardcode model strings (e.g., `model="sonnet"`) — always resolve via gsd-tools
- **NEVER** inline code execution in the MGW orchestrator — always spawn a Task() agent
- **NEVER** let MGW read application source code directly — spawn an analysis agent
- **NEVER** omit `subagent_type` from a Task() call — always specify the agent type

## Consumers

| Pattern | Referenced By |
|---------|-------------|
| Standard spawn template | run.md, issue.md, pr.md, ask.md, review.md |
| Comment classification | run.md (pre-flight), review.md (standalone) |
| Quick pipeline | run.md |
| Milestone pipeline | run.md, milestone.md |
| Question classification | ask.md |
| Model resolution | run.md |
## PR Review Pattern

Used by `/mgw:review` for deep PR analysis. This is problem-solving orchestration
(not execution orchestration) — the reviewer has high autonomy to analyze, question
assumptions, and provide architectural guidance.

```bash
# 1. Prepare review context
REVIEW_DIR=".mgw/reviews"
mkdir -p "$REVIEW_DIR"
REVIEW_ID="pr-${PR_NUMBER}-$(date +%Y%m%d-%H%M%S)"

# 2. Create context file with PR details, diff, linked issue
cat > "${REVIEW_DIR}/${REVIEW_ID}-context.md" << EOF
# PR Review Context

## PR Information
- Number: #${PR_NUMBER}
- Title: ${PR_TITLE}
...
EOF

# 3. Spawn deep review agent
Task(
  prompt="
    <files_to_read>
    - ./CLAUDE.md
    - ${REVIEW_CONTEXT_FILE}
    </files_to_read>

    You are a senior code reviewer performing comprehensive PR review.
    Analyze across five dimensions: test, rationale, intent vs implementation,
    impact analysis, and architectural review.

    Return structured JSON with test_results, rationale, intent_vs_implementation,
    impact_analysis, architectural_review, and overall_verdict.
  ",
  subagent_type="general-purpose",
  model="sonnet",
  description="Deep review PR #${PR_NUMBER}"
)

# 4. Store results in .mgw/reviews/
```

**State separation:**
- `.mgw/active/` — MGW pipeline state
- `.mgw/reviews/` — PR review state (think tank context)
- `.planning/` — GSD execution state

This separation gives the reviewer space to handle larger context for
mission-critical review processes without polluting pipeline or execution state.

## Consumers

| Pattern | Referenced By |
|---------|---------------|
| Standard spawn template | run.md, issue.md, pr.md, ask.md, review.md |
| PR deep review | review.md (new) |
| Comment classification | run.md (pre-flight) |
| Quick pipeline | run.md |
| Milestone pipeline | run.md, milestone.md |
| Question classification | ask.md |
| Model resolution | run.md |
| Utility patterns | run.md, pr.md, issue.md, sync.md, link.md, update.md, ask.md |
