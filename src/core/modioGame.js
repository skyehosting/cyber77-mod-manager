'use strict';
/*
 * Mods the game's own Mods menu installed (Cyberpunk 2077 2.5+, mod.io inside the game). Read only:
 * this app never installs, removes or switches them; the game does, in its Mods menu.
 *
 * Where (mod.io's SDK, github.com/modio/modio-sdk): a storage root, by default <Public>\mod.io\
 * (FOLDERID_Public), moved by %LOCALAPPDATA%\mod.io\globalsettings.json {"RootLocalStoragePath"}.
 * Under it, per game (5784 is Cyberpunk 2077 on mod.io):
 *   <root>/5784/metadata/state.json   {"Mods":[{ID, Profile (the mod's mod.io details), State, SizeOnDisk, PathOnDisk}], "version":1}
 *   <root>/5784/mods/<ModID>/          the mod's files, as the game loads them
 * State: 0 install pending, 1 installed, 2 update pending, 5 uninstall pending (ModioModCollectionEntry.h).
 * The SDK has no on/off flag: the game keeps that itself, so it is not known here.
 * Never read: %LOCALAPPDATA%\mod.io\5784\<user>\user.json (it holds the player's mod.io sign-in token).
 *
 * Linux: the game runs under Proton, so the same Windows folders are inside its prefix
 * (drive_c/users/Public, drive_c/users/<user>/AppData/Local); found from the prefix, not guessed.
 */
const fs = require('fs');
const path = require('path');
const { siteUrl, cdnUrl, GAME_ID } = require('./modio');

const STATES = { 0: 'install pending', 1: 'installed', 2: 'update pending', 5: 'removal pending' };
const MAX_FILES = 5000; // files listed per mod (for clashes with this app's mods)
const MAX_ALL_FILES = 200000; // and in all
const RECHECK = 30e3; // nothing there (or the folders not known): looked at again after this long
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (child, parent) => child.length > parent.length + 1 && same(child.slice(0, parent.length + 1), parent + path.sep);

const readJson = (file, max = 50 << 20) => {
  try {
    if (fs.statSync(file).size > max) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
};

/** Files under a folder, as relative paths with forward slashes (at most `max`). */
function listFiles(dir, max = MAX_FILES) {
  max = Math.max(0, max);
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

class GameModio {
  /**
   * dirs(): { localAppData, publicDir, driveC } where the game's Windows folders are (Windows: this
   * PC's; Linux: inside the game's Proton prefix; null when not known). driveC maps a "C:/…" root.
   */
  constructor({ dirs, dirsKey = () => '', log }) {
    this.dirs = dirs;
    this.dirsKey = dirsKey;
    this.log = log;
    this.cache = { key: '', value: null };
    this.dirsMemo = { at: 0, value: null };
    this.missing = { file: '', at: 0 }; // a state file that was not there: not looked for again at once
  }

  /** The game's Windows folders, worked out at most every 30 s (on Linux this reads Steam's libraries). */
  gameDirs() {
    const key = String(this.dirsKey() || '');
    if (Date.now() - this.dirsMemo.at > RECHECK || this.dirsMemo.key !== key) this.dirsMemo = { at: Date.now(), key, value: this.dirs?.() || null };
    return this.dirsMemo.value;
  }

  /** The mod.io storage root the game uses (its global settings, else the default), or ''. */
  root() {
    const d = this.gameDirs();
    if (!d) return '';
    const settings = d.localAppData ? readJson(path.join(d.localAppData, 'mod.io', 'globalsettings.json'), 1 << 20) : null;
    let root = typeof settings?.RootLocalStoragePath === 'string' ? settings.RootLocalStoragePath.trim() : '';
    // A network folder (\\server\share, //server) is not looked in: an unreachable one would hold the app up.
    if (/^([\\/]{2})/.test(root)) root = '';
    if (root && d.driveC) {
      // Under Proton the game wrote a Windows path: each drive letter is a link in the prefix's dosdevices
      // (c: is drive_c, z: is /). Anything else is not a place in the prefix.
      const m = root.match(/^([a-z]):[\\/]?(.*)$/i);
      if (m) {
        const rest = m[2].replace(/\\/g, '/');
        const viaLink = path.join(path.dirname(d.driveC), 'dosdevices', `${m[1].toLowerCase()}:`);
        root = m[1].toLowerCase() === 'c' && !fs.existsSync(viaLink) ? path.join(d.driveC, rest) : path.join(viaLink, rest);
      } else if (!root.startsWith('/')) root = '';
    }
    if (root && !path.isAbsolute(root)) root = '';
    return root || (d.publicDir ? path.join(d.publicDir, 'mod.io') : '');
  }

  /** { found, root, mods: [{ id, name, version, fileId, state, url, logo, path, files, size }] } */
  read() {
    const root = this.root();
    const gameDir = root ? path.join(root, String(GAME_ID)) : '';
    const stateFile = gameDir ? path.join(gameDir, 'metadata', 'state.json') : '';
    if (!stateFile || (this.missing.file === stateFile && Date.now() - this.missing.at < RECHECK)) return { found: false, root, mods: [] };
    let mtime = 0;
    try { mtime = fs.statSync(stateFile).mtimeMs; } catch { this.missing = { file: stateFile, at: Date.now() }; return { found: false, root, mods: [] }; }
    this.missing = { file: '', at: 0 };
    let modsTime = 0;
    try { modsTime = fs.statSync(path.join(gameDir, 'mods')).mtimeMs; } catch { /* none yet */ }
    const key = `${stateFile}:${mtime}:${modsTime}`;
    if (this.cache.key === key) return this.cache.value;
    const st = readJson(stateFile);
    const entries = Array.isArray(st?.Mods) ? st.Mods.slice(0, 2000) : [];
    const modsRoot = path.resolve(gameDir, 'mods');
    const mods = [];
    let listed = 0;
    for (const e of entries) {
      const id = Number(e?.ID);
      if (!Number.isInteger(id) || id <= 0) continue;
      const p = e.Profile && typeof e.Profile === 'object' ? e.Profile : {};
      // Its files: where the entry says, if that is inside this game's mods folder; else the usual place.
      let dir = path.join(modsRoot, String(id));
      if (typeof e.PathOnDisk === 'string' && e.PathOnDisk) {
        const given = path.resolve(e.PathOnDisk);
        if (inside(given, modsRoot)) dir = given;
      }
      const nameId = typeof p.name_id === 'string' ? p.name_id : '';
      mods.push({
        id, name: String(p.name || p.Name || nameId || `mod.io mod ${id}`).slice(0, 200),
        version: String(p.modfile?.version || '').slice(0, 60), fileId: Number(p.modfile?.id) || 0,
        state: STATES[Number(e.State)] || 'unknown', installed: Number(e.State) === 1 || Number(e.State) === 2,
        url: siteUrl(p.profile_url || (nameId ? `https://mod.io/g/cyberpunk-2077/m/${encodeURIComponent(nameId)}` : '')),
        logo: cdnUrl(p.logo?.thumb_640x360 || p.logo?.thumb_320x180 || p.logo?.original),
        path: dir, files: listFiles(dir, Math.min(MAX_FILES, MAX_ALL_FILES - listed)), size: Number(e.SizeOnDisk) || 0,
      });
      listed += mods.at(-1).files.length;
    }
    const value = { found: true, root, mods };
    this.cache = { key, value };
    return value;
  }
}

module.exports = { GameModio, listFiles, STATES };
