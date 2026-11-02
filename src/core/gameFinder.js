'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CP2077_APP_ID = '1091500';
const GAME_EXE = path.join('bin', 'x64', 'Cyberpunk2077.exe');

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

/** Library folders listed in steamapps/libraryfolders.vdf. */
function steamLibraries(steamPath) {
  const libs = [steamPath];
  try {
    const vdf = fs.readFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  } catch { /* no vdf */ }
  return [...new Set(libs.map(p => path.normalize(p)))];
}

/** Find the Steam install of Cyberpunk 2077 (registry → library folders → app manifest). */
async function findCyberpunk() {
  const candidates = [];
  const steam = (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'))
    || (await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
  if (steam) {
    for (const lib of steamLibraries(steam.replace(/\//g, '\\'))) {
      let installDir = 'Cyberpunk 2077';
      try {
        const acf = fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${CP2077_APP_ID}.acf`), 'utf8');
        installDir = acf.match(/"installdir"\s+"([^"]+)"/)?.[1] || installDir;
      } catch { /* not in this library */ }
      candidates.push(path.join(lib, 'steamapps', 'common', installDir));
    }
  }
  candidates.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077');
  candidates.push('C:\\Program Files (x86)\\GOG Galaxy\\Games\\Cyberpunk 2077');
  candidates.push('C:\\Program Files\\Epic Games\\Cyberpunk 2077');
  return candidates.find(isGameDir) || null;
}

module.exports = { findCyberpunk, isGameDir };
