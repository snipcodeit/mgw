---
phase: quick
plan: 2
subsystem: template-engine
tags: [ai-generation, templates, project-init, refactor]
dependency_graph:
  requires: []
  provides: [ai-driven-project-scaffolding]
  affects: [mgw-project-command, template-loader, templates-module]
tech_stack:
  added: []
  patterns: [ai-inline-generation, schema-validation, temp-file-handoff]
key_files:
  created: []
  modified:
    - lib/template-loader.cjs
    - lib/templates.cjs
    - .claude/commands/mgw/project.md
    - templates/schema.json
  deleted:
    - templates/web-app.json
    - templates/cli-tool.json
    - templates/library.json
decisions:
  - "AI generates project template inline during /mgw:project execution — no load() function needed"
  - "Temp file pattern: AI writes to /tmp/mgw-template.json, downstream steps read from it"
  - "schema.json type field changed from enum restriction to minLength:1 string"
  - "validate() accepts any non-empty type string — game, mobile-app, data-pipeline, etc."
metrics:
  duration: "5 min"
  completed: "2026-02-26"
  tasks_completed: 2
  files_modified: 4
  files_deleted: 3
---

# Quick Task 2: Replace Rigid 3-Template System with AI-Driven Scaffolding — Summary

**One-liner:** Replaced the web-app/cli-tool/library enum with AI-driven inline JSON generation, stripping template-loader.cjs to validate/getSchema/VALID_GSD_ROUTES only and rewriting /mgw:project to generate project-specific milestones and issues for any project type.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Refactor template-loader.cjs to validation-only, delete template JSONs | 88829d3 | lib/template-loader.cjs, lib/templates.cjs, templates/web-app.json (deleted), templates/cli-tool.json (deleted), templates/library.json (deleted) |
| 2 | Rewrite /mgw:project command for AI-driven scaffolding | ffc6ca2 | .claude/commands/mgw/project.md, templates/schema.json |

## What Was Built

### lib/template-loader.cjs (validation-only module)

The `load()` function and all template-filling infrastructure was removed:
- Removed: `load()`, `VALID_TYPES`, `detectRepo()`, `deepClone()`, `fillString()`, `fillRecursive()`, `findUnfilledPlaceholders()`, `getTemplatesDir()`
- Added: `getSchema()` — reads and returns templates/schema.json as a string
- Updated: `validate()` — now accepts any non-empty string for `type` (no enum restriction)
- Updated: CLI mode — `schema` subcommand added, `load` subcommand removed
- Updated: `module.exports = { validate, getSchema, VALID_GSD_ROUTES }`

### lib/templates.cjs (re-export wrapper)

Updated to match new exports: `{ validate, getSchema, VALID_GSD_ROUTES }`.

### templates/ directory

- Deleted: `web-app.json`, `cli-tool.json`, `library.json`
- Updated: `schema.json` — removed `enum: ["web-app","cli-tool","library"]` restriction on `type` field; now accepts any descriptive string

### .claude/commands/mgw/project.md (AI-driven command)

- **gather_inputs step:** Reduced from 3 questions to 2; removed all template-type detection logic
- **generate_template step** (new, replaces load_template): Instructs Claude to generate complete project-specific JSON inline; reads schema via `template-loader.cjs schema`; validates with `template-loader.cjs validate`; writes to `/tmp/mgw-template.json`
- **create_milestones, create_issues steps:** Updated all `python3` JSON parsing to read from `/tmp/mgw-template.json` and use `d['milestones'][N]` instead of `d['template']['milestones'][N]`
- **write_project_json step:** Uses `GENERATED_TYPE` from AI-generated JSON instead of hardcoded `TEMPLATE_TYPE`
- **report step:** Shows `Type: {GENERATED_TYPE}` instead of `Template: {TEMPLATE_TYPE}`
- **success_criteria:** Updated to "AI-generated project template validates against schema.json"

## Decisions Made

1. **AI generates inline, not via subprocess call** — Since /mgw:project already runs inside Claude, there's no need to invoke Claude as a subprocess. The command instructs the executing Claude instance to generate the JSON as part of command execution.

2. **Temp file handoff pattern** — AI writes the generated JSON to `/tmp/mgw-template.json` using the Write tool; bash snippets in downstream steps read from that file path. This is cleaner than passing JSON through shell variables (avoids quoting issues, size limits).

3. **schema.json type field updated** — The `enum: ["web-app","cli-tool","library"]` restriction was removed from schema.json to align with the new open-ended approach. The schema now serves as a structural reference rather than a type gate.

4. **validate() relaxed for type** — The old check `!VALID_TYPES.includes(output.type)` is replaced with a simple non-empty string check, enabling types like "game", "data-pipeline", "mobile-app", "browser-extension", etc.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Updated schema.json type field**
- **Found during:** Task 2
- **Issue:** schema.json still had `enum: ["web-app","cli-tool","library"]` on the `type` field. The AI reads schema to understand the required output format — if schema still restricts type to those 3 values, the AI would generate only those types defeating the purpose.
- **Fix:** Changed `enum` to `minLength: 1` with updated description listing example open-ended types.
- **Files modified:** templates/schema.json
- **Commit:** ffc6ca2 (included in Task 2 commit)

## Verification Results

All 6 verification checks passed:
1. `ls templates/` — shows only `schema.json`
2. `node lib/template-loader.cjs schema` — outputs valid JSON with definitions
3. `node -e "require('./lib/templates.cjs')"` — exports `VALID_GSD_ROUTES,getSchema,validate`
4. project.md — no `detect_template_type`, no `template-loader.cjs load` call
5. project.md — 16 matches for generation-related instructions
6. project.md — validates AI output against schema.json before proceeding

## Self-Check: PASSED

Files exist:
- FOUND: /hd1/repos/mgw/lib/template-loader.cjs
- FOUND: /hd1/repos/mgw/lib/templates.cjs
- FOUND: /hd1/repos/mgw/.claude/commands/mgw/project.md
- FOUND: /hd1/repos/mgw/templates/schema.json
- MISSING (correctly deleted): templates/web-app.json
- MISSING (correctly deleted): templates/cli-tool.json
- MISSING (correctly deleted): templates/library.json

Commits exist:
- FOUND: 88829d3 refactor(quick-2): strip template-loader to validation-only
- FOUND: ffc6ca2 feat(quick-2): rewrite /mgw:project for AI-driven scaffolding
