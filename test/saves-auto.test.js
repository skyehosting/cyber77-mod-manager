'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

/** The app's manager with a save folder of its own (two saves) and its own backup folder. */
function setup(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-sauto-'));
  const saves = path.join(root, 'saves');
  for (const name of ['ManualSave-1', 'AutoSave-0']) {
    fs.mkdirSync(path.join(saves, name), { recursive: true });
    fs.writeFileSync(path.join(saves, name, 'sav.dat'), `save ${name}`);
    fs.writeFileSync(path.join(saves, name, 'metadata.9.json'), JSON.stringify({ Data: { metadata: { playthroughID: 'aaaa', level: 3 } } }));
  }
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ saveBackupDir: path.join(root, 'backups'), ...extra });
  const mgr = new ModManager({ settings, log: quiet });
  mgr.saves.savesDir = () => saves;
  mgr.data.mods.a = { id: 'a', name: 'A', version: '1', enabled: true, priority: 1, files: [] };
  return { mgr, saves, settings };
}
const play = (saves, name, text) => fs.writeFileSync(path.join(saves, name, 'sav.dat'), text);

test('automatic backups: the first one, then a pause while nothing was played, then the cooldown', async () => {
  const { mgr, saves } = setup();
  const first = await mgr.autoBackupSaves('play');
  assert.ok(first.made, 'the first automatic backup is made');
  assert.strictEqual(first.made.profileName, 'Default');
  assert.deepStrictEqual(await mgr.autoBackupSaves('play'), { skipped: 'not played since the last backup' });
  play(saves, 'AutoSave-0', 'played a bit, longer now');
  assert.deepStrictEqual(await mgr.autoBackupSaves('play'), { skipped: 'cooldown' }, 'played, but within the hour');
  mgr.data.saveBackup.at -= 61 * 60000;
  const later = await mgr.autoBackupSaves('play');
  assert.strictEqual(later.made?.reason, 'play', 'an hour later: backed up');
});

test('mods changed since the last backup: backed up right away, whatever the cooldown', async () => {
  const { mgr, saves } = setup();
  await mgr.autoBackupSaves('play');
  mgr.data.mods.b = { id: 'b', name: 'B', version: '1', enabled: true, priority: 2, files: [] };
  play(saves, 'ManualSave-1', 'a new manual save with mod B');
  const r = await mgr.autoBackupSaves('play');
  assert.strictEqual(r.made?.reason, 'play-mods');
});

test('the settings: off, no pause, a custom cooldown, and the limit per profile', async () => {
  const off = setup({ saveAutoBackup: false });
  assert.deepStrictEqual(await off.mgr.autoBackupSaves('play'), { skipped: 'off' });

  const { mgr, saves, settings } = setup({ savePauseUnchanged: false, saveCooldown: 0, saveMaxPerProfile: 3 });
  for (let i = 0; i < 5; i++) {
    play(saves, 'AutoSave-0', `round ${i}`);
    const r = await mgr.autoBackupSaves(i % 2 ? 'game-start' : 'play');
    assert.ok(r.made, `round ${i}`);
    await new Promise(res => setTimeout(res, 1100)); // backups are named by the second
  }
  assert.strictEqual(mgr.saves.list().length, 3, 'only the newest 3 kept');
  assert.ok(mgr.saves.list().some(b => b.reason === 'game-start'));
  // Bad values are clamped: the limit never goes below 3, the cooldown never below 0.
  settings.update({ saveMaxPerProfile: 1, saveCooldown: -5 });
  assert.deepStrictEqual([settings.get('saveMaxPerProfile'), settings.get('saveCooldown')], [3, 0]);
});

test('a manual backup works whatever the settings; none when there are no saves', async () => {
  const { mgr, saves } = setup({ saveAutoBackup: false });
  const r = await mgr.backupSavesNow({ label: 'Before the finale' });
  assert.deepStrictEqual([r.reason, r.label], ['manual', 'Before the finale']);
  fs.rmSync(saves, { recursive: true });
  await assert.rejects(mgr.backupSavesNow(), /no Cyberpunk 2077 saves/);
  const view = mgr.savesView();
  assert.deepStrictEqual([view.found, view.backups.length], [false, 1]);
});

test('the backup folder setting refuses unsafe places', () => {
  const { settings, saves } = setup();
  const before = settings.get('saveBackupDir');
  const { backupDirProblem } = require('../src/core/saves');
  const { defaultSavesDir } = require('../src/core/saves');
  const appSaves = defaultSavesDir(); // what Settings checks against: the game's save folder
  const bads = [String.raw`\\server\share\backups`, 'C:\\', String.raw`relative\folder`, process.env.WINDIR || String.raw`C:\Windows`, `C:${path.sep}${'y'.repeat(500)}`];
  for (const bad of [...bads, path.join(saves, 'backups'), path.dirname(saves)]) assert.ok(backupDirProblem(bad, saves), `refused: ${bad.slice(0, 40)}`);
  for (const bad of [...bads, path.join(appSaves, 'backups'), path.dirname(appSaves)]) {
    settings.update({ saveBackupDir: bad });
    assert.strictEqual(settings.get('saveBackupDir'), before, `not saved: ${bad.slice(0, 40)}`);
  }
  assert.strictEqual(backupDirProblem(path.join(os.tmpdir(), 'my backups'), saves), '');
  // The save folder named another way (a junction to it, or a short 8.3 name): still the save folder.
  const link = `${saves}-junction`;
  fs.symlinkSync(saves, link, 'junction');
  assert.ok(backupDirProblem(path.join(saves, 'backups'), link), 'refused: inside the saves, which were named by a junction');
  assert.ok(backupDirProblem(path.join(link, 'backups'), saves), 'refused: inside the saves, through a junction');
  fs.rmdirSync(link); // the junction only, never what it points to
  settings.update({ saveBackupDir: '' });
  assert.strictEqual(settings.get('saveBackupDir'), '', 'back to the default folder');
});

test('the pause only counts while its backup exists; its fingerprint is what the backup holds', async () => {
  const { mgr } = setup();
  const first = await mgr.autoBackupSaves('play');
  assert.ok(first.made);
  assert.deepStrictEqual(await mgr.autoBackupSaves('play'), { skipped: 'not played since the last backup' });
  mgr.saves.remove(first.made.id);
  const again = await mgr.autoBackupSaves('play');
  assert.ok(again.made, 'its backup was deleted: a new one is made even though nothing was played');
  const { savesFingerprint } = require('../src/core/saves');
  assert.strictEqual(mgr.data.saveBackup.savesFp, savesFingerprint(again.made.saves));
});

test('a save screenshot is only read when it is a real PNG file', () => {
  const { mgr, saves } = setup();
  fs.writeFileSync(path.join(saves, 'ManualSave-1', 'screenshot.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest')]));
  fs.writeFileSync(path.join(saves, 'AutoSave-0', 'screenshot.png'), 'not a png at all');
  assert.match(mgr.saveScreenshot('ManualSave-1'), /^data:image\/png;base64,/);
  assert.strictEqual(mgr.saveScreenshot('AutoSave-0'), '');
  assert.strictEqual(mgr.saveScreenshot('QuickSave-3'), '', 'missing: no error, no path');
  assert.throws(() => mgr.saveScreenshot('../../secret'), /No such save/);
});
