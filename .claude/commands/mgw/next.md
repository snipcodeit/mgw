---
name: mgw:next
description: Show next unblocked issue — what to work on now, based on declared dependencies
argument-hint: ""
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

<objective>
Surface the next unblocked issue across the current milestone based on dependency
declarations. Local-first: reads project.json for fast answer, then does a quick
`gh` API check to verify the issue is still open.

This is a read-only command — it does NOT modify state, run pipelines, or create
worktrees. After displaying the brief, it offers to run `/mgw:run` for the
recommended issue.
</objective>

<execution_context>
@~/.claude/commands/mgw/workflows/state.md
@~/.claude/commands/mgw/workflows/github.md
</execution_context>

<process>

<step name="load_state">
**Load project.json and validate:**

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
MGW_DIR="${REPO_ROOT}/.mgw"

if [ ! -f "${MGW_DIR}/project.json" ]; then
  echo "No project initialized. Run /mgw:project first."
  exit 1
fi

PROJECT_JSON=$(cat "${MGW_DIR}/project.json")

# Resolve active milestone index using state resolution (supports both schema versions)
ACTIVE_IDX=$(node -e "
const { loadProjectState, resolveActiveMilestoneIndex } = require('./lib/state.cjs');
const state = loadProjectState();
console.log(resolveActiveMilestoneIndex(state));
")

# Get milestone data
MILESTONE_DATA=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
p = json.load(sys.stdin)
idx = ${ACTIVE_IDX}
if idx < 0 or idx >= len(p['milestones']):
    print(json.dumps({'error': 'No more milestones'}))
    sys.exit(0)
m = p['milestones'][idx]
print(json.dumps(m))
")

MILESTONE_NAME=$(echo "$MILESTONE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])")
ISSUES_JSON=$(echo "$MILESTONE_DATA" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['issues']))")
TOTAL_ISSUES=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
```
</step>

<step name="resolve_dependencies">
**Compute dependency graph and ordered issue list:**

```bash
DEPENDENCY_RESULT=$(echo "$ISSUES_JSON" | python3 -c "
import json, sys
from collections import defaultdict

issues = json.load(sys.stdin)

# Build slug-to-issue and number-to-issue mappings
slug_to_issue = {}
num_to_issue = {}
slug_to_num = {}
for issue in issues:
    title = issue.get('title', '')
    slug = title.lower().replace(' ', '-')[:40]
    slug_to_issue[slug] = issue
    num_to_issue[issue['github_number']] = issue
    slug_to_num[slug] = issue['github_number']

# Build forward and reverse dependency maps
# forward: issue -> what it depends on
# reverse: issue -> what it unblocks
forward_deps = {}  # slug -> [blocking_slugs]
reverse_deps = defaultdict(list)  # slug -> [dependent_slugs]

for issue in issues:
    title = issue.get('title', '')
    slug = title.lower().replace(' ', '-')[:40]
    deps = issue.get('depends_on_slugs', [])
    forward_deps[slug] = deps
    for dep_slug in deps:
        if dep_slug in slug_to_issue:
            reverse_deps[dep_slug].append(slug)

# Find unblocked issues:
# - pipeline_stage == 'new' (not done, not failed, not in-progress)
# - ALL depends_on issues have pipeline_stage == 'done'
unblocked = []
blocked = []
done_count = 0
failed_issues = []

for issue in issues:
    title = issue.get('title', '')
    slug = title.lower().replace(' ', '-')[:40]
    stage = issue.get('pipeline_stage', 'new')

    if stage == 'done':
        done_count += 1
        continue
    if stage == 'failed':
        failed_issues.append(issue)
        continue
    if stage not in ('new',):
        continue  # in-progress, skip for now

    # Check if all dependencies are done
    deps = issue.get('depends_on_slugs', [])
    all_deps_done = True
    blocking_info = []
    for dep_slug in deps:
        if dep_slug in slug_to_issue:
            dep_issue = slug_to_issue[dep_slug]
            if dep_issue.get('pipeline_stage') != 'done':
                all_deps_done = False
                blocking_info.append({
                    'number': dep_issue['github_number'],
                    'title': dep_issue['title'],
                    'stage': dep_issue.get('pipeline_stage', 'new')
                })

    if all_deps_done:
        # Compute what this issue unblocks
        unblocks = []
        for dep_slug in reverse_deps.get(slug, []):
            if dep_slug in slug_to_issue:
                dep_issue = slug_to_issue[dep_slug]
                unblocks.append({
                    'number': dep_issue['github_number'],
                    'title': dep_issue['title']
                })

        # Compute resolved dependencies
        resolved_deps = []
        for dep_slug in deps:
            if dep_slug in slug_to_issue:
                dep_issue = slug_to_issue[dep_slug]
                resolved_deps.append({
                    'number': dep_issue['github_number'],
                    'title': dep_issue['title']
                })

        unblocked.append({
            'issue': issue,
            'unblocks': unblocks,
            'resolved_deps': resolved_deps
        })
    else:
        blocked.append({
            'issue': issue,
            'blocked_by': blocking_info
        })

# Sort unblocked by phase_number (first = recommended)
unblocked.sort(key=lambda x: x['issue'].get('phase_number', 999))

result = {
    'unblocked': unblocked,
    'blocked': blocked,
    'done_count': done_count,
    'total': len(issues),
    'failed': [{'number': i['github_number'], 'title': i['title']} for i in failed_issues]
}
print(json.dumps(result, indent=2))
")
```
</step>

<step name="handle_nothing_unblocked">
**If no issues are unblocked:**

Check if ALL issues are done:
```bash
ALL_DONE=$(echo "$DEPENDENCY_RESULT" | python3 -c "
import json,sys
r = json.load(sys.stdin)
print('true' if r['done_count'] == r['total'] else 'false')
")
```

If all done:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► ALL DONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All ${TOTAL_ISSUES} issues in milestone "${MILESTONE_NAME}" are complete.

Run /mgw:milestone to finalize (close milestone, create release).
```

If not all done (some are blocked/failed):
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► BLOCKED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

No unblocked issues in milestone "${MILESTONE_NAME}".

| Issue | Blocked By | Blocker Status |
|-------|-----------|----------------|
| #N title | #M title | ◆ In progress |
| #K title | #J title | ✗ Failed |

${failed_advice}

Progress: ${done_count}/${total} complete
```

Where `${failed_advice}` is: "Resolve #J to unblock #K." (specific actionable advice for each failed blocker).
</step>

<step name="verify_live">
**Quick GitHub verification for recommended issue:**

```bash
RECOMMENDED=$(echo "$DEPENDENCY_RESULT" | python3 -c "
import json,sys
r = json.load(sys.stdin)
if r['unblocked']:
    print(json.dumps(r['unblocked'][0]))
else:
    print('null')
")
```

If recommended issue exists:
```bash
REC_NUMBER=$(echo "$RECOMMENDED" | python3 -c "import json,sys; print(json.load(sys.stdin)['issue']['github_number'])")

# Quick GitHub check — verify issue is still open
GH_CHECK=$(gh issue view ${REC_NUMBER} --json state,title,labels -q '{state: .state, title: .title}' 2>/dev/null)

if [ -n "$GH_CHECK" ]; then
  GH_STATE=$(echo "$GH_CHECK" | python3 -c "import json,sys; print(json.load(sys.stdin)['state'])")
  if [ "$GH_STATE" != "OPEN" ]; then
    # Issue was closed externally — skip to next unblocked
    echo "Issue #${REC_NUMBER} is ${GH_STATE} on GitHub. Checking next..."
    # Remove from unblocked list, try next
  fi
  VERIFIED="(verified)"
else
  VERIFIED="(GitHub state unverified)"
fi
```
</step>

<step name="display_brief">
**Display full brief for recommended issue:**

```bash
REC_ISSUE=$(echo "$RECOMMENDED" | python3 -c "import json,sys; r=json.load(sys.stdin); print(json.dumps(r['issue']))")
REC_TITLE=$(echo "$REC_ISSUE" | python3 -c "import json,sys; print(json.load(sys.stdin)['title'])")
REC_GSD_ROUTE=$(echo "$REC_ISSUE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('gsd_route','plan-phase'))")
REC_LABELS=$(echo "$REC_ISSUE" | python3 -c "import json,sys; print(', '.join(json.load(sys.stdin).get('labels',[])))")
REC_PHASE=$(echo "$REC_ISSUE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('phase_number',''))")
REC_PHASE_NAME=$(echo "$REC_ISSUE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('phase_name',''))")

DONE_COUNT=$(echo "$DEPENDENCY_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['done_count'])")
```

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MGW ► NEXT UP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Issue:       #${REC_NUMBER} — ${REC_TITLE} ${VERIFIED}
GSD Route:   ${REC_GSD_ROUTE}
Phase:       ${REC_PHASE}: ${REC_PHASE_NAME}
Labels:      ${REC_LABELS}
Milestone:   ${MILESTONE_NAME} (${DONE_COUNT}/${TOTAL_ISSUES} complete)

Dependencies (all done):
  ✓ #${dep1_number} — ${dep1_title}
  ✓ #${dep2_number} — ${dep2_title}
  (or: None — this is an independent issue)

Unblocks:
  ○ #${next1_number} — ${next1_title}
  ○ #${next2_number} — ${next2_title}
  (or: None — no downstream dependencies)

───────────────────────────────────────────────────────────────
```

If other unblocked alternatives exist:
```bash
ALT_COUNT=$(echo "$DEPENDENCY_RESULT" | python3 -c "
import json,sys
r = json.load(sys.stdin)
print(len(r['unblocked']) - 1)
")
```

If ALT_COUNT > 0:
```
Also unblocked:
  #${alt1_number} — ${alt1_title} (${alt1_gsd_route})
  #${alt2_number} — ${alt2_title} (${alt2_gsd_route})
```
</step>

<step name="offer_run">
**Offer to run the recommended issue:**

```
AskUserQuestion(
  header: "Ready to Start",
  question: "Run /mgw:run #${REC_NUMBER} now?",
  options: [
    { label: "Yes", description: "Start the pipeline for this issue" },
    { label: "No", description: "Just viewing — I'll run it later" },
    { label: "Pick different", description: "Choose a different unblocked issue" }
  ]
)
```

**If "Yes":** Display the command to run:
```
Start the pipeline:

  /mgw:run ${REC_NUMBER}

<sub>/clear first → fresh context window</sub>
```

Note: /mgw:next is read-only (allowed-tools don't include Task). It cannot invoke
/mgw:run directly. It displays the command for the user to run.

**If "Pick different":** Display the alternatives list and ask user to pick:
```
AskUserQuestion(
  header: "Select Issue",
  question: "Which issue do you want to work on?",
  options: [alt_issues_as_options]
)
```

Then re-display the brief for the selected issue.

**If "No":** Exit cleanly.
</step>

</process>

<success_criteria>
- [ ] project.json loaded and current milestone identified (MLST-02)
- [ ] Dependency graph computed from depends_on_slugs
- [ ] Single recommended issue surfaced (dependency order, then phase order)
- [ ] Full brief displayed: number, title, GSD route, labels, dependencies, what it unblocks, milestone context
- [ ] Alternatives listed when multiple issues are unblocked
- [ ] Blocking chain shown when nothing is unblocked
- [ ] Live GitHub verification attempted for recommended issue
- [ ] Offer to run /mgw:run displayed
- [ ] Read-only: no state modifications, no pipeline execution
</success_criteria>
