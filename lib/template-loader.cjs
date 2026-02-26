'use strict';

const fs = require('fs');
const path = require('path');

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
 * Resolve the templates directory path.
 * @returns {string} Absolute path to templates/
 */
function getTemplatesDir() {
  return path.join(__dirname, '..', 'templates');
}

/**
 * Read and return the contents of templates/schema.json as a string.
 * Used by /mgw:project to include in the AI prompt so Claude knows the required structure.
 * @returns {string} JSON schema as a string
 */
function getSchema() {
  const schemaPath = path.join(getTemplatesDir(), 'schema.json');
  return fs.readFileSync(schemaPath, 'utf-8');
}

/**
 * Validate an AI-generated project template output.
 *
 * Accepts any string value for `type` (e.g. "game", "mobile-app", "data-pipeline") —
 * no longer restricted to web-app/cli-tool/library. AI generates the type value
 * based on the project description.
 *
 * @param {object} output - A generated template object
 * @returns {{valid: boolean, errors: Array<{field: string, error: string, suggestion: string}>}}
 */
function validate(output) {
  const errors = [];

  // a. Check type — must be a non-empty string (any value is valid)
  if (!output.type || typeof output.type !== 'string' || output.type.trim() === '') {
    errors.push({
      field: 'type',
      error: `Missing or empty type field: ${output.type}`,
      suggestion: 'Provide a descriptive type string (e.g. "game", "mobile-app", "api-service", "data-pipeline")'
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
      suggestion: 'Each milestone must have a unique name'
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

      // h. Check issues exist in each phase
      if (!Array.isArray(phase.issues) || phase.issues.length === 0) {
        errors.push({
          field: `${phasePath}.issues`,
          error: `Phase "${phase.name}" has no issues`,
          suggestion: 'Each phase must have at least one issue'
        });
      }
    }
  }

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
  node template-loader.cjs validate  (reads JSON from stdin)
  node template-loader.cjs schema    (prints templates/schema.json to stdout)

Commands:
  validate  Validate an AI-generated template from stdin
  schema    Print the templates/schema.json schema to stdout

The validate command accepts any JSON object with:
  - type: any descriptive string (game, mobile-app, api-service, data-pipeline, etc.)
  - project: { name, description }
  - milestones: array of milestones with phases and issues
`);
    process.exit(0);
  }

  if (command === 'validate') {
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

  } else if (command === 'schema') {
    try {
      console.log(getSchema());
      process.exit(0);
    } catch (err) {
      console.error(`Error reading schema: ${err.message}`);
      process.exit(1);
    }

  } else {
    console.error(JSON.stringify({
      success: false,
      errors: [{ field: 'command', error: `Unknown command: ${command}`, suggestion: 'Valid commands: validate, schema' }]
    }, null, 2));
    process.exit(1);
  }
}

module.exports = { validate, getSchema, VALID_GSD_ROUTES };
