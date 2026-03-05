'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Create a temp directory for each test to avoid cross-contamination
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-logger-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Fresh require for each test group
function loadLogger() {
  delete require.cache[require.resolve('../lib/logger.cjs')];
  return require('../lib/logger.cjs');
}

// ---------------------------------------------------------------------------
// writeLog
// ---------------------------------------------------------------------------

describe('writeLog', () => {
  it('creates log directory and writes a JSON line', () => {
    const { writeLog, getLogFile } = loadLogger();
    writeLog({ command: 'run', issue: 42, status: 'ok', repoRoot: tmpDir });

    const logFile = getLogFile(tmpDir);
    assert.ok(fs.existsSync(logFile));

    const content = fs.readFileSync(logFile, 'utf-8').trim();
    const entry = JSON.parse(content);
    assert.equal(entry.command, 'run');
    assert.equal(entry.issue, 42);
    assert.equal(entry.status, 'ok');
    assert.ok(entry.timestamp);
    // repoRoot should NOT be in the written entry
    assert.equal(entry.repoRoot, undefined);
  });

  it('appends multiple entries', () => {
    const { writeLog, getLogFile } = loadLogger();
    writeLog({ command: 'run', status: 'ok', repoRoot: tmpDir });
    writeLog({ command: 'sync', status: 'ok', repoRoot: tmpDir });

    const lines = fs.readFileSync(getLogFile(tmpDir), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).command, 'run');
    assert.equal(JSON.parse(lines[1]).command, 'sync');
  });

  it('does not throw on write failure', () => {
    const { writeLog } = loadLogger();
    // /nonexistent path will fail — should not throw
    assert.doesNotThrow(() => {
      writeLog({ command: 'test', status: 'ok', repoRoot: '/nonexistent/path/mgw-test' });
    });
  });
});

// ---------------------------------------------------------------------------
// startTimer
// ---------------------------------------------------------------------------

describe('startTimer', () => {
  it('records duration_ms on finish', () => {
    const { startTimer, readLogs } = loadLogger();
    const timer = startTimer({ command: 'run', issue: 1, repoRoot: tmpDir });

    // Simulate a brief delay
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }

    timer.finish('ok');

    const entries = readLogs({ repoRoot: tmpDir });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].command, 'run');
    assert.equal(entries[0].status, 'ok');
    assert.ok(entries[0].duration_ms >= 0);
  });

  it('records error message on failure', () => {
    const { startTimer, readLogs } = loadLogger();
    const timer = startTimer({ command: 'sync', repoRoot: tmpDir });
    timer.finish('error', 'something failed');

    const entries = readLogs({ repoRoot: tmpDir });
    assert.equal(entries[0].status, 'error');
    assert.equal(entries[0].error, 'something failed');
  });
});

// ---------------------------------------------------------------------------
// readLogs
// ---------------------------------------------------------------------------

describe('readLogs', () => {
  it('returns empty array when no logs exist', () => {
    const { readLogs } = loadLogger();
    const entries = readLogs({ repoRoot: tmpDir });
    assert.deepEqual(entries, []);
  });

  it('filters by command', () => {
    const { writeLog, readLogs } = loadLogger();
    writeLog({ command: 'run', status: 'ok', repoRoot: tmpDir });
    writeLog({ command: 'sync', status: 'ok', repoRoot: tmpDir });
    writeLog({ command: 'run', status: 'error', repoRoot: tmpDir });

    const entries = readLogs({ repoRoot: tmpDir, command: 'run' });
    assert.equal(entries.length, 2);
    assert.ok(entries.every(e => e.command === 'run'));
  });

  it('filters by issue', () => {
    const { writeLog, readLogs } = loadLogger();
    writeLog({ command: 'run', issue: 10, status: 'ok', repoRoot: tmpDir });
    writeLog({ command: 'run', issue: 20, status: 'ok', repoRoot: tmpDir });

    const entries = readLogs({ repoRoot: tmpDir, issue: 10 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].issue, 10);
  });

  it('respects limit', () => {
    const { writeLog, readLogs } = loadLogger();
    for (let i = 0; i < 10; i++) {
      writeLog({ command: 'run', status: 'ok', repoRoot: tmpDir });
    }

    const entries = readLogs({ repoRoot: tmpDir, limit: 3 });
    assert.equal(entries.length, 3);
  });

  it('returns most recent first', () => {
    const { writeLog, readLogs } = loadLogger();
    writeLog({ command: 'first', status: 'ok', repoRoot: tmpDir });
    writeLog({ command: 'second', status: 'ok', repoRoot: tmpDir });

    const entries = readLogs({ repoRoot: tmpDir });
    assert.equal(entries[0].command, 'second');
    assert.equal(entries[1].command, 'first');
  });
});

// ---------------------------------------------------------------------------
// aggregateMetrics
// ---------------------------------------------------------------------------

describe('aggregateMetrics', () => {
  it('returns zeros for empty entries', () => {
    const { aggregateMetrics } = loadLogger();
    const metrics = aggregateMetrics([]);
    assert.equal(metrics.total, 0);
    assert.equal(metrics.avgDuration, 0);
    assert.equal(metrics.failureRate, 0);
  });

  it('computes correct metrics', () => {
    const { aggregateMetrics } = loadLogger();
    const entries = [
      { command: 'run', status: 'ok', duration_ms: 100 },
      { command: 'run', status: 'ok', duration_ms: 200 },
      { command: 'sync', status: 'error', duration_ms: 50, error: 'fail' },
    ];

    const metrics = aggregateMetrics(entries);
    assert.equal(metrics.total, 3);
    assert.equal(metrics.byStatus.ok, 2);
    assert.equal(metrics.byStatus.error, 1);
    assert.equal(metrics.failureRate, 33); // 1/3 ≈ 33%
    assert.equal(metrics.avgDuration, 117); // (100+200+50)/3 ≈ 117

    assert.equal(metrics.byCommand.run.count, 2);
    assert.equal(metrics.byCommand.run.avgDuration, 150);
    assert.equal(metrics.byCommand.sync.count, 1);
    assert.equal(metrics.byCommand.sync.errors, 1);
  });
});
