'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { STEAM_APP_ID } = require('./gameFinder');

/** REDmod mods only load when the game starts with -modded. */
function hasRedmods(gameDir) {
  try {
    return fs.readdirSync(path.join(gameDir, 'mods'), { withFileTypes: true })
      .some(e => e.isDirectory() && fs.existsSync(path.join(gameDir, 'mods', e.name, 'info.json')));
  } catch {
    return false;
  }
}

/**
 * Start the game the way its store expects: Steam and Epic through their launchers (so overlays,
 * cloud saves and DRM work), GOG / Xbox / other installs by running the game directly.
 * `openExternal` is Electron's shell.openExternal (passed in so this module stays testable).
 */
async function launchGame({ gameDir, store, epicApp }, openExternal) {
  const exe = path.join(gameDir, 'bin', 'x64', 'Cyberpunk2077.exe');
  if (!fs.existsSync(exe)) throw new Error('Cyberpunk2077.exe was not found. Check the game folder in Settings.');
  const args = hasRedmods(gameDir) ? ['-modded'] : [];
  if (store === 'steam') {
    await openExternal(`steam://run/${STEAM_APP_ID}//${args.join(' ')}/`);
    return { via: 'Steam', args };
  }
  if (store === 'epic' && epicApp) {
    await openExternal(`com.epicgames.launcher://apps/${encodeURIComponent(epicApp)}?action=launch&silent=true`);
    return { via: 'Epic Games Launcher', args: [] };
  }
  const child = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {}); // reported through the process check
  child.unref();
  return { via: 'the game executable', args };
}

module.exports = { launchGame, hasRedmods };
