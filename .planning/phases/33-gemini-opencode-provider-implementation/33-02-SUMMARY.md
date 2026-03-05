---
phase: 33-gemini-opencode-provider-implementation
plan: "02"
subsystem: provider
tags: [opencode, multi-provider, cli, provider-interface]

requires:
  - phase: 32-multi-provider-ai-architecture
    provides: provider contract (PROVIDER_ID, assertAvailable, invoke, getCommandsDir) and ProviderManager registry

provides:
  - OpenCodeProvider module (lib/provider-opencode.cjs) implementing the full MGW provider interface

affects:
  - 33-03-PLAN (register in ProviderManager)
  - any future provider implementations (follow same pattern)

tech-stack:
  added: []
  patterns:
    - "opencode run subcommand: use 'opencode run <prompt>' as non-interactive invocation"
    - "Native --system-prompt flag: opencode natively supports --system-prompt <file>"
    - "Binary-presence-as-auth: opencode --version exit 0 is sufficient availability guard"

key-files:
  created:
    - lib/provider-opencode.cjs
  modified: []

key-decisions:
  - "Use 'opencode run <prompt>' as non-interactive mode (not -p flag)"
  - "Pass commandFile via --system-prompt <file> (opencode natively supports this)"
  - "No separate auth check: opencode --version exit 0 is the availability guard"
  - "getCommandsDir returns ~/.opencode/commands (user-level, not bundled)"
  - "opts.json ignored: opencode CLI has no --output-format json equivalent"

patterns-established:
  - "Pattern: opencode run as non-interactive invocation with native --system-prompt support"

requirements-completed:
  - MP-05

duration: 5min
completed: 2026-03-05
---

# Phase 33 Plan 02: OpenCodeProvider Summary

**OpenCode CLI provider using 'opencode run' non-interactive mode with native --system-prompt file support and user-level commands directory at ~/.opencode/commands**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-05T00:05:00Z
- **Completed:** 2026-03-05T00:10:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Created lib/provider-opencode.cjs implementing the full MGW provider interface
- assertAvailable() uses opencode --version as binary presence guard (no separate auth subcommand)
- invoke() uses 'opencode run <prompt>' as the non-interactive invocation mode
- invoke() passes commandFile via --system-prompt (opencode natively supports this, unlike gemini)
- getCommandsDir() returns ~/.opencode/commands with clear error if directory missing

## Task Commits

Each task was committed atomically:

1. **Task 1: Create lib/provider-opencode.cjs** - `13cd93b` (feat)

## Files Created/Modified
- `lib/provider-opencode.cjs` - OpenCode CLI provider; PROVIDER_ID='opencode', full interface contract implemented

## Decisions Made
- Non-interactive mode is 'opencode run' subcommand (not -p flag as in claude/gemini)
- commandFile passed via --system-prompt <file> since opencode natively supports it
- Binary presence (opencode --version) is the only availability guard
- getCommandsDir returns user-level ~/.opencode/commands (not bundled commands)
- opts.json flag explicitly ignored with comment

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- OpenCodeProvider ready for registration in ProviderManager (33-03)
- Both new providers (gemini and opencode) ready for wave 2

---
*Phase: 33-gemini-opencode-provider-implementation*
*Completed: 2026-03-05*
