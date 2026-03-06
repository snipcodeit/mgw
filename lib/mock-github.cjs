'use strict';

/**
 * lib/mock-github.cjs — GitHub API interceptor for tests
 *
 * Intercepts `child_process.execSync` calls that invoke the `gh` CLI, returning
 * pre-baked fixture responses instead of making real network calls.
 *
 * Usage:
 *
 *   const mockGitHub = require('./lib/mock-github.cjs');
 *
 *   // Activate before test (optionally pass a scenario name)
 *   mockGitHub.activate();             // base fixtures only
 *   mockGitHub.activate('pr-error');   // load test/fixtures/github/pr-error/ overrides
 *
 *   // ... run code that calls gh CLI ...
 *
 *   const calls = mockGitHub.getCallLog();  // inspect what was called
 *   mockGitHub.deactivate();                // restore real execSync
 *
 * Scenario support:
 *   Scenarios live in test/fixtures/github/<scenario>/ and override base fixtures.
 *   Any fixture key present in the scenario directory takes precedence over the
 *   corresponding base fixture. This allows targeted per-test overrides.
 *
 * Inline overrides (highest precedence):
 *   mockGitHub.setResponse('gh issue view', '{"number":999}');
 *
 * Call log format:
 *   Each entry: { cmd, fixture, returnValue, timestamp }
 *
 * Safety:
 *   - Re-activating without deactivating first is safe (auto-deactivates).
 *   - Module never makes real gh CLI calls.
 *   - Fixture load errors throw descriptive Error messages.
 */

const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the fixtures base directory relative to this file.
 * Works whether installed as a package or used in-repo.
 */
function resolveFixturesDir() {
  // Walk up from lib/ to find test/fixtures/github/
  const libDir = __dirname;
  const repoRoot = path.resolve(libDir, '..');
  return path.join(repoRoot, 'test', 'fixtures', 'github');
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

/**
 * Load a fixture file and return its contents as a string.
 * Returns the raw file content — callers receive exactly what execSync would.
 *
 * For fixtures whose JSON root is a string (e.g. `"https://..."`) we strip
 * the outer quotes since execSync output never includes JSON string quoting.
 * For fixtures whose JSON root is an object or array, we return the raw JSON.
 *
 * @param {string} fixtureKey - e.g. "issue-view", "pr-create"
 * @param {string} baseDir - resolved fixtures base directory
 * @param {string|null} scenarioDir - resolved scenario override directory (or null)
 * @returns {string} fixture content as execSync would return it
 * @throws {Error} if fixture file not found in either location
 */
function loadFixture(fixtureKey, baseDir, scenarioDir) {
  const filename = `${fixtureKey}.json`;

  // Scenario directory takes precedence
  if (scenarioDir) {
    const scenarioPath = path.join(scenarioDir, filename);
    if (fs.existsSync(scenarioPath)) {
      return parseFixtureFile(scenarioPath, fixtureKey);
    }
  }

  // Base fixture
  const basePath = path.join(baseDir, filename);
  if (fs.existsSync(basePath)) {
    return parseFixtureFile(basePath, fixtureKey);
  }

  throw new Error(
    `mock-github: fixture not found: "${fixtureKey}" (looked for ${filename} in ${baseDir}${scenarioDir ? ` and ${scenarioDir}` : ''})`
  );
}

/**
 * Read a fixture file and convert its content to execSync-compatible output.
 *
 * JSON strings (root is a quoted string) are unwrapped: `"foo"` → `foo`
 * JSON objects/arrays are returned as compact JSON strings.
 * Empty strings (`""`) are returned as `""`.
 *
 * @param {string} filePath - absolute path to fixture .json file
 * @param {string} fixtureKey - used in error messages
 * @returns {string}
 */
function parseFixtureFile(filePath, fixtureKey) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8').trim();
  } catch (err) {
    throw new Error(`mock-github: failed to read fixture "${fixtureKey}" at ${filePath}: ${err.message}`, { cause: err });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`mock-github: fixture "${fixtureKey}" is not valid JSON (${filePath}): ${err.message}`, { cause: err });
  }

  // Unwrap JSON string values (execSync output is never JSON-encoded strings)
  if (typeof parsed === 'string') {
    return parsed;
  }

  // Objects and arrays: return compact JSON (callers parse with JSON.parse)
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

/**
 * Route table: ordered list of [pattern, fixtureKey] pairs.
 * First match wins. Patterns are matched against the full command string.
 *
 * Built-in responses (not loaded from fixtures) are also handled in routeCommand().
 */
const ROUTE_TABLE = [
  // Issue operations
  [/\bgh issue view\b/, 'issue-view'],
  [/\bgh issue list\b/, 'issue-list'],
  [/\bgh issue comment\b/, 'issue-comment'],
  [/\bgh issue edit\b/, 'issue-edit'],

  // Milestone operations (order matters: PATCH before GET)
  [/\bgh api\b.*\/milestones\/\d+.*--method PATCH/, 'milestone-close'],
  [/\bgh api\b.*--method POST.*\/milestones/, 'milestone-create'],
  [/\bgh api\b.*\/milestones\b.*--method POST/, 'milestone-create'],
  [/\bgh api repos\/.*\/milestones\/\d+/, 'milestone-view'],

  // Label operations
  [/\bgh label create\b/, 'label-create'],
  [/\bgh label list\b/, 'label-list'],

  // PR operations
  [/\bgh pr create\b/, 'pr-create'],
  [/\bgh pr view\b/, 'pr-view'],

  // Rate limit
  [/\bgh api rate_limit\b/, 'rate-limit'],

  // Board / GraphQL operations (order matters: specific mutations before generic graphql)
  [/\bgh api graphql\b.*updateProjectV2ItemFieldValue/, 'graphql-board-mutation'],
  [/\bgh api graphql\b.*discussionCategories/, 'repo-meta'],
  [/\bgh api graphql\b.*createDiscussion/, 'discussion-create'],
  [/\bgh project item-add\b/, 'board-item'],
];

/**
 * Built-in responses — returned directly without loading a fixture file.
 * These cover repo identity and user queries that are near-universal.
 */
const BUILTINS = [
  [/\bgh repo view\b/, 'snipcodeit/mgw'],
  [/\bgh api user\b/, '{"login":"snipcodeit"}'],
  [/\bgh api\b.*\/user\b/, '{"login":"snipcodeit"}'],
];

/**
 * Find the matching fixture key or builtin value for a command string.
 *
 * @param {string} cmd - the execSync command string
 * @param {Map<string, string>} inlineOverrides - per-command inline overrides
 * @returns {{ type: 'fixture'|'builtin'|'empty', key?: string, value?: string }}
 */
function routeCommand(cmd, inlineOverrides) {
  // 1. Inline overrides (highest precedence) — match by prefix/substring
  for (const [pattern, value] of inlineOverrides) {
    if (cmd.includes(pattern)) {
      return { type: 'builtin', key: pattern, value };
    }
  }

  // 2. Builtin responses
  for (const [pattern, value] of BUILTINS) {
    if (pattern.test(cmd)) {
      return { type: 'builtin', key: String(pattern), value };
    }
  }

  // 3. Route table → fixture key
  for (const [pattern, fixtureKey] of ROUTE_TABLE) {
    if (pattern.test(cmd)) {
      return { type: 'fixture', key: fixtureKey };
    }
  }

  // 4. Default: empty string (unknown command)
  return { type: 'empty', key: null };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The original child_process.execSync before any mock was installed */
let _originalExecSync = null;

/** Whether the mock is currently active */
let _active = false;

/** Ordered log of intercepted calls */
let _callLog = [];

/** Resolved path to base fixtures directory */
let _baseDir = null;

/** Resolved path to scenario override directory (or null) */
let _scenarioDir = null;

/** Per-command inline overrides: Map<string, string> (pattern string → return value) */
let _inlineOverrides = new Map();

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Activate the mock. Replaces child_process.execSync with an interceptor.
 *
 * Safe to call when already active — deactivates first, then re-activates.
 *
 * @param {string} [scenario] - Optional scenario name. If provided, fixtures from
 *   `test/fixtures/github/<scenario>/` override the base fixtures.
 * @throws {Error} if the fixtures base directory does not exist
 */
function activate(scenario) {
  if (_active) {
    deactivate();
  }

  _baseDir = resolveFixturesDir();

  if (!fs.existsSync(_baseDir)) {
    throw new Error(
      `mock-github: fixtures directory not found: ${_baseDir}\n` +
      'Create test/fixtures/github/ with fixture JSON files before activating the mock.'
    );
  }

  if (scenario) {
    _scenarioDir = path.join(_baseDir, scenario);
    if (!fs.existsSync(_scenarioDir)) {
      throw new Error(
        `mock-github: scenario directory not found: ${_scenarioDir}`
      );
    }
  } else {
    _scenarioDir = null;
  }

  _callLog = [];
  _inlineOverrides = new Map();

  // Store original and install interceptor
  _originalExecSync = childProcess.execSync;

  childProcess.execSync = function mockExecSync(cmd, _opts) {
    const route = routeCommand(cmd, _inlineOverrides);

    let returnValue;
    let fixtureKey;

    if (route.type === 'builtin') {
      returnValue = route.value;
      fixtureKey = route.key;
    } else if (route.type === 'fixture') {
      returnValue = loadFixture(route.key, _baseDir, _scenarioDir);
      fixtureKey = route.key;
    } else {
      returnValue = '';
      fixtureKey = null;
    }

    _callLog.push({
      cmd,
      fixture: fixtureKey,
      returnValue,
      timestamp: new Date().toISOString(),
    });

    return returnValue;
  };

  _active = true;
}

/**
 * Deactivate the mock. Restores the original child_process.execSync.
 * Safe to call when not active (no-op).
 */
function deactivate() {
  if (!_active) return;

  childProcess.execSync = _originalExecSync;
  _originalExecSync = null;
  _active = false;
  _baseDir = null;
  _scenarioDir = null;
  _inlineOverrides = new Map();
  // Note: call log is preserved after deactivation — callers inspect it after the test
}

/**
 * Return the ordered array of intercepted call entries since the last activate().
 * Each entry: { cmd, fixture, returnValue, timestamp }
 *
 * @returns {Array<{cmd: string, fixture: string|null, returnValue: string, timestamp: string}>}
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
 * Set an inline response override for commands matching the given pattern string.
 * The pattern is matched with String.prototype.includes() against the full command.
 * Inline overrides take precedence over all other routing (builtins and fixture table).
 *
 * Must be called after activate().
 *
 * @param {string} cmdPattern - Substring to match in the command string
 * @param {string} returnValue - Value to return when the pattern matches
 * @throws {Error} if called before activate()
 */
function setResponse(cmdPattern, returnValue) {
  if (!_active) {
    throw new Error('mock-github: setResponse() called before activate(). Call activate() first.');
  }
  _inlineOverrides.set(cmdPattern, returnValue);
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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  activate,
  deactivate,
  getCallLog,
  clearCallLog,
  setResponse,
  isActive,
};
