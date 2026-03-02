---
name: mgw:init
description: Bootstrap current repo for MGW integration — creates .mgw/ state, GitHub templates, gitignore entries, and runs config wizard
argument-hint: "[--no-config]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
---

<objective>
One-time setup for a repo to work with MGW. Creates the .mgw/ state directory,
GitHub issue/PR templates, ensures gitignore entries, and runs an interactive
config wizard for first-time setup preferences. Safe to re-run — skips anything
that already exists. Pass --no-config to skip the wizard.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
@~/.claude/commands/mgw/workflows/validation.md
</execution_context>

<process>

<step name="verify_repo">
**Verify we're in a git repo with a GitHub remote:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
gh repo view --json nameWithOwner -q .nameWithOwner
```

If not a git repo → error: "Not a git repository. Run from a repo root."
If no GitHub remote → error: "No GitHub remote found. MGW requires a GitHub repo."

Store REPO_NAME from gh output.
</step>

<step name="init_mgw_state">
**Initialize .mgw/ directory (from state.md):**

Follow initialization procedure from @~/.claude/commands/mgw/workflows/state.md:
```bash
mkdir -p "${REPO_ROOT}/.mgw/active" "${REPO_ROOT}/.mgw/completed"
```

Ensure .mgw/ is gitignored:
```bash
if ! grep -q "^\.mgw/$" "${REPO_ROOT}/.gitignore" 2>/dev/null; then
  echo ".mgw/" >> "${REPO_ROOT}/.gitignore"
fi
```

Initialize cross-refs:
```bash
if [ ! -f "${REPO_ROOT}/.mgw/cross-refs.json" ]; then
  echo '{"links":[]}' > "${REPO_ROOT}/.mgw/cross-refs.json"
fi
```

Ensure .worktrees/ is gitignored:
```bash
if ! grep -q "^\.worktrees/$" "${REPO_ROOT}/.gitignore" 2>/dev/null; then
  echo ".worktrees/" >> "${REPO_ROOT}/.gitignore"
fi
```
</step>

<step name="create_issue_templates">
**Create GitHub issue templates (skip if they exist):**

Check for existing templates:
```bash
ls "${REPO_ROOT}/.github/ISSUE_TEMPLATE/" 2>/dev/null
```

If no templates exist, create:

`${REPO_ROOT}/.github/ISSUE_TEMPLATE/bug.yml`:
```yaml
name: Bug Report
description: Something isn't working as expected
labels: ["bug"]
body:
  - type: textarea
    id: bluf
    attributes:
      label: BLUF
      description: Bottom Line Up Front — one sentence summary of the problem
    validations:
      required: true

  - type: textarea
    id: whats-wrong
    attributes:
      label: What's Wrong
      description: What's broken, with file paths and line numbers where relevant
    validations:
      required: true

  - type: textarea
    id: whats-involved
    attributes:
      label: What's Involved
      description: Files and systems that need changes
    validations:
      required: true

  - type: textarea
    id: steps-to-fix
    attributes:
      label: Steps to Fix
      description: Suggested fix approach (optional but helpful for triage)
    validations:
      required: false

  - type: textarea
    id: context
    attributes:
      label: Additional Context
    validations:
      required: false
```

`${REPO_ROOT}/.github/ISSUE_TEMPLATE/enhancement.yml`:
```yaml
name: Enhancement
description: New feature or improvement to existing functionality
labels: ["enhancement"]
body:
  - type: textarea
    id: bluf
    attributes:
      label: BLUF
      description: Bottom Line Up Front — one sentence summary of what you want
    validations:
      required: true

  - type: textarea
    id: whats-needed
    attributes:
      label: What's Needed
      description: What should change or be added, with specifics
    validations:
      required: true

  - type: textarea
    id: whats-involved
    attributes:
      label: What's Involved
      description: Files, systems, and scope estimate
    validations:
      required: true

  - type: textarea
    id: context
    attributes:
      label: Additional Context
    validations:
      required: false
```

If templates already exist → report "Issue templates already exist, skipping."
</step>

<step name="create_pr_template">
**Create PR template (skip if exists):**

Check: `${REPO_ROOT}/.github/PULL_REQUEST_TEMPLATE.md`

If not found, create:
```markdown
## Summary
<!-- 2-4 bullets: what changed and why -->

-

Closes #<!-- issue number -->

## Changes
<!-- Group by system/module -->

-

## Test Plan
<!-- How to verify these changes work -->

- [ ]
```

If exists → report "PR template already exists, skipping."
</step>

<step name="ensure_labels">
**Ensure standard labels exist on GitHub:**

```bash
gh label create "bug" --description "Something isn't working" --color "d73a4a" --force
gh label create "enhancement" --description "New feature or improvement" --color "a2eeef" --force

# MGW pipeline labels
gh label create "mgw:triaged" --description "Issue triaged and ready for pipeline" --color "0e8a16" --force
gh label create "mgw:needs-info" --description "Blocked — needs more detail or clarification" --color "e4e669" --force
gh label create "mgw:needs-security-review" --description "Blocked — requires security review" --color "d93f0b" --force
gh label create "mgw:discussing" --description "Under discussion — not yet approved" --color "c5def5" --force
gh label create "mgw:approved" --description "Discussion complete — approved for execution" --color "0e8a16" --force
gh label create "mgw:in-progress" --description "Pipeline actively executing" --color "1d76db" --force
gh label create "mgw:blocked" --description "Pipeline blocked by stakeholder comment" --color "b60205" --force
```

`--force` updates existing labels without error.
</step>

<step name="run_config_wizard">
**Run interactive config wizard for first-time setup (skip if --no-config or config already exists):**

Check whether the wizard should run:
```bash
# Skip if --no-config flag is present
# Skip if .mgw/config.json already exists
```

Use `lib/config-wizard.cjs` to determine and execute:
```javascript
const { runWizard, shouldRunWizard } = require('./lib/config-wizard.cjs');
const mgwDir = path.join(REPO_ROOT, '.mgw');

if (shouldRunWizard(mgwDir, process.argv)) {
  await runWizard(mgwDir);
} else if (fs.existsSync(path.join(mgwDir, 'config.json'))) {
  // report: ".mgw/config.json   exists, skipping wizard"
} else {
  // report: ".mgw/config.json   skipped (--no-config)"
}
```

The wizard asks the user four questions in order:
1. **GitHub username** — auto-detected from `gh api user -q .login`; user may accept or override
2. **Default issue state filter** — `open` (default) or `all`
3. **Default issue limit** — `10`, `25` (default), or `50`
4. **Default assignee filter** — `me` (default) or `all`

Answers are written to `${REPO_ROOT}/.mgw/config.json`:
```json
{
  "github_username": "...",
  "default_issue_state": "open",
  "default_issue_limit": 25,
  "default_assignee": "me",
  "created_at": "<ISO timestamp>"
}
```

If the wizard errors or is interrupted, report the failure but do not abort the overall init — config is optional.
</step>

<step name="report">
**Report setup status:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► INIT — ${REPO_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  .mgw/                  ${created|exists}
  .mgw/cross-refs.json   ${created|exists}
  .mgw/config.json       ${written|exists|skipped}
  .gitignore entries     ${added|exists}
  Issue templates        ${created|exists}
  PR template            ${created|exists}
  GitHub labels          synced
  MGW pipeline labels    synced (7 labels)

Ready to use:
  /mgw:issues            Browse issues
  /mgw:run <number>      Full pipeline
```
</step>

</process>

<success_criteria>
- [ ] Verified git repo with GitHub remote
- [ ] .mgw/ directory structure created
- [ ] .mgw/ and .worktrees/ in .gitignore
- [ ] cross-refs.json initialized
- [ ] Config wizard run (or skipped via --no-config / pre-existing config.json)
- [ ] .mgw/config.json written with user preferences (unless skipped)
- [ ] Issue templates created (bug + enhancement)
- [ ] PR template created
- [ ] GitHub labels ensured (bug, enhancement)
- [ ] MGW pipeline labels ensured (7 mgw:* labels)
- [ ] Setup report shown
</success_criteria>
