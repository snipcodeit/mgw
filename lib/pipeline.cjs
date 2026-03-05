'use strict';

/**
 * lib/pipeline.cjs — Pipeline stage constants and transition validation
 *
 * Single source of truth for all MGW pipeline stages, valid transitions,
 * and stage display metadata. Replaces scattered string literals across
 * commands and lib modules.
 */

/**
 * All valid pipeline stages.
 * @enum {string}
 */
const STAGES = {
  NEW:                    'new',
  TRIAGED:                'triaged',
  NEEDS_INFO:             'needs-info',
  NEEDS_SECURITY_REVIEW:  'needs-security-review',
  DISCUSSING:             'discussing',
  APPROVED:               'approved',
  PLANNING:               'planning',
  DIAGNOSING:             'diagnosing',
  EXECUTING:              'executing',
  VERIFYING:              'verifying',
  PR_CREATED:             'pr-created',
  DONE:                   'done',
  FAILED:                 'failed',
  BLOCKED:                'blocked',
};

/** Set of all valid stage values for O(1) lookup */
const STAGE_SET = new Set(Object.values(STAGES));

/**
 * Valid stage transitions. Each key maps to the set of stages it can transition TO.
 * Transitions not listed here are invalid.
 */
const VALID_TRANSITIONS = {
  [STAGES.NEW]:                   [STAGES.TRIAGED],
  [STAGES.TRIAGED]:               [STAGES.NEEDS_INFO, STAGES.NEEDS_SECURITY_REVIEW, STAGES.DISCUSSING, STAGES.APPROVED, STAGES.PLANNING, STAGES.DIAGNOSING],
  [STAGES.NEEDS_INFO]:            [STAGES.TRIAGED],
  [STAGES.NEEDS_SECURITY_REVIEW]: [STAGES.TRIAGED, STAGES.APPROVED],
  [STAGES.DISCUSSING]:            [STAGES.TRIAGED, STAGES.APPROVED],
  [STAGES.APPROVED]:              [STAGES.PLANNING],
  [STAGES.PLANNING]:              [STAGES.EXECUTING],
  [STAGES.DIAGNOSING]:            [STAGES.PLANNING],
  [STAGES.EXECUTING]:             [STAGES.VERIFYING],
  [STAGES.VERIFYING]:             [STAGES.PR_CREATED, STAGES.EXECUTING],
  [STAGES.PR_CREATED]:            [STAGES.DONE],
  [STAGES.DONE]:                  [],
  [STAGES.FAILED]:                [STAGES.NEW, STAGES.TRIAGED, STAGES.PLANNING, STAGES.EXECUTING],
  [STAGES.BLOCKED]:               [STAGES.NEW, STAGES.TRIAGED, STAGES.PLANNING, STAGES.EXECUTING],
};

// Any stage can transition to FAILED or BLOCKED
for (const stage of Object.keys(VALID_TRANSITIONS)) {
  if (stage !== STAGES.DONE && stage !== STAGES.FAILED && stage !== STAGES.BLOCKED) {
    VALID_TRANSITIONS[stage].push(STAGES.FAILED, STAGES.BLOCKED);
  }
}

/**
 * Stage display icons — maps stage to Unicode icon character.
 */
const STAGE_ICONS = {
  [STAGES.NEW]:                   '○',
  [STAGES.TRIAGED]:               '◇',
  [STAGES.NEEDS_INFO]:            '?',
  [STAGES.NEEDS_SECURITY_REVIEW]: '⚑',
  [STAGES.DISCUSSING]:            '💬',
  [STAGES.APPROVED]:              '✔',
  [STAGES.PLANNING]:              '◆',
  [STAGES.DIAGNOSING]:            '🔍',
  [STAGES.EXECUTING]:             '◆',
  [STAGES.VERIFYING]:             '◆',
  [STAGES.PR_CREATED]:            '✓',
  [STAGES.DONE]:                  '✓',
  [STAGES.FAILED]:                '✗',
  [STAGES.BLOCKED]:               '⊘',
};

/**
 * Stage label map — human-readable names for display.
 */
const STAGE_LABELS = {
  [STAGES.NEW]:                   'New',
  [STAGES.TRIAGED]:               'Triaged',
  [STAGES.NEEDS_INFO]:            'Needs Info',
  [STAGES.NEEDS_SECURITY_REVIEW]: 'Needs Security Review',
  [STAGES.DISCUSSING]:            'Discussing',
  [STAGES.APPROVED]:              'Approved',
  [STAGES.PLANNING]:              'Planning',
  [STAGES.DIAGNOSING]:            'Diagnosing',
  [STAGES.EXECUTING]:             'Executing',
  [STAGES.VERIFYING]:             'Verifying',
  [STAGES.PR_CREATED]:            'PR Created',
  [STAGES.DONE]:                  'Done',
  [STAGES.FAILED]:                'Failed',
  [STAGES.BLOCKED]:               'Blocked',
};

/**
 * Check whether a string is a valid pipeline stage.
 * @param {string} stage
 * @returns {boolean}
 */
function isValidStage(stage) {
  return STAGE_SET.has(stage);
}

/**
 * Check whether transitioning from one stage to another is valid.
 * @param {string} from - Current stage
 * @param {string} to - Target stage
 * @returns {boolean}
 */
function isValidTransition(from, to) {
  if (!isValidStage(from) || !isValidStage(to)) return false;
  const allowed = VALID_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Transition hooks
// ---------------------------------------------------------------------------

/** @type {Array<(from: string, to: string, context: object) => void>} */
const _hooks = [];

/**
 * Register a callback that fires on every successful stage transition.
 *
 * @param {(from: string, to: string, context: object) => void} fn
 * @returns {() => void} Unsubscribe function
 */
function onTransition(fn) {
  _hooks.push(fn);
  return () => {
    const idx = _hooks.indexOf(fn);
    if (idx !== -1) _hooks.splice(idx, 1);
  };
}

/**
 * Transition an issue state to a new pipeline stage.
 *
 * Validates the transition is allowed, updates the state object immutably,
 * and fires all registered hooks.
 *
 * @param {object} issueState - Issue state object (from .mgw/active/*.json)
 * @param {string} newStage - Target pipeline stage
 * @param {object} [context] - Optional context passed to hooks (e.g. { issueNumber })
 * @returns {object} New state object with updated pipeline_stage
 * @throws {Error} If the transition is invalid
 */
function transitionStage(issueState, newStage, context) {
  const currentStage = (issueState && issueState.pipeline_stage) || STAGES.NEW;

  if (!isValidStage(newStage)) {
    throw new Error(`Invalid target stage: "${newStage}"`);
  }

  if (currentStage === newStage) {
    throw new Error(`Already at stage "${newStage}" — self-transitions are not allowed`);
  }

  if (!isValidTransition(currentStage, newStage)) {
    throw new Error(
      `Invalid transition: "${currentStage}" → "${newStage}". ` +
      `Allowed targets: [${(VALID_TRANSITIONS[currentStage] || []).join(', ')}]`
    );
  }

  const newState = Object.assign({}, issueState, {
    pipeline_stage: newStage,
    last_transition: new Date().toISOString(),
    previous_stage: currentStage,
  });

  // Fire hooks (non-blocking, errors are caught and logged to stderr)
  const ctx = context || {};
  for (const hook of _hooks) {
    try {
      hook(currentStage, newStage, ctx);
    } catch (err) {
      process.stderr.write(`[pipeline] hook error: ${err.message}\n`);
    }
  }

  return newState;
}

/**
 * Clear all registered transition hooks. Used for testing.
 */
function clearHooks() {
  _hooks.length = 0;
}

module.exports = {
  STAGES,
  VALID_TRANSITIONS,
  STAGE_ICONS,
  STAGE_LABELS,
  isValidStage,
  isValidTransition,
  transitionStage,
  onTransition,
  clearHooks,
};
