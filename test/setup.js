/**
 * test/setup.js — Vitest global setup
 *
 * Auto-activates mock-github and mock-gsd-agent before each test, and
 * deactivates them after. Both mocks are conditionally required — the
 * setup works correctly even when lib/mock-github.cjs or
 * lib/mock-gsd-agent.cjs are not yet present (e.g., when PRs #258 and
 * #259 are not yet merged to main).
 *
 * To use mocks in a vitest test file:
 *
 *   import { mockGitHub, mockGsdAgent } from './setup.js';
 *
 *   test('my test', () => {
 *     // mocks are already active (activated in beforeEach)
 *     mockGitHub.setResponse('gh issue view', '{"number":999}');
 *     // ...
 *   });
 *
 * To use a scenario:
 *
 *   import { mockGitHub } from './setup.js';
 *
 *   beforeEach(() => {
 *     // Override the global beforeEach activation with a scenario
 *     mockGitHub.deactivate();
 *     mockGitHub.activate('pr-error');
 *   });
 */

import { beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Conditional mock loading
// ---------------------------------------------------------------------------

// Conditionally load mock-github — gracefully skip if not present
// (lib/mock-github.cjs lands via PR #258)
let mockGitHub = null;
try {
  mockGitHub = require(path.join(repoRoot, 'lib', 'mock-github.cjs'));
} catch (_e) {
  // mock-github.cjs not available — tests run without GitHub API interception
}

// Conditionally load mock-gsd-agent — gracefully skip if not present
// (lib/mock-gsd-agent.cjs lands via PR #259)
let mockGsdAgent = null;
try {
  mockGsdAgent = require(path.join(repoRoot, 'lib', 'mock-gsd-agent.cjs'));
} catch (_e) {
  // mock-gsd-agent.cjs not available — tests run without agent spawn interception
}

// ---------------------------------------------------------------------------
// Auto-activate hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
  if (mockGitHub && typeof mockGitHub.activate === 'function') {
    mockGitHub.activate();
  }
  if (mockGsdAgent && typeof mockGsdAgent.activate === 'function') {
    mockGsdAgent.activate();
  }
});

afterEach(() => {
  if (mockGitHub && typeof mockGitHub.deactivate === 'function') {
    mockGitHub.deactivate();
  }
  if (mockGsdAgent && typeof mockGsdAgent.deactivate === 'function') {
    mockGsdAgent.deactivate();
  }
});

// ---------------------------------------------------------------------------
// Exports — available for test files that need direct mock access
// ---------------------------------------------------------------------------

export { mockGitHub, mockGsdAgent };
