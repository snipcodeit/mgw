<purpose>
Reusable state detection workflow for MGW commands. Reads five signal sources and
classifies the project into one of six STATE_CLASS values. Any command that needs to
know the current project state (project.md, status.md, milestone.md, sync.md) can
reference this workflow instead of re-implementing the detection logic inline.
</purpose>

## Input Contract

Requires the following variables to be set before invoking:

| Variable | Source | Description |
|----------|--------|-------------|
| `REPO_ROOT` | `git rev-parse --show-toplevel` | Absolute path to the repo root |
| `REPO` | `gh repo view --json nameWithOwner -q .nameWithOwner` | GitHub owner/repo slug |

## Output Contract

Sets the following variables for downstream steps to branch on:

| Variable | Type | Values |
|----------|------|--------|
| `STATE_CLASS` | string | `Fresh`, `GSD-Only`, `GSD-Mid-Exec`, `Aligned`, `Diverged`, `Extend` |
| `EXTEND_MODE` | bool | `true` when STATE_CLASS is Extend or user chose extend in Aligned |
| `EXISTING_MILESTONE_COUNT` | int | Number of milestones in project.json (Extend/Aligned paths only) |
| `EXISTING_PHASE_COUNT` | int | Highest phase number in project.json phase_map (Extend/Aligned paths only) |
| `LOCAL_MILESTONE_COUNT` | int | Count of milestones in project.json (Aligned/Diverged paths only) |
| `GH_MILESTONE_COUNT` | int | Count of milestones on GitHub (Aligned/Diverged paths only) |

## The Five Signals

| Signal | What It Checks |
|--------|---------------|
| `P` | `.planning/PROJECT.md` exists |
| `R` | `.planning/ROADMAP.md` exists |
| `S` | `.planning/STATE.md` exists |
| `M` | `.mgw/project.json` exists |
| `G` | Count of GitHub milestones via `gh api` |

## The Six State Classes

| State | P | R | S | M | G | Meaning |
|---|---|---|---|---|---|---|
| Fresh | false | false | false | false | 0 | Clean slate — no GSD, no MGW |
| GSD-Only | true | false | false | false | 0 | PROJECT.md present but no roadmap yet |
| GSD-Mid-Exec | true | true | true | false | 0 | GSD in progress, MGW not yet linked |
| Aligned | true | — | — | true | >0 | Both MGW + GitHub consistent with each other |
| Diverged | — | — | — | true | >0 | MGW + GitHub present but inconsistent |
| Extend | true | — | — | true | >0 | All milestones in project.json are done |

## Step: detect_state

**Detect existing project state from five signal sources:**

Check five signals to determine what already exists for this project:

```bash
# Signal checks
P=false  # .planning/PROJECT.md exists
R=false  # .planning/ROADMAP.md exists
S=false  # .planning/STATE.md exists
M=false  # .mgw/project.json exists
G=0      # GitHub milestone count

[ -f "${REPO_ROOT}/.planning/PROJECT.md" ] && P=true
[ -f "${REPO_ROOT}/.planning/ROADMAP.md" ] && R=true
[ -f "${REPO_ROOT}/.planning/STATE.md" ] && S=true
[ -f "${REPO_ROOT}/.mgw/project.json" ] && M=true

G=$(gh api "repos/${REPO}/milestones" --jq 'length' 2>/dev/null || echo 0)
```

**Classify into STATE_CLASS:**

```bash
# Classification logic
STATE_CLASS="Fresh"
EXTEND_MODE=false

if [ "$M" = "true" ] && [ "$G" -gt 0 ]; then
  # Check if all milestones are complete (Extend detection)
  ALL_COMPLETE=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
milestones = p.get('milestones', [])
current = p.get('current_milestone', 1)
# All complete when current_milestone exceeds array length
# (milestone.md increments current_milestone after completing each)
all_done = current > len(milestones) and len(milestones) > 0
print('true' if all_done else 'false')
")

  if [ "$ALL_COMPLETE" = "true" ]; then
    STATE_CLASS="Extend"
    EXTEND_MODE=true
    EXISTING_MILESTONE_COUNT=$(python3 -c "import json; print(len(json.load(open('${REPO_ROOT}/.mgw/project.json'))['milestones']))")
    EXISTING_PHASE_COUNT=$(python3 -c "import json; print(max((int(k) for k in json.load(open('${REPO_ROOT}/.mgw/project.json')).get('phase_map',{}).keys()), default=0))")
  else
    # M=true, G>0, not all done — check consistency (Aligned vs Diverged)
    GH_MILESTONE_COUNT=$G
    LOCAL_MILESTONE_COUNT=$(python3 -c "import json; print(len(json.load(open('${REPO_ROOT}/.mgw/project.json')).get('milestones', [])))")

    # Consistency: milestone counts match and names overlap
    CONSISTENCY_OK=$(python3 -c "
import json, subprocess, sys
local = json.load(open('${REPO_ROOT}/.mgw/project.json'))
local_names = set(m['name'] for m in local.get('milestones', []))
local_count = len(local_names)
gh_count = ${GH_MILESTONE_COUNT}

# Count mismatch is a drift signal (allow off-by-one for in-flight)
if abs(local_count - gh_count) > 1:
    print('false')
    sys.exit(0)

# Name overlap check: at least 50% of local milestone names found on GitHub
result = subprocess.run(
    ['gh', 'api', 'repos/${REPO}/milestones', '--jq', '[.[].title]'],
    capture_output=True, text=True
)
try:
    gh_names = set(json.loads(result.stdout))
    overlap = len(local_names & gh_names)
    print('true' if overlap >= max(1, local_count // 2) else 'false')
except Exception:
    print('false')
")

    if [ "$CONSISTENCY_OK" = "true" ]; then
      STATE_CLASS="Aligned"
    else
      STATE_CLASS="Diverged"
    fi
  fi
elif [ "$M" = "false" ] && [ "$G" -eq 0 ]; then
  # No MGW state, no GitHub milestones — GSD signals determine class
  if [ "$P" = "true" ] && [ "$R" = "true" ] && [ "$S" = "true" ]; then
    STATE_CLASS="GSD-Mid-Exec"
  elif [ "$P" = "true" ] && [ "$R" = "true" ]; then
    STATE_CLASS="GSD-Mid-Exec"
  elif [ "$P" = "true" ]; then
    STATE_CLASS="GSD-Only"
  else
    STATE_CLASS="Fresh"
  fi
fi

echo "State detected: ${STATE_CLASS} (P=${P} R=${R} S=${S} M=${M} G=${G})"
```

**Route by STATE_CLASS:**

```bash
case "$STATE_CLASS" in
  "Fresh")
    # Proceed to gather_inputs (standard flow)
    ;;

  "GSD-Only"|"GSD-Mid-Exec")
    # GSD artifacts exist but MGW not initialized — delegate to align_from_gsd
    # (proceed to align_from_gsd step)
    ;;

  "Aligned")
    # MGW + GitHub consistent — display status and offer extend mode
    TOTAL_ISSUES=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
print(sum(len(m.get('issues', [])) for m in p.get('milestones', [])))
")
    echo ""
    echo "Project already initialized and aligned with GitHub."
    echo "  Milestones: ${LOCAL_MILESTONE_COUNT} local / ${GH_MILESTONE_COUNT} on GitHub"
    echo "  Issues: ${TOTAL_ISSUES} tracked in project.json"
    echo ""
    echo "What would you like to do?"
    echo ""
    echo "  1) Continue with /mgw:milestone (execute next milestone)"
    echo "  2) Add new milestones to this project (extend mode)"
    echo "  3) View full status (/mgw:status)"
    echo ""
    read -p "Choose [1/2/3]: " ALIGNED_CHOICE
    case "$ALIGNED_CHOICE" in
      2)
        echo ""
        echo "Entering extend mode — new milestones will be added to the existing project."
        EXTEND_MODE=true
        EXISTING_MILESTONE_COUNT=${LOCAL_MILESTONE_COUNT}
        EXISTING_PHASE_COUNT=$(python3 -c "
import json
p = json.load(open('${REPO_ROOT}/.mgw/project.json'))
print(sum(len(m.get('phases', [])) for m in p.get('milestones', [])))
")
        echo "Phase numbering will continue from phase ${EXISTING_PHASE_COUNT}."
        # Fall through to gather_inputs — do NOT exit
        ;;
      3)
        echo ""
        echo "Run /mgw:status to view the full project status dashboard."
        exit 0
        ;;
      *)
        echo ""
        echo "Run /mgw:milestone to execute the next milestone."
        exit 0
        ;;
    esac
    ;;

  "Diverged")
    # MGW + GitHub inconsistent — delegate to reconcile_drift
    # (proceed to reconcile_drift step)
    ;;

  "Extend")
    # All milestones done — entering extend mode
    echo "All ${EXISTING_MILESTONE_COUNT} milestones complete. Entering extend mode."
    echo "Phase numbering will continue from phase ${EXISTING_PHASE_COUNT}."
    # Proceed to gather_inputs in extend mode (EXTEND_MODE=true already set)
    ;;
esac
```
