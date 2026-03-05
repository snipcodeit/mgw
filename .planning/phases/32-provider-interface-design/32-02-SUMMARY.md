---
phase: 32-provider-interface-design
plan: "02"
subsystem: api
tags: [provider-manager, abstraction, cli, barrel-export, multi-provider]

requires:
  - phase: 32-01
    provides: lib/provider-claude.cjs implementing MGW provider contract (PROVIDER_ID, assertAvailable, invoke, getCommandsDir)
provides:
  - lib/provider-manager.cjs with ProviderManager registry resolving active provider at runtime
  - lib/index.cjs barrel exports ProviderManager for convenient import
  - bin/mgw.cjs wired through ProviderManager with --provider flag for future provider selection
affects: []

tech-stack:
  added: []
  patterns:
    - "ProviderManager registry pattern: central resolution point mapping PROVIDER_ID strings to provider modules"
    - "Provider flag pattern: --provider CLI flag selects AI provider without touching command logic"
    - "Barrel spread pattern: ...require('./provider-manager.cjs') adds ProviderManager to lib/index.cjs"

key-files:
  created:
    - lib/provider-manager.cjs
  modified:
    - lib/index.cjs
    - bin/mgw.cjs

key-decisions:
  - "ProviderManager implemented as a plain object (not a class) with getProvider and listProviders — simplest shape that satisfies the registry contract"
  - "getProvider() defaults to 'claude' when no providerId given — zero-config for existing usage"
  - "getProvider('unknown') throws with helpful error listing available providers"
  - "--provider global flag added to mgw CLI to enable future provider selection without code changes"
  - "help command getCommandsDir() call fixed to route through ProviderManager.getProvider() — bug caught during Task 2"

patterns-established:
  - "ProviderManager as single resolution point: future providers added to registry dict, no command logic changes needed"
  - "Provider selection: opts.provider from CLI flag flows directly to ProviderManager.getProvider(opts.provider)"

requirements-completed:
  - MP-02
  - MP-03

duration: 8min
completed: 2026-03-05
---

# Phase 32 Plan 02: Provider Interface Design Summary

**ProviderManager registry built in lib/provider-manager.cjs and wired into bin/mgw.cjs + lib/index.cjs, completing the multi-provider abstraction layer with --provider flag support**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-05T06:20:00Z
- **Completed:** 2026-03-05T06:28:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Created lib/provider-manager.cjs with ProviderManager registry (getProvider, listProviders)
- Wired bin/mgw.cjs to use ProviderManager instead of direct lib/claude.cjs import
- Added --provider global flag to mgw CLI for future provider selection
- Added ProviderManager to lib/index.cjs barrel so callers can import from single entry point
- Fixed a pre-existing bug where help command called bare getCommandsDir() without a provider reference

## Task Commits

Each task was committed atomically:

1. **Task 1: Create lib/provider-manager.cjs** - `80614a5` (feat)
2. **Task 2: Wire bin/mgw.cjs and lib/index.cjs through ProviderManager** - `c22192a` (feat)

## Files Created/Modified
- `lib/provider-manager.cjs` - Runtime provider resolution registry; maps PROVIDER_ID strings to provider modules
- `lib/index.cjs` - Added ...require('./provider-manager.cjs') barrel spread
- `bin/mgw.cjs` - Replaced lib/claude.cjs import with ProviderManager; added --provider flag; routed all provider calls through provider.* methods

## Decisions Made
- ProviderManager implemented as a plain object singleton (not a class) — simplest shape satisfying the registry contract with no instantiation overhead
- Default provider is 'claude' when no --provider flag given — ensures zero-config backward compatibility
- Error message on unknown provider explicitly lists available providers: `Unknown provider: "X". Available: claude`
- The --provider flag value flows directly as opts.provider into ProviderManager.getProvider(opts.provider)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed help command calling bare getCommandsDir() after import removed**
- **Found during:** Task 2 (Wire bin/mgw.cjs and lib/index.cjs through ProviderManager)
- **Issue:** bin/mgw.cjs help command (line 511) called `getCommandsDir()` directly, but the new import replaced the old destructured `{ assertClaudeAvailable, invokeClaude, getCommandsDir }` import with `{ ProviderManager }`. The bare `getCommandsDir` reference would throw ReferenceError at runtime.
- **Fix:** Changed `getCommandsDir()` to `ProviderManager.getProvider().getCommandsDir()` to route through the provider abstraction consistently.
- **Files modified:** bin/mgw.cjs
- **Verification:** `node --check bin/mgw.cjs` passes; no remaining bare `getCommandsDir` references outside of provider.* calls.
- **Committed in:** `c22192a` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Fix was necessary for correctness — help command would have thrown ReferenceError at runtime. No scope creep.

## Issues Encountered
- Plan 32-02 had uncommitted working tree changes for bin/mgw.cjs and lib/index.cjs from a previous partial execution. These were verified against the plan specification, the bug fix was applied, and the commit was created.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Multi-provider abstraction is complete; future providers add a lib/provider-{id}.cjs and register in provider-manager.cjs registry
- All existing mgw commands work through the new abstraction (backward compatible)
- --provider flag is wired and ready for future provider implementations

---
*Phase: 32-provider-interface-design*
*Completed: 2026-03-05*
