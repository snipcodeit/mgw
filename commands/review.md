---
name: mgw:review
description: Review GitHub comments on issues OR perform deep PR analysis
argument-hint: "<issue-number | pr-number | pr-url> [--pr]"
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
Two-mode review command:

**Mode 1: Issue Comment Review (default)**
Review and classify new comments on a GitHub issue since last triage. Fetches new comments,
classifies them (material/informational/blocking/resolution), and updates state.

Use this when checking for stakeholder feedback before running the pipeline, or reviewing
comments on a blocked issue.

**Mode 2: PR Deep Review (with --pr flag)**
Comprehensive PR review that mimics a senior engineer's code review process. Problem-solving
orchestration with high autonomy to analyze, question assumptions, and provide architectural
guidance across five dimensions.

This is intentionally different from execution orchestration — the reviewer has space to think
deeply rather than produce code.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<context>
Reference: $ARGUMENTS (issue number, PR number, or PR URL)
Flags: --pr forces PR deep review mode
</context>

<process>

<step name="detect_mode">
**Detect review mode:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)

# Parse arguments
REFERENCE="$ARGUMENTS"
PR_MODE=false

# Check for --pr flag
if [[ "$REFERENCE" =~ --pr[[:space:]]|$ ]]; then
  PR_MODE=true
  REFERENCE=$(echo "$REFERENCE" | sed 's/--pr//g' | xargs)
fi

# Determine if PR or issue based on format
if [[ "$REFERENCE" =~ ^https?://github\.com/[^/]+/[^/]+/pull/ ]]; then
  # URL - determine if issue or PR
  if [[ "$REFERENCE" =~ /pull/ ]]; then
    PR_MODE=true
  fi
  PR_REF="$REFERENCE"
elif [[ "$REFERENCE" =~ ^https?://github\.com/[^/]+/[^/]+/issues/ ]]; then
  PR_MODE=false
  ISSUE_REF="$REFERENCE"
elif [[ "$REFERENCE" =~ ^[0-9]+$ ]]; then
  # Number - check if it's a PR or issue by testing
  # Default to issue comment review (safer default)
  PR_MODE=false
  NUMBER="$REFERENCE"
else
  # Default: issue comment review
  PR_MODE=false
  NUMBER="$REFERENCE"
fi

# Export for later steps
export PR_MODE
```
</step>

<step name="route_to_mode">
**Route to appropriate review mode:**

If PR_MODE=true → Jump to "pr_review" section below
If PR_MODE=false → Continue to "issue_comments" section

</step>

# ═══════════════════════════════════════════════════════════════════════════════
# MODE 1: ISSUE COMMENT REVIEW (original functionality, optimized)
# ═══════════════════════════════════════════════════════════════════════════════

<step name="issue_validate">
**Validate issue and load state:**

```bash
# Parse issue number
if [ -n "$NUMBER" ]; then
  ISSUE_NUMBER="$NUMBER"
elif [ -n "$ISSUE_REF" ]; then
  ISSUE_NUMBER=$(echo "$ISSUE_REF" | grep -oE '[0-9]+$' | head -1)
fi

if [ -z "$ISSUE_NUMBER" ]; then
  AskUserQuestion(
    header: "Issue Number Required",
    question: "Which issue number do you want to review comments for?",
    followUp: "Enter the GitHub issue number (e.g., 42)"
  )
  ISSUE_NUMBER="$ANSWER"
fi

# Verify issue exists
gh issue view "$ISSUE_NUMBER" >/dev/null 2>&1 || {
  echo "Error: Issue #${ISSUE_NUMBER} not found."
  exit 1
}

# Check if issue is triaged (state file exists)
if [ ! -f "${REPO_ROOT}/.mgw/active/${ISSUE_NUMBER}-*.json" ]; then
  echo "Issue #${ISSUE_NUMBER} hasn't been triaged yet."
  echo "Run /mgw:issue ${ISSUE_NUMBER} first, then review comments."
  # Still allow review but warn
fi
```
</step>

<step name="issue_fetch_comments">
**Fetch current comment state:**

```bash
CURRENT_COMMENTS=$(gh issue view $ISSUE_NUMBER --json comments --jq '.comments | length' 2>/dev/null || echo "0")
STORED_COMMENTS=0

# Try to get stored count from state file
if [ -f "${REPO_ROOT}/.mgw/active/${ISSUE_NUMBER}-"*".json" ]; then
  STATE_FILE=$(ls "${REPO_ROOT}/.mgw/active/${ISSUE_NUMBER}-"*".json" | head -1)
  STORED_COMMENTS=$(jq -r '.triage.last_comment_count // 0' "$STATE_FILE" 2>/dev/null || echo "0")
fi

NEW_COUNT=$(($CURRENT_COMMENTS - $STORED_COMMENTS))

if [ "$NEW_COUNT" -le 0 ]; then
  echo "No new comments on #${ISSUE_NUMBER} since triage (${STORED_COMMENTS} stored, ${CURRENT_COMMENTS} now)."
  echo "Done."
  exit 0
fi

# Fetch new comments
NEW_COMMENTS=$(gh issue view $ISSUE_NUMBER --json comments \
  --jq "[.comments[-${NEW_COUNT}:]] | .[] | {author: .author.login, body: .body, createdAt: .createdAt}" 2>/dev/null)

# Get issue context for classification
ISSUE_TITLE=$(gh issue view $ISSUE_NUMBER --json title -q '.title')
PIPELINE_STAGE=$(jq -r '.pipeline_stage // "new"' "$STATE_FILE" 2>/dev/null || echo "new")
GSD_ROUTE=$(jq -r '.gsd_route // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")
```
</step>

<step name="issue_classify">
**Spawn classification agent (lightweight):**

```
Task(
  prompt="
KR|<files_to_read>
ST|- ./CLAUDE.md (Project instructions — if exists)
</files_to_read>

Classify new comments on GitHub issue #${ISSUE_NUMBER}.

<issue_context>
Title: ${ISSUE_TITLE}
Current pipeline stage: ${PIPELINE_STAGE}
GSD Route: ${GSD_ROUTE}
</issue_context>

<new_comments>
${NEW_COMMENTS}
</new_comments>

<classification_rules>
- **material** — Comment changes scope, requirements, acceptance criteria, or design
- **informational** — Status update, acknowledgment, question, +1
- **blocking** — Explicit instruction to stop or wait
- **resolution** — Comment indicates a previously identified blocker has been resolved

Priority: blocking > resolution > material > informational
</classification_rules>

<output_format>
Return ONLY valid JSON:
{
  \"classification\": \"material|informational|blocking|resolution\",
  \"reasoning\": \"Brief explanation\",
  \"per_comment\": [{\"author\": \"username\", \"snippet\": \"first 100 chars\", \"classification\": \"...\"}],
  \"new_requirements\": [],
  \"blocking_reason\": \"\",
  \"resolved_blocker\": \"\"
}
</output_format>
  ",
  subagent_type="general-purpose",
  description="Classify comments on #${ISSUE_NUMBER}"
)
```
</step>

<step name="issue_present_and_act">
**Present classification and offer actions:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► COMMENT REVIEW — #${ISSUE_NUMBER}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

New comments: ${NEW_COUNT}
Classification: ${classification}
Reasoning: ${reasoning}

Actions based on classification:
- informational: Update last_comment_count
- material: Update with new requirements
- blocking: Option to block pipeline
- resolution: Option to re-triage
```

</step>

# ═══════════════════════════════════════════════════════════════════════════════
# MODE 2: PR DEEP REVIEW (new functionality)
# ═══════════════════════════════════════════════════════════════════════════════

<step name="pr_review">
**PR Deep Review Mode:**

This section handles comprehensive PR analysis. Jump here if PR_MODE=true.

<step name="pr_validate">
**Validate and parse PR reference:**

```bash
# Parse PR number from various formats
if [[ "$REFERENCE" =~ ^https?://github\.com/[^/]+/[^/]+/pull/([0-9]+) ]]; then
  PR_NUMBER="${BASH_REMATCH[1]}"
elif [[ "$REFERENCE" =~ ^[0-9]+$ ]] && "$PR_MODE" = true; then
  PR_NUMBER="$REFERENCE"
else
  # Try current branch
  CURRENT_BRANCH=$(git branch --show-current)
  PR_NUMBER=$(gh pr view "$CURRENT_BRANCH" --json number -q '.number' 2>/dev/null || echo "")
fi

# Verify PR exists
gh pr view "$PR_NUMBER" >/dev/null 2>&1 || {
  echo "Error: PR #${PR_NUMBER} not found."
  exit 1
}
```
</step>

<step name="pr_fetch_details">
**Fetch comprehensive PR details:**

```bash
PR_DATA=$(gh pr view "$PR_NUMBER" --json number,title,body,state,url,baseRefName,headRefName,author,createdAt,changedFiles)
PR_TITLE=$(echo "$PR_DATA" | jq -r '.title')
PR_BODY=$(echo "$PR_DATA" | jq -r '.body // ""')
PR_STATE=$(echo "$PR_DATA" | jq -r '.state')
PR_URL=$(echo "$PR_DATA" | jq -r '.url')
PR_BASE=$(echo "$PR_DATA" | jq -r '.baseRefName')
PR_HEAD=$(echo "$PR_DATA" | jq -r '.headRefName')
PR_AUTHOR=$(echo "$PR_DATA" | jq -r '.author.login')
FILE_COUNT=$(echo "$PR_DATA" | jq -r '.changedFiles')

# Find linked issue
LINKED_ISSUE=$(echo "$PR_BODY" | grep -oE '(closes|fixes|addresses|resolves) #[[:digit:]]+' | grep -oE '[[:digit:]]+' | head -1)

if [ -n "$LINKED_ISSUE" ]; then
  ISSUE_TITLE=$(gh issue view "$LINKED_ISSUE" --json title -q '.title' 2>/dev/null || echo "")
fi
```
</step>

<step name="pr_prepare_context">
**Prepare review directory:**

```bash
REVIEW_DIR="${REPO_ROOT}/.mgw/reviews"
mkdir -p "$REVIEW_DIR"

REVIEW_ID="pr-${PR_NUMBER}-$(date +%Y%m%d-%H%M%S)"
REVIEW_STATE_FILE="${REVIEW_DIR}/${REVIEW_ID}.json"

cat > "$REVIEW_STATE_FILE" << EOF
{
  \"review_id\": \"${REVIEW_ID}\",
  \"pr_number\": ${PR_NUMBER},
  \"pr_title\": \"${PR_TITLE}\",
  \"pr_url\": \"${PR_URL}\",
  \"linked_issue\": ${LINKED_ISSUE:-null},
  \"reviewer\": \"${PR_AUTHOR}\",
  \"created_at\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",
  \"status\": \"in_progress\",
  \"mode\": \"deep_pr_review\"
}
EOF
```
</step>

<step name="pr_spawn_reviewer">
**Spawn deep review agent:**

```
Task(
  prompt="
KR|<files_to_read>
ST|- ./CLAUDE.md (Project instructions — if exists)
</files_to_read>

You are a senior code reviewer. Perform deep PR analysis addressing five dimensions:

## 1. TEST THIS PR
Run tests, build, verify functionality works.

## 2. WHY DO WE NEED THIS?
Analyze rationale vs linked issue #${LINKED_ISSUE:-none}.

## 3. STATED INTENT VS ACTUAL CHANGES
Compare PR claims vs actual code changes.

## 4. IMPACT ANALYSIS
Side effects, dependencies, patterns, security, performance.

## 5. ARCHITECTURAL REVIEW
Alternatives, design consistency, root cause vs symptom.

## PR Context
- **PR:** #${PR_NUMBER} - ${PR_TITLE}
- **Author:** ${PR_AUTHOR}
- **Base:** ${PR_BASE} ← ${PR_HEAD}
- **Files:** ${FILE_COUNT}
- **Linked Issue:** ${LINKED_ISSUE:-none} ${ISSUE_TITLE:+- ${ISSUE_TITLE}}

## Output

Write to ${REVIEW_STATE_FILE}:

node -e \"
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('${REVIEW_STATE_FILE}', 'utf-8'));
state.analyses = {
  test_results: { tests_passed: true/false, build_passed: true/false, summary: '...' },
  rationale: { problem_identified: '...', problem_valid: true/false, priority: 'high/medium/low' },
  intent_vs_implementation: { gaps: [], scope_creep: [] },
  impact_analysis: { side_effects: [], dependencies: [], pattern_violations: [] },
  architectural_review: { approach_correct: true/false, alternatives: [], recommendations: [] },
  overall_verdict: { recommendation: 'approve/request_changes/needs_discussion', confidence: 'high/medium/low', summary: '...', blockers: [], concerns: [] }
};
state.status = 'completed';
state.completed_at = new Date().toISOString();
fs.writeFileSync('${REVIEW_STATE_FILE}', JSON.stringify(state, null, 2));
console.log('Review complete.');
\"
  ",
  subagent_type="general-purpose",
  model="sonnet",
  description="Deep review PR #${PR_NUMBER}"
)
```
</step>

<step name="pr_present">
**Present review results:**

```bash
REVIEW_DATA=$(cat "$REVIEW_STATE_FILE")
# Parse and display results in structured format
```
</step>

</process>

<success_criteria>
- [ ] Mode detection works (issue comments vs PR deep review)
- [ ] Issue comment classification still functions
- [ ] PR deep review analyzes five dimensions
- [ ] State properly separated (.mgw/reviews/ for PR, .mgw/active/ for issues)
- [ ] Both modes preserve their respective contexts
</success_criteria>
