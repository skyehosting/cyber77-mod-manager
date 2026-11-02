'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = channel => cb => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  snapshot: () => call('snapshot'),
  logs: () => call('logs'),
  getSettings: () => call('settings:get'),
  setSettings: patch => call('settings:set', patch),
  validateKey: () => call('settings:validateKey'),
  detectGame: () => call('settings:detectGame'),
  pickFolder: title => call('dialog:folder', title),
  pickFile: (title, filters) => call('dialog:file', title, filters),
  addLinks: text => call('links:add', text),
  cancelJob: id => call('jobs:cancel', id),
  retryJob: id => call('jobs:retry', id),
  clearJobs: () => call('jobs:clear'),
  install: keys => call('downloads:install', keys),
  installAndEnable: keys => call('downloads:installAndEnable', keys),
  deleteDownloads: keys => call('downloads:delete', keys),
  importArchives: () => call('downloads:import'),
  enable: ids => call('mods:enable', ids),
  disable: ids => call('mods:disable', ids),
  uninstall: ids => call('mods:uninstall', ids),
  reinstall: ids => call('mods:reinstall', ids),
  prioritize: ids => call('mods:prioritize', ids),
  modFiles: id => call('mods:files', id),
  redeploy: () => call('mods:redeploy'),
  purge: () => call('mods:purge'),
  fomodSubmit: (token, selections) => call('fomod:submit', token, selections),
  fomodCancel: token => call('fomod:cancel', token),
  openPath: which => call('open:path', which),
  openNexus: (game, modId) => call('open:nexus', game, modId),
  reportError: msg => ipcRenderer.send('renderer-error', String(msg)),
  onSnapshot: on('snapshot'),
  onJob: on('job'),
  onLog: on('log'),
  onFomod: on('fomod'),
});
