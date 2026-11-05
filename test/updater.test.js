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
  assert.strictEqual(intervalMs(0, 'minutes'), 86400e3, 'nonsense falls back to the default, once a day');
  assert.strictEqual(intervalMs(5, 'weeks'), 86400e3, 'an unknown unit too');
  assert.strictEqual(intervalMs(999, 'days'), 24 * 86400e3, 'at most 24 days (a timer cannot wait longer)');
  assert.ok(intervalMs(999, 'days') < 2 ** 31, 'within what setInterval can wait');
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

test('Linux: a copy from the .deb never checks (its status says so); a release without its AppImage yet is no error', () => {
  const deb = new AppUpdater({ autoUpdater: null, enabled: false, offStatus: 'package', getSchedule: () => ({}), isBusy: () => false, log: quiet });
  deb.start();
  assert.strictEqual(deb.state.status, 'package');
  const up = fakeUpdater();
  const u = new AppUpdater({ autoUpdater: up, enabled: true, getSchedule: () => ({ mode: 'off' }), isBusy: () => false, log: quiet });
  up.emit('error', new Error('Cannot find latest-linux.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1.1.90/latest-linux.yml): HttpError: 404'));
  assert.strictEqual(u.state.status, 'current');
  assert.strictEqual(u.state.error, '');
  up.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.strictEqual(u.state.status, 'error', 'other failures still show');
});

test('the update check is once a day by default; copies still on the old 2-minute default move to it, once', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Settings } = require('../src/core/settings');
  const fresh = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-upd-')), null);
  assert.deepStrictEqual([fresh.get('updateEvery'), fresh.get('updateUnit')], [1, 'days']);
  // An older copy: settings.json saved with the old default, and one where the user chose 6 hours.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-upd-'));
  fs.writeFileSync(path.join(old, 'settings.json'), JSON.stringify({ updateEvery: 2, updateUnit: 'minutes' }));
  const moved = new Settings(old, null);
  assert.deepStrictEqual([moved.get('updateEvery'), moved.get('updateUnit')], [1, 'days']);
  moved.update({ updateEvery: 2, updateUnit: 'minutes' });
  assert.deepStrictEqual([new Settings(old, null).get('updateEvery'), new Settings(old, null).get('updateUnit')], [2, 'minutes'], 'chosen again later: kept');
  const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-upd-'));
  fs.writeFileSync(path.join(chosen, 'settings.json'), JSON.stringify({ updateEvery: 6, updateUnit: 'hours' }));
  assert.deepStrictEqual([new Settings(chosen, null).get('updateEvery'), new Settings(chosen, null).get('updateUnit')], [6, 'hours']);
});
