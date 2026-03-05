'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyFailure,
  canRetry,
  incrementRetry,
  resetRetryState,
  getBackoffMs,
  withRetry,
  MAX_RETRIES,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
} = require('../lib/retry.cjs');

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

describe('classifyFailure', () => {
  it('returns permanent for null/undefined error', () => {
    assert.equal(classifyFailure(null).class, 'permanent');
    assert.equal(classifyFailure(undefined).class, 'permanent');
  });

  it('returns permanent for non-object error', () => {
    assert.equal(classifyFailure('string error').class, 'permanent');
    assert.equal(classifyFailure(42).class, 'permanent');
  });

  // HTTP status code classification
  it('classifies HTTP 429 as transient', () => {
    const r = classifyFailure({ status: 429 });
    assert.equal(r.class, 'transient');
    assert.match(r.reason, /429/);
  });

  it('classifies HTTP 500 as transient', () => {
    assert.equal(classifyFailure({ status: 500 }).class, 'transient');
  });

  it('classifies HTTP 502 as transient', () => {
    assert.equal(classifyFailure({ status: 502 }).class, 'transient');
  });

  it('classifies HTTP 503 as transient', () => {
    assert.equal(classifyFailure({ status: 503 }).class, 'transient');
  });

  it('classifies HTTP 504 as transient', () => {
    assert.equal(classifyFailure({ status: 504 }).class, 'transient');
  });

  it('classifies HTTP 403 as permanent', () => {
    assert.equal(classifyFailure({ status: 403 }).class, 'permanent');
  });

  it('classifies HTTP 400 as permanent', () => {
    assert.equal(classifyFailure({ status: 400 }).class, 'permanent');
  });

  it('classifies HTTP 401 as permanent', () => {
    assert.equal(classifyFailure({ status: 401 }).class, 'permanent');
  });

  it('classifies HTTP 404 as permanent', () => {
    assert.equal(classifyFailure({ status: 404 }).class, 'permanent');
  });

  it('classifies HTTP 422 as permanent', () => {
    assert.equal(classifyFailure({ status: 422 }).class, 'permanent');
  });

  // Node.js error code classification
  it('classifies ECONNRESET as transient', () => {
    assert.equal(classifyFailure({ code: 'ECONNRESET' }).class, 'transient');
  });

  it('classifies ETIMEDOUT as transient', () => {
    assert.equal(classifyFailure({ code: 'ETIMEDOUT' }).class, 'transient');
  });

  it('classifies ECONNREFUSED as transient', () => {
    assert.equal(classifyFailure({ code: 'ECONNREFUSED' }).class, 'transient');
  });

  it('classifies ENOENT as permanent', () => {
    assert.equal(classifyFailure({ code: 'ENOENT' }).class, 'permanent');
  });

  // Message pattern classification
  it('classifies "rate limit" message as transient', () => {
    assert.equal(classifyFailure({ message: 'API rate limit exceeded' }).class, 'transient');
  });

  it('classifies "service unavailable" message as transient', () => {
    assert.equal(classifyFailure({ message: 'Service Unavailable' }).class, 'transient');
  });

  it('classifies "bad gateway" message as transient', () => {
    assert.equal(classifyFailure({ message: 'Bad Gateway' }).class, 'transient');
  });

  it('classifies "model overload" message as transient', () => {
    assert.equal(classifyFailure({ message: 'model overload, try again later' }).class, 'transient');
  });

  it('classifies "ambiguous" message as needs-info', () => {
    assert.equal(classifyFailure({ message: 'ambiguous requirements' }).class, 'needs-info');
  });

  it('classifies "missing required field" as needs-info', () => {
    assert.equal(classifyFailure({ message: 'missing required field: body' }).class, 'needs-info');
  });

  it('classifies unknown error as permanent', () => {
    const r = classifyFailure({ message: 'something unexpected' });
    assert.equal(r.class, 'permanent');
    assert.match(r.reason, /unknown/);
  });

  // Priority: HTTP status code > message pattern
  it('HTTP status takes priority over message pattern', () => {
    // Status 429 (transient) with permanent-sounding message
    assert.equal(classifyFailure({ status: 429, message: 'permanent error' }).class, 'transient');
    // Status 404 (permanent) with transient-sounding message
    assert.equal(classifyFailure({ status: 404, message: 'rate limit' }).class, 'permanent');
  });
});

// ---------------------------------------------------------------------------
// canRetry
// ---------------------------------------------------------------------------

describe('canRetry', () => {
  it('returns false for null/undefined', () => {
    assert.equal(canRetry(null), false);
    assert.equal(canRetry(undefined), false);
  });

  it('returns true when retry_count is 0', () => {
    assert.equal(canRetry({ retry_count: 0 }), true);
  });

  it('returns true when retry_count < MAX_RETRIES', () => {
    assert.equal(canRetry({ retry_count: MAX_RETRIES - 1 }), true);
  });

  it('returns false when retry_count >= MAX_RETRIES', () => {
    assert.equal(canRetry({ retry_count: MAX_RETRIES }), false);
    assert.equal(canRetry({ retry_count: MAX_RETRIES + 1 }), false);
  });

  it('returns false when dead_letter is true', () => {
    assert.equal(canRetry({ retry_count: 0, dead_letter: true }), false);
  });

  it('returns true when retry_count is missing (defaults to 0)', () => {
    assert.equal(canRetry({}), true);
  });
});

// ---------------------------------------------------------------------------
// incrementRetry
// ---------------------------------------------------------------------------

describe('incrementRetry', () => {
  it('increments retry_count from 0 to 1', () => {
    const result = incrementRetry({ retry_count: 0 });
    assert.equal(result.retry_count, 1);
  });

  it('returns a new object (immutable)', () => {
    const original = { retry_count: 1, title: 'test' };
    const result = incrementRetry(original);
    assert.notEqual(result, original);
    assert.equal(original.retry_count, 1);
  });

  it('defaults to 0 when retry_count is missing', () => {
    const result = incrementRetry({});
    assert.equal(result.retry_count, 1);
  });
});

// ---------------------------------------------------------------------------
// resetRetryState
// ---------------------------------------------------------------------------

describe('resetRetryState', () => {
  it('clears retry fields', () => {
    const result = resetRetryState({ retry_count: 3, last_failure_class: 'transient', dead_letter: true });
    assert.equal(result.retry_count, 0);
    assert.equal(result.last_failure_class, null);
    assert.equal(result.dead_letter, false);
  });

  it('returns a new object (immutable)', () => {
    const original = { retry_count: 3 };
    const result = resetRetryState(original);
    assert.notEqual(result, original);
  });
});

// ---------------------------------------------------------------------------
// getBackoffMs
// ---------------------------------------------------------------------------

describe('getBackoffMs', () => {
  it('returns a non-negative integer', () => {
    for (let i = 0; i < 10; i++) {
      const delay = getBackoffMs(i);
      assert.ok(delay >= 0, 'delay should be non-negative');
      assert.equal(delay, Math.floor(delay), 'delay should be integer');
    }
  });

  it('does not exceed BACKOFF_MAX_MS', () => {
    for (let i = 0; i < 20; i++) {
      assert.ok(getBackoffMs(i) <= BACKOFF_MAX_MS, `delay at retry ${i} should not exceed max`);
    }
  });

  it('base at retry 0 is BACKOFF_BASE_MS (delay in [0, BACKOFF_BASE_MS])', () => {
    // Run multiple times to verify range
    for (let i = 0; i < 50; i++) {
      const delay = getBackoffMs(0);
      assert.ok(delay <= BACKOFF_BASE_MS, `delay at retry 0 should be <= ${BACKOFF_BASE_MS}`);
    }
  });

  it('handles negative retryCount gracefully', () => {
    const delay = getBackoffMs(-1);
    assert.ok(delay >= 0);
    assert.ok(delay <= BACKOFF_BASE_MS);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  it('returns result on success', async () => {
    const result = await withRetry(async () => 'ok');
    assert.equal(result, 'ok');
  });

  it('throws immediately on permanent error', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw Object.assign(new Error('not found'), { status: 404 });
      }),
      /not found/
    );
    assert.equal(calls, 1, 'should not retry permanent errors');
  });

  it('retries transient errors up to maxRetries', async () => {
    let calls = 0;
    // Use zero-delay backoff by mocking Math.random
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      await assert.rejects(
        withRetry(async () => {
          calls++;
          throw Object.assign(new Error('rate limit'), { status: 429 });
        }, { maxRetries: 2 }),
        /rate limit/
      );
      assert.equal(calls, 3, 'should be initial + 2 retries');
    } finally {
      Math.random = origRandom;
    }
  });

  it('succeeds after transient failure followed by success', async () => {
    let calls = 0;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const result = await withRetry(async () => {
        calls++;
        if (calls < 2) throw Object.assign(new Error('service unavailable'), { status: 503 });
        return 'recovered';
      });
      assert.equal(result, 'recovered');
      assert.equal(calls, 2);
    } finally {
      Math.random = origRandom;
    }
  });

  it('uses default MAX_RETRIES when maxRetries not specified', async () => {
    let calls = 0;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      await assert.rejects(
        withRetry(async () => {
          calls++;
          throw Object.assign(new Error('rate limit'), { status: 429 });
        }),
        /rate limit/
      );
      assert.equal(calls, MAX_RETRIES + 1);
    } finally {
      Math.random = origRandom;
    }
  });

  it('does not retry needs-info errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error('ambiguous requirements');
      }),
      /ambiguous/
    );
    assert.equal(calls, 1, 'should not retry needs-info errors');
  });
});
