'use strict';
const fs = require('fs');
const path = require('path');
const { JsonStore } = require('./jsonStore');

/**
 * Puts enabled mods' staged files into the game folder (hardlinks, or copies as a fallback) and
 * takes them out again. The manifest records every file it placed, so it only ever removes its
 * own files. A game file it would overwrite is moved to the backup folder first and put back
 * when no enabled mod provides that path any more.
 */
/** Move a file, also across drives (rename cannot): copy, then delete the original. */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

class Deployer {
  constructor({ manifestFile, backupDir, log }) {
    this.backupDir = backupDir;
    this.log = log;
    this.store = new JsonStore(manifestFile, { gameDir: '', deployed: {}, createdDirs: [] });
    // (dest, backupFile) => true when the original must not go back (the manager sets it: Vortex's
    // copy of a file Vortex no longer places).
    this.staleOriginal = null;
  }

  get deployed() { return this.store.data.deployed; }

  /** dest (lower-case) -> owner mod id, for the UI. */
  owners() {
    const out = {};
    for (const [k, v] of Object.entries(this.deployed)) out[k] = v.owner;
    return out;
  }

  /**
   * Make the game folder match `mods` (enabled mods, lowest priority first; later ones win).
   * Each mod: { id, stagingDir, files: string[] (dest paths relative to the game folder) }.
   */
  sync(gameDir, mods, method = 'hardlink') {
    const data = this.store.data;
    if (data.gameDir && Object.keys(data.deployed).length && path.resolve(data.gameDir) !== path.resolve(gameDir)) {
      throw new Error(`Mods are deployed to ${data.gameDir}. Disable all mods before changing the game folder.`);
    }
    data.gameDir = gameDir;

    const desired = new Map();
    for (const mod of mods) {
      for (const dest of mod.files) {
        desired.set(dest.toLowerCase(), { dest, owner: mod.id, src: path.join(mod.stagingDir, dest) });
      }
    }

    const result = { added: 0, removed: 0, restored: 0, errors: [] };
    const fail = (msg, err) => {
      result.errors.push(`${msg}: ${err.message}`);
      this.log.error(msg, err.message);
    };

    try {
      // 1. Take out files that are no longer wanted or now belong to another mod.
      for (const [key, entry] of Object.entries(data.deployed)) {
        const want = desired.get(key);
        if (want && want.owner === entry.owner && this.isIntact(gameDir, entry)) continue;
        try {
          this.removeFile(gameDir, entry);
          result.removed++;
          if (!want && entry.backup && this.restoreBackup(gameDir, entry)) result.restored++;
          if (want && entry.backup) want.backup = entry.backup;
          delete data.deployed[key];
        } catch (err) {
          fail(`Could not remove ${entry.dest}`, err);
        }
      }

      // 2. Put in what is missing.
      for (const [key, want] of desired) {
        if (data.deployed[key]) continue;
        try {
          data.deployed[key] = this.placeFile(gameDir, want, method);
          result.added++;
        } catch (err) {
          fail(`Could not deploy ${want.dest}`, err);
        }
      }

      this.cleanDirs(gameDir);
    } finally {
      this.store.save();
    }
    return result;
  }

  /** Our file is still in place and is still the one we put there. */
  isIntact(gameDir, entry) {
    try {
      const st = fs.statSync(path.join(gameDir, entry.dest), { bigint: true });
      return st.ino.toString() === entry.ino;
    } catch {
      return false;
    }
  }

  /** 'ok' | 'missing' (deleted outside the app) | 'changed' (replaced by something else). */
  fileState(gameDir, entry) {
    try {
      const st = fs.statSync(path.join(gameDir, entry.dest), { bigint: true });
      return st.ino.toString() === entry.ino ? 'ok' : 'changed';
    } catch (err) {
      return err.code === 'ENOENT' ? 'missing' : 'ok';
    }
  }

  /**
   * Drop manifest entries whose files were deleted outside the app (a mod removed by hand).
   * Where we had backed up an original file, it is put back.
   */
  forget(gameDir, keys) {
    for (const key of keys) {
      const entry = this.deployed[key];
      if (!entry) continue;
      if (entry.backup) {
        try { this.restoreBackup(gameDir, entry); } catch (err) { this.log.warn(`Could not restore ${entry.dest}`, err.message); }
      }
      delete this.deployed[key];
    }
    this.cleanDirs(gameDir);
    this.store.save();
  }

  removeFile(gameDir, entry) {
    const full = path.join(gameDir, entry.dest);
    let st;
    try { st = fs.statSync(full, { bigint: true }); } catch (err) {
      if (err.code === 'ENOENT') return; // already gone
      throw err;
    }
    if (st.ino.toString() !== entry.ino) {
      // Something else replaced our file (another tool, a game update). Leave it alone.
      this.log.warn(`${entry.dest} was changed outside this app; left it in place.`);
      return;
    }
    fs.rmSync(full, { force: true });
  }

  /** Put the original back; true when it was. */
  restoreBackup(gameDir, entry) {
    const full = path.join(gameDir, entry.dest);
    if (!fs.existsSync(entry.backup)) {
      this.log.warn(`Backup for ${entry.dest} is missing; nothing to restore.`);
      return false;
    }
    if (fs.existsSync(full)) {
      this.log.warn(`${entry.dest} exists again; kept its backup at ${entry.backup} instead of restoring.`);
      return false;
    }
    if (this.staleOriginal?.(entry.dest, entry.backup)) {
      // Vortex's own copy (it has the file in its staging folder): back in the game, no record would list it.
      fs.rmSync(entry.backup, { force: true });
      this.log.info(`Did not put back ${entry.dest}: it was Vortex's copy, and that mod is off in Vortex now`);
      return false;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    moveFile(entry.backup, full);
    this.log.info(`Restored original ${entry.dest}`);
    return true;
  }

  placeFile(gameDir, want, method) {
    const full = path.join(gameDir, want.dest);
    if (!fs.existsSync(want.src)) throw new Error(`staged file missing (${want.src}); reinstall the mod`);
    this.makeParents(gameDir, path.dirname(want.dest));

    let backup = want.backup || null;
    let movedAside = null;
    if (fs.existsSync(full)) {
      // A file we do not manage: keep it safe before overwriting it. The first original stays the
      // one restored later; a file that replaced ours since is kept beside it.
      let to = path.join(this.backupDir, want.dest);
      if (fs.existsSync(to)) to = `${to}.${Date.now()}`;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      moveFile(full, to);
      movedAside = to;
      if (backup) this.log.warn(`${want.dest} had been replaced outside this app; kept that file at ${to}`);
      else { backup = to; this.log.warn(`Backed up existing ${want.dest} before overwriting it`); }
    }

    let kind = 'copy';
    try {
      if (method === 'hardlink') {
        try {
          fs.linkSync(want.src, full);
          kind = 'link';
        } catch (err) {
          if (!this.warnedLink) {
            this.log.warn(`Hardlink failed (${err.code}); copying files instead. Put the data folder on the game's drive for hardlinks.`);
            this.warnedLink = true;
          }
        }
      }
      if (kind === 'copy') fs.copyFileSync(want.src, full);
    } catch (err) {
      // The mod's file could not be placed: the file that was there goes back.
      if (movedAside) { try { moveFile(movedAside, full); } catch { /* it stays in the backup folder */ } }
      throw err;
    }
    const st = fs.statSync(full, { bigint: true });
    return { dest: want.dest, owner: want.owner, kind, ino: st.ino.toString(), size: Number(st.size), backup };
  }

  makeParents(gameDir, relDir) {
    const created = new Set(this.store.data.createdDirs);
    const parts = relDir.split(/[\\/]/).filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      const full = path.join(gameDir, cur);
      if (!fs.existsSync(full)) {
        fs.mkdirSync(full);
        created.add(cur.toLowerCase());
      }
    }
    this.store.data.createdDirs = [...created];
  }

  /** Remove now-empty folders that this app created, deepest first. */
  cleanDirs(gameDir) {
    const keep = [];
    const dirs = [...this.store.data.createdDirs].sort((a, b) => b.split('/').length - a.split('/').length);
    for (const d of dirs) {
      const full = path.join(gameDir, d);
      try {
        if (!fs.existsSync(full)) continue;
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        else keep.push(d);
      } catch {
        keep.push(d);
      }
    }
    this.store.data.createdDirs = keep;
  }
}

module.exports = { Deployer };
