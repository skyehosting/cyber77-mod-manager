'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { AppUpdater, intervalMs } = require('../src/core/updater');

const quiet = { info() {}, warn() {}, error() {}, success() {} };

test('the check interval follows the setting, never under a minute', () => {
  assert.strictEqual(intervalMs(2, 'minutes'), 120e3);
  assert.strictEqual(intervalMs(3, 'hours'), 3 * 3600e3);
  assert.strictEqual(intervalMs(1, 'days'), 86400e3);
  assert.strictEqual(intervalMs(0, 'minutes'), 120e3, 'nonsense falls back to 2 minutes');
  assert.strictEqual(intervalMs(5, 'weeks'), 5 * 60e3, 'an unknown unit counts as minutes');
  assert.strictEqual(intervalMs(999, 'days'), 30 * 86400e3, 'at most 30 days');
});

function fakeUpdater() {
  const up = new EventEmitter();
  up.checks = 0;
  up.installed = null;
  up.checkForUpdates = async () => { up.checks++; };
  up.quitAndInstall = (silent, runAfter) => { up.installed = { silent, runAfter }; };
  return up;
}

test('a new version downloads, waits while the app is busy, then restarts to install', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate'] });
  const up = fakeUpdater();
  let busy = true;
  const u = new AppUpdater({ autoUpdater: up, enabled: true, getSchedule: () => ({ every: 2, unit: 'minutes' }), isBusy: () => busy, log: quiet });
  u.start();
  assert.strictEqual(up.checks, 1, 'checks at start');
  t.mock.timers.tick(120e3);
  assert.strictEqual(up.checks, 2, 'and every 2 minutes');

  up.emit('update-available', { version: '1.1.9' });
  assert.strictEqual(u.state.status, 'downloading');
  up.emit('update-downloaded', { version: '1.1.9' });
  assert.strictEqual(u.state.status, 'ready');
  assert.strictEqual(u.state.waiting, true, 'a download or install in progress holds the restart');
  t.mock.timers.tick(60e3);
  assert.strictEqual(up.installed, null);

  busy = false;
  t.mock.timers.tick(5000);
  assert.ok(u.state.restartAt > 0, 'once idle, a countdown starts');
  t.mock.timers.tick(15000);
  t.mock.timers.tick(1);
  assert.deepStrictEqual(up.installed, { silent: true, runAfter: true }, 'silent install, then the app starts again');
  assert.strictEqual(up.checks, 2, 'no new checks while an update waits');
});

test('"Later" leaves the update for when the app is closed', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate'] });
  const up = fakeUpdater();
  const u = new AppUpdater({ autoUpdater: up, enabled: true, getSchedule: () => ({ every: 1, unit: 'hours' }), isBusy: () => false, log: quiet });
  up.emit('update-downloaded', { version: '1.2.0' });
  u.postpone();
  t.mock.timers.tick(60e3);
  assert.strictEqual(up.installed, null);
  assert.strictEqual(up.autoInstallOnAppQuit, true);
});

test('running from source never checks', () => {
  const u = new AppUpdater({ autoUpdater: null, enabled: false, getSchedule: () => ({}), isBusy: () => false, log: quiet });
  u.start();
  assert.strictEqual(u.state.status, 'dev');
});
