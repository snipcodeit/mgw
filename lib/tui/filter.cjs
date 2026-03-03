'use strict';

/**
 * FilterState — manages active label/milestone/state/assignee filters
 * for the TUI issue browser.
 *
 * Filters are extracted from the full issue set (labels, milestones,
 * assignees are collected from the loaded issues so the pane always
 * shows real options).
 *
 * The filter pane presents three sections:
 *   Labels     — multi-select checkboxes
 *   Milestones — multi-select checkboxes
 *   State      — single-select (open / closed / all)
 *
 * Applying filters narrows the issue list BEFORE fuzzy search runs,
 * so search works within the filtered view.
 *
 * Persistence: on FilterState construction the caller may supply a
 * persistedState object from .mgw/config.json; on any mutation the
 * caller receives the updated plain object via `toJSON()`.
 *
 * @module filter
 */

/**
 * Valid issue state options for the state filter.
 * @type {string[]}
 */
const STATE_OPTIONS = ['open', 'closed', 'all'];

/**
 * Build a sorted, deduplicated array of label name strings from an
 * array of issue objects.
 *
 * @param {Object[]} issues
 * @returns {string[]}
 */
function extractLabels(issues) {
  const seen = new Set();
  for (const issue of issues) {
    for (const l of (issue.labels || [])) {
      const name = typeof l === 'object' ? l.name : String(l);
      if (name) seen.add(name);
    }
  }
  return Array.from(seen).sort();
}

/**
 * Build a sorted, deduplicated array of milestone title strings from
 * an array of issue objects.
 *
 * @param {Object[]} issues
 * @returns {string[]}
 */
function extractMilestones(issues) {
  const seen = new Set();
  for (const issue of issues) {
    if (issue.milestone) {
      const title = typeof issue.milestone === 'object'
        ? issue.milestone.title
        : String(issue.milestone);
      if (title) seen.add(title);
    }
  }
  return Array.from(seen).sort();
}

/**
 * FilterState — represents the current filter configuration.
 *
 * @property {string[]} availableLabels       - All labels present in the issue set
 * @property {string[]} availableMilestones   - All milestones present in the issue set
 * @property {Set<string>} activeLabels       - Labels that are toggled ON
 * @property {Set<string>} activeMilestones   - Milestones that are toggled ON
 * @property {string} activeState             - 'open' | 'closed' | 'all'
 *
 * Cursor positions (for keyboard navigation inside the filter pane):
 * @property {string} cursorSection  - 'labels' | 'milestones' | 'state'
 * @property {number} cursorIndex    - Position within the current section list
 */
class FilterState {
  /**
   * @param {Object[]} issues - Full unfiltered issue set (used to extract options)
   * @param {Object}  [persisted={}] - Hydrated from .mgw/config.json if available
   * @param {string[]} [persisted.activeLabels]
   * @param {string[]} [persisted.activeMilestones]
   * @param {string}   [persisted.activeState]
   */
  constructor(issues, persisted = {}) {
    this.availableLabels = extractLabels(issues);
    this.availableMilestones = extractMilestones(issues);

    // Restore persisted selections, clamping to what's actually available
    const pl = Array.isArray(persisted.activeLabels) ? persisted.activeLabels : [];
    const pm = Array.isArray(persisted.activeMilestones) ? persisted.activeMilestones : [];
    const ps = STATE_OPTIONS.includes(persisted.activeState) ? persisted.activeState : 'open';

    this.activeLabels = new Set(pl.filter(l => this.availableLabels.includes(l)));
    this.activeMilestones = new Set(pm.filter(m => this.availableMilestones.includes(m)));
    this.activeState = ps;

    // Navigation cursor
    this.cursorSection = 'labels';
    this.cursorIndex = 0;
  }

  // ── Cursor navigation ──────────────────────────────────────────────────────

  /**
   * The ordered list of sections shown in the filter pane.
   * @returns {string[]}
   */
  get sections() {
    return ['labels', 'milestones', 'state'];
  }

  /**
   * Number of items in the cursor's current section.
   * @returns {number}
   */
  get currentSectionLength() {
    switch (this.cursorSection) {
      case 'labels': return Math.max(this.availableLabels.length, 1);
      case 'milestones': return Math.max(this.availableMilestones.length, 1);
      case 'state': return STATE_OPTIONS.length;
      default: return 1;
    }
  }

  /**
   * Move cursor down within the current section.
   */
  cursorDown() {
    this.cursorIndex = Math.min(this.cursorIndex + 1, this.currentSectionLength - 1);
  }

  /**
   * Move cursor up within the current section.
   */
  cursorUp() {
    this.cursorIndex = Math.max(this.cursorIndex - 1, 0);
  }

  /**
   * Advance to the next section (wraps around).
   */
  nextSection() {
    const idx = this.sections.indexOf(this.cursorSection);
    this.cursorSection = this.sections[(idx + 1) % this.sections.length];
    this.cursorIndex = 0;
  }

  /**
   * Go to the previous section (wraps around).
   */
  prevSection() {
    const idx = this.sections.indexOf(this.cursorSection);
    this.cursorSection = this.sections[(idx - 1 + this.sections.length) % this.sections.length];
    this.cursorIndex = 0;
  }

  // ── Toggle actions ─────────────────────────────────────────────────────────

  /**
   * Toggle the item under the cursor.
   * For labels/milestones: toggle membership in the active set.
   * For state: cycle to the selected option.
   */
  toggleCursor() {
    switch (this.cursorSection) {
      case 'labels': {
        const label = this.availableLabels[this.cursorIndex];
        if (!label) break;
        if (this.activeLabels.has(label)) {
          this.activeLabels.delete(label);
        } else {
          this.activeLabels.add(label);
        }
        break;
      }
      case 'milestones': {
        const ms = this.availableMilestones[this.cursorIndex];
        if (!ms) break;
        if (this.activeMilestones.has(ms)) {
          this.activeMilestones.delete(ms);
        } else {
          this.activeMilestones.add(ms);
        }
        break;
      }
      case 'state': {
        this.activeState = STATE_OPTIONS[this.cursorIndex];
        break;
      }
    }
  }

  /**
   * Clear all active filters, reset state to 'open'.
   */
  clearAll() {
    this.activeLabels.clear();
    this.activeMilestones.clear();
    this.activeState = 'open';
  }

  // ── Filtering ──────────────────────────────────────────────────────────────

  /**
   * Return true if no filters are active (besides state=open which is the default).
   * @returns {boolean}
   */
  get isEmpty() {
    return this.activeLabels.size === 0 &&
           this.activeMilestones.size === 0 &&
           this.activeState === 'open';
  }

  /**
   * Apply the current filter state to an array of issues.
   *
   * Label filter: issue must have ALL selected labels.
   * Milestone filter: issue must match ANY selected milestone.
   * State filter: applied upstream by the GitHub API; in TUI mode
   *   we apply it client-side against issue.state.
   *
   * @param {Object[]} issues - Full unfiltered issue set
   * @returns {Object[]} Filtered subset
   */
  apply(issues) {
    return issues.filter(issue => {
      // State filter
      if (this.activeState !== 'all') {
        const issueState = (issue.state || 'open').toLowerCase();
        if (issueState !== this.activeState) return false;
      }

      // Label filter — issue must have ALL selected labels
      if (this.activeLabels.size > 0) {
        const issueLabels = new Set(
          (issue.labels || []).map(l => typeof l === 'object' ? l.name : String(l))
        );
        for (const required of this.activeLabels) {
          if (!issueLabels.has(required)) return false;
        }
      }

      // Milestone filter — issue must match ANY selected milestone
      if (this.activeMilestones.size > 0) {
        const ms = issue.milestone
          ? (typeof issue.milestone === 'object' ? issue.milestone.title : String(issue.milestone))
          : null;
        if (!ms || !this.activeMilestones.has(ms)) return false;
      }

      return true;
    });
  }

  // ── Serialisation ──────────────────────────────────────────────────────────

  /**
   * Return a plain object suitable for JSON persistence in .mgw/config.json.
   *
   * @returns {{activeLabels: string[], activeMilestones: string[], activeState: string}}
   */
  toJSON() {
    return {
      activeLabels: Array.from(this.activeLabels),
      activeMilestones: Array.from(this.activeMilestones),
      activeState: this.activeState,
    };
  }
}

module.exports = { FilterState, extractLabels, extractMilestones, STATE_OPTIONS };
