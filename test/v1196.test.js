'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Settings } = require('../src/core/settings');
const { AppUpdater } = require('../src/core/updater');

const quiet = { info() {}, warn() {}, error() {}, success() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-set196-'));

test('Downloads install and enable by themselves by default; a copy on the old default (Main files only) follows once', () => {
  const fresh = new Settings(tmp(), null);
  assert.strictEqual(fresh.get('autoInstall'), 'all');
  assert.strictEqual(fresh.get('autoEnable'), true);

  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autoInstall: 'main' }));
  const old = new Settings(dir, null);
  assert.strictEqual(old.get('autoInstall'), 'all', 'moved from the old default');
  // Chosen again afterwards: it stays (the move happens once).
  old.update({ autoInstall: 'main' });
  assert.strictEqual(new Settings(dir, null).get('autoInstall'), 'main');

  const offDir = tmp();
  fs.writeFileSync(path.join(offDir, 'settings.json'), JSON.stringify({ autoInstall: 'off' }));
  assert.strictEqual(new Settings(offDir, null).get('autoInstall'), 'off', 'a choice of "Don\'t install" is kept');
});

test('Performance and update-when-opening settings: defaults and limits', () => {
  const s = new Settings(tmp(), null);
  assert.deepStrictEqual([s.get('perfInterval'), s.get('perfHistory'), s.get('perfGraphs'), s.get('updateOnLaunch')], [1000, 60, true, true]);
  s.update({ perfInterval: '50', perfHistory: '99999', perfGraphs: 0, updateOnLaunch: '' });
  assert.deepStrictEqual([s.get('perfInterval'), s.get('perfHistory'), s.get('perfGraphs'), s.get('updateOnLaunch')], [500, 600, false, false]);
  s.update({ perfInterval: 'abc', perfHistory: 'x' });
  assert.deepStrictEqual([s.get('perfInterval'), s.get('perfHistory')], [1000, 60]);
});

function fakeUp() {
  const up = new EventEmitter();
  up.checks = 0;
  up.checkForUpdates = async () => { up.checks++; };
  up.quitAndInstall = () => {};
  return up;
}

test('After the check before opening, the app updater does not check again at once; a download it left goes on', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate', 'Date'] });
  const up = fakeUp();
  const u = new AppUpdater({ autoUpdater: up, enabled: true, getSchedule: () => ({ every: 1, unit: 'hours', mode: 'auto' }), isBusy: () => false, log: quiet });
  u.afterLaunchCheck({ outcome: 'none' });
  u.start();
  assert.strictEqual(up.checks, 0, 'not checked twice on opening');
  assert.strictEqual(u.state.status, 'current');
  t.mock.timers.tick(3600e3);
  assert.strictEqual(up.checks, 1, 'the schedule goes on');

  const up2 = fakeUp();
  const v = new AppUpdater({ autoUpdater: up2, enabled: true, getSchedule: () => ({ every: 1, unit: 'hours', mode: 'auto' }), isBusy: () => false, log: quiet });
  v.afterLaunchCheck({ outcome: 'background', version: '9.9.9' });
  v.start();
  assert.deepStrictEqual([v.state.status, v.state.available, up2.checks], ['downloading', '9.9.9', 0]);
  v.check();
  assert.strictEqual(up2.checks, 0, 'a download under way is not started again');
  // Ten minutes without a word from it: given up on, a check may run again.
  t.mock.timers.tick(11 * 60e3);
  v.check();
  assert.strictEqual(up2.checks, 1);

  const up3 = fakeUp();
  const w = new AppUpdater({ autoUpdater: up3, enabled: true, getSchedule: () => ({ every: 1, unit: 'hours', mode: 'auto' }), isBusy: () => false, log: quiet });
  w.afterLaunchCheck({ outcome: 'error' });
  w.start();
  assert.strictEqual(up3.checks, 1, 'the check before opening failed: the usual one runs');
  clearInterval(u.timer); clearInterval(v.timer); clearInterval(w.timer);
});

test('A download that finished between the check before opening and the app updater shows as ready, not as downloading', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate', 'Date'] });
  const up = fakeUp();
  const u = new AppUpdater({ autoUpdater: up, enabled: true, getSchedule: () => ({ every: 1, unit: 'hours', mode: 'ask' }), isBusy: () => false, log: quiet });
  u.afterLaunchCheck({ outcome: 'background', version: '9.9.9', downloaded: '9.9.9' });
  u.start();
  assert.deepStrictEqual([u.state.status, u.state.available, up.checks], ['ready', '9.9.9', 0]);
  clearInterval(u.timer);
});
