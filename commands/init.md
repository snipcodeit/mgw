---
name: mgw:init
description: Bootstrap current repo for MGW integration — creates .mgw/ state, GitHub templates, gitignore entries, and optionally installs shell completions
argument-hint: ""
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
---

<objective>
One-time setup for a repo to work with MGW. Creates the .mgw/ state directory,
GitHub issue/PR templates, and ensures gitignore entries. Safe to re-run — skips
anything that already exists.
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

<step name="install_completions">
<!-- MERGE NOTE: PR #125 (config wizard) also modifies commands/init.md.
     Resolve conflict when merging — include both install_completions and run_config_wizard steps. -->
**Offer to install shell completions (opt-in):**

Locate the completions directory bundled with the MGW package:
```bash
MGW_PKG_DIR=$(node -e "const path = require('path'); console.log(path.resolve(__dirname, '..', '..'))" 2>/dev/null || echo "")
COMPLETIONS_DIR="${MGW_PKG_DIR}/completions"
```

If completions are not found (package not globally installed or completions dir absent) → skip silently, note "Shell completions not available (mgw not installed globally)" in report.

If completions are found, detect the user's shell and determine the install target:
```bash
CURRENT_SHELL=$(basename "${SHELL:-}")
```

Shell → target directory mapping:
- `bash` → `~/.local/share/bash-completion/completions/` (source file: `mgw.bash`)
- `zsh`  → `~/.zsh/completions/` (source file: `mgw.zsh`)
- `fish` → `~/.config/fish/completions/` (source file: `mgw.fish`)

If shell is unrecognized or `SHELL` is unset → show all three install commands and skip auto-install.

**Interactive mode (default):** Ask the user:
```
Shell completions are available for ${CURRENT_SHELL}.

Install to ${COMPLETION_TARGET_DIR}? [Y/n]
```

If the user answers yes (or presses Enter for the default):
```bash
mkdir -p "${COMPLETION_TARGET_DIR}"
cp "${COMPLETIONS_DIR}/mgw.${SHELL_EXT}" "${COMPLETION_TARGET_DIR}/mgw.${SHELL_EXT}"
```

Then show the source/activation line appropriate for the shell:
- bash: `# Reload with: source ~/.local/share/bash-completion/completions/mgw.bash`
  (or add to ~/.bashrc: `source ~/.local/share/bash-completion/completions/mgw.bash`)
- zsh: Add to ~/.zshrc (required — ~/.zsh/completions is not in default $fpath):
  ```
  fpath=(~/.zsh/completions $fpath)
  autoload -Uz compinit
  compinit
  ```
  Then reload: `source ~/.zshrc`
- fish: `# Completions loaded automatically from ~/.config/fish/completions/`

If user answers no → skip, note "Shell completions: skipped" in report.

If the completion file already exists at the target → overwrite (idempotent re-run).

**Non-interactive mode** (stdin is not a TTY): Skip the prompt entirely, print the install command as a hint:
```
  Shell completions available. Install manually:
    cp ${COMPLETIONS_DIR}/mgw.${SHELL_EXT} ${COMPLETION_TARGET_DIR}/mgw.${SHELL_EXT}
```
</step>

<step name="report">
**Report setup status:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► INIT — ${REPO_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  .mgw/                  ${created|exists}
  .mgw/cross-refs.json   ${created|exists}
  .gitignore entries     ${added|exists}
  Issue templates        ${created|exists}
  PR template            ${created|exists}
  GitHub labels          synced
  MGW pipeline labels    synced (7 labels)
  Shell completions      ${installed (bash|zsh|fish)|skipped|not available}

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
- [ ] Issue templates created (bug + enhancement)
- [ ] PR template created
- [ ] GitHub labels ensured (bug, enhancement)
- [ ] MGW pipeline labels ensured (7 mgw:* labels)
- [ ] Shell completion install offered (interactive) or hint printed (non-interactive)
- [ ] Completion install skipped gracefully if completions dir not found
- [ ] Setup report shown with completion status line
</success_criteria>
