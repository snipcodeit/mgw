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
| `general-purpose` | Utility agents (no code execution) | Comments, PR body, analysis, triage |

## GSD Quick Pipeline Pattern

Used by `/mgw:run` for small/medium issues (gsd:quick and gsd:quick --full routes).

```bash
# 1. Init quick task
INIT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs init quick "$DESCRIPTION")
# Parse: planner_model, executor_model, checker_model, verifier_model,
#        next_num, slug, date, quick_dir, task_dir, roadmap_exists

# 2. Handle missing ROADMAP.md (quick tasks in non-GSD repos)
if [ "$roadmap_exists" = "false" ]; then
  mkdir -p .planning/quick
  echo '{"model_profile":"balanced","commit_docs":true}' > .planning/config.json
  cat > .planning/ROADMAP.md << 'HEREDOC'
# Roadmap
## v1.0: MGW-Managed
Issue-driven development managed by MGW.
HEREDOC
fi

# 3. Create task directory
QUICK_DIR=".planning/quick/${next_num}-${slug}"
mkdir -p "$QUICK_DIR"

# 4. Spawn planner → (if --full) checker → executor → (if --full) verifier
# See run.md for full spawn sequence with templates
```

## GSD Milestone Pipeline Pattern

Used by `/mgw:run` for large issues (gsd:new-milestone route).

```bash
# 1. Init milestone
MILESTONE_INIT=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs init new-milestone 2>/dev/null)

# 2. Resolve models
PLANNER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-planner --raw)
EXECUTOR_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-executor --raw)
VERIFIER_MODEL=$(node ~/.claude/get-shit-done/bin/gsd-tools.cjs resolve-model gsd-verifier --raw)

# 3. For each phase in ROADMAP.md:
#    a. Spawn planner (gsd-planner)
#    b. Spawn executor(s) (gsd-executor)
#    c. Spawn verifier (gsd-verifier)
#    d. Post phase update comment on issue
```

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
| Standard spawn template | run.md, issue.md, pr.md, ask.md |
| Quick pipeline | run.md |
| Milestone pipeline | run.md |
| Question classification | ask.md |
| Model resolution | run.md |
| Utility patterns | run.md, pr.md, issue.md, sync.md, link.md, update.md, ask.md |
