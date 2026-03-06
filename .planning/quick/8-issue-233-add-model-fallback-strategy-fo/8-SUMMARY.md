# Summary: Add Model Fallback Strategy for Agent Execution Failures

## One Liner
Added ModelFallbackEngine to provide per-agent-type model tier fallback when retry policy is exhausted, configurable via .mgw/config.json.

## Changes

### New Files
- **lib/model-fallback.cjs** — ModelFallbackEngine class with:
  - DEFAULT_FALLBACK_CHAINS per agent type (gsd-planner: [inherit, sonnet, haiku], etc.)
  - `resolveFallbackChain(agentType)` — returns ordered model list
  - `executeWithFallback(fn, opts)` — wraps async fn with model-tier retry
  - `ModelFallbackError` — error class with fallback_attempts tracking
  - `loadConfig()` — reads .mgw/config.json retry.model_fallback settings
  - NON_FALLBACK_FAILURE_TYPES set (hallucination, permission-denied skip fallback)

### Modified Files
- **lib/gsd-adapter.cjs** — Added:
  - `resolveFallbackChain(agentType)` wrapper function
  - `getModelFallbackEngine()` singleton accessor
  - Safe import of model-fallback.cjs (no-op when absent)

- **lib/retry-policy.cjs** — Added:
  - Safe import of model-fallback.cjs
  - `fallback_attempts` field to RetryPolicyError
  - `modelFallback` option to executeWithPolicy
  - `_attemptModelFallback()` private method for fallback delegation
  - `onFallback` callback option for logging model tier transitions

### Dependency Files (from other PRs, included for worktree compatibility)
- **lib/agent-errors.cjs** — from #229 (defines AGENT_FAILURE_TYPES, classifyAgentFailure)
- **lib/retry-policy.cjs** — originally from #232, extended here

## Key Files
- lib/model-fallback.cjs
- lib/gsd-adapter.cjs
- lib/retry-policy.cjs

## Technical Decisions
1. **Disabled by default** — model_fallback is false unless explicitly enabled in .mgw/config.json to preserve backward compatibility
2. **Per-agent-type chains** — different agents have different model needs; planners start with inherit (opus-level), executors start with sonnet
3. **Non-fallback failure types** — hallucination and permission-denied skip fallback because model change won't fix them
4. **Safe imports everywhere** — every dependency uses try/catch import so each module works independently

## Commits
1. `feat(lib): add model fallback engine for agent execution failures` — lib/model-fallback.cjs
2. `feat(adapter): add model fallback chain resolution to gsd-adapter` — lib/gsd-adapter.cjs
3. `feat(retry): integrate model fallback with retry policy engine` — lib/retry-policy.cjs, lib/agent-errors.cjs
