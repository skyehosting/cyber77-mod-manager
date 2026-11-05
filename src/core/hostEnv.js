'use strict';
const path = require('path');

/*
 * Linux AppImage: its launcher (AppRun) puts the AppImage's own folders first on PATH,
 * LD_LIBRARY_PATH, XDG_DATA_DIRS and GSETTINGS_SCHEMA_DIR, and the AppImage carries libraries of its
 * own (libXss, libXtst, libappindicator, ...). Every program the app starts would inherit them:
 * Steam (through steam:// links), protontricks and Wine, 7-Zip, xdg-open. Those get the computer's own
 * settings instead. The app itself has loaded what it needs by then (the library path is read once,
 * when a program starts), and Electron's own helper processes need none of those libraries (none is
 * among the app binary's NEEDED ones; they are tray and notification helpers the main process loads).
 * The AppImage carries no GSettings schemas (usr/share holds only its icons).
 */
const VARS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'];

/**
 * Whether this process is an AppImage's: APPIMAGE and APPDIR set, and its program inside APPDIR (a
 * copy installed otherwise but started from another AppImage's terminal inherits both variables).
 */
function runsAsAppImage(env = process.env, execPath = process.execPath) {
  if (!env.APPIMAGE || !env.APPDIR || !path.isAbsolute(env.APPDIR)) return false;
  const appDir = path.resolve(env.APPDIR);
  return path.resolve(execPath).startsWith(`${appDir}${path.sep}`);
}

/** `env` without the AppImage's own folders (entries in or under APPDIR); changed in place. */
function dropAppImagePaths(env, execPath = process.execPath) {
  const appDir = runsAsAppImage(env, execPath) ? path.resolve(env.APPDIR) : '';
  if (!appDir) return env;
  const inside = p => { const r = path.resolve(p); return r === appDir || r.startsWith(`${appDir}${path.sep}`); };
  for (const name of VARS) {
    if (typeof env[name] !== 'string') continue;
    const kept = env[name].split(':').filter(p => p && !(path.isAbsolute(p) && inside(p)));
    if (kept.length) env[name] = kept.join(':');
    else delete env[name];
  }
  return env;
}

module.exports = { dropAppImagePaths, runsAsAppImage };
