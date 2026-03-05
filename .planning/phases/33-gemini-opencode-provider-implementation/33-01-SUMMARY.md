---
phase: 33-gemini-opencode-provider-implementation
plan: "01"
subsystem: provider
tags: [gemini, multi-provider, cli, provider-interface]

requires:
  - phase: 32-multi-provider-ai-architecture
    provides: provider contract (PROVIDER_ID, assertAvailable, invoke, getCommandsDir) and ProviderManager registry

provides:
  - GeminiProvider module (lib/provider-gemini.cjs) implementing the full MGW provider interface

affects:
  - 33-03-PLAN (register in ProviderManager)
  - any future provider implementations (follow same pattern)

tech-stack:
  added: []
  patterns:
    - "Inline system prompt: when CLI has no --system-prompt-file, read file and prepend as <system> block"
    - "Binary-presence-as-auth: gemini --version exit 0 is sufficient availability guard (no separate auth status)"

key-files:
  created:
    - lib/provider-gemini.cjs
  modified: []

key-decisions:
  - "No separate auth check for gemini: gemini --version exit 0 is the availability guard (no auth status subcommand)"
  - "System prompt inlined as <system> XML block prepended to user prompt (gemini has no --system-prompt-file)"
  - "getCommandsDir returns ~/.gemini/commands (user-level, not bundled) with clear install instructions on missing"
  - "opts.json ignored: gemini CLI has no --output-format json equivalent"

patterns-established:
  - "Pattern: inline-system-prompt for CLIs without --system-prompt-file flag"

requirements-completed:
  - MP-04

duration: 5min
completed: 2026-03-05
---

# Phase 33 Plan 01: GeminiProvider Summary

**Gemini CLI provider with inline system-prompt injection, binary-presence auth guard, and user-level commands directory at ~/.gemini/commands**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-05T00:00:00Z
- **Completed:** 2026-03-05T00:05:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Created lib/provider-gemini.cjs implementing the full MGW provider interface
- assertAvailable() uses gemini --version as binary presence guard (no separate auth subcommand)
- invoke() reads commandFile and prepends content as XML <system> block (no --system-prompt-file in gemini CLI)
- getCommandsDir() returns ~/.gemini/commands with clear error if directory missing

## Task Commits

Each task was committed atomically:

1. **Task 1: Create lib/provider-gemini.cjs** - `8c1d372` (feat)

## Files Created/Modified
- `lib/provider-gemini.cjs` - Gemini CLI provider; PROVIDER_ID='gemini', full interface contract implemented

## Decisions Made
- Binary presence (gemini --version) is the only availability guard — gemini has no auth status subcommand
- System prompt inlined as `<system>\n{contents}\n</system>\n\n{userPrompt}` since gemini lacks --system-prompt-file
- getCommandsDir returns user-level ~/.gemini/commands (not bundled commands like ClaudeProvider)
- opts.json flag explicitly ignored with comment; gemini has no JSON output format equivalent

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GeminiProvider ready for registration in ProviderManager (33-03)
- Pattern established for providers without --system-prompt-file: inline <system> block

---
*Phase: 33-gemini-opencode-provider-implementation*
*Completed: 2026-03-05*
