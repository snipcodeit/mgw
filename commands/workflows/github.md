<purpose>
Shared GitHub CLI patterns for all MGW commands. Commands reference these patterns
instead of inventing their own gh calls. Every gh command used by MGW should be
documented here with a copy-paste-ready bash snippet.
</purpose>

## Issue Operations

### Fetch Single Issue
Used when triaging or loading issue context.
```bash
# Full issue data for triage/analysis
gh issue view $ISSUE_NUMBER --json number,title,body,labels,assignees,state,comments,url,milestone
```

### List Issues with Filters
Used by browse commands. Default: assigned to current user, open, limit 25.
```bash
# Default: your open issues
gh issue list --assignee @me --state open --limit 25 --json number,title,labels,createdAt,comments,assignees

# With filters (replace as needed)
gh issue list --label "$LABEL" --milestone "$MILESTONE" --assignee "$USER" --state "$STATE" --limit 25 --json number,title,labels,createdAt,comments,assignees
```

### Check Issue State
Used by sync and staleness detection to check if an issue is still open.
```bash
gh issue view ${NUMBER} --json state,closed -q '{state: .state, closed: .closed}'
```

### Check Issue Updated Timestamp
Used by staleness detection to compare GitHub state with local state.
```bash
gh issue view ${ISSUE_NUMBER} --json updatedAt -q .updatedAt
```

### Get Comment Count
Used by comment tracking to get the current number of comments on an issue.
```bash
gh issue view ${ISSUE_NUMBER} --json comments --jq '.comments | length'
```

### Get Recent Comments
Used by pre-flight comment check and review command to fetch new comments since triage.
```bash
# Fetch last N comments with author, body, and timestamp
NEW_COUNT=$((CURRENT_COMMENTS - STORED_COMMENTS))
gh issue view ${ISSUE_NUMBER} --json comments \
  --jq "[.comments[-${NEW_COUNT}:]] | .[] | {author: .author.login, body: .body, createdAt: .createdAt}"
```

### Get Last Comment Timestamp
Used during triage to snapshot the most recent comment timestamp.
```bash
gh issue view ${ISSUE_NUMBER} --json comments \
  --jq '.comments[-1].createdAt // empty'
```

## Issue Mutations

### Assign to Self
Used when claiming an issue during triage.
```bash
GH_USER=$(gh api user -q .login)
gh issue edit $ISSUE_NUMBER --add-assignee @me
```

### Post Issue Comment
Used for status updates, triage results, and pipeline notifications.
```bash
gh issue comment ${ISSUE_NUMBER} --body "$COMMENT_BODY"
```

### Manage Labels
Used during repo initialization to ensure standard labels exist.
```bash
# --force updates existing labels without error
gh label create "$LABEL_NAME" --description "$DESCRIPTION" --color "$HEX_COLOR" --force
```

## Label Lifecycle Operations

### MGW Pipeline Labels
Seven labels for pipeline stage tracking. Created by init.md, managed by issue.md and run.md.

| Label | Color | Description |
|-------|-------|-------------|
| `mgw:triaged` | `0e8a16` | Issue triaged and ready for pipeline |
| `mgw:needs-info` | `e4e669` | Blocked — needs more detail or clarification |
| `mgw:needs-security-review` | `d93f0b` | Blocked — requires security review |
| `mgw:discussing` | `c5def5` | Under discussion — not yet approved |
| `mgw:approved` | `0e8a16` | Discussion complete — approved for execution |
| `mgw:in-progress` | `1d76db` | Pipeline actively executing |
| `mgw:blocked` | `b60205` | Pipeline blocked by stakeholder comment |

### Remove MGW Labels and Apply New
Used when transitioning pipeline stages. Removes all `mgw:*` pipeline labels, then applies the target label.
```bash
# Remove all mgw: pipeline labels from issue, then apply new one
remove_mgw_labels_and_apply() {
  local ISSUE_NUMBER="$1"
  local NEW_LABEL="$2"

  # Get current labels
  CURRENT_LABELS=$(gh issue view "$ISSUE_NUMBER" --json labels --jq '.labels[].name' 2>/dev/null)

  # Remove any mgw: pipeline labels
  for LABEL in $CURRENT_LABELS; do
    case "$LABEL" in
      mgw:triaged|mgw:needs-info|mgw:needs-security-review|mgw:discussing|mgw:approved|mgw:in-progress|mgw:blocked)
        gh issue edit "$ISSUE_NUMBER" --remove-label "$LABEL" 2>/dev/null
        ;;
    esac
  done

  # Apply new label
  if [ -n "$NEW_LABEL" ]; then
    gh issue edit "$ISSUE_NUMBER" --add-label "$NEW_LABEL" 2>/dev/null
  fi
}
```

## Triage Comment Templates

### Gate Blocked Comment
Posted immediately during /mgw:issue when triage gates fail.
```bash
GATE_BLOCKED_BODY=$(cat <<COMMENTEOF
> **MGW** . \`triage-blocked\` . ${TIMESTAMP}

### Triage: Action Required

| Gate | Result |
|------|--------|
${GATE_TABLE_ROWS}

**What's needed:**
${MISSING_FIELDS_LIST}

Please update the issue with the required information, then re-run \`/mgw:issue ${ISSUE_NUMBER}\`.
COMMENTEOF
)
gh issue comment ${ISSUE_NUMBER} --body "$GATE_BLOCKED_BODY" 2>/dev/null || true
```

### Gate Passed Comment
Posted immediately during /mgw:issue when all triage gates pass.
```bash
GATE_PASSED_BODY=$(cat <<COMMENTEOF
> **MGW** . \`triage-complete\` . ${TIMESTAMP}

### Triage Complete

| | |
|---|---|
| **Scope** | ${SCOPE_SIZE} -- ${FILE_COUNT} files across ${SYSTEM_LIST} |
| **Validity** | ${VALIDITY} |
| **Security** | ${SECURITY_RISK} |
| **Route** | \`${gsd_route}\` -- ${ROUTE_REASONING} |
| **Gates** | All passed |

Ready for pipeline execution.
COMMENTEOF
)
gh issue comment ${ISSUE_NUMBER} --body "$GATE_PASSED_BODY" 2>/dev/null || true
```

### Scope Proposal Comment
Posted when new-milestone route triggers discussion phase.
```bash
SCOPE_PROPOSAL_BODY=$(cat <<COMMENTEOF
> **MGW** . \`scope-proposal\` . ${TIMESTAMP}

### Scope Proposal: Discussion Requested

This issue was triaged as **${SCOPE_SIZE}** scope requiring the \`new-milestone\` route.

**Proposed breakdown:**
${SCOPE_BREAKDOWN}

**Estimated phases:** ${PHASE_COUNT}

Please review and confirm scope, or suggest changes. Once approved, run \`/mgw:run ${ISSUE_NUMBER}\` to begin execution.
COMMENTEOF
)
gh issue comment ${ISSUE_NUMBER} --body "$SCOPE_PROPOSAL_BODY" 2>/dev/null || true
```

## Milestone Operations

### Create Milestone
Used when scaffolding a project structure from a template.
```bash
# Create milestone and capture number + ID for subsequent operations
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
MILESTONE_JSON=$(gh api "repos/${REPO}/milestones" --method POST \
  -f title="$MILESTONE_TITLE" \
  -f description="$MILESTONE_DESCRIPTION" \
  -f state="open")

# milestone.number: used for issue assignment (-F milestone=N)
# milestone.id: stored in project.json for cross-referencing
MILESTONE_NUMBER=$(echo "$MILESTONE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])")
MILESTONE_ID=$(echo "$MILESTONE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
MILESTONE_URL=$(echo "$MILESTONE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['html_url'])")
```

Note: There is no native `gh milestone` subcommand. Always use `gh api repos/{owner}/{repo}/milestones`.

### Create Issue with Milestone
Used when scaffolding issues from a template. Assigns to milestone in a single API call.
```bash
# -F (not -f) for milestone — sends as integer, not string
ISSUE_JSON=$(gh api "repos/${REPO}/issues" --method POST \
  -f title="$ISSUE_TITLE" \
  -f body="$ISSUE_BODY" \
  -F milestone="$MILESTONE_NUMBER" \
  -f "labels[]=$LABEL1" \
  -f "labels[]=$LABEL2")

ISSUE_NUMBER=$(echo "$ISSUE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])")
```

### Create and Apply Dependency Labels
Used after all issues are created to apply blocked-by relationships.
Two-pass required: issue numbers are only known after creation.
```bash
# Step 1: Create label (idempotent with --force)
gh label create "blocked-by:#${BLOCKING_ISSUE}" \
  --description "Blocked by issue #${BLOCKING_ISSUE}" \
  --color "e4e669" \
  --force

# Step 2: Apply label to dependent issue
gh issue edit "${DEPENDENT_ISSUE}" --add-label "blocked-by:#${BLOCKING_ISSUE}"
```

Note: `#` in label names works with `gh label create` and `gh issue edit --add-label`.
For API path access (e.g., deletion), URL-encode `#` as `%23`.

### Create Phase Labels
Used during project init to create phase tracking labels.
```bash
gh label create "phase:${PHASE_NUMBER}-${PHASE_SLUG}" \
  --description "Phase ${PHASE_NUMBER}: ${PHASE_NAME}" \
  --color "0075ca" \
  --force
```

## PR Operations

### Create PR
Used after GSD execution to open a pull request.
```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
gh pr create --title "$PR_TITLE" --base "$DEFAULT_BRANCH" --head "$BRANCH_NAME" --body "$PR_BODY"
```

### Post PR Comment
Used to add testing procedures or follow-up notes to a PR.
```bash
gh pr comment ${PR_NUMBER} --body "$COMMENT_BODY"
```

### Check PR State
Used by sync to determine if a linked PR was merged or closed.
```bash
gh pr view ${PR_NUMBER} --json state,mergedAt -q '{state: .state, mergedAt: .mergedAt}'
```

## Repo Metadata

### Get Repo Name
Used for display and verification that we're in a GitHub repo.
```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

### Get Default Branch
Used to determine the base branch for PRs and worktree creation.
```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
```

## User Identity

### Get Current User
Used to check if current user is assigned to an issue.
```bash
GH_USER=$(gh api user -q .login)
```

## Remote Operations

### Check Remote Branch Exists
Used by sync to verify if a branch still exists on the remote.
```bash
git ls-remote --heads origin ${BRANCH_NAME} | grep -q . && echo "remote" || echo "no-remote"
```

### Push Branch with Upstream
Used after GSD execution to push the feature branch for PR creation.
```bash
git push -u origin ${BRANCH_NAME}
```

## Batch Operations (GraphQL)

### Batch Issue Staleness Check
Used by staleness detection to check multiple issues in a single API call.
```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)

gh api graphql -f query='
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issues(first: 50, states: OPEN) {
        nodes { number updatedAt }
      }
    }
  }
' -f owner="$OWNER" -f repo="$REPO" --jq '.data.repository.issues.nodes'
```

## Rate Limit

### Check Rate Limit
Used before batch operations (milestone execution) to estimate available API calls.
```bash
RATE_JSON=$(gh api rate_limit --jq '.resources.core')
REMAINING=$(echo "$RATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['remaining'])")
LIMIT=$(echo "$RATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['limit'])")
RESET_EPOCH=$(echo "$RATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['reset'])")
RESET_TIME=$(date -d "@${RESET_EPOCH}" '+%H:%M:%S' 2>/dev/null || echo "unknown")
```

Conservative estimate: ~25 API calls per `/mgw:run` invocation (triage + comments + PR creation).
If rate limit check fails (network error), log warning and proceed — never block on non-critical checks.

### Close Milestone
Used after all issues in a milestone are complete.
```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/${REPO}/milestones/${MILESTONE_NUMBER}" --method PATCH \
  -f state="closed"
```

Note: Uses same API path as Create Milestone but with PATCH method.

## Release Operations

### Create Draft Release
Used after milestone completion to create an auto-generated release summary.
```bash
RELEASE_TAG="milestone-${MILESTONE_NUM}-complete"
gh release create "$RELEASE_TAG" --draft \
  --title "Milestone ${MILESTONE_NUM}: ${MILESTONE_NAME}" \
  --notes "$RELEASE_BODY"
```

Tag format: `milestone-{N}-complete` (e.g., `milestone-1-complete`).
Release is created as draft — user reviews and publishes manually.

## Consumers

| Section | Referenced By |
|---------|-------------|
| Issue Operations | issue.md, run.md, issues.md, sync.md, milestone.md, next.md, ask.md |
| Comment Operations | issue.md (triage snapshot), run.md (pre-flight check), sync.md (drift), review.md |
| Issue Mutations | issue.md, update.md, run.md, init.md, milestone.md, ask.md |
| Milestone Operations | project.md, milestone.md |
| Dependency Labels | project.md |
| Phase Labels | project.md |
| PR Operations | pr.md, run.md, sync.md |
| Repo Metadata | init.md, issues.md, run.md, pr.md, milestone.md |
| User Identity | issue.md |
| Remote Operations | sync.md, run.md |
| Batch Operations | state.md (staleness detection) |
| Rate Limit | milestone.md |
| Release Operations | milestone.md |
| Label Lifecycle | issue.md, run.md, init.md |
| Triage Comment Templates | issue.md |
| Scope Proposal Template | run.md (new-milestone discussion) |
