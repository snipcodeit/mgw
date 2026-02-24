<purpose>
Shared state management for MGW commands. All mgw: commands reference this
for .mgw/ directory initialization, issue state read/write, and cross-ref management.
</purpose>

<state_format>

## Directory Structure

`.mgw/` lives at repo root, is gitignored, and is local-only per developer.

```
.mgw/
  config.json        # User prefs (github username, default filters)
  active/            # In-progress issue pipelines
    <number>-<slug>.json
  completed/         # Archived after PR merged/issue closed
  cross-refs.json    # Bidirectional issue/PR/branch links
```

## Initialization

Before any state operation, ensure .mgw/ exists:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
MGW_DIR="${REPO_ROOT}/.mgw"
mkdir -p "${MGW_DIR}/active" "${MGW_DIR}/completed"

# Ensure gitignored
if ! grep -q "^\.mgw/$" "${REPO_ROOT}/.gitignore" 2>/dev/null; then
  echo ".mgw/" >> "${REPO_ROOT}/.gitignore"
fi

# Initialize cross-refs if missing
if [ ! -f "${MGW_DIR}/cross-refs.json" ]; then
  echo '{"links":[]}' > "${MGW_DIR}/cross-refs.json"
fi
```

## Issue State Schema

File: `.mgw/active/<number>-<slug>.json`

```json
{
  "issue": {
    "number": 42,
    "title": "Short title",
    "url": "https://github.com/owner/repo/issues/42",
    "labels": ["bug"],
    "assignee": "username"
  },
  "triage": {
    "scope": { "files": 0, "systems": [] },
    "validity": "pending|confirmed|invalid",
    "security_notes": "",
    "conflicts": []
  },
  "gsd_route": null,
  "gsd_artifacts": { "type": null, "path": null },
  "pipeline_stage": "new|triaged|planning|executing|verifying|pr-created|done",
  "comments_posted": [],
  "linked_pr": null,
  "linked_issues": [],
  "linked_branches": []
}
```

## Slug Generation

From issue title: lowercase, replace non-alphanumeric with hyphens, collapse multiple hyphens, trim to 40 chars, strip trailing hyphens.

## Cross-Refs Schema

File: `.mgw/cross-refs.json`

```json
{
  "links": [
    { "a": "issue:42", "b": "issue:43", "type": "related", "created": "2026-02-24T10:00:00Z" },
    { "a": "issue:42", "b": "pr:15", "type": "implements", "created": "2026-02-24T12:00:00Z" },
    { "a": "issue:42", "b": "branch:fix/auth-42", "type": "tracks", "created": "2026-02-24T10:00:00Z" }
  ]
}
```

</state_format>
