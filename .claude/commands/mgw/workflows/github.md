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

## Consumers

| Section | Referenced By |
|---------|-------------|
| Issue Operations | issue.md, run.md, issues.md, sync.md |
| Issue Mutations | issue.md, update.md, run.md, init.md |
| PR Operations | pr.md, run.md, sync.md |
| Repo Metadata | init.md, issues.md, run.md, pr.md |
| User Identity | issue.md |
| Remote Operations | sync.md, run.md |
| Batch Operations | state.md (staleness detection) |
