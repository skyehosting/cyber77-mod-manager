'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/*
 * Cyberpunk 2077's saves, and backups of them. Research and rules: notes/saves.md.
 *
 * Saves: %USERPROFILE%\Saved Games\CD Projekt Red\Cyberpunk 2077\<slot>\ with sav.dat,
 * screenshot.png and metadata.<n>.json. Slots are ManualSave-N, AutoSave-N, QuickSave-N,
 * PointOfNoReturnSave-N, EndGameSave-N. The loose files beside them are never copied or moved:
 * user.gls holds the player's CD PROJEKT RED sign-in token.
 *
 * Backups are plain folders anyone can open and copy without this app:
 *   <root>\<YYYY-MM-DD>\<HH-MM-SS> <reason>\<slot>\…   and   …\backup.json
 * Every file is kept once in <root>\.store\<2>\<sha256> and backups hard-link to it (plain copies
 * where links are not possible), so a backup costs only the saves that changed. Live saves are
 * COPIED into the store and checked by hash; restored files are copies. Work in progress lives in
 * <root>\.work (never inside the game's save folder, which cloud services sync).
 */

const SLOT = /^(ManualSave|AutoSave|QuickSave|PointOfNoReturnSave|EndGameSave)-(\d{1,6})$/;
const BACKUP_ID = /^\d{4}-\d{2}-\d{2}\/[^/\\]{1,120}$/;
const NEVER_COPY = /^user\.gls$/i;
const MAX_FILE = 256 << 20; // a save file is a few MB: anything over 256 MB is not part of a save
const STALE = 10 * 60000; // leftovers of an interrupted backup or delete, swept after 10 minutes

// Safety backups (before a restore, a profile switch, deleting saves): kept 7 days whatever the limit.
const SAFETY = new Set(['restore', 'switch', 'delete']);
const REASONS = Object.freeze(Object.assign(Object.create(null), {
  manual: 'Manual',
  play: 'Before play',
  'play-mods': 'Before play, mods changed',
  'game-start': 'Game started',
  restore: 'Before restore',
  switch: 'Before profile switch',
  delete: 'Before deleting saves',
}));
const reasonOf = r => (typeof r === 'string' && Object.prototype.hasOwnProperty.call(REASONS, r) ? r : 'manual');

/** The game's save folder. CMM_SAVES_DIR points tests elsewhere. */
function defaultSavesDir() {
  if (process.env.CMM_SAVES_DIR !== undefined) return process.env.CMM_SAVES_DIR;
  return path.join(process.env.USERPROFILE || '', 'Saved Games', 'CD Projekt Red', 'Cyberpunk 2077');
}

/** Where backups go by default: beside the game's saves (same drive: links work), outside the app. */
function defaultBackupDir() {
  if (process.env.CMM_SAVE_BACKUPS_DIR !== undefined) return process.env.CMM_SAVE_BACKUPS_DIR;
  return path.join(process.env.USERPROFILE || '', 'Saved Games', 'Edgerunners Mod Manager', 'Save backups');
}

/**
 * Is this a folder backups may go in? Returns '' when fine, else why not. Never: inside (or holding)
 * the game's save folder (cloud services sync it), a drive root, a network share, Windows or the
 * program folders, or the user folder itself.
 */
function backupDirProblem(dir, savesDir = defaultSavesDir()) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return 'Choose a full folder path.';
  if (dir.length > 400) return 'That path is too long.';
  if (/^[\\/]{2}/.test(dir)) return 'Choose a folder on this PC, not a network share.';
  let full = path.resolve(dir);
  // Follow links and junctions: compare where the folder really is (its nearest existing part).
  for (let p = full, rest = ''; ; rest = path.join(path.basename(p), rest), p = path.dirname(p)) {
    try { full = path.join(fs.realpathSync.native(p), rest); break; } catch { if (path.dirname(p) === p) break; }
  }
  if (path.parse(full).root === full || path.parse(full).root === `${full}\\`) return 'Choose a folder, not a whole drive.';
  const inside = (a, b) => { const r = path.relative(path.resolve(b), path.resolve(a)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (savesDir && (inside(full, savesDir) || inside(savesDir, full))) return 'Not in (or around) the game\'s save folder: cloud saves would sync the backups.';
  for (const sys of [process.env.WINDIR, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]) {
    if (sys && inside(full, sys)) return 'Not in a Windows or program folder.';
  }
  if (process.env.USERPROFILE && path.resolve(process.env.USERPROFILE) === full) return 'Choose a folder inside your user folder, not the user folder itself.';
  return '';
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const filesIn = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
/** Write JSON so a crash leaves the old file or the new one, never half of one. */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
/** Move a file or folder; across drives, copy then delete. */
async function move(from, to) {
  try { await fsp.rename(from, to); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.cp(from, to, { recursive: true, preserveTimestamps: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}
/** A file's sha256, read in chunks (no whole-file buffers). */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** A save's metadata: the newest metadata.<n>.json in its folder. */
function readMetadata(dir) {
  const metas = filesIn(dir).filter(e => e.isFile() && /^metadata\.\d+\.json$/i.test(e.name))
    .sort((a, b) => Number(b.name.split('.')[1]) - Number(a.name.split('.')[1]));
  for (const e of metas) {
    const m = readJson(path.join(dir, e.name))?.Data?.metadata;
    if (m && typeof m === 'object') return m;
  }
  return null;
}

/** One save folder: its slot, character and play details, files and size. Null when not a save. */
function readSave(savesDir, name) {
  const slot = name.match(SLOT);
  if (!slot) return null;
  const dir = path.join(savesDir, name);
  const files = filesIn(dir).filter(e => e.isFile() && !NEVER_COPY.test(e.name)).map(e => e.name);
  if (!files.some(f => f.toLowerCase() === 'sav.dat')) return null;
  let size = 0;
  let time = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      size += st.size;
      if (f.toLowerCase() === 'sav.dat') time = st.mtimeMs;
    } catch { /* gone meanwhile */ }
  }
  const m = readMetadata(dir) || {};
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  const shot = files.find(f => f.toLowerCase() === 'screenshot.png');
  return {
    folder: name,
    kind: slot[1],
    number: Number(slot[2]),
    playthrough: str(m.playthroughID, 80) || 'unknown',
    level: num(m.level),
    streetCred: num(m.streetCred),
    lifePath: str(m.lifePath, 40),
    gender: str(m.bodyGender, 20),
    location: str(m.locationName),
    quest: str(m.trackedQuestEntry, 300),
    playTime: num(m.playthroughTime || m.playTime),
    gameVersion: str(String(m.buildPatch || ''), 20),
    difficulty: str(m.difficulty, 20),
    modded: !!m.isModded,
    phantomLiberty: Array.isArray(m.additionalContentIds) && m.additionalContentIds.length > 0,
    time,
    size,
    files,
    screenshot: shot ? path.join(dir, shot) : '',
  };
}

/** Every save in the folder, newest first. */
function scanSaves(savesDir) {
  return filesIn(savesDir).filter(e => e.isDirectory()).map(e => readSave(savesDir, e.name)).filter(Boolean)
    .sort((a, b) => b.time - a.time);
}

/** Saves grouped by playthrough (one character's run), newest playthrough first. */
function groupPlaythroughs(saves) {
  const by = new Map();
  for (const s of saves) {
    if (!by.has(s.playthrough)) by.set(s.playthrough, []);
    by.get(s.playthrough).push(s);
  }
  return [...by.entries()].map(([id, list]) => {
    const latest = list[0];
    return {
      id, saves: list.map(s => s.folder), count: list.length, latest: latest.folder, time: latest.time,
      level: Math.max(...list.map(s => s.level)), lifePath: latest.lifePath, gender: latest.gender,
      playTime: Math.max(...list.map(s => s.playTime)), location: latest.location, gameVersion: latest.gameVersion,
      size: list.reduce((n, s) => n + s.size, 0), phantomLiberty: list.some(s => s.phantomLiberty),
    };
  }).sort((a, b) => b.time - a.time);
}

/** What the saves are right now, as one string: changes when any save is added, removed or rewritten. */
function savesFingerprint(saves) {
  const parts = saves.map(s => `${s.folder}:${s.size}:${Math.round(s.time)}`).sort();
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

const pad = n => String(n).padStart(2, '0');
const dayOf = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const clockOf = t => { const d = new Date(t); return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; };

/** A backup.json as the app uses it: known fields, typed and bounded (it is a file anyone can edit). */
function cleanRecord(r, id) {
  if (!r || typeof r !== 'object' || !(Number(r.at) > 0)) return null;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const saves = (Array.isArray(r.saves) ? r.saves : []).filter(s => s && typeof s === 'object' && SLOT.test(String(s.folder))).slice(0, 5000).map(s => ({
    folder: String(s.folder), kind: String(s.folder).match(SLOT)[1], number: Number(String(s.folder).match(SLOT)[2]), playthrough: str(s.playthrough, 80) || 'unknown', level: num(s.level),
    lifePath: str(s.lifePath, 40), gender: str(s.gender, 20), location: str(s.location, 200), quest: str(s.quest, 300),
    playTime: num(s.playTime), gameVersion: str(s.gameVersion, 20), modded: !!s.modded, phantomLiberty: !!s.phantomLiberty,
    time: num(s.time), size: num(s.size),
  }));
  return {
    id, at: num(r.at), reason: reasonOf(r.reason), label: str(r.label, 80), pinned: r.pinned === true,
    profile: str(r.profile, 40), profileName: str(r.profileName, 60), mods: num(r.mods), size: num(r.size), saves,
  };
}

class SaveBackups {
  /** savesDir(): the game's save folder. root(): where backups go. log: the app's log. */
  constructor({ savesDir = defaultSavesDir, root = defaultBackupDir, log }) {
    this.savesDir = savesDir;
    this.root = root;
    this.log = log;
    this.busy = false;
    this.linkCache = new Map();
  }

  get store() { return path.join(this.root(), '.store'); }
  get work() { return path.join(this.root(), '.work'); }

  /** One operation at a time (backups, restores, deletes). */
  async exclusive(fn) {
    if (this.busy) throw new Error('A save backup or restore is already running. Try again in a moment.');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  /** Can this backup folder hold hard links? Probed per folder; a failed probe is tried again next time. */
  linksWork() {
    const root = this.root();
    if (this.linkCache.get(root) === true) return true;
    const a = path.join(this.store, `.link-test-${process.pid}`);
    let ok = false;
    try {
      fs.mkdirSync(this.store, { recursive: true });
      fs.writeFileSync(a, 'x');
      fs.linkSync(a, `${a}.2`);
      ok = true;
    } catch { /* no links on this drive, or a passing lock */ }
    fs.rmSync(a, { force: true });
    fs.rmSync(`${a}.2`, { force: true });
    if (ok) this.linkCache.set(root, true);
    return ok;
  }

  /** Copy a live file to `dest`, checked against `hash` (a save being written right now fails the copy). */
  async copyChecked(from, dest, hash) {
    const tmp = `${dest}.${process.pid}.tmp`;
    await fsp.copyFile(from, tmp);
    if (await hashFile(tmp) !== hash) {
      await fsp.rm(tmp, { force: true });
      throw Object.assign(new Error(`${path.basename(path.dirname(from))} changed while it was backed up`), { changed: true });
    }
    await fsp.rename(tmp, dest);
  }

  /** Keep a copy of a live file at `to` (stored once per content, linked where possible). Its hash. */
  async keep(from, to, links) {
    if (NEVER_COPY.test(path.basename(from))) throw new Error('refusing to copy user.gls');
    const hash = await hashFile(from);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    if (!links) { await this.copyChecked(from, to, hash); return hash; }
    const blob = path.join(this.store, hash.slice(0, 2), hash);
    if (!fs.existsSync(blob)) {
      await fsp.mkdir(path.dirname(blob), { recursive: true });
      await this.copyChecked(from, blob, hash);
      try { fs.chmodSync(blob, 0o444); } catch { /* read-only helps; not required */ }
    }
    // NTFS allows 1023 links per file: past that (or any other failure), a plain copy.
    try { await fsp.link(blob, to); } catch { await fsp.copyFile(blob, to); }
    return hash;
  }

  /** Leftovers of interrupted work (older than 10 minutes): half-made backups, half-deleted ones, temp files. */
  sweep() {
    const old = p => { try { return Date.now() - fs.statSync(p).mtimeMs > STALE; } catch { return false; } };
    let swept = false;
    for (const day of filesIn(this.root()).filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))) {
      const dayDir = path.join(this.root(), day.name);
      for (const b of filesIn(dayDir)) {
        const p = path.join(dayDir, b.name);
        if (/\.(partial|deleting)$/.test(b.name) && old(p)) { fs.rmSync(p, { recursive: true, force: true }); swept = true; }
      }
      try { fs.rmdirSync(dayDir); } catch { /* not empty */ }
    }
    if (swept) this.collect(); // their stored files, unless a backup still uses them
    // .work holds a failed restore's staging folder; it is never swept by itself (it may hold the only copy).
    for (const e of filesIn(this.store)) {
      const p = path.join(this.store, e.name);
      if (e.isFile() && e.name.startsWith('.link-test-') && old(p)) fs.rmSync(p, { force: true });
      if (e.isDirectory()) for (const f of filesIn(p)) if (f.name.endsWith('.tmp') && old(path.join(p, f.name))) fs.rmSync(path.join(p, f.name), { force: true });
    }
  }

  /**
   * Back up every save. info: { reason, profile, profileName, mods, label }. The save set is read
   * again after copying: if the game saved meanwhile, the backup is tried once more. Returns the
   * backup's record, or null when there are no saves.
   */
  create(info = {}) {
    return this.exclusive(() => this.createNow(info));
  }

  async createNow(info, attempt = 1) {
    this.sweep();
    const savesDir = this.savesDir();
    const saves = scanSaves(savesDir);
    if (!saves.length) return null;
    const at = Date.now();
    const reason = reasonOf(info.reason);
    const dayDir = path.join(this.root(), dayOf(at));
    let name = `${clockOf(at)} ${REASONS[reason]}`;
    for (let n = 2; fs.existsSync(path.join(dayDir, name)) || fs.existsSync(path.join(dayDir, `${name}.partial`)); n++) name = `${clockOf(at)} ${REASONS[reason]} (${n})`;
    const dir = path.join(dayDir, name);
    const tmp = `${dir}.partial`;
    const links = this.linksWork();
    try {
      const hashes = {};
      const skipped = [];
      for (const s of saves) {
        for (const f of s.files) {
          const from = path.join(savesDir, s.folder, f);
          // A save file is a few MB: something huge in a slot folder is not part of it, and must not block backups.
          if (fs.statSync(from).size > MAX_FILE) { skipped.push(`${s.folder}/${f}`); continue; }
          hashes[`${s.folder}/${f}`] = await this.keep(from, path.join(tmp, s.folder, f), links);
        }
        await new Promise(r => setImmediate(r)); // the window stays responsive during a big first backup
      }
      // The same saves as when it started (the game did not write one meanwhile)?
      if (savesFingerprint(scanSaves(savesDir)) !== savesFingerprint(saves)) throw Object.assign(new Error('the game saved while the backup was made'), { changed: true });
      const record = {
        format: 1, at, reason, label: String(info.label || '').slice(0, 80), pinned: false,
        profile: String(info.profile || '').slice(0, 40), profileName: String(info.profileName || '').slice(0, 60), mods: Number(info.mods) || 0,
        size: saves.reduce((n, s) => n + s.size, 0),
        saves: saves.map(({ files, screenshot, ...s }) => s),
        hashes,
        skipped,
      };
      if (skipped.length) this.log?.warn?.(`Save backup: left out ${skipped.length} oversized file(s) that are not part of a save: ${skipped.slice(0, 3).join(', ')}`);
      writeJsonAtomic(path.join(tmp, 'backup.json'), record);
      fs.renameSync(tmp, dir);
      return this.recordOf(dir);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (err.changed && attempt < 3) return this.createNow(info, attempt + 1);
      throw err;
    }
  }

  /** A backup's record (cleaned), with its id: "<day>/<folder>". */
  recordOf(dir) {
    return cleanRecord(readJson(path.join(dir, 'backup.json')), path.relative(this.root(), dir).replace(/\\/g, '/'));
  }

  /** Every backup, newest first. */
  list() {
    const root = this.root();
    const out = [];
    for (const day of filesIn(root).filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))) {
      for (const b of filesIn(path.join(root, day.name)).filter(e => e.isDirectory() && !/\.(partial|deleting)$/.test(e.name))) {
        const r = this.recordOf(path.join(root, day.name, b.name));
        if (r) out.push(r);
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** The folder of a backup id, only ever a finished backup inside the backup folder. */
  dirOf(id) {
    const s = String(id);
    // Windows drops trailing dots and spaces from names: "x.partial." would reach "x.partial".
    if (!BACKUP_ID.test(s) || s.includes('..') || /[. ]$/.test(s) || /\.(partial|deleting)$/i.test(s)) throw new Error('That backup does not exist.');
    const root = path.resolve(this.root());
    const dir = path.resolve(root, s);
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(path.join(dir, 'backup.json'))) throw new Error('That backup does not exist.');
    return dir;
  }

  /** Change a backup's label or pin. */
  update(id, patch) {
    if (this.busy) throw new Error('A save backup or restore is running. Try again in a moment.');
    const dir = this.dirOf(id);
    const file = path.join(dir, 'backup.json');
    const r = readJson(file);
    if (!r || typeof r !== 'object') throw new Error('That backup\'s record cannot be read.');
    const p = patch && typeof patch === 'object' ? patch : {};
    if ('pinned' in p) r.pinned = p.pinned === true;
    if ('label' in p) r.label = String(p.label || '').slice(0, 80);
    writeJsonAtomic(file, r);
    return this.recordOf(dir);
  }

  /** Delete a backup folder: renamed first (atomic), then removed, so a failure never leaves half a backup listed. */
  deleteDir(dir) {
    const gone = `${dir}.deleting`;
    fs.renameSync(dir, gone);
    fs.rmSync(gone, { recursive: true, force: true });
    try { fs.rmdirSync(path.dirname(dir)); } catch { /* the day still has backups */ }
  }

  /** Delete a backup, and every stored file no backup uses any more. Freed bytes. */
  remove(id) {
    if (this.busy) throw new Error('A save backup or restore is running. Try again in a moment.');
    this.deleteDir(this.dirOf(id));
    return this.collect();
  }

  /** Stored files no backup links to any more (the store's own name is the only link): delete them. Freed bytes. */
  collect() {
    let freed = 0;
    for (const sub of filesIn(this.store).filter(e => e.isDirectory())) {
      for (const f of filesIn(path.join(this.store, sub.name)).filter(e => e.isFile() && !e.name.endsWith('.tmp'))) {
        const p = path.join(this.store, sub.name, f.name);
        try {
          const st = fs.statSync(p);
          if (st.nlink <= 1) { fs.chmodSync(p, 0o666); fs.rmSync(p); freed += st.size; }
        } catch { /* in use */ }
      }
    }
    return freed;
  }

  /**
   * Keep at most `max` backups per profile, oldest going first. Never removed: pinned backups, and
   * safety backups (before a restore, a switch, deleting saves) younger than 7 days. A limit below
   * 3, or not a number, removes nothing. Returns the ids removed.
   */
  prune(max) {
    const keep = Number(max);
    if (!Number.isInteger(keep) || keep < 3) return [];
    if (this.busy) return [];
    this.sweep();
    const removed = [];
    const byProfile = new Map();
    for (const b of this.list()) {
      if (b.pinned || (SAFETY.has(b.reason) && Date.now() - b.at < 7 * 86400000)) continue;
      if (!byProfile.has(b.profile)) byProfile.set(b.profile, []);
      byProfile.get(b.profile).push(b);
    }
    for (const list of byProfile.values()) {
      for (const b of list.slice(keep)) {
        try { this.deleteDir(this.dirOf(b.id)); removed.push(b.id); } catch { /* in use: next time */ }
      }
    }
    if (removed.length) this.collect();
    return removed;
  }

  /** The space the backups take on disk, remembered until backups change (walking them is slow). */
  diskSize() {
    const root = this.root();
    const list = this.list();
    const key = `${root}|${list.length}|${list[0]?.at || 0}|${list[list.length - 1]?.at || 0}`;
    if (this.sizeKey !== key) { this.sizeValue = this.measure(); this.sizeKey = key; }
    return this.sizeValue;
  }

  /** Each stored file once, plus plain copies where links failed. */
  measure() {
    let n = 0;
    const seen = new Set();
    const walk = dir => {
      for (const e of filesIn(dir)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        try {
          const st = fs.statSync(p, { bigint: true });
          const key = `${st.dev}:${st.ino}`;
          if (!seen.has(key)) { seen.add(key); n += Number(st.size); }
        } catch { /* gone */ }
      }
    };
    walk(this.root());
    return n;
  }

  /**
   * Put saves from a backup back. folders: the slots to restore, or 'all' (the whole set: saves made
   * after the backup leave too). First a safety backup of the saves now (unless info.safety is
   * false), then every slot is checked (a real folder with sav.dat, files matching the hashes
   * recorded at backup time) and staged OUTSIDE the game's folder; only when all are ready are they
   * swapped in. Returns the slots restored.
   */
  restore(id, folders = 'all', info = {}) {
    return this.exclusive(async () => {
      const dir = this.dirOf(id);
      const raw = readJson(path.join(dir, 'backup.json'));
      const record = cleanRecord(raw, id);
      if (!record) throw new Error('That backup\'s record cannot be read.');
      const hashes = raw && typeof raw.hashes === 'object' && raw.hashes ? raw.hashes : {};
      const listed = new Set(record.saves.map(s => s.folder));
      const asked = [...new Set(folders === 'all' ? listed : (Array.isArray(folders) ? folders : []).map(String).filter(f => listed.has(f)))];
      // Only slots that are really there, complete and unchanged: every file recorded at backup time
      // present and matching its hash (sav.dat at least), a real folder and real files (no links out).
      const ready = [];
      const bad = [];
      for (const slot of asked) {
        const from = path.join(dir, slot);
        const want = Object.entries(hashes).filter(([k, v]) => k.startsWith(`${slot}/`) && typeof v === 'string').map(([k, v]) => [k.slice(slot.length + 1), v]);
        let ok = SLOT.test(slot) && want.some(([f]) => f.toLowerCase() === 'sav.dat');
        try { if (ok && !fs.lstatSync(from).isDirectory()) ok = false; } catch { ok = false; }
        for (const [f, h] of ok ? want : []) {
          if (!ok) break;
          const p = path.join(from, f);
          try { if (path.basename(f) !== f || NEVER_COPY.test(f) || !fs.lstatSync(p).isFile() || await hashFile(p) !== h) ok = false; } catch { ok = false; }
        }
        if (ok) ready.push({ slot, from, files: want.map(([f]) => f) }); else bad.push(slot);
      }
      if (!ready.length) throw new Error('This backup has no complete saves to restore.');
      if (folders === 'all' && bad.length) throw new Error(`This backup is incomplete (${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''} damaged or missing): restore single saves from it instead.`);
      // Always a safety backup of the saves as they are now first: it holds anything the restore replaces.
      await this.createNow({ profile: info.profile, profileName: info.profileName, mods: info.mods, reason: 'restore' });
      // Stage every slot first; a failure here changes nothing. The staging folder is on the save
      // folder's drive (so every swap is an atomic rename), and never inside the save folder itself.
      const savesDir = this.savesDir();
      await fsp.mkdir(savesDir, { recursive: true });
      const sameDrive = (() => { try { fs.mkdirSync(this.root(), { recursive: true }); return fs.statSync(this.root()).dev === fs.statSync(savesDir).dev; } catch { return false; } })();
      const stage = path.join(sameDrive ? this.work : path.join(path.dirname(savesDir), '.edgerunners-work'), `restore-${Date.now()}`);
      await fsp.rm(stage, { recursive: true, force: true });
      let finished = false;
      const swapped = []; // slots moved in, and whether a live one stepped aside for each
      try {
        for (const r of ready) {
          await fsp.mkdir(path.join(stage, 'new', r.slot), { recursive: true });
          for (const f of r.files) {
            const to = path.join(stage, 'new', r.slot, f);
            await fsp.copyFile(path.join(r.from, f), to);
            try { await fsp.chmod(to, 0o666); } catch { /* the stored copy was read-only */ }
          }
        }
        // Swap: each live slot steps aside, the staged one moves in, the old one goes last.
        await fsp.mkdir(path.join(stage, 'old'), { recursive: true });
        try {
          for (const r of ready) {
            const live = path.join(savesDir, r.slot);
            const had = fs.existsSync(live);
            if (had) await move(live, path.join(stage, 'old', r.slot));
            swapped.push({ slot: r.slot, had });
            await move(path.join(stage, 'new', r.slot), live);
            swapped[swapped.length - 1].in = true;
          }
          if (folders === 'all') {
            const keepSet = new Set(swapped.map(s => s.slot));
            for (const s of scanSaves(savesDir)) {
              if (keepSet.has(s.folder)) continue;
              await move(path.join(savesDir, s.folder), path.join(stage, 'old', s.folder));
              swapped.push({ slot: s.folder, had: true, extra: true });
            }
          }
        } catch (err) {
          // Put everything back as it was; whatever cannot be is still in the staging folder and the safety backup.
          for (const s of swapped.reverse()) {
            const live = path.join(savesDir, s.slot);
            try {
              if (s.in && !s.extra) await fsp.rm(live, { recursive: true, force: true });
              if (s.had) await move(path.join(stage, 'old', s.slot), live);
            } catch { /* left in the staging folder */ }
          }
          throw err;
        }
        // What no backup holds (files too big to back up, subfolders) goes back into its restored slot.
        let carried = true;
        for (const s of swapped.filter(x => x.had && !x.extra)) {
          const oldDir = path.join(stage, 'old', s.slot);
          for (const e of filesIn(oldDir)) {
            const p = path.join(oldDir, e.name);
            let big = false;
            try { big = e.isDirectory() || fs.statSync(p).size > MAX_FILE; } catch { /* gone */ }
            const into = path.join(savesDir, s.slot, e.name);
            if (!big || fs.existsSync(into)) continue;
            try { await move(p, into); } catch { carried = false; }
          }
        }
        if (!carried) this.log?.warn?.(`Some files that were not part of a save stayed in ${stage}`);
        finished = carried;
        return swapped.filter(s => !s.extra).map(s => s.slot);
      } finally {
        // Only a finished restore clears its staging folder: after a failure it may hold the only copy.
        if (finished) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
}

module.exports = { SaveBackups, scanSaves, readSave, groupPlaythroughs, savesFingerprint, backupDirProblem, defaultSavesDir, defaultBackupDir, REASONS, SLOT, move, hashFile };
