'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, screen } = require('electron');
const { logger } = require('./core/logger');
const { Settings } = require('./core/settings');
const { ModManager } = require('./core/manager');
const { findCyberpunk, findInstalls, storeOf, isGameDir } = require('./core/gameFinder');
const { launchGame } = require('./core/launcher');
const { GameLogMonitor } = require('./core/gameLogs');

let win = null;
let settings = null;
let manager = null;
let gameLogs = null;
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

const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

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

  // Ctrl + / Ctrl - / Ctrl 0 zoom the whole UI (the menu bar, which normally provides this, is hidden).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const wc = win.webContents;
    const cur = wc.getZoomFactor();
    let next = null;
    if (input.key === '=' || input.key === '+') next = ZOOM_STEPS.find(z => z > cur + 0.001);
    else if (input.key === '-') next = [...ZOOM_STEPS].reverse().find(z => z < cur - 0.001);
    else if (input.key === '0') next = 1;
    if (next) {
      wc.setZoomFactor(next);
      event.preventDefault();
    }
  });
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
  logger.on('entry', e => send('log', e));

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
  applyNxmSetting();

  gameLogs = new GameLogMonitor({
    getGameDir: () => settings.get('gamePath'),
    log: logger,
    crashDir: path.join(process.env.LOCALAPPDATA || '', 'REDEngine', 'ReportQueue'),
  });
  gameLogs.on('entries', batch => send('gamelog', batch));
  logger.on('entry', e => {
    if (e.level === 'warn' || e.level === 'error') gameLogs.report(e.level, e.detail ? `${e.message}: ${e.detail.split('\n')[0]}` : e.message);
  });
  gameLogs.on('game', status => { send('gamestatus', status); pushSnapshot(); });
  gameLogs.on('reset', () => send('gamelog-reset'));
  gameLogs.start();
  app.on('before-quit', () => gameLogs.stop());

  handle('snapshot', () => ({ ...manager.snapshot(), gameStatus: gameLogs.status() }));
  handle('logs', () => logger.entries);
  handle('gamelog:snapshot', () => ({ entries: gameLogs.entries.slice(-4000), sources: gameLogs.sources(), status: gameLogs.status() }));
  handle('gamelog:sources', () => gameLogs.sources());
  handle('gamelog:reveal', rel => {
    const full = path.join(settings.get('gamePath'), String(rel));
    if (!full.startsWith(path.resolve(settings.get('gamePath')))) throw new Error('Not a game file');
    shell.showItemInFolder(full);
  });
  handle('gamelog:open', rel => {
    const full = path.join(settings.get('gamePath'), String(rel));
    if (!full.startsWith(path.resolve(settings.get('gamePath')))) throw new Error('Not a game file');
    return shell.openPath(full);
  });
  handle('settings:get', () => settings.publicView());
  handle('settings:set', patch => {
    const before = settings.get('dataDir');
    const gameBefore = settings.get('gamePath');
    settings.update(patch);
    if (settings.get('dataDir') !== before) logger.warn('Data folder changed. Restart the app to use it.');
    if (settings.get('gamePath') !== gameBefore) gameLogs.reset();
    if ('handleNxm' in patch) applyNxmSetting();
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
  handle('game:launch', async () => {
    const dir = settings.get('gamePath');
    if (!isGameDir(dir)) throw new Error('Set the Cyberpunk 2077 folder in Settings first.');
    const store = await storeOf(dir);
    const r = await launchGame({ gameDir: dir, store: store.store, epicApp: store.epicApp }, url => shell.openExternal(url));
    logger.success(`Launching Cyberpunk 2077 through ${r.via}${r.args.length ? ` (${r.args.join(' ')}, for REDmod)` : ''}`);
    return r;
  });
  handle('export:json', async (kind, data) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const r = await dialog.showSaveDialog(win, {
      title: kind === 'gamelog' ? 'Export game log' : 'Export activity log',
      defaultPath: path.join(app.getPath('documents'), `cyberpunk-${kind === 'gamelog' ? 'game-log' : 'activity'}-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const doc = kind === 'gamelog'
      ? { exportedAt: new Date().toISOString(), game: gameLogs.status(), sources: gameLogs.sources(), filter: data?.filter || null, entries: data?.entries || gameLogs.entries }
      : { exportedAt: new Date().toISOString(), entries: logger.entries };
    fs.writeFileSync(r.filePath, JSON.stringify(doc, null, 2));
    lastExport = r.filePath;
    logger.success(`Exported ${doc.entries.length} log lines to ${r.filePath}`);
    return { file: r.filePath, count: doc.entries.length };
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
  handle('profiles:export', async id => {
    const doc = manager.exportProfile(id);
    // A safe default file name: no reserved characters, no trailing dots, no device names (CON, NUL, …).
    let safe = doc.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim() || 'profile';
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe)) safe = `profile-${safe}`;
    const r = await dialog.showSaveDialog(win, {
      title: 'Export profile', defaultPath: path.join(app.getPath('documents'), `${safe}.cmmprofile.json`),
      filters: [{ name: 'Cyber Mod Manager profile', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(doc, null, 2));
    lastExport = r.filePath;
    logger.success(`Exported profile "${doc.name}" (${doc.mods.length} mods) to ${r.filePath}`);
    return { file: r.filePath, count: doc.mods.length };
  });
  handle('profiles:importPlan', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import profile', properties: ['openFile'],
      filters: [{ name: 'Cyber Mod Manager profile', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('That file is too large to be a profile.');
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('That file is not valid JSON.'); }
    return manager.planProfileImport(doc);
  });
  handle('profiles:importApply', (token, name) => manager.applyProfileImport(token, name));
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
  handle('mods:enable', ids => manager.setEnabled(ids, true));
  handle('mods:disable', ids => manager.setEnabled(ids, false));
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
function applyNxmSetting() {
  const args = process.defaultApp ? [path.resolve(process.argv[1] || '.')] : [];
  if (settings.get('handleNxm')) {
    if (app.setAsDefaultProtocolClient('nxm', process.execPath, args)) logger.info('This app now handles Nexus "Mod Manager Download" links');
  } else if (app.isDefaultProtocolClient('nxm', process.execPath, args)) {
    app.removeAsDefaultProtocolClient('nxm', process.execPath, args);
    logger.info('Nexus "Mod Manager Download" links are no longer handled by this app');
  }
}

const pendingNxm = [];
function handleNxmArgs(argv) {
  for (const a of argv) {
    if (!/^nxm:\/\//i.test(a)) continue;
    if (!manager) { pendingNxm.push(a); continue; }
    manager.handleNxm(a)
      .then(r => send('toast', { text: r.queued ? `Downloading ${r.file}` : `${r.file} is already downloaded`, kind: 'success' }))
      .catch(err => logger.error('Could not start that Nexus download', err.message));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => handleNxmArgs(argv));
  app.whenReady().then(boot).then(() => { handleNxmArgs(process.argv); pendingNxm.splice(0).forEach(u => handleNxmArgs([u])); });
}
app.on('window-all-closed', () => app.quit());
