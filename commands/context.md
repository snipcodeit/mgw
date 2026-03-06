---
name: mgw:context
description: Show assembled context for an issue — what GSD agents see before planning/execution
argument-hint: "<issue-number>"
allowed-tools:
  - Bash
  - Read
---

<objective>
Display the full assembled context for a GitHub issue, showing exactly what a GSD agent
would receive as input before planning or execution. Useful for debugging context gaps,
verifying that prior phase summaries are available, and checking what a second developer's
agent will see.

This command is read-only. It does not modify any state.
</objective>

<process>

<step name="validate_input">
**Validate issue number provided:**

Parse $ARGUMENTS for a numeric issue number. If missing:
```
AskUserQuestion(
  header: "Issue Number Required",
  question: "Which issue number do you want context for?",
  followUp: "Enter the GitHub issue number (e.g., 42)"
)
```
</step>

<step name="assemble_and_display">
**Assemble full context from GitHub and display formatted output:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)

node -e "
const ic = require('${REPO_ROOT}/lib/issue-context.cjs');

(async () => {
  // Assemble issue context
  const ctx = await ic.assembleIssueContext(${ISSUE_NUMBER});
  if (!ctx || !ctx.issue) {
    console.log('No context found for issue #${ISSUE_NUMBER}.');
    process.exit(0);
  }

  const issue = ctx.issue;
  const milestone = issue.milestone || {};
  const labels = (issue.labels || []).map(l => typeof l === 'object' ? l.name : l);

  // Header
  console.log('');
  console.log('Issue #' + issue.number + ': ' + issue.title);
  if (milestone.title) {
    console.log('Milestone: ' + milestone.title);
  }
  console.log('Status: ' + (issue.state || 'unknown'));
  if (labels.length > 0) {
    console.log('Labels: ' + labels.join(', '));
  }

  // Vision
  const vision = await ic.fetchProjectVision();
  if (vision) {
    console.log('');
    console.log('-- Vision --');
    console.log(vision.slice(0, 2000));
  }

  // Prior phases (from milestone siblings)
  if (ctx.milestoneContext && ctx.milestoneContext.length > 0) {
    console.log('');
    console.log('-- Prior Phases --');
    for (const s of ctx.milestoneContext) {
      if (s.issueNumber === issue.number) continue;
      console.log('Phase #' + s.issueNumber + ': ' + s.title);
      if (s.summary) {
        // Indent summary lines
        const lines = s.summary.split('\\n').slice(0, 5);
        for (const line of lines) {
          console.log('  ' + line);
        }
      }
    }
  }

  // Phase goal (from issue body)
  if (issue.body) {
    console.log('');
    console.log('-- Phase Goal --');
    // Extract acceptance criteria or goal sections from body
    const body = issue.body;
    const goalMatch = body.match(/##?\\s*(?:Goal|Description|Overview)\\s*\\n([\\s\\S]*?)(?=\\n##|$)/i);
    if (goalMatch) {
      console.log(goalMatch[1].trim().slice(0, 1000));
    } else {
      // Show first meaningful paragraph
      const paras = body.split('\\n\\n').filter(p => p.trim() && !p.startsWith('<!--'));
      if (paras.length > 0) {
        console.log(paras[0].trim().slice(0, 1000));
      }
    }

    const acMatch = body.match(/##?\\s*Acceptance\\s*Criteria\\s*\\n([\\s\\S]*?)(?=\\n##|$)/i);
    if (acMatch) {
      console.log('');
      console.log('-- Acceptance Criteria --');
      console.log(acMatch[1].trim().slice(0, 1000));
    }
  }

  // Dependencies (from labels)
  const blockedBy = labels.filter(l => l.startsWith('blocked-by:'));
  const blocks = labels.filter(l => l.startsWith('blocks:'));
  if (blockedBy.length > 0 || blocks.length > 0) {
    console.log('');
    console.log('-- Dependencies --');
    if (blockedBy.length > 0) {
      console.log('Blocked by: ' + blockedBy.map(l => l.replace('blocked-by:', '')).join(', '));
    }
    if (blocks.length > 0) {
      console.log('Blocks: ' + blocks.map(l => l.replace('blocks:', '')).join(', '));
    }
  }

  // Plan (if posted)
  if (ctx.planComment) {
    console.log('');
    console.log('-- Plan (from structured comment) --');
    const planBody = ctx.planComment.body.replace(/<!--[\\s\\S]*?-->\\n?/, '').trim();
    console.log(planBody.slice(0, 2000));
  }

  // Summary (if posted)
  if (ctx.summaryComment) {
    console.log('');
    console.log('-- Summary (from structured comment) --');
    const summaryBody = ctx.summaryComment.body.replace(/<!--[\\s\\S]*?-->\\n?/, '').trim();
    console.log(summaryBody.slice(0, 1000));
  }

  console.log('');
})().catch(e => {
  console.error('Error assembling context: ' + e.message);
  process.exit(1);
});
" 2>/dev/null
```
</step>

<step name="display">
**Display context report with banner:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► CONTEXT FOR #${ISSUE_NUMBER}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${FORMATTED_OUTPUT}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tip: This is what GSD agents see before planning.
  → /mgw:run ${ISSUE_NUMBER}  — Execute this issue
  → /mgw:status              — Project dashboard
```
</step>

</process>

<success_criteria>
- [ ] Issue number validated
- [ ] Issue context assembled from GitHub comments via assembleIssueContext()
- [ ] Vision fetched via fetchProjectVision() (GitHub Project README first, local fallback)
- [ ] Output formatted with clear section headers (Vision, Prior Phases, Phase Goal, etc.)
- [ ] Acceptance criteria extracted from issue body when present
- [ ] Dependencies shown from labels
- [ ] Plan and summary comments displayed when available
- [ ] No state modified
</success_criteria>
