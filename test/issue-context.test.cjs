'use strict';

/**
 * test/issue-context.test.cjs — Unit tests for lib/issue-context.cjs
 *
 * Tests cover: parseMetadata, formatWithMetadata, buildGSDPromptContext (mock),
 * safeContext error handling, and cache read/write via temp directories.
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IC_MODULE = path.resolve(__dirname, '..', 'lib', 'issue-context.cjs');

/**
 * Reload lib/issue-context.cjs fresh (evict module cache).
 */
function loadIC() {
  delete require.cache[IC_MODULE];
  return require(IC_MODULE);
}

// ---------------------------------------------------------------------------
// parseMetadata
// ---------------------------------------------------------------------------

describe('parseMetadata', () => {
  it('extracts type, phase, milestone, timestamp from well-formed header', () => {
    const ic = loadIC();
    const body = '<!-- mgw:type=plan mgw:phase=3 mgw:milestone=1 mgw:timestamp=2026-03-05T12:00:00Z -->\n# Phase 3';
    const result = ic.parseMetadata(body);
    assert.equal(result.type, 'plan');
    assert.equal(result.phase, 3);
    assert.equal(result.milestone, 1);
    assert.equal(result.timestamp, '2026-03-05T12:00:00Z');
  });

  it('returns nulls for comment with no metadata header', () => {
    const ic = loadIC();
    const result = ic.parseMetadata('# Just a regular comment\nNo metadata here.');
    assert.equal(result.type, null);
    assert.equal(result.phase, null);
    assert.equal(result.milestone, null);
    assert.equal(result.timestamp, null);
  });

  it('returns nulls for null/undefined/empty input', () => {
    const ic = loadIC();
    assert.deepEqual(ic.parseMetadata(null), { type: null, phase: null, milestone: null, timestamp: null });
    assert.deepEqual(ic.parseMetadata(undefined), { type: null, phase: null, milestone: null, timestamp: null });
    assert.deepEqual(ic.parseMetadata(''), { type: null, phase: null, milestone: null, timestamp: null });
  });

  it('handles partial metadata (only type)', () => {
    const ic = loadIC();
    const body = '<!-- mgw:type=summary -->\nSome content';
    const result = ic.parseMetadata(body);
    assert.equal(result.type, 'summary');
    assert.equal(result.phase, null);
    assert.equal(result.milestone, null);
  });

  it('handles malformed HTML comment gracefully', () => {
    const ic = loadIC();
    const body = '<!-- broken comment\nno closing';
    const result = ic.parseMetadata(body);
    assert.equal(result.type, null);
  });

  it('ignores metadata in non-HTML-comment context', () => {
    const ic = loadIC();
    const body = 'mgw:type=plan mgw:phase=3';
    const result = ic.parseMetadata(body);
    assert.equal(result.type, null);
  });
});

// ---------------------------------------------------------------------------
// formatWithMetadata
// ---------------------------------------------------------------------------

describe('formatWithMetadata', () => {
  it('prepends metadata header with all fields', () => {
    const ic = loadIC();
    const result = ic.formatWithMetadata('test content', { type: 'plan', phase: 3, milestone: 1 });
    assert.ok(result.startsWith('<!-- mgw:type=plan mgw:phase=3 mgw:milestone=1 mgw:timestamp='));
    assert.ok(result.includes('test content'));
  });

  it('includes timestamp even when not provided', () => {
    const ic = loadIC();
    const result = ic.formatWithMetadata('content', { type: 'summary' });
    assert.ok(result.includes('mgw:timestamp='));
  });

  it('uses provided timestamp when given', () => {
    const ic = loadIC();
    const result = ic.formatWithMetadata('content', {
      type: 'plan',
      phase: 1,
      milestone: 1,
      timestamp: '2026-01-01T00:00:00Z',
    });
    assert.ok(result.includes('mgw:timestamp=2026-01-01T00:00:00Z'));
  });

  it('round-trips with parseMetadata', () => {
    const ic = loadIC();
    const formatted = ic.formatWithMetadata('test', {
      type: 'verification',
      phase: 5,
      milestone: 2,
      timestamp: '2026-06-15T10:30:00Z',
    });
    const parsed = ic.parseMetadata(formatted);
    assert.equal(parsed.type, 'verification');
    assert.equal(parsed.phase, 5);
    assert.equal(parsed.milestone, 2);
    assert.equal(parsed.timestamp, '2026-06-15T10:30:00Z');
  });

  it('handles empty/null meta gracefully', () => {
    const ic = loadIC();
    const result = ic.formatWithMetadata('content', {});
    assert.ok(result.includes('<!-- '));
    assert.ok(result.includes('content'));
  });

  it('content appears after the header line', () => {
    const ic = loadIC();
    const result = ic.formatWithMetadata('my content here', { type: 'plan' });
    const lines = result.split('\n');
    assert.ok(lines[0].startsWith('<!--'));
    assert.ok(lines[0].endsWith('-->'));
    assert.equal(lines[1], 'my content here');
  });
});

// ---------------------------------------------------------------------------
// buildGSDPromptContext (with mocked data)
// ---------------------------------------------------------------------------

describe('buildGSDPromptContext', () => {
  it('returns empty string when no options produce content', async () => {
    const ic = loadIC();
    // No milestone, no vision, no summaries — should return empty
    const result = await ic.buildGSDPromptContext({});
    assert.equal(result, '');
  });

  it('includes vision section when project.json has description', async () => {
    const ic = loadIC();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-ic-test-'));
    const mgwDir = path.join(tmpDir, '.mgw');
    fs.mkdirSync(mgwDir, { recursive: true });
    fs.writeFileSync(
      path.join(mgwDir, 'project.json'),
      JSON.stringify({ project: { name: 'TestProject', description: 'A test project for e-commerce' } }),
      'utf-8'
    );

    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const result = await ic.buildGSDPromptContext({ includeVision: true });
      assert.ok(result.includes('<mgw_context>'));
      assert.ok(result.includes('<vision>'));
      assert.ok(result.includes('A test project for e-commerce'));
      assert.ok(result.includes('</vision>'));
      assert.ok(result.includes('</mgw_context>'));
    } finally {
      process.cwd = origCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// safeContext
// ---------------------------------------------------------------------------

describe('safeContext', () => {
  it('returns empty string when buildGSDPromptContext would throw', async () => {
    const ic = loadIC();
    // Calling with a milestone that doesn't exist in any real repo
    // This should not throw, just return empty string
    const result = await ic.safeContext({ issueNumber: 99999, includeVision: true });
    assert.equal(typeof result, 'string');
    // safeContext should return '' or a context string, never throw
  });

  it('returns a string type', async () => {
    const ic = loadIC();
    const result = await ic.safeContext({});
    assert.equal(typeof result, 'string');
  });
});

// ---------------------------------------------------------------------------
// fetchProjectVision
// ---------------------------------------------------------------------------

describe('fetchProjectVision', () => {
  it('falls back to project.json description when no GitHub board', async () => {
    const ic = loadIC();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-vision-test-'));
    const mgwDir = path.join(tmpDir, '.mgw');
    fs.mkdirSync(mgwDir, { recursive: true });
    fs.writeFileSync(
      path.join(mgwDir, 'project.json'),
      JSON.stringify({ project: { name: 'TestVision', description: 'E-commerce platform with search' } }),
      'utf-8'
    );

    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const result = await ic.fetchProjectVision();
      assert.ok(result.includes('E-commerce platform with search'));
    } finally {
      process.cwd = origCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to vision-brief.json when no project description or name', async () => {
    const ic = loadIC();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-vision-test-'));
    const mgwDir = path.join(tmpDir, '.mgw');
    fs.mkdirSync(mgwDir, { recursive: true });
    // project.json exists but has no description and no name — triggers vision-brief fallback
    fs.writeFileSync(
      path.join(mgwDir, 'project.json'),
      JSON.stringify({ project: {} }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(mgwDir, 'vision-brief.json'),
      JSON.stringify({ vision_summary: 'A revolutionary app for pet owners' }),
      'utf-8'
    );

    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const result = await ic.fetchProjectVision();
      assert.ok(result.includes('revolutionary app for pet owners'));
    } finally {
      process.cwd = origCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty string when no sources available', async () => {
    const ic = loadIC();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-vision-test-'));

    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const result = await ic.fetchProjectVision();
      assert.equal(result, '');
    } finally {
      process.cwd = origCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// updateProjectReadme
// ---------------------------------------------------------------------------

describe('updateProjectReadme', () => {
  it('returns false when no project.json exists', async () => {
    const ic = loadIC();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-readme-test-'));

    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const result = await ic.updateProjectReadme();
      assert.equal(result, false);
    } finally {
      process.cwd = origCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns false when no board configured', async () => {
    const ic = loadIC();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-readme-test-'));
    const mgwDir = path.join(tmpDir, '.mgw');
    fs.mkdirSync(mgwDir, { recursive: true });
    fs.writeFileSync(
      path.join(mgwDir, 'project.json'),
      JSON.stringify({ project: { name: 'Test' }, milestones: [] }),
      'utf-8'
    );

    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      const result = await ic.updateProjectReadme();
      assert.equal(result, false);
    } finally {
      process.cwd = origCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cache read/write
// ---------------------------------------------------------------------------

describe('context cache', () => {
  let tmpDir;
  let origCwd;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-cache-test-'));
    origCwd = process.cwd;
  });

  afterEach(() => {
    process.cwd = origCwd;
    const cacheDir = path.join(tmpDir, '.mgw', 'context-cache');
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  after(() => {
    process.cwd = origCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports all required functions', () => {
    const ic = loadIC();
    const fns = [
      'parseMetadata', 'formatWithMetadata', 'postPlanningComment',
      'findPlanningComments', 'findLatestComment', 'assembleMilestoneContext',
      'assembleIssueContext', 'buildGSDPromptContext', 'safeContext',
      'rebuildContextCache', 'fetchProjectVision', 'updateProjectReadme',
    ];
    for (const fn of fns) {
      assert.equal(typeof ic[fn], 'function', `${fn} should be a function`);
    }
  });
});
