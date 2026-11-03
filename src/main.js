'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, screen, session } = require('electron');
const { logger } = require('./core/logger');
const { Settings } = require('./core/settings');
const { ModManager } = require('./core/manager');
const { findCyberpunk, findInstalls, storeOf, isGameDir, steamLaunchOptions, missingLaunchOptions, STEAM_APP_ID } = require('./core/gameFinder');
const { launchGame, hasRedmods, redmodFolders, redmodFingerprint, deployRedmods, redmodToolsInstalled } = require('./core/launcher');
const { GameLogMonitor, ownerRoot } = require('./core/gameLogs');
const { PlayHistory } = require('./core/plays');
const { scaleFor, stepScale } = require('./core/scale');
const { buildReport } = require('./core/report');
const nxm = require('./core/nxmHandler');
const { AppUpdater } = require('./core/updater');
const { Assistant } = require('./core/ai');
const { makeTools } = require('./core/aiTools');
const { WebReader } = require('./core/web');
const { GameFiles } = require('./core/gameFiles');
const { ModConfig } = require('./core/modConfig');
const { CrashReports } = require('./core/crashes');

let win = null;
let settings = null;
let manager = null;
let gameLogs = null;
let updater = null;
let assistant = null;
let modConfig = null;
let crashes = null;
let plays = null;
let lastExport = '';

const cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: s => safeStorage.encryptString(s).toString('base64'),
  decrypt: s => safeStorage.decryptString(Buffer.from(s, 'base64')),
};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let snapshotTimer = null;
function pushSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => send('snapshot', { ...manager.snapshot(), gameStatus: gameLogs?.status() }), 50);
}

/** Register an IPC handler whose errors are logged to the console and returned as { error }. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: await fn(...args) };
    } catch (err) {
      logger.error(err.message, err.stack);
      return { error: err.message };
    }
  });
}

// A separate profile (screenshots, tests) never touches the real settings or library.
if (process.env.CMM_USER_DATA) app.setPath('userData', process.env.CMM_USER_DATA);

let scaleState = null;

/**
 * Scale the window's content (src/core/scale.js): Windows' scale for the display the window is on, or
 * the one chosen in Settings → Display instead of it.
 */
function applyScale() {
  if (!win || win.isDestroyed()) return null;
  const display = screen.getDisplayMatching(win.getBounds());
  const { zoom, min, state } = scaleFor({ want: Number(settings?.get('uiScale')) || 0, system: display.scaleFactor, area: display.workAreaSize });
  if (Math.abs(win.webContents.getZoomFactor() - zoom) > 0.001) win.webContents.setZoomFactor(zoom);
  win.setMinimumSize(min.width, min.height);
  // A larger scale needs a larger window: grow it to the new minimum (Windows does not do it itself).
  const [w, h] = win.getSize();
  if (!win.isMaximized() && !win.isFullScreen() && (w < min.width || h < min.height)) win.setSize(Math.max(w, min.width), Math.max(h, min.height));
  scaleState = state;
  send('scale', scaleState);
  return scaleState;
}

/** Last window bounds, kept only if they still fit on a connected display. */
function savedBounds(file) {
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 10 && b.y < a.y + a.height - 100;
    });
    return visible ? b : null;
  } catch {
    return null;
  }
}

function createWindow() {
  const boundsFile = path.join(app.getPath('userData'), 'window.json');
  // Size from the screen the window opens on, in DIPs, so it suits any resolution and Windows scale.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.round(Math.min(Math.max(area.width * 0.78, 940), 1680));
  const height = Math.round(Math.min(Math.max(area.height * 0.82, 600), 1050));
  const saved = savedBounds(boundsFile);
  // Screenshot runs (tools/capture.js) render off-screen so nothing pops up on the desktop.
  const capture = !!process.env.CMM_CAPTURE;
  win = new BrowserWindow({
    width: saved?.width || width,
    height: saved?.height || height,
    x: capture ? -32000 : saved?.x,
    y: capture ? -32000 : saved?.y,
    skipTaskbar: capture,
    focusable: !capture,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: '#0f1115',
    title: 'Cyber Mod Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !capture,
      // The Browse page shows Nexus mod pages in a <webview> (locked down in guardWebviews).
      webviewTag: true,
    },
  });
  if (saved?.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    try { fs.writeFileSync(boundsFile, JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* not critical */ }
  };
  win.on('close', saveBounds);

  // Ctrl + / Ctrl - step the app's scale (kept in Settings → Display); Ctrl 0 goes back to Windows' scale.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const cur = scaleState?.effective || 100;
    let next = null;
    if (input.key === '=' || input.key === '+') next = stepScale(cur, 1);
    else if (input.key === '-') next = stepScale(cur, -1);
    else if (input.key === '0') next = 0;
    if (next === null) return;
    event.preventDefault();
    settings.update({ uiScale: next });
    applyScale();
    send('settings-changed');
  });
  // The content's scale: once loaded, and again when the window moves to a display with another scale.
  win.webContents.on('did-finish-load', applyScale);
  let movedTimer = null;
  win.on('moved', () => { clearTimeout(movedTimer); movedTimer = setTimeout(applyScale, 300); });
  win.webContents.on('will-navigate', ev => ev.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('render-process-gone', (_e, d) => logger.error(`Window crashed: ${d.reason}`));
}

async function boot() {
  const userData = app.getPath('userData');
  settings = new Settings(userData, cipher);
  logger.setFile(path.join(userData, 'logs', `${new Date().toISOString().slice(0, 10)}.log`));
  logger.setHistory(path.join(userData, 'logs', 'manager-history.jsonl'));
  logger.on('entry', e => send('log', e));
  // One line per start: which version, and whether the saved settings and API key were there.
  logger.info(`Cyber Mod Manager ${app.getVersion()} started${process.argv.includes('--updated') ? ' after an update' : ''}: settings ${settings.store.restored ? 'restored from their backup' : 'loaded'}, API key ${settings.apiKey ? 'found' : settings.get('apiKeyEnc') ? 'saved but could not be read' : 'not set'}`);

  if (!isGameDir(settings.get('gamePath'))) {
    const found = await findCyberpunk();
    if (found) {
      settings.update({ gamePath: found });
      logger.info(`Found Cyberpunk 2077 at ${found}`);
    } else {
      logger.warn('Cyberpunk 2077 was not found automatically. Set its folder on the Settings page.');
    }
  }

  manager = new ModManager({ settings, log: logger });
  manager.on('changed', pushSnapshot);
  manager.on('job', job => send('job', job));
  manager.on('fomod', req => send('fomod', req));
  manager.startHealthChecks();
  manager.startVortexWatch();
  applyNxmSetting().catch(err => logger.error('Could not set the Nexus link handler', err.message));
  updater = new AppUpdater({
    autoUpdater: app.isPackaged ? require('electron-updater').autoUpdater : null,
    enabled: app.isPackaged && !process.env.CMM_CAPTURE,
    getSchedule: () => ({ every: settings.get('updateEvery'), unit: settings.get('updateUnit'), mode: settings.get('updateMode') }),
    isBusy: () => manager.busy || !!redmodRunning || manager.exporting > 0, // a restart would cut these off
    aiBusy: () => !!(assistant?.busy || assistant?.waiting),
    // No checks and no restarts while the game runs; a restart only while the window can be seen.
    gameRunning: () => !!gameLogs?.status().running || !!plays?.current, // and while a play is still saving its logs
    inView: () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
    log: logger,
  });
  updater.on('state', st => send('update', { ...st, current: app.getVersion() }));
  updater.start();
  if (settings.apiKey) {
    manager.validateKey().then(u => send('key-user', u)).catch(err => logger.warn('Could not check the Nexus API key', err.message));
    manager.resolveSoon(); // mods that know their Nexus mod but not the exact file (moved from Vortex): look them up once
  }
  applyAdBlock();

  gameLogs = new GameLogMonitor({
    getGameDir: () => settings.get('gamePath'),
    log: logger,
    crashDir: path.join(process.env.LOCALAPPDATA || '', 'REDEngine', 'ReportQueue'),
    knownFile: path.join(app.getPath('userData'), 'found-logs.json'),
  });
  gameLogs.on('entries', batch => send('gamelog', batch));
  logger.on('entry', e => {
    if (e.level === 'warn' || e.level === 'error') gameLogs.report(e.level, e.detail ? `${e.message}: ${e.detail.split('\n')[0]}` : e.message);
  });
  gameLogs.on('game', status => { send('gamestatus', status); pushSnapshot(); updater?.gameChanged(!!status.running); });
  gameLogs.on('reset', () => send('gamelog-reset'));
  // Each play's logs as their own set (before start: the first news can be that the game runs).
  plays = new PlayHistory({ dir: path.join(app.getPath('userData'), 'logs', 'plays'), logs: gameLogs, log: logger, keep: () => settings.get('playsKeep'), profile: () => {
    const pr = manager.data.profiles;
    const p = pr?.list?.[pr.active];
    return p ? { id: pr.active, name: p.name } : null;
  } });
  plays.on('plays', list => send('plays', list));
  gameLogs.start();
  plays.recover(); // a play the app was closed during: finish it now that the logs are found
  screen.on('display-metrics-changed', () => applyScale());
  screen.on('display-removed', () => applyScale());
  app.on('before-quit', () => {
    gameLogs.stop();
    // A play the game has left (its last minute of logs not saved yet) is saved now, not lost.
    if (plays?.current?.closeTimer) { clearTimeout(plays.current.closeTimer); plays.finish(); }
  });
  // The AI assistant (after the game-log monitor, which its tools read): read tools see everything; changes only through approved proposals.
  const gameFiles = new GameFiles({ getGameDir: () => manager.gameDir(), owners: () => manager.fileOwners(), ownerRoot });
  crashes = new CrashReports({ dir: () => path.join(process.env.LOCALAPPDATA || '', 'REDEngine', 'ReportQueue'), gameDir: () => manager.gameDir(), gameLogs, files: gameFiles });
  // A crash: the window says so wherever the user is, and the Crashes view shows it.
  gameLogs.on('crash', id => send('crash', crashes.list(1)[0] || { id }));
  modConfig = new ModConfig({ manager, files: gameFiles, ownerRoot, backupDir: path.join(app.getPath('userData'), 'edited-originals') });
  const tools = makeTools({
    manager, gameLogs, logger, web: new WebReader(), files: gameFiles, config: modConfig, crashes, plays,
    allMods: () => {
      const snap = manager.snapshot();
      return [...snap.mods, ...(snap.vortex?.mods || []).map(v => ({ ...v, vortex: true }))];
    },
    deployRedmods: () => runRedmodDeploy(settings.get('gamePath'), true),
    redmodStatus: () => redmodStatus(),
  });
  assistant = new Assistant({ settings, tools, file: path.join(app.getPath('userData'), 'ai-chat.json') });
  assistant.on('event', e => send('ai', e));

  handle('snapshot', () => ({ ...manager.snapshot(), gameStatus: gameLogs.status() }));
  handle('logs', () => logger.entries);
  handle('gamelog:snapshot', () => ({ entries: gameLogs.entries.slice(-4000), sources: gameLogs.sources(), status: gameLogs.status() }));
  handle('gamelog:sources', () => gameLogs.sources());
  handle('crash:list', () => crashes.list(30));
  handle('crash:details', id => crashes.details(String(id || 'latest')));
  handle('crash:open', id => { const c = crashes.list(50).find(x => x.id === id); if (c) shell.openPath(c.folder); });
  handle('crash:delete', ids => crashes.remove(ids));
  handle('scale:get', () => applyScale() || scaleState);
  handle('plays:list', () => plays.list());
  handle('plays:get', id => { const p = plays.get(String(id)); if (!p) throw new Error("That play's logs are no longer here."); return { ...p, entries: p.entries.slice(-8000) }; });
  handle('plays:delete', ids => plays.remove(Array.isArray(ids) ? ids.map(String) : [String(ids)]));
  handle('plays:openFile', (id, rel) => shell.openPath(plays.filePath(String(id), String(rel))));
  handle('plays:revealFile', (id, rel) => shell.showItemInFolder(plays.filePath(String(id), String(rel))));
  handle('plays:openFolder', id => shell.openPath(plays.folder(String(id))));
  // A file inside the game folder (not a sibling folder named like it), by its path relative to it.
  const gameFile = rel => {
    const root = path.resolve(settings.get('gamePath') || '');
    const full = path.resolve(root, String(rel));
    const inside = path.relative(root, full);
    if (!settings.get('gamePath') || !inside || inside.startsWith('..') || path.isAbsolute(inside) || inside.includes(':')) throw new Error('Not a game file');
    return full;
  };
  handle('gamelog:reveal', rel => shell.showItemInFolder(gameFile(rel)));
  // Opening runs the file's program: logs and text files only, never a program in the game folder.
  handle('gamelog:open', rel => {
    const full = gameFile(rel);
    if (!/\.(log|txt|json|ini|toml|yaml|yml|xml|cfg|csv|md)$/i.test(full)) throw new Error('Only log and text files open from here.');
    return shell.openPath(full);
  });
  handle('settings:get', () => settings.publicView());
  handle('settings:set', patch => {
    const before = settings.get('dataDir');
    const gameBefore = settings.get('gamePath');
    settings.update(patch);
    if (settings.get('dataDir') !== before) logger.warn('Data folder changed. Restart the app to use it.');
    if (settings.get('gamePath') !== gameBefore) gameLogs.reset();
    if ('handleNxm' in patch) applyNxmSetting().catch(err => logger.error('Could not change the Nexus link handler', err.message));
    if ('blockAds' in patch) applyAdBlock();
    if ('playsKeep' in patch) plays?.prune();
    if ('uiScale' in patch) applyScale();
    if ('updateEvery' in patch || 'updateUnit' in patch || 'updateMode' in patch) updater?.start();
    logger.success('Settings saved');
    pushSnapshot();
    return settings.publicView();
  });
  handle('settings:validateKey', () => manager.validateKey());
  handle('settings:detectGame', async () => {
    const found = await findCyberpunk();
    if (!found) throw new Error('Cyberpunk 2077 not found in any Steam library. Browse to its folder instead.');
    settings.update({ gamePath: found });
    logger.success(`Found Cyberpunk 2077 at ${found}`);
    pushSnapshot();
    return settings.publicView();
  });
  handle('dialog:folder', async title => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (title, filters) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile', 'multiSelections'], filters });
    return r.canceled ? null : r.filePaths;
  });
  handle('links:add', text => manager.addLinks(text));
  handle('links:plan', text => manager.planLinks(text));
  handle('links:queue', (token, deps, files) => manager.queuePlan(token, deps, files));
  handle('game:installs', () => findInstalls());
  handle('steam:launchOptions', async () => {
    const found = await steamLaunchOptions();
    return found ? { options: found.options, missing: missingLaunchOptions(found.options, true) } : null;
  });
  handle('steam:openGame', () => shell.openExternal(`steam://nav/games/details/${STEAM_APP_ID}`));
  // Play: REDmod deploy first when the REDmods changed since the last one, then the game.
  handle('game:launch', async ({ skipDeploy = false, skipSteamCheck = false } = {}) => {
    const dir = settings.get('gamePath');
    if (!isGameDir(dir)) throw new Error('Set the Cyberpunk 2077 folder in Settings first.');
    if (!skipDeploy) {
      const r = await runRedmodDeploy(dir, false);
      if (r && !r.ok) return { deployFailed: true, missingTools: !!r.missingTools, reason: r.reason };
    }
    const store = await storeOf(dir);
    // Through Steam: the game's Steam launch options must skip the launcher (and load REDmods).
    if (store.store === 'steam' && ['steam', 'store'].includes(settings.get('launchMode')) && !skipSteamCheck) {
      const found = await steamLaunchOptions();
      const missing = missingLaunchOptions(found?.options, true);
      if (missing.length) return { steamOptions: { current: found?.options || '', missing, suggested: [found?.options, ...missing].filter(Boolean).join(' ') } };
    }
    const r = await launchGame({ gameDir: dir, store: store.store, epicApp: store.epicApp, mode: settings.get('launchMode') }, url => shell.openExternal(url));
    logger.success(`Launching Cyberpunk 2077 through ${r.via}${r.args.length ? ` (${r.args.join(' ')}, for REDmod)` : ''}`);
    return r;
  });
  handle('redmod:deploy', () => runRedmodDeploy(settings.get('gamePath'), true));
  handle('redmod:status', () => redmodStatus());
  // How to get the free REDmod tools for the store this copy of the game came from.
  handle('redmod:help', async () => {
    const store = await storeOf(settings.get('gamePath'));
    return { store: store.store, label: store.label, ...(REDMOD_HELP[store.store] || REDMOD_HELP.other) };
  });
  handle('redmod:getTools', async () => {
    const store = await storeOf(settings.get('gamePath'));
    const help = REDMOD_HELP[store.store] || REDMOD_HELP.other;
    await shell.openExternal(help.url);
    return { store: store.store, url: help.url };
  });
  handle('ai:view', () => assistant.view());
  handle('ai:send', text => { assistant.send(text).catch(err => send('ai', { type: 'item', item: { id: String(Date.now()), type: 'error', text: err.message } })); return true; });
  handle('ai:stop', () => assistant.stop());
  handle('ai:decide', (id, approve, values) => assistant.decide(String(id), !!approve, values || {}));
  // Mod config: every mod's files, and the built-in editor.
  handle('cfg:list', () => modConfig.list());
  handle('cfg:files', key => modConfig.modFiles(String(key)));
  handle('cfg:read', loc => {
    const { full, ...r } = modConfig.read(loc);
    return r;
  });
  handle('cfg:write', (loc, text, opts) => {
    try {
      const r = modConfig.write(loc, text, opts || {});
      logger.success(`Saved ${loc.rel}${loc.base === 'game' ? '' : ' (stored copy)'}`);
      return r;
    } catch (err) {
      if (err.conflict) return { conflict: true };
      throw err;
    }
  });
  handle('cfg:restore', loc => {
    const { full, ...r } = modConfig.restore(loc);
    logger.info(`Put back the original ${loc.rel}`);
    return r;
  });
  handle('cfg:show', loc => shell.showItemInFolder(modConfig.resolve(loc)));
  handle('cfg:twins', (loc, others) => modConfig.twins(loc, others || []));
  handle('cfg:writeLike', (loc, text) => {
    const r = modConfig.writeLike(loc, text);
    logger.success(`Saved ${loc.rel} (${loc.base === 'vortex' ? "Vortex's copy" : loc.base === 'app' ? 'stored copy' : 'game folder'})`);
    return r;
  });
  handle('ai:clear', () => assistant.clear());
  handle('ai:test', () => assistant.test());
  // Links in the assistant's answers open in the user's browser (web pages only).
  handle('open:link', url => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url)); });
  handle('loadorder:get', () => manager.loadOrderView());
  handle('loadorder:save', order => manager.saveLoadOrder(order));
  handle('loadorder:auto', () => manager.autoSortLoadOrder());
  handle('loadorder:reset', () => manager.resetLoadOrder());
  // Stop: close the game (asked twice in the window). A normal close first, then a forced one.
  handle('game:stop', async () => {
    const pid = gameLogs.status().pid;
    if (!pid) throw new Error('Cyberpunk 2077 is not running.');
    const { execFile } = require('child_process');
    const kill = force => new Promise(r => execFile('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true }, () => r()));
    const alive = () => new Promise(r => execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (_e, out) => r(String(out).includes(`"${pid}"`))));
    await kill(false);
    for (let i = 0; i < 10 && await alive(); i++) await new Promise(r => setTimeout(r, 500));
    if (await alive()) await kill(true);
    logger.info('Closed Cyberpunk 2077 (Stop)');
    return true;
  });
  // One report for both export buttons: every error and warning, and every mod with its state.
  handle('logs:history', () => logger.history);
  handle('nxm:status', () => nxmStatus());
  handle('vortex:adoptPreview', () => manager.vortexAdoptPreview('all'));
  handle('vortex:adopt', ids => manager.adoptFromVortex(Array.isArray(ids) ? ids : 'all'));
  handle('update:state', () => ({ ...updater.state, current: app.getVersion() }));
  handle('update:check', () => updater.check());
  handle('update:postpone', () => updater.postpone());
  handle('update:install', () => updater.installNow());
  // The switch applies at once (not with Save): Settings shows the result right away.
  handle('nxm:set', async on => {
    settings.update({ handleNxm: !!on });
    return applyNxmSetting();
  });
  handle('browse:search', opts => manager.nexus.searchMods(opts || {}));
  handle('browse:categories', () => manager.nexus.modCategories());
  handle('browse:open', url => { if (NEXUS_PAGE.test(String(url))) shell.openExternal(String(url)); });
  handle('export:json', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const r = await dialog.showSaveDialog(win, {
      title: 'Export diagnostics report',
      defaultPath: path.join(app.getPath('documents'), `cyberpunk-mods-report-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    let vortex = null;
    try { vortex = manager.vortex.read(); } catch { /* unreadable: left out */ }
    const doc = buildReport({
      snap: manager.snapshot(), vortex,
      gameLog: gameLogs.entries, gameStatus: gameLogs.status(), sources: gameLogs.sources(),
      app: { version: app.getVersion() },
    });
    fs.writeFileSync(r.filePath, JSON.stringify(doc, null, 2));
    lastExport = r.filePath;
    logger.success(`Exported a report (${doc.summary.errors} errors, ${doc.summary.warnings} warnings, ${doc.summary.mods} mods) to ${r.filePath}`);
    return { file: r.filePath, ...doc.summary };
  });
  handle('vortex:open', () => {
    const exe = manager.vortex.exePath();
    if (!exe) throw new Error('Vortex.exe was not found.');
    require('child_process').spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  });
  handle('updates:check', () => manager.checkUpdates());
  handle('updates:apply', ids => manager.updateMods(ids));
  handle('mods:repair', ids => manager.repair(ids));
  handle('profiles:switch', id => manager.switchProfile(id));
  handle('profiles:create', (name, copyCurrent) => manager.createProfile(name, { copyCurrent }));
  handle('profiles:rename', (id, name) => manager.renameProfile(id, name));
  handle('profiles:delete', id => manager.deleteProfile(id));
  handle('vortex:profilePlan', id => manager.vortexProfilePlan(String(id)));
  handle('vortex:useProfile', (id, opts) => manager.useVortexProfile(String(id), { switchOffOthers: opts?.switchOffOthers !== false }));
  handle('nexus:signedIn', () => nexusSignedIn());
  handle('profiles:export', async id => {
    await manager.resolveProfileFiles(id); // mods moved from Vortex: their Nexus files, so they are not "local"
    const doc = manager.exportProfile(id);
    // A safe default file name: no reserved characters, no trailing dots, no device names (CON, NUL, …).
    let safe = doc.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim() || 'profile';
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe)) safe = `profile-${safe}`;
    // A profile with mods from local files is best shared as a .zip that carries them.
    const locals = doc.mods.filter(m => !(m.modId > 0 && m.fileId > 0)).length;
    const zip = { name: 'Profile with its local mods (.zip)', extensions: ['zip'] };
    const json = { name: 'Profile, Nexus mods only (.json)', extensions: ['json'] };
    const r = await dialog.showSaveDialog(win, {
      title: 'Export profile', defaultPath: path.join(app.getPath('documents'), `${safe}.cmmprofile.${locals ? 'zip' : 'json'}`),
      filters: locals ? [zip, json] : [json, zip],
    });
    if (r.canceled || !r.filePath) return null;
    lastExport = r.filePath;
    if (/\.zip$/i.test(r.filePath)) return manager.exportProfileZip(id, r.filePath);
    fs.writeFileSync(r.filePath, JSON.stringify(doc, null, 2));
    lastExport = r.filePath;
    logger.success(`Exported profile "${doc.name}" (${doc.mods.length} mods) to ${r.filePath}`);
    return { file: r.filePath, count: doc.mods.length };
  });
  handle('profiles:importPlan', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import profile', properties: ['openFile'],
      filters: [{ name: 'Cyber Mod Manager profile', extensions: ['zip', 'json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    if (/\.zip$/i.test(file)) {
      const plan = await manager.planProfileZip(file);
      if (!plan) throw new Error('That .zip is not a profile exported by Cyber Mod Manager (it has no profile.json).');
      return plan;
    }
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('That file is too large to be a profile.');
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('That file is not valid JSON.'); }
    return manager.planProfileImport(doc);
  });
  handle('profiles:importApply', (token, name) => manager.applyProfileImport(token, name));
  handle('profiles:code', id => manager.profileCode(id));
  handle('profiles:importCode', text => manager.planProfileCode(text));
  handle('profiles:importCancel', token => manager.cancelProfileImport(token));
  handle('profiles:revealExport', () => { if (lastExport) shell.showItemInFolder(lastExport); });
  handle('jobs:cancel', id => manager.downloader.cancel(id));
  handle('jobs:retry', id => manager.downloader.retry(id));
  handle('jobs:clear', () => { manager.downloader.clearFinished(); pushSnapshot(); });
  handle('downloads:install', keys => manager.install(keys));
  handle('downloads:installAndEnable', async keys => {
    const results = await manager.install(keys);
    const ids = results.filter(r => r.id).map(r => r.id);
    if (ids.length) await manager.setEnabled(ids, true);
    return results;
  });
  handle('downloads:delete', keys => manager.deleteDownloads(keys));
  handle('downloads:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Install mod archives', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Archives', extensions: ['zip', '7z', 'rar'] }],
    });
    if (r.canceled) return null;
    const keys = await manager.importArchives(r.filePaths);
    return manager.install(keys);
  });
  // Archives dropped on the window: only existing .zip/.7z/.rar files are taken.
  handle('downloads:importPaths', async paths => {
    const ok = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && /\.(zip|7z|rar)$/i.test(p) && path.isAbsolute(p))
      .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (!ok.length) throw new Error('Drop .zip, .7z or .rar mod archives to install them.');
    // One .zip that is a shared profile: set the profile up instead of installing it as a mod.
    if (ok.length === 1 && /\.zip$/i.test(ok[0])) {
      const plan = await manager.planProfileZip(ok[0]);
      if (plan) return { profile: plan };
    }
    const keys = await manager.importArchives(ok);
    const results = await manager.install(keys);
    return { count: ok.length, skipped: (paths?.length || 0) - ok.length, results };
  });
  handle('mods:enable', ids => manager.setEnabled(ids, true));
  handle('mods:disable', ids => manager.setEnabled(ids, false));
  handle('mods:switchVersion', (offIds, onId) => manager.switchVersion(offIds, onId));
  handle('mods:uninstall', ids => manager.uninstall(ids));
  handle('mods:reinstall', ids => manager.reinstall(ids));
  handle('mods:prioritize', ids => manager.prioritize(ids));
  handle('mods:files', id => manager.modFiles(id));
  handle('mods:conflicts', id => manager.conflictDetails(id));
  handle('mods:redeploy', () => manager.redeploy());
  handle('mods:purge', () => manager.purge());
  handle('fomod:submit', (token, selections) => manager.fomodSubmit(token, selections));
  handle('fomod:cancel', token => manager.fomodCancel(token));
  handle('open:path', which => {
    const map = {
      game: manager.gameDir(), downloads: settings.downloadsDir, staging: settings.stagingDir,
      backups: settings.backupDir, logs: path.join(userData, 'logs'),
    };
    const target = map[which];
    if (!target) throw new Error(`Unknown folder ${which}`);
    fs.mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });
  handle('open:nexus', (game, modId) => shell.openExternal(`https://www.nexusmods.com/${encodeURIComponent(game)}/mods/${Number(modId)}`));
  ipcMain.on('renderer-error', (_e, msg) => logger.error(`UI error: ${msg}`));

  createWindow();
}

process.on('uncaughtException', err => logger.error(`Unexpected error: ${err.message}`, err.stack));
process.on('unhandledRejection', err => logger.error(`Unhandled promise rejection: ${err?.message || err}`, err?.stack));

/*
 * Nexus "Mod Manager Download" links (nxm://). Off by default; when switched on in Settings this app
 * becomes the handler and a clicked link starts downloading here. Windows hands the link to a new
 * process, which passes it to the running one and exits (single instance).
 */
const nxmArgs = () => (process.defaultApp ? [path.resolve(process.argv[1] || '.')] : []);
const nxmBackupFile = () => path.join(app.getPath('userData'), 'nxm-previous-handler.reg');

/** Who opens nxm:// links now, for Settings. */
async function nxmStatus() {
  const command = await nxm.readCommand();
  return {
    on: !!settings.get('handleNxm'),
    ours: app.isDefaultProtocolClient('nxm', process.execPath, nxmArgs()),
    handler: nxm.describe(command, process.execPath),
    saved: fs.existsSync(nxmBackupFile()),
  };
}

/**
 * Make the registry match the setting. On: save whoever handles the links now, then take them
 * over. Off: give them back to whoever had them before. Screenshot runs never touch the registry
 * (their throwaway settings would undo the user's choice).
 */
async function applyNxmSetting() {
  if (process.env.CMM_CAPTURE) return nxmStatus();
  const args = nxmArgs();
  const ours = app.isDefaultProtocolClient('nxm', process.execPath, args);
  if (settings.get('handleNxm')) {
    if (!ours) {
      const before = nxm.describe(await nxm.readCommand(), process.execPath);
      // Keep the first handler we replaced; a later Vortex start that took the links back is not it.
      if (!fs.existsSync(nxmBackupFile())) await nxm.backup(nxmBackupFile());
      if (!app.setAsDefaultProtocolClient('nxm', process.execPath, args)) throw new Error('Windows did not accept this app as the handler for Nexus links.');
      await nxm.setIcon(process.execPath);
      logger.success(`Nexus "Mod Manager Download" links now open this app${before ? ` (they opened ${before} before)` : ''}`);
    }
  } else if (ours) {
    const saved = fs.existsSync(nxmBackupFile());
    await nxm.restore(saved ? nxmBackupFile() : '');
    const back = nxm.describe(await nxm.readCommand(), process.execPath);
    try { fs.unlinkSync(nxmBackupFile()); } catch { /* none */ }
    logger.success(`Nexus "Mod Manager Download" links are no longer handled by this app${back ? `; they open ${back} again` : saved ? '' : '; no other program was set before'}`);
  }
  return nxmStatus();
}

/**
 * REDmod deploy, when the REDmods changed since the last successful one (or always, when forced).
 * Returns null when there was nothing to do, else { ok, reason }. Progress goes to the window.
 */
let redmodRunning = null;

/**
 * Where the REDmods stand: how many there are, whether what is deployed matches them (a change
 * since the last successful deploy means Play deploys first), and how this app's last deploy went.
 */
function redmodStatus(dir = settings.get('gamePath')) {
  if (!isGameDir(dir)) return { count: 0, upToDate: true, last: null, tools: true };
  const count = hasRedmods(dir) ? redmodFolders(dir).length : 0;
  return {
    count, upToDate: !count || redmodFingerprint(dir) === settings.get('redmodDeployed'), running: !!redmodRunning,
    last: settings.get('redmodLast') || null, tools: redmodToolsInstalled(dir),
  };
}

const REDMOD_MISSING = 'The REDmod tools are not installed (tools\\redmod\\bin\\redMod.exe). They are a free DLC from CD Projekt for Cyberpunk 2077: without them REDmods cannot be deployed, by this app or any other.';
let redmodMissingNoted = false;

/*
 * Getting the REDmod tools, per store (CD Projekt's modding page, cyberpunk.net/en/modding-support).
 * Every store puts them in the same place: <game>\tools\redmod\bin\redMod.exe.
 */
const REDMOD_HELP = {
  steam: {
    url: 'steam://store/2060310', button: 'Open it in Steam',
    steps: ['In Steam, open "Cyberpunk 2077 REDmod" (free DLC) and click Install.', 'Steam downloads it into the game folder. Then press Play here again.'],
  },
  gog: {
    url: 'https://www.gog.com/game/cyberpunk_2077_redmod', button: 'Open it on GOG',
    steps: ['On GOG, add "Cyberpunk 2077 REDmod" (free DLC) to your library.', 'In GOG Galaxy: Cyberpunk 2077 → Manage installation → Configure, tick REDmod and let it install. Then press Play here again.'],
  },
  epic: {
    url: 'https://www.cyberpunk.net/en/modding-support', button: 'Open CD Projekt\'s guide',
    steps: ['On Epic, REDmod comes with the game (version 1.6 and later); it has no separate download.', 'In the Epic Games Launcher: Library → Cyberpunk 2077 → ⋯ → Manage → Verify. That puts back missing game files, the REDmod tools included.'],
  },
  other: {
    url: 'https://www.cyberpunk.net/en/modding-support', button: 'Open CD Projekt\'s guide',
    steps: ['CD Projekt offers REDmod for the Steam, GOG and Epic versions of the game (see their modding page).', 'Install it there into this game folder, then press Play here again.'],
  },
};

async function runRedmodDeploy(dir, force) {
  if (!isGameDir(dir) || !hasRedmods(dir)) return null;
  const fp = redmodFingerprint(dir);
  if (!force && fp === settings.get('redmodDeployed')) return null;
  // No tools: nothing can deploy. Said once per run (not as a failure each Play); installing them fixes it.
  if (!redmodToolsInstalled(dir)) {
    if (!redmodMissingNoted) { logger.warn('REDmod tools are missing: your REDmods are not deployed', REDMOD_MISSING); redmodMissingNoted = true; }
    return { ok: false, missingTools: true, reason: REDMOD_MISSING };
  }
  if (redmodRunning) return redmodRunning;
  redmodRunning = (async () => {
    logger.info(`Deploying ${redmodFolders(dir).length} REDmods (REDmod deploy)…`);
    send('redmod', { stage: 'deploying' });
    const res = await deployRedmods(dir, { onLine: line => { if (/stage|deploy|error/i.test(line)) send('redmod', { stage: 'deploying', line }); } });
    if (res.ok) {
      settings.update({ redmodDeployed: fp, redmodLast: { ok: true, at: Date.now() } });
      logger.success('REDmods deployed');
      send('redmod', { stage: 'done', status: redmodStatus() });
      return { ok: true };
    }
    // The tool's own error lines say why (a script that does not compile, a missing file, …).
    const why = res.lines.filter(l => /error|failed|missing|not found/i.test(l)).slice(-6);
    const reason = why.join('\n') || res.lines.slice(-3).join('\n') || 'REDmod deploy failed';
    settings.update({ redmodLast: { ok: false, at: Date.now(), reason } });
    logger.error('REDmod deploy failed: your REDmods may not load in the game', res.lines.slice(-25).join('\n'));
    send('redmod', { stage: 'failed', reason, status: redmodStatus() });
    return { ok: false, reason };
  })().finally(() => { redmodRunning = null; });
  return redmodRunning;
}

/*
 * Nexus pages inside the app (the Browse page). The <webview> gets no preload and no Node, runs
 * sandboxed in its own persistent session (so a Nexus login and the cookie choice are kept), and
 * may only show https://*.nexusmods.com. Other links open in the user's browser; nxm:// links and
 * file downloads come to this app's downloader.
 */
const NEXUS_PAGE = /^https:\/\/([a-z0-9-]+\.)*nexusmods\.com(\/|$)/i;
const NEXUS_PARTITION = 'persist:nexus';
// nexusmods.com keeps a login in this cookie: Browse hides its Log in button while it is there (only its presence is read).
const NEXUS_LOGIN_COOKIE = 'nexusmods_session';
async function nexusSignedIn() {
  const list = await session.fromPartition(NEXUS_PARTITION).cookies.get({ name: NEXUS_LOGIN_COOKIE }).catch(() => []);
  return list.some(c => /(^|\.)nexusmods\.com$/i.test(String(c.domain || '').replace(/^\./, '')) && !!c.value);
}
function guardWebviews() {
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev, prefs, params) => {
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      prefs.webSecurity = true;
      prefs.partition = NEXUS_PARTITION;
      if (!NEXUS_PAGE.test(params.src || '')) ev.preventDefault();
    });
    if (wc.getType() !== 'webview') return;
    const route = url => {
      if (/^nxm:\/\//i.test(url)) { handleNxmArgs([url]); return; }
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    };
    wc.on('will-navigate', (ev, url) => { if (!NEXUS_PAGE.test(url)) { ev.preventDefault(); route(url); } });
    wc.on('will-frame-navigate', ev => { if (ev.isMainFrame && !NEXUS_PAGE.test(ev.url)) { ev.preventDefault(); route(ev.url); } });
    // A server redirect off Nexus is not followed in the page either (it opens in the browser).
    wc.on('will-redirect', (ev, url, _inPlace, isMainFrame) => { if (isMainFrame !== false && !NEXUS_PAGE.test(url)) { ev.preventDefault(); route(url); } });
    wc.setWindowOpenHandler(({ url }) => {
      // A Nexus link meant for a new tab stays in the page view; anything else goes to the browser.
      if (NEXUS_PAGE.test(url)) wc.loadURL(url); else route(url);
      return { action: 'deny' };
    });
  });
  const nexusSession = session.fromPartition(NEXUS_PARTITION);
  // Keep the Nexus login across restarts, as a browser that restores its session does: Nexus's
  // session-only cookies (no expiry) are given 30 days so they are saved to disk, and the cookie
  // store is written out soon after a change and on quit (an update restart included).
  let flushTimer = null;
  const flush = () => nexusSession.cookies.flushStore().catch(() => {});
  nexusSession.cookies.on('changed', (_e, cookie, _cause, removed) => {
    const host = String(cookie.domain || '').replace(/^\./, '');
    if (!/(^|\.)nexusmods\.com$/i.test(host)) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 2000);
    if (cookie.name === NEXUS_LOGIN_COOKIE) send('nexus:signedIn', !removed && !!cookie.value);
    if (removed || !cookie.session || !cookie.value) return;
    nexusSession.cookies.set({
      url: `https://${host}${cookie.path || '/'}`, name: cookie.name, value: cookie.value,
      domain: String(cookie.domain).startsWith('.') ? cookie.domain : undefined, // host-only stays host-only
      path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400,
    }).catch(() => {});
  });
  app.on('before-quit', flush);
  nexusSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'openExternal') {
      const url = String(details?.externalURL || '');
      if (/^nxm:\/\//i.test(url)) handleNxmArgs([url]);
      else if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      callback(false);
      return;
    }
    callback(permission === 'fullscreen');
  });
  // A "Manual download" clicked in the page: this app downloads it instead, with the file picker.
  session.fromPartition(NEXUS_PARTITION).on('will-download', (ev, item) => {
    ev.preventDefault();
    const page = item.getURLChain?.().concat(item.getURL()).find(u => /\/mods\/\d+/.test(u)) || '';
    const m = page.match(/nexusmods\.com\/(?:games\/)?([a-z0-9_-]+)\/mods\/(\d+)/i);
    send('browse:download', m ? { game: m[1].toLowerCase(), modId: Number(m[2]) } : { url: item.getURL() });
  });
}

/*
 * Ads and trackers on the Nexus pages (Browse), blocked with Ghostery's engine and the usual
 * filter lists (EasyList, EasyPrivacy, uBlock Origin's), network and cosmetic. Only the Nexus page
 * session is affected. The compiled lists are cached and fetched again after a week.
 */
let adBlocker = null;
let adBlockOn = false;
async function applyAdBlock() {
  const want = settings.get('blockAds') !== false;
  const ses = session.fromPartition(NEXUS_PARTITION);
  if (!want) {
    if (adBlockOn && adBlocker) adBlocker.disableBlockingInSession(ses);
    adBlockOn = false;
    return;
  }
  if (adBlockOn) return;
  try {
    if (!adBlocker) {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
      try { if (Date.now() - fs.statSync(cache).mtimeMs > 7 * 86400000) fs.unlinkSync(cache); } catch { /* none yet */ }
      adBlocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: cache,
        read: p => fs.promises.readFile(p),
        write: (p, buf) => fs.promises.writeFile(p, buf),
      });
    }
    // The setting may have been turned off while the lists loaded.
    if (settings.get('blockAds') === false || adBlockOn) return;
    adBlocker.enableBlockingInSession(ses);
    adBlockOn = true;
    logger.info('Ad and tracker blocking is on for Nexus pages');
  } catch (err) {
    logger.warn('Could not load the ad-blocking lists; Nexus pages show ads for now', err.message);
  }
}

const pendingNxm = [];
function handleNxmArgs(argv) {
  for (const a of argv) {
    if (!/^nxm:\/\//i.test(a)) continue;
    if (!manager) { pendingNxm.push(a); continue; }
    manager.handleNxm(a)
      .then(r => send('toast', { text: r.resumed ? `Downloading ${r.file}` : r.queued ? `Downloading ${r.file}` : `${r.file} is already downloaded`, kind: 'success' }))
      .catch(err => logger.error('Could not start that Nexus download', err.message));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  }
}

function start() {
  app.on('second-instance', (_e, argv) => handleNxmArgs(argv));
  app.whenReady().then(guardWebviews).then(boot).then(() => { handleNxmArgs(process.argv); pendingNxm.splice(0).forEach(u => handleNxmArgs([u])); });
}

if (app.requestSingleInstanceLock()) {
  start();
} else if (process.argv.includes('--updated')) {
  // Started by the installer of an update: the old version may still be closing. Wait for it
  // (up to 15 s) instead of quitting, so the app comes back after updating.
  let tries = 0;
  const retry = setInterval(() => {
    if (app.requestSingleInstanceLock()) { clearInterval(retry); start(); } else if (++tries >= 30) { clearInterval(retry); app.quit(); }
  }, 500);
} else {
  app.quit();
}
app.on('window-all-closed', () => app.quit());
