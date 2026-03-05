'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  STAGES, VALID_TRANSITIONS, STAGE_ICONS, STAGE_LABELS,
  isValidStage, isValidTransition, transitionStage, onTransition, clearHooks,
} = require('../lib/pipeline.cjs');

// ---------------------------------------------------------------------------
// STAGES
// ---------------------------------------------------------------------------

describe('STAGES', () => {
  it('has exactly 14 stages', () => {
    assert.equal(Object.keys(STAGES).length, 14);
  });

  it('contains all expected stage values', () => {
    const expected = [
      'new', 'triaged', 'needs-info', 'needs-security-review', 'discussing',
      'approved', 'planning', 'diagnosing', 'executing', 'verifying',
      'pr-created', 'done', 'failed', 'blocked'
    ];
    const values = Object.values(STAGES);
    for (const s of expected) {
      assert.ok(values.includes(s), `missing stage: ${s}`);
    }
  });

  it('all values are lowercase kebab-case strings', () => {
    for (const v of Object.values(STAGES)) {
      assert.equal(typeof v, 'string');
      assert.match(v, /^[a-z][a-z0-9-]*$/);
    }
  });
});

// ---------------------------------------------------------------------------
// VALID_TRANSITIONS
// ---------------------------------------------------------------------------

describe('VALID_TRANSITIONS', () => {
  it('has an entry for every stage', () => {
    for (const stage of Object.values(STAGES)) {
      assert.ok(stage in VALID_TRANSITIONS, `missing transitions for: ${stage}`);
    }
  });

  it('new can only transition to triaged', () => {
    const allowed = VALID_TRANSITIONS[STAGES.NEW].filter(s => s !== 'failed' && s !== 'blocked');
    assert.deepEqual(allowed, [STAGES.TRIAGED]);
  });

  it('done has no forward transitions (terminal state)', () => {
    assert.deepEqual(VALID_TRANSITIONS[STAGES.DONE], []);
  });

  it('every non-terminal stage can transition to failed and blocked', () => {
    const terminals = [STAGES.DONE, STAGES.FAILED, STAGES.BLOCKED];
    for (const [stage, targets] of Object.entries(VALID_TRANSITIONS)) {
      if (terminals.includes(stage)) continue;
      assert.ok(targets.includes(STAGES.FAILED), `${stage} should allow transition to failed`);
      assert.ok(targets.includes(STAGES.BLOCKED), `${stage} should allow transition to blocked`);
    }
  });

  it('failed can recover to new, triaged, planning, or executing', () => {
    const targets = VALID_TRANSITIONS[STAGES.FAILED];
    assert.ok(targets.includes(STAGES.NEW));
    assert.ok(targets.includes(STAGES.TRIAGED));
    assert.ok(targets.includes(STAGES.PLANNING));
    assert.ok(targets.includes(STAGES.EXECUTING));
  });

  it('planning transitions to executing', () => {
    const targets = VALID_TRANSITIONS[STAGES.PLANNING].filter(s => s !== 'failed' && s !== 'blocked');
    assert.deepEqual(targets, [STAGES.EXECUTING]);
  });

  it('executing transitions to verifying', () => {
    const targets = VALID_TRANSITIONS[STAGES.EXECUTING].filter(s => s !== 'failed' && s !== 'blocked');
    assert.deepEqual(targets, [STAGES.VERIFYING]);
  });

  it('verifying can go to pr-created or back to executing', () => {
    const targets = VALID_TRANSITIONS[STAGES.VERIFYING].filter(s => s !== 'failed' && s !== 'blocked');
    assert.ok(targets.includes(STAGES.PR_CREATED));
    assert.ok(targets.includes(STAGES.EXECUTING));
  });

  it('pr-created transitions to done', () => {
    const targets = VALID_TRANSITIONS[STAGES.PR_CREATED].filter(s => s !== 'failed' && s !== 'blocked');
    assert.deepEqual(targets, [STAGES.DONE]);
  });
});

// ---------------------------------------------------------------------------
// STAGE_ICONS & STAGE_LABELS
// ---------------------------------------------------------------------------

describe('STAGE_ICONS', () => {
  it('has an icon for every stage', () => {
    for (const stage of Object.values(STAGES)) {
      assert.ok(stage in STAGE_ICONS, `missing icon for: ${stage}`);
    }
  });
});

describe('STAGE_LABELS', () => {
  it('has a label for every stage', () => {
    for (const stage of Object.values(STAGES)) {
      assert.ok(stage in STAGE_LABELS, `missing label for: ${stage}`);
    }
  });

  it('all labels are non-empty strings', () => {
    for (const label of Object.values(STAGE_LABELS)) {
      assert.equal(typeof label, 'string');
      assert.ok(label.length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// isValidStage
// ---------------------------------------------------------------------------

describe('isValidStage', () => {
  it('returns true for all defined stages', () => {
    for (const stage of Object.values(STAGES)) {
      assert.equal(isValidStage(stage), true, `${stage} should be valid`);
    }
  });

  it('returns false for unknown strings', () => {
    assert.equal(isValidStage('invalid'), false);
    assert.equal(isValidStage(''), false);
    assert.equal(isValidStage('DONE'), false);
  });

  it('returns false for non-string values', () => {
    assert.equal(isValidStage(null), false);
    assert.equal(isValidStage(undefined), false);
    assert.equal(isValidStage(42), false);
  });
});

// ---------------------------------------------------------------------------
// isValidTransition
// ---------------------------------------------------------------------------

describe('isValidTransition', () => {
  it('returns true for valid transitions', () => {
    assert.equal(isValidTransition('new', 'triaged'), true);
    assert.equal(isValidTransition('planning', 'executing'), true);
    assert.equal(isValidTransition('pr-created', 'done'), true);
  });

  it('returns false for invalid transitions', () => {
    assert.equal(isValidTransition('new', 'done'), false);
    assert.equal(isValidTransition('done', 'new'), false);
    assert.equal(isValidTransition('planning', 'triaged'), false);
  });

  it('returns true for transition to failed from any non-terminal stage', () => {
    assert.equal(isValidTransition('new', 'failed'), true);
    assert.equal(isValidTransition('executing', 'failed'), true);
    assert.equal(isValidTransition('verifying', 'failed'), true);
  });

  it('returns false when from stage is invalid', () => {
    assert.equal(isValidTransition('garbage', 'triaged'), false);
  });

  it('returns false when to stage is invalid', () => {
    assert.equal(isValidTransition('new', 'garbage'), false);
  });

  it('returns false for self-transitions', () => {
    assert.equal(isValidTransition('new', 'new'), false);
    assert.equal(isValidTransition('done', 'done'), false);
  });
});

// ---------------------------------------------------------------------------
// transitionStage
// ---------------------------------------------------------------------------

describe('transitionStage', () => {
  afterEach(() => clearHooks());

  it('returns new state with updated pipeline_stage', () => {
    const state = { pipeline_stage: 'new', number: 42 };
    const result = transitionStage(state, 'triaged');
    assert.equal(result.pipeline_stage, 'triaged');
    assert.equal(result.number, 42);
    assert.equal(result.previous_stage, 'new');
    assert.ok(result.last_transition);
  });

  it('is immutable — does not modify input', () => {
    const state = { pipeline_stage: 'new' };
    const result = transitionStage(state, 'triaged');
    assert.notEqual(result, state);
    assert.equal(state.pipeline_stage, 'new');
  });

  it('throws on invalid target stage', () => {
    const state = { pipeline_stage: 'new' };
    assert.throws(() => transitionStage(state, 'garbage'), /Invalid target stage/);
  });

  it('throws on self-transition', () => {
    const state = { pipeline_stage: 'new' };
    assert.throws(() => transitionStage(state, 'new'), /self-transitions/);
  });

  it('throws on invalid transition', () => {
    const state = { pipeline_stage: 'new' };
    assert.throws(() => transitionStage(state, 'done'), /Invalid transition/);
  });

  it('defaults to "new" when pipeline_stage is missing', () => {
    const result = transitionStage({}, 'triaged');
    assert.equal(result.pipeline_stage, 'triaged');
    assert.equal(result.previous_stage, 'new');
  });

  it('fires registered hooks on transition', () => {
    const calls = [];
    onTransition((from, to, ctx) => calls.push({ from, to, ctx }));

    transitionStage({ pipeline_stage: 'planning' }, 'executing', { issueNumber: 5 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].from, 'planning');
    assert.equal(calls[0].to, 'executing');
    assert.equal(calls[0].ctx.issueNumber, 5);
  });

  it('hook errors do not prevent transition', () => {
    onTransition(() => { throw new Error('hook fail'); });

    const result = transitionStage({ pipeline_stage: 'new' }, 'triaged');
    assert.equal(result.pipeline_stage, 'triaged');
  });

  it('unsubscribe removes hook', () => {
    const calls = [];
    const unsub = onTransition(() => calls.push(1));

    transitionStage({ pipeline_stage: 'new' }, 'triaged');
    assert.equal(calls.length, 1);

    unsub();
    transitionStage({ pipeline_stage: 'triaged' }, 'planning');
    assert.equal(calls.length, 1);
  });
});
