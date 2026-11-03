'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { AppUpdater, intervalMs, RESTART_DELAY_MS } = require('../src/core/updater');

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
  t.mock.timers.tick(RESTART_DELAY_MS);
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

test('while the game runs: no scheduled checks and no restart; both happen once it closes', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate'] });
  const up = fakeUpdater();
  let game = true;
  const u = new AppUpdater({ autoUpdater: up, enabled: true, getSchedule: () => ({ every: 2, unit: 'minutes' }), isBusy: () => false, gameRunning: () => game, log: quiet });
  u.start();
  t.mock.timers.tick(10 * 60e3);
  assert.strictEqual(up.checks, 0, 'nothing checked while playing');
  assert.strictEqual(u.state.heldForGame, true);
  game = false;
  u.gameChanged(false);
  assert.strictEqual(up.checks, 1, 'the check that came due runs when the game closes');

  // An update that is ready while the game runs waits for it to close.
  game = true;
  up.emit('update-downloaded', { version: '2.0.0' });
  assert.deepStrictEqual([u.state.waiting, u.state.waitingFor], [true, 'game']);
  t.mock.timers.tick(10 * 60e3);
  assert.strictEqual(up.installed, null, 'never restarts during a game');
  game = false;
  u.gameChanged(false);
  assert.ok(u.state.restartAt > 0, 'after the game, the countdown');
  t.mock.timers.tick(RESTART_DELAY_MS + 1);
  assert.deepStrictEqual(up.installed, { silent: true, runAfter: true });
});

test('a restart only while the window can be seen, so its notice is never missed', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate'] });
  const up = fakeUpdater();
  let seen = false;
  const u = new AppUpdater({ autoUpdater: up, enabled: true, getSchedule: () => ({ every: 1, unit: 'hours' }), isBusy: () => false, inView: () => seen, log: quiet });
  up.emit('update-available', { version: '2.1.0' });
  assert.strictEqual(u.state.status, 'downloading', 'the window shows it from the moment it is found');
  up.emit('update-downloaded', { version: '2.1.0' });
  assert.strictEqual(u.state.waitingFor, 'view');
  t.mock.timers.tick(60 * 60e3);
  assert.strictEqual(up.installed, null, 'minimized all along: no restart behind the user\'s back');
  seen = true;
  t.mock.timers.tick(5000);
  assert.ok(u.state.restartAt > 0);
  seen = false; // minimized again during the notice
  t.mock.timers.tick(RESTART_DELAY_MS + 1);
  assert.strictEqual(up.installed, null, 'the countdown waits again');
  seen = true;
  t.mock.timers.tick(5000);
  t.mock.timers.tick(RESTART_DELAY_MS + 1);
  assert.ok(up.installed);
});

test('"Ask before restarting" waits for the user; "Off" never checks by itself, but Check now works', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate'] });
  const up = fakeUpdater();
  let mode = 'ask';
  const u = new AppUpdater({ autoUpdater: up, enabled: true, getSchedule: () => ({ every: 2, unit: 'minutes', mode }), isBusy: () => false, log: quiet });
  u.start();
  up.emit('update-downloaded', { version: '3.0.0' });
  t.mock.timers.tick(60 * 60e3);
  assert.strictEqual(up.installed, null, 'no restart without the user');
  assert.strictEqual(u.state.restartAt, 0);
  u.installNow();
  t.mock.timers.tick(1);
  assert.ok(up.installed, 'Restart now installs it');

  const up2 = fakeUpdater();
  mode = 'off';
  const off = new AppUpdater({ autoUpdater: up2, enabled: true, getSchedule: () => ({ every: 2, unit: 'minutes', mode }), isBusy: () => false, log: quiet });
  off.start();
  t.mock.timers.tick(60 * 60e3);
  assert.strictEqual(up2.checks, 0, 'off: no checks at all');
  off.check();
  assert.strictEqual(up2.checks, 1, 'Check now still works');
  mode = 'auto';
  off.start();
  assert.strictEqual(up2.checks, 2, 'turned back on: checks again');
});

test('a restart waits while the AI assistant is answering, also when it starts during the countdown', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate'] });
  const up = fakeUpdater();
  let ai = true;
  const u = new AppUpdater({ autoUpdater: up, enabled: true, getSchedule: () => ({ every: 1, unit: 'hours' }), isBusy: () => false, aiBusy: () => ai, log: quiet });
  up.emit('update-available', { version: '2.2.0' });
  up.emit('update-downloaded', { version: '2.2.0' });
  assert.strictEqual(u.state.waitingFor, 'ai');
  t.mock.timers.tick(10 * 60e3);
  assert.strictEqual(up.installed, null);
  ai = false;
  t.mock.timers.tick(5000);
  assert.ok(u.state.restartAt > 0);
  ai = true; // a new question during the notice
  t.mock.timers.tick(RESTART_DELAY_MS + 1);
  assert.strictEqual(up.installed, null, 'the answer is not cut off');
  ai = false;
  t.mock.timers.tick(5000);
  t.mock.timers.tick(RESTART_DELAY_MS + 1);
  assert.ok(up.installed);
});
