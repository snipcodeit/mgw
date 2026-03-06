/**
 * test/checkpoint.test.js — Unit tests for checkpoint read/write and resume
 * detection functions in lib/state.cjs.
 *
 * Covers:
 *   - updateCheckpoint() merge semantics (step_progress shallow merge,
 *     artifacts/step_history append-only, resume full-replace)
 *   - detectCheckpoint() returning null for triage-only checkpoints and
 *     non-null for checkpoints at plan/execute/verify/pr steps
 *   - resumeFromCheckpoint() mapping resume.action to resumeStage for all
 *     documented action values, plus unknown/null default
 *   - clearCheckpoint() resetting checkpoint to null
 *   - Forward-compat round-trip: unknown fields in checkpoint are preserved
 *
 * Isolation strategy:
 *   - fs.mkdtempSync() creates a real tmp dir per describe block
 *   - process.cwd() is overridden so getMgwDir() stays sandboxed
 *   - require.cache is cleared before each require of state.cjs
 *   - afterEach removes .mgw/ and restores process.cwd()
 *   - Tmp dirs removed in afterAll via fs.rmSync
 *
 * This file uses the same isolation pattern as test/state.test.cjs and
 * test/validate-and-load.test.js but imports via vitest (ESM) format.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_MODULE = path.join(REPO_ROOT, 'lib', 'state.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clear state module cache and re-require fresh.
 * Required so that process.cwd() overrides take effect on path resolution.
 */
function loadState() {
  delete _require.cache[STATE_MODULE];
  return _require(STATE_MODULE);
}

/**
 * Override process.cwd to return tmpDir.
 * Returns a restore function — call it in afterEach.
 */
function overrideCwd(tmpDir) {
  const original = process.cwd.bind(process);
  process.cwd = () => tmpDir;
  return () => {
    process.cwd = original;
  };
}

/**
 * Remove .mgw/ inside tmpDir if it exists.
 */
function cleanMgw(tmpDir) {
  const mgwDir = path.join(tmpDir, '.mgw');
  if (fs.existsSync(mgwDir)) {
    fs.rmSync(mgwDir, { recursive: true, force: true });
  }
}

/**
 * Write a minimal issue state file into .mgw/active/.
 * Creates directories as needed.
 *
 * @param {string} tmpDir - Tmp directory root (process.cwd() override target)
 * @param {number} issueNumber - Issue number used to name the file
 * @param {object} overrides - Fields to merge onto the base state
 * @returns {{ filePath: string, state: object }} Written file path and state object
 */
function writeIssueState(tmpDir, issueNumber, overrides = {}) {
  const activeDir = path.join(tmpDir, '.mgw', 'active');
  fs.mkdirSync(activeDir, { recursive: true });

  const base = {
    issue_number: issueNumber,
    slug: `test-issue-${issueNumber}`,
    title: `Test issue ${issueNumber}`,
    pipeline_stage: 'triaged',
    gsd_route: 'plan-phase',
    checkpoint: null,
  };
  const state = Object.assign({}, base, overrides);
  const fileName = `${issueNumber}-test-issue-${issueNumber}.json`;
  const filePath = path.join(activeDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  return { filePath, state };
}

/**
 * Read and parse the issue state file from .mgw/active/.
 */
function readIssueState(tmpDir, issueNumber) {
  const activeDir = path.join(tmpDir, '.mgw', 'active');
  const entries = fs.readdirSync(activeDir);
  const match = entries.find(f => f.startsWith(`${issueNumber}-`) && f.endsWith('.json'));
  if (!match) return null;
  return JSON.parse(fs.readFileSync(path.join(activeDir, match), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Group 1: updateCheckpoint() — merge semantics
// ---------------------------------------------------------------------------

describe('updateCheckpoint() — merge semantics', () => {
  let tmpDir;
  let restoreCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-cp-test-g1-'));
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('initializes checkpoint from null when none exists', () => {
    writeIssueState(tmpDir, 1, { checkpoint: null });
    const { updateCheckpoint } = loadState();

    const result = updateCheckpoint(1, { pipeline_step: 'plan' });

    expect(result.updated).toBe(true);
    expect(result.checkpoint).toBeTruthy();
    expect(result.checkpoint.pipeline_step).toBe('plan');
    expect(result.checkpoint.schema_version).toBe(1);
    expect(result.checkpoint.artifacts).toEqual([]);
    expect(result.checkpoint.step_history).toEqual([]);

    const persisted = readIssueState(tmpDir, 1);
    expect(persisted.checkpoint).toBeTruthy();
    expect(persisted.checkpoint.pipeline_step).toBe('plan');
  });

  it('overwrites pipeline_step on subsequent calls', () => {
    writeIssueState(tmpDir, 2, { checkpoint: null });
    const { updateCheckpoint } = loadState();

    updateCheckpoint(2, { pipeline_step: 'plan' });
    updateCheckpoint(2, { pipeline_step: 'execute' });

    const persisted = readIssueState(tmpDir, 2);
    expect(persisted.checkpoint.pipeline_step).toBe('execute');
  });

  it('shallow-merges step_progress — existing keys preserved, new keys added', () => {
    writeIssueState(tmpDir, 3, { checkpoint: null });
    const { updateCheckpoint } = loadState();

    // First write: sets plan_path and plan_checked
    updateCheckpoint(3, {
      pipeline_step: 'plan',
      step_progress: { plan_path: '/some/plan.md', plan_checked: false },
    });

    // Second write: only updates plan_checked — plan_path must be preserved
    updateCheckpoint(3, {
      step_progress: { plan_checked: true },
    });

    const persisted = readIssueState(tmpDir, 3);
    expect(persisted.checkpoint.step_progress.plan_path).toBe('/some/plan.md');
    expect(persisted.checkpoint.step_progress.plan_checked).toBe(true);
  });

  it('appends artifacts — never replaces existing entries', () => {
    writeIssueState(tmpDir, 4, { checkpoint: null });
    const { updateCheckpoint } = loadState();

    const artifact1 = { path: 'plan.md', type: 'plan', created_at: '2026-03-06T10:00:00Z' };
    const artifact2 = { path: 'summary.md', type: 'summary', created_at: '2026-03-06T11:00:00Z' };

    updateCheckpoint(4, { artifacts: [artifact1] });
    updateCheckpoint(4, { artifacts: [artifact2] });

    const persisted = readIssueState(tmpDir, 4);
    expect(persisted.checkpoint.artifacts).toHaveLength(2);
    expect(persisted.checkpoint.artifacts[0].path).toBe('plan.md');
    expect(persisted.checkpoint.artifacts[1].path).toBe('summary.md');
  });

  it('appends step_history — never replaces existing entries', () => {
    writeIssueState(tmpDir, 5, { checkpoint: null });
    const { updateCheckpoint } = loadState();

    const entry1 = { step: 'plan', completed_at: '2026-03-06T10:00:00Z', agent_type: 'gsd-planner' };
    const entry2 = { step: 'execute', completed_at: '2026-03-06T11:00:00Z', agent_type: 'gsd-executor' };

    updateCheckpoint(5, { step_history: [entry1] });
    updateCheckpoint(5, { step_history: [entry2] });

    const persisted = readIssueState(tmpDir, 5);
    expect(persisted.checkpoint.step_history).toHaveLength(2);
    expect(persisted.checkpoint.step_history[0].step).toBe('plan');
    expect(persisted.checkpoint.step_history[1].step).toBe('execute');
  });

  it('fully replaces resume on each call (resume.context is opaque)', () => {
    writeIssueState(tmpDir, 6, { checkpoint: null });
    const { updateCheckpoint } = loadState();

    updateCheckpoint(6, { resume: { action: 'spawn-executor', context: { quick_dir: '/a' } } });
    updateCheckpoint(6, { resume: { action: 'spawn-verifier', context: { quick_dir: '/b', plan_num: 2 } } });

    const persisted = readIssueState(tmpDir, 6);
    expect(persisted.checkpoint.resume.action).toBe('spawn-verifier');
    expect(persisted.checkpoint.resume.context.quick_dir).toBe('/b');
    expect(persisted.checkpoint.resume.context.plan_num).toBe(2);
    // Old context from first call must not persist
    expect(Object.keys(persisted.checkpoint.resume.context)).toHaveLength(2);
  });

  it('updates last_agent_output on each call', () => {
    writeIssueState(tmpDir, 7, { checkpoint: null });
    const { updateCheckpoint } = loadState();

    updateCheckpoint(7, { last_agent_output: '/first/output.md' });
    updateCheckpoint(7, { last_agent_output: '/second/output.md' });

    const persisted = readIssueState(tmpDir, 7);
    expect(persisted.checkpoint.last_agent_output).toBe('/second/output.md');
  });

  it('always updates updated_at timestamp', () => {
    writeIssueState(tmpDir, 8, { checkpoint: null });
    const { updateCheckpoint } = loadState();

    const before = new Date().toISOString();
    const result = updateCheckpoint(8, { pipeline_step: 'plan' });

    expect(result.checkpoint.updated_at).toBeDefined();
    expect(result.checkpoint.updated_at >= before).toBe(true);
  });

  it('throws when no state file exists for the issue number', () => {
    // Do not create a state file for issue 9
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    const { updateCheckpoint } = loadState();

    expect(() => updateCheckpoint(9, { pipeline_step: 'plan' })).toThrow(/No state file found/);
  });
});

// ---------------------------------------------------------------------------
// Group 2: detectCheckpoint() — null-return semantics
// ---------------------------------------------------------------------------

describe('detectCheckpoint() — null-return semantics', () => {
  let tmpDir;
  let restoreCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-cp-test-g2-'));
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns null when no state file exists for the issue number', () => {
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    const { detectCheckpoint } = loadState();

    expect(detectCheckpoint(100)).toBeNull();
  });

  it('returns null when checkpoint field is null', () => {
    writeIssueState(tmpDir, 101, { checkpoint: null });
    const { detectCheckpoint } = loadState();

    expect(detectCheckpoint(101)).toBeNull();
  });

  it('returns null when pipeline_step is "triage" (index 0 — not resumable)', () => {
    writeIssueState(tmpDir, 102, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'triage',
        step_progress: { comment_check_done: true },
        last_agent_output: null,
        artifacts: [],
        resume: { action: 'begin-execution', context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:01:00Z',
        step_history: [],
      },
    });
    const { detectCheckpoint } = loadState();

    expect(detectCheckpoint(102)).toBeNull();
  });

  it('returns checkpoint data when pipeline_step is "plan" (index 1)', () => {
    writeIssueState(tmpDir, 103, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'plan',
        step_progress: { plan_path: '/plan.md', plan_checked: false },
        last_agent_output: '/plan.md',
        artifacts: [{ path: '/plan.md', type: 'plan', created_at: '2026-03-06T10:00:00Z' }],
        resume: { action: 'run-plan-checker', context: { quick_dir: '/q' } },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:05:00Z',
        step_history: [],
      },
    });
    const { detectCheckpoint } = loadState();

    const cp = detectCheckpoint(103);
    expect(cp).not.toBeNull();
    expect(cp.pipeline_step).toBe('plan');
    expect(cp.step_progress.plan_path).toBe('/plan.md');
    expect(cp.artifacts).toHaveLength(1);
    expect(cp.resume.action).toBe('run-plan-checker');
  });

  it('returns checkpoint data when pipeline_step is "execute"', () => {
    writeIssueState(tmpDir, 104, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'execute',
        step_progress: { gsd_phase: 1, tasks_completed: 2, tasks_total: 5 },
        last_agent_output: null,
        artifacts: [],
        resume: { action: 'continue-execution', context: { phase_number: 1 } },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:10:00Z',
        step_history: [],
      },
    });
    const { detectCheckpoint } = loadState();

    const cp = detectCheckpoint(104);
    expect(cp).not.toBeNull();
    expect(cp.pipeline_step).toBe('execute');
  });

  it('returns checkpoint data when pipeline_step is "verify"', () => {
    writeIssueState(tmpDir, 105, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'verify',
        step_progress: { verification_path: '/verify.md', must_haves_checked: true },
        last_agent_output: '/verify.md',
        artifacts: [],
        resume: { action: 'create-pr', context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:20:00Z',
        step_history: [],
      },
    });
    const { detectCheckpoint } = loadState();

    const cp = detectCheckpoint(105);
    expect(cp).not.toBeNull();
    expect(cp.pipeline_step).toBe('verify');
  });

  it('returns checkpoint data when pipeline_step is "pr"', () => {
    writeIssueState(tmpDir, 106, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'pr',
        step_progress: { branch_pushed: true, pr_number: 42, pr_url: 'https://github.com/r/p/pulls/42' },
        last_agent_output: 'https://github.com/r/p/pulls/42',
        artifacts: [],
        resume: { action: 'cleanup', context: { pr_number: 42 } },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:30:00Z',
        step_history: [],
      },
    });
    const { detectCheckpoint } = loadState();

    const cp = detectCheckpoint(106);
    expect(cp).not.toBeNull();
    expect(cp.pipeline_step).toBe('pr');
  });
});

// ---------------------------------------------------------------------------
// Group 3: resumeFromCheckpoint() — action → stage mapping
// ---------------------------------------------------------------------------

describe('resumeFromCheckpoint() — action to resumeStage mapping', () => {
  let tmpDir;
  let restoreCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-cp-test-g3-'));
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper: write an issue state with a plan-step checkpoint and a given resume action.
   */
  function writeCheckpointWithAction(issueNumber, action, extraHistory = []) {
    writeIssueState(tmpDir, issueNumber, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'plan',
        step_progress: {},
        last_agent_output: null,
        artifacts: [],
        resume: { action, context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:05:00Z',
        step_history: extraHistory,
      },
    });
  }

  it('returns null when no resumable checkpoint exists (triage-only)', () => {
    writeIssueState(tmpDir, 200, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'triage',
        step_progress: {},
        last_agent_output: null,
        artifacts: [],
        resume: { action: 'begin-execution', context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:00:00Z',
        step_history: [],
      },
    });
    const { resumeFromCheckpoint } = loadState();

    expect(resumeFromCheckpoint(200)).toBeNull();
  });

  it('maps "run-plan-checker" → resumeStage "planning"', () => {
    writeCheckpointWithAction(201, 'run-plan-checker');
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(201);
    expect(result).not.toBeNull();
    expect(result.resumeStage).toBe('planning');
    expect(result.resumeAction).toBe('run-plan-checker');
  });

  it('maps "spawn-executor" → resumeStage "executing"', () => {
    writeCheckpointWithAction(202, 'spawn-executor');
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(202);
    expect(result.resumeStage).toBe('executing');
    expect(result.resumeAction).toBe('spawn-executor');
  });

  it('maps "continue-execution" → resumeStage "executing"', () => {
    writeCheckpointWithAction(203, 'continue-execution');
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(203);
    expect(result.resumeStage).toBe('executing');
    expect(result.resumeAction).toBe('continue-execution');
  });

  it('maps "spawn-verifier" → resumeStage "verifying"', () => {
    writeCheckpointWithAction(204, 'spawn-verifier');
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(204);
    expect(result.resumeStage).toBe('verifying');
    expect(result.resumeAction).toBe('spawn-verifier');
  });

  it('maps "create-pr" → resumeStage "pr-pending"', () => {
    writeCheckpointWithAction(205, 'create-pr');
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(205);
    expect(result.resumeStage).toBe('pr-pending');
    expect(result.resumeAction).toBe('create-pr');
  });

  it('maps "begin-execution" → resumeStage "planning"', () => {
    writeCheckpointWithAction(206, 'begin-execution');
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(206);
    expect(result.resumeStage).toBe('planning');
    expect(result.resumeAction).toBe('begin-execution');
  });

  it('maps null action → resumeStage "planning" (safe default), resumeAction "unknown"', () => {
    writeCheckpointWithAction(207, null);
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(207);
    expect(result.resumeStage).toBe('planning');
    expect(result.resumeAction).toBe('unknown');
  });

  it('maps unrecognized action → resumeStage "planning" (safe default)', () => {
    writeCheckpointWithAction(208, 'future-unknown-action');
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(208);
    expect(result.resumeStage).toBe('planning');
    expect(result.resumeAction).toBe('future-unknown-action');
  });

  it('derives completedSteps from step_history entries', () => {
    const history = [
      { step: 'plan', completed_at: '2026-03-06T10:00:00Z', agent_type: 'gsd-planner' },
      { step: 'execute', completed_at: '2026-03-06T10:30:00Z', agent_type: 'gsd-executor' },
    ];
    writeCheckpointWithAction(209, 'spawn-verifier', history);
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(209);
    expect(result.completedSteps).toEqual(['plan', 'execute']);
  });

  it('returns empty completedSteps when step_history is empty', () => {
    writeCheckpointWithAction(210, 'run-plan-checker', []);
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(210);
    expect(result.completedSteps).toEqual([]);
  });

  it('returns checkpoint data nested under result.checkpoint', () => {
    writeCheckpointWithAction(211, 'spawn-executor');
    const { resumeFromCheckpoint } = loadState();

    const result = resumeFromCheckpoint(211);
    expect(result.checkpoint).toBeDefined();
    expect(result.checkpoint.pipeline_step).toBe('plan');
    expect(result.checkpoint.resume.action).toBe('spawn-executor');
  });
});

// ---------------------------------------------------------------------------
// Group 4: clearCheckpoint() — reset behavior
// ---------------------------------------------------------------------------

describe('clearCheckpoint() — reset to null', () => {
  let tmpDir;
  let restoreCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-cp-test-g4-'));
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('sets checkpoint to null and returns { cleared: true } when checkpoint was non-null', () => {
    writeIssueState(tmpDir, 300, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'plan',
        step_progress: {},
        last_agent_output: null,
        artifacts: [],
        resume: { action: 'spawn-executor', context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:05:00Z',
        step_history: [],
      },
    });
    const { clearCheckpoint } = loadState();

    const result = clearCheckpoint(300);

    expect(result).toEqual({ cleared: true });

    const persisted = readIssueState(tmpDir, 300);
    expect(persisted.checkpoint).toBeNull();
  });

  it('returns { cleared: false } when checkpoint was already null', () => {
    writeIssueState(tmpDir, 301, { checkpoint: null });
    const { clearCheckpoint } = loadState();

    const result = clearCheckpoint(301);

    expect(result).toEqual({ cleared: false });

    const persisted = readIssueState(tmpDir, 301);
    expect(persisted.checkpoint).toBeNull();
  });

  it('preserves other fields in the state file (pipeline_stage, triage, etc.)', () => {
    writeIssueState(tmpDir, 302, {
      pipeline_stage: 'executing',
      gsd_route: 'plan-phase',
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'execute',
        step_progress: {},
        last_agent_output: null,
        artifacts: [],
        resume: { action: null, context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:05:00Z',
        step_history: [],
      },
    });
    const { clearCheckpoint } = loadState();

    clearCheckpoint(302);

    const persisted = readIssueState(tmpDir, 302);
    expect(persisted.pipeline_stage).toBe('executing');
    expect(persisted.gsd_route).toBe('plan-phase');
    expect(persisted.checkpoint).toBeNull();
  });

  it('writes atomically (uses atomicWriteJson — no .tmp file left behind)', () => {
    writeIssueState(tmpDir, 303, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'plan',
        step_progress: {},
        last_agent_output: null,
        artifacts: [],
        resume: { action: null, context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:05:00Z',
        step_history: [],
      },
    });
    const { clearCheckpoint } = loadState();

    clearCheckpoint(303);

    const activeDir = path.join(tmpDir, '.mgw', 'active');
    const entries = fs.readdirSync(activeDir);
    const tmpFiles = entries.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('throws when no state file found for the issue number', () => {
    const activeDir = path.join(tmpDir, '.mgw', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    const { clearCheckpoint } = loadState();

    expect(() => clearCheckpoint(999)).toThrow(/No state file found/);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Forward-compatibility — unknown fields preserved on round-trip
// ---------------------------------------------------------------------------

describe('Forward-compatibility — unknown fields preserved on round-trip', () => {
  let tmpDir;
  let restoreCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-cp-test-g5-'));
    restoreCwd = overrideCwd(tmpDir);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves unknown top-level checkpoint fields on updateCheckpoint round-trip', () => {
    // Simulate a checkpoint written by a future version with an extra field
    writeIssueState(tmpDir, 400, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'plan',
        step_progress: { plan_path: '/plan.md' },
        last_agent_output: '/plan.md',
        artifacts: [],
        resume: { action: 'spawn-executor', context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:05:00Z',
        step_history: [],
        // Future field that current consumers do not know about
        future_field: 'preserve-me',
        another_future_field: { nested: true },
      },
    });

    const { updateCheckpoint } = loadState();

    // Perform a read-modify-write (update step_progress)
    updateCheckpoint(400, {
      step_progress: { plan_checked: true },
    });

    const persisted = readIssueState(tmpDir, 400);

    // Known fields work correctly
    expect(persisted.checkpoint.step_progress.plan_path).toBe('/plan.md');
    expect(persisted.checkpoint.step_progress.plan_checked).toBe(true);

    // Unknown fields must be preserved
    expect(persisted.checkpoint.future_field).toBe('preserve-me');
    expect(persisted.checkpoint.another_future_field).toEqual({ nested: true });
  });

  it('preserves unknown step_progress keys on shallow merge', () => {
    writeIssueState(tmpDir, 401, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'execute',
        step_progress: {
          gsd_phase: 1,
          tasks_completed: 2,
          tasks_total: 5,
          // Key from a future pipeline version
          future_progress_key: 'do-not-lose-me',
        },
        last_agent_output: null,
        artifacts: [],
        resume: { action: 'continue-execution', context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:10:00Z',
        step_history: [],
      },
    });

    const { updateCheckpoint } = loadState();

    // Update tasks_completed only — future_progress_key must survive
    updateCheckpoint(401, {
      step_progress: { tasks_completed: 3 },
    });

    const persisted = readIssueState(tmpDir, 401);
    expect(persisted.checkpoint.step_progress.gsd_phase).toBe(1);
    expect(persisted.checkpoint.step_progress.tasks_completed).toBe(3);
    expect(persisted.checkpoint.step_progress.tasks_total).toBe(5);
    expect(persisted.checkpoint.step_progress.future_progress_key).toBe('do-not-lose-me');
  });

  it('detectCheckpoint returns unknown step_progress keys intact', () => {
    writeIssueState(tmpDir, 402, {
      checkpoint: {
        schema_version: 1,
        pipeline_step: 'plan',
        step_progress: {
          plan_path: '/plan.md',
          unknown_future_key: 42,
        },
        last_agent_output: null,
        artifacts: [],
        resume: { action: 'run-plan-checker', context: {} },
        started_at: '2026-03-06T10:00:00Z',
        updated_at: '2026-03-06T10:05:00Z',
        step_history: [],
      },
    });

    const { detectCheckpoint } = loadState();
    const cp = detectCheckpoint(402);

    expect(cp).not.toBeNull();
    expect(cp.step_progress.plan_path).toBe('/plan.md');
    expect(cp.step_progress.unknown_future_key).toBe(42);
  });
});
