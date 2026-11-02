'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lo = require('../src/core/loadOrder');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function game(names, modlist) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-lo-'));
  const dir = path.join(root, 'game', 'archive', 'pc', 'mod');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'game', 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(root, 'game', 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  for (const n of names) fs.writeFileSync(path.join(dir, n), n);
  fs.writeFileSync(path.join(dir, 'Some.archive.xl'), 'xl'); // not an archive itself
  if (modlist) fs.writeFileSync(path.join(dir, 'modlist.txt'), modlist.join('\n'));
  return { root, gameDir: path.join(root, 'game'), dir };
}

test('the game order: ASCII by name, or modlist.txt first', () => {
  const g = game(['c.archive', '#first.archive', 'B.archive', 'a.archive']);
  assert.deepStrictEqual(lo.currentOrder(g.gameDir), { custom: false, order: ['#first.archive', 'B.archive', 'a.archive', 'c.archive'] }, 'ASCII: capitals before lower case');
  const h = game(['a.archive', 'b.archive', 'c.archive'], ['c.archive', 'gone.archive', 'a.archive']);
  assert.deepStrictEqual(lo.currentOrder(h.gameDir), { custom: true, order: ['c.archive', 'a.archive', 'b.archive'] }, 'missing names are skipped, unlisted ones follow');
});

test('auto-sort puts each mod above the mods it needs and keeps the rest in place', () => {
  const order = ['#logic.archive', 'base.archive', 'addon.archive', 'zz_patch.archive', 'other.archive'];
  const owner = new Map([['base.archive', 1], ['addon.archive', 2], ['zz_patch.archive', 3]]);
  const needs = new Map([[2, [1]], [3, [2]], [1, [2]]]); // 1 ↔ 2 is a loop
  const sorted = lo.autoSort(order, owner, new Map([[2, [1]], [3, [2]]]));
  assert.ok(sorted.indexOf('zz_patch.archive') < sorted.indexOf('addon.archive'));
  assert.ok(sorted.indexOf('addon.archive') < sorted.indexOf('base.archive'));
  assert.deepStrictEqual([sorted[0], sorted.at(-1)], ['#logic.archive', 'other.archive'], 'mods without requirements keep their place');
  assert.strictEqual(lo.autoSort(order, owner, needs).length, order.length, 'a loop does not hang or lose archives');
});

test('saving lists every archive; new archives slot in by name; reset removes the file', () => {
  const g = game(['a.archive', 'b.archive'], ['b.archive', 'a.archive']);
  fs.writeFileSync(path.join(g.dir, 'c.archive'), 'c');
  const full = lo.writeOrder(g.gameDir, ['b.archive', 'a.archive']);
  assert.deepStrictEqual(full, ['b.archive', 'a.archive', 'c.archive']);
  assert.ok(fs.existsSync(path.join(g.dir, 'modlist.txt.cmm-backup')), 'the modlist.txt there was before is kept');
  assert.deepStrictEqual(fs.readFileSync(path.join(g.dir, 'modlist.txt'), 'utf8').trim().split(/\r?\n/), full);
  lo.resetOrder(g.gameDir);
  assert.strictEqual(lo.currentOrder(g.gameDir).custom, false);
});

test('auto-sort through the app, with requirements from Nexus', async () => {
  const g = game(['ArchiveXL.archive', 'MyOutfit.archive']);
  const settings = new Settings(path.join(g.root, 'ud'), null);
  settings.update({ gamePath: g.gameDir });
  const mgr = new ModManager({ settings, log: quiet });
  mgr.data.mods.x = { id: 'x', name: 'ArchiveXL', modId: 4198, enabled: true, files: ['archive/pc/mod/ArchiveXL.archive'], priority: 1 };
  mgr.data.mods.o = { id: 'o', name: 'My Outfit', modId: 9, enabled: true, files: ['archive/pc/mod/MyOutfit.archive'], priority: 2 };
  mgr.nexus.getRequirementsMany = async () => new Map([[9, [4198]], [4198, []]]);
  const r = await mgr.autoSortLoadOrder();
  assert.deepStrictEqual(r.archives.map(a => a.name), ['MyOutfit.archive', 'ArchiveXL.archive']);
  assert.strictEqual(r.moved, 2);
  assert.deepStrictEqual(r.needs['9'], ['ArchiveXL']);
  assert.strictEqual(r.custom, true);
  // Installing another archive mod later keeps the saved order and adds the new one.
  fs.writeFileSync(path.join(g.dir, 'Hair.archive'), 'h');
  mgr.deploy();
  assert.deepStrictEqual(lo.currentOrder(g.gameDir).order, ['Hair.archive', 'MyOutfit.archive', 'ArchiveXL.archive']);
});
