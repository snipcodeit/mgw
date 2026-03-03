---
name: mgw:review
description: Deep PR review — analyze changes, compare intent vs implementation, test, and provide architectural feedback
argument-hint: "<pr-number | pr-url>"
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
Comprehensive PR review that mimics a senior engineer's code review process. This is
problem-solving orchestration (not execution orchestration) — the reviewer has autonomy
to deeply analyze, question assumptions, and provide architectural guidance.

The review addresses five core questions:
1. **Test this PR** — Does the PR pass tests? Build? Work as expected?
2. **Why do we need this?** — Analyze the rationale, compare to linked issue
3. **They say the changes do this but here's what I'm actually seeing** — Compare stated intent vs actual changes
4. **If we add this what actually changes** — Impact analysis (side effects, dependencies, patterns)
5. **Is this something that actually should be something else** — Architectural review (alternative approaches, design patterns)

Review state is stored in .mgw/reviews/ — separate from .mgw/active/ (MGW pipeline) and
.planning/ (GSD execution). This separation gives the reviewer space to handle larger
context for these "think tank" mission-critical review processes.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/gsd.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<context>
PR reference: $ARGUMENTS (number like "42" or full URL like "https://github.com/owner/repo/pull/42")

State: .mgw/reviews/ (review-specific state, separate from pipeline state)
</context>

<process>

<step name="validate_input">
**Validate and parse PR reference:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)

# Parse PR from arguments
PR_REF="$ARGUMENTS"

# Handle various input formats
if [[ "$PR_REF" =~ ^https?://github\.com/[^/]+/[^/]+/pull/([0-9]+) ]]; then
  PR_NUMBER="${BASH_REMATCH[1]}"
elif [[ "$PR_REF" =~ ^([0-9]+)$ ]]; then
  PR_NUMBER="$PR_REF"
else
  # Try to find an open PR for the current branch
  CURRENT_BRANCH=$(git branch --show-current)
  PR_NUMBER=$(gh pr view "$CURRENT_BRANCH" --json number -q '.number' 2>/dev/null || echo "")
  
  if [ -z "$PR_NUMBER" ]; then
    AskUserQuestion(
      header: "PR Reference Required",
      question: "Which PR do you want to review?",
      options: [
        { label: "Enter PR number", description: "Type the PR number (e.g., 42)" },
        { label: "Enter PR URL", description: "Paste the full PR URL" }
      ]
    )
  fi
fi

# Verify PR exists
gh pr view "$PR_NUMBER" --json number >/dev/null 2>&1 || {
  echo "Error: PR #${PR_NUMBER} not found in this repository."
  exit 1
}
```
</step>

<step name="fetch_pr_details">
**Fetch comprehensive PR details:**

```bash
# PR metadata
PR_DATA=$(gh pr view "$PR_NUMBER" --json number,title,body,state,url,baseRefName,headRefName,author,createdAt,changedFiles)
PR_TITLE=$(echo "$PR_DATA" | jq -r '.title')
PR_BODY=$(echo "$PR_DATA" | jq -r '.body // ""')
PR_STATE=$(echo "$PR_DATA" | jq -r '.state')
PR_URL=$(echo "$PR_DATA" | jq -r '.url')
PR_BASE=$(echo "$PR_DATA" | jq -r '.baseRefName')
PR_HEAD=$(echo "$PR_DATA" | jq -r '.headRefName')
PR_AUTHOR=$(echo "$PR_DATA" | jq -r '.author.login')
PR_CREATED=$(echo "$PR_DATA" | jq -r '.createdAt')
FILE_COUNT=$(echo "$PR_DATA" | jq -r '.changedFiles')

# Fetch the diff (limited for review context)
PR_DIFF=$(gh pr diff "$PR_NUMBER" --patch 2>/dev/null | head -5000)

# List of changed files
CHANGED_FILES=$(gh pr view "$PR_NUMBER" --json files --jq '.files[].path')
```

**Find linked issue (from PR body or cross-refs):**

```bash
# Try to find issue number in PR body (Closes #N, Fixes #N, etc.)
LINKED_ISSUE=$(echo "$PR_BODY" | grep -oE '(closes|fixes|addresses|resolves) #[[:digit:]]+' | grep -oE '[[:digit:]]+' | head -1)

# Also check cross-refs.json
if [ -z "$LINKED_ISSUE" ] && [ -f "${REPO_ROOT}/.mgw/cross-refs.json" ]; then
  LINKED_ISSUE=$(python3 -c "
import json
refs = json.load(open('${REPO_ROOT}/.mgw/cross-refs.json'))
for link in refs.get('links', []):
  if link.get('type') == 'implements' and f'pr:{PR_NUMBER}' in link.get('b', ''):
    import re
    match = re.search(r'issue:(\d+)', link.get('a', ''))
    if match:
      print(match.group(1))
      break
" 2>/dev/null)
fi
```

**If linked issue exists, fetch issue context:**

```bash
if [ -n "$LINKED_ISSUE" ]; then
  ISSUE_DATA=$(gh issue view "$LINKED_ISSUE" --json number,title,body,labels,state 2>/dev/null)
  ISSUE_TITLE=$(echo "$ISSUE_DATA" | jq -r '.title')
  ISSUE_BODY=$(echo "$ISSUE_DATA" | jq -r '.body // ""')
  ISSUE_LABELS=$(echo "$ISSUE_DATA" | jq -r '.labels[]?.name' 2>/dev/null || echo "")
fi
```

**Get GSD context (if available):**

```bash
# Check for GSD artifacts related to this PR
GSD_CONTEXT=""
if [ -d ".planning" ]; then
  # Look for SUMMARY files that might match
  GSD_SUMMARY=$(find .planning -name "*-SUMMARY.md" -type f 2>/dev/null | head -3)
  if [ -n "$GSD_SUMMARY" ]; then
    GSD_CONTEXT="GSD artifacts found: $(echo $GSD_SUMMARY | tr '\n' ', ')"
  fi
fi
```
</step>

<step name="prepare_review_context">
**Prepare review directory structure:**

```bash
# Create .mgw/reviews/ directory (review-specific state)
REVIEW_DIR="${REPO_ROOT}/.mgw/reviews"
mkdir -p "$REVIEW_DIR"

# Create review-specific state file
REVIEW_ID="pr-${PR_NUMBER}-$(date +%Y%m%d-%H%M%S)"
REVIEW_STATE_FILE="${REVIEW_DIR}/${REVIEW_ID}.json"

# Initialize review state
cat > "$REVIEW_STATE_FILE" << EOF
{
  "review_id": "${REVIEW_ID}",
  "pr_number": ${PR_NUMBER},
  "pr_title": "${PR_TITLE}",
  "pr_url": "${PR_URL}",
  "linked_issue": ${LINKED_ISSUE:-null},
  "reviewer": "${PR_AUTHOR}",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "status": "in_progress",
  "analyses": {}
}
EOF
```

**Create a dedicated review context file for the agent:**

```bash
REVIEW_CONTEXT_FILE="${REVIEW_DIR}/${REVIEW_ID}-context.md"

cat > "$REVIEW_CONTEXT_FILE" << EOF
# PR Review Context

## PR Information
- **Number:** #${PR_NUMBER}
- **Title:** ${PR_TITLE}
- **URL:** ${PR_URL}
- **Author:** ${PR_AUTHOR}
- **Base Branch:** ${PR_BASE}
- **Head Branch:** ${PR_HEAD}
- **Changed Files:** ${FILE_COUNT}

## PR Description
${PR_BODY}

## Linked Issue
${LINKED_ISSUE:+- **Issue:** #${LINKED_ISSUE}
- **Title:** ${ISSUE_TITLE}
- **Labels:** ${ISSUE_LABELS}
- **Body:** ${ISSUE_BODY}
${ISSUE_BODY:+}

## GSD Context
${GSD_CONTEXT:-No GSD artifacts found for this PR.}

## Changed Files
${CHANGED_FILES}

---
This review analyzes the PR across five dimensions. The reviewer should operate
with high autonomy — questioning assumptions, identifying gaps, and proposing
alternatives where appropriate.
EOF
```
</step>

<step name="spawn_deep_reviewer">
**Spawn the deep review agent:**

This is problem-solving orchestration — the agent has full autonomy to analyze,
question, and provide architectural guidance. Unlike execution orchestration where
the goal is to produce code, here the goal is quality assurance and analysis.

```
Task(
  prompt="
KR|<files_to_read>
ST|- ./CLAUDE.md (Project instructions — if exists, follow all guidelines)
MK|- .agents/skills/ (Project skills — if dir exists, list skills, read SKILL.md for each)
KB|- ${REVIEW_CONTEXT_FILE} (Review context prepared by MGW)
</files_to_read>

KB|You are a senior code reviewer performing a comprehensive PR review. This is
KB|problem-solving orchestration — your goal is quality assurance and analysis,
KB|not code execution. You have high autonomy to question assumptions, identify
KB|gaps, and propose alternatives.

## Your Review Mission

Perform a deep analysis of PR #${PR_NUMBER} that addresses these five core questions:

### 1. TEST THIS PR
Does the PR work? Run the tests, try to build, verify the changes actually work.
- Run: npm test, npm run build, or equivalent
- Check if tests pass
- Identify any breaking changes or regressions
- Test the specific functionality if possible

### 2. WHY DO WE NEED THIS?
Analyze the rationale behind this PR.
- Compare the PR description to the linked issue (if any)
- What problem does this solve?
- Is the problem real and worth solving?
- Are there dependencies or prerequisites?

### 3. STATED INTENT VS ACTUAL CHANGES
Compare what the PR claims to do vs what it actually does.
- Extract the stated purpose from PR title, description, and linked issue
- Analyze the actual diff and code changes
- Identify gaps between intent and implementation
- Note any scope creep or drift from original intent

### 4. IMPACT ANALYSIS
What actually changes if we merge this?
- Side effects on other modules/systems
- Dependencies introduced or affected
- Pattern violations (does this match project conventions?)
- Performance implications
- Security considerations
- Backward compatibility

### 5. ARCHITECTURAL REVIEW
Is this the right approach? Could it be done better?
- Alternative approaches that weren't taken
- Design pattern consistency with the codebase
- Is this solving a symptom rather than the root cause?
- Should this be structured differently?
- Any technical debt introduced?

## Output Format

Return a comprehensive review in this format:

\`\`\`json
{
  \"test_results\": {
    \"tests_passed\": true|false,
    \"build_passed\": true|false,
    \"summary\": \"brief summary of test/build results\",
    \"details\": \"any specific test failures or build errors\"
  },
  \"rationale\": {
    \"problem_identified\": \"what problem does this solve\",
    \"problem_valid\": true|false,
    \"priority\": \"high|medium|low\",
    \"notes\": \"additional rationale analysis\"
  },
  \"intent_vs_implementation\": {
    \"stated_purpose\": \"what the PR claims to do\",
    \"actual_changes\": \"what the code actually does\",
    \"gaps\": [\"list of gaps between intent and implementation\"],
    \"scope_creep\": [\"any scope drift identified\"]
  },
  \"impact_analysis\": {
    \"side_effects\": [\"potential side effects\"],
    \"dependencies\": [\"affected dependencies\"],
    \"pattern_violations\": [\"any code pattern violations\"],
    \"security_notes\": [\"security considerations\"],
    \"performance_notes\": [\"performance implications\"]
  },
  \"architectural_review\": {
    \"approach_correct\": true|false,
    \"alternatives\": [\"alternative approaches considered\"],
    \"design_consistency\": \"consistent|needs_work|inconsistent\",
    \"root_cause_vs_symptom\": \"solving root cause|solving symptom\",
    \"technical_debt\": [\"any technical debt introduced\"],
    \"recommendations\": [\"architectural recommendations\"]
  },
  \"overall_verdict\": {
    \"recommendation\": \"approve|request_changes|needs_discussion\",
    \"confidence\": \"high|medium|low\",
    \"summary\": \"one paragraph overall assessment\",
    \"blockers\": [\"issues that must be resolved\"],
    \"concerns\": [\"issues worth discussing\"]
  }
}
\`\`\`

## Important Notes

- You MUST actually run tests and build commands — don't just analyze the code
- Be honest about limitations — if you can't verify something, say so
- Focus on quality over speed — this is a think tank process
- Question assumptions — don't take the PR description at face value
- Think about long-term implications, not just immediate functionality
  ",
  subagent_type="general-purpose",
  model="sonnet",  # Use a capable model for deep analysis
  description="Deep review PR #${PR_NUMBER}"
)
VN```

**IMPORTANT:** The agent must WRITE its analysis directly to the review state file.
After the Task() completes, MGW reads this file to get the results.

**Agent's final step:** Write analysis to `${REVIEW_STATE_FILE}`
</step>

<step name="process_review_results">
**Process and store review results:**

After the agent completes, read the structured JSON output and update the review state file:

```bash
# Read the agent's output (it should return JSON)
# Store the full review in the review state file
# Update status to completed

# Update review state file with results
node -e "
const fs = require('fs');
const statePath = '${REVIEW_STATE_FILE}';
let state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

state.status = 'completed';
state.completed_at = new Date().toISOString();
VB|# Agent writes its complete JSON analysis here - see agent prompt for exact format

fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log('Review completed and stored.');
"
VJ|"

**Read review results from file:**

```bash
# After agent completes, read the analysis from the state file
REVIEW_DATA=$(cat "${REVIEW_STATE_FILE}")

# Parse the analysis sections
TEST_RESULTS=$(echo "$REVIEW_DATA" | jq -r '.analyses.test_results // {}')
RATIONALE=$(echo "$REVIEW_DATA" | jq -r '.analyses.rationale // {}')
INTENT_VS_IMPL=$(echo "$REVIEW_DATA" | jq -r '.analyses.intent_vs_implementation // {}')
IMPACT=$(echo "$REVIEW_DATA" | jq -r '.analyses.impact_analysis // {}')
ARCH=$(echo "$REVIEW_DATA" | jq -r '.analyses.architectural_review // {}')
VERDICT=$(echo "$REVIEW_DATA" | jq -r '.analyses.overall_verdict // {}')

# Extract key fields
TESTS_PASSED=$(echo "$TEST_RESULTS" | jq -r '.tests_passed // false')
BUILD_PASSED=$(echo "$TEST_RESULTS" | jq -r '.build_passed // false')
TEST_SUMMARY=$(echo "$TEST_RESULTS" | jq -r '.summary // "No test results"')

VERDICT_REC=$(echo "$VERDICT" | jq -r '.recommendation // "needs_discussion"')
VERDICT_CONF=$(echo "$VERDICT" | jq -r '.confidence // "low"')
VERDICT_SUM=$(echo "$VERDICT" | jq -r '.summary // ""')

BLOCKERS=$(echo "$VERDICT" | jq -r '.blockers // [] | .[]' 2>/dev/null || echo "")
CONCERNS=$(echo "$VERDICT" | jq -r '.concerns // [] | .[]' 2>/dev/null || echo "")

# If review not complete, wait/notify
if [ "$(echo "$REVIEW_DATA" | jq -r '.status')" != "completed" ]; then
  echo "Review still in progress or failed. Check ${REVIEW_STATE_FILE}"
fi
```

**Optionally post review summary as PR comment:**

```
AskUserQuestion(
  header: "Post Review to PR",
  question: "Post a summary of this review as a PR comment?",
  options: [
    { label: "Yes, post summary", description: "Add review summary as PR comment" },
    { label: "No, keep private", description: "Keep review in .mgw/reviews/ only" }
  ]
)
```

KB|If yes, format and post:
```bash
# Format and post review summary
REVIEW_SUMMARY=$(node -e "
const analysis = ${AGENT_JSON_OUTPUT};
const verdict = analysis.overall_verdict;

let summary = \`## PR Review: #${PR_NUMBER}

**Verdict:** \${verdict.recommendation.toUpperCase()} | Confidence: \${verdict.confidence}

### Summary
\${verdict.summary}

### Tests
\${analysis.test_results.summary}

### Key Concerns
\${verdict.concerns.length > 0 ? verdict.concerns.map(c => '- ' + c).join('\\n') : 'None'}

### Blockers  
\${verdict.blockers.length > 0 ? verdict.blockers.map(b => '- ' + b).join('\\n') : 'None'}
\`;

// Output for shell
console.log(summary);
")

gh pr comment "$PR_NUMBER" --body "$REVIEW_SUMMARY"
```
</step>

<step name="present_review">
**Present the comprehensive review:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► PR REVIEW — #${PR_NUMBER}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Title: ${PR_TITLE}
Author: ${PR_AUTHOR}
Linked Issue: ${LINKED_ISSUE:-none}
Files Changed: ${FILE_COUNT}

VERDICT: ${overall_verdict.recommendation} (${overall_verdict.confidence} confidence)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 TEST RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${test_results.summary}
Tests Passed: ${test_results.tests_passed ? '✓' : '✗'}
Build Passed: ${test_results.build_passed ? '✓' : '✗'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 RATIONALE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Problem: ${rationale.problem_identified}
Valid: ${rationale.provalid ? '✓' : '✗'}
Priority: ${rationale.priority}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 INTENT VS IMPLEMENTATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${intent_vs_implementation.gaps.map(g => '• ' + g).join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 IMPACT ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${impact_analysis.side_effects.map(s => '• ' + s).join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ARCHITECTURAL REVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Approach Correct: ${architectural_review.approach_correct ? '✓' : '✗'}
Design Consistency: ${architectural_review.design_consistency}

Recommendations:
${architectural_review.recommendations.map(r => '• ' + r).join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 BLOCKERS & CONCERNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Blockers:
${overall_verdict.blockers.length > 0 ? overall_verdict.blockers.map(b => '• ' + b).join('\n') : '  None'}

Concerns:
${overall_verdict.concerns.length > 0 ? overall_verdict.concerns.map(c => '• ' + c).join('\n') : '  None'}

Review saved to: .mgw/reviews/${REVIEW_ID}.json
```
</step>

<step name="offer_followup">
**Offer follow-up actions:**

```
AskUserQuestion(
  header: "Review Complete",
  question: "What would you like to do with this review?",
  options: [
    { label: "Post to PR", description: "Add review summary as PR comment" },
    { label: "Create issue", description: "Create a follow-up issue for concerns" },
    { label: "Link to issue", description: "Link this review to the linked issue" },
    { label: "Done", description: "Keep review in .mgw/reviews/" }
  ]
)
```

Handle each option:
- **Post to PR**: Format summary and post via `gh pr comment`
- **Create issue**: Spawn agent to create issue with review concerns
- **Link to issue**: Add cross-ref in .mgw/cross-refs.json
- **Done**: No further action needed

</step>

</process>

<success_criteria>
- [ ] PR reference validated and parsed
- [ ] PR details fetched (diff, files, description)
- [ ] Linked issue found (from body or cross-refs)
- [ ] Review directory created (.mgw/reviews/)
- [ ] Review context file prepared
- [ ] Deep review agent spawned with full context
- [ ] Review results stored in review state file
- [ ] Review presented to user with all five analysis dimensions
- [ ] Follow-up actions offered (post, create issue, link, done)
</success_criteria>
