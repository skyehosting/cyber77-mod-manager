'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

/*
 * Follows every log the game and its mods write — CET and its mods, RED4ext and its plugins,
 * redscript, ArchiveXL, TweakXL, Codeware, Input Loader, ReShade, … — and merges them into one
 * timeline. Logs are found by scanning the game folder, so new mods' logs show up on their own.
 * Rotated logs (one file per session, e.g. `red4ext-2026-11-01-20-39-42.log`) are grouped and only
 * the newest file of each group is followed.
 */

const SCAN_ROOTS = ['bin/x64', 'red4ext', 'r6/logs', 'r6/cache', 'engine', 'tools', 'mods'];
const MAX_DEPTH = 6;
const TAIL_BYTES = 64 * 1024;
const HISTORY_MS = 24 * 3600 * 1000; // on start, show the last day of each log
const MAX_ENTRIES = 8000;
const STALE_MS = 3 * 24 * 3600 * 1000; // ignore logs not written for 3 days
const GAME_EXE = 'Cyberpunk2077.exe';

const LEVEL_WORDS = [
  [/^(critical|crit|fatal)$/i, 'error'],
  [/^(error|err)$/i, 'error'],
  [/^(warning|warn)$/i, 'warn'],
  [/^(info|information|notice|success)$/i, 'info'],
  [/^(debug|trace|verbose)$/i, 'debug'],
];

// A date (and optional time) stamp in a file name, in any of the usual separators.
const STAMP = /[-_ .]?r?\d{4}[-_.]?\d{2}[-_.]?\d{2}(?:[-_ t.]?\d{2}[-_:.]?\d{2}(?:[-_:.]?\d{2})?)?/gi;

/** Group key for rotated logs: drop date/time stamps and redscript's run suffix. */
function groupKey(rel) {
  return rel.toLowerCase()
    .replace(STAMP, '')
    .replace(/_rcurrent/g, '')
    .replace(/\.previous\d*/g, '')
    .replace(/-(exit|crash|hang)\b/g, '');
}

/**
 * Whether a file is a log: *.log, *log.txt (REDmod's REDmodLog.txt), or a crash/error/log .txt in a
 * mod's logs folder (crash reports such as AppearanceRuntimePlugin/Logs/crash-….txt).
 */
function isLogFile(dir, name) {
  if (/\.log(\.txt)?$|log\.txt$/i.test(name)) return true;
  return /(^|\/)logs?$/i.test(dir) && /\.txt$/i.test(name) && /log|crash|error/i.test(name);
}

// Looking for logs a mod writes anywhere: how often while the game runs, and what is never one.
const DISCOVER_MS = 30000;
const SKIP_DIRS = new Set(['archive/pc/content', 'archive/pc/ep1', 'r6/cache']);
const NOT_LOGS = /^(readme|read me|license|licence|notice|third[-_ ]party|changelog|change log|credits|modlist)/i;

/**
 * Could this file be a log some mod writes? Text-like names (.log, .txt, .out, .err) or anything
 * in a logs folder; never readmes, licences or the archive mod list this app writes.
 */
function mayBeLog(dir, name) {
  if (NOT_LOGS.test(name) || /\.(zip|7z|rar|dmp|png|jpe?g|dds|dll|exe|archive|bin|sqlite3?|db)$/i.test(name)) return false;
  return isLogFile(dir, name) || /\.(txt|out|err)$/i.test(name) || /(^|\/)logs?$/i.test(dir);
}

/** A text file: no NUL bytes at its start (a UTF-16 log starts with its byte-order mark). */
function isText(full) {
  try {
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n);
    return (head[0] === 0xff && head[1] === 0xfe) || !head.includes(0);
  } catch {
    return false;
  }
}

/** A short, human name for where a log comes from. */
function sourceName(rel) {
  const p = rel.replace(/\\/g, '/');
  const lower = p.toLowerCase();
  const file = path.posix.basename(p).replace(/\.log(\.txt)?$|\.txt$/i, '');
  const clean = s => s.replace(STAMP, '').replace(/[-_]rCURRENT$/i, '').replace(/\.previous\d*$/i, '').replace(/[-_ .]+$/, '') || s;
  let m = lower.match(/^bin\/x64\/plugins\/cyber_engine_tweaks\/mods\/([^/]+)\//);
  if (m) {
    const folder = p.split('/')[5];
    const sub = clean(file);
    return sub.toLowerCase() === folder.toLowerCase() ? `CET · ${folder}` : `CET · ${folder} · ${sub}`;
  }
  if (lower.startsWith('bin/x64/plugins/cyber_engine_tweaks/')) {
    if (file === 'scripting') return 'CET scripting';
    if (file === 'cyber_engine_tweaks') return 'CET';
    return `CET · ${file}`;
  }
  if (lower.startsWith('r6/logs/redscript')) return 'redscript';
  m = lower.match(/^red4ext\/plugins\/([^/]+)\//);
  if (m) {
    const plugin = p.split('/')[2];
    const sub = clean(file);
    return sub.toLowerCase().startsWith(plugin.toLowerCase().slice(0, 5)) ? plugin : `${plugin} · ${sub}`;
  }
  if (lower.startsWith('red4ext/logs/')) {
    const n = clean(file);
    return n.toLowerCase() === 'red4ext' ? 'RED4ext' : n;
  }
  if (lower === 'red4ext/red4ext.log') return 'RED4ext';
  if (lower.startsWith('mods/')) return `REDmod · ${p.split('/')[1]}`;
  if (lower.startsWith('tools/redmod/')) return 'REDmod deploy';
  if (lower.startsWith('tools/')) return clean(file);
  return clean(file).replace(/-[0-9A-F]{12,}$/i, '');
}

/** The folder of the mod that owns this log, for linking problems to installed mods. */
function ownerRoot(rel) {
  const parts = rel.replace(/\\/g, '/').split('/');
  const lower = parts.map(s => s.toLowerCase());
  if (lower.slice(0, 5).join('/') === 'bin/x64/plugins/cyber_engine_tweaks/mods' && parts[5]) return parts.slice(0, 6).join('/');
  if (lower[0] === 'red4ext' && lower[1] === 'plugins' && parts[2]) return parts.slice(0, 3).join('/');
  if (lower[0] === 'mods' && parts[1]) return parts.slice(0, 2).join('/');
  return '';
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Parse one log line. Recognises the common formats:
 *   [2026-11-01 20:39:42.103] [info    ] [ 58348] [RED4ext] text      (spdlog: RED4ext, ArchiveXL, …)
 *   [2026-10-28 00:14:27 UTC-04:00] [info] [func] [47492] text         (CET)
 *   [INFO - Sun, 1 Nov 2026 20:39:51 -0500] text                       (redscript)
 *   [20:39:42.099] text                                                (time only)
 * Returns { time|null, level|null, text } — text without the stamp, level and thread brackets.
 */
function parseLine(line, fileDate) {
  let rest = line;
  let time = null;
  let level = null;
  let m = rest.match(/^\[(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?(?: ?UTC([+-]\d{2}):?(\d{2}))?\]\s*/);
  if (m) {
    const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
    if (m[8]) {
      const off = (Number(m[8]) * 60 + Math.sign(Number(m[8]) || 1) * Number(m[9])) * 60000;
      time = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms) - off;
    } else {
      time = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
    }
    rest = rest.slice(m[0].length);
  } else if ((m = rest.match(/^\[(\w+)\s*-\s*\w{3},\s*(\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\]\s*/))) {
    level = m[1];
    const off = (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) * 60000;
    time = Date.UTC(+m[4], MONTHS[m[3].toLowerCase()] ?? 0, +m[2], +m[5], +m[6], +m[7]) - off;
    rest = rest.slice(m[0].length);
  } else if ((m = rest.match(/^\[(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\]\s*/))) {
    const d = new Date(fileDate || Date.now());
    d.setHours(+m[1], +m[2], +m[3], m[4] ? Number(m[4].padEnd(3, '0')) : 0);
    time = d.getTime();
    rest = rest.slice(m[0].length);
  }
  // Leading bracket groups: a level word, a thread id, or a function signature (dropped).
  for (let i = 0; i < 4; i++) {
    const b = rest.match(/^\[\s*([^\]]{1,120}?)\s*\]\s*/);
    if (!b) break;
    const inner = b[1];
    const lw = LEVEL_WORDS.find(([re]) => re.test(inner));
    if (lw && !level) { level = inner; rest = rest.slice(b[0].length); continue; }
    if (/^\d+$/.test(inner) || /__cdecl|__thiscall|\(.*\)/.test(inner)) { rest = rest.slice(b[0].length); continue; }
    break;
  }
  let norm = null;
  if (level) {
    const lw = LEVEL_WORDS.find(([re]) => re.test(level));
    norm = lw ? lw[1] : null;
  }
  if (!norm) {
    // No explicit level: judge by wording. Whole words only, so "ShowPauseWarning" is not a warning.
    // Counters such as "failure=0" or "0 errors" are not problems.
    const words = rest.replace(/\b\w+\s*[=:]\s*0\b/g, '').replace(/\b(no|0)\s+(errors?|warnings?|failures?)\b/gi, '');
    if (/\b(error|exception|failed|failure|fatal|crash(ed)?|unhandled|access violation)\b/i.test(words)) norm = 'error';
    else if (/\b(warning|warn|deprecated|incompatible|missing)\b/i.test(words)) norm = 'warn';
  }
  return { time, level: norm, text: rest };
}

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

class GameLogMonitor extends EventEmitter {
  /** knownFile: where logs found by watching a game run are remembered (followed on every start). */
  constructor({ getGameDir, log, crashDir, knownFile = '' }) {
    super();
    this.getGameDir = getGameDir;
    this.log = log;
    this.crashDir = crashDir;
    this.knownFile = knownFile;
    this.found = new Set();
    try { for (const r of JSON.parse(fs.readFileSync(knownFile, 'utf8')).logs || []) this.found.add(r); } catch { /* none yet */ }
    this.baseline = null; // rel -> size of every possible log when the game started
    this.discovering = false;
    this.files = new Map(); // rel -> { rel, full, source, root, offset, size, mtime, followed, errors, warns, partial }
    this.entries = [];
    this.nextId = 1;
    this.pending = [];
    this.game = { running: false, since: null, pid: null };
    this.timers = [];
    this.knownCrashes = new Set();
  }

  start() {
    this.scan(true);
    this.pollFiles();
    this.timers.push(setInterval(() => this.scan(false), 5000));
    this.timers.push(setInterval(() => this.pollFiles(), 1000));
    this.timers.push(setInterval(() => this.checkGame(), 3000));
    this.timers.push(setInterval(() => this.flush(), 300));
    this.timers.push(setInterval(() => { if (this.game.running) this.discover(); }, DISCOVER_MS));
    this.checkGame();
    this.snapshotCrashes();
  }

  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  /** Restart from scratch (e.g. the game folder changed). */
  reset() {
    this.files.clear();
    this.entries = [];
    this.pending = [];
    this.scan(true);
    this.emit('reset');
  }

  findLogs(gameDir) {
    const out = [];
    const walk = (rel, depth) => {
      let ents;
      try { ents = fs.readdirSync(path.join(gameDir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (depth < MAX_DEPTH) walk(r, depth + 1); } else if (isLogFile(rel, e.name)) out.push(r);
      }
    };
    for (const root of SCAN_ROOTS) walk(root, 0);
    const have = new Set(out.map(r => r.toLowerCase()));
    for (const r of this.found) if (!have.has(r.toLowerCase()) && fs.existsSync(path.join(gameDir, r))) out.push(r);
    return out;
  }

  /**
   * Every file in the whole install that could be a log (see mayBeLog), with its size. Walks the
   * folder without blocking; the game's own content archives are skipped.
   */
  async possibleLogs(gameDir) {
    const sizes = new Map();
    const walk = async rel => {
      let ents;
      try { ents = await fs.promises.readdir(rel ? path.join(gameDir, rel) : gameDir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(r.toLowerCase())) await walk(r); } else if (e.isFile() && mayBeLog(rel, e.name)) {
          try { sizes.set(r, (await fs.promises.stat(path.join(gameDir, r))).size); } catch { /* gone */ }
        }
      }
    };
    await walk('');
    return sizes;
  }

  /**
   * While the game runs: a text file that appeared or grew since it started is a log some mod writes,
   * wherever it is. Follow it from now on, and remember it for later starts.
   */
  async discover() {
    const gameDir = this.getGameDir();
    if (this.discovering || !this.baseline || !gameDir) return;
    this.discovering = true;
    try {
      const now = await this.possibleLogs(gameDir);
      const followed = new Set([...this.files.keys()].map(r => r.toLowerCase()));
      const fresh = [];
      for (const [rel, size] of now) {
        if (followed.has(rel.toLowerCase()) || this.found.has(rel)) continue;
        const before = this.baseline.get(rel);
        if (size > 0 && (before === undefined || size > before) && isText(path.join(gameDir, rel))) fresh.push(rel);
      }
      if (!fresh.length) return;
      for (const rel of fresh) {
        this.found.add(rel);
        this.note('info', `Found a new log, written while the game ran: ${rel}. Following it from now on.`, 'Logs');
      }
      if (this.knownFile) {
        try { fs.writeFileSync(this.knownFile, JSON.stringify({ logs: [...this.found].sort() }, null, 1)); } catch (err) { this.log.warn('Could not remember the new logs', err.message); }
      }
      this.scan(false);
    } finally {
      this.discovering = false;
    }
  }

  scan(initial) {
    const gameDir = this.getGameDir();
    if (!gameDir || !fs.existsSync(gameDir)) return;
    const found = this.findLogs(gameDir);
    const groups = new Map();
    for (const rel of found) {
      let st;
      try { st = fs.statSync(path.join(gameDir, rel)); } catch { continue; }
      const key = groupKey(rel);
      const cur = groups.get(key);
      if (!cur || st.mtimeMs > cur.st.mtimeMs) groups.set(key, { rel, st });
      if (!this.files.has(rel)) {
        this.files.set(rel, {
          rel, full: path.join(gameDir, rel), source: sourceName(rel), root: ownerRoot(rel),
          offset: 0, size: st.size, mtime: st.mtimeMs, followed: false, errors: 0, warns: 0, partial: '',
        });
      }
    }
    for (const [rel, f] of this.files) if (!found.includes(rel)) this.files.delete(rel);
    // Follow only the newest file of each rotation group, and only recent ones.
    const newest = new Set([...groups.values()].map(g => g.rel));
    for (const f of this.files.values()) {
      const shouldFollow = newest.has(f.rel) && Date.now() - f.mtime < STALE_MS;
      if (shouldFollow && !f.followed) {
        f.followed = true;
        // Existing logs: start from their tail. Logs created after we started: read from the top.
        f.offset = initial || f.size > TAIL_BYTES ? Math.max(0, f.size - TAIL_BYTES) : 0;
        f.skipFirst = f.offset > 0;
        f.firstRead = initial;
        if (!initial) this.note('info', `Now following ${f.rel}`, 'Logs');
      } else if (!shouldFollow) {
        f.followed = false;
      }
    }
  }

  pollFiles() {
    for (const f of this.files.values()) {
      if (!f.followed) continue;
      let st;
      try { st = fs.statSync(f.full); } catch { continue; }
      f.mtime = st.mtimeMs;
      if (st.size < f.offset) { f.offset = 0; f.partial = ''; f.skipFirst = false; } // truncated / rewritten
      if (st.size === f.offset) continue;
      const len = Math.min(st.size - f.offset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      let fd;
      try {
        fd = fs.openSync(f.full, 'r');
        fs.readSync(fd, buf, 0, len, f.offset);
      } catch {
        continue; // locked mid-write; try again next tick
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      f.offset += len;
      f.size = st.size;
      const text = f.partial + (f.offset === len ? decode(buf) : buf.toString('utf8'));
      const lines = text.split(/\r?\n/);
      f.partial = lines.pop() || '';
      if (f.skipFirst) { lines.shift(); f.skipFirst = false; }
      this.ingest(f, lines, f.firstRead);
      f.firstRead = false;
    }
  }

  ingest(f, lines, historyOnly = false) {
    let last = null;
    const cutoff = historyOnly ? Date.now() - HISTORY_MS : 0;
    for (const raw of lines) {
      const line = raw.replace(/\0/g, '').trimEnd();
      if (!line) continue;
      const p = parseLine(line, f.mtime);
      // Lines with no stamp and no level continue the previous entry (stack traces, file lists).
      if (!p.time && !p.level && last && last.lines < 40) {
        last.text += `\n${line}`;
        last.lines++;
        continue;
      }
      const entry = {
        id: this.nextId++, time: p.time || (last ? last.time : f.mtime), level: p.level || 'info',
        source: f.source, file: f.rel, root: f.root, text: p.text || line, lines: 1,
      };
      if (entry.time < cutoff) { last = entry; continue; }
      if (entry.level === 'error') f.errors++;
      if (entry.level === 'warn') f.warns++;
      this.push(entry);
      last = entry;
    }
  }

  /** A game event (started, exited, crashed): shown as a divider in the timeline. */
  note(level, text, source = 'Game') {
    this.push({ id: this.nextId++, time: Date.now(), level, source, file: '', root: '', text, lines: 1, marker: true });
  }

  /** A problem reported by this app itself, so every error is in one timeline. */
  report(level, text) {
    this.push({ id: this.nextId++, time: Date.now(), level, source: 'Mod Manager', file: '', root: '', text, lines: 1 });
  }

  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.pending.push(entry);
  }

  flush() {
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.emit('entries', batch);
  }

  sources() {
    return [...this.files.values()].map(f => ({
      rel: f.rel, source: f.source, root: f.root, size: f.size, mtime: f.mtime, followed: f.followed, errors: f.errors, warns: f.warns,
    })).sort((a, b) => b.mtime - a.mtime);
  }

  status() { return { ...this.game, sources: this.files.size, followed: [...this.files.values()].filter(f => f.followed).length }; }

  checkGame() {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${GAME_EXE}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return;
      const m = stdout.match(/"Cyberpunk2077\.exe","(\d+)"/i);
      const running = !!m;
      if (running === this.game.running) return;
      if (running) {
        this.game = { running: true, since: Date.now(), pid: Number(m[1]) };
        this.note('success', `Cyberpunk 2077 started (PID ${m[1]})`);
        this.snapshotCrashes();
        // What could be a log right now; anything that appears or grows during the run is one.
        this.baseline = null;
        const dir = this.getGameDir();
        if (dir) this.possibleLogs(dir).then(sizes => { if (this.game.running) this.baseline = sizes; }).catch(() => {});
      } else {
        // One last look for logs the run wrote (crash logs are often written on the way out).
        this.discover().finally(() => { this.baseline = null; });
        const ran = this.game.since ? Math.round((Date.now() - this.game.since) / 60000) : 0;
        this.game = { running: false, since: null, pid: null };
        const crash = this.newCrashReport();
        if (crash) this.note('error', `Cyberpunk 2077 exited and wrote a crash report: ${crash}`);
        else this.note('info', `Cyberpunk 2077 exited${ran ? ` after ${ran} min` : ''}`);
      }
      this.flush();
      this.emit('game', this.status());
    });
  }

  /** The game's crash reporter drops a folder per crash under %LOCALAPPDATA%\REDEngine\ReportQueue. */
  snapshotCrashes() {
    try { for (const d of fs.readdirSync(this.crashDir)) this.knownCrashes.add(d); } catch { /* none yet */ }
  }

  newCrashReport() {
    try {
      const fresh = fs.readdirSync(this.crashDir).filter(d => !this.knownCrashes.has(d));
      fresh.forEach(d => this.knownCrashes.add(d));
      return fresh.length ? path.join(this.crashDir, fresh[fresh.length - 1]) : '';
    } catch {
      return '';
    }
  }
}

module.exports = { GameLogMonitor, parseLine, sourceName, groupKey, ownerRoot, isLogFile, mayBeLog };
