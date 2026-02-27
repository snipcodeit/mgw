# Troubleshooting

Common issues and their solutions when working with MGW.

---

## Authentication Issues

### GitHub CLI Not Authenticated

```
Error: gh: not logged in
```

**Fix:** Run `gh auth status` to check. If not authenticated:

```bash
gh auth login
# Select GitHub.com, HTTPS, and authenticate via browser
```

MGW requires the `repo` scope. If you are authenticated but getting permission errors:

```bash
gh auth login --scopes repo
```

### Claude CLI Not Installed

```
Error: claude CLI is not installed.
Install it with: npm install -g @anthropic-ai/claude-code
Then run: claude login
```

**Fix:** Install Claude Code and authenticate. Non-AI commands (`sync`, `issues`, `link`, `help`) work without Claude -- see [[Commands Reference]] for which commands require it.

### Claude CLI Not Authenticated

```
Error: claude CLI is not authenticated.
Run: claude login
```

**Fix:** Run `claude login` and follow the prompts.

---

## GSD Issues

### GSD Not Installed

```
Error: GSD slash commands not found
```

**Fix:** Install GSD at the standard location:

```bash
git clone https://github.com/glittercowboy/get-shit-done.git ~/.claude/get-shit-done
```

Verify:

```
/gsd:quick --help
```

### GSD Tools Not Found

```
Error: GSD tools not found at ~/.claude/get-shit-done/bin/gsd-tools.cjs
```

**Fix:** Ensure GSD is installed at `~/.claude/get-shit-done/`. If it is installed elsewhere, check if a symlink exists.

---

## State Issues

### State Drift

Local `.mgw/` state can fall out of sync with GitHub if you merge PRs from the web UI, close issues manually, or work from a different machine.

**Fix:**

```
/mgw:sync
```

This archives completed issues, flags stale branches, and catches drift.

### Corrupted State Files

If `.mgw/` JSON files become corrupted:

```bash
# Validate JSON
python3 -c "import json; json.load(open('.mgw/project.json'))"

# If corrupt, remove and re-initialize
rm -rf .mgw/
/mgw:init
/mgw:project   # If you need project tracking
```

### Missing `.mgw/` Directory

If you cloned a repo that uses MGW but don't have a `.mgw/` directory:

```
/mgw:init
```

This won't affect anything on GitHub. The `.mgw/` directory is local-only and gitignored.

### No Project Initialized

```
Error: No project initialized
```

Commands like `/mgw:next` and `/mgw:milestone` require project state.

**Fix:** Either scaffold a project:

```
/mgw:project
```

Or run individual issues without project state:

```
/mgw:run 42
```

`/mgw:run` works with or without `project.json`.

---

## Worktree Issues

### Stale Worktrees After Crash

If a session ends without cleaning up worktrees:

```bash
# List active worktrees
git worktree list

# Remove a specific worktree
git worktree remove .worktrees/issue/42-fix-auth

# Force remove if there are uncommitted changes
git worktree remove .worktrees/issue/42-fix-auth --force

# Prune all stale worktree references
git worktree prune

# Clean up empty directories
rmdir .worktrees/issue .worktrees 2>/dev/null
```

The associated branches are not deleted automatically. Clean them up after removing the worktree:

```bash
git branch -d issue/42-fix-auth
```

### Branch Already Exists

```
Error: Branch already exists
```

A previous pipeline run created the branch.

**Fix:** Delete the branch and retry:

```bash
git branch -D issue/42-fix-auth
/mgw:run 42
```

Or use the existing branch if the work is still relevant.

---

## Pipeline Issues

### Pipeline Failed (No PR Created)

When `/mgw:run` fails to produce a PR:

1. **Check the issue comments** -- MGW posts a `pipeline-failed` comment with details
2. **Check for a lingering worktree:**
   ```bash
   git worktree list
   cd .worktrees/issue/42-fix-auth
   git log --oneline
   ```
3. **Clean up and retry:**
   ```bash
   git worktree remove .worktrees/issue/42-fix-auth
   /mgw:run 42
   ```

### Blocked by Stakeholder Comment

If a blocking comment is detected during pre-flight:

1. Pipeline pauses with `pipeline_stage: "blocked"`
2. A `pipeline-blocked` comment is posted
3. **Fix:** Resolve the blocker (reply on the issue, update requirements)
4. Re-run: `/mgw:run 42`

### No GSD Route Determined

```
Error: No GSD route determined
```

Triage couldn't determine issue scope.

**Fix:** Run triage manually to inspect the output:

```
/mgw:issue 42
```

### Merge Conflict in Worktree

The main branch diverged during execution.

**Fix:** Resolve conflicts in the worktree, then resume:

```
/mgw:run 42
```

---

## GitHub API Issues

### Rate Limiting

```
Error: API rate limit exceeded
```

MGW posts comments on issues at each pipeline stage. If you're executing many issues quickly via `/mgw:milestone`, you may hit rate limits.

**Check your current rate limit:**

```bash
gh api rate_limit --jq '.resources.core'
```

**Fix:** Wait for the reset window (usually under an hour) or reduce concurrent pipelines. Authenticated requests get 5,000 requests per hour.

### Issue Not Found

```
Error: Issue #N not found
```

The issue doesn't exist or is in a different repo.

**Fix:** Check the issue number and ensure you are in the correct repo.

### Permission Denied

```
Error: Permission denied
```

GitHub token lacks required scopes.

**Fix:** Re-authenticate:

```bash
gh auth login --scopes repo
```

---

## Dependency Issues

### Circular Dependencies

If `/mgw:milestone` reports a circular dependency:

1. Check the reported issue slugs
2. Review `blocked-by` labels on GitHub
3. Remove the circular label:
   ```bash
   gh issue edit 42 --remove-label "blocked-by:#43"
   ```
4. Update `depends_on_slugs` in `.mgw/project.json` if needed
5. Re-run: `/mgw:milestone`

---

## Slash Command Issues

### Slash Commands Not Appearing in Claude Code

```bash
# Verify commands are deployed
ls ~/.claude/commands/mgw/
# Should list .md files

# If missing, redeploy
mkdir -p ~/.claude/commands/mgw/workflows
cp -r /path/to/mgw/.claude/commands/mgw/* ~/.claude/commands/mgw/
```

### Not a Git Repository

```
Error: Not a git repository
```

MGW requires a git repository with a GitHub remote.

**Verify:**

```bash
git rev-parse --show-toplevel
gh repo view
```

---

## Common Errors Quick Reference

| Error | Cause | Fix |
|-------|-------|-----|
| `Issue #N not found` | Issue doesn't exist or wrong repo | Check issue number and repo |
| `Branch already exists` | Previous pipeline created the branch | Delete branch or use existing |
| `No GSD route determined` | Triage couldn't determine scope | Run `/mgw:issue N` manually |
| `Merge conflict in worktree` | Main branch diverged during execution | Resolve conflicts, then resume |
| `Permission denied` | Token lacks scopes | `gh auth login --scopes repo` |
| `API rate limit exceeded` | Too many API calls | Wait for reset or reduce concurrency |
| `GSD tools not found` | GSD not installed | Clone GSD to `~/.claude/get-shit-done/` |
| `claude CLI is not installed` | Claude Code not installed | Install and authenticate Claude Code |
| `No project initialized` | Missing project.json | Run `/mgw:project` or use `/mgw:run` directly |

---

## Resuming After Failure

### `/mgw:run` Failed Mid-Execution

The worktree and branch still exist. Simply re-run:

```
/mgw:run 42
```

MGW detects existing state and resumes.

### `/mgw:milestone` Failed

Re-run -- completed issues are skipped:

```
/mgw:milestone
```

### Complete Reset

If nothing else works:

```bash
# Clean up worktrees
git worktree prune
rm -rf .worktrees/

# Reset state
rm -rf .mgw/
/mgw:init
```

---

## Uninstalling MGW

```bash
# Remove CLI
npm unlink mgw

# Remove slash commands
rm -rf ~/.claude/commands/mgw/

# Remove local state (per-repo, if initialized)
rm -rf .mgw/
```

---

## Next Steps

- [[Commands Reference]] -- Full command documentation
- [[Configuration]] -- State files and settings
- [[Workflow Guide]] -- Usage patterns
- [[Home]] -- Back to overview
