'use strict';
const fs = require('fs');
const path = require('path');

/*
 * Game crashes, one per folder the game's crash reporter leaves in
 * %LOCALAPPDATA%\REDEngine\ReportQueue\Cyberpunk2077-YYYYMMDD-HHMMSS-…: stacktrace.txt (the
 * reason), report.txt (loaded modules), attch\*.txt (the game's own log) and a minidump. The dump
 * says where the crash happened: which DLL, so which mod. Each crash is put together with the
 * game-log errors and warnings from the minutes before it and the crash logs mods wrote then.
 */

const BEFORE_MS = 10 * 60e3; // game-log problems this long before a crash are part of it
const NEAR_MS = 15 * 60e3;   // mod crash logs written this close to it are too

/** The time in a crash folder's name (local time), or the folder's own time. */
function crashTime(name, full) {
  const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  try { return fs.statSync(full).mtimeMs; } catch { return 0; }
}

/** stacktrace.txt: "Error reason: …", "Expression: …", "Message: …", "File: …". */
function parseStack(text) {
  const get = k => (String(text).match(new RegExp(`^${k}:\\s*(.*)$`, 'mi')) || [])[1]?.trim() || '';
  return { reason: get('Error reason'), expression: get('Expression'), message: get('Message'), file: get('File') };
}

/**
 * The crash address and the module it is in, from a minidump (MDMP): its exception stream (6)
 * and module list (4). Reads only those parts of the file. Returns null if the dump has neither.
 */
function readDump(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
    const head = read(0, 32);
    if (head.readUInt32LE(0) !== 0x504d444d) return null; // "MDMP"
    const streams = head.readUInt32LE(8);
    const dirRva = head.readUInt32LE(12);
    const dir = read(dirRva, streams * 12);
    const find = type => { for (let i = 0; i < streams; i++) if (dir.readUInt32LE(i * 12) === type) return { size: dir.readUInt32LE(i * 12 + 4), rva: dir.readUInt32LE(i * 12 + 8) }; return null; };
    const ex = find(6);
    const ml = find(4);
    if (!ex || !ml) return null;
    const e = read(ex.rva, 40);
    const code = e.readUInt32LE(8);
    const address = e.readBigUInt64LE(24);
    const count = read(ml.rva, 4).readUInt32LE(0);
    const list = read(ml.rva + 4, Math.min(count, 2000) * 108);
    const modules = [];
    for (let i = 0; i < Math.min(count, 2000); i++) {
      const o = i * 108;
      const base = list.readBigUInt64LE(o);
      const size = BigInt(list.readUInt32LE(o + 8));
      const nameRva = list.readUInt32LE(o + 20);
      const len = read(nameRva, 4).readUInt32LE(0);
      const full = read(nameRva + 4, Math.min(len, 1024)).toString('utf16le');
      modules.push({ base, size, path: full });
    }
    const hit = modules.find(m => address >= m.base && address < m.base + m.size);
    return {
      code: `0x${code.toString(16).toUpperCase().padStart(8, '0')}`,
      address: `0x${address.toString(16).toUpperCase()}`,
      module: hit ? { name: path.win32.basename(hit.path), path: hit.path, offset: `0x${(address - hit.base).toString(16).toUpperCase()}` } : null,
      modules: modules.map(m => m.path),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

const SYSTEM_DIRS = /\\windows\\(system32|syswow64|winsxs)\\|\\windows\\microsoft\.net\\/i;

class CrashReports {
  /**
   * dir(): the ReportQueue folder. gameDir(): the game folder. gameLogs: the log monitor (its
   * entries). files: the GameFiles index (who owns a file in the game folder).
   */
  constructor({ dir, gameDir, gameLogs, files }) {
    this.dir = dir;
    this.gameDir = gameDir;
    this.gameLogs = gameLogs;
    this.files = files;
    this.cache = new Map(); // folder -> summary (a crash folder does not change)
  }

  /** Every crash, newest first, with its headline (what crashed, and in which mod). */
  list(limit = 20) {
    let names = [];
    try { names = fs.readdirSync(this.dir(), { withFileTypes: true }).filter(e => e.isDirectory() && /^Cyberpunk2077/i.test(e.name)).map(e => e.name); } catch { return []; }
    return names.map(n => ({ n, t: crashTime(n, path.join(this.dir(), n)) })).sort((a, b) => b.t - a.t).slice(0, limit).map(({ n }) => this.summary(n));
  }

  summary(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const full = path.join(this.dir(), name);
    const time = crashTime(name, full);
    let stack = {};
    try { stack = parseStack(fs.readFileSync(path.join(full, 'stacktrace.txt'), 'utf8')); } catch { /* none */ }
    const dumpFile = fs.existsSync(path.join(full, 'Cyberpunk2077.dmp')) ? path.join(full, 'Cyberpunk2077.dmp') : (fs.readdirSync(full).find(f => /\.dmp$/i.test(f)) && path.join(full, fs.readdirSync(full).find(f => /\.dmp$/i.test(f))));
    const dump = dumpFile ? readDump(dumpFile) : null;
    // Dumps name modules by file name only: find that file in the game folder to know its mod.
    // Not there (and not Windows' own): a driver's, an overlay's or another program's.
    const module = dump?.module ? this.locate(dump.module) : null;
    const out = { id: name, time, folder: full, reason: stack.reason, expression: stack.expression, message: stack.message, module, dumpSize: dumpFile ? fs.statSync(dumpFile).size : 0 };
    this.cache.set(name, out);
    return out;
  }

  /** Where a crashing module is: its file in the game folder and that file's mod, or outside it. */
  locate(m) {
    const name = path.win32.basename(m.path || m.name).toLowerCase();
    const out = { ...m, mod: '', file: '', system: SYSTEM_DIRS.test(m.path || ''), notInGame: false };
    if (/[\\/]/.test(m.path || '')) out.mod = this.ownerOf(m.path);
    try {
      const idx = this.files.index();
      const hit = idx.files.find(f => path.posix.basename(f.rel).toLowerCase() === name)
        || (/\.(exe|dll|asi)$/i.test(name) && fs.existsSync(path.join(this.gameDir(), 'bin', 'x64', name)) ? { rel: `bin/x64/${path.win32.basename(m.path || m.name)}` } : null);
      if (hit) {
        out.file = hit.rel;
        out.mod = out.mod || (name === 'cyberpunk2077.exe' ? 'the game itself' : '') || idx.own.files.get(hit.rel.toLowerCase())?.mod || (/^bin\/x64\/[^/]+$/i.test(hit.rel) ? 'the game itself, or a mod installed by hand' : 'installed by hand');
      } else out.notInGame = !out.system && !/^(ntdll|kernel32|kernelbase|ucrtbase|msvcp|vcruntime|user32|gdi32|d3d1[12]|dxgi|combase)/i.test(name);
    } catch { /* no index */ }
    return out;
  }

  /** The mod a file in the game folder belongs to (by its path), or ''. */
  ownerOf(fullPath) {
    const game = path.resolve(this.gameDir() || '');
    const p = path.resolve(fullPath || '');
    if (!game || !p.toLowerCase().startsWith(`${game.toLowerCase()}${path.sep}`)) return '';
    const rel = path.relative(game, p).replace(/\\/g, '/');
    try {
      const idx = this.files.index();
      const owned = idx.own.files.get(rel.toLowerCase());
      if (owned) return owned.mod;
      return /^bin\/x64\/[^/]+$/i.test(rel) ? 'the game itself, or a mod installed by hand' : 'installed by hand';
    } catch { return ''; }
  }

  /** Delete crash reports by id (their folders in the queue). Returns how many went. */
  remove(ids) {
    let n = 0;
    for (const id of [].concat(ids || []).map(String)) {
      if (!/^Cyberpunk2077[\w.-]*$/i.test(id)) continue;
      const full = path.join(this.dir(), id);
      try { if (!fs.statSync(full).isDirectory()) continue; fs.rmSync(full, { recursive: true, force: true }); this.cache.delete(id); n++; } catch { /* gone or in use */ }
    }
    return n;
  }

  /** Everything about one crash ('latest' or its id), for the Crashes view and the AI. */
  details(id = 'latest') {
    const all = this.list(50);
    const c = id === 'latest' ? all[0] : all.find(x => x.id === id);
    if (!c) return null;
    const read = (f, max) => { try { const t = fs.readFileSync(path.join(c.folder, f), 'utf8'); return t.length > max ? t.slice(-max) : t; } catch { return ''; } };
    // The game's own log of that session (attch\Cyberpunk2077.exe-….txt): its last lines.
    let gameLog = '';
    try {
      const att = fs.readdirSync(path.join(c.folder, 'attch')).find(f => /\.txt$/i.test(f));
      if (att) gameLog = read(path.join('attch', att), 6000).split(/\r?\n/).slice(-60).join('\n');
    } catch { /* none */ }
    // Mod DLLs that were loaded (not Windows' own).
    let loaded = [];
    const report = read('report.txt', 200000);
    loaded = [...report.matchAll(/^LoadedModule\[\d+\]=(.+)$/gm)].map(m => m[1].trim());
    const game = String(this.gameDir() || '').toLowerCase();
    const modDlls = (readDump(path.join(c.folder, 'Cyberpunk2077.dmp'))?.modules || [])
      .filter(p => game && p.toLowerCase().startsWith(game) && !/\\bin\\x64\\(cyberpunk2077\.exe|[^\\]*(physx|bink|amd_|libxe|nvngx|sl\.|icu|oo2|redlexer|redgalaxy|libcurl|dbghelp)[^\\]*)$/i.test(p))
      .map(p => ({ file: path.relative(this.gameDir(), p).replace(/\\/g, '/'), mod: this.ownerOf(p) }));
    // Game-log problems in the minutes before it.
    const before = (this.gameLogs?.entries || []).filter(e => (e.level === 'error' || e.level === 'warn') && e.time <= c.time + 60e3 && e.time >= c.time - BEFORE_MS)
      .slice(-60).map(e => ({ time: e.time, level: e.level, source: e.source, text: String(e.text).slice(0, 400) }));
    // Crash logs mods wrote around then (e.g. a plugin's Logs\crash-….txt).
    let modCrashLogs = [];
    try {
      const idx = this.files.index();
      modCrashLogs = idx.files.filter(f => /crash/i.test(path.posix.basename(f.rel)) && /\.(txt|log)$/i.test(f.rel) && Math.abs(f.mtime - c.time) < NEAR_MS)
        .slice(0, 5).map(f => {
          let text = '';
          try { text = fs.readFileSync(path.join(this.gameDir(), f.rel), 'utf8').split(/\r?\n/).slice(0, 40).join('\n'); } catch { /* gone */ }
          return { file: f.rel, mod: idx.own.files.get(f.rel.toLowerCase())?.mod || '', text };
        });
    } catch { /* no index */ }
    return { ...c, stacktrace: read('stacktrace.txt', 4000), gameLog, loadedModules: loaded.length, modDlls, problemsBefore: before, modCrashLogs };
  }
}

module.exports = { CrashReports, readDump, parseStack, crashTime };
