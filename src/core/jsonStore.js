'use strict';
const fs = require('fs');
const path = require('path');

/**
 * A JSON file written atomically (temp file + rename), so a crash never leaves it half written.
 * Each save also keeps the previous good version as <file>.bak: if the file is ever missing or
 * unreadable, the backup is used instead of starting over (settings, the API key, the library).
 */
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.restored = false;
    this.data = this.load();
  }

  read(file) {
    return { ...structuredClone(this.defaults), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  load() {
    try {
      return this.read(this.file);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      try {
        const data = this.read(`${this.file}.bak`);
        this.restored = true;
        return data;
      } catch {
        return structuredClone(this.defaults);
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    // The version being replaced becomes the backup, if it is readable (a damaged one never
    // replaces a good backup).
    try {
      JSON.parse(fs.readFileSync(this.file, 'utf8'));
      fs.copyFileSync(this.file, `${this.file}.bak`);
    } catch { /* no file yet, or unreadable: keep the backup there is */ }
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
