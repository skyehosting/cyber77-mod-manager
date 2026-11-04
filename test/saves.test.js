'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SaveBackups, scanSaves, groupPlaythroughs, savesFingerprint } = require('../src/core/saves');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

const meta = (name, playthroughID, level, extra = {}) => JSON.stringify({
  RootType: 'saveMetadataContainer',
  Data: { metadata: { name, playthroughID, level, lifePath: 'StreetKid', bodyGender: 'Female', locationName: 'LocKey#1', playthroughTime: level * 3600, buildPatch: '2.5', isModded: true, additionalContentIds: ['EP1'], ...extra } },
});

/** A save folder like the game's: two playthroughs, plus the global files beside them. */
function makeSaves(root) {
  const dir = path.join(root, 'Cyberpunk 2077');
  const save = (name, pt, level) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'sav.dat'), `save ${name}`);
    fs.writeFileSync(path.join(dir, name, 'screenshot.png'), 'png');
    fs.writeFileSync(path.join(dir, name, 'metadata.9.json'), meta(name, pt, level));
  };
  save('ManualSave-1', 'aaaa', 5);
  save('ManualSave-2', 'aaaa', 9);
  save('AutoSave-0', 'aaaa', 10);
  save('QuickSave-0', 'bbbb', 30);
  // Not saves: the global files (user.gls holds a sign-in token), the user's own archive, an unknown folder.
  fs.writeFileSync(path.join(dir, 'user.gls'), 'SLGR ... sign-in token ...');
  fs.writeFileSync(path.join(dir, 'EnabledMods.json'), '{}');
  fs.writeFileSync(path.join(dir, 'ManualSave-8.7z'), 'archive');
  fs.mkdirSync(path.join(dir, 'Something Else'));
  return dir;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-saves-'));
  const saves = makeSaves(root);
  const backups = path.join(root, 'backups');
  return { root, saves, backups, store: new SaveBackups({ savesDir: () => saves, root: () => backups, log: quiet }) };
}
const bdir = (store, id) => path.join(store.root(), ...id.split('/'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('reading saves: slots only, metadata, playthroughs', () => {
  const { saves } = setup();
  const list = scanSaves(saves);
  assert.deepStrictEqual(list.map(s => s.folder).sort(), ['AutoSave-0', 'ManualSave-1', 'ManualSave-2', 'QuickSave-0']);
  const s = list.find(x => x.folder === 'ManualSave-2');
  assert.deepStrictEqual([s.kind, s.number, s.playthrough, s.level, s.lifePath, s.gameVersion, s.modded, s.phantomLiberty], ['ManualSave', 2, 'aaaa', 9, 'StreetKid', '2.5', true, true]);
  assert.deepStrictEqual(groupPlaythroughs(list).map(p => [p.id, p.count, p.level]).sort(), [['aaaa', 3, 10], ['bbbb', 1, 30]]);
  fs.writeFileSync(path.join(saves, 'ManualSave-1', 'metadata.9.json'), '{ not json');
  assert.strictEqual(scanSaves(saves).find(x => x.folder === 'ManualSave-1').playthrough, 'unknown', 'broken metadata: still a save');
});

test('a backup: plain folders of the saves only; the next one shares unchanged files; live saves never linked', async () => {
  const { saves, store } = setup();
  const b1 = await store.create({ reason: 'manual', profile: 'p1', profileName: 'Default', mods: 12 });
  const d1 = bdir(store, b1.id);
  assert.deepStrictEqual(fs.readdirSync(d1).sort(), ['AutoSave-0', 'ManualSave-1', 'ManualSave-2', 'QuickSave-0', 'backup.json']);
  assert.ok(!fs.readdirSync(store.root(), { recursive: true }).some(f => /user\.gls/i.test(f)), 'the sign-in token file is never copied');
  assert.deepStrictEqual([b1.reason, b1.profileName, b1.mods, b1.saves.length], ['manual', 'Default', 12, 4]);
  assert.deepStrictEqual(b1.saves.map(x => [x.folder, x.kind, x.number]).sort(), [['AutoSave-0', 'AutoSave', 0], ['ManualSave-1', 'ManualSave', 1], ['ManualSave-2', 'ManualSave', 2], ['QuickSave-0', 'QuickSave', 0]], 'each save keeps its slot name and number');
  assert.notStrictEqual(fs.statSync(path.join(saves, 'ManualSave-2', 'sav.dat')).ino, fs.statSync(path.join(d1, 'ManualSave-2', 'sav.dat')).ino);
  fs.writeFileSync(path.join(saves, 'ManualSave-2', 'sav.dat'), 'rewritten in place');
  assert.strictEqual(read(d1, 'ManualSave-2', 'sav.dat'), 'save ManualSave-2', 'the game rewriting a save cannot change a backup');
  const b2 = await store.create({ reason: 'play' });
  const d2 = bdir(store, b2.id);
  const ino = (d, s) => fs.statSync(path.join(d, s, 'sav.dat')).ino;
  assert.strictEqual(ino(d1, 'ManualSave-1'), ino(d2, 'ManualSave-1'), 'unchanged: stored once');
  assert.notStrictEqual(ino(d1, 'ManualSave-2'), ino(d2, 'ManualSave-2'));
  assert.deepStrictEqual(store.list().map(b => b.id), [b2.id, b1.id], 'newest first');
});

test('deleting and pruning: frees only files no backup uses; pinned and recent safety backups stay; bad limits remove nothing', async () => {
  const { saves, store } = setup();
  const ids = [];
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(saves, 'QuickSave-0', 'sav.dat'), `played ${i}`);
    ids.push((await store.create({ reason: i === 1 ? 'restore' : 'play', profile: 'p1' })).id);
  }
  store.update(ids[0], { pinned: true, label: 'Before the heist' });
  for (const bad of [undefined, null, 'x', NaN, 0, -1, 2, 2.5]) assert.deepStrictEqual(store.prune(bad), [], `prune(${bad}) removes nothing`);
  // Keep 3: of the unpinned, non-safety ones (2, 3, 4, 5) the oldest one goes.
  assert.deepStrictEqual(store.prune(3), [ids[2]]);
  const left = store.list().map(b => b.id);
  assert.ok(left.includes(ids[0]) && left.includes(ids[1]), 'pinned and the safety backup stay');
  assert.strictEqual(store.list().find(b => b.id === ids[0]).label, 'Before the heist');
  assert.ok(store.remove(ids[5]) > 0, 'its own files were freed');
  assert.strictEqual(read(bdir(store, ids[0]), 'QuickSave-0', 'sav.dat'), 'played 0', 'others untouched');
});

test('restoring one save or the whole set: a safety backup first, copies, saves made later leave with "all"', async () => {
  const { saves, store } = setup();
  const b = await store.create({ reason: 'manual' });
  fs.writeFileSync(path.join(saves, 'ManualSave-1', 'sav.dat'), 'broken by a mod');
  fs.mkdirSync(path.join(saves, 'ManualSave-3'));
  fs.writeFileSync(path.join(saves, 'ManualSave-3', 'sav.dat'), 'newer save');
  assert.deepStrictEqual(await store.restore(b.id, ['ManualSave-1']), ['ManualSave-1']);
  assert.strictEqual(read(saves, 'ManualSave-1', 'sav.dat'), 'save ManualSave-1');
  assert.ok(fs.existsSync(path.join(saves, 'ManualSave-3')), 'one save: the others stay');
  assert.notStrictEqual(fs.statSync(path.join(saves, 'ManualSave-1', 'sav.dat')).ino, fs.statSync(path.join(bdir(store, b.id), 'ManualSave-1', 'sav.dat')).ino, 'a copy, not a link');
  fs.writeFileSync(path.join(saves, 'ManualSave-1', 'sav.dat'), 'the game can write the restored save');
  const safety = store.list().find(x => x.reason === 'restore');
  assert.ok(safety && safety.saves.some(s => s.folder === 'ManualSave-3'), 'the safety backup holds the newer save');
  await store.restore(b.id, 'all');
  assert.ok(!fs.existsSync(path.join(saves, 'ManualSave-3')), 'the whole set: saves made after it leave');
  for (const f of ['user.gls', 'EnabledMods.json', 'ManualSave-8.7z', 'Something Else']) assert.ok(fs.existsSync(path.join(saves, f)), `${f} untouched`);
  assert.ok(!fs.readdirSync(saves).some(f => /restoring|partial|tmp/.test(f)), 'nothing of this app\'s left in the game\'s folder');
});

test('a damaged or crafted backup never empties the save folder', async () => {
  const { saves, store } = setup();
  const before = scanSaves(saves).map(s => s.folder).sort();
  // 1. A record listing only a non-slot name.
  const crafted = await store.create({ reason: 'manual' });
  const file = path.join(bdir(store, crafted.id), 'backup.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, saves: [{ folder: 'x' }, { folder: '../../evil' }] }));
  await assert.rejects(store.restore(crafted.id, 'all'), /no complete saves/);
  assert.deepStrictEqual(scanSaves(saves).map(s => s.folder).sort(), before);
  // 2. A backup missing one of its slots: "all" refuses; the slots that are complete restore one by one.
  const half = await store.create({ reason: 'manual' });
  fs.rmSync(path.join(bdir(store, half.id), 'ManualSave-1'), { recursive: true });
  await assert.rejects(store.restore(half.id, 'all'), /incomplete/);
  await assert.rejects(store.restore(half.id, ['ManualSave-1']), /no complete saves/);
  assert.strictEqual(read(saves, 'ManualSave-1', 'sav.dat'), 'save ManualSave-1', 'the live save is untouched');
  // 3. A file changed inside a backup (its hash no longer matches): not restored.
  const edited = await store.create({ reason: 'manual' });
  const f = path.join(bdir(store, edited.id), 'ManualSave-2', 'sav.dat');
  fs.chmodSync(f, 0o666);
  fs.rmSync(f);
  fs.writeFileSync(f, 'tampered');
  await assert.rejects(store.restore(edited.id, ['ManualSave-2']), /no complete saves/);
  assert.strictEqual(read(saves, 'ManualSave-2', 'sav.dat'), 'save ManualSave-2');
  // 4. A recorded file missing from the backup (here its metadata): that save is incomplete, not restored.
  const thin = await store.create({ reason: 'manual' });
  const m = path.join(bdir(store, thin.id), 'ManualSave-1', 'metadata.9.json');
  fs.chmodSync(m, 0o666);
  fs.rmSync(m);
  await assert.rejects(store.restore(thin.id, ['ManualSave-1']), /no complete saves/);
  assert.ok(fs.existsSync(path.join(saves, 'ManualSave-1', 'metadata.9.json')));
  // 5. The same save asked twice is restored once.
  const fresh = await store.create({ reason: 'manual' });
  assert.deepStrictEqual(await store.restore(fresh.id, ['ManualSave-2', 'ManualSave-2']), ['ManualSave-2']);
  // 6. Ids never leave the backup folder (nor reach a half-made one through Windows' trailing-dot rule).
  for (const bad of ['../../etc', '.store/ab', 'x', `${crafted.id}/../../..`, 'C:/Windows/System32', `${crafted.id}.partial`, `${crafted.id}.partial.`, `${crafted.id} `]) {
    await assert.rejects(store.restore(bad, 'all'), /does not exist/, bad);
    assert.throws(() => store.remove(bad), /does not exist/, bad);
  }
});

test('leftovers of an interrupted backup are swept; odd reasons are not folder names', async () => {
  const { store } = setup();
  const b = await store.create({ reason: 'constructor' });
  assert.strictEqual(b.reason, 'manual');
  assert.ok(!b.id.includes('function'), b.id);
  // A half-made backup from a crash, 20 minutes old: invisible to the list, removed by the next backup.
  const day = path.dirname(bdir(store, b.id));
  const partial = path.join(day, '00-00-00 Before play.partial');
  fs.cpSync(bdir(store, b.id), partial, { recursive: true });
  const old = new Date(Date.now() - 20 * 60000);
  fs.utimesSync(partial, old, old);
  assert.strictEqual(store.list().length, 1);
  await store.create({ reason: 'play' });
  assert.ok(!fs.existsSync(partial), 'swept');
});

test('a huge stray file in a save folder is left out, and does not block backups or restores', async () => {
  const { saves, store } = setup();
  const big = path.join(saves, 'ManualSave-1', 'not-part-of-the-save.bin');
  const fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, (256 << 20) + 1); // sparse: no real disk space
  fs.closeSync(fd);
  const b = await store.create({ reason: 'manual' });
  assert.ok(!fs.existsSync(path.join(bdir(store, b.id), 'ManualSave-1', 'not-part-of-the-save.bin')));
  assert.deepStrictEqual(await store.restore(b.id, ['ManualSave-2']), ['ManualSave-2'], 'its safety backup works too');
  // Restoring the slot that holds it: the big file (in no backup) stays in the restored slot.
  assert.deepStrictEqual(await store.restore(b.id, ['ManualSave-1']), ['ManualSave-1']);
  assert.strictEqual(fs.statSync(big).size, (256 << 20) + 1);
});

test('restore always takes its safety backup: no option turns it off', async () => {
  const { saves, store } = setup();
  const b = await store.create({ reason: 'manual' });
  fs.mkdirSync(path.join(saves, 'ManualSave-7'));
  fs.writeFileSync(path.join(saves, 'ManualSave-7', 'sav.dat'), 'made after the backup');
  await store.restore(b.id, 'all', { safety: false });
  const safety = store.list().find(x => x.reason === 'restore');
  assert.ok(safety && safety.saves.some(s => s.folder === 'ManualSave-7'), 'the save that left is in the safety backup');
});

test('the fingerprint changes only when saves change', () => {
  const { saves } = setup();
  const a = savesFingerprint(scanSaves(saves));
  assert.strictEqual(savesFingerprint(scanSaves(saves)), a);
  fs.writeFileSync(path.join(saves, 'AutoSave-0', 'sav.dat'), 'a new autosave, longer than before');
  assert.notStrictEqual(savesFingerprint(scanSaves(saves)), a);
});
