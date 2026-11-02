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
