'use strict';

/**
 * lib/mock-gsd-agent.cjs — Fake GSD agent runner for tests
 *
 * Intercepts Task() spawns in MGW command tests, returning configurable
 * fixture outputs and recording spawn calls for assertion.
 *
 * Usage:
 *
 *   const mockAgent = require('./lib/mock-gsd-agent.cjs');
 *
 *   // Activate before test (optionally pass a scenario name)
 *   mockAgent.activate();                   // base fixtures only
 *   mockAgent.activate('planner-error');    // load test/fixtures/agents/planner-error/ overrides
 *
 *   // ... call spawnStub() where code would call Task() ...
 *   const output = mockAgent.spawnStub({
 *     subagent_type: 'gsd-planner',
 *     prompt: 'Plan phase 47...',
 *     model: 'inherit',
 *     description: 'Plan Phase 47'
 *   });
 *
 *   const calls = mockAgent.getCallLog();   // inspect what was spawned
 *   mockAgent.assertSpawned('gsd-planner'); // assert a specific agent type was used
 *   mockAgent.deactivate();                 // clean up
 *
 * Scenario support:
 *   Scenarios live in test/fixtures/agents/<scenario>/ and override base fixtures.
 *   Any fixture file present in the scenario directory takes precedence over the
 *   corresponding base fixture. This allows targeted per-test overrides.
 *
 * Inline overrides (highest precedence):
 *   mockAgent.setResponse('gsd-planner', '## PLANNING COMPLETE\n...');
 *
 * Call log format:
 *   Each entry: { subagent_type, prompt, model, description, output, timestamp }
 *
 * Safety:
 *   - Re-activating without deactivating first is safe (auto-deactivates).
 *   - Fixture load errors throw descriptive Error messages.
 *   - spawnStub() throws if called before activate().
 *   - All state is module-local — safe to require multiple times.
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the fixtures base directory relative to this file.
 * Works whether installed as a package or used in-repo.
 *
 * @returns {string} Absolute path to test/fixtures/agents/
 */
function resolveFixturesDir() {
  // Walk up from lib/ to find test/fixtures/agents/
  const libDir = __dirname;
  const repoRoot = path.resolve(libDir, '..');
  return path.join(repoRoot, 'test', 'fixtures', 'agents');
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

/**
 * Load a fixture file and return its contents as a string.
 * Returns the raw fixture content — callers receive exactly what the agent "returned".
 *
 * For fixtures whose JSON root is a string (e.g. `"## PLANNING COMPLETE\n..."`) we
 * strip the outer quotes since agent outputs are plain text, not JSON-encoded strings.
 * For fixtures whose JSON root is an object or array, we return compact JSON.
 *
 * @param {string} agentType - e.g. "gsd-planner", "general-purpose"
 * @param {string} baseDir - resolved fixtures base directory
 * @param {string|null} scenarioDir - resolved scenario override directory (or null)
 * @returns {string} fixture content as the agent would return it
 * @throws {Error} if fixture file not found in either location
 */
function loadFixture(agentType, baseDir, scenarioDir) {
  const filename = `${agentType}.json`;

  // Scenario directory takes precedence
  if (scenarioDir) {
    const scenarioPath = path.join(scenarioDir, filename);
    if (fs.existsSync(scenarioPath)) {
      return parseFixtureFile(scenarioPath, agentType);
    }
  }

  // Base fixture
  const basePath = path.join(baseDir, filename);
  if (fs.existsSync(basePath)) {
    return parseFixtureFile(basePath, agentType);
  }

  // No fixture found — return empty string (unknown agent type)
  return '';
}

/**
 * Read a fixture file and convert its content to agent-output-compatible string.
 *
 * JSON strings (root is a quoted string) are unwrapped: `"foo"` → `foo`
 * JSON objects/arrays are returned as compact JSON strings.
 * Empty strings (`""`) are returned as `""`.
 *
 * @param {string} filePath - absolute path to fixture .json file
 * @param {string} agentType - used in error messages
 * @returns {string}
 */
function parseFixtureFile(filePath, agentType) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8').trim();
  } catch (err) {
    throw new Error(`mock-gsd-agent: failed to read fixture "${agentType}" at ${filePath}: ${err.message}`, { cause: err });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`mock-gsd-agent: fixture "${agentType}" is not valid JSON (${filePath}): ${err.message}`, { cause: err });
  }

  // Unwrap JSON string values (agent outputs are plain text, not JSON-encoded strings)
  if (typeof parsed === 'string') {
    return parsed;
  }

  // Objects and arrays: return compact JSON (callers parse with JSON.parse)
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Whether the mock is currently active */
let _active = false;

/** Ordered log of recorded spawn calls */
let _callLog = [];

/** Resolved path to base fixtures directory */
let _baseDir = null;

/** Resolved path to scenario override directory (or null) */
let _scenarioDir = null;

/** Per-agent-type inline overrides: Map<string, string> (agentType → output string) */
let _inlineOverrides = new Map();

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Activate the mock. Sets up fixture directory resolution and resets state.
 *
 * Safe to call when already active — deactivates first, then re-activates.
 *
 * @param {string} [scenario] - Optional scenario name. If provided, fixtures from
 *   `test/fixtures/agents/<scenario>/` override the base fixtures.
 * @throws {Error} if the fixtures base directory does not exist
 */
function activate(scenario) {
  if (_active) {
    deactivate();
  }

  _baseDir = resolveFixturesDir();

  if (!fs.existsSync(_baseDir)) {
    throw new Error(
      `mock-gsd-agent: fixtures directory not found: ${_baseDir}\n` +
      'Create test/fixtures/agents/ with fixture JSON files before activating the mock.'
    );
  }

  if (scenario) {
    _scenarioDir = path.join(_baseDir, scenario);
    if (!fs.existsSync(_scenarioDir)) {
      throw new Error(
        `mock-gsd-agent: scenario directory not found: ${_scenarioDir}`
      );
    }
  } else {
    _scenarioDir = null;
  }

  _callLog = [];
  _inlineOverrides = new Map();
  _active = true;
}

/**
 * Deactivate the mock. Clears scenario dir and inline overrides.
 * Preserves the call log — callers inspect it after the test.
 * Safe to call when not active (no-op).
 */
function deactivate() {
  if (!_active) return;

  _active = false;
  _baseDir = null;
  _scenarioDir = null;
  _inlineOverrides = new Map();
  // Note: _callLog is preserved after deactivation
}

/**
 * Simulate a Task() spawn. Records the call and returns fixture output.
 *
 * This is the test-side replacement for the Task() orchestrator primitive.
 * Call it in test code wherever the production path would call Task().
 *
 * Output resolution order (highest to lowest precedence):
 *   1. Inline override set via setResponse(agentType, output)
 *   2. Scenario fixture: test/fixtures/agents/<scenario>/<agentType>.json
 *   3. Base fixture: test/fixtures/agents/<agentType>.json
 *   4. Empty string (if no fixture found)
 *
 * @param {object} config - Spawn configuration
 * @param {string} config.subagent_type - Agent type (e.g. "gsd-planner", "gsd-executor")
 * @param {string} [config.prompt] - The prompt that would be sent to the agent
 * @param {string} [config.model] - Model identifier (e.g. "inherit", "sonnet")
 * @param {string} [config.description] - Human-readable spawn description
 * @returns {string} The fixture output representing what the agent "returned"
 * @throws {Error} if called before activate()
 */
function spawnStub(config) {
  if (!_active) {
    throw new Error('mock-gsd-agent: spawnStub() called before activate(). Call activate() first.');
  }

  const {
    subagent_type,
    prompt = '',
    model = '',
    description = '',
  } = config || {};

  if (!subagent_type) {
    throw new Error('mock-gsd-agent: spawnStub() requires config.subagent_type');
  }

  // Output resolution: inline override > scenario fixture > base fixture > empty
  let output;
  if (_inlineOverrides.has(subagent_type)) {
    output = _inlineOverrides.get(subagent_type);
  } else {
    output = loadFixture(subagent_type, _baseDir, _scenarioDir);
  }

  _callLog.push({
    subagent_type,
    prompt,
    model,
    description,
    output,
    timestamp: new Date().toISOString(),
  });

  return output;
}

/**
 * Return the ordered array of recorded spawn entries since the last activate().
 * Each entry: { subagent_type, prompt, model, description, output, timestamp }
 *
 * @returns {Array<{subagent_type: string, prompt: string, model: string, description: string, output: string, timestamp: string}>}
 */
function getCallLog() {
  return _callLog.slice(); // defensive copy
}

/**
 * Clear the call log without deactivating the mock.
 * Useful for resetting between sub-scenarios in a single test.
 */
function clearCallLog() {
  _callLog = [];
}

/**
 * Set an inline response override for a given agent type.
 * Inline overrides take precedence over all fixture loading.
 *
 * Must be called after activate().
 *
 * @param {string} agentType - Agent type to override (e.g. "gsd-planner")
 * @param {string} output - Output string to return when this agent type is spawned
 * @throws {Error} if called before activate()
 */
function setResponse(agentType, output) {
  if (!_active) {
    throw new Error('mock-gsd-agent: setResponse() called before activate(). Call activate() first.');
  }
  _inlineOverrides.set(agentType, output);
}

/**
 * Whether the mock is currently active.
 * Useful for guard assertions in test setup/teardown.
 *
 * @returns {boolean}
 */
function isActive() {
  return _active;
}

/**
 * Return the number of spawn calls recorded.
 *
 * @param {string} [agentType] - If provided, count only calls with this subagent_type.
 *   If omitted, return total spawn count.
 * @returns {number}
 */
function getSpawnCount(agentType) {
  if (agentType === undefined) {
    return _callLog.length;
  }
  return _callLog.filter(entry => entry.subagent_type === agentType).length;
}

/**
 * Assert that a specific agent type was spawned at least once.
 * Throws an AssertionError with a descriptive message if not.
 *
 * Useful as a single-line assertion in tests:
 *   mockAgent.assertSpawned('gsd-planner');
 *
 * @param {string} agentType - Agent type that should have been spawned
 * @throws {AssertionError} if the agent type was not spawned
 */
function assertSpawned(agentType) {
  const count = getSpawnCount(agentType);
  assert.ok(
    count > 0,
    `mock-gsd-agent: assertSpawned('${agentType}') failed — no calls recorded for this agent type.\n` +
    `Recorded spawns: [${_callLog.map(e => e.subagent_type).join(', ')}]`
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  activate,
  deactivate,
  spawnStub,
  getCallLog,
  clearCallLog,
  setResponse,
  isActive,
  getSpawnCount,
  assertSpawned,
};
