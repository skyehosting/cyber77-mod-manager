'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { STEAM_APP_ID } = require('./gameFinder');
const { caseResolver } = require('./fileCase');

/** <game>/mods, in the case it has on disk (Linux; the game, under Wine, does not mind the case). */
const modsDir = gameDir => path.join(gameDir, caseResolver(gameDir).resolve('mods', false));

/** REDmod mods: folders in <game>/mods with an info.json. They load only with -modded. */
function redmodFolders(gameDir) {
  try {
    const mods = modsDir(gameDir);
    const hasInfo = name => (process.platform === 'win32' ? fs.existsSync(path.join(mods, name, 'info.json'))
      : fs.readdirSync(path.join(mods, name)).some(f => f.toLowerCase() === 'info.json'));
    return fs.readdirSync(mods, { withFileTypes: true })
      .filter(e => e.isDirectory() && hasInfo(e.name))
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
  for (const name of redmodFolders(gameDir)) walk(path.join(modsDir(gameDir), name), name);
  return h.digest('hex');
}

const redmodTool = gameDir => path.join(gameDir, caseResolver(gameDir).resolve('tools/redmod/bin/redMod.exe', false));

/*
 * Linux: REDmod deploy (a Windows program) runs inside the game's Proton folder through
 * protontricks-launch, as the Nexus Mods App does it. A small batch file goes into the folder's
 * drive_c (Flatpak protontricks can always read there; it cannot read every folder in the home):
 * protontricks sets STEAM_APP_PATH to the game folder, and the batch file starts redMod.exe from its
 * own folder (protontricks before 1.12 ignores the folder it is started in).
 */
const LINUX_BAT = 'cmm-redmod-deploy.bat';
const LINUX_MODLIST = 'cmm-redmod-modlist.txt';
const DEPLOY_BAT = [
  '@echo off',
  'rem Edgerunners Mod Manager: REDmod deploy inside the game\'s Proton folder (run by protontricks-launch).',
  'if "%STEAM_APP_PATH%"=="" (',
  '  echo ERROR: STEAM_APP_PATH is not set: this runs through protontricks-launch only.',
  '  exit /b 1',
  ')',
  'cd /d "%STEAM_APP_PATH%"',
  'cd tools\\redmod\\bin',
  'if not exist redMod.exe (',
  '  echo ERROR: redMod.exe was not found in tools\\redmod\\bin.',
  '  exit /b 1',
  ')',
  'redMod.exe %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n'); // cmd reads CRLF

/** Write a file afresh (never through a link someone left at its name). */
function writeFresh(file, text) {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, text, { flag: 'wx' });
}

/**
 * Linux: put the batch file (and Vortex's REDmod order, CRLF as REDmod needs it) into the Proton
 * folder's drive_c. Returns { bat, args }: the batch file's Linux path and the arguments for redMod.exe.
 */
function linuxDeployFiles(gameDir, prefix) {
  const driveC = path.join(prefix, 'drive_c');
  if (!fs.statSync(driveC).isDirectory()) throw new Error('The game\'s Proton folder has no drive_c.');
  const bat = path.join(driveC, LINUX_BAT);
  writeFresh(bat, DEPLOY_BAT);
  const args = ['deploy', '-reportProgress'];
  const cr = caseResolver(gameDir);
  const order = path.join(gameDir, cr.resolve('V2077/modlist.txt', false));
  const list = path.join(driveC, LINUX_MODLIST);
  if (fs.existsSync(order)) {
    writeFresh(list, fs.readFileSync(order, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('\r\n'));
    args.push(`-modlist=C:\\${LINUX_MODLIST}`);
  } else fs.rmSync(list, { force: true }); // an old order is not used
  // REDmod stops when the folder it deploys into is missing.
  fs.mkdirSync(path.join(gameDir, cr.resolve('r6/cache/modded')), { recursive: true });
  return { bat, args };
}

/**
 * Run REDmod deploy, as the game's launcher (and Vortex) do: it builds what the REDmods need into
 * the game folder. Vortex's load order (V2077/modlist.txt) is used when there is one.
 * Resolves { ok, lines } with the tool's output; never throws for a failed deploy.
 * Linux: `linux` is { prefix, launch(target, args) → { file, args } } (protontricks-launch).
 */
function deployRedmods(gameDir, { onLine = () => {}, timeoutMs = 20 * 60e3, linux = null } = {}) {
  return new Promise(resolve => {
    const exe = redmodTool(gameDir);
    if (!fs.existsSync(exe)) { resolve({ ok: false, lines: ['REDmod tools are not installed (tools\\redmod\\bin\\redMod.exe is missing). Install the free "REDmod" DLC for Cyberpunk 2077.'] }); return; }
    let file = exe;
    let args;
    let opts = { cwd: path.dirname(exe), windowsHide: true };
    if (process.platform === 'win32') {
      args = ['deploy', '-reportProgress', '-root', gameDir, `-rttiSchemaPath=${path.join(gameDir, 'tools', 'redmod', 'metadata.json')}`];
      const modlist = path.join(gameDir, 'V2077', 'modlist.txt');
      if (fs.existsSync(modlist)) args.push(`-modlist=${modlist}`);
    } else {
      try {
        if (!linux?.prefix || !linux.launch) throw new Error('REDmod deploy runs inside the game\'s Proton folder, which is not known.');
        const put = linuxDeployFiles(gameDir, linux.prefix);
        ({ file, args } = linux.launch(put.bat, put.args));
      } catch (err) { resolve({ ok: false, lines: [err.message] }); return; }
      // Its own process group, so a timeout ends Wine's processes too; nothing to read on stdin.
      opts = { cwd: gameDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] };
    }
    const lines = [];
    const child = spawn(file, args, opts);
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
    const timers = [];
    let done = false;
    const finish = res => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(res);
    };
    const signal = sig => { try { if (opts.detached) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* gone */ } };
    timers.push(setTimeout(() => {
      lines.push('REDmod deploy took too long and was stopped.');
      signal('SIGTERM');
      // Wine's processes can outlive a polite stop: then the whole group, and an answer either way.
      timers.push(setTimeout(() => signal('SIGKILL'), 5000));
      timers.push(setTimeout(() => finish({ ok: false, lines }), 10000));
    }, timeoutMs));
    child.on('error', err => finish({ ok: false, lines: [...lines, err.message] }));
    const result = code => ({ ok: code === 0 && !lines.some(l => /has failed|^ERROR/i.test(l)), lines });
    child.on('close', code => finish(result(code)));
    // A program it started (Wine's wineserver) can keep the output open after it ended: not waited for.
    child.on('exit', code => timers.push(setTimeout(() => finish(result(code)), 3000)));
  });
}

/**
 * Start the game. By default the game's own program runs directly: no Steam "custom arguments"
 * prompt and no CD Projekt launcher (Steam still starts for the game if it is not running).
 * Epic installs go through the Epic Games Launcher, which signs the game in. With
 * mode 'steam', Steam installs are started by Steam itself (its overlay works). Steam asks to
 * confirm any arguments another program passes, so none are passed: the game's own Steam launch
 * options (--launcher-skip -modded) do that job.
 * `openExternal` is Electron's shell.openExternal (passed in so this module stays testable).
 */
async function launchGame({ gameDir, store, epicApp, mode = 'direct' }, openExternal, run = spawn) {
  const exe = path.join(gameDir, 'bin', 'x64', 'Cyberpunk2077.exe');
  if (!fs.existsSync(exe)) throw new Error('Cyberpunk2077.exe was not found. Check the game folder in Settings.');
  if (process.platform !== 'win32') {
    // Linux: the game is the Windows build; only Steam (through Proton) can start it from here.
    if (store !== 'steam') throw new Error('On Linux this app starts Steam copies of the game. Start this copy from its own launcher (Heroic, Lutris).');
    await openExternal(`steam://rungameid/${STEAM_APP_ID}`);
    return { via: 'Steam', args: [] };
  }
  const args = hasRedmods(gameDir) ? ['-modded'] : [];
  if (store === 'epic' && epicApp) {
    await openExternal(`com.epicgames.launcher://apps/${encodeURIComponent(epicApp)}?action=launch&silent=true`);
    return { via: 'Epic Games Launcher', args: [] };
  }
  if (store === 'steam' && (mode === 'steam' || mode === 'store')) {
    await openExternal(`steam://rungameid/${STEAM_APP_ID}`);
    return { via: 'Steam (with its overlay)', args: [] };
  }
  const child = run(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {}); // reported through the process check
  child.unref();
  return { via: 'the game directly', args };
}

/** Whether CD Projekt's REDmod tools (a free DLC) are installed: without them REDmods cannot be deployed. */
const redmodToolsInstalled = gameDir => fs.existsSync(redmodTool(gameDir));

module.exports = { launchGame, hasRedmods, redmodFolders, redmodFingerprint, deployRedmods, redmodToolsInstalled, linuxDeployFiles, DEPLOY_BAT };
