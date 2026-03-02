# Generate Template

## Precondition

`PROJECT_NAME`, `DESCRIPTION`, `STACK`, `REPO`, `PREFIX` are set — either from `gather_inputs`
(fresh/non-extend path) or from `workflows/extend-project.md` (extend path). `HISTORY_CONTEXT`
is populated in extend mode, empty otherwise.

Required variables:
- `REPO_ROOT` — absolute path to repo root

## Postcondition

After this workflow completes:
- `/tmp/mgw-template.json` exists and has passed validation
- `MILESTONE_COUNT`, `TOTAL_PHASES`, `GENERATED_TYPE` are set
- Ready to proceed to `create_milestones` step in project.md

---

<step name="generate_template">
**Generate a project-specific template using AI:**

First, read the schema to understand the required output structure:

```bash
SCHEMA=$(node "${REPO_ROOT}/lib/template-loader.cjs" schema)
```

Now, as the AI executing this command, generate a complete project template JSON for this specific project. The JSON must:

1. Match the schema structure: milestones > phases > issues with all required fields
2. Use a descriptive `type` value that fits the project (e.g., "game", "mobile-app", "saas-platform", "data-pipeline", "api-service", "developer-tool", "browser-extension", etc. — NOT limited to web-app/cli-tool/library)
3. Contain 2-4 milestones with 1-3 phases each, each phase having 2-4 issues
4. Have issue titles that are specific and actionable — referencing the actual project domain, not generic placeholders like "Implement primary feature set"
5. Have issue descriptions that reference the actual project context
6. Use `depends_on` slugs following the convention: lowercase title, spaces-to-hyphens, truncated to 40 chars (e.g., "design-core-game-loop-and-player-mechanic")
7. Choose `gsd_route` values appropriately:
   - `plan-phase` for complex multi-step implementation work
   - `quick` for small well-defined tasks
   - `research-phase` for unknowns requiring investigation
   - `execute-phase` for straightforward mechanical execution
8. Use specific, relevant labels (not just "phase-N") — e.g., "backend", "frontend", "game-design", "ml", "database", "ui/ux", "performance", "security"
9. Set `version` to "1.0.0"
10. Include the standard `parameters` section with `project_name` and `description` as required params, and `repo`, `stack`, `prefix` as optional params
11. Include a `project` object with `name`, `description`, `repo`, `stack`, and `prefix` fields filled from the gathered inputs

Output the generated JSON as a fenced code block (```json ... ```).

The project details for generation:
- **Project name:** `$PROJECT_NAME`
- **Description:** `$DESCRIPTION`
- **Stack:** `$STACK`
- **Repo:** `$REPO`
- **Prefix:** `$PREFIX`

<project_history>
${HISTORY_CONTEXT:-No prior history available.}
</project_history>

When in extend mode (HISTORY_CONTEXT is populated): do NOT suggest features or systems that already
appear in the project history above. Build new milestones that complement and extend what exists.

After generating the JSON, extract it and write to a temp file:

```bash
# Write AI-generated JSON to temp file
# (Claude writes the JSON using the Write tool to /tmp/mgw-template.json)
```

**Validate the generated JSON:**

```bash
node "${REPO_ROOT}/lib/template-loader.cjs" validate < /tmp/mgw-template.json
```

If validation fails, review the errors and regenerate with corrections. Repeat until validation passes.

If validation passes, parse key metrics:

```bash
MILESTONE_COUNT=$(python3 -c "import json; d=json.load(open('/tmp/mgw-template.json')); print(len(d['milestones']))")
TOTAL_PHASES=$(python3 -c "import json; d=json.load(open('/tmp/mgw-template.json')); print(sum(len(m['phases']) for m in d['milestones']))")
GENERATED_TYPE=$(python3 -c "import json; d=json.load(open('/tmp/mgw-template.json')); print(d['type'])")
```
</step>
