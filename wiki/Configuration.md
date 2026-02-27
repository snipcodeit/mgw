# Configuration

MGW stores all pipeline state locally in the `.mgw/` directory at your repository root. This page covers every file in that directory, the full state schema, environment variables, and template customization.

---

## The `.mgw/` Directory

```
.mgw/
  config.json          User preferences
  project.json         Project structure: milestones, phases, issues
  active/              In-progress issue pipelines
    42-fix-auth.json   Per-issue state
  completed/           Archived state files (moved here after PR merge)
  cross-refs.json      Bidirectional links: issue <-> PR <-> branch
```

The `.mgw/` directory is:
- **Local-only** -- gitignored, per-developer
- **Safe to delete** -- run `/mgw:init` to recreate the structure; nothing on GitHub is affected
- **Created by** `/mgw:init`

---

## config.json

User-level preferences:

```json
{
  "github_username": "your-username",
  "default_assignee": "@me",
  "default_state": "open"
}
```

This file is optional. MGW falls back to sensible defaults when it is absent.

---

## project.json

Created by `/mgw:project`. Contains the full project structure:

```json
{
  "project": {
    "name": "my-app",
    "description": "A web application for ...",
    "repo": "owner/my-app",
    "template": "web-app",
    "created": "2026-02-26T10:00:00Z",
    "project_board": {
      "number": 1,
      "url": "https://github.com/orgs/owner/projects/1"
    }
  },
  "milestones": [
    {
      "github_number": 1,
      "github_id": 12345,
      "name": "v1 -- Core Features",
      "issues": [
        {
          "github_number": 10,
          "title": "Design database schema",
          "phase_number": 1,
          "phase_name": "Database Layer",
          "gsd_route": "quick",
          "labels": ["backend", "database"],
          "depends_on_slugs": [],
          "pipeline_stage": "done"
        }
      ]
    }
  ],
  "current_milestone": 1,
  "phase_map": {}
}
```

### Key Fields

| Field | Description |
|-------|-------------|
| `current_milestone` | 1-indexed pointer to the active milestone. Advanced automatically when a milestone completes. |
| `pipeline_stage` (per issue) | Progress: `new` -> `triaged` -> `planning` -> `executing` -> `verifying` -> `pr-created` -> `done` (or `failed` / `blocked`) |
| `depends_on_slugs` | Slugified issue titles for dependency resolution |
| `phase_number` | Ordering within a milestone |

---

## Issue State Files

Each in-progress issue has a JSON file at `.mgw/active/<number>-<slug>.json`:

```json
{
  "issue": {
    "number": 42,
    "title": "Fix authentication flow",
    "url": "https://github.com/owner/repo/issues/42",
    "labels": ["bug"],
    "assignee": "username"
  },
  "triage": {
    "scope": { "files": 5, "systems": ["auth", "middleware"] },
    "validity": "confirmed",
    "security_notes": "Touches auth tokens -- review required",
    "conflicts": [],
    "last_comment_count": 3,
    "last_comment_at": "2026-02-26T10:00:00Z"
  },
  "gsd_route": "quick",
  "gsd_artifacts": { "type": "quick", "path": ".planning/quick/01-fix-auth" },
  "pipeline_stage": "executing",
  "comments_posted": ["triage-complete", "work-started"],
  "linked_pr": null,
  "linked_issues": [],
  "linked_branches": ["issue/42-fix-auth"]
}
```

### Issue State Schema

| Field | Type | Description |
|-------|------|-------------|
| `issue.number` | number | GitHub issue number |
| `issue.title` | string | Issue title |
| `issue.url` | string | Full GitHub URL |
| `issue.labels` | string[] | GitHub labels |
| `issue.assignee` | string | GitHub username |
| `triage.scope.files` | number | Estimated file count |
| `triage.scope.systems` | string[] | Affected systems/modules |
| `triage.validity` | string | `"confirmed"`, `"unconfirmed"`, or `"invalid"` |
| `triage.security_notes` | string | Security concerns (empty if none) |
| `triage.conflicts` | string[] | Conflicting issues |
| `triage.last_comment_count` | number | Comment count at triage time |
| `triage.last_comment_at` | string/null | Last comment timestamp at triage |
| `gsd_route` | string | GSD route: `quick`, `quick --full`, `plan-phase`, `new-milestone`, etc. |
| `gsd_artifacts.type` | string/null | Artifact type |
| `gsd_artifacts.path` | string/null | Path to `.planning/` artifacts |
| `pipeline_stage` | string | Current stage (see [[Architecture]]) |
| `comments_posted` | string[] | Stage tags of comments already posted |
| `linked_pr` | number/null | PR number if created |
| `linked_issues` | number[] | Related issue numbers |
| `linked_branches` | string[] | Associated branch names |

---

## cross-refs.json

Tracks bidirectional relationships:

```json
{
  "links": [
    { "a": "issue:42", "b": "issue:43", "type": "related", "created": "2026-02-26T10:00:00Z" },
    { "a": "issue:42", "b": "pr:15", "type": "implements", "created": "2026-02-26T12:00:00Z" },
    { "a": "issue:42", "b": "branch:issue/42-fix-auth", "type": "tracks", "created": "2026-02-26T10:00:00Z" }
  ]
}
```

### Link Types

| From | To | Type | Meaning |
|------|----|------|---------|
| issue | issue | `related` | General cross-reference |
| issue | issue | `blocked-by` | Dependency relationship |
| issue | pr | `implements` | PR resolves the issue |
| issue | branch | `tracks` | Branch contains work for the issue |
| pr | branch | `tracks` | PR is based on the branch |

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `NO_COLOR` | Disable colored terminal output |
| `CI` | Detected automatically; disables color and interactive prompts |

---

## CLI Global Options

Every CLI subcommand supports:

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would happen without executing |
| `--json` | Output structured JSON instead of formatted text |
| `-v, --verbose` | Show API calls and file writes |
| `--debug` | Full payloads, timings, and internal state |
| `--model <model>` | Override the Claude model for AI-dependent commands (e.g., `--model claude-opus-4-6`) |

---

## GitHub Issue Templates

`/mgw:init` creates two issue templates in `.github/ISSUE_TEMPLATE/`:

- **`bug_report.yml`** -- Fields: BLUF, What's Wrong, What's Involved, Steps to Fix, Additional Context
- **`feature_request.yml`** -- Fields: BLUF, What's Needed, What's Involved, Additional Context

These structured fields help MGW's triage agent extract requirements more reliably. You can customize the templates -- MGW will work with any issue body, but structured templates produce better triage results.

---

## PR Template

`.github/PULL_REQUEST_TEMPLATE.md` provides the base structure:

```markdown
## Summary
<!-- 2-4 bullets: what changed and why -->

Closes #<!-- issue number -->

## Changes
<!-- Group by system/module -->

## Test Plan
<!-- How to verify these changes work -->
```

When MGW creates PRs via `/mgw:pr` or `/mgw:run`, it fills in these sections automatically from GSD artifacts and milestone context.

---

## Worktree Configuration

MGW creates git worktrees in `.worktrees/` for each issue pipeline:

```
.worktrees/
  issue/42-fix-auth/     # Full checkout on branch issue/42-fix-auth
  issue/71-user-reg/     # Full checkout on branch issue/71-user-reg
```

Both `.mgw/` and `.worktrees/` are added to `.gitignore` by `/mgw:init`.

The `.mgw/` directory is **not** inside worktrees. It only exists in the main repository checkout. All state operations during `/mgw:run` use absolute paths back to the main repo.

---

## Slug Format

Slugs are derived from issue titles: lowercase, spaces replaced with hyphens, truncated to 40 characters.

```
"Design Core Game Loop and Player Mechanics"
-> "design-core-game-loop-and-player-mechanic"  (truncated at 40 chars)
```

MGW uses `gsd-tools.cjs generate-slug` for consistent slug generation.

---

## Manual State Editing

If pipeline state gets out of sync, you can edit the JSON files directly:

```bash
# Mark an issue as done manually
cat .mgw/active/42-fix-auth.json | jq '.pipeline_stage = "done"' > /tmp/fix.json
mv /tmp/fix.json .mgw/active/42-fix-auth.json

# Move it to completed
mv .mgw/active/42-fix-auth.json .mgw/completed/

# Reconcile
mgw sync
```

### Complete Reset

```bash
rm -rf .mgw/
/mgw:init
```

This preserves GitHub issues, milestones, and PRs but resets all local tracking state.

---

## Next Steps

- [[Commands Reference]] -- What every command does
- [[Architecture]] -- How state flows through the system
- [[Troubleshooting]] -- When state goes wrong
