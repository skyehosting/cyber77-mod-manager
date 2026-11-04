'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { prefixFromPath, steamPrefix, prefixFolders } = require('./wine');

/*
 * Finds Cyberpunk 2077 installs from every store that sells it on PC:
 *   Steam            registry → libraryfolders.vdf → appmanifest_1091500.acf
 *   GOG              registry (GOG.com\Games\1423049311, Galaxy or offline installer)
 *   Epic Games       %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item
 *   Xbox / Game Pass <drive>:\XboxGames\Cyberpunk 2077\Content
 * plus the usual default folders on every drive. Each install says which store it came from, so the
 * game can be launched the right way. On Linux: Steam's folders (native, Flatpak, Snap) → their
 * libraries → appmanifest_1091500.acf, and the game's Proton prefix (wine.js).
 */

const STEAM_APP_ID = '1091500';
const GOG_GAME_ID = '1423049311';
const GAME_EXE = path.join('bin', 'x64', 'Cyberpunk2077.exe');
const STORE_LABEL = { steam: 'Steam', gog: 'GOG', epic: 'Epic Games', xbox: 'Xbox app', custom: 'Other' };

function isGameDir(dir) {
  return !!dir && fs.existsSync(path.join(dir, GAME_EXE));
}

function regQuery(key, value) {
  return new Promise(resolve => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i'));
      resolve(m ? m[1].trim() : null);
    });
  });
}

/** Fixed drive roots that exist (C:\ … Z:\). */
function driveRoots() {
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try { if (fs.existsSync(root)) out.push(root); } catch { /* not ready */ }
  }
  return out;
}

async function steamInstalls() {
  const found = [];
  const steam = (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'))
    || (await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
  const libs = new Set();
  if (steam) {
    const base = path.normalize(steam.replace(/\//g, '\\'));
    libs.add(base);
    try {
      const vdf = fs.readFileSync(path.join(base, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
    } catch { /* no library list */ }
  }
  for (const root of driveRoots()) {
    libs.add(path.join(root, 'SteamLibrary'));
    libs.add(path.join(root, 'Steam'));
  }
  libs.add('C:\\Program Files (x86)\\Steam');
  for (const lib of libs) {
    let installDir = 'Cyberpunk 2077';
    try {
      const acf = fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`), 'utf8');
      installDir = acf.match(/"installdir"\s+"([^"]+)"/)?.[1] || installDir;
    } catch { /* not in this library */ }
    found.push({ store: 'steam', path: path.join(lib, 'steamapps', 'common', installDir) });
  }
  return found;
}

async function gogInstalls() {
  const found = [];
  for (const key of [`HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\${GOG_GAME_ID}`, `HKLM\\SOFTWARE\\GOG.com\\Games\\${GOG_GAME_ID}`]) {
    const p = await regQuery(key, 'path');
    if (p) found.push({ store: 'gog', path: p });
  }
  for (const root of driveRoots()) {
    found.push({ store: 'gog', path: path.join(root, 'GOG Games', 'Cyberpunk 2077') });
    found.push({ store: 'gog', path: path.join(root, 'Program Files (x86)', 'GOG Galaxy', 'Games', 'Cyberpunk 2077') });
  }
  return found;
}

function epicInstalls() {
  const found = [];
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let items = [];
  try { items = fs.readdirSync(dir).filter(f => f.endsWith('.item')); } catch { /* Epic not installed */ }
  for (const f of items) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j.InstallLocation && isGameDir(j.InstallLocation)) found.push({ store: 'epic', path: j.InstallLocation, epicApp: j.AppName });
    } catch { /* unreadable manifest */ }
  }
  for (const root of driveRoots()) found.push({ store: 'epic', path: path.join(root, 'Program Files', 'Epic Games', 'Cyberpunk 2077') });
  return found;
}

function xboxInstalls() {
  const found = [];
  for (const root of driveRoots()) {
    found.push({ store: 'xbox', path: path.join(root, 'XboxGames', 'Cyberpunk 2077', 'Content') });
    found.push({ store: 'xbox', path: path.join(root, 'XboxGames', 'Cyberpunk 2077') });
  }
  return found;
}

// ---------------------------------------------------------------- Linux

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// The system's own answer: links resolved, and the name's real case where case does not count.
const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
/** The Linux home folder (tests point CMM_LINUX_HOME at a made-up one). */
const linuxHome = () => process.env.CMM_LINUX_HOME || os.homedir();

/**
 * Steam's folders on Linux: native (~/.local/share/Steam, which ~/.steam/steam and ~/.steam/root
 * link to), Debian's, Flatpak's and Snap's. Several can be installed at once, each with libraries of
 * its own. A folder counts once it has a library list, and once only (links resolved).
 */
function linuxSteamRoots(home = linuxHome()) {
  const xdg = process.env.XDG_DATA_HOME;
  const data = !process.env.CMM_LINUX_HOME && xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
  const flatpak = path.join(home, '.var', 'app', 'com.valvesoftware.Steam');
  const tries = [
    path.join(data, 'Steam'), path.join(home, '.local', 'share', 'Steam'), path.join(home, '.local', 'share', 'steam'),
    path.join(home, '.steam', 'steam'), path.join(home, '.steam', 'root'), path.join(home, '.steam', 'debian-installation'), path.join(home, '.steam'),
    path.join(flatpak, '.local', 'share', 'Steam'), path.join(flatpak, 'data', 'Steam'), path.join(flatpak, '.steam', 'steam'),
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'), path.join(home, '.snap', 'data', 'steam', 'common', '.local', 'share', 'Steam'),
  ];
  const out = [];
  const seen = new Set();
  for (const dir of tries) {
    if (!fs.existsSync(path.join(dir, 'steamapps', 'libraryfolders.vdf')) && !fs.existsSync(path.join(dir, 'config', 'libraryfolders.vdf'))) continue;
    const r = real(dir);
    if (seen.has(r)) continue;
    seen.add(r);
    // Flatpak's Steam writes library paths as it sees them: its home is ~/.var/app/<id> out here.
    out.push({ dir: r, sandboxHome: r.startsWith(real(flatpak) + path.sep) ? real(flatpak) : '' });
  }
  return out;
}

/** Library folders in a libraryfolders.vdf (either format); libraries marked unmounted are left out. */
function parseLibraryFolders(vdf) {
  const text = String(vdf);
  const unq = s => s.replace(/\\\\/g, '\\');
  const out = [];
  for (const m of text.matchAll(/"\d+"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
    const p = m[1].match(/"path"\s+"((?:[^"\\]|\\.)*)"/i);
    if (p && !/"mounted"\s+"0"/i.test(m[1])) out.push(unq(p[1]));
  }
  // The old format: "1"  "/path/to/library" at the top level (spaces and tabs only: \s would also
  // take line breaks, and rescan every run of blank lines).
  for (const m of text.matchAll(/^[ \t]*"\d+"[ \t]+"((?:[^"\\]|\\.)*)"[ \t]*$/gm)) out.push(unq(m[1]));
  return out;
}

/** Every Steam library on Linux: [{ dir (its steamapps folder's parent), apps (the steamapps folder) }]. */
function linuxSteamLibraries(home = linuxHome()) {
  const libs = [];
  const seen = new Set();
  const add = dir => {
    const apps = ['steamapps', 'SteamApps'].map(n => path.join(dir, n)).find(isDir);
    if (!apps) return;
    const key = real(dir);
    if (seen.has(key)) return;
    seen.add(key);
    libs.push({ dir: key, apps });
  };
  for (const root of linuxSteamRoots(home)) {
    add(root.dir);
    let vdf = '';
    for (const f of ['steamapps', 'config'].map(d => path.join(root.dir, d, 'libraryfolders.vdf'))) {
      try { if (fs.statSync(f).size < 1 << 20) { vdf = fs.readFileSync(f, 'utf8'); break; } } catch { /* the other copy */ }
    }
    for (let p of parseLibraryFolders(vdf)) {
      if (!path.isAbsolute(p)) continue;
      p = path.resolve(p);
      if (root.sandboxHome && !isDir(p) && p.startsWith(home + path.sep)) p = path.join(root.sandboxHome, path.relative(home, p));
      add(p);
    }
  }
  return libs;
}

/**
 * The game in each Steam library on Linux, installed or not yet: { path, library, installed,
 * progress }. Until Steam has finished, the game's folder is empty (files go to downloading/ first)
 * and its manifest lacks the "fully installed" flag (4).
 */
function linuxSteamGames(home = linuxHome()) {
  const out = [];
  for (const lib of linuxSteamLibraries(home)) {
    let acf;
    try { acf = fs.readFileSync(path.join(lib.apps, `appmanifest_${STEAM_APP_ID}.acf`), 'utf8'); } catch { continue; }
    const num = key => Number(acf.match(new RegExp(`"${key}"\\s+"(\\d+)"`, 'i'))?.[1]) || 0;
    // A folder name only (never a path out of the library).
    const name = acf.match(/"installdir"\s+"([^"]+)"/i)?.[1] || '';
    const dir = path.join(lib.apps, 'common', /^[^/\\]+$/.test(name) && name !== '..' && name !== '.' ? name : 'Cyberpunk 2077');
    const installed = (num('StateFlags') & 4) === 4 && isGameDir(dir);
    const total = num('BytesToDownload');
    out.push({ store: 'steam', path: installed ? real(dir) : dir, library: lib.dir, installed, progress: installed ? 1 : total ? Math.min(1, num('BytesDownloaded') / total) : 0 });
  }
  return out;
}

function linuxInstalls(home = linuxHome()) {
  const all = linuxSteamGames(home).filter(g => g.installed);
  for (const dir of [path.join(home, 'Games', 'Cyberpunk 2077'), path.join(home, 'Games', 'Heroic', 'Cyberpunk 2077')]) all.push({ store: 'custom', path: dir });
  const seen = new Map();
  for (const i of all) {
    if (!isGameDir(i.path)) continue;
    const key = real(i.path);
    if (!seen.has(key) || seen.get(key).store === 'custom') seen.set(key, { store: i.store, path: key, label: STORE_LABEL[i.store] });
  }
  return [...seen.values()];
}

/** Steam installs of the game still downloading (Linux): [{ path, progress }]. */
function installingNow() {
  if (process.platform === 'win32') return [];
  return linuxSteamGames().filter(g => !g.installed).map(g => ({ store: 'steam', path: g.path, label: STORE_LABEL.steam, installing: true, progress: g.progress }));
}

/**
 * Where the game keeps its Windows folders (Linux): its Wine/Proton prefix, and in it the saves and
 * crash report folders; null when unknown (Windows, a game never launched yet, no prefix found).
 */
function gameWindowsFolders(gameDir) {
  if (process.platform === 'win32' || !gameDir) return null;
  // Steam's prefixes only for a game in a Steam library (<library>/steamapps/common/<dir>): a GOG or
  // Heroic copy beside a Steam one must never get the Steam copy's saves.
  const dir = path.resolve(gameDir);
  const inSteam = path.basename(path.dirname(dir)) === 'common' && /^steamapps$/i.test(path.basename(path.dirname(path.dirname(dir))));
  const pfx = prefixFromPath(dir) || (inSteam ? steamPrefix(dir, linuxSteamLibraries().map(l => l.dir), STEAM_APP_ID) : '');
  return pfx ? prefixFolders(pfx) : null;
}

/** Every Cyberpunk 2077 install on this PC, one entry per folder, with its store. */
async function findInstalls() {
  if (process.platform !== 'win32') return linuxInstalls();
  const all = [...await steamInstalls(), ...await gogInstalls(), ...epicInstalls(), ...xboxInstalls()];
  for (const root of driveRoots()) {
    all.push({ store: 'custom', path: path.join(root, 'Games', 'Cyberpunk 2077') });
    all.push({ store: 'custom', path: path.join(root, 'Cyberpunk 2077') });
  }
  const seen = new Map();
  for (const i of all) {
    if (!isGameDir(i.path)) continue;
    const key = path.resolve(i.path).toLowerCase();
    // A more specific store wins over a guessed "custom" folder.
    if (!seen.has(key) || seen.get(key).store === 'custom') seen.set(key, { ...i, path: path.resolve(i.path), label: STORE_LABEL[i.store] });
  }
  return [...seen.values()];
}

/** The best install to use when none is chosen yet: Steam, then GOG, Epic, Xbox, other. */
async function findCyberpunk() {
  const order = ['steam', 'gog', 'epic', 'xbox', 'custom'];
  const installs = await findInstalls();
  installs.sort((a, b) => order.indexOf(a.store) - order.indexOf(b.store));
  return installs[0]?.path || null;
}

/** Which store an install folder belongs to (for launching), from the folder alone. */
async function storeOf(dir) {
  if (!isGameDir(dir)) return { store: 'custom', label: STORE_LABEL.custom };
  // Windows paths ignore case; Linux ones don't (and may run through links).
  const key = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : real(p));
  const hit = (await findInstalls()).find(i => key(i.path) === key(dir));
  if (hit) return hit;
  if (fs.existsSync(path.join(dir, 'steam_api64.dll')) || /steamapps/i.test(dir)) return { store: 'steam', label: STORE_LABEL.steam };
  if (fs.existsSync(path.join(dir, `goggame-${GOG_GAME_ID}.info`))) return { store: 'gog', label: STORE_LABEL.gog };
  return { store: 'custom', label: STORE_LABEL.custom, path: dir };
}

/**
 * The game's launch options and last play time in one Steam user's localconfig.vdf (the
 * apps → 1091500 block that holds "LastPlayed" / "LaunchOptions"), or null if it has none.
 */
function parseLaunchOptions(vdf) {
  const unq = s => s.replace(/\\(["\\])/g, '$1');
  for (const m of String(vdf).matchAll(new RegExp(`"${STEAM_APP_ID}"\\s*\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}`, 'g'))) {
    const body = m[1];
    if (!/"(LastPlayed|LaunchOptions|Playtime)"/.test(body)) continue;
    const opt = body.match(/"LaunchOptions"\s+"((?:[^"\\]|\\.)*)"/);
    return { options: opt ? unq(opt[1]) : '', lastPlayed: Number(body.match(/"LastPlayed"\s+"(\d+)"/)?.[1]) || 0 };
  }
  return null;
}

/**
 * Cyberpunk 2077's launch options as Steam has them (Steam → the game's Properties → Launch
 * Options), for the Steam user who played it last. They apply when Steam starts the game itself.
 */
async function steamLaunchOptions() {
  let roots;
  if (process.platform === 'win32') {
    const steam = (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'))
      || (await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
    roots = steam ? [path.normalize(steam.replace(/\//g, '\\'))] : [];
  } else {
    roots = linuxSteamRoots().map(r => r.dir);
  }
  let best = null;
  for (const root of roots) {
    const users = path.join(root, 'userdata');
    let names = [];
    try { names = fs.readdirSync(users); } catch { continue; }
    for (const id of names) {
      let r;
      try { r = parseLaunchOptions(fs.readFileSync(path.join(users, id, 'config', 'localconfig.vdf'), 'utf8')); } catch { continue; }
      if (r && (!best || r.lastPlayed > best.lastPlayed)) best = { ...r, user: id };
    }
  }
  return best;
}

/** The launch options Steam needs for this app's Play: skip the launcher, and load REDmods. */
function missingLaunchOptions(options, needsModded) {
  const have = String(options || '').split(/\s+/).map(s => s.toLowerCase());
  return ['--launcher-skip', needsModded ? '-modded' : ''].filter(o => o && !have.includes(o));
}

module.exports = {
  findCyberpunk, findInstalls, storeOf, isGameDir, STEAM_APP_ID, GOG_GAME_ID, STORE_LABEL, parseLaunchOptions, steamLaunchOptions, missingLaunchOptions,
  installingNow, gameWindowsFolders, linuxSteamRoots, linuxSteamLibraries, linuxSteamGames, parseLibraryFolders,
};
