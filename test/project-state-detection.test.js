/**
 * test/project-state-detection.test.js — Scenario tests for mgw:project state detection
 *
 * Tests all six STATE_CLASS paths of the detectProjectState() function in lib/state.cjs.
 * The function encapsulates the five-signal classification logic from workflows/detect-state.md.
 *
 * Five signals:
 *   P — .planning/PROJECT.md exists
 *   R — .planning/ROADMAP.md exists
 *   S — .planning/STATE.md exists
 *   M — .mgw/project.json exists
 *   G — Count of GitHub milestones (passed as githubMilestoneCount, no live API call)
 *
 * Six STATE_CLASS values:
 *   Fresh        — no GSD state, no MGW state, no GitHub milestones
 *   GSD-Only     — PROJECT.md present, no ROADMAP, no MGW, G=0
 *   GSD-Mid-Exec — PROJECT.md + ROADMAP (or STATE.md) present, no MGW, G=0
 *   Aligned      — MGW project.json + GitHub milestones present, counts consistent
 *   Diverged     — MGW project.json + GitHub milestones present, counts inconsistent
 *   Extend       — MGW project.json present, all milestones complete (current_milestone > count)
 *
 * Isolation strategy:
 *   - fs.mkdtempSync() creates a real tmp dir per describe block
 *   - Fixtures pre-seed .mgw/ and .planning/ directories in the tmp dir
 *   - detectProjectState() takes { repoRoot, githubMilestoneCount } — no live calls
 *   - afterAll() removes tmp dirs
 *   - No live GitHub tokens or Claude API calls used
 *
 * Dependencies:
 *   - lib/state.cjs:detectProjectState — extracted from workflows/detect-state.md
 *   - test/fixtures/project-state/{aligned,diverged,extend}.json — pre-baked project.json content
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const STATE_MODULE = path.join(REPO_ROOT, 'lib', 'state.cjs');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'project-state');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reload lib/state.cjs fresh (evict module cache so process.cwd override
 * takes effect on each reload if needed).
 */
function loadState() {
  delete _require.cache[STATE_MODULE];
  return _require(STATE_MODULE);
}

/**
 * Create a temp directory. Returns tmpDir path.
 */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-state-test-'));
}

/**
 * Remove a temp directory.
 */
function removeTmpDir(tmpDir) {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Seed a file into tmpDir, creating parent directories as needed.
 *
 * @param {string} tmpDir - Base temp directory
 * @param {string} relPath - Relative path within tmpDir (e.g. '.planning/PROJECT.md')
 * @param {string} [content=''] - File content
 */
function seedFile(tmpDir, relPath, content = '') {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

/**
 * Seed .mgw/project.json from a fixture file.
 *
 * @param {string} tmpDir - Base temp directory
 * @param {string} fixtureName - Name of fixture in test/fixtures/project-state/
 */
function seedProjectJson(tmpDir, fixtureName) {
  const fixturePath = path.join(FIXTURES_DIR, `${fixtureName}.json`);
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }
  seedFile(tmpDir, '.mgw/project.json', fs.readFileSync(fixturePath, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('detectProjectState', () => {
  // ---------------------------------------------------------------------------
  // STATE_CLASS: Fresh
  // Signals: P=false, R=false, S=false, M=false, G=0
  // No files on disk, no GitHub milestones.
  // ---------------------------------------------------------------------------
  describe('Fresh', () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = makeTmpDir();
      // No files seeded — completely empty directory
    });

    afterAll(() => {
      removeTmpDir(tmpDir);
    });

    it('returns Fresh when no planning files and no project.json exist and G=0', () => {
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 0 });

      expect(result.stateClass).toBe('Fresh');
    });

    it('reports all signals as false/0', () => {
      const { detectProjectState } = loadState();
      const { signals } = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 0 });

      expect(signals.P).toBe(false);
      expect(signals.R).toBe(false);
      expect(signals.S).toBe(false);
      expect(signals.M).toBe(false);
      expect(signals.G).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // STATE_CLASS: GSD-Only
  // Signals: P=true, R=false, S=false, M=false, G=0
  // .planning/PROJECT.md exists — project is scoped but no roadmap yet.
  // ---------------------------------------------------------------------------
  describe('GSD-Only', () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = makeTmpDir();
      // Seed only PROJECT.md — no ROADMAP.md, no STATE.md, no project.json
      seedFile(tmpDir, '.planning/PROJECT.md', '# Test Project\n');
    });

    afterAll(() => {
      removeTmpDir(tmpDir);
    });

    it('returns GSD-Only when only PROJECT.md exists and G=0', () => {
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 0 });

      expect(result.stateClass).toBe('GSD-Only');
    });

    it('reports P=true, M=false, G=0', () => {
      const { detectProjectState } = loadState();
      const { signals } = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 0 });

      expect(signals.P).toBe(true);
      expect(signals.R).toBe(false);
      expect(signals.S).toBe(false);
      expect(signals.M).toBe(false);
      expect(signals.G).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // STATE_CLASS: GSD-Mid-Exec
  // Signals: P=true, R=true, S=true, M=false, G=0
  // Full GSD state exists (.planning/PROJECT.md + ROADMAP.md + STATE.md),
  // but MGW has not yet been initialized.
  // ---------------------------------------------------------------------------
  describe('GSD-Mid-Exec', () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = makeTmpDir();
      // Seed PROJECT.md, ROADMAP.md, and STATE.md — no project.json
      seedFile(tmpDir, '.planning/PROJECT.md', '# Test Project\n');
      seedFile(tmpDir, '.planning/ROADMAP.md', '# Roadmap\n\n## v1 — Core\n');
      seedFile(tmpDir, '.planning/STATE.md', '# State\nphase: 1\n');
    });

    afterAll(() => {
      removeTmpDir(tmpDir);
    });

    it('returns GSD-Mid-Exec when PROJECT.md + ROADMAP.md + STATE.md exist and G=0', () => {
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 0 });

      expect(result.stateClass).toBe('GSD-Mid-Exec');
    });

    it('reports P=true, R=true, S=true, M=false, G=0', () => {
      const { detectProjectState } = loadState();
      const { signals } = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 0 });

      expect(signals.P).toBe(true);
      expect(signals.R).toBe(true);
      expect(signals.S).toBe(true);
      expect(signals.M).toBe(false);
      expect(signals.G).toBe(0);
    });

    it('also returns GSD-Mid-Exec when only PROJECT.md + ROADMAP.md exist (no STATE.md)', () => {
      // Edge case: R=true is sufficient for GSD-Mid-Exec per detect-state.md logic
      const midExecDir = makeTmpDir();
      seedFile(midExecDir, '.planning/PROJECT.md', '# Test Project\n');
      seedFile(midExecDir, '.planning/ROADMAP.md', '# Roadmap\n');
      // No STATE.md

      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: midExecDir, githubMilestoneCount: 0 });

      expect(result.stateClass).toBe('GSD-Mid-Exec');

      removeTmpDir(midExecDir);
    });
  });

  // ---------------------------------------------------------------------------
  // STATE_CLASS: Aligned
  // Signals: M=true, G>0, local milestone count consistent with G (|local-G| <= 1)
  // Both MGW project.json and GitHub milestones exist and counts match.
  // ---------------------------------------------------------------------------
  describe('Aligned', () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = makeTmpDir();
      // Seed project.json with 2 milestones, current_milestone=1 (not all done)
      seedProjectJson(tmpDir, 'aligned');
      // Also seed planning files (P=true) to match realistic Aligned scenario
      seedFile(tmpDir, '.planning/PROJECT.md', '# Test Project\n');
    });

    afterAll(() => {
      removeTmpDir(tmpDir);
    });

    it('returns Aligned when project.json has 2 milestones and G=2 (exact match)', () => {
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 2 });

      expect(result.stateClass).toBe('Aligned');
    });

    it('returns Aligned when G is off by 1 (|local-G| <= 1 tolerance)', () => {
      // project.json has 2 milestones, G=1 — off by 1 is still Aligned
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 1 });

      expect(result.stateClass).toBe('Aligned');
    });

    it('reports M=true and G>0', () => {
      const { detectProjectState } = loadState();
      const { signals } = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 2 });

      expect(signals.M).toBe(true);
      expect(signals.G).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // STATE_CLASS: Diverged
  // Signals: M=true, G>0, local milestone count inconsistent with G (|local-G| > 1)
  // MGW project.json and GitHub milestones exist but counts diverge significantly.
  // ---------------------------------------------------------------------------
  describe('Diverged', () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = makeTmpDir();
      // Seed project.json with 5 milestones — G will be set to 2 (diff = 3 > 1)
      seedProjectJson(tmpDir, 'diverged');
    });

    afterAll(() => {
      removeTmpDir(tmpDir);
    });

    it('returns Diverged when local has 5 milestones but G=2 (diff > 1)', () => {
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 2 });

      expect(result.stateClass).toBe('Diverged');
    });

    it('returns Diverged when local has 5 milestones but G=0 is not applicable (M=true, G>0 path)', () => {
      // G=8: 5 local vs 8 GitHub — diff=3 > 1 → Diverged
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 8 });

      expect(result.stateClass).toBe('Diverged');
    });

    it('reports M=true and G>0', () => {
      const { detectProjectState } = loadState();
      const { signals } = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 2 });

      expect(signals.M).toBe(true);
      expect(signals.G).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // STATE_CLASS: Extend
  // Signals: M=true, G>0, current_milestone > milestones.length (all done)
  // All milestones in project.json are complete — project is ready to extend.
  // ---------------------------------------------------------------------------
  describe('Extend', () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = makeTmpDir();
      // Seed project.json with 2 milestones, current_milestone=3 (all done)
      seedProjectJson(tmpDir, 'extend');
    });

    afterAll(() => {
      removeTmpDir(tmpDir);
    });

    it('returns Extend when current_milestone (3) > milestones.length (2)', () => {
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 2 });

      expect(result.stateClass).toBe('Extend');
    });

    it('returns Extend regardless of G value (Extend check runs before consistency check)', () => {
      // Even if G is very different (e.g. G=10), Extend is detected first
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 10 });

      expect(result.stateClass).toBe('Extend');
    });

    it('reports M=true and G>0', () => {
      const { detectProjectState } = loadState();
      const { signals } = detectProjectState({ repoRoot: tmpDir, githubMilestoneCount: 2 });

      expect(signals.M).toBe(true);
      expect(signals.G).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Return shape contract
  // ---------------------------------------------------------------------------
  describe('return shape', () => {
    it('always returns { stateClass: string, signals: { P, R, S, M, G } }', () => {
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: '/tmp', githubMilestoneCount: 0 });

      expect(result).toHaveProperty('stateClass');
      expect(typeof result.stateClass).toBe('string');
      expect(result).toHaveProperty('signals');
      expect(typeof result.signals.P).toBe('boolean');
      expect(typeof result.signals.R).toBe('boolean');
      expect(typeof result.signals.S).toBe('boolean');
      expect(typeof result.signals.M).toBe('boolean');
      expect(typeof result.signals.G).toBe('number');
    });

    it('defaults repoRoot to process.cwd() when not provided', () => {
      const { detectProjectState } = loadState();
      // Called without repoRoot — should not throw
      expect(() => detectProjectState({ githubMilestoneCount: 0 })).not.toThrow();
    });

    it('defaults githubMilestoneCount to 0 when not provided', () => {
      const { detectProjectState } = loadState();
      const result = detectProjectState({ repoRoot: '/tmp' });

      expect(result.signals.G).toBe(0);
    });
  });
});
