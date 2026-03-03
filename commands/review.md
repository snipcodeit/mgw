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
if [[ "$REFERENCE" == *"--pr"* ]]; then
  PR_MODE=true
  REFERENCE=$(echo "$REFERENCE" | sed 's/--pr//g' | xargs)
fi

# Determine if PR or issue based on format
if [[ "$REFERENCE" =~ ^https?://github\.com/[^/]+/[^/]+/pull/ ]]; then
  PR_MODE=true
  PR_REF="$REFERENCE"
elif [[ "$REFERENCE" =~ ^https?://github\.com/[^/]+/[^/]+/issues/ ]]; then
  PR_MODE=false
  ISSUE_REF="$REFERENCE"
elif [[ "$REFERENCE" =~ ^[0-9]+$ ]]; then
  # Probe GitHub to determine if it's a PR or issue
  if gh pr view "$REFERENCE" >/dev/null 2>&1; then
    PR_MODE=true
  fi
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
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
</files_to_read>

Classify new comments on GitHub issue #${ISSUE_NUMBER}.

<issue_context>
Title: ${ISSUE_TITLE}
Current pipeline stage: ${PIPELINE_STAGE}
GSD Route: ${GSD_ROUTE}
Triage scope: ${triage.scope}
</issue_context>

<new_comments>
${NEW_COMMENTS}
</new_comments>

<classification_rules>
Classify each comment (and the overall batch) into ONE of:

- **material** — Comment changes scope, requirements, acceptance criteria, or design.
  Examples: 'Actually we also need to handle X', 'Changed the requirement to Y',
  'Don't forget about edge case Z'.

- **informational** — Status update, acknowledgment, question that doesn't change scope, +1.
  Examples: 'Looks good', 'Thanks for picking this up', 'What's the ETA?', '+1'.

- **blocking** — Explicit instruction to stop or wait. Must contain clear hold language.
  Examples: 'Don't work on this yet', 'Hold off', 'Blocked by external dependency',
  'Wait for design review'.

- **resolution** — Comment indicates a previously identified blocker or issue has been resolved.
  Examples: 'The dependency has been updated', 'Security review complete — approved',
  'Added the missing acceptance criteria', 'Updated the issue with more detail'.

If ANY comment in the batch is blocking, overall classification is blocking.
If ANY comment is resolution (and none blocking), overall classification is resolution.
If ANY comment is material (and none blocking/resolution), overall classification is material.
Otherwise, informational.
</classification_rules>

<output_format>
Return ONLY valid JSON:
{
  \"classification\": \"material|informational|blocking|resolution\",
  \"reasoning\": \"Brief explanation of why this classification was chosen\",
  \"per_comment\": [
    {
      \"author\": \"username\",
      \"snippet\": \"first 100 chars of comment\",
      \"classification\": \"material|informational|blocking|resolution\"
    }
  ],
  \"new_requirements\": [\"list of new requirements if material, empty array otherwise\"],
  \"blocking_reason\": \"reason if blocking, empty string otherwise\",
  \"resolved_blocker\": \"description of what was resolved, empty string otherwise\"
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

Display the classification result:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► COMMENT REVIEW — #${ISSUE_NUMBER}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

New comments: ${NEW_COUNT} since triage
Classification: ${classification}
Reasoning: ${reasoning}

${per_comment_table}

${if material: 'New requirements detected:\n' + new_requirements}
${if blocking: 'Blocking reason: ' + blocking_reason}
```

Offer actions based on classification:

**If informational:**
```
AskUserQuestion(
  header: "Informational Comments",
  question: "Mark comments as reviewed and update state?",
  options: [
    { label: "Yes", description: "Update last_comment_count, continue" },
    { label: "No", description: "Keep current state, don't update count" }
  ]
)
```
If yes: update `triage.last_comment_count` to $CURRENT_COMMENTS in state file.

**If material:**
```
AskUserQuestion(
  header: "Material Comments Detected",
  question: "How should MGW handle the scope change?",
  options: [
    { label: "Acknowledge and continue", description: "Update state with new requirements, keep current route" },
    { label: "Re-triage", description: "Run /mgw:issue to re-analyze with new context" },
    { label: "Ignore", description: "Don't update state" }
  ]
)
```
If acknowledge: update `triage.last_comment_count` and store new_requirements in state.
If re-triage: suggest running `/mgw:issue ${ISSUE_NUMBER}` to re-triage.

**If blocking:**
```
AskUserQuestion(
  header: "Blocking Comment Detected",
  question: "Block the pipeline for this issue?",
  options: [
    { label: "Block", description: "Set pipeline_stage to 'blocked'" },
    { label: "Override", description: "Ignore blocker, keep current stage" },
    { label: "Review", description: "I'll review the comments manually" }
  ]
)
```
If block: update `pipeline_stage = "blocked"` and `triage.last_comment_count` in state.
If override: update `triage.last_comment_count` only, keep pipeline_stage.

**If resolution:**
```
AskUserQuestion(
  header: "Blocker Resolution Detected",
  question: "A previous blocker appears to be resolved. Re-triage this issue?",
  options: [
    { label: "Re-triage", description: "Run /mgw:issue to re-analyze with updated context" },
    { label: "Acknowledge", description: "Update comment count, keep current pipeline stage" },
    { label: "Ignore", description: "Don't update state" }
  ]
)
```
If re-triage:
  - Update `triage.last_comment_count`
  - Suggest: "Run `/mgw:issue ${ISSUE_NUMBER}` to re-triage with the resolved context."
  - If pipeline_stage is "blocked" or "needs-info" or "needs-security-review", note:
    "Re-triage will re-evaluate gates and may unblock the pipeline."
If acknowledge:
  - Update `triage.last_comment_count`
  - Keep current pipeline_stage

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
elif [[ "$REFERENCE" =~ ^[0-9]+$ ]] && [[ "$PR_MODE" = true ]]; then
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
REVIEWER=$(gh api user -q .login 2>/dev/null || echo "unknown")

# Fetch the actual diff for the reviewer agent
PR_DIFF=$(gh pr diff "$PR_NUMBER" 2>/dev/null || echo "")

# Find linked issue
LINKED_ISSUE=$(echo "$PR_BODY" | grep -oE '(closes|fixes|addresses|resolves) #[[:digit:]]+' | grep -oE '[[:digit:]]+' | head -1)

if [ -n "$LINKED_ISSUE" ]; then
  ISSUE_TITLE=$(gh issue view "$LINKED_ISSUE" --json title -q '.title' 2>/dev/null || echo "")
  ISSUE_BODY=$(gh issue view "$LINKED_ISSUE" --json body -q '.body' 2>/dev/null || echo "")
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
  \"reviewer\": \"${REVIEWER}\",
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
<files_to_read>
- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each, follow relevant rules)
</files_to_read>

You are a senior code reviewer. Perform deep PR analysis addressing five dimensions.

**Important context about this repository:** MGW is a command system — the files being reviewed
are markdown command definitions (parsed by Claude Code at invocation time), not compiled source code.
There are no automated tests. \"Run tests\" means: parse each changed .md file, verify step tags are
properly closed, check bash snippets for syntax errors, and verify all XML tags balance.

## 1. TEST THIS PR
Parse each changed .md file for structural integrity:
- All `<step name="...">` tags have matching `</step>` closings
- XML tags balance (no unclosed tags)
- Bash code blocks have no syntax errors (check conditionals, variable references)
- YAML frontmatter is valid (no XX| prefixes, valid keys only)
- Agent Task() prompts have no stray line prefixes (e.g. XX| artifacts)

## 2. WHY DO WE NEED THIS?
Analyze rationale vs linked issue #${LINKED_ISSUE:-none}:
- Does the PR solve a real problem?
- Is the problem worth solving?
- Does the approach match the stated need?

## 3. STATED INTENT VS ACTUAL CHANGES
Compare PR description vs actual diff:
- What the PR claims vs what the code actually does
- Gaps between intent and implementation
- Scope creep (changes beyond what was stated)

## 4. IMPACT ANALYSIS
For markdown command files specifically:
- Which MGW commands/workflows reference the changed files?
- Does any change break existing behavior? (regression risk)
- Are any shared workflow patterns (state.md, github.md, gsd.md, validation.md) affected?
- Security or correctness issues in bash snippets?

## 5. ARCHITECTURAL REVIEW
- Does the approach follow MGW's delegation boundary (orchestrate, never code)?
- Is state properly separated (.mgw/active/ vs .mgw/reviews/ vs .planning/)?
- Are there simpler alternatives?
- Does it introduce technical debt?

## PR Context
- **PR:** #${PR_NUMBER} - ${PR_TITLE}
- **Author:** ${PR_AUTHOR}
- **Reviewer:** ${REVIEWER}
- **Base:** ${PR_BASE} ← ${PR_HEAD}
- **Files changed:** ${FILE_COUNT}
- **Linked Issue:** ${LINKED_ISSUE:-none} ${ISSUE_TITLE:+- ${ISSUE_TITLE}}

## Linked Issue Body
${ISSUE_BODY:-N/A}

## PR Diff
\`\`\`diff
${PR_DIFF}
\`\`\`

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
```

Display structured report:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► PR DEEP REVIEW — #${PR_NUMBER}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${PR_TITLE}
Verdict: ${overall_verdict.recommendation} (${overall_verdict.confidence} confidence)

── 1. TEST ──
${test_results.summary}

── 2. RATIONALE ──
${rationale.problem_identified}
Valid: ${rationale.problem_valid} | Priority: ${rationale.priority}

── 3. INTENT vs IMPLEMENTATION ──
Gaps: ${intent_vs_implementation.gaps}
Scope creep: ${intent_vs_implementation.scope_creep}

── 4. IMPACT ──
Side effects: ${impact_analysis.side_effects}
Pattern violations: ${impact_analysis.pattern_violations}

── 5. ARCHITECTURE ──
Approach correct: ${architectural_review.approach_correct}
Recommendations: ${architectural_review.recommendations}

── VERDICT ──
${overall_verdict.summary}
Blockers: ${overall_verdict.blockers}
Concerns: ${overall_verdict.concerns}

Review state: ${REVIEW_STATE_FILE}
```

Offer follow-up actions:
```
AskUserQuestion(
  header: "Review Complete",
  question: "What would you like to do with this review?",
  options: [
    { label: "Post to PR", description: "Post review summary as PR comment" },
    { label: "Create issue", description: "File a follow-up issue for blockers/concerns" },
    { label: "Done", description: "Review recorded in .mgw/reviews/" }
  ]
)
```

If "Post to PR": post `overall_verdict.summary` + blockers/concerns as a PR comment via `gh pr comment ${PR_NUMBER} --body "..."`.
If "Create issue": offer to file a new GitHub issue with the blockers as the body.
</step>

</process>

<success_criteria>
- [ ] Mode detection correctly routes: --pr flag, PR URL, and bare PR numbers (via gh pr view probe) enter PR mode
- [ ] Issue comment review (Mode 1) classifies all four types and offers correct AskUserQuestion actions
- [ ] Issue state file updated according to user choice (last_comment_count, pipeline_stage)
- [ ] PR deep review (Mode 2) fetches diff and passes it to the reviewer agent
- [ ] Reviewer agent prompt is domain-aware (markdown command files, not compiled code)
- [ ] Review results stored in .mgw/reviews/ and presented with follow-up actions
- [ ] State properly separated (.mgw/reviews/ for PR, .mgw/active/ for issues)
- [ ] reviewer field reflects the current user, not the PR author
</success_criteria>
