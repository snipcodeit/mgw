'use strict';

/**
 * lib/templates.cjs — Re-export of template-loader.cjs
 *
 * Provides a consistent module boundary so callers can import
 * template functionality from lib/ without knowing the internal
 * loader implementation.
 */

const { validate, getSchema, VALID_GSD_ROUTES } = require('./template-loader.cjs');

module.exports = { validate, getSchema, VALID_GSD_ROUTES };
