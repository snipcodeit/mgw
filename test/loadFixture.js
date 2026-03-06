/**
 * test/loadFixture.js — Fixture loader helper
 *
 * Loads JSON fixture files from test/fixtures/.
 *
 * Usage:
 *
 *   import { loadFixture } from './loadFixture.js';
 *
 *   const issueData = loadFixture('github/issue-view');
 *   const plannerOutput = loadFixture('agents/gsd-planner');
 *
 * Fixture file resolution:
 *   loadFixture('github/issue-view')  →  test/fixtures/github/issue-view.json
 *   loadFixture('agents/gsd-planner') →  test/fixtures/agents/gsd-planner.json
 *   loadFixture('my-fixture')         →  test/fixtures/my-fixture.json
 *
 * @param {string} name - Fixture name, optionally prefixed with subdirectory.
 *   Forward slashes are used as path separators (platform-independent).
 * @returns {unknown} Parsed JSON content of the fixture file.
 * @throws {Error} if the fixture file is not found.
 * @throws {Error} if the fixture file contains invalid JSON.
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the test/fixtures/ directory.
 * All fixture names are resolved relative to this directory.
 */
export const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

/**
 * Load a fixture by name and return its parsed JSON content.
 *
 * @param {string} name - Fixture identifier, e.g. 'github/issue-view' or 'agents/gsd-planner'
 * @returns {unknown} Parsed JSON value — may be an object, array, string, number, or boolean.
 */
export function loadFixture(name) {
  // Normalize forward slashes to platform path separator
  const normalizedName = name.split('/').join(path.sep);
  const fixturePath = path.resolve(FIXTURES_DIR, `${normalizedName}.json`);

  if (!fs.existsSync(fixturePath)) {
    throw new Error(
      `loadFixture: fixture not found: "${name}"\n` +
      `  Looked for: ${fixturePath}\n` +
      `  Fixtures directory: ${FIXTURES_DIR}`
    );
  }

  const raw = fs.readFileSync(fixturePath, 'utf-8').trim();

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadFixture: fixture "${name}" is not valid JSON (${fixturePath}): ${err.message}`,
      { cause: err }
    );
  }
}
