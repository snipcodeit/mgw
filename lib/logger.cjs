'use strict';

/**
 * lib/logger.cjs — Structured execution logging
 *
 * Writes JSON-lines log entries to .mgw/logs/YYYY-MM-DD.jsonl.
 * Each entry records a command invocation with timing, stage, and outcome.
 *
 * Log directory is under .mgw/ which is already gitignored.
 */

const path = require('path');
const fs = require('fs');

/**
 * Get the log directory path (.mgw/logs/ under repo root).
 * Creates the directory if it doesn't exist.
 *
 * @param {string} [repoRoot] - Repository root. Defaults to cwd.
 * @returns {string} Absolute path to log directory
 */
function getLogDir(repoRoot) {
  const root = repoRoot || process.cwd();
  const logDir = path.join(root, '.mgw', 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

/**
 * Get today's log file path.
 *
 * @param {string} [repoRoot] - Repository root
 * @returns {string} Path to YYYY-MM-DD.jsonl
 */
function getLogFile(repoRoot) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getLogDir(repoRoot), `${date}.jsonl`);
}

/**
 * Write a structured log entry to today's log file.
 *
 * @param {object} entry
 * @param {string} entry.command - Command name (e.g. 'run', 'sync', 'issues')
 * @param {string} [entry.stage] - Pipeline stage at time of log
 * @param {number} [entry.issue] - Issue number if applicable
 * @param {number} [entry.duration_ms] - Command duration in milliseconds
 * @param {string} entry.status - 'ok', 'error', 'skipped'
 * @param {string} [entry.error] - Error message if status is 'error'
 * @param {string} [entry.repoRoot] - Repository root (not written to log)
 */
function writeLog(entry) {
  const { repoRoot, ...rest } = entry;
  const record = {
    timestamp: new Date().toISOString(),
    ...rest,
  };

  try {
    const logFile = getLogFile(repoRoot);
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n');
  } catch {
    // Logging failures are non-fatal — never crash the CLI
  }
}

/**
 * Create a timer that writes a log entry on completion.
 *
 * Usage:
 *   const timer = startTimer({ command: 'run', issue: 42 });
 *   // ... do work ...
 *   timer.finish('ok');
 *   // or: timer.finish('error', 'something failed');
 *
 * @param {object} entry - Partial log entry (command, stage, issue)
 * @returns {{ finish: (status: string, error?: string) => void }}
 */
function startTimer(entry) {
  const start = Date.now();
  return {
    finish(status, errorMsg) {
      writeLog({
        ...entry,
        duration_ms: Date.now() - start,
        status,
        error: errorMsg || undefined,
      });
    },
  };
}

/**
 * Read log entries, optionally filtered.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - Repository root
 * @param {string} [opts.since] - ISO date string or relative like '1d', '7d'
 * @param {number} [opts.issue] - Filter by issue number
 * @param {string} [opts.command] - Filter by command name
 * @param {string} [opts.stage] - Filter by pipeline stage
 * @param {number} [opts.limit] - Max entries to return (most recent first)
 * @returns {object[]} Array of log entries
 */
function readLogs(opts) {
  const o = opts || {};
  const logDir = getLogDir(o.repoRoot);

  if (!fs.existsSync(logDir)) return [];

  // Determine date range
  let sinceDate = null;
  if (o.since) {
    const relativeMatch = o.since.match(/^(\d+)d$/);
    if (relativeMatch) {
      sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - parseInt(relativeMatch[1], 10));
    } else {
      sinceDate = new Date(o.since);
    }
  }

  // List all .jsonl files sorted by name (date order)
  let files;
  try {
    files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort();
  } catch {
    return [];
  }

  // Filter files by date if since is specified
  if (sinceDate) {
    const sinceStr = sinceDate.toISOString().slice(0, 10);
    files = files.filter(f => f.replace('.jsonl', '') >= sinceStr);
  }

  const entries = [];

  for (const file of files) {
    const filePath = path.join(logDir, file);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      // Apply filters
      if (o.issue && entry.issue !== o.issue) continue;
      if (o.command && entry.command !== o.command) continue;
      if (o.stage && entry.stage !== o.stage) continue;

      entries.push(entry);
    }
  }

  // Most recent first
  entries.reverse();

  if (o.limit && entries.length > o.limit) {
    return entries.slice(0, o.limit);
  }

  return entries;
}

/**
 * Aggregate metrics from log entries.
 *
 * @param {object[]} entries - Array of log entries from readLogs()
 * @returns {object} Aggregated metrics
 */
function aggregateMetrics(entries) {
  if (!entries || entries.length === 0) {
    return {
      total: 0,
      byStatus: {},
      byCommand: {},
      avgDuration: 0,
      failureRate: 0,
    };
  }

  const byStatus = {};
  const byCommand = {};
  let totalDuration = 0;
  let durationCount = 0;
  let failures = 0;

  for (const e of entries) {
    // By status
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    if (e.status === 'error') failures++;

    // By command
    if (e.command) {
      if (!byCommand[e.command]) {
        byCommand[e.command] = { count: 0, errors: 0, totalDuration: 0 };
      }
      byCommand[e.command].count++;
      if (e.status === 'error') byCommand[e.command].errors++;
      if (typeof e.duration_ms === 'number') {
        byCommand[e.command].totalDuration += e.duration_ms;
      }
    }

    // Duration
    if (typeof e.duration_ms === 'number') {
      totalDuration += e.duration_ms;
      durationCount++;
    }
  }

  // Compute averages for each command
  for (const cmd of Object.keys(byCommand)) {
    const c = byCommand[cmd];
    c.avgDuration = c.count > 0 ? Math.round(c.totalDuration / c.count) : 0;
  }

  return {
    total: entries.length,
    byStatus,
    byCommand,
    avgDuration: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
    failureRate: entries.length > 0 ? Math.round((failures / entries.length) * 100) : 0,
  };
}

module.exports = {
  getLogDir,
  getLogFile,
  writeLog,
  startTimer,
  readLogs,
  aggregateMetrics,
};
