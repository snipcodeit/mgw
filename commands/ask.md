---
name: mgw:ask
description: Route a question/observation — classify as in-scope, adjacent, separate, duplicate, or out-of-scope
argument-hint: "<question>"
allowed-tools:
  - Bash
  - Read
  - Task
  - AskUserQuestion
---

<objective>
During milestone execution, observations arise that need classification: is this
in-scope for the current issue, adjacent to a different issue, a separate concern,
a duplicate, or out-of-scope entirely?

/mgw:ask spawns a general-purpose agent with full project context (milestone, all
issues, active state, recent git diff) that classifies the question and recommends
an action. Read-only for the orchestrator — the agent reads state and code, MGW
presents the structured result.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<context>
Question text: $ARGUMENTS

Active issues context: .mgw/active/ (current work state)
Project context: .mgw/project.json (milestone + all issues)
Capability context: commands/*.md front matter (name + description per command)
Live state: open PRs via gh pr list, milestones via gh api
</context>

<process>

<step name="validate_input">
**Validate question text provided:**

Parse $ARGUMENTS for the question text. If missing or empty:
```
AskUserQuestion(
  header: "Question Required",
  question: "What question or observation do you want to classify?",
  followUp: "Enter a question or observation (e.g., 'The slug generation doesn't handle unicode characters')"
)
```
Store as $QUESTION.
</step>

<step name="load_project_context">
**Load project.json for milestone and issue context:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
MGW_DIR="${REPO_ROOT}/.mgw"

# Load project state
PROJECT_JSON=""
MILESTONE_CONTEXT=""
ALL_ISSUES_CONTEXT=""

if [ -f "${MGW_DIR}/project.json" ]; then
  PROJECT_JSON=$(cat "${MGW_DIR}/project.json")

  # Extract current milestone info
  MILESTONE_CONTEXT=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
idx = p['current_milestone'] - 1
if idx < len(p['milestones']):
    m = p['milestones'][idx]
    print(f\"Milestone: {m['name']}\")
    if m.get('description'):
        print(f\"Description: {m['description']}\")
else:
    print('No active milestone')
" 2>/dev/null || echo "No project initialized")

  # Extract all issues in current milestone with titles, bodies, scopes, labels
  ALL_ISSUES_CONTEXT=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
idx = p['current_milestone'] - 1
if idx >= len(p['milestones']):
    print('No issues found')
    sys.exit(0)
m = p['milestones'][idx]
for issue in m.get('issues', []):
    num = issue.get('github_number', '?')
    title = issue.get('title', 'untitled')
    stage = issue.get('pipeline_stage', 'new')
    labels = ', '.join(issue.get('labels', []))
    phase = issue.get('phase_name', '')
    scope = issue.get('scope', '')
    print(f'#{num} [{stage}] {title}')
    if phase:
        print(f'  Phase: {phase}')
    if labels:
        print(f'  Labels: {labels}')
    if scope:
        print(f'  Scope: {scope}')
    print()
" 2>/dev/null || echo "")
else
  MILESTONE_CONTEXT="No project initialized"
  ALL_ISSUES_CONTEXT=""
fi
```
</step>

<step name="load_capability_context">
**Load MGW command surface, open PRs, and live milestones:**

```bash
# Extract name + description from each command's front matter
COMMAND_SURFACE=""
COMMANDS_DIR="${REPO_ROOT}/commands"
for f in "${COMMANDS_DIR}"/*.md; do
  CMD_NAME=$(grep -m1 "^name:" "$f" 2>/dev/null | sed 's/^name:[[:space:]]*//')
  CMD_DESC=$(grep -m1 "^description:" "$f" 2>/dev/null | sed 's/^description:[[:space:]]*//')
  if [ -n "$CMD_NAME" ]; then
    COMMAND_SURFACE="${COMMAND_SURFACE}${CMD_NAME}: ${CMD_DESC}\n"
  fi
done

# Fetch open PRs
PR_CONTEXT=$(gh pr list --state open --json number,title,headRefName \
  --jq '.[] | "#\(.number) [\(.headRefName)] \(.title)"' 2>/dev/null || echo "No open PRs")

# Fetch live milestones from GitHub API
REPO_SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
MILESTONE_LIST=""
if [ -n "$REPO_SLUG" ]; then
  MILESTONE_LIST=$(gh api "repos/${REPO_SLUG}/milestones" \
    --jq '.[] | "[\(.state)] \(.title)"' 2>/dev/null || echo "")
fi
if [ -z "$MILESTONE_LIST" ]; then
  MILESTONE_LIST="No milestones found (or GitHub API unavailable)"
fi
```
</step>

<step name="load_active_state">
**Load active issue state from .mgw/active/:**

```bash
ACTIVE_STATE=""
ACTIVE_ISSUE_NUMBER=""

ACTIVE_FILES=$(ls "${MGW_DIR}/active/"*.json 2>/dev/null)
if [ -n "$ACTIVE_FILES" ]; then
  for f in ${ACTIVE_FILES}; do
    ISSUE_DATA=$(cat "$f")
    ISSUE_NUM=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('issue',{}).get('number','?'))")
    ISSUE_TITLE=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('issue',{}).get('title','untitled'))")
    PIPELINE_STAGE=$(echo "$ISSUE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('pipeline_stage','unknown'))")
    ACTIVE_STATE="${ACTIVE_STATE}#${ISSUE_NUM} [${PIPELINE_STAGE}] ${ISSUE_TITLE}\n"
    # Track the most recently active issue (last in list)
    ACTIVE_ISSUE_NUMBER="$ISSUE_NUM"
  done
else
  ACTIVE_STATE="No active issues"
fi
```
</step>

<step name="gather_git_diff">
**Gather recent git diff for change context:**

```bash
# Get recent changes (staged + unstaged, limited to keep prompt reasonable)
RECENT_DIFF=$(git diff HEAD --stat 2>/dev/null | head -30 || echo "No changes")
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
```
</step>

<step name="fetch_issue_details">
**Fetch full issue bodies from GitHub for matching context:**

If project.json has issues, fetch their bodies for the agent to compare against:

```bash
ISSUE_BODIES=""
if [ -n "$PROJECT_JSON" ]; then
  ISSUE_NUMBERS=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
idx = p['current_milestone'] - 1
if idx < len(p['milestones']):
    m = p['milestones'][idx]
    for issue in m.get('issues', []):
        print(issue.get('github_number', ''))
" 2>/dev/null)

  for NUM in $ISSUE_NUMBERS; do
    if [ -n "$NUM" ]; then
      BODY=$(gh issue view "$NUM" --json number,title,body -q '"\(.number)|\(.title)|\(.body)"' 2>/dev/null || echo "")
      if [ -n "$BODY" ]; then
        ISSUE_BODIES="${ISSUE_BODIES}${BODY}\n---\n"
      fi
    fi
  done
fi
```
</step>

<step name="spawn_classification_agent">
**Spawn general-purpose agent for question classification:**

```
Task(
  prompt="
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
</files_to_read>

You are a question classification agent for the MGW pipeline. Your job is to
classify a question or observation against the current project context and
recommend an action.

<question>
${QUESTION}
</question>

<current_milestone>
${MILESTONE_CONTEXT}
</current_milestone>

<milestone_issues>
${ALL_ISSUES_CONTEXT}
</milestone_issues>

<issue_bodies>
${ISSUE_BODIES}
</issue_bodies>

<active_work>
Current branch: ${CURRENT_BRANCH}
Active issues in .mgw/:
${ACTIVE_STATE}
</active_work>

<recent_changes>
${RECENT_DIFF}
</recent_changes>

<mgw_capabilities>
## MGW Command Surface
${COMMAND_SURFACE}

## Open Pull Requests
${PR_CONTEXT}

## GitHub Milestones
${MILESTONE_LIST}
</mgw_capabilities>

<classification_rules>

Classify the question into exactly ONE of these categories:

| Category | Criteria | Action |
|----------|----------|--------|
| In-scope | Directly relates to the current active issue being worked on | Include in current work — no new issue needed |
| Adjacent | Relates to a DIFFERENT issue in the same milestone | Note it on that issue — suggest posting a comment |
| Separate | Doesn't match any open issue in the milestone | Suggest filing a new issue with a title |
| Duplicate | Matches an existing issue (same root cause or fix) | Point to the existing issue |
| Out-of-scope | Beyond the current milestone entirely | Note for future planning |

Decision process:
1. Read the question carefully
2. Compare against each issue title, body, and scope in the milestone
3. Check if it relates to current active work (branch, diff, active state)
4. Look for keyword/concept overlap with existing issues
5. If no match, determine if it fits the milestone's theme or is out-of-scope

</classification_rules>

<output_format>
Return a structured classification report:

## Classification: ${CATEGORY}

### Analysis
- What the question is about (1-2 sentences)
- Why this classification was chosen (1-2 sentences)

### Related Issue
- Issue number and title (if adjacent or duplicate)
- Or 'N/A — current work' (if in-scope)
- Or 'No matching issue' (if separate or out-of-scope)

### Recommendation
- Specific actionable next step
- If 'separate': suggest an issue title and brief body
- If 'adjacent': suggest a comment to post on the related issue
- If 'in-scope': note what to include in current work
- If 'duplicate': point to the matching issue
- If 'out-of-scope': note for future milestone planning
</output_format>
",
  subagent_type="general-purpose",
  description="Classify question: ${QUESTION}"
)
```
</step>

<step name="present_result">
**Present the classification result to the user:**

Display the agent's report, then present the MGW action banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► QUESTION ROUTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${classification_report_from_agent}

───────────────────────────────────────────────────────
```
</step>

<step name="offer_actions">
**Offer follow-up actions based on classification:**

**If "Separate":**
```
AskUserQuestion(
  header: "File New Issue?",
  question: "Create a new issue from this observation?",
  options: [
    { label: "Yes", description: "File the suggested issue via /mgw:issue" },
    { label: "No", description: "Note it and continue current work" }
  ]
)
```

If user says "Yes":
```
Suggested issue ready. To file it:

  gh issue create --title "${suggested_title}" --body "${suggested_body}"

Or use /mgw:project to add it to a future milestone.
```

**If "Adjacent":**
```
AskUserQuestion(
  header: "Post Comment?",
  question: "Post a note on the related issue #${related_number}?",
  options: [
    { label: "Yes", description: "Post observation as a comment on #${related_number}" },
    { label: "No", description: "Note it and continue current work" }
  ]
)
```

If user says "Yes":
```bash
gh issue comment ${related_number} --body "> **MGW** · \`observation\` · $(node ~/.claude/get-shit-done/bin/gsd-tools.cjs current-timestamp --raw)

Observation noted during work on #${ACTIVE_ISSUE_NUMBER}:

${QUESTION}"
```

Report: "Comment posted on #${related_number}."

**If "In-scope":**
```
This relates to your current work on #${ACTIVE_ISSUE_NUMBER}.
No action needed — include it in your current implementation.
```

**If "Duplicate":**
```
This appears to duplicate #${duplicate_number} — ${duplicate_title}.
No new issue needed. Check that issue for existing progress.
```

**If "Out-of-scope":**
```
This is beyond the current milestone scope.
Consider adding it to a future milestone or filing it for backlog:

  gh issue create --title "${suggested_title}" --label "backlog"
```
</step>

</process>

<success_criteria>
- [ ] Question text parsed from $ARGUMENTS (or prompted)
- [ ] project.json loaded for milestone + issue context
- [ ] .mgw/active/ state loaded for current work context
- [ ] Recent git diff gathered for change context
- [ ] Issue bodies fetched from GitHub for comparison
- [ ] Classification agent spawned with full context
- [ ] Classification returned: in-scope, adjacent, separate, duplicate, or out-of-scope
- [ ] Related issue identified (if adjacent or duplicate)
- [ ] Actionable recommendation provided
- [ ] Follow-up action offered (file issue, post comment, etc.)
- [ ] Delegation boundary respected: agent reads code/state, MGW presents results
- [ ] Command surface index built from commands/*.md front matter
- [ ] Open PRs fetched and injected into agent context
- [ ] Live GitHub milestones fetched as fallback when project.json is absent
</success_criteria>
</output>
