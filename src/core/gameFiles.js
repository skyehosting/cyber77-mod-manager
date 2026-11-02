'use strict';
const fs = require('fs');
const path = require('path');

/*
 * Read-only look into the game folder's mod files, for the AI assistant's troubleshooting: find
 * files by name, search their text, read one. Every path stays inside the game folder, and each
 * result names the mod that put the file there (this app's, Vortex's, or nobody's: by hand).
 */

// Where mods live in a Cyberpunk 2077 install.
const ROOTS = ['archive/pc/mod', 'mods', 'bin/x64/plugins', 'r6/scripts', 'r6/tweaks', 'r6/config', 'red4ext', 'engine/config'];
// Text a mod ships or writes: configs, scripts, tweaks, ArchiveXL/TweakXL yaml, logs.
const TEXT = new Set(['.xl', '.yaml', '.yml', '.lua', '.reds', '.json', '.ini', '.toml', '.txt', '.tweak', '.cfg', '.xml', '.csv', '.log', '.md', '.ws', '.script']);
const MAX_INDEX = 80000;
const MAX_SEARCH_FILES = 12000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const INDEX_MS = 30000;

const extOf = p => path.extname(p).toLowerCase();
const isText = p => TEXT.has(extOf(p));

class GameFiles {
  /** getGameDir(): the game folder. owners(): { files: Map(lower rel → {mod, by}), roots: Map(lower root → {mod, by}) }. ownerRoot(rel): a mod folder. */
  constructor({ getGameDir, owners, ownerRoot }) {
    this.getGameDir = getGameDir;
    this.owners = owners;
    this.ownerRoot = ownerRoot;
    this.cache = null;
  }

  /** Every file under the mod folders: [{ rel, size, mtime }], cached for a short while. */
  index() {
    const dir = this.getGameDir();
    if (!dir || !fs.existsSync(dir)) throw new Error('The game folder is not set or not found.');
    if (this.cache && this.cache.dir === dir && Date.now() - this.cache.at < INDEX_MS) return this.cache;
    const files = [];
    let truncated = false;
    const walk = rel => {
      let entries;
      try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (files.length >= MAX_INDEX) { truncated = true; return; }
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(r);
        else if (e.isFile()) {
          try {
            const st = fs.statSync(path.join(dir, r));
            files.push({ rel: r, size: st.size, mtime: st.mtimeMs });
          } catch { /* gone */ }
        }
      }
    };
    for (const r of ROOTS) walk(r);
    this.cache = { dir, at: Date.now(), files, truncated, own: this.owners() };
    return this.cache;
  }

  ownerOf(rel, own) {
    const hit = own.files.get(rel.toLowerCase()) || own.roots.get(this.ownerRoot(rel).toLowerCase());
    return hit ? `${hit.mod} (${hit.by})` : 'not managed: put there by hand, by a mod at runtime, or by another tool';
  }

  /** Files whose path contains every word of `name` (case-insensitive), optionally under `folder`. */
  find({ name, folder, limit = 120 }) {
    const idx = this.index();
    const words = String(name || '').toLowerCase().split(/\s+/).filter(Boolean);
    const under = String(folder || '').toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const hits = idx.files.filter(f => {
      const l = f.rel.toLowerCase();
      return (!under || l.startsWith(`${under}/`)) && words.every(w => l.includes(w));
    });
    const n = Math.min(Math.max(Number(limit) || 120, 1), 300);
    return {
      gameFolder: idx.dir, total: hits.length, shown: Math.min(n, hits.length), indexTruncated: idx.truncated || undefined,
      files: hits.slice(0, n).map(f => ({ path: f.rel, size: f.size, modified: new Date(f.mtime).toISOString(), mod: this.ownerOf(f.rel, idx.own) })),
    };
  }

  /** Lines containing `text` in the mod folders' text files (not logs unless asked for). */
  async search({ text, folder, ext, limit = 80 }) {
    const needle = String(text || '').toLowerCase();
    if (needle.length < 2) throw new Error('Give at least 2 characters to search for.');
    const idx = this.index();
    const under = String(folder || '').toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const exts = ext ? new Set(String(ext).toLowerCase().split(/[\s,]+/).filter(Boolean).map(e => (e.startsWith('.') ? e : `.${e}`))) : null;
    const pool = idx.files.filter(f => isText(f.rel) && f.size <= MAX_TEXT_BYTES &&
      (exts ? exts.has(extOf(f.rel)) : extOf(f.rel) !== '.log') &&
      (!under || f.rel.toLowerCase().startsWith(`${under}/`)));
    const n = Math.min(Math.max(Number(limit) || 80, 1), 200);
    const matches = [];
    let filesWithMatches = 0;
    let scanned = 0;
    for (const f of pool.slice(0, MAX_SEARCH_FILES)) {
      let body;
      try { body = await fs.promises.readFile(path.join(idx.dir, f.rel), 'utf8'); } catch { continue; }
      scanned++;
      if (!body.toLowerCase().includes(needle)) continue;
      filesWithMatches++;
      const lines = body.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < n; i++) {
        if (lines[i].toLowerCase().includes(needle)) matches.push({ path: f.rel, line: i + 1, text: lines[i].trim().slice(0, 240), mod: this.ownerOf(f.rel, idx.own) });
      }
    }
    return { gameFolder: idx.dir, filesSearched: scanned, filesNotSearched: Math.max(0, pool.length - MAX_SEARCH_FILES) || undefined, filesWithMatches, shown: matches.length, matches };
  }

  /** One text file, with line numbers, from `from` (1-based) for `count` lines. */
  async read({ file, from = 1, count = 200 }) {
    const idx = this.index();
    const rel = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.resolve(idx.dir, rel);
    const inside = path.relative(idx.dir, full);
    if (!rel || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Only files inside the game folder can be read (give the path relative to it).');
    const st = await fs.promises.stat(full).catch(() => null);
    if (!st?.isFile()) throw new Error(`No file at ${rel}. Use find_mod_files to get its exact path.`);
    if (st.size > MAX_TEXT_BYTES * 4) throw new Error(`${rel} is too large to read (${Math.round(st.size / 1048576)} MB).`);
    const buf = await fs.promises.readFile(full);
    if (!isText(rel) && buf.subarray(0, 8000).includes(0)) throw new Error(`${rel} is a binary file (an archive, a DLL…); only text files can be read.`);
    const lines = buf.toString('utf8').split(/\r?\n/);
    const start = Math.max(1, Math.floor(Number(from) || 1));
    const n = Math.min(Math.max(Math.floor(Number(count) || 200), 1), 400);
    const slice = lines.slice(start - 1, start - 1 + n);
    return {
      path: inside.replace(/\\/g, '/'), mod: this.ownerOf(inside.replace(/\\/g, '/'), idx.own), totalLines: lines.length,
      from: start, to: start + slice.length - 1,
      text: slice.map((l, i) => `${String(start + i).padStart(4)}| ${l.slice(0, 500)}`).join('\n'),
    };
  }
}

module.exports = { GameFiles, ROOTS };
