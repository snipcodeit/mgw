'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MgwError,
  GitHubApiError,
  GsdToolError,
  StateError,
  TimeoutError,
  ClaudeNotAvailableError,
} = require('../lib/errors.cjs');

// ---------------------------------------------------------------------------
// MgwError (base)
// ---------------------------------------------------------------------------

describe('MgwError', () => {
  it('extends Error', () => {
    const err = new MgwError('test');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof MgwError);
  });

  it('has correct name, message, and defaults', () => {
    const err = new MgwError('something broke');
    assert.equal(err.name, 'MgwError');
    assert.equal(err.message, 'something broke');
    assert.equal(err.code, 'MGW_ERROR');
    assert.equal(err.stage, null);
    assert.equal(err.issueNumber, null);
  });

  it('accepts optional code, stage, issueNumber', () => {
    const err = new MgwError('msg', { code: 'CUSTOM', stage: 'executing', issueNumber: 42 });
    assert.equal(err.code, 'CUSTOM');
    assert.equal(err.stage, 'executing');
    assert.equal(err.issueNumber, 42);
  });

  it('accepts a cause error', () => {
    const cause = new Error('root');
    const err = new MgwError('wrapper', { cause });
    assert.equal(err.cause, cause);
  });
});

// ---------------------------------------------------------------------------
// GitHubApiError
// ---------------------------------------------------------------------------

describe('GitHubApiError', () => {
  it('extends MgwError', () => {
    const err = new GitHubApiError('API fail');
    assert.ok(err instanceof MgwError);
    assert.ok(err instanceof GitHubApiError);
  });

  it('has correct name and default code', () => {
    const err = new GitHubApiError('API fail');
    assert.equal(err.name, 'GitHubApiError');
    assert.equal(err.code, 'GITHUB_API_ERROR');
  });

  it('stores status and endpoint', () => {
    const err = new GitHubApiError('not found', { status: 404, endpoint: '/repos/x/y' });
    assert.equal(err.status, 404);
    assert.equal(err.endpoint, '/repos/x/y');
  });

  it('defaults status and endpoint to null', () => {
    const err = new GitHubApiError('msg');
    assert.equal(err.status, null);
    assert.equal(err.endpoint, null);
  });
});

// ---------------------------------------------------------------------------
// GsdToolError
// ---------------------------------------------------------------------------

describe('GsdToolError', () => {
  it('extends MgwError', () => {
    const err = new GsdToolError('tool fail');
    assert.ok(err instanceof MgwError);
    assert.ok(err instanceof GsdToolError);
  });

  it('has correct name and default code', () => {
    const err = new GsdToolError('tool fail');
    assert.equal(err.name, 'GsdToolError');
    assert.equal(err.code, 'GSD_TOOL_ERROR');
  });

  it('stores command field', () => {
    const err = new GsdToolError('fail', { command: 'generate-slug' });
    assert.equal(err.command, 'generate-slug');
  });
});

// ---------------------------------------------------------------------------
// StateError
// ---------------------------------------------------------------------------

describe('StateError', () => {
  it('extends MgwError', () => {
    const err = new StateError('state fail');
    assert.ok(err instanceof MgwError);
  });

  it('stores filePath', () => {
    const err = new StateError('bad', { filePath: '/tmp/project.json' });
    assert.equal(err.filePath, '/tmp/project.json');
  });
});

// ---------------------------------------------------------------------------
// TimeoutError
// ---------------------------------------------------------------------------

describe('TimeoutError', () => {
  it('extends MgwError', () => {
    const err = new TimeoutError('timed out');
    assert.ok(err instanceof MgwError);
    assert.ok(err instanceof TimeoutError);
  });

  it('has correct name and code', () => {
    const err = new TimeoutError('timed out');
    assert.equal(err.name, 'TimeoutError');
    assert.equal(err.code, 'TIMEOUT_ERROR');
  });

  it('stores timeoutMs and operation', () => {
    const err = new TimeoutError('slow', { timeoutMs: 30000, operation: 'gh api' });
    assert.equal(err.timeoutMs, 30000);
    assert.equal(err.operation, 'gh api');
  });
});

// ---------------------------------------------------------------------------
// ClaudeNotAvailableError
// ---------------------------------------------------------------------------

describe('ClaudeNotAvailableError', () => {
  it('extends MgwError', () => {
    const err = new ClaudeNotAvailableError('not installed');
    assert.ok(err instanceof MgwError);
    assert.ok(err instanceof ClaudeNotAvailableError);
  });

  it('has correct name and code', () => {
    const err = new ClaudeNotAvailableError('not installed');
    assert.equal(err.name, 'ClaudeNotAvailableError');
    assert.equal(err.code, 'CLAUDE_NOT_AVAILABLE');
  });

  it('stores reason field', () => {
    const err = new ClaudeNotAvailableError('msg', { reason: 'not-authenticated' });
    assert.equal(err.reason, 'not-authenticated');
  });
});

// ---------------------------------------------------------------------------
// instanceof checks across hierarchy
// ---------------------------------------------------------------------------

describe('instanceof hierarchy', () => {
  it('all error types are instanceof Error', () => {
    const errors = [
      new MgwError('a'),
      new GitHubApiError('b'),
      new GsdToolError('c'),
      new StateError('d'),
      new TimeoutError('e'),
      new ClaudeNotAvailableError('f'),
    ];
    for (const err of errors) {
      assert.ok(err instanceof Error, `${err.name} should be instanceof Error`);
      assert.ok(err instanceof MgwError, `${err.name} should be instanceof MgwError`);
    }
  });

  it('subtypes are not instanceof each other', () => {
    const gh = new GitHubApiError('x');
    const gsd = new GsdToolError('y');
    assert.ok(!(gh instanceof GsdToolError));
    assert.ok(!(gsd instanceof GitHubApiError));
  });
});
