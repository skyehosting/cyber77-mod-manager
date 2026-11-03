'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/*
 * The game's logs, one set per play: from "Cyberpunk 2077 started" until it exits or crashes (and a
 * minute after, for logs written on the way out and the crash reporter's folder). Each play is a
 * folder under logs/plays/<YYYYMMDD-HHMMSS>/:
 *   play.json      when, how long, how it ended (exited / crashed / unknown), its error and warning counts
 *   timeline.jsonl every log line of the play, as the Game log showed it
 *   files/…        a copy of every log the game and its mods wrote during the play (mods often start
 *                  their log over on the next launch: this keeps the old one)
 * The Game log shows any play; the AI reads them as separate sessions.
 */

const AFTER_MS = 60e3; // lines and files written this long after the game is gone still belong to the play
const KEEP = 50; // plays kept; older ones are removed (the user can delete any sooner)
const FILE_MAX = 8 * 1024 * 1024; // a bigger log keeps its last 8 MB
const FILES_MAX = 100 * 1024 * 1024; // per play

const stamp = t => {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

class PlayHistory extends EventEmitter {
  /** dir: where plays are kept. logs: the GameLogMonitor (its 'game', 'entries' and 'crash' events, and its files). */
  constructor({ dir, logs, log }) {
    super();
    this.dir = dir;
    this.logs = logs;
    this.log = log;
    this.current = null; // { id, dir, meta, closeTimer }
    this.startedAt = Date.now();
    this.recover();
    logs.on('game', s => this.onGame(s));
    logs.on('entries', batch => this.onEntries(batch));
    logs.on('crash', id => { if (this.current) { this.current.meta.outcome = 'crashed'; this.current.meta.crash = id; this.writeMeta(this.current); } });
  }

  /** A play the app did not see end (it was closed first): finish it from what was written. */
  recover() {
    for (const p of this.list()) {
      if (p.end) continue;
      const d = path.join(this.dir, p.id);
      const lines = this.readTimeline(p.id);
      const last = lines.length ? lines[lines.length - 1].time : p.start;
      this.copyFiles(d, p.start, last + AFTER_MS);
      fs.writeFileSync(path.join(d, 'play.json'), JSON.stringify({ ...p, end: last, outcome: p.outcome === 'crashed' ? 'crashed' : 'unknown', note: 'Cyber Mod Manager was closed before the game, so the end is the last log line it saw.' }, null, 2));
    }
  }

  onGame(s) {
    if (s.running && !this.current) this.begin(s.since || Date.now(), s);
    else if (s.running && this.current?.closeTimer) { clearTimeout(this.current.closeTimer); this.current.closeTimer = null; this.current.meta.end = 0; } // started again within the minute
    else if (!s.running && this.current && !this.current.closeTimer) {
      this.current.meta.end = Date.now();
      if (!this.current.meta.outcome) this.current.meta.outcome = 'exited';
      this.writeMeta(this.current);
      this.current.closeTimer = setTimeout(() => this.finish(), AFTER_MS);
    }
  }

  begin(start, s) {
    const id = stamp(start);
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    // The app opened while the game was already running: the lines from before are in the copied files.
    const late = Date.now() - this.startedAt < 30e3;
    this.current = { id, dir, meta: { id, start, end: 0, outcome: '', crash: '', errors: 0, warns: 0, lines: 0, pid: s.pid || 0, joinedLate: !!late } };
    this.writeMeta(this.current);
    // "Cyberpunk 2077 started" was sent just before this news: it opens the play.
    this.onEntries((this.logs.entries || []).filter(e => e.time >= start - 2000));
    this.emit('plays', this.list());
  }

  onEntries(batch) {
    const c = this.current;
    if (!c) return;
    // Lines as they arrive during the play (by arrival: some logs stamp their lines in UTC). Lines
    // read from old files are hours older; this app's own messages are not the game's.
    const mine = batch.filter(e => e.time >= c.meta.start - 6 * 3600e3 && e.source !== 'Mod Manager');
    if (!mine.length) return;
    for (const e of mine) {
      if (e.marker) continue;
      if (e.level === 'error') c.meta.errors++;
      else if (e.level === 'warn') c.meta.warns++;
    }
    c.meta.lines += mine.length;
    try { fs.appendFileSync(path.join(c.dir, 'timeline.jsonl'), `${mine.map(e => JSON.stringify(e)).join('\n')}\n`); } catch { /* the folder was deleted */ }
    if (c.meta.lines % 200 < mine.length) this.writeMeta(c);
  }

  /** The play is over: keep a copy of every log written during it. */
  finish() {
    const c = this.current;
    if (!c) return;
    this.current = null;
    const files = this.copyFiles(c.dir, c.meta.start, Date.now());
    c.meta.files = files.count;
    c.meta.size = files.bytes;
    this.writeMeta(c);
    this.prune();
    this.log?.info(`Saved the logs of the play at ${new Date(c.meta.start).toLocaleString()}: ${c.meta.lines} lines, ${files.count} log files`);
    this.emit('plays', this.list());
  }

  /** Copy the logs written between from and to (by their time) into <play>/files, keeping their paths. */
  copyFiles(dir, from, to) {
    let count = 0;
    let bytes = 0;
    for (const f of this.logs.files?.values?.() || []) {
      let st;
      try { st = fs.statSync(f.full); } catch { continue; }
      if (st.mtimeMs < from - 5000 || st.mtimeMs > to + 5000 || !st.size) continue;
      const size = Math.min(st.size, FILE_MAX);
      if (bytes + size > FILES_MAX) break;
      const dest = path.join(dir, 'files', ...f.rel.split('/'));
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (st.size <= FILE_MAX) fs.copyFileSync(f.full, dest);
        else {
          const fd = fs.openSync(f.full, 'r');
          const buf = Buffer.alloc(FILE_MAX);
          fs.readSync(fd, buf, 0, FILE_MAX, st.size - FILE_MAX);
          fs.closeSync(fd);
          fs.writeFileSync(dest, buf);
        }
        fs.utimesSync(dest, st.atime, st.mtime);
        count++;
        bytes += size;
      } catch { /* in use or gone */ }
    }
    return { count, bytes };
  }

  writeMeta(c) {
    try { fs.writeFileSync(path.join(c.dir, 'play.json'), JSON.stringify(c.meta, null, 2)); } catch { /* deleted */ }
  }

  /** Every play, newest first (the one in progress included, with live: true). */
  list() {
    let ids = [];
    try { ids = fs.readdirSync(this.dir).filter(n => /^\d{8}-\d{6}$/.test(n)); } catch { return []; }
    return ids.sort().reverse().map(id => {
      if (this.current?.id === id) return { ...this.current.meta, live: !this.current.closeTimer, closing: !!this.current.closeTimer };
      const m = readJson(path.join(this.dir, id, 'play.json'));
      return m ? { ...m, id } : null;
    }).filter(Boolean);
  }

  readTimeline(id) {
    if (!/^\d{8}-\d{6}$/.test(String(id))) return [];
    try {
      return fs.readFileSync(path.join(this.dir, id, 'timeline.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  /** One play: its summary, lines and saved files. */
  get(id) {
    const p = this.list().find(x => x.id === id);
    if (!p) return null;
    return { ...p, entries: this.readTimeline(id), files: this.files(id) };
  }

  files(id) {
    const root = path.join(this.dir, String(id), 'files');
    const out = [];
    const walk = (d, rel) => {
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else { try { const st = fs.statSync(path.join(d, e.name)); out.push({ rel: r, size: st.size, mtime: st.mtimeMs }); } catch { /* gone */ } }
      }
    };
    walk(root, '');
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** The full path of a saved file (inside that play's folder only). */
  filePath(id, rel) {
    if (!/^\d{8}-\d{6}$/.test(String(id))) throw new Error('No such play.');
    const root = path.resolve(this.dir, id, 'files');
    const full = path.resolve(root, String(rel || ''));
    if (!full.startsWith(root + path.sep)) throw new Error('Not a file of that play.');
    return full;
  }

  folder(id) {
    if (!/^\d{8}-\d{6}$/.test(String(id))) throw new Error('No such play.');
    return path.join(this.dir, id);
  }

  /** Delete plays (not the one in progress). Returns how many went. */
  remove(ids) {
    let n = 0;
    for (const id of [].concat(ids || [])) {
      if (!/^\d{8}-\d{6}$/.test(String(id)) || this.current?.id === id) continue;
      try { fs.rmSync(path.join(this.dir, id), { recursive: true, force: true }); n++; } catch { /* in use */ }
    }
    if (n) this.emit('plays', this.list());
    return n;
  }

  prune() {
    const old = this.list().filter(p => !p.live && !p.closing).slice(KEEP);
    if (old.length) this.remove(old.map(p => p.id));
  }
}

module.exports = { PlayHistory, stamp, KEEP, AFTER_MS };
