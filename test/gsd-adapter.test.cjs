'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Import selectGsdRoute directly — it's pure logic, no mocking needed
const { selectGsdRoute } = require('../lib/gsd-adapter.cjs');

// ---------------------------------------------------------------------------
// selectGsdRoute
// ---------------------------------------------------------------------------

describe('selectGsdRoute', () => {
  // Priority 1: Explicit labels
  describe('Priority 1: explicit label', () => {
    it('returns "quick" for gsd-route:quick label', () => {
      const issue = { labels: [{ name: 'gsd-route:quick' }], pipeline_stage: '' };
      assert.equal(selectGsdRoute(issue), 'quick');
    });

    it('returns "quick" for gsd:quick label', () => {
      const issue = { labels: ['gsd:quick'], pipeline_stage: '' };
      assert.equal(selectGsdRoute(issue), 'quick');
    });

    it('returns "quick" for bare "quick" label', () => {
      const issue = { labels: ['quick'], pipeline_stage: '' };
      assert.equal(selectGsdRoute(issue), 'quick');
    });

    it('returns "diagnose" for gsd-route:diagnose label', () => {
      const issue = { labels: [{ name: 'gsd-route:diagnose' }], pipeline_stage: '' };
      assert.equal(selectGsdRoute(issue), 'diagnose');
    });

    it('returns "diagnose" for needs-diagnosis label', () => {
      const issue = { labels: ['needs-diagnosis'], pipeline_stage: '' };
      assert.equal(selectGsdRoute(issue), 'diagnose');
    });

    it('labels take priority over pipeline stage', () => {
      const issue = { labels: ['quick'], pipeline_stage: 'executing' };
      assert.equal(selectGsdRoute(issue), 'quick');
    });
  });

  // Priority 2: Pipeline stage continuation
  describe('Priority 2: pipeline stage continuation', () => {
    it('returns "diagnose" when pipeline_stage is "diagnosing"', () => {
      const issue = { labels: [], pipeline_stage: 'diagnosing' };
      assert.equal(selectGsdRoute(issue), 'diagnose');
    });

    it('returns "execute-only" when pipeline_stage is "executing"', () => {
      const issue = { labels: [], pipeline_stage: 'executing' };
      assert.equal(selectGsdRoute(issue), 'execute-only');
    });

    it('returns "verify-only" when pipeline_stage is "verifying"', () => {
      const issue = { labels: [], pipeline_stage: 'verifying' };
      assert.equal(selectGsdRoute(issue), 'verify-only');
    });
  });

  // Priority 4: Default
  describe('Priority 4: default', () => {
    it('returns "plan-phase" when no labels or stage match', () => {
      const issue = { labels: [], pipeline_stage: '' };
      assert.equal(selectGsdRoute(issue), 'plan-phase');
    });

    it('returns "plan-phase" for empty issue object', () => {
      assert.equal(selectGsdRoute({}), 'plan-phase');
    });

    it('returns "plan-phase" when pipeline_stage is "triaged"', () => {
      const issue = { labels: [], pipeline_stage: 'triaged' };
      assert.equal(selectGsdRoute(issue), 'plan-phase');
    });

    it('returns "plan-phase" when pipeline_stage is "planning"', () => {
      const issue = { labels: [], pipeline_stage: 'planning' };
      assert.equal(selectGsdRoute(issue), 'plan-phase');
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('handles labels as array of strings', () => {
      const issue = { labels: ['bug', 'quick'], pipeline_stage: '' };
      assert.equal(selectGsdRoute(issue), 'quick');
    });

    it('handles labels as array of objects with name', () => {
      const issue = { labels: [{ name: 'bug' }, { name: 'gsd-route:diagnose' }], pipeline_stage: '' };
      assert.equal(selectGsdRoute(issue), 'diagnose');
    });

    it('handles labels being undefined', () => {
      const issue = { pipeline_stage: 'executing' };
      assert.equal(selectGsdRoute(issue), 'execute-only');
    });

    it('handles pipeline_stage being undefined', () => {
      const issue = { labels: [] };
      assert.equal(selectGsdRoute(issue), 'plan-phase');
    });

    it('project state parameter does not change default routing', () => {
      const issue = { labels: [], pipeline_stage: '' };
      const projectState = { milestones: [{ title: 'v1.0' }] };
      assert.equal(selectGsdRoute(issue, projectState), 'plan-phase');
    });
  });
});
