'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const { logger } = require('./core/logger');
const { Settings } = require('./core/settings');
const { ModManager } = require('./core/manager');
const { findCyberpunk, isGameDir } = require('./core/gameFinder');

let win = null;
let settings = null;
let manager = null;

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
  snapshotTimer = setTimeout(() => send('snapshot', manager.snapshot()), 50);
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

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: '#0d0f14',
    title: 'Cyber Mod Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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

  handle('snapshot', () => manager.snapshot());
  handle('logs', () => logger.entries);
  handle('settings:get', () => settings.publicView());
  handle('settings:set', patch => {
    const before = settings.get('dataDir');
    settings.update(patch);
    if (settings.get('dataDir') !== before) logger.warn('Data folder changed. Restart the app to use it.');
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
    require('fs').mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });
  handle('open:nexus', (game, modId) => shell.openExternal(`https://www.nexusmods.com/${encodeURIComponent(game)}/mods/${Number(modId)}`));
  ipcMain.on('renderer-error', (_e, msg) => logger.error(`UI error: ${msg}`));

  createWindow();
}

process.on('uncaughtException', err => logger.error(`Unexpected error: ${err.message}`, err.stack));
process.on('unhandledRejection', err => logger.error(`Unhandled promise rejection: ${err?.message || err}`, err?.stack));

app.whenReady().then(boot);
app.on('window-all-closed', () => app.quit());
