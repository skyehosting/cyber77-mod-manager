'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');
const { SaveTrash } = require('../src/core/saveTrash');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

/** Game saves (two playthroughs) and a second profile, in a temp folder of their own: nothing real is touched. */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-trash-'));
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  const saves = path.join(root, 'saves');
  const save = (dir, name, pt, text = `save ${name}`) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'sav.dat'), text);
    fs.writeFileSync(path.join(dir, name, 'metadata.9.json'), JSON.stringify({ Data: { metadata: { playthroughID: pt, level: 5 } } }));
  };
  save(saves, 'ManualSave-1', 'aaaa');
  save(saves, 'AutoSave-0', 'aaaa');
  save(saves, 'QuickSave-0', 'bbbb');
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game, saveBackupDir: path.join(root, 'backups') });
  const mgr = new ModManager({ settings, log: quiet });
  mgr.saves.savesDir = () => saves;
  mgr.profileSaves.root = () => path.join(root, 'profile saves');
  mgr.trash.root = () => path.join(root, 'trash');
  mgr.gameRunning = async () => false;
  mgr.data.profiles.list.p2 = { id: 'p2', name: 'Photo mode', enabled: [], created: Date.now() };
  return { mgr, saves, root, first: mgr.data.profiles.active, save };
}
const slots = dir => { try { return fs.readdirSync(dir).filter(n => /-\d+$/.test(n)).sort(); } catch { return []; } };

test('deleting saves moves them to the Trash; restore puts them back where they were', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  const r = await mgr.trashSaves(first, ['ManualSave-1', 'QuickSave-0']);
  assert.strictEqual(r.trashed, 2);
  assert.deepStrictEqual(slots(saves), ['AutoSave-0']);
  const list = mgr.savesView().trash;
  assert.strictEqual(list.length, 2);
  assert.ok(list.every(x => x.from.profile === first && x.from.game), 'remembers where each came from');
  const back = await mgr.restoreTrash(r.ids);
  assert.strictEqual(back.restored, 2);
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
  assert.strictEqual(fs.readFileSync(path.join(saves, 'ManualSave-1', 'sav.dat'), 'utf8'), 'save ManualSave-1');
  assert.strictEqual(mgr.trash.list().length, 0);
});

test('a restore never overwrites: a taken slot gets the next free manual save number; the same save is not duplicated', async () => {
  const { mgr, saves, first, save } = setup();
  await mgr.setPerProfileSaves(true);
  const { ids } = await mgr.trashSaves(first, ['ManualSave-1', 'QuickSave-0']);
  save(saves, 'ManualSave-1', 'aaaa', 'played since'); // the game reused the slot
  fs.cpSync(path.join(mgr.trash.dirOf(ids[1]), 'QuickSave-0'), path.join(saves, 'QuickSave-0'), { recursive: true }); // a cloud copy came back
  const r = await mgr.restoreTrash(ids);
  assert.deepStrictEqual({ restored: r.restored, present: r.present, renamed: r.renamed }, { restored: 1, present: 1, renamed: 1 });
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'ManualSave-2', 'QuickSave-0']);
  assert.strictEqual(fs.readFileSync(path.join(saves, 'ManualSave-1', 'sav.dat'), 'utf8'), 'played since');
  assert.strictEqual(fs.readFileSync(path.join(saves, 'ManualSave-2', 'sav.dat'), 'utf8'), 'save ManualSave-1');
});

test('move: copied first, the originals go to the Trash only once the target has them', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  const r = await mgr.moveSaves(first, ['ManualSave-1', 'AutoSave-0'], ['p2']);
  assert.strictEqual(r.moved, 2);
  assert.deepStrictEqual(slots(saves), ['QuickSave-0']);
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf('p2')), ['AutoSave-0', 'ManualSave-1']);
  assert.strictEqual(mgr.trash.list().length, 2, 'the originals can still be put back');
  assert.deepStrictEqual(await mgr.savesPresence('p2', ['ManualSave-1', 'AutoSave-0'], [first]), { [first]: 0 });
  assert.deepStrictEqual(await mgr.savesPresence(first, ['QuickSave-0'], ['p2', first]), { p2: 0 }, 'the source itself is not a target');
});

test('nothing moves out of or back into the game\'s folder while the game runs', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  const { ids } = await mgr.trashSaves(first, ['QuickSave-0']);
  mgr.gameRunning = async () => true;
  await assert.rejects(mgr.trashSaves(first, ['ManualSave-1']), /Close Cyberpunk 2077 first/);
  await assert.rejects(mgr.moveSaves(first, ['ManualSave-1'], ['p2']), /Close Cyberpunk 2077 first/);
  await assert.rejects(mgr.restoreTrash(ids), /Close Cyberpunk 2077 first/);
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1']);
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf('p2')), [], 'a refused move copied nothing either');
});

test('a save whose profile is gone asks for a place; purge deletes for good', async () => {
  const { mgr, first } = setup();
  await mgr.setPerProfileSaves(true);
  await mgr.copySaves(first, ['QuickSave-0'], ['p2']);
  const { ids } = await mgr.trashSaves('p2', ['QuickSave-0']);
  delete mgr.data.profiles.list.p2;
  const r = await mgr.restoreTrash(ids);
  assert.strictEqual(r.missing, 1);
  await assert.rejects(mgr.restoreTrash(ids, 'constructor'), /no longer exists/);
  const again = await mgr.trashSaves(first, ['AutoSave-0']);
  const p = await mgr.purgeTrash('all');
  assert.strictEqual(p.removed, 2);
  assert.ok(p.freed > 0);
  assert.strictEqual(mgr.trash.list().length, 0);
  await assert.rejects(mgr.restoreTrash(again.ids), /no longer in the Trash/);
});

test('trash ids and slots are checked: nothing outside the Trash can be named', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-trash-ids-'));
  const t = new SaveTrash({ root: () => root });
  for (const bad of ['..', '../x', 'a/b', 'constructor', '']) assert.throws(() => t.dirOf(bad), /No such deleted save/);
  await assert.rejects(t.put(root, '../../etc', {}), /No such save/);
  assert.deepStrictEqual(t.list(), []);
  assert.deepStrictEqual(await t.purge(['../x']), { removed: 0, freed: 0 });
});

test('another drive: once the Trash has a whole copy it is kept, even if the original can\'t be removed', async () => {
  const fsp = require('fs/promises');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-trash-xdev-'));
  const saves = path.join(root, 'saves');
  fs.mkdirSync(path.join(saves, 'ManualSave-3'), { recursive: true });
  fs.writeFileSync(path.join(saves, 'ManualSave-3', 'sav.dat'), 'precious');
  const warned = [];
  const t = new SaveTrash({ root: () => path.join(root, 'trash'), log: { warn: m => warned.push(m) } });
  const { rename, rm } = fsp;
  const src = path.join(saves, 'ManualSave-3');
  fsp.rename = async (a, b) => { if (a === src) { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; } return rename(a, b); };
  fsp.rm = async (p, o) => { if (p === src) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } return rm(p, o); };
  try {
    const id = await t.put(saves, 'ManualSave-3', { profile: 'p1' });
    assert.strictEqual(fs.readFileSync(path.join(t.dirOf(id), 'ManualSave-3', 'sav.dat'), 'utf8'), 'precious', 'the whole copy stays in the Trash');
    assert.strictEqual(warned.length, 1, 'the user is told the original is still there');
  } finally {
    fsp.rename = rename;
    fsp.rm = rm;
  }
});
