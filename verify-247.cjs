'use strict';
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const WORKTREE = __dirname;
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log('PASS:', name);
    passed++;
  } catch (err) {
    console.error('FAIL:', name, '-', err.message);
    failed++;
  }
}

// Check 1: all required exports
check('lib/mock-github.cjs exports required functions', () => {
  delete require.cache[require.resolve(path.join(WORKTREE, 'lib/mock-github.cjs'))];
  const m = require(path.join(WORKTREE, 'lib/mock-github.cjs'));
  const required = ['activate', 'deactivate', 'getCallLog', 'clearCallLog', 'setResponse', 'isActive'];
  const missing = required.filter(f => typeof m[f] !== 'function');
  if (missing.length) throw new Error('missing: ' + missing.join(', '));
});

// Check 2: activate patches execSync
check('activate() patches and deactivate() restores execSync', () => {
  delete require.cache[require.resolve(path.join(WORKTREE, 'lib/mock-github.cjs'))];
  const m = require(path.join(WORKTREE, 'lib/mock-github.cjs'));
  const orig = cp.execSync;
  m.activate();
  if (cp.execSync === orig) throw new Error('execSync not patched after activate()');
  m.deactivate();
  if (cp.execSync !== orig) throw new Error('execSync not restored after deactivate()');
});

// Check 3: fixture count
check('16 fixture files exist in test/fixtures/github/', () => {
  const fixturesDir = path.join(WORKTREE, 'test', 'fixtures', 'github');
  const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json'));
  if (files.length !== 16) throw new Error(`expected 16, got ${files.length}: ${files.join(', ')}`);
});

// Check 4: getCallLog returns ordered array
check('getCallLog() returns ordered array of intercepted calls', () => {
  delete require.cache[require.resolve(path.join(WORKTREE, 'lib/mock-github.cjs'))];
  const m = require(path.join(WORKTREE, 'lib/mock-github.cjs'));
  m.activate();
  cp.execSync('gh issue view 42', { encoding: 'utf-8' });
  cp.execSync('gh pr create --title Test', { encoding: 'utf-8' });
  const log = m.getCallLog();
  m.deactivate();
  if (!Array.isArray(log)) throw new Error('not an array');
  if (log.length !== 2) throw new Error(`expected 2 entries, got ${log.length}`);
  if (!log[0].cmd.includes('issue view')) throw new Error('wrong order in call log');
  if (log[0].fixture !== 'issue-view') throw new Error(`wrong fixture key: ${log[0].fixture}`);
  if (log[1].fixture !== 'pr-create') throw new Error(`wrong fixture key: ${log[1].fixture}`);
});

// Check 5: deactivate disables mock
check('deactivate() disables mock', () => {
  delete require.cache[require.resolve(path.join(WORKTREE, 'lib/mock-github.cjs'))];
  const m = require(path.join(WORKTREE, 'lib/mock-github.cjs'));
  m.activate();
  if (!m.isActive()) throw new Error('should be active after activate()');
  m.deactivate();
  if (m.isActive()) throw new Error('should not be active after deactivate()');
});

// Check 6: inline override works
check('setResponse() inline override takes precedence over fixtures', () => {
  delete require.cache[require.resolve(path.join(WORKTREE, 'lib/mock-github.cjs'))];
  const m = require(path.join(WORKTREE, 'lib/mock-github.cjs'));
  m.activate();
  m.setResponse('gh issue view', JSON.stringify({ number: 999, title: 'Custom' }));
  const result = JSON.parse(cp.execSync('gh issue view 999', { encoding: 'utf-8' }));
  m.deactivate();
  if (result.number !== 999) throw new Error(`expected 999, got ${result.number}`);
});

// Check 7: clearCallLog
check('clearCallLog() clears without deactivating', () => {
  delete require.cache[require.resolve(path.join(WORKTREE, 'lib/mock-github.cjs'))];
  const m = require(path.join(WORKTREE, 'lib/mock-github.cjs'));
  m.activate();
  cp.execSync('gh issue list', { encoding: 'utf-8' });
  m.clearCallLog();
  const log = m.getCallLog();
  m.deactivate();
  if (log.length !== 0) throw new Error(`expected 0 entries, got ${log.length}`);
});

// Check 8: re-activate is safe
check('re-activate without deactivate is safe', () => {
  delete require.cache[require.resolve(path.join(WORKTREE, 'lib/mock-github.cjs'))];
  const m = require(path.join(WORKTREE, 'lib/mock-github.cjs'));
  const orig = cp.execSync;
  m.activate();
  m.activate(); // should auto-deactivate first
  m.deactivate();
  if (cp.execSync !== orig) throw new Error('execSync not restored after double-activate then deactivate');
});

// Check 9: fixture content correctness
check('issue-view fixture has correct shape', () => {
  delete require.cache[require.resolve(path.join(WORKTREE, 'lib/mock-github.cjs'))];
  const m = require(path.join(WORKTREE, 'lib/mock-github.cjs'));
  m.activate();
  const raw = cp.execSync('gh issue view 42 --json number,title', { encoding: 'utf-8' });
  const parsed = JSON.parse(raw);
  m.deactivate();
  if (typeof parsed.number !== 'number') throw new Error('number field missing');
  if (typeof parsed.title !== 'string') throw new Error('title field missing');
  if (!Array.isArray(parsed.labels)) throw new Error('labels field missing');
});

// Check 10: milestone routing
check('milestone-view fixture routes correctly', () => {
  delete require.cache[require.resolve(path.join(WORKTREE, 'lib/mock-github.cjs'))];
  const m = require(path.join(WORKTREE, 'lib/mock-github.cjs'));
  m.activate();
  const raw = cp.execSync('gh api repos/snipcodeit/mgw/milestones/3', { encoding: 'utf-8' });
  const ms = JSON.parse(raw);
  m.deactivate();
  if (ms.number !== 3) throw new Error(`expected number 3, got ${ms.number}`);
  if (ms.state !== 'open') throw new Error(`expected state open, got ${ms.state}`);
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('VERIFICATION PASSED');
