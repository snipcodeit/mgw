---
phase: 8
plan: 1
type: quick-full
wave: 1
depends_on: []
files_modified:
  - lib/model-fallback.cjs
  - lib/retry-policy.cjs
  - lib/gsd-adapter.cjs
autonomous: true
requirements:
  - Model fallback chain resolution via gsd-tools resolve-model
  - Integration with RetryPolicyEngine from lib/retry-policy.cjs
  - fallback_attempts field in diagnostic logs
  - Configurable via .mgw/config.json retry.model_fallback setting
must_haves:
  truths:
    - lib/model-fallback.cjs exports ModelFallbackEngine class
    - ModelFallbackEngine.resolveFallbackChain returns ordered model list
    - ModelFallbackEngine.executeWithFallback wraps fn with model-tier retry
    - fallback_attempts tracked in returned result metadata
    - Configuration loaded from .mgw/config.json retry.model_fallback field
    - Integration with RetryPolicyEngine._classifyError for fallback triggers
    - gsd-adapter.cjs exports resolveFallbackChain wrapper function
  artifacts:
    - lib/model-fallback.cjs
  key_links:
    - lib/retry-policy.cjs (RetryPolicyEngine, dependency from #232)
    - lib/agent-errors.cjs (AGENT_FAILURE_TYPES, dependency from #229)
    - lib/gsd-adapter.cjs (resolveModel, existing adapter layer)
    - lib/errors.cjs (MgwError base class)
    - lib/retry.cjs (classifyFailure, getBackoffMs)
---

## Objective

Implement a model fallback strategy for GSD agent execution failures. When an agent fails
after retry exhaustion at a given model tier, automatically attempt re-execution with a
lower-tier model (e.g., opus -> sonnet -> haiku for analysis tasks). This extends the
existing RetryPolicyEngine from #232 with model-tier awareness.

## Context

### Architecture

The fallback engine sits BETWEEN the retry policy engine and the agent spawn call:

```
MGW orchestrator
  → RetryPolicyEngine.executeWithPolicy(fn, { agentType })    ← existing (#232)
    → on policy exhaustion at current model tier:
      → ModelFallbackEngine.executeWithFallback(fn, { agentType })  ← NEW (#233)
        → resolves fallback chain: [opus, sonnet, haiku]
        → tries fn(model) for each tier until success or chain exhausted
```

### Design Decisions

1. **Fallback chain is per-agent-type** — different agent types have different model chains
   (e.g., gsd-planner needs opus/sonnet, gsd-executor can use sonnet/haiku)
2. **Configurable via .mgw/config.json** — `retry.model_fallback: true/false` master switch,
   plus per-agent-type chain overrides
3. **Non-breaking** — when model_fallback is false (default), behavior is identical to pre-#233
4. **Integrates with gsd-adapter** — uses resolveModel for primary model, adds
   resolveFallbackChain for the ordered fallback list

### Dependencies

- lib/retry-policy.cjs (from #232 PR #241) — RetryPolicyEngine class
- lib/agent-errors.cjs (from #229 PR #238) — AGENT_FAILURE_TYPES, classifyAgentFailure
- lib/gsd-adapter.cjs — resolveModel, invokeGsdTool

## Tasks

### Task 1: Create lib/model-fallback.cjs

**files:** lib/model-fallback.cjs (new)
**action:** Create the ModelFallbackEngine class that:

1. **DEFAULT_FALLBACK_CHAINS** — frozen map of agent-type to model chain:
   ```
   gsd-planner:      [inherit, sonnet, haiku]
   gsd-executor:     [sonnet, haiku]
   gsd-verifier:     [sonnet, haiku]
   gsd-plan-checker: [sonnet, haiku]
   general-purpose:  [sonnet, haiku]
   ```
   Where "inherit" means "use the model running the current session" (passthrough).

2. **Constructor** — accepts opts for chain overrides and config path. Loads config
   from .mgw/config.json `retry.model_fallback` section if present. Merge priority:
   DEFAULT < config file < constructor opts.

3. **resolveFallbackChain(agentType)** — returns the ordered model list for an agent type.
   If model_fallback is disabled, returns only the primary model (no fallback).

4. **executeWithFallback(fn, opts)** — async wrapper:
   - Takes fn(modelName) as argument
   - Resolves the fallback chain for the agent type
   - For each model in chain: calls fn(model)
   - If fn succeeds: return { result, model, fallback_attempts, total_models_tried }
   - If fn throws: classify error; if non-retryable (hallucination, permission-denied),
     throw immediately without trying next model
   - If all models exhausted: throw ModelFallbackError with fallback_attempts count

5. **ModelFallbackError** — extends MgwError with fallback-specific fields:
   failureType, agentType, modelsAttempted, fallback_attempts

6. **Static loadConfig(configPath)** — loads from .mgw/config.json:
   ```json
   {
     "retry": {
       "model_fallback": true,
       "fallback_chains": {
         "gsd-planner": ["inherit", "sonnet"],
         "gsd-executor": ["sonnet", "haiku"]
       }
     }
   }
   ```

**verify:** `node -e "const m = require('./lib/model-fallback.cjs'); const e = new m.ModelFallbackEngine(); console.log(e.resolveFallbackChain('gsd-planner'));"` returns array with >= 2 models
**done:** lib/model-fallback.cjs exists, exports ModelFallbackEngine, ModelFallbackError

### Task 2: Add resolveFallbackChain to gsd-adapter.cjs

**files:** lib/gsd-adapter.cjs (modify)
**action:** Add a `resolveFallbackChain(agentType)` wrapper function to gsd-adapter.cjs that:
1. Creates a ModelFallbackEngine instance (or uses cached singleton)
2. Calls engine.resolveFallbackChain(agentType)
3. Returns the ordered model list
4. Export the new function

Also add `getModelFallbackEngine()` that returns the singleton engine for use by
callers who need the full executeWithFallback capability.

**verify:** `node -e "const a = require('./lib/gsd-adapter.cjs'); console.log(a.resolveFallbackChain('gsd-planner'));"` returns array
**done:** gsd-adapter.cjs exports resolveFallbackChain and getModelFallbackEngine

### Task 3: Integrate fallback with RetryPolicyEngine

**files:** lib/retry-policy.cjs (modify)
**action:** Extend RetryPolicyEngine.executeWithPolicy to optionally invoke model fallback
when retries are exhausted:

1. Add optional `modelFallback` field to executeWithPolicy opts
2. When retries exhaust and modelFallback is enabled:
   - Instead of throwing immediately, check if ModelFallbackEngine is available
   - If available and model_fallback is enabled in config: call
     engine.executeWithFallback with the next model in the chain
   - Track fallback_attempts in the returned result
3. Add `fallback_attempts` to RetryPolicyError fields
4. Safe import of model-fallback.cjs (like existing safe import of agent-errors.cjs)

**verify:** RetryPolicyEngine constructor works with and without model-fallback.cjs present
**done:** lib/retry-policy.cjs references model-fallback.cjs safely, fallback_attempts field present

## Verification

- [ ] lib/model-fallback.cjs exports ModelFallbackEngine and ModelFallbackError
- [ ] ModelFallbackEngine.resolveFallbackChain returns array of model names
- [ ] ModelFallbackEngine.executeWithFallback wraps async fn with model-tier retry
- [ ] fallback_attempts tracked in result and error objects
- [ ] Config loaded from .mgw/config.json retry.model_fallback when present
- [ ] Default behavior (no config) is model_fallback disabled (backward compatible)
- [ ] gsd-adapter.cjs exports resolveFallbackChain wrapper
- [ ] RetryPolicyEngine integration is safe (works without model-fallback.cjs)
- [ ] No hardcoded model names — uses gsd-tools resolve-model pattern

## Success Criteria

1. New file lib/model-fallback.cjs with ModelFallbackEngine class
2. gsd-adapter.cjs extended with resolveFallbackChain and getModelFallbackEngine
3. retry-policy.cjs extended with optional model fallback integration
4. All safe imports — no breaking changes when dependency files are absent
5. Configuration schema documented in config loading code

## Output

- lib/model-fallback.cjs (new)
- lib/gsd-adapter.cjs (modified)
- lib/retry-policy.cjs (modified)
