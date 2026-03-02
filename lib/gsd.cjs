'use strict';

/**
 * lib/gsd.cjs — GSD tooling bridge (backward-compat shim)
 *
 * This module is kept as a re-export shim so existing callers are not broken.
 * All implementation has moved to lib/gsd-adapter.cjs (Phase 34, issue #138).
 *
 * New code should import from gsd-adapter.cjs directly.
 */

module.exports = require('./gsd-adapter.cjs');
