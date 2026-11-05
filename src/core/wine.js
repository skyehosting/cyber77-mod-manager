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

/** Windows components put into a prefix with winetricks or protontricks (its winetricks.log). */
function prefixComponents(pfx) {
  try {
    const file = path.join(pfx, 'winetricks.log');
    if (fs.statSync(file).size > 1 << 20) return new Set(); // a log that big is not one (and is not read whole)
    return new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(Boolean));
  } catch { return new Set(); }
}

/**
 * What the mod loaders need in the game's prefix and it lacks: Cyber Engine Tweaks needs the Visual
 * C++ 2022 runtime and d3dcompiler_47 (its overlay), RED4ext the runtime (the RED modding wiki's
 * Linux page; the Nexus Mods App checks the same). loaders: 'cet' / 'red4ext'.
 */
function missingComponents(pfx, loaders) {
  const need = new Set();
  if (loaders.includes('cet')) { need.add('vcrun2022'); need.add('d3dcompiler_47'); }
  if (loaders.includes('red4ext')) need.add('vcrun2022');
  const have = prefixComponents(pfx);
  return [...need].filter(c => !have.has(c));
}

/**
 * The command that installs components into a Steam game's prefix: protontricks (installed, or its
 * Flatpak), else protontricks with a note that it needs installing first.
 */
function protontricksCommand(appId, components, { home = os.homedir(), pathEnv = process.env.PATH || '' } = {}) {
  const onPath = !!onPathFile('protontricks', pathEnv);
  const flatpak = !onPath && protontricksFlatpak(home);
  const cmd = `${flatpak ? `flatpak run ${PROTONTRICKS_FLATPAK}` : 'protontricks'} ${appId} ${components.join(' ')}`;
  return { command: cmd, installed: onPath || flatpak };
}

const PROTONTRICKS_FLATPAK = 'com.github.Matoking.protontricks';
/** A program in one of PATH's (absolute) folders: its full path, or ''. */
function onPathFile(name, pathEnv = process.env.PATH || '') {
  for (const d of String(pathEnv).split(path.delimiter)) {
    if (!path.isAbsolute(d)) continue;
    const f = path.join(d, name);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
  }
  return '';
}
const protontricksFlatpak = home => ['/var/lib/flatpak/app', path.join(home, '.local', 'share', 'flatpak', 'app')]
  .some(d => fs.existsSync(path.join(d, PROTONTRICKS_FLATPAK)));

/**
 * How to run a Windows program inside a Steam game's Proton folder: protontricks-launch (installed,
 * or the Flatpak's), as { file, args } to spawn, or null when protontricks is not installed.
 * `target` is the program's Linux path; `args` go to it.
 */
function protontricksLaunch(appId, target, args = [], { home = os.homedir(), pathEnv = process.env.PATH || '' } = {}) {
  const native = onPathFile('protontricks-launch', pathEnv);
  if (native) return { file: native, args: ['--appid', String(appId), target, ...args], via: 'protontricks' };
  const flatpak = onPathFile('flatpak', pathEnv);
  if (flatpak && protontricksFlatpak(home)) {
    return { file: flatpak, args: ['run', `--command=protontricks-launch`, PROTONTRICKS_FLATPAK, '--appid', String(appId), target, ...args], via: 'protontricks (Flatpak)' };
  }
  return null;
}

module.exports = { isPrefix, prefixUser, prefixFolders, prefixFromPath, steamPrefix, prefixComponents, missingComponents, protontricksCommand, protontricksLaunch };
