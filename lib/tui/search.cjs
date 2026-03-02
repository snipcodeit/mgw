'use strict';

/**
 * FuzzySearch — pure fuzzy search for arrays of objects.
 *
 * No UI dependency. Safe to require in any context.
 *
 * Scoring:
 *   100 — exact match on any key
 *    80 — prefix match
 *    60 — substring match
 *    40 — fuzzy character sequence match
 *     0 — no match (excluded from results)
 *
 * @example
 *   const fs = new FuzzySearch(issues, { keys: ['title', 'number'] });
 *   const results = fs.search('auth');
 */
class FuzzySearch {
  /**
   * @param {Object[]} items - Array of objects to search
   * @param {Object} [options={}]
   * @param {string[]} [options.keys=['title']] - Object keys to search against
   */
  constructor(items, options = {}) {
    this.items = items;
    this.keys = options.keys || ['title'];
  }

  /**
   * Search items by query string.
   *
   * @param {string} query - Search query (empty string returns all items)
   * @returns {Object[]} Matching items sorted by score descending
   */
  search(query) {
    if (!query || typeof query !== 'string' || query.trim() === '') {
      return this.items.slice();
    }

    const q = query.toLowerCase().trim();

    const scored = this.items
      .map((item) => ({ item, score: this._score(item, q) }))
      .filter(({ score }) => score > 0);

    scored.sort((a, b) => b.score - a.score);

    return scored.map(({ item }) => item);
  }

  /**
   * Score a single item against a query.
   *
   * @param {Object} item
   * @param {string} q - Lowercase trimmed query
   * @returns {number} Score (0 = no match)
   * @private
   */
  _score(item, q) {
    let max = 0;

    for (const key of this.keys) {
      const rawVal = item[key];
      const val = this._normalizeValue(rawVal);

      if (val === q) return 100;

      if (val.startsWith(q)) {
        max = Math.max(max, 80);
      } else if (val.includes(q)) {
        max = Math.max(max, 60);
      } else if (this._fuzzy(val, q)) {
        max = Math.max(max, 40);
      }
    }

    return max;
  }

  /**
   * Normalize a value to a searchable lowercase string.
   * Arrays (e.g. labels) are joined with space.
   *
   * @param {*} val
   * @returns {string}
   * @private
   */
  _normalizeValue(val) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) {
      return val
        .map((v) => (typeof v === 'object' && v !== null ? v.name || JSON.stringify(v) : String(v)))
        .join(' ')
        .toLowerCase();
    }
    return String(val).toLowerCase();
  }

  /**
   * Check if all characters of `pattern` appear in `str` in order.
   *
   * @param {string} str
   * @param {string} pattern
   * @returns {boolean}
   * @private
   */
  _fuzzy(str, pattern) {
    let pi = 0;
    for (let si = 0; si < str.length && pi < pattern.length; si++) {
      if (str[si] === pattern[pi]) pi++;
    }
    return pi === pattern.length;
  }
}

module.exports = { FuzzySearch };
