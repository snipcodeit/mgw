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
