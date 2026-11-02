'use strict';
const fs = require('fs');
const path = require('path');
const { listFiles } = require('./vortexDeploy');

/*
 * The Mod config page: every mod's files (this app's, Vortex's, and files no mod manager put in
 * the game folder), read and saved by the built-in editor.
 *
 * A file is addressed by a location { base, id, rel }:
 *   base 'game'   - in the game folder (what the game loads)
 *   base 'app'    - this app's stored copy of a mod (a disabled mod, or a file another mod wins)
 *   base 'vortex' - Vortex's stored copy of one of its mods
 * Paths never leave their base folder. Saving writes in place, so a hardlinked file stays linked,
 * and the first save keeps the original in the app's own folder, never where the game loads it.
 */

const TEXT_EXT = new Set(['.reds', '.lua', '.json', '.yaml', '.yml', '.xl', '.ini', '.toml', '.cfg', '.conf', '.env', '.properties', '.settings', '.config',
  '.txt', '.log', '.xml', '.csv', '.md', '.tweak', '.ws', '.script', '.js', '.mjs', '.ts', '.py', '.bat', '.cmd', '.ps1', '.html', '.css']);
const MAX_OPEN = 5 * 1024 * 1024;
const READ_ONLY_OVER = 2 * 1024 * 1024;

// Folders that hold many mods' loose files: never joined to a mod by name.
const GENERIC_ROOTS = new Set(['archive/pc/mod', 'r6/config', 'r6/scripts', 'r6/tweaks', 'red4ext', 'red4ext/plugins', 'bin/x64/plugins', 'bin/x64/plugins/cyber_engine_tweaks', 'mods', 'engine/config', 'engine/config/platform', 'engine/config/platform/pc']);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const extOf = p => path.extname(p).toLowerCase();
const isTextName = p => TEXT_EXT.has(extOf(p)) || /(^|\/)\.env$/i.test(p);

/** Which folder group a file nobody manages belongs to: a mod's own folder, or its place. */
function handRoot(rel, ownerRoot) {
  const own = ownerRoot(rel);
  if (own) return own;
  const p = rel.split('/');
  const low = rel.toLowerCase();
  if (/^r6\/(scripts|tweaks)\/[^/]+\//.test(low)) return p.slice(0, 3).join('/');
  if (/^bin\/x64\/plugins\/cyber_engine_tweaks\//.test(low)) return 'bin/x64/plugins/cyber_engine_tweaks';
  if (/^red4ext\//.test(low)) return 'red4ext';
  return p.slice(0, Math.min(p.length - 1, 3)).join('/') || rel;
}

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), bom: 'utf16le' };
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), bom: 'utf8' };
  return { text: buf.toString('utf8'), bom: '' };
}
function encode(text, bom) {
  if (bom === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (bom === 'utf8') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

class ModConfig {
  /**
   * manager: the mod manager (its mods, deployer, Vortex bridge, settings).
   * files: the GameFiles index of the game's mod folders. ownerRoot(rel): a mod's own folder.
   * backupDir: where originals are kept before the first save.
   */
  constructor({ manager, files, ownerRoot, backupDir }) {
    this.manager = manager;
    this.files = files;
    this.ownerRoot = ownerRoot;
    this.backupDir = backupDir;
  }

  gameDir() { return this.manager.gameDir(); }

  vortexStaging() { return path.join(this.manager.vortex.root, 'cyberpunk2077', 'mods'); }

  /** The folder a location's path is relative to. */
  root(loc) {
    if (loc.base === 'game') return this.gameDir();
    if (loc.base === 'app' && /^[\w.-]+$/.test(String(loc.id))) return path.join(this.manager.settings.stagingDir, loc.id);
    if (loc.base === 'vortex' && loc.id && !/[\\/]|\.\./.test(String(loc.id))) return path.join(this.vortexStaging(), loc.id);
    throw new Error('Unknown file location.');
  }

  /** The full path of a location, never outside its base folder. */
  resolve(loc) {
    const base = this.root(loc || {});
    const rel = String(loc.rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.resolve(base, rel);
    const inside = path.relative(base, full);
    if (!rel || !inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('That file is outside the mod folders.');
    return full;
  }

  /** Every mod with its state, plus folders of files no mod manager put there. */
  /**
   * Every mod once, each with its copies ("parts"): this app's, Vortex's (the copy Vortex keeps
   * after a move, or the same mod installed there too) and folders no mod manager put there.
   * Parts belong together when they are linked (moved from Vortex, the same Nexus file) or share
   * a name ("AiNpcCyberpunkMod" in a CET folder and in a RED4ext folder).
   */
  list() {
    const parts = [];
    const appByVortex = new Map(); // vortexId -> app part (moved from Vortex, or the same file)
    for (const m of Object.values(this.manager.data.mods)) {
      const p = { key: `app:${m.id}`, name: m.name, modName: m.modName || '', version: m.version || '', enabled: !!m.enabled, source: 'app', type: m.type || '', fileCount: m.files.length };
      parts.push(p);
      if (m.fromVortex) appByVortex.set(m.fromVortex, p);
    }
    let vx = { mods: [] };
    try { vx = this.manager.vortex.read(); } catch { /* no Vortex */ }
    const adopted = this.manager.data.vortexAdopted || {};
    let twins = {};
    try { twins = this.manager.vortexTwins(vx); } catch { /* none */ }
    const appPart = id => parts.find(p => p.key === `app:${id}`);
    for (const v of vx.mods || []) {
      const ownId = adopted[v.vortexId] || twins[v.vortexId];
      const own = appByVortex.get(v.vortexId) || (ownId && appPart(ownId));
      if (own && !v.fileCount) continue; // nothing left in Vortex's copy
      parts.push({
        key: `vx:${v.vortexId}`, name: v.name, modName: v.modName || '', version: v.version || '', enabled: !!v.enabled, source: 'vortex', type: v.type || '', fileCount: v.fileCount || 0,
        linkedTo: own?.key || '', note: own ? (v.enabled ? 'Also enabled in Vortex' : 'Kept by Vortex, switched off') : '',
      });
    }
    try {
      const counts = new Map();
      for (const f of this.unmanaged()) {
        const r = handRoot(f.rel, this.ownerRoot);
        counts.set(r, (counts.get(r) || 0) + 1);
      }
      for (const [root, n] of counts) parts.push({ key: `hand:${root}`, name: root.split('/').pop(), folder: root, enabled: true, source: 'hand', type: '', fileCount: n });
    } catch { /* no game folder */ }

    // Group: links first, then names.
    const parent = new Map(parts.map(p => [p.key, p.key]));
    const find = k => { while (parent.get(k) !== k) k = parent.get(k); return k; };
    const join = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent.set(y, x); };
    for (const p of parts) if (p.linkedTo) join(p.linkedTo, p.key);
    const byName = new Map();
    for (const p of parts) {
      if (p.source === 'hand' && GENERIC_ROOTS.has(p.folder.toLowerCase())) continue;
      for (const n of new Set([p.name, p.modName].map(norm).filter(n => n.length >= 4))) {
        if (byName.has(n)) join(byName.get(n), p.key); else byName.set(n, p.key);
      }
    }
    const groups = new Map();
    for (const p of parts) {
      const g = find(p.key);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    const RANK = { app: 0, vortex: 1, hand: 2 };
    const out = [...groups.values()].map(list => {
      list.sort((a, b) => RANK[a.source] - RANK[b.source] || a.name.localeCompare(b.name));
      const main = list[0];
      return {
        key: main.key, name: main.name, version: main.version || '', enabled: main.enabled, source: main.source, folder: main.folder, type: main.type,
        fileCount: list.reduce((n, p) => n + p.fileCount, 0),
        parts: list.map(({ modName, linkedTo, ...p }) => p),
      };
    });
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** For each other copy of a file: does it exist, and is it the same file on disk (hardlinked)? */
  twins(loc, others) {
    const id = l => { const st = fs.statSync(this.resolve(l), { bigint: true }); return `${st.dev}:${st.ino}`; };
    const mine = id(loc);
    return others.map(o => {
      try { return { exists: true, linked: id(o) === mine }; } catch { return { exists: false, linked: false }; }
    });
  }

  /** Save text into another copy of a file, in that copy's own line endings and encoding. */
  writeLike(loc, text) {
    const cur = this.read(loc);
    return this.write(loc, text, { mtime: cur.mtime, eol: cur.eol, bom: cur.bom });
  }

  /** Game-folder files that neither this app nor Vortex placed, and that are in no mod's own folder. */
  unmanaged() {
    const idx = this.files.index();
    return idx.files.filter(f => !idx.own.files.has(f.rel.toLowerCase()) && !idx.own.roots.has(this.ownerRoot(f.rel).toLowerCase()));
  }

  /** Files in the game folder under a mod's own folders that the mod did not ship (it made them: settings, logs). */
  madeBy(roots, shipped) {
    if (!roots.size) return [];
    const idx = this.files.index();
    return idx.files.filter(f => roots.has(this.ownerRoot(f.rel).toLowerCase()) && !shipped.has(f.rel.toLowerCase()));
  }

  entry(loc, size, note = '') {
    return { loc, rel: loc.rel, size, editable: isTextName(loc.rel) && size <= MAX_OPEN, note };
  }

  sizeOf(loc) {
    try { return fs.statSync(this.resolve(loc)).size; } catch { return -1; }
  }

  /** One mod's files: where each one is (game folder or stored copy), its size, whether it can be edited. */
  modFiles(key) {
    const [kind, ...rest] = String(key).split(':');
    const id = rest.join(':');
    const out = [];
    if (kind === 'app') {
      const m = this.manager.data.mods[id];
      if (!m) throw new Error('That mod is no longer installed.');
      const owners = this.manager.deployer.owners();
      const shipped = new Set(m.files.map(f => f.toLowerCase()));
      for (const rel of m.files) {
        const inGame = m.enabled && owners[rel.toLowerCase()] === id;
        const loc = inGame ? { base: 'game', rel } : { base: 'app', id, rel };
        out.push(this.entry(loc, this.sizeOf(loc), inGame ? '' : m.enabled ? 'Another mod\'s copy is in the game; this is this mod\'s stored copy' : 'Stored copy: the mod is disabled'));
      }
      const roots = new Set(m.files.map(f => this.ownerRoot(f).toLowerCase()).filter(Boolean));
      for (const f of this.madeBy(roots, shipped)) out.push(this.entry({ base: 'game', rel: f.rel }, f.size, 'Made by the mod'));
      return { name: m.name, files: out };
    }
    if (kind === 'vx') {
      const vx = this.manager.vortex.read();
      const v = (vx.mods || []).find(x => x.vortexId === id);
      if (!v) throw new Error('That Vortex mod is no longer there.');
      const deployed = v.deployedFiles || [];
      const all = deployed.length ? deployed : listFiles(path.join(this.vortexStaging(), id)).map(p => p.replace(/\\/g, '/'));
      const shipped = new Set(all.map(f => f.toLowerCase()));
      for (const rel of all) {
        const loc = deployed.length ? { base: 'game', rel } : { base: 'vortex', id, rel };
        out.push(this.entry(loc, this.sizeOf(loc), deployed.length ? '' : 'Vortex\'s stored copy: the mod is disabled'));
      }
      const roots = new Set(all.map(f => this.ownerRoot(f).toLowerCase()).filter(Boolean));
      for (const f of this.madeBy(roots, shipped)) out.push(this.entry({ base: 'game', rel: f.rel }, f.size, 'Made by the mod'));
      return { name: v.name, files: out, vortex: true };
    }
    if (kind === 'hand') {
      for (const f of this.unmanaged()) if (handRoot(f.rel, this.ownerRoot) === id) out.push(this.entry({ base: 'game', rel: f.rel }, f.size));
      return { name: id.split('/').pop(), files: out };
    }
    throw new Error('Unknown mod.');
  }

  backupPath(loc) {
    return path.join(this.backupDir, loc.base, loc.base === 'game' ? '' : String(loc.id), ...String(loc.rel).split('/'));
  }

  /** A file's text for the editor: line endings and encoding are kept to write it back the same way. */
  read(loc) {
    const full = this.resolve(loc);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error('That is not a file.');
    if (st.size > MAX_OPEN) throw new Error(`This file is too large to open here (${Math.round(st.size / 1048576)} MB).`);
    const buf = fs.readFileSync(full);
    const { text, bom } = decode(buf);
    if (bom !== 'utf16le' && buf.subarray(0, 8000).includes(0)) throw new Error('This is a binary file, not text.');
    return {
      text: text.replace(/\r\n/g, '\n'), eol: text.includes('\r\n') ? '\r\n' : '\n', bom, mtime: st.mtimeMs, size: st.size,
      readOnly: st.size > READ_ONLY_OVER, hasBackup: fs.existsSync(this.backupPath(loc)), full,
    };
  }

  /**
   * Save the editor's text. `mtime` is when the editor read it: if the file changed since (the mod
   * or the game wrote it), nothing is written unless `force`. Returns the new mtime.
   */
  write(loc, text, { mtime, eol = '\n', bom = '', force = false } = {}) {
    const full = this.resolve(loc);
    const st = fs.statSync(full);
    if (!force && mtime && Math.abs(st.mtimeMs - mtime) > 1) {
      throw Object.assign(new Error('The file changed on disk since you opened it.'), { conflict: true });
    }
    const keep = this.backupPath(loc);
    if (!fs.existsSync(keep)) {
      fs.mkdirSync(path.dirname(keep), { recursive: true });
      fs.copyFileSync(full, keep);
    }
    // Written in place (not replaced), so hardlinks to Vortex's or this app's stored copy stay linked.
    fs.writeFileSync(full, encode(String(text).replace(/\r\n/g, '\n').replace(/\n/g, eol), bom));
    return { mtime: fs.statSync(full).mtimeMs, hasBackup: true };
  }

  /** Put back the file as it was before its first save here. */
  restore(loc) {
    const keep = this.backupPath(loc);
    if (!fs.existsSync(keep)) throw new Error('There is no original kept for this file.');
    fs.writeFileSync(this.resolve(loc), fs.readFileSync(keep));
    return this.read(loc);
  }
}

module.exports = { ModConfig, handRoot, isTextName, TEXT_EXT };
