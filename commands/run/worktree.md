---
name: mgw:run/worktree
description: Create isolated worktree for issue work
---

<step name="create_worktree">
**Create isolated worktree for issue work:**

Derive branch and worktree path:
```bash
BRANCH_NAME="issue/${ISSUE_NUMBER}-${slug}"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/${BRANCH_NAME}"
```

**Check for active work on this issue by another developer:**
```bash
# Check 1: Remote branch already exists (another machine pushed work)
REMOTE_BRANCHES=$(git ls-remote --heads origin "issue/${ISSUE_NUMBER}-*" 2>/dev/null | awk '{print $2}' | sed 's|refs/heads/||')
if [ -n "$REMOTE_BRANCHES" ]; then
  echo "WARNING: Remote branch(es) already exist for issue #${ISSUE_NUMBER}:"
  echo "$REMOTE_BRANCHES" | sed 's/^/  /'
  echo ""
  AskUserQuestion(
    header: "Active Work Detected",
    question: "Remote branch exists for #${ISSUE_NUMBER}. Another developer may be working on this. Proceed anyway?",
    options: [
      { label: "Proceed", description: "Create a new worktree anyway (may cause conflicts)" },
      { label: "Abort", description: "Stop pipeline — coordinate with the other developer first" }
    ]
  )
  if [ "$USER_CHOICE" = "Abort" ]; then
    echo "Pipeline aborted — coordinate with the developer who owns the existing branch."
    exit 1
  fi
fi

# Check 2: Open PR already exists for this issue
EXISTING_PR=$(gh pr list --search "issue/${ISSUE_NUMBER}-" --state open --json number,headRefName --jq '.[0].number' 2>/dev/null || echo "")
if [ -n "$EXISTING_PR" ]; then
  echo "WARNING: Open PR #${EXISTING_PR} already exists for issue #${ISSUE_NUMBER}."
  echo "Creating a new worktree will produce a conflicting PR."
  AskUserQuestion(
    header: "Open PR Exists",
    question: "PR #${EXISTING_PR} is already open for this issue. Proceed with a new worktree?",
    options: [
      { label: "Proceed", description: "Create new worktree anyway" },
      { label: "Abort", description: "Stop — review the existing PR first" }
    ]
  )
  if [ "$USER_CHOICE" = "Abort" ]; then
    exit 1
  fi
fi
```

Ensure .worktrees/ is gitignored:
```bash
mkdir -p "$(dirname "${WORKTREE_DIR}")"
if ! git check-ignore -q .worktrees 2>/dev/null; then
  echo ".worktrees/" >> "${REPO_ROOT}/.gitignore"
fi
```

Create worktree with feature branch:
```bash
# If worktree already exists (resume in same session), skip creation
if [ -d "${WORKTREE_DIR}" ]; then
  echo "Worktree exists, reusing"
# If branch already exists (resume from prior session)
elif git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  git worktree add "${WORKTREE_DIR}" "${BRANCH_NAME}"
# New branch (first run)
else
  git worktree add "${WORKTREE_DIR}" -b "${BRANCH_NAME}"
fi
```

**Switch working directory to worktree:**
```bash
cd "${WORKTREE_DIR}"
```

Update state (at `${REPO_ROOT}/.mgw/active/`): add branch to linked_branches.
Add cross-ref (at `${REPO_ROOT}/.mgw/cross-refs.json`): issue → branch.

**Apply in-progress label:**
```bash
remove_mgw_labels_and_apply ${ISSUE_NUMBER} "mgw:in-progress"
```

**PATH CONVENTION for remaining steps:**
- File operations, git commands, and agent work use **relative paths** (CWD = worktree)
- `.mgw/` state operations use **absolute paths**: `${REPO_ROOT}/.mgw/`
  (`.mgw/` is gitignored — it only exists in the main repo, not the worktree)
</step>
