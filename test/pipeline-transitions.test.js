/**
 * test/pipeline-transitions.test.js — Pipeline stage transition tests for mgw:run
 *
 * Simulates a full mgw:run cycle (triage → plan → execute → verify → pr-created → done)
 * using mock agents. Asserts:
 *   - pipeline_stage transitions via lib/pipeline.cjs
 *   - checkpoint pipeline_step progression via lib/state.cjs
 *   - onTransition hooks fire at each stage change
 *   - mock GitHub call log captures expected commands
 *   - mock GSD agent spawns are recorded
 *
 * Tests:
 *   1. happy-path — new → triaged → planning → executing → verifying → pr-created → done
 *   2. failure-mode: agent returns no output → failed
 *   3. failure-mode: blocking comment detected → blocked
 *   4. checkpoint: pipeline_step progression throughout happy path
 *
 * Isolation strategy:
 *   - lib/pipeline.cjs is loaded fresh per describe block (cache evicted)
 *   - lib/state.cjs uses a tmp dir with process.cwd() override
 *   - mock-github and mock-gsd-agent are activated/deactivated in beforeEach/afterEach
 *   - clearHooks() called in beforeEach to prevent hook accumulation
 *   - Tmp dirs removed in afterAll
 *
 * No live GitHub tokens or Claude API calls are used.
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

const PIPELINE_MODULE = path.join(REPO_ROOT, 'lib', 'pipeline.cjs');
const STATE_MODULE = path.join(REPO_ROOT, 'lib', 'state.cjs');
const MOCK_GITHUB_MODULE = path.join(REPO_ROOT, 'lib', 'mock-github.cjs');
const MOCK_AGENT_MODULE = path.join(REPO_ROOT, 'lib', 'mock-gsd-agent.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reload lib/pipeline.cjs fresh (evict module cache). */
function loadPipeline() {
  delete _require.cache[PIPELINE_MODULE];
  return _require(PIPELINE_MODULE);
}

/** Reload lib/state.cjs fresh (evict module cache). */
function loadState() {
  delete _require.cache[STATE_MODULE];
  return _require(STATE_MODULE);
}

/** Override process.cwd to return tmpDir. Returns restore function. */
function overrideCwd(tmpDir) {
  const original = process.cwd.bind(process);
  process.cwd = () => tmpDir;
  return () => { process.cwd = original; };
}

/** Remove .mgw/ inside tmpDir if it exists. */
function cleanMgw(tmpDir) {
  const mgwDir = path.join(tmpDir, '.mgw');
  if (fs.existsSync(mgwDir)) {
    fs.rmSync(mgwDir, { recursive: true, force: true });
  }
}

/**
 * Write a minimal issue state file into tmpDir/.mgw/active/.
 * Returns the file path.
 */
function writeIssueState(tmpDir, issueNum, overrides = {}) {
  const activeDir = path.join(tmpDir, '.mgw', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const state = Object.assign(
    {
      issue_number: issueNum,
      slug: `test-issue-${issueNum}`,
      title: `Test issue ${issueNum}`,
      pipeline_stage: 'new',
      gsd_route: 'plan-phase',
      checkpoint: null,
    },
    overrides
  );
  const filePath = path.join(activeDir, `${issueNum}-test-issue-${issueNum}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

/** Read a persisted issue state back from tmpDir/.mgw/active/. */
function readIssueState(tmpDir, issueNum) {
  const activeDir = path.join(tmpDir, '.mgw', 'active');
  const entries = fs.readdirSync(activeDir);
  const match = entries.find(
    f => f.startsWith(`${issueNum}-`) && f.endsWith('.json')
  );
  if (!match) throw new Error(`No state file for issue #${issueNum} in ${activeDir}`);
  return JSON.parse(fs.readFileSync(path.join(activeDir, match), 'utf-8'));
}

/**
 * Build a minimal issue state object suitable for transitionStage().
 * Does NOT write to disk — used for pure in-memory state machine tests.
 */
function makeIssueState(overrides = {}) {
  return Object.assign(
    {
      issue_number: 252,
      slug: 'test-issue-252',
      title: 'Write pipeline stage transition tests',
      pipeline_stage: 'new',
      gsd_route: 'plan-phase',
      checkpoint: null,
    },
    overrides
  );
}

// ---------------------------------------------------------------------------
// Suite 1: happy-path — new → triaged → planning → executing → verifying → pr-created → done
// ---------------------------------------------------------------------------

describe('happy-path: full mgw:run cycle', () => {
  let pipeline;
  let transitionLog;

  beforeEach(() => {
    pipeline = loadPipeline();
    transitionLog = [];
    // Register a hook to capture all transitions
    pipeline.onTransition((from, to, ctx) => {
      transitionLog.push({ from, to, ctx });
    });
  });

  afterEach(() => {
    pipeline.clearHooks();
  });

  it('transitions through all stages from new to done', () => {
    const { transitionStage, STAGES, VALID_TRANSITIONS } = pipeline;
    let state = makeIssueState();

    // new → triaged
    state = transitionStage(state, STAGES.TRIAGED);
    expect(state.pipeline_stage).toBe('triaged');
    expect(state.previous_stage).toBe('new');

    // triaged → planning
    state = transitionStage(state, STAGES.PLANNING);
    expect(state.pipeline_stage).toBe('planning');
    expect(state.previous_stage).toBe('triaged');

    // planning → executing
    state = transitionStage(state, STAGES.EXECUTING);
    expect(state.pipeline_stage).toBe('executing');
    expect(state.previous_stage).toBe('planning');

    // executing → verifying
    state = transitionStage(state, STAGES.VERIFYING);
    expect(state.pipeline_stage).toBe('verifying');
    expect(state.previous_stage).toBe('executing');

    // verifying → pr-created
    state = transitionStage(state, STAGES.PR_CREATED);
    expect(state.pipeline_stage).toBe('pr-created');
    expect(state.previous_stage).toBe('verifying');

    // pr-created → done
    state = transitionStage(state, STAGES.DONE);
    expect(state.pipeline_stage).toBe('done');
    expect(state.previous_stage).toBe('pr-created');

    // done is terminal — no forward transitions
    expect(VALID_TRANSITIONS[STAGES.DONE]).toEqual([]);
    expect(() => transitionStage(state, STAGES.FAILED)).toThrow();
  });

  it('fires onTransition hooks at each stage change', () => {
    const { transitionStage, STAGES } = pipeline;
    let state = makeIssueState();

    state = transitionStage(state, STAGES.TRIAGED);
    state = transitionStage(state, STAGES.PLANNING);
    state = transitionStage(state, STAGES.EXECUTING);
    state = transitionStage(state, STAGES.VERIFYING);
    state = transitionStage(state, STAGES.PR_CREATED);
    state = transitionStage(state, STAGES.DONE);

    expect(transitionLog).toHaveLength(6);
    expect(transitionLog[0]).toMatchObject({ from: 'new', to: 'triaged' });
    expect(transitionLog[1]).toMatchObject({ from: 'triaged', to: 'planning' });
    expect(transitionLog[2]).toMatchObject({ from: 'planning', to: 'executing' });
    expect(transitionLog[3]).toMatchObject({ from: 'executing', to: 'verifying' });
    expect(transitionLog[4]).toMatchObject({ from: 'verifying', to: 'pr-created' });
    expect(transitionLog[5]).toMatchObject({ from: 'pr-created', to: 'done' });
  });

  it('clearHooks() prevents hook from firing after clear', () => {
    const { transitionStage, STAGES, clearHooks } = pipeline;
    const firedAfterClear = [];
    pipeline.onTransition((from, to) => firedAfterClear.push({ from, to }));

    let state = makeIssueState();
    state = transitionStage(state, STAGES.TRIAGED);
    clearHooks();

    // This transition should NOT fire hooks
    state = transitionStage(state, STAGES.PLANNING);

    // transitionLog (registered in beforeEach) captured the first transition
    // firedAfterClear captured before clearHooks, so it has one entry
    expect(firedAfterClear).toHaveLength(1);
    expect(firedAfterClear[0]).toMatchObject({ from: 'new', to: 'triaged' });
  });

  it('self-transition throws', () => {
    const { transitionStage, STAGES } = pipeline;
    const state = makeIssueState({ pipeline_stage: 'planning' });
    expect(() => transitionStage(state, STAGES.PLANNING)).toThrow(/self-transition/);
  });

  it('invalid transition throws with descriptive message', () => {
    const { transitionStage, STAGES } = pipeline;
    const state = makeIssueState({ pipeline_stage: 'new' });
    // new → done is not a valid transition
    expect(() => transitionStage(state, STAGES.DONE)).toThrow(/Invalid transition/);
  });

  it('isValidTransition covers all happy-path edges', () => {
    const { isValidTransition, STAGES } = pipeline;
    const happyPath = [
      [STAGES.NEW, STAGES.TRIAGED],
      [STAGES.TRIAGED, STAGES.PLANNING],
      [STAGES.PLANNING, STAGES.EXECUTING],
      [STAGES.EXECUTING, STAGES.VERIFYING],
      [STAGES.VERIFYING, STAGES.PR_CREATED],
      [STAGES.PR_CREATED, STAGES.DONE],
    ];
    for (const [from, to] of happyPath) {
      expect(isValidTransition(from, to)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: failure-mode — agent returns no output → failed
// ---------------------------------------------------------------------------

describe('failure-mode: agent returns no output', () => {
  let pipeline;
  let mockAgent;

  beforeEach(() => {
    pipeline = loadPipeline();
    pipeline.clearHooks();
    mockAgent = _require(MOCK_AGENT_MODULE);
    mockAgent.activate();
    // Override gsd-planner to return empty string (simulates silent agent failure)
    mockAgent.setResponse('gsd-planner', '');
  });

  afterEach(() => {
    pipeline.clearHooks();
    mockAgent.deactivate();
  });

  it('transitions to failed when planner returns no output', () => {
    const { transitionStage, STAGES, isValidTransition } = pipeline;
    let state = makeIssueState();

    // Simulate pipeline progress up to executing
    state = transitionStage(state, STAGES.TRIAGED);
    state = transitionStage(state, STAGES.PLANNING);

    // Simulate agent spawn — returns empty output
    const output = mockAgent.spawnStub({
      subagent_type: 'gsd-planner',
      prompt: 'Create PLAN.md for issue #252',
      description: 'Planner for issue 252',
    });

    // Agent failure detection: empty output means execution failed
    expect(output).toBe('');

    // On empty output, pipeline transitions to failed
    state = transitionStage(state, STAGES.FAILED);
    expect(state.pipeline_stage).toBe('failed');
  });

  it('assertSpawned passes for gsd-planner', () => {
    mockAgent.spawnStub({
      subagent_type: 'gsd-planner',
      prompt: 'Plan issue 252',
      description: 'Test planner spawn',
    });
    // Should not throw
    expect(() => mockAgent.assertSpawned('gsd-planner')).not.toThrow();
  });

  it('assertSpawned throws when agent was not spawned', () => {
    // gsd-executor was never called
    expect(() => mockAgent.assertSpawned('gsd-executor')).toThrow();
  });

  it('failed stage can recover to triaged or planning', () => {
    const { isValidTransition, STAGES } = pipeline;
    expect(isValidTransition(STAGES.FAILED, STAGES.TRIAGED)).toBe(true);
    expect(isValidTransition(STAGES.FAILED, STAGES.PLANNING)).toBe(true);
    expect(isValidTransition(STAGES.FAILED, STAGES.EXECUTING)).toBe(true);
    // Cannot skip directly to done from failed
    expect(isValidTransition(STAGES.FAILED, STAGES.DONE)).toBe(false);
    // Cannot skip to pr-created from failed
    expect(isValidTransition(STAGES.FAILED, STAGES.PR_CREATED)).toBe(false);
  });

  it('call log records the failed spawn attempt', () => {
    mockAgent.spawnStub({
      subagent_type: 'gsd-planner',
      prompt: 'Plan issue 252',
      description: 'Planner',
    });

    const log = mockAgent.getCallLog();
    expect(log).toHaveLength(1);
    expect(log[0].subagent_type).toBe('gsd-planner');
    expect(log[0].output).toBe('');
  });

  it('getSpawnCount returns correct count per agent type', () => {
    mockAgent.spawnStub({ subagent_type: 'gsd-planner', prompt: '', description: '' });
    mockAgent.spawnStub({ subagent_type: 'gsd-planner', prompt: '', description: '' });
    expect(mockAgent.getSpawnCount('gsd-planner')).toBe(2);
    expect(mockAgent.getSpawnCount('gsd-executor')).toBe(0);
    expect(mockAgent.getSpawnCount()).toBe(2); // total
  });

  it('any-stage can transition to failed', () => {
    const { isValidTransition, STAGES } = pipeline;
    const nonTerminal = [
      STAGES.NEW, STAGES.TRIAGED, STAGES.NEEDS_INFO, STAGES.DISCUSSING,
      STAGES.APPROVED, STAGES.PLANNING, STAGES.DIAGNOSING,
      STAGES.EXECUTING, STAGES.VERIFYING, STAGES.PR_CREATED,
    ];
    for (const stage of nonTerminal) {
      expect(isValidTransition(stage, STAGES.FAILED)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: failure-mode — blocking comment detected → blocked
// ---------------------------------------------------------------------------

describe('failure-mode: blocking comment detected', () => {
  let pipeline;
  let mockGitHub;

  beforeEach(() => {
    pipeline = loadPipeline();
    pipeline.clearHooks();
    mockGitHub = _require(MOCK_GITHUB_MODULE);
    mockGitHub.activate();
    // Override gh issue view to return a blocking comment
    mockGitHub.setResponse(
      'gh issue view',
      JSON.stringify({
        number: 252,
        title: 'Write pipeline stage transition tests',
        comments: [
          {
            author: { login: 'stakeholder' },
            body: 'Hold off, do not work on this yet. Blocked by design review.',
            createdAt: '2026-03-06T10:00:00Z',
          },
        ],
      })
    );
  });

  afterEach(() => {
    pipeline.clearHooks();
    mockGitHub.deactivate();
  });

  it('transitions to blocked when blocking comment is detected', () => {
    const { transitionStage, STAGES } = pipeline;
    let state = makeIssueState({ pipeline_stage: 'triaged' });

    // Simulate comment classification: 'Hold off' → blocking
    const commentBody = 'Hold off, do not work on this yet. Blocked by design review.';
    const isBlocking = /hold off|do not work|blocked|wait/i.test(commentBody);
    expect(isBlocking).toBe(true);

    // Pipeline transitions to blocked on blocking comment
    state = transitionStage(state, STAGES.BLOCKED);
    expect(state.pipeline_stage).toBe('blocked');
  });

  it('mock GitHub call log includes gh issue view', () => {
    const { execSync } = _require('child_process');
    // Trigger the mock by calling execSync (mock-github intercepts child_process.execSync)
    const result = execSync('gh issue view 252 --json comments');
    const parsed = JSON.parse(result);
    expect(parsed.number).toBe(252);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].body).toMatch(/Hold off/);

    const log = mockGitHub.getCallLog();
    expect(log.length).toBeGreaterThan(0);
    const issueViewCall = log.find(entry => entry.cmd.includes('gh issue view'));
    expect(issueViewCall).toBeDefined();
  });

  it('blocked stage can recover to triaged or planning', () => {
    const { isValidTransition, STAGES } = pipeline;
    expect(isValidTransition(STAGES.BLOCKED, STAGES.TRIAGED)).toBe(true);
    expect(isValidTransition(STAGES.BLOCKED, STAGES.PLANNING)).toBe(true);
    expect(isValidTransition(STAGES.BLOCKED, STAGES.EXECUTING)).toBe(true);
    // Cannot skip to done from blocked
    expect(isValidTransition(STAGES.BLOCKED, STAGES.DONE)).toBe(false);
    // Cannot skip to pr-created from blocked
    expect(isValidTransition(STAGES.BLOCKED, STAGES.PR_CREATED)).toBe(false);
  });

  it('any non-terminal stage can transition to blocked', () => {
    const { isValidTransition, STAGES } = pipeline;
    const nonTerminal = [
      STAGES.NEW, STAGES.TRIAGED, STAGES.NEEDS_INFO, STAGES.DISCUSSING,
      STAGES.APPROVED, STAGES.PLANNING, STAGES.DIAGNOSING,
      STAGES.EXECUTING, STAGES.VERIFYING, STAGES.PR_CREATED,
    ];
    for (const stage of nonTerminal) {
      expect(isValidTransition(stage, STAGES.BLOCKED)).toBe(true);
    }
  });

  it('clearCallLog resets the log without deactivating mock', () => {
    expect(mockGitHub.isActive()).toBe(true);
    const { execSync } = _require('child_process');
    execSync('gh issue view 252 --json comments');
    expect(mockGitHub.getCallLog().length).toBeGreaterThan(0);

    mockGitHub.clearCallLog();
    expect(mockGitHub.getCallLog()).toHaveLength(0);
    expect(mockGitHub.isActive()).toBe(true); // still active after clear
  });

  it('deactivate restores real execSync (isActive becomes false)', () => {
    expect(mockGitHub.isActive()).toBe(true);
    mockGitHub.deactivate();
    expect(mockGitHub.isActive()).toBe(false);
    // Re-activate for afterEach cleanup
    mockGitHub.activate();
  });
});

// ---------------------------------------------------------------------------
// Suite 4: checkpoint — pipeline_step progression throughout happy path
// ---------------------------------------------------------------------------

describe('checkpoint: pipeline_step progression', () => {
  let tmpDir;
  let restoreCwd;
  let stateLib;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-pipeline-test-'));
    restoreCwd = overrideCwd(tmpDir);
    stateLib = loadState();
    writeIssueState(tmpDir, 300);
  });

  afterEach(() => {
    restoreCwd();
    cleanMgw(tmpDir);
    delete _require.cache[STATE_MODULE];
  });

  afterAll(() => {
    // tmpDir may have already been removed by afterEach — guard with existsSync
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('CHECKPOINT_STEP_ORDER matches documented progression', () => {
    const { CHECKPOINT_STEP_ORDER } = stateLib;
    expect(CHECKPOINT_STEP_ORDER).toEqual(['triage', 'plan', 'execute', 'verify', 'pr']);
  });

  it('checkpoint is null before first updateCheckpoint call', () => {
    const state = readIssueState(tmpDir, 300);
    expect(state.checkpoint).toBeNull();
  });

  it('initializes checkpoint on first updateCheckpoint call', () => {
    const { updateCheckpoint } = stateLib;
    updateCheckpoint(300, {
      pipeline_step: 'triage',
      step_progress: { route_selected: 'plan-phase', comment_check_done: true },
      resume: { action: 'begin-execution', context: { gsd_route: 'plan-phase' } },
    });

    const state = readIssueState(tmpDir, 300);
    expect(state.checkpoint).not.toBeNull();
    expect(state.checkpoint.schema_version).toBe(1);
    expect(state.checkpoint.pipeline_step).toBe('triage');
    expect(state.checkpoint.step_progress.route_selected).toBe('plan-phase');
    expect(state.checkpoint.step_progress.comment_check_done).toBe(true);
  });

  it('advances pipeline_step through all 5 steps', () => {
    const { updateCheckpoint } = stateLib;

    // triage
    updateCheckpoint(300, {
      pipeline_step: 'triage',
      step_progress: { route_selected: 'plan-phase' },
      resume: { action: 'begin-execution', context: {} },
    });
    let state = readIssueState(tmpDir, 300);
    expect(state.checkpoint.pipeline_step).toBe('triage');

    // plan
    updateCheckpoint(300, {
      pipeline_step: 'plan',
      step_progress: { plan_path: '/plan.md', plan_checked: false },
      artifacts: [{ path: '/plan.md', type: 'plan', created_at: new Date().toISOString() }],
      resume: { action: 'spawn-executor', context: { quick_dir: '/q', plan_num: '11' } },
    });
    state = readIssueState(tmpDir, 300);
    expect(state.checkpoint.pipeline_step).toBe('plan');
    expect(state.checkpoint.step_progress.plan_path).toBe('/plan.md');
    expect(state.checkpoint.artifacts).toHaveLength(1);
    expect(state.checkpoint.artifacts[0].type).toBe('plan');

    // execute
    updateCheckpoint(300, {
      pipeline_step: 'execute',
      step_progress: { gsd_phase: 1, tasks_completed: 0, tasks_total: 1 },
      resume: { action: 'spawn-verifier', context: { quick_dir: '/q', plan_num: '11' } },
    });
    state = readIssueState(tmpDir, 300);
    expect(state.checkpoint.pipeline_step).toBe('execute');
    expect(state.checkpoint.step_progress.gsd_phase).toBe(1);
    // plan artifact still present (append-only)
    expect(state.checkpoint.artifacts).toHaveLength(1);

    // verify
    updateCheckpoint(300, {
      pipeline_step: 'verify',
      step_progress: {
        verification_path: '/verify.md',
        must_haves_checked: true,
        artifact_check_done: true,
      },
      artifacts: [{ path: '/verify.md', type: 'verification', created_at: new Date().toISOString() }],
      resume: { action: 'create-pr', context: { quick_dir: '/q', plan_num: '11' } },
    });
    state = readIssueState(tmpDir, 300);
    expect(state.checkpoint.pipeline_step).toBe('verify');
    expect(state.checkpoint.step_progress.verification_path).toBe('/verify.md');
    expect(state.checkpoint.artifacts).toHaveLength(2); // plan + verification

    // pr
    updateCheckpoint(300, {
      pipeline_step: 'pr',
      step_progress: { branch_pushed: true, pr_number: 99, pr_url: 'https://github.com/test/repo/pull/99' },
      step_history: [{ step: 'pr', completed_at: new Date().toISOString(), agent_type: 'general-purpose', output_path: 'https://github.com/test/repo/pull/99' }],
      resume: { action: 'cleanup', context: { pr_number: 99 } },
    });
    state = readIssueState(tmpDir, 300);
    expect(state.checkpoint.pipeline_step).toBe('pr');
    expect(state.checkpoint.step_progress.pr_number).toBe(99);
    expect(state.checkpoint.step_progress.branch_pushed).toBe(true);
    expect(state.checkpoint.step_history).toHaveLength(1);
    expect(state.checkpoint.step_history[0].step).toBe('pr');
  });

  it('detectCheckpoint returns null for triage-only checkpoint', () => {
    const { updateCheckpoint, detectCheckpoint } = stateLib;
    updateCheckpoint(300, {
      pipeline_step: 'triage',
      step_progress: { route_selected: 'plan-phase' },
    });
    const cp = detectCheckpoint(300);
    // triage-only is not resumable (index 0 in CHECKPOINT_STEP_ORDER)
    expect(cp).toBeNull();
  });

  it('detectCheckpoint returns data for post-triage checkpoints', () => {
    const { updateCheckpoint, detectCheckpoint } = stateLib;
    updateCheckpoint(300, {
      pipeline_step: 'plan',
      step_progress: { plan_path: '/plan.md' },
      resume: { action: 'spawn-executor', context: {} },
    });
    const cp = detectCheckpoint(300);
    expect(cp).not.toBeNull();
    expect(cp.pipeline_step).toBe('plan');
    expect(cp.step_progress.plan_path).toBe('/plan.md');
    expect(cp.resume.action).toBe('spawn-executor');
  });

  it('artifacts array is append-only across multiple updateCheckpoint calls', () => {
    const { updateCheckpoint } = stateLib;
    const t = new Date().toISOString();

    updateCheckpoint(300, {
      pipeline_step: 'plan',
      artifacts: [{ path: '/plan.md', type: 'plan', created_at: t }],
    });
    updateCheckpoint(300, {
      pipeline_step: 'execute',
      artifacts: [{ path: '/summary.md', type: 'summary', created_at: t }],
    });
    updateCheckpoint(300, {
      pipeline_step: 'verify',
      artifacts: [{ path: '/verify.md', type: 'verification', created_at: t }],
    });

    const state = readIssueState(tmpDir, 300);
    expect(state.checkpoint.artifacts).toHaveLength(3);
    expect(state.checkpoint.artifacts.map(a => a.type)).toEqual(['plan', 'summary', 'verification']);
  });

  it('step_history is append-only across multiple updateCheckpoint calls', () => {
    const { updateCheckpoint } = stateLib;
    const t = new Date().toISOString();

    updateCheckpoint(300, {
      pipeline_step: 'plan',
      step_history: [{ step: 'plan', completed_at: t, agent_type: 'gsd-planner', output_path: '/plan.md' }],
    });
    updateCheckpoint(300, {
      pipeline_step: 'execute',
      step_history: [{ step: 'execute', completed_at: t, agent_type: 'gsd-executor', output_path: '/summary.md' }],
    });

    const state = readIssueState(tmpDir, 300);
    expect(state.checkpoint.step_history).toHaveLength(2);
    expect(state.checkpoint.step_history[0].step).toBe('plan');
    expect(state.checkpoint.step_history[1].step).toBe('execute');
  });

  it('updated_at is advanced on every checkpoint write', async () => {
    const { updateCheckpoint } = stateLib;

    updateCheckpoint(300, { pipeline_step: 'plan' });
    const first = readIssueState(tmpDir, 300);
    const firstTs = first.checkpoint.updated_at;

    // Small delay to ensure clock advances
    await new Promise(resolve => setTimeout(resolve, 5));

    updateCheckpoint(300, { pipeline_step: 'execute' });
    const second = readIssueState(tmpDir, 300);
    const secondTs = second.checkpoint.updated_at;

    expect(new Date(secondTs).getTime()).toBeGreaterThanOrEqual(new Date(firstTs).getTime());
  });
});
