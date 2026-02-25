'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Valid template types
 */
const VALID_TYPES = ['web-app', 'cli-tool', 'library'];

/**
 * Valid GSD route identifiers (matching GSD workflow filenames)
 */
const VALID_GSD_ROUTES = [
  'quick',
  'plan-phase',
  'discuss-phase',
  'research-phase',
  'execute-phase',
  'verify-phase',
  'new-project',
  'new-milestone',
  'complete-milestone'
];

/**
 * Maximum number of parameters allowed
 */
const MAX_PARAMS = 5;

/**
 * Parameter names that count toward the limit
 */
const KNOWN_PARAMS = ['project_name', 'description', 'repo', 'stack', 'prefix'];

/**
 * Detect GitHub repo from git remote origin.
 * @returns {string|null} owner/repo or null if detection fails
 */
function detectRepo() {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // Handle SSH: git@github.com:owner/repo.git
    // Handle HTTPS: https://github.com/owner/repo.git
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the templates directory path.
 * @returns {string} Absolute path to templates/
 */
function getTemplatesDir() {
  return path.join(__dirname, '..', 'templates');
}

/**
 * Deep clone a JSON-serializable object.
 * @param {object} obj
 * @returns {object}
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Replace parameter placeholders in a string value.
 * Replaces {project_name}, {description}, {prefix}, {repo}, {stack}.
 * @param {string} str
 * @param {object} params - Resolved parameter values
 * @returns {string}
 */
function fillString(str, params) {
  if (typeof str !== 'string') return str;

  return str
    .replace(/\{project_name\}/g, params.project_name || '')
    .replace(/\{description\}/g, params.description || '')
    .replace(/\{prefix\}/g, params.prefix || '')
    .replace(/\{repo\}/g, params.repo || '')
    .replace(/\{stack\}/g, params.stack || '');
}

/**
 * Recursively walk a JSON structure and fill parameter placeholders in all string values.
 * @param {*} node - Current node in the JSON tree
 * @param {object} params - Resolved parameter values
 * @returns {*} Node with placeholders filled
 */
function fillRecursive(node, params) {
  if (typeof node === 'string') {
    return fillString(node, params);
  }

  if (Array.isArray(node)) {
    return node.map(item => fillRecursive(item, params));
  }

  if (node !== null && typeof node === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = fillRecursive(value, params);
    }
    return result;
  }

  return node;
}

/**
 * Check for unfilled parameter placeholders in all string values.
 * @param {*} node - Node to check
 * @param {string} path - Current JSON path for error reporting
 * @returns {Array<{field: string, error: string, suggestion: string}>}
 */
function findUnfilledPlaceholders(node, jsonPath) {
  const errors = [];
  const paramPattern = /\{(project_name|description|prefix|repo|stack)\}/g;

  if (typeof node === 'string') {
    const matches = node.match(paramPattern);
    if (matches) {
      for (const match of matches) {
        errors.push({
          field: jsonPath,
          error: `Unfilled placeholder remaining: ${match}`,
          suggestion: `Provide a value for ${match.slice(1, -1)} parameter`
        });
      }
    }
    return errors;
  }

  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      errors.push(...findUnfilledPlaceholders(item, `${jsonPath}[${i}]`));
    });
    return errors;
  }

  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      errors.push(...findUnfilledPlaceholders(value, `${jsonPath}.${key}`));
    }
  }

  return errors;
}

/**
 * Load a template, fill parameters, and validate the output.
 *
 * @param {string} templateType - One of: "web-app", "cli-tool", "library"
 * @param {object} params - Key-value pairs of parameter values
 * @returns {{success: boolean, output?: object, errors?: Array<{field: string, error: string, suggestion: string}>}}
 */
function load(templateType, params) {
  const errors = [];

  // 1. Validate template type
  if (!VALID_TYPES.includes(templateType)) {
    return {
      success: false,
      errors: [{
        field: 'templateType',
        error: `Unknown template type: ${templateType}`,
        suggestion: `Valid types: ${VALID_TYPES.join(', ')}`
      }]
    };
  }

  // 2. Count params and enforce limit
  const paramKeys = Object.keys(params || {});
  if (paramKeys.length > MAX_PARAMS) {
    return {
      success: false,
      errors: [{
        field: 'params',
        error: `Too many parameters: ${paramKeys.length} provided, maximum is ${MAX_PARAMS}`,
        suggestion: `Only ${KNOWN_PARAMS.join(', ')} are accepted`
      }]
    };
  }

  // Check for unknown parameters
  const unknownParams = paramKeys.filter(k => !KNOWN_PARAMS.includes(k));
  if (unknownParams.length > 0) {
    return {
      success: false,
      errors: unknownParams.map(k => ({
        field: k,
        error: `Unknown parameter: ${k}`,
        suggestion: `Valid parameters: ${KNOWN_PARAMS.join(', ')}`
      }))
    };
  }

  // 3. Read template file
  const templatePath = path.join(getTemplatesDir(), `${templateType}.json`);
  let template;
  try {
    const raw = fs.readFileSync(templatePath, 'utf-8');
    template = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        success: false,
        errors: [{
          field: 'templateType',
          error: `Template file not found: templates/${templateType}.json`,
          suggestion: 'Ensure templates/ directory exists with valid template files'
        }]
      };
    }
    return {
      success: false,
      errors: [{
        field: 'template',
        error: `Failed to parse template: ${err.message}`,
        suggestion: 'Check template file is valid JSON'
      }]
    };
  }

  // 4. Validate required parameters
  const resolvedParams = { ...(params || {}) };

  for (const req of template.parameters.required) {
    if (!resolvedParams[req.name] || String(resolvedParams[req.name]).trim() === '') {
      errors.push({
        field: req.name,
        error: `Required parameter missing: ${req.name}`,
        suggestion: req.description
      });
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // 5. Apply smart defaults for optional parameters
  for (const opt of template.parameters.optional) {
    if (resolvedParams[opt.name] === undefined || resolvedParams[opt.name] === null) {
      if (opt.name === 'repo' && opt.default === 'detect') {
        resolvedParams.repo = detectRepo();
      } else {
        resolvedParams[opt.name] = opt.default;
      }
    }
  }

  // 6. Deep clone and fill parameters
  const filled = deepClone(template);

  // Fill parameters throughout the structure
  filled.milestones = fillRecursive(filled.milestones, resolvedParams);

  // 7. Add project metadata
  filled.project = {
    name: resolvedParams.project_name,
    description: resolvedParams.description,
    repo: resolvedParams.repo || null,
    stack: resolvedParams.stack,
    prefix: resolvedParams.prefix
  };

  // 8. Validate the filled output
  const validation = validate(filled);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  return { success: true, output: filled };
}

/**
 * Validate a filled template output.
 *
 * @param {object} output - A filled template output object
 * @returns {{valid: boolean, errors: Array<{field: string, error: string, suggestion: string}>}}
 */
function validate(output) {
  const errors = [];

  // a. Check type
  if (!output.type || !VALID_TYPES.includes(output.type)) {
    errors.push({
      field: 'type',
      error: `Invalid or missing type: ${output.type}`,
      suggestion: `Must be one of: ${VALID_TYPES.join(', ')}`
    });
  }

  // b. Check project metadata
  if (!output.project) {
    errors.push({
      field: 'project',
      error: 'Missing project metadata',
      suggestion: 'Output must include a project object with name and description'
    });
  } else {
    if (!output.project.name || String(output.project.name).trim() === '') {
      errors.push({
        field: 'project.name',
        error: 'Project name is empty',
        suggestion: 'Provide a non-empty project_name parameter'
      });
    }
    if (!output.project.description || String(output.project.description).trim() === '') {
      errors.push({
        field: 'project.description',
        error: 'Project description is empty',
        suggestion: 'Provide a non-empty description parameter'
      });
    }
  }

  // c. Check milestones exist
  if (!Array.isArray(output.milestones) || output.milestones.length === 0) {
    errors.push({
      field: 'milestones',
      error: 'Milestones array is empty or missing',
      suggestion: 'Template must define at least one milestone'
    });
    return { valid: false, errors };
  }

  // d. Check milestone name uniqueness
  const milestoneNames = output.milestones.map(m => m.name);
  const nameSet = new Set(milestoneNames);
  if (nameSet.size !== milestoneNames.length) {
    const dupes = milestoneNames.filter((n, i) => milestoneNames.indexOf(n) !== i);
    errors.push({
      field: 'milestones',
      error: `Duplicate milestone names: ${[...new Set(dupes)].join(', ')}`,
      suggestion: 'Each milestone must have a unique name after parameter filling'
    });
  }

  // e-g. Check each milestone and phase
  for (let mi = 0; mi < output.milestones.length; mi++) {
    const milestone = output.milestones[mi];

    if (!Array.isArray(milestone.phases) || milestone.phases.length === 0) {
      errors.push({
        field: `milestones[${mi}].phases`,
        error: `Milestone "${milestone.name}" has no phases`,
        suggestion: 'Each milestone must have at least one phase'
      });
      continue;
    }

    for (let pi = 0; pi < milestone.phases.length; pi++) {
      const phase = milestone.phases[pi];
      const phasePath = `milestones[${mi}].phases[${pi}]`;

      if (typeof phase.number !== 'number' || !Number.isInteger(phase.number)) {
        errors.push({
          field: `${phasePath}.number`,
          error: `Phase number must be an integer, got: ${phase.number}`,
          suggestion: 'Use sequential integers starting from 1'
        });
      }

      if (!phase.name || String(phase.name).trim() === '') {
        errors.push({
          field: `${phasePath}.name`,
          error: 'Phase name is empty',
          suggestion: 'Each phase must have a descriptive name'
        });
      }

      if (!phase.description || String(phase.description).trim() === '') {
        errors.push({
          field: `${phasePath}.description`,
          error: 'Phase description is empty',
          suggestion: 'Each phase must have a description'
        });
      }

      if (!VALID_GSD_ROUTES.includes(phase.gsd_route)) {
        errors.push({
          field: `${phasePath}.gsd_route`,
          error: `Invalid GSD route: ${phase.gsd_route}`,
          suggestion: `Valid routes: ${VALID_GSD_ROUTES.join(', ')}`
        });
      }
    }
  }

  // h. Check for unfilled placeholders
  const placeholderErrors = findUnfilledPlaceholders(output, 'output');
  errors.push(...placeholderErrors);

  return {
    valid: errors.length === 0,
    errors
  };
}

// ── CLI Mode ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`Usage:
  node template-loader.cjs load <type> [--param value ...]
  node template-loader.cjs validate (reads JSON from stdin)

Commands:
  load      Load and fill a template
  validate  Validate a filled template from stdin

Template types: ${VALID_TYPES.join(', ')}

Parameters:
  --project_name  (required) Project name
  --description   (required) One-line project description
  --repo          (optional) GitHub repo owner/name (default: detect from git)
  --stack         (optional) Tech stack hint (default: unknown)
  --prefix        (optional) Milestone naming prefix (default: v1)
`);
    process.exit(0);
  }

  if (command === 'load') {
    const templateType = args[1];

    if (!templateType) {
      console.error(JSON.stringify({
        success: false,
        errors: [{ field: 'templateType', error: 'Template type required', suggestion: `Usage: load <${VALID_TYPES.join('|')}>` }]
      }, null, 2));
      process.exit(1);
    }

    // Parse --key value pairs
    const params = {};
    for (let i = 2; i < args.length; i += 2) {
      const key = args[i];
      const value = args[i + 1];

      if (!key.startsWith('--')) {
        console.error(JSON.stringify({
          success: false,
          errors: [{ field: 'args', error: `Expected --flag, got: ${key}`, suggestion: 'Use --param_name value format' }]
        }, null, 2));
        process.exit(1);
      }

      if (value === undefined) {
        console.error(JSON.stringify({
          success: false,
          errors: [{ field: key.slice(2), error: `Missing value for ${key}`, suggestion: `Provide a value: ${key} "your value"` }]
        }, null, 2));
        process.exit(1);
      }

      params[key.slice(2)] = value;
    }

    const result = load(templateType, params);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);

  } else if (command === 'validate') {
    // Read JSON from stdin
    let input = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      try {
        const output = JSON.parse(input);
        const result = validate(output);
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.valid ? 0 : 1);
      } catch (err) {
        console.error(JSON.stringify({
          valid: false,
          errors: [{ field: 'input', error: `Failed to parse stdin as JSON: ${err.message}`, suggestion: 'Pipe valid JSON to stdin' }]
        }, null, 2));
        process.exit(1);
      }
    });

  } else {
    console.error(JSON.stringify({
      success: false,
      errors: [{ field: 'command', error: `Unknown command: ${command}`, suggestion: 'Valid commands: load, validate' }]
    }, null, 2));
    process.exit(1);
  }
}

module.exports = { load, validate };
