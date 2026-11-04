'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Wine and Proton prefixes (Linux). There the game is the Windows build, run through Proton (Steam)
 * or Wine, and what it keeps in Windows folders lives inside its prefix:
 *   <prefix>/drive_c/users/<user>/Saved Games/CD Projekt Red/Cyberpunk 2077      saves
 *   <prefix>/drive_c/users/<user>/AppData/Local/REDEngine/ReportQueue            crash reports
 * Steam's Proton keeps a game's prefix in <library>/steamapps/compatdata/<appid>/pfx, made at the
 * game's first launch, with the user "steamuser". Research: the Linux port audit (1.1, 7.1, 19).
 */

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/** A Wine prefix: drive_c and its registry files. */
function isPrefix(dir) {
  return !!dir && isDir(path.join(dir, 'drive_c')) && (fs.existsSync(path.join(dir, 'user.reg')) || fs.existsSync(path.join(dir, 'system.reg')));
}

/**
 * The Windows user folder inside a prefix: steamuser (Proton), the Linux user's name (Wine), or the
 * one that is there (umu, Lutris and Bottles may have both, one linked to the other). '' if none.
 */
function prefixUser(pfx, user = linuxUser()) {
  const users = path.join(pfx, 'drive_c', 'users');
  for (const name of ['steamuser', user]) if (name && isDir(path.join(users, name))) return name;
  try {
    return fs.readdirSync(users).find(n => n !== 'Public' && isDir(path.join(users, n))) || '';
  } catch { return ''; }
}
function linuxUser() {
  try { return os.userInfo().username; } catch { return process.env.USER || ''; }
}

/** The game's Windows folders inside a prefix, or null when the prefix has no user folder yet. */
function prefixFolders(pfx) {
  const user = isPrefix(pfx) ? prefixUser(pfx) : '';
  if (!user) return null;
  const home = path.join(pfx, 'drive_c', 'users', user);
  return {
    prefix: pfx, user,
    saves: path.join(home, 'Saved Games', 'CD Projekt Red', 'Cyberpunk 2077'),
    crashDir: path.join(home, 'AppData', 'Local', 'REDEngine', 'ReportQueue'),
  };
}

/** A game installed inside a prefix (…/drive_c/GOG Games/Cyberpunk 2077): that prefix, else ''. */
function prefixFromPath(dir) {
  let d = path.resolve(dir);
  for (;;) {
    const up = path.dirname(d);
    if (up === d) return '';
    if (path.basename(d) === 'drive_c') return isPrefix(up) ? up : '';
    d = up;
  }
}

/**
 * A Steam game's Proton prefix: compatdata/<appid>/pfx in the game's own library (where Steam makes
 * it), else in any other library (a game moved since, an SD card); several: the one launched last
 * (pfx.lock is touched at each launch). '' before the game's first launch.
 */
function steamPrefix(gameDir, libraries, appId) {
  const own = path.resolve(gameDir, '..', '..', '..'); // <library>/steamapps/common/<installdir>
  const pfxIn = lib => path.join(lib, 'steamapps', 'compatdata', String(appId), 'pfx');
  const seen = new Set();
  const found = [];
  for (const lib of [own, ...libraries]) {
    const p = pfxIn(lib);
    const key = real(p);
    if (seen.has(key) || !isPrefix(p)) continue;
    seen.add(key);
    found.push(p);
  }
  if (!found.length) return '';
  const ownKey = real(pfxIn(own));
  const used = p => { try { return fs.statSync(path.join(path.dirname(p), 'pfx.lock')).mtimeMs; } catch { return 0; } };
  found.sort((a, b) => (real(b) === ownKey) - (real(a) === ownKey) || used(b) - used(a));
  return found[0];
}

module.exports = { isPrefix, prefixUser, prefixFolders, prefixFromPath, steamPrefix };
