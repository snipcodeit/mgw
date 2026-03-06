'use strict';

/**
 * lib/plugin-loader.cjs
 *
 * Runtime loader and validator for MGW plugins.
 *
 * Plugins are directories containing a mgw-plugin.json manifest and an
 * entrypoint module. This loader:
 *   1. Validates manifests against templates/mgw-plugin-schema.json
 *   2. Discovers plugins in configured directories
 *   3. Loads validated plugins by requiring their entrypoint
 *   4. Provides a registry (Map keyed by "name:type") for O(1) lookup
 *
 * Graceful degradation: if Ajv is not installed, falls back to basic
 * structural validation so plugin loading works before npm install.
 *
 * Standard discovery directories (via getDefaultPluginDirs):
 *   - <repoRoot>/.mgw/plugins   (project-local, takes priority)
 *   - ~/.mgw/plugins             (user-global)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Ajv setup (with graceful degradation) ───────────────────────────────────

let Ajv = null;
try {
  Ajv = require('ajv');
} catch (_) {
  // Ajv not installed — will use fallback structural validation
}

const SCHEMA_PATH = path.join(__dirname, '..', 'templates', 'mgw-plugin-schema.json');

/** @type {Function|null} Compiled Ajv validator, initialized lazily */
let _compiledValidator = null;

/**
 * Load and compile the plugin manifest JSON Schema.
 * Returns null if Ajv is unavailable or schema file is missing.
 */
function _getValidator() {
  if (_compiledValidator !== null) return _compiledValidator;
  if (!Ajv) return null;

  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  } catch (err) {
    // Schema file missing or malformed — fall back to structural checks
    return null;
  }

  try {
    const ajv = new Ajv({ allErrors: true, jsonPointers: true });
    _compiledValidator = ajv.compile(schema);
    return _compiledValidator;
  } catch (_) {
    return null;
  }
}

// ─── Fallback structural validation ──────────────────────────────────────────

const REQUIRED_FIELDS = ['name', 'version', 'type', 'entrypoint'];
const VALID_TYPES = ['agent-template', 'hook', 'validator'];

/**
 * Basic structural validation used when Ajv is unavailable.
 *
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: Array<{message: string}>|null }}
 */
function _structuralValidate(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: [{ message: 'Manifest must be a JSON object' }] };
  }

  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (!manifest[field] || typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      errors.push({ message: `Required field "${field}" is missing or empty` });
    }
  }

  if (manifest.type && !VALID_TYPES.includes(manifest.type)) {
    errors.push({
      message: `Invalid plugin type "${manifest.type}". Must be one of: ${VALID_TYPES.join(', ')}`
    });
  }

  if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    errors.push({ message: `Invalid version "${manifest.version}". Must be semver format (e.g. "1.0.0")` });
  }

  if (manifest.name && !/^[a-z][a-z0-9-]*$/.test(manifest.name)) {
    errors.push({ message: `Invalid name "${manifest.name}". Must be kebab-case starting with a letter` });
  }

  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, errors: null };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate a plugin manifest object against mgw-plugin-schema.json.
 *
 * Uses Ajv schema validation when available, falls back to structural checks.
 *
 * @param {object} manifest - Parsed mgw-plugin.json content
 * @returns {{ valid: boolean, errors: Array<{message: string}>|null }}
 */
function validateManifest(manifest) {
  const validator = _getValidator();

  if (!validator) {
    return _structuralValidate(manifest);
  }

  const valid = validator(manifest);
  if (valid) {
    return { valid: true, errors: null };
  }

  // Map Ajv errors to simplified format
  const errors = (validator.errors || []).map(err => ({
    message: `${err.dataPath || 'manifest'} ${err.message}`.trim()
  }));

  return { valid: false, errors };
}

/**
 * Load a single plugin from a directory.
 *
 * Reads mgw-plugin.json, validates it, then requires the entrypoint module.
 *
 * @param {string} pluginDir - Absolute path to the plugin directory
 * @returns {{ manifest: object, plugin: object|Function, dir: string }}
 * @throws {Error} If manifest is invalid, entrypoint missing, or load fails
 */
function loadPlugin(pluginDir) {
  const manifestPath = path.join(pluginDir, 'mgw-plugin.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No mgw-plugin.json found in ${pluginDir}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse mgw-plugin.json in ${pluginDir}: ${err.message}`);
  }

  const result = validateManifest(manifest);
  if (!result.valid) {
    const errorList = (result.errors || []).map(e => e.message).join('; ');
    throw new Error(
      `Invalid plugin manifest in ${pluginDir} (plugin: "${manifest.name || 'unknown'}"): ${errorList}`
    );
  }

  const entrypointPath = path.resolve(pluginDir, manifest.entrypoint);

  // Security: ensure entrypoint is within pluginDir
  if (!entrypointPath.startsWith(path.resolve(pluginDir))) {
    throw new Error(
      `Plugin "${manifest.name}" entrypoint escapes plugin directory. Entrypoint must be a relative path within the plugin directory.`
    );
  }

  if (!fs.existsSync(entrypointPath)) {
    throw new Error(
      `Plugin "${manifest.name}" entrypoint not found: ${manifest.entrypoint} (resolved to ${entrypointPath})`
    );
  }

  let plugin;
  try {
    plugin = require(entrypointPath);
  } catch (err) {
    throw new Error(`Failed to load plugin "${manifest.name}" from ${entrypointPath}: ${err.message}`);
  }

  return { manifest, plugin, dir: pluginDir };
}

/**
 * Discover and load all plugins from one or more directories.
 *
 * Scans each directory for subdirectories containing mgw-plugin.json.
 * Invalid plugins are logged as warnings but do not abort discovery.
 *
 * @param {string[]} pluginDirs - Array of absolute directory paths to scan
 * @returns {Array<{ manifest: object, plugin: object|Function, dir: string }>}
 */
function discoverPlugins(pluginDirs) {
  const loaded = [];

  for (const dir of pluginDirs) {
    if (!fs.existsSync(dir)) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(dir, entry.name);
      const manifestPath = path.join(pluginDir, 'mgw-plugin.json');

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const loaded_plugin = loadPlugin(pluginDir);
        loaded.push(loaded_plugin);
      } catch (err) {
        // Invalid plugins are warnings, not fatal errors
        process.stderr.write(`[plugin-loader] WARNING: Skipping plugin in ${pluginDir}: ${err.message}\n`);
      }
    }
  }

  return loaded;
}

/**
 * Build a plugin registry Map from a list of loaded plugins.
 *
 * The registry is keyed by "name:type" strings, enabling O(1) lookup when
 * the pipeline checks whether a specific plugin extension point is available.
 *
 * When two plugins share the same name and type (e.g. project-local overrides
 * user-global), the last entry in the array wins. Callers should order
 * pluginDirs so project-local directories come before user-global ones — the
 * resulting discoverPlugins() array will have user-global entries first and
 * project-local entries last, so project-local plugins win.
 *
 * @param {Array<{ manifest: object, plugin: object|Function, dir: string }>} plugins
 *   Array as returned by discoverPlugins().
 * @returns {Map<string, { manifest: object, plugin: object|Function, dir: string }>}
 *   Map keyed by "name:type" (e.g. "my-validator:validator").
 */
function buildRegistry(plugins) {
  const registry = new Map();
  for (const entry of plugins) {
    const key = `${entry.manifest.name}:${entry.manifest.type}`;
    registry.set(key, entry);
  }
  return registry;
}

/**
 * Return the standard plugin discovery directories for a project.
 *
 * Always returns exactly two paths in priority order:
 *   [0] <repoRoot>/.mgw/plugins  — project-local plugins (highest priority)
 *   [1] ~/.mgw/plugins            — user-global plugins
 *
 * Neither path is required to exist — discoverPlugins() skips missing dirs.
 *
 * @param {string} repoRoot - Absolute path to the project root directory.
 * @returns {string[]} Array of two absolute directory paths.
 */
function getDefaultPluginDirs(repoRoot) {
  return [
    path.join(repoRoot, '.mgw', 'plugins'),
    path.join(os.homedir(), '.mgw', 'plugins')
  ];
}

module.exports = {
  validateManifest,
  loadPlugin,
  discoverPlugins,
  buildRegistry,
  getDefaultPluginDirs,
  // Expose schema path for consumers that need it
  SCHEMA_PATH
};
