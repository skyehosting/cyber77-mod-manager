'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/** Collects log lines, mirrors them to a file and pushes them to the UI console. */
class Logger extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.max = 2000;
    this.file = null;
    // What the app did, kept across restarts (JSON lines). Debug lines are not kept.
    this.history = [];
    this.historyFile = null;
    this.historyMax = 3000;
  }

  /** Load the kept history and append to it from now on. The file is trimmed when it grows. */
  setHistory(file) {
    this.historyFile = file;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const keep = lines.slice(-this.historyMax);
      this.history = keep.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (lines.length > this.historyMax * 2) fs.writeFileSync(file, `${keep.join('\n')}\n`);
    } catch { /* no history yet */ }
  }

  setFile(file) {
    this.file = file;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  }

  log(level, message, detail) {
    const entry = { time: Date.now(), level, message: String(message) };
    if (detail !== undefined) {
      entry.detail = detail instanceof Error ? (detail.stack || detail.message) : String(detail);
    }
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    this.emit('entry', entry);
    if (level !== 'debug') {
      this.history.push(entry);
      if (this.history.length > this.historyMax) this.history.shift();
      if (this.historyFile) fs.appendFile(this.historyFile, `${JSON.stringify(entry)}\n`, () => {});
    }
    const line = `[${new Date(entry.time).toISOString()}] ${level.toUpperCase()} ${entry.message}${entry.detail ? `\n  ${entry.detail}` : ''}\n`;
    if (level === 'error') process.stderr.write(line); else process.stdout.write(line);
    if (this.file) fs.appendFile(this.file, line, () => {});
  }

  info(m, d) { this.log('info', m, d); }
  warn(m, d) { this.log('warn', m, d); }
  error(m, d) { this.log('error', m, d); }
  success(m, d) { this.log('success', m, d); }
  debug(m, d) { this.log('debug', m, d); }
}

module.exports = { Logger, logger: new Logger() };
