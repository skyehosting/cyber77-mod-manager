'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { EventEmitter } = require('events');

// tray.js with a stand-in for Electron: what closing the window does, not how a tray icon looks.
const made = [];
class FakeTray extends EventEmitter {
  constructor(img) { super(); this.img = img; this.destroyed = false; this.balloons = []; made.push(this); }
  setToolTip(t) { this.tip = t; }
  setContextMenu(m) { this.menu = m; }
  displayBalloon(b) { this.balloons.push(b); }
  destroy() { this.destroyed = true; }
}
const fakeElectron = {
  Tray: FakeTray,
  Menu: { buildFromTemplate: items => ({ items }) },
  nativeImage: { createFromPath: p => ({ path: p, isEmpty: () => false, resize() { return this; } }) },
  Notification: { isSupported: () => false },
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };
const { setupTray } = require('../src/tray');
Module._load = load;

function fakeWin() {
  const w = new EventEmitter();
  Object.assign(w, { hidden: false, shown: 0, isDestroyed: () => false, isMinimized: () => false, isVisible() { return !this.hidden; }, restore() {}, hide() { this.hidden = true; }, show() { this.hidden = false; this.shown++; }, focus() {} });
  w.close = () => { let prevented = false; w.emit('close', { preventDefault: () => { prevented = true; } }); return prevented ? 'hidden' : 'closed'; };
  return w;
}
const settingsWith = d => ({ get: k => d[k], update: p => Object.assign(d, p), d });

test('close hides to the tray (once with a hint); Quit, an update or Windows shutting down really close', () => {
  const app = new EventEmitter();
  app.quit = () => app.emit('before-quit');
  const settings = settingsWith({ closeToTray: true, trayHintShown: false });
  const t = setupTray({ app, settings, title: 'EMM' });
  const w = fakeWin();
  t.attach(w);
  const icon = made.at(-1);
  assert.strictEqual(w.close(), 'hidden');
  assert.ok(w.hidden);
  assert.ok(t.inTray(), 'in the tray: updates may install, Nexus links do not pop it up');
  assert.strictEqual(settings.d.trayHintShown, true, 'the hint is shown once');
  assert.strictEqual(icon.balloons.length, 1);
  assert.strictEqual(w.close(), 'hidden');
  // The icon brings it back; its menu has Open and Quit.
  icon.emit('click');
  assert.ok(!w.hidden);
  w.emit('show');
  assert.ok(!t.inTray());
  assert.deepStrictEqual(icon.menu.items.map(i => i.label || i.type), ['Open EMM', 'separator', 'Quit']);
  icon.menu.items.at(-1).click(); // Quit
  assert.strictEqual(w.close(), 'closed', 'quitting is never held up');
  // Windows signing out on a fresh window.
  const app2 = new EventEmitter();
  const t2 = setupTray({ app: app2, settings: settingsWith({ closeToTray: true, trayHintShown: true }), title: 'EMM' });
  const w2 = fakeWin();
  t2.attach(w2);
  w2.emit('session-end');
  assert.strictEqual(w2.close(), 'closed');
});

test('turned off: no tray icon and close closes; turned on again: the icon comes back', () => {
  const app = new EventEmitter();
  const settings = settingsWith({ closeToTray: false, trayHintShown: true });
  const before = made.length;
  const t = setupTray({ app, settings, title: 'EMM' });
  const w = fakeWin();
  t.attach(w);
  assert.strictEqual(made.length, before, 'no icon while off');
  assert.strictEqual(w.close(), 'closed');
  settings.update({ closeToTray: true });
  t.sync();
  assert.strictEqual(made.length, before + 1);
  assert.strictEqual(w.close(), 'hidden');
  settings.update({ closeToTray: false });
  t.sync();
  assert.ok(made.at(-1).destroyed, 'the icon goes away');
  assert.strictEqual(w.close(), 'closed');
});

test('back from an update installed in the tray: starts there; with no icon possible, it shows after all', () => {
  const app = new EventEmitter();
  const t = setupTray({ app, settings: settingsWith({ closeToTray: true, trayHintShown: true }), title: 'EMM', onHide() {} });
  const w = fakeWin();
  w.hidden = true;
  t.attach(w, { inTray: true });
  assert.ok(t.inTray());
  assert.ok(w.hidden);
  // A missing tray picture: no icon, so the window is not left hidden.
  const orig = fakeElectron.nativeImage.createFromPath;
  fakeElectron.nativeImage.createFromPath = () => ({ isEmpty: () => true, resize() { return this; } });
  const t2 = setupTray({ app, settings: settingsWith({ closeToTray: true, trayHintShown: true }), title: 'EMM', log: { warn() {} } });
  const w2 = fakeWin();
  w2.hidden = true;
  t2.attach(w2, { inTray: true });
  fakeElectron.nativeImage.createFromPath = orig;
  assert.ok(!w2.hidden, 'shown');
  assert.strictEqual(w2.close(), 'closed', 'and closing closes');
});

test('closing to the tray closes the AI settings window with it', () => {
  const app = new EventEmitter();
  let closed = 0;
  const t = setupTray({ app, settings: settingsWith({ closeToTray: true, trayHintShown: true }), title: 'EMM', onHide: () => { closed++; } });
  const w = fakeWin();
  t.attach(w);
  w.close();
  assert.strictEqual(closed, 1);
});
