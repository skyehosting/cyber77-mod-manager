'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');
const { Deployer } = require('../src/core/deployer');
const loadOrder = require('../src/core/loadOrder');
const { findUpdate } = require('../src/core/updates');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

/** A game folder and a manager, with mods put straight into the library (no archives needed). */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-fix-'));
  const game = path.join(root, 'Cyberpunk 2077');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  const settings = new Settings(path.join(root, 'userdata'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  const addMod = (id, files, priority = 1) => {
    for (const [rel, text] of Object.entries(files)) {
      const full = path.join(settings.stagingDir, id, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    }
    mgr.data.mods[id] = { id, key: id, name: id, modName: id, files: Object.keys(files), enabled: false, priority, warnings: [] };
  };
  return { root, game, settings, mgr, addMod };
}
const read = (game, rel) => fs.readFileSync(path.join(game, rel), 'utf8');

test('the game folder moved (the old one is gone): the record is cleared and mods go into the new one', async () => {
  const { root, game, settings, mgr, addMod } = setup();
  addMod('a', { 'archive/pc/mod/a.archive': 'A' });
  await mgr.setEnabled(['a'], true);
  const moved = path.join(root, 'Moved Cyberpunk 2077');
  fs.renameSync(game, moved);
  settings.update({ gamePath: moved });
  await mgr.setEnabled(['a'], false);
  await mgr.setEnabled(['a'], true);
  assert.strictEqual(read(moved, 'archive/pc/mod/a.archive'), 'A');
});

test('a new game folder in Settings: mods come out of the old one (its original put back) and go into the new one', async () => {
  const { root, game, settings, mgr, addMod } = setup();
  fs.mkdirSync(path.join(game, 'engine/config'), { recursive: true });
  fs.writeFileSync(path.join(game, 'engine/config/user.ini'), 'original');
  addMod('a', { 'engine/config/user.ini': 'modded' });
  await mgr.setEnabled(['a'], true);
  const other = path.join(root, 'Second copy');
  fs.mkdirSync(path.join(other, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(other, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  settings.update({ gamePath: other });
  await mgr.prioritize(['a']); // any change deploys
  assert.strictEqual(read(game, 'engine/config/user.ini'), 'original', 'the old folder is as it was');
  assert.strictEqual(read(other, 'engine/config/user.ini'), 'modded');
});

test('repair puts a deleted file back and still restores the original when the mod goes off', async () => {
  const { game, mgr, addMod } = setup();
  fs.mkdirSync(path.join(game, 'engine/config'), { recursive: true });
  fs.writeFileSync(path.join(game, 'engine/config/user.ini'), 'original');
  addMod('a', { 'engine/config/user.ini': 'modded' });
  await mgr.setEnabled(['a'], true);
  fs.rmSync(path.join(game, 'engine/config/user.ini'));
  await mgr.repair(['a']);
  assert.strictEqual(read(game, 'engine/config/user.ini'), 'modded');
  await mgr.setEnabled(['a'], false);
  assert.strictEqual(read(game, 'engine/config/user.ini'), 'original');
});

test('a mod file that cannot be placed leaves the original in the game', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-fix-'));
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(game, 'engine/user.ini'), 'original');
  const staged = path.join(root, 'staged');
  fs.mkdirSync(path.join(staged, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(staged, 'engine/user.ini'), 'modded');
  const dep = new Deployer({ manifestFile: path.join(root, 'deployment.json'), backupDir: path.join(root, 'backups'), log: quiet });
  const copy = fs.copyFileSync;
  fs.copyFileSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  try {
    const res = dep.sync(game, [{ id: 'm', stagingDir: staged, files: ['engine/user.ini'] }], 'copy');
    assert.strictEqual(res.errors.length, 1);
  } finally {
    fs.copyFileSync = copy;
  }
  assert.strictEqual(read(game, 'engine/user.ini'), 'original');
});

test('the saved load order keeps the place of archives that are not in the game right now', () => {
  assert.deepStrictEqual(loadOrder.keepAbsent(['c', 'b', 'a'], ['b', 'a']), ['c', 'b', 'a'], 'a disabled mod keeps its place at the top');
  assert.deepStrictEqual(loadOrder.keepAbsent(['x', 'c', 'y', 'a'], ['a', 'c']), ['x', 'a', 'c', 'y'], 'each one stays after the one it followed');
  assert.deepStrictEqual(loadOrder.keepAbsent(['c', 'b'], []), ['c', 'b'], 'nothing in the game: the order is still remembered');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-fix-'));
  fs.mkdirSync(path.join(root, 'archive', 'pc', 'mod'), { recursive: true });
  fs.writeFileSync(path.join(root, 'archive', 'pc', 'mod', 'modlist.txt'), 'old.archive\r\n');
  assert.deepStrictEqual(loadOrder.writeOrder(root, ['old.archive']), []);
  assert.ok(!fs.existsSync(path.join(root, 'archive', 'pc', 'mod', 'modlist.txt')), 'no archives: no list, not an empty one');
});

test('an update is not guessed when the installed file is no longer listed at all', () => {
  const files = [{ file_id: 9, name: 'Optional addon', category_id: 3, uploaded_timestamp: 9 }];
  assert.strictEqual(findUpdate(files, [], 5), null);
});
