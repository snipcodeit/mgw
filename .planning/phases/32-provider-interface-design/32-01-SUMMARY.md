---
phase: 32-provider-interface-design
plan: "01"
subsystem: api
tags: [provider-interface, claude, abstraction, backward-compat]

requires: []
provides:
  - lib/provider-claude.cjs implementing MGW provider contract (PROVIDER_ID, assertAvailable, invoke, getCommandsDir)
  - lib/claude.cjs reduced to backward-compat shim with legacy aliases
affects:
  - 32-02-provider-manager

tech-stack:
  added: []
  patterns:
    - "Provider interface contract: every lib/provider-*.cjs exports PROVIDER_ID, assertAvailable(), invoke(), getCommandsDir()"
    - "Backward-compat shim pattern: old module re-exports from new with legacy aliases"

key-files:
  created:
    - lib/provider-claude.cjs
  modified:
    - lib/claude.cjs

key-decisions:
  - "Renamed assertClaudeAvailable -> assertAvailable and invokeClaude -> invoke to establish generic provider contract names"
  - "lib/claude.cjs becomes a shim (not deleted) so bin/mgw.cjs and lib/index.cjs need no changes in this plan"
  - "PROVIDER_ID constant added to make provider identity explicit and registry-ready"

patterns-established:
  - "Provider module pattern: lib/provider-{id}.cjs with PROVIDER_ID, assertAvailable, invoke, getCommandsDir"
  - "Shim pattern: backward-compat shim spreads new module and adds legacy aliases"

requirements-completed:
  - MP-01

duration: 2min
completed: 2026-03-05
---

# Phase 32 Plan 01: Provider Interface Design Summary

**Claude CLI provider extracted to lib/provider-claude.cjs with generic provider contract; lib/claude.cjs reduced to a backward-compat shim with legacy aliases**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-05T06:17:27Z
- **Completed:** 2026-03-05T06:19:30Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Created lib/provider-claude.cjs with provider interface contract (PROVIDER_ID='claude', assertAvailable, invoke, getCommandsDir)
- Reduced lib/claude.cjs to a thin shim that re-exports from provider-claude.cjs and adds legacy aliases
- All existing callers (bin/mgw.cjs, lib/index.cjs) continue to work without modification

## Task Commits

Each task was committed atomically:

1. **Task 1: Create lib/provider-claude.cjs** - `fa60faf` (feat)
2. **Task 2: Reduce lib/claude.cjs to backward-compat shim** - `97102bf` (feat)

## Files Created/Modified
- `lib/provider-claude.cjs` - Canonical Claude CLI provider implementing the MGW provider interface
- `lib/claude.cjs` - Backward-compat shim re-exporting from provider-claude.cjs with legacy aliases

## Decisions Made
- Renamed assertClaudeAvailable -> assertAvailable and invokeClaude -> invoke to establish generic provider contract names that all future providers will implement
- Kept lib/claude.cjs as a shim (rather than deleting it) so bin/mgw.cjs and lib/index.cjs need no changes in this plan — wiring through ProviderManager is plan 32-02's responsibility
- Added PROVIDER_ID constant to make provider identity explicit and enable registry-based resolution

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- lib/provider-claude.cjs ready for 32-02 to import into ProviderManager registry
- Provider contract shape established; ProviderManager can now resolve by PROVIDER_ID
- Both verify commands pass, backward compat preserved

---
*Phase: 32-provider-interface-design*
*Completed: 2026-03-05*
