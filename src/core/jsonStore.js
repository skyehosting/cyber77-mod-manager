'use strict';
const fs = require('fs');
const path = require('path');

/** A JSON file written atomically (temp file + rename), so a crash never leaves it half written. */
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ...structuredClone(this.defaults), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      return structuredClone(this.defaults);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
