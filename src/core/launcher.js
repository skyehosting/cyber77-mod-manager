'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { STEAM_APP_ID } = require('./gameFinder');

/** REDmod mods: folders in <game>/mods with an info.json. They load only with -modded. */
function redmodFolders(gameDir) {
  try {
    return fs.readdirSync(path.join(gameDir, 'mods'), { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(gameDir, 'mods', e.name, 'info.json')))
      .map(e => e.name).sort();
  } catch {
    return [];
  }
}
const hasRedmods = gameDir => redmodFolders(gameDir).length > 0;

/**
 * A fingerprint of the REDmods as they are now (folder names, and each file's path, size and
 * time). REDmod deploy has to run again whenever it changes: a mod added, removed or updated.
 */
function redmodFingerprint(gameDir) {
  const h = crypto.createHash('sha1');
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
      else { const st = fs.statSync(p); h.update(`${rel}/${e.name}|${st.size}|${Math.floor(st.mtimeMs)}\n`); }
    }
  };
  for (const name of redmodFolders(gameDir)) walk(path.join(gameDir, 'mods', name), name);
  return h.digest('hex');
}

const redmodTool = gameDir => path.join(gameDir, 'tools', 'redmod', 'bin', 'redMod.exe');

/**
 * Run REDmod deploy, as the game's launcher (and Vortex) do: it builds what the REDmods need into
 * the game folder. Vortex's load order (V2077/modlist.txt) is used when there is one.
 * Resolves { ok, lines } with the tool's output; never throws for a failed deploy.
 */
function deployRedmods(gameDir, { onLine = () => {}, timeoutMs = 20 * 60e3 } = {}) {
  return new Promise(resolve => {
    const exe = redmodTool(gameDir);
    if (!fs.existsSync(exe)) { resolve({ ok: false, lines: ['REDmod tools are not installed (tools\\redmod\\bin\\redMod.exe is missing). Install the free "REDmod" DLC for Cyberpunk 2077.'] }); return; }
    const args = ['deploy', '-reportProgress', '-root', gameDir, `-rttiSchemaPath=${path.join(gameDir, 'tools', 'redmod', 'metadata.json')}`];
    const modlist = path.join(gameDir, 'V2077', 'modlist.txt');
    if (fs.existsSync(modlist)) args.push(`-modlist=${modlist}`);
    const lines = [];
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
    const take = buf => {
      for (const l of String(buf).split(/\r?\n/)) {
        if (!l.trim()) continue;
        lines.push(l.trim());
        if (lines.length > 400) lines.shift();
        onLine(l.trim());
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { child.kill(); lines.push('REDmod deploy took too long and was stopped.'); }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, lines: [...lines, err.message] }); });
    child.on('close', code => {
      clearTimeout(timer);
      const failed = code !== 0 || lines.some(l => /has failed|^ERROR/i.test(l));
      resolve({ ok: !failed, lines });
    });
  });
}

/**
 * Start the game. By default the game's own program runs directly: no Steam "custom arguments"
 * prompt and no CD Projekt launcher (Steam still starts for the game if it is not running).
 * Epic installs go through the Epic Games Launcher, which signs the game in. With
 * mode 'store', Steam installs go through Steam too (it asks to confirm -modded).
 * `openExternal` is Electron's shell.openExternal (passed in so this module stays testable).
 */
async function launchGame({ gameDir, store, epicApp, mode = 'direct' }, openExternal, run = spawn) {
  const exe = path.join(gameDir, 'bin', 'x64', 'Cyberpunk2077.exe');
  if (!fs.existsSync(exe)) throw new Error('Cyberpunk2077.exe was not found. Check the game folder in Settings.');
  const args = hasRedmods(gameDir) ? ['-modded'] : [];
  if (store === 'epic' && epicApp) {
    await openExternal(`com.epicgames.launcher://apps/${encodeURIComponent(epicApp)}?action=launch&silent=true`);
    return { via: 'Epic Games Launcher', args: [] };
  }
  if (store === 'steam' && mode === 'store') {
    await openExternal(`steam://run/${STEAM_APP_ID}//${args.join(' ')}/`);
    return { via: 'Steam', args };
  }
  const child = run(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {}); // reported through the process check
  child.unref();
  return { via: 'the game directly', args };
}

module.exports = { launchGame, hasRedmods, redmodFolders, redmodFingerprint, deployRedmods };
