'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { scanSaves, groupPlaythroughs, SLOT, hashFile } = require('./saves');

/*
 * Per-profile saves (off unless the user turns it on). The profile in use keeps its saves in the
 * game's save folder, as always; every other profile's saves wait in a folder of its own:
 *   %USERPROFILE%\Saved Games\Edgerunners Mod Manager\Profile saves\<profile id>\<slot>\…
 * (plus profile.json naming the profile, so the folders make sense without the app). Same drive as
 * the game's saves: every move is a rename. Outside the folder cloud services sync, and kept when the
 * app is uninstalled. Only slot folders move; the files beside them (user.gls…) never do.
 *
 * A switch, with the game closed, after a safety backup (the caller's):
 *   1. the saves in the game's folder go to the old profile's folder
 *   2. the new profile's saves come in
 * A switch never deletes or overwrites a save: a slot name already taken where a save goes gets the
 * next free ManualSave number (the game loads a renamed save). Cloud sync can put back a save that
 * left with a switch; it then counts as the profile in use's (a duplicate at worst, never a loss).
 * Every move is written to a journal first (.switch.log in the profile saves folder): a switch cut
 * off half way (crash, power loss) is undone the next time, unless the new owner was already saved.
 * Research: notes/saves.md.
 */

const ID = /^[a-z0-9]{1,40}$/i;

function defaultStoreDir() {
  if (process.env.CMM_PROFILE_SAVES_DIR !== undefined) return process.env.CMM_PROFILE_SAVES_DIR;
  return path.join(process.env.USERPROFILE || '', 'Saved Games', 'Edgerunners Mod Manager', 'Profile saves');
}

/** Where README.txt about the saves goes (the folder the uninstaller points to). None in tests. */
function defaultHomeDir() {
  if (process.env.CMM_PROFILE_SAVES_DIR !== undefined) return '';
  return path.join(process.env.USERPROFILE || '', 'Saved Games', 'Edgerunners Mod Manager');
}

const slotsIn = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && SLOT.test(e.name)).map(e => e.name); } catch { return []; } };
const savHash = async dir => { try { return await hashFile(path.join(dir, 'sav.dat')); } catch { return ''; } };

/** `slot` if free in `taken`, else the next free ManualSave number; either way it is taken now. */
function freeName(slot, taken) {
  let name = slot;
  if (taken.has(name)) {
    let n = Math.max(0, ...[...taken].map(s => s.match(SLOT)).filter(m => m && m[1] === 'ManualSave').map(m => Number(m[2]))) + 1;
    while (taken.has(`ManualSave-${n}`)) n++;
    name = `ManualSave-${n}`;
  }
  taken.add(name);
  return name;
}

/** Move a folder: a rename; across drives a copy under a temporary name, renamed when whole, then the original goes. */
async function safeMove(src, dst) {
  try { await fsp.rename(src, dst); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const tmp = path.join(path.dirname(dst), `.${path.basename(dst)}.moving`);
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.cp(src, tmp, { recursive: true, preserveTimestamps: true });
    await fsp.rename(tmp, dst);
    await fsp.rm(src, { recursive: true, force: true });
  }
}

class ProfileSaves {
  /** savesDir(): the game's save folder. root(): where other profiles' saves wait. */
  constructor({ savesDir, root = defaultStoreDir, log }) {
    this.savesDir = savesDir;
    this.root = root;
    this.log = log;
  }

  /** A profile's folder (ids are this app's own: letters and digits only). */
  dirOf(profileId) {
    if (!ID.test(String(profileId))) throw new Error('Unknown profile.');
    return path.join(this.root(), String(profileId));
  }

  /** Name the folder for people browsing it without the app. */
  label(profileId, name) {
    const dir = this.dirOf(profileId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ profile: String(name || '').slice(0, 60), note: 'Saves of this Edgerunners Mod Manager profile. To use them without the app, copy these save folders into Saved Games\\CD Projekt Red\\Cyberpunk 2077.' }, null, 2));
  }

  /** The saves a profile keeps while another one is in use. */
  savesOf(profileId) { return scanSaves(this.dirOf(profileId)); }

  /** sav.dat hash of every slot, for a folder: { slot: hash }. */
  async hashes(dir) {
    const out = {};
    for (const s of slotsIn(dir)) out[s] = await savHash(path.join(dir, s));
    return out;
  }

  get journal() { return path.join(this.root(), '.switch.log'); }

  /**
   * Switch: the game's saves go to `from`'s folder, `to`'s saves come in. The journal stays until
   * the caller has recorded `to` as the owner (flushed to disk) and calls clear(), so a crash at any
   * point leaves it saying what happened (the manager's recoverSwap sorts it out).
   */
  async swap(from, to) {
    const game = this.savesDir();
    const fromDir = this.dirOf(from);
    const toDir = this.dirOf(to);
    if (fs.existsSync(this.journal)) throw new Error('An earlier switch of saves is still being sorted out. Try again in a moment.');
    await fsp.mkdir(fromDir, { recursive: true });
    await fsp.mkdir(game, { recursive: true });
    const fd = fs.openSync(this.journal, 'wx');
    const note = obj => { fs.writeSync(fd, `${JSON.stringify(obj)}\n`); fs.fsyncSync(fd); };
    try {
      note({ from, to, at: Date.now() });
      // 1. Out: the game's saves to `from`.
      const outTaken = new Set(slotsIn(fromDir));
      for (const slot of slotsIn(game)) {
        const dst = path.join(fromDir, freeName(slot, outTaken));
        note({ src: path.join(game, slot), dst });
        await safeMove(path.join(game, slot), dst);
      }
      // 2. In: `to`'s saves.
      const inTaken = new Set(slotsIn(game));
      for (const slot of slotsIn(toDir)) {
        const dst = path.join(game, freeName(slot, inTaken));
        note({ src: path.join(toDir, slot), dst });
        await safeMove(path.join(toDir, slot), dst);
      }
    } catch (err) {
      fs.closeSync(fd);
      // Put back what moved (the journal says what).
      const r = await this.undo();
      if (r.left.length) this.log?.error?.(`Could not put every save back after a failed switch (the backup made before it has them): ${r.left.join('; ')}`);
      throw err;
    }
    fs.closeSync(fd);
    return { count: slotsIn(game).length };
  }

  /** Forget the journal. */
  clear() { fs.rmSync(this.journal, { force: true }); }

  /** Is this path a slot folder in the game's save folder or in a profile's folder (the only places a switch moves)? */
  slotPath(p) {
    const abs = path.resolve(String(p));
    if (!SLOT.test(path.basename(abs))) return false;
    const parent = path.dirname(abs);
    if (parent.toLowerCase() === path.resolve(this.savesDir()).toLowerCase()) return true;
    return path.dirname(parent).toLowerCase() === path.resolve(this.root()).toLowerCase() && ID.test(path.basename(parent));
  }

  /** The journal of a switch: { head: { from, to }, moves: [{ src, dst }] }, or null. */
  readJournal() {
    let text;
    try { text = fs.readFileSync(this.journal, 'utf8'); } catch { return null; }
    const lines = [];
    for (const l of text.split('\n')) { try { if (l.trim()) lines.push(JSON.parse(l)); } catch { /* a line cut off by the crash: its move never started */ } }
    const [head, ...rest] = lines;
    return {
      head: head && typeof head === 'object' ? head : {},
      moves: rest.filter(m => typeof m?.src === 'string' && typeof m?.dst === 'string' && this.slotPath(m.src) && this.slotPath(m.dst)),
    };
  }

  /**
   * Undo a journaled switch, newest move first. A save back at its old place in the meantime is kept:
   * the returning one gets a free number. A move that cannot be undone is listed in `left`; the
   * journal is then kept aside (.switch.log.failed-<time>) so switching is not blocked for good.
   */
  async undo() {
    const j = this.readJournal();
    const left = [];
    if (!j) return { left };
    for (const m of j.moves.reverse()) {
      if (!fs.existsSync(m.dst)) continue; // never moved (or already back)
      try {
        await fsp.mkdir(path.dirname(m.src), { recursive: true });
        const back = fs.existsSync(m.src) ? path.join(path.dirname(m.src), freeName(path.basename(m.src), new Set(slotsIn(path.dirname(m.src))))) : m.src;
        await safeMove(m.dst, back);
      } catch (err) {
        left.push(`${m.dst} (${err.code || err.message})`);
      }
    }
    if (left.length) fs.renameSync(this.journal, `${this.journal}.failed-${Date.now()}`);
    else this.clear();
    return { left };
  }

  /** Folders a copy or a move across drives left half made (it was cut off): they go. */
  sweep(dirs) {
    for (const dir of dirs) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) if (/^\..+\.(copying|moving)$/.test(n)) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch { /* next time */ } }
    }
  }

  /**
   * Copy saves of a playthrough into a folder (a profile's, or the game's for the profile in use). A
   * save already there (same sav.dat) is skipped; a slot name taken there gets the next free
   * ManualSave number. Returns how many were copied, and how many of those under a new name.
   */
  async copyPlaythrough(fromDir, playthroughId, toDir) {
    const saves = scanSaves(fromDir).filter(s => s.playthrough === playthroughId);
    if (!saves.length) return { copied: 0, renamed: 0 };
    await fsp.mkdir(toDir, { recursive: true });
    const taken = new Set(slotsIn(toDir));
    const there = new Set(Object.values(await this.hashes(toDir)).filter(Boolean));
    let copied = 0;
    let renamed = 0;
    for (const s of saves) {
      const src = path.join(fromDir, s.folder);
      const h = await savHash(src);
      if (!h || there.has(h)) continue; // no sav.dat, or the same save is there already
      const name = freeName(s.folder, taken);
      const tmp = path.join(toDir, `.${name}.copying`);
      try {
        await fsp.rm(tmp, { recursive: true, force: true });
        await fsp.cp(src, tmp, { recursive: true, preserveTimestamps: true });
        if (await savHash(tmp) !== h) throw new Error(`${s.folder} changed while it was copied. Try again.`);
        await fsp.rename(tmp, path.join(toDir, name));
      } catch (err) {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      there.add(h);
      copied++;
      if (name !== s.folder) renamed++;
    }
    return { copied, renamed };
  }

  /**
   * A deleted profile's saves: kept, in "Deleted profiles\<name> <date>" (named for people, out of the
   * app's way). Returns that folder, or '' when it had no saves (its empty folder goes).
   */
  async retire(profileId, name) {
    const dir = this.dirOf(profileId);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return ''; }
    if (entries.every(e => e === 'profile.json')) { await fsp.rm(dir, { recursive: true, force: true }); return ''; }
    const base = String(name || 'Profile').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 60) || 'Profile';
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
    const parent = path.join(this.root(), 'Deleted profiles');
    await fsp.mkdir(parent, { recursive: true });
    let dest = path.join(parent, `${base} ${stamp}`);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(parent, `${base} ${stamp} (${n})`);
    await safeMove(dir, dest);
    return dest;
  }

  /** Every profile's playthroughs: { [profileId]: [{ id, count, … }] } (the profile in use: the game's folder). */
  overview(profileIds, activeId) {
    const out = {};
    for (const id of profileIds) {
      if (!ID.test(id)) continue;
      const saves = id === activeId ? scanSaves(this.savesDir()) : this.savesOf(id);
      const size = new Map(saves.map(s => [s.folder, s.size]));
      // shot: the newest save, for its picture (the page asks for it by profile and slot).
      out[id] = groupPlaythroughs(saves).map(p => ({ id: p.id, count: p.count, level: p.level, lifePath: p.lifePath, gender: p.gender, time: p.time,
        shot: { profile: id, folder: p.latest, time: p.time, size: size.get(p.latest) || 0 } }));
    }
    return out;
  }
}

module.exports = { ProfileSaves, defaultStoreDir, defaultHomeDir, ID };
