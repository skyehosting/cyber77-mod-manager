'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/*
 * Finds Cyberpunk 2077 installs from every store that sells it on PC:
 *   Steam            registry → libraryfolders.vdf → appmanifest_1091500.acf
 *   GOG              registry (GOG.com\Games\1423049311, Galaxy or offline installer)
 *   Epic Games       %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item
 *   Xbox / Game Pass <drive>:\XboxGames\Cyberpunk 2077\Content
 * plus the usual default folders on every drive. Each install says which store it came from, so the
 * game can be launched the right way.
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

/** Every Cyberpunk 2077 install on this PC, one entry per folder, with its store. */
async function findInstalls() {
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
  const hit = (await findInstalls()).find(i => i.path.toLowerCase() === path.resolve(dir).toLowerCase());
  if (hit) return hit;
  if (fs.existsSync(path.join(dir, 'steam_api64.dll')) || /steamapps/i.test(dir)) return { store: 'steam', label: STORE_LABEL.steam };
  if (fs.existsSync(path.join(dir, `goggame-${GOG_GAME_ID}.info`))) return { store: 'gog', label: STORE_LABEL.gog };
  return { store: 'custom', label: STORE_LABEL.custom, path: dir };
}

module.exports = { findCyberpunk, findInstalls, storeOf, isGameDir, STEAM_APP_ID, GOG_GAME_ID, STORE_LABEL };
