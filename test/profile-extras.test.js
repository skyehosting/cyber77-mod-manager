'use strict';
// A shared profile carries the sender's archive load order and their picks of whose copy of a
// shared file loads, in profile files and in share codes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');
const loadOrder = require('../src/core/loadOrder');
const profileCode = require('../src/core/profileCode');

const SEVEN_ZIP = require('./seven-zip');
const has7z = fs.existsSync(SEVEN_ZIP);
const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
const SHARED = 'archive/pc/mod/shared.archive';

function makeManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-extras-'));
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game, sevenZipPath: SEVEN_ZIP });
  const mgr = new ModManager({ settings, log: quiet });
  const zip = (name, files) => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-src-'));
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(src, rel), content);
    const out = path.join(root, name);
    execFileSync(SEVEN_ZIP, ['a', '-bso0', '-bsp0', out, '*'], { cwd: src });
    return out;
  };
  const installAs = async (name, files, modId, fileId) => {
    const [key] = await mgr.importArchives([zip(`${name}.zip`, files)]);
    const rec = mgr.data.downloads[key];
    delete mgr.data.downloads[key];
    const newKey = fileId ? String(fileId) : key;
    mgr.data.downloads[newKey] = { ...rec, key: newKey, modId, fileId, modName: name, name, version: '1.0' };
    const [res] = await mgr.install([newKey]);
    await mgr.setEnabled([res.id], true);
    return res.id;
  };
  const modlist = () => fs.readFileSync(loadOrder.modlistFile(game), 'utf8').split(/\r?\n/).filter(Boolean);
  return { mgr, game, zip, installAs, modlist };
}

test('adoptOrder puts the wanted archives in order in their own places and adds the missing ones', () => {
  // x and y are the receiver's own: they keep their places.
  assert.deepStrictEqual(loadOrder.adoptOrder(['a.archive', 'x.archive', 'b.archive', 'y.archive'], ['b.archive', 'a.archive']),
    ['b.archive', 'x.archive', 'a.archive', 'y.archive']);
  // Case is ignored and the receiver's spelling kept; c (not here yet) follows the one before it.
  assert.deepStrictEqual(loadOrder.adoptOrder(['A.archive', 'x.archive', 'B.archive'], ['b.archive', 'c.archive', 'a.archive']),
    ['B.archive', 'c.archive', 'x.archive', 'A.archive']);
  assert.deepStrictEqual(loadOrder.adoptOrder([], ['b.archive', 'a.archive']), ['b.archive', 'a.archive']);
});

test('an export carries the profile\'s archive order and file picks, and a code keeps them', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, installAs } = makeManager();
  const a = await installAs('Alpha', { 'alpha.archive': 'A', 'shared.archive': 'A' }, 10, 100);
  const b = await installAs('Beta', { 'beta.archive': 'B', 'shared.archive': 'B' }, 20, 200);
  const l = await installAs('Local', { 'local.archive': 'L', 'shared.archive': 'L' }, 0, 0);
  const off = await installAs('Off', { 'off.archive': 'O' }, 30, 300);
  mgr.saveLoadOrder(['off.archive', 'beta.archive', 'local.archive', 'shared.archive', 'alpha.archive']);
  await mgr.setEnabled([off], false);
  // Alpha's copy of the shared file loads, picked among all three.
  await mgr.setFileChoices({ [SHARED]: { id: a, among: [a, b, l] } });

  const doc = mgr.exportProfile('default');
  assert.deepStrictEqual(doc.mods.map(m => m.name), ['Alpha', 'Beta', 'Local']);
  assert.deepStrictEqual(doc.loadOrder, ['beta.archive', 'local.archive', 'shared.archive', 'alpha.archive'], 'the profile\'s archives only (not Off\'s)');
  assert.deepStrictEqual(doc.fileChoices, [{ file: SHARED, mod: 0, among: [0, 1, 2] }]);

  // In a code: the order as it is, the pick among the Nexus mods only (Local is not in a code).
  const back = profileCode.decode(profileCode.encode(doc));
  assert.deepStrictEqual(back.loadOrder, doc.loadOrder);
  assert.deepStrictEqual(back.fileChoices, [{ file: SHARED, mod: 0, among: [0, 1] }]);
  assert.strictEqual(back.localCount, 1);

  // No order set and no picks: nothing extra, and the code is as before.
  mgr.resetLoadOrder();
  await mgr.setFileChoices({ [SHARED]: null });
  const plain = mgr.exportProfile('default');
  assert.strictEqual(plain.loadOrder, undefined);
  assert.strictEqual(plain.fileChoices, undefined);
  const code = profileCode.decode(profileCode.encode(plain));
  assert.ok(!('loadOrder' in code) && !('fileChoices' in code));
});

test('importing takes in the sender\'s archive order and picks, also for mods still downloading', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, game, zip, installAs, modlist } = makeManager();
  const own = await installAs('Mine', { 'mine.archive': 'M' }, 90, 900);
  const a = await installAs('Alpha', { 'alpha.archive': 'A', 'shared.archive': 'A' }, 10, 100);
  const b = await installAs('Beta', { 'beta.archive': 'B', 'shared.archive': 'B' }, 20, 200);
  mgr.nexus.getFiles = async () => ({ files: [{ file_id: 300, name: 'Gamma', file_name: 'Gamma.zip', category_name: 'MAIN', size_in_bytes: 5 }], file_updates: [] });
  const doc = {
    format: 'cyber-mod-manager-profile', version: 1, name: 'Friend',
    // Lowest priority first: Gamma would win the shared file, but the sender picked Alpha's copy.
    mods: [{ name: 'Alpha', modId: 10, fileId: 100 }, { name: 'Beta', modId: 20, fileId: 200 }, { name: 'Gamma', modId: 30, fileId: 300 }],
    loadOrder: ['gamma.archive', 'shared.archive', 'beta.archive', 'alpha.archive'],
    fileChoices: [{ file: SHARED, mod: 0, among: [0, 1, 2] }],
  };
  const plan = await mgr.planProfileImport(doc);
  assert.strictEqual(plan.archives, 4);
  assert.strictEqual(plan.picks, 1);
  const queued = [];
  mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  await mgr.applyProfileImport(plan.token, 'Friend');

  assert.deepStrictEqual(mgr.data.fileChoices[SHARED], { id: a, among: [a, b, '300'] });
  assert.strictEqual(fs.readFileSync(path.join(game, SHARED), 'utf8'), 'A', 'Alpha\'s copy, as picked');
  assert.deepStrictEqual(modlist(), ['shared.archive', 'beta.archive', 'alpha.archive'], 'the sender\'s order (Mine is off in this profile)');
  assert.ok(mgr.data.loadOrder.includes('mine.archive') && mgr.data.loadOrder.includes('gamma.archive'), 'absent ones keep their places');

  // Gamma arrives: its archive goes where the sender had it, and the pick still holds.
  const q = queued[0];
  fs.mkdirSync(path.dirname(q.dest), { recursive: true });
  fs.copyFileSync(zip('Gamma.zip', { 'gamma.archive': 'G', 'shared.archive': 'G' }), q.dest);
  mgr.onDownloaded({ ...q, total: 5 });
  await new Promise(r => setTimeout(r, 30));
  await mgr.chain;
  await mgr.chain;
  assert.ok(mgr.data.mods['300']?.enabled);
  assert.deepStrictEqual(modlist(), ['gamma.archive', 'shared.archive', 'beta.archive', 'alpha.archive']);
  assert.strictEqual(fs.readFileSync(path.join(game, SHARED), 'utf8'), 'A');
  void own;
});

test('a failed import puts the load order and picks back', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, game, installAs } = makeManager();
  const a = await installAs('Alpha', { 'alpha.archive': 'A', 'shared.archive': 'A' }, 10, 100);
  const b = await installAs('Beta', { 'beta.archive': 'B', 'shared.archive': 'B' }, 20, 200);
  mgr.saveLoadOrder(['alpha.archive', 'beta.archive', 'shared.archive']);
  const before = [...mgr.data.loadOrder];
  const plan = await mgr.planProfileImport({
    format: 'cyber-mod-manager-profile', version: 1, name: 'P',
    mods: [{ modId: 10, fileId: 100 }, { modId: 20, fileId: 200 }],
    loadOrder: ['beta.archive', 'alpha.archive'], fileChoices: [{ file: SHARED, mod: 0, among: [0, 1] }],
  });
  fs.renameSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), path.join(game, 'gone.exe'));
  mgr.deployer.store.data.deployed = {};
  await assert.rejects(mgr.applyProfileImport(plan.token, 'P'), /folder/);
  assert.deepStrictEqual(mgr.data.loadOrder, before);
  assert.deepStrictEqual(mgr.data.fileChoices || {}, {});
  void a; void b;
});

test('a shared order and picks are checked: no folders, no bad places, no prototype keys', async () => {
  const { mgr } = makeManager();
  mgr.nexus.getFiles = async () => ({ files: [], file_updates: [] });
  const plan = await mgr.planProfileImport({
    format: 'cyber-mod-manager-profile', version: 1, name: 'x',
    mods: [{ modId: 1, fileId: 1 }, { modId: 2, fileId: 2 }],
    loadOrder: ['ok.archive', '../evil.archive', 'a\\b.archive', 'C:x.archive', 'notes.txt', 5, 'OK.archive', 'fine.ARCHIVE'],
    fileChoices: [
      { file: '../outside.archive', mod: 0, among: [0, 1] },
      { file: 'C:/abs.archive', mod: 0, among: [0, 1] },
      { file: '__proto__', mod: 0, among: [0, 1] },
      { file: 'archive/pc/mod/one.archive', mod: 0, among: [0] },
      { file: 'archive/pc/mod/far.archive', mod: 7, among: [7, 0] },
      { file: 'Archive\\PC\\mod\\Good.archive', mod: 1, among: [0, 1, 99, -1, 1.5] },
    ],
  });
  assert.strictEqual(plan.archives, 2, 'ok.archive (once, case ignored) and fine.ARCHIVE');
  assert.strictEqual(plan.picks, 1, 'only the good pick');
  const stored = mgr.profileImports.get(plan.token);
  assert.deepStrictEqual(stored.loadOrder, ['ok.archive', 'fine.ARCHIVE']);
  assert.deepStrictEqual(stored.picks, [{ file: 'archive/pc/mod/good.archive', mod: 1, among: [1, 0] }]);
});

test('a code with a damaged extra section is refused', () => {
  const doc = { name: 'x', mods: [{ modId: 1, fileId: 1 }, { modId: 2, fileId: 2 }], loadOrder: ['a.archive', 'b.archive'], fileChoices: [{ file: 'x', mod: 0, among: [0, 1] }] };
  const good = profileCode.encode(doc);
  assert.deepStrictEqual(profileCode.decode(good).loadOrder, ['a.archive', 'b.archive']);
  // Cut short inside the extra section.
  const zlib = require('zlib');
  const raw = zlib.inflateRawSync(Buffer.from(good.slice(profileCode.PREFIX.length), 'base64url'));
  const cut = profileCode.PREFIX + zlib.deflateRawSync(raw.subarray(0, raw.length - 3)).toString('base64url');
  assert.throws(() => profileCode.decode(cut), /damaged/);
});

test('names that differ only in case are one archive: placed, written as the file is spelled, not doubled', () => {
  assert.deepStrictEqual(loadOrder.mergeOrder(['b.ARCHIVE', 'a.archive'], ['A.archive', 'B.archive', 'c.archive']), ['B.archive', 'A.archive', 'c.archive']);
  assert.deepStrictEqual(loadOrder.keepAbsent(['x.archive', 'B.archive', 'gone.archive'], ['b.archive', 'a.archive']), ['x.archive', 'b.archive', 'gone.archive', 'a.archive']);
});

test('an import keeps the user\'s own pick for a file; a failed one puts modlist.txt back', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, game, installAs } = makeManager();
  const a = await installAs('Alpha', { 'alpha.archive': 'A', 'shared.archive': 'A' }, 10, 100);
  const b = await installAs('Beta', { 'beta.archive': 'B', 'shared.archive': 'B' }, 20, 200);
  await mgr.setFileChoices({ [SHARED]: { id: b, among: [a, b] } });
  mgr.nexus.getFiles = async () => ({ files: [], file_updates: [] });
  const doc = {
    format: 'cyber-mod-manager-profile', version: 1, name: 'P',
    mods: [{ modId: 10, fileId: 100 }, { modId: 20, fileId: 200 }],
    loadOrder: ['beta.archive', 'alpha.archive'], fileChoices: [{ file: SHARED, mod: 0, among: [0, 1] }],
  };
  // No order set here yet: a deploy that wrote the sender's and then failed must not leave it.
  const real = mgr.syncActiveProfile.bind(mgr);
  let calls = 0;
  mgr.syncActiveProfile = () => { if (++calls === 2) throw new Error('disk full'); return real(); };
  await assert.rejects(mgr.applyProfileImport((await mgr.planProfileImport(doc)).token, 'P'), /disk full/);
  assert.ok(!fs.existsSync(loadOrder.modlistFile(game)), 'no modlist.txt left behind');
  assert.strictEqual(mgr.data.loadOrder, undefined);
  mgr.syncActiveProfile = real;

  await mgr.applyProfileImport((await mgr.planProfileImport(doc)).token, 'P');
  assert.strictEqual(mgr.data.fileChoices[SHARED].id, b, 'the user\'s choice stays');
  assert.strictEqual(fs.readFileSync(path.join(game, SHARED), 'utf8'), 'B');
});

test('a code never holds more than it can read back', () => {
  const mods = Array.from({ length: 120 }, (_, i) => ({ modId: i + 1, fileId: i + 1 }));
  const doc = { name: 'x', mods, loadOrder: ['a.archive', 'b.archive'], fileChoices: [
    { file: 'wide', mod: 0, among: mods.map((_, i) => i) }, // among 120 mods: more than a code takes
    { file: 'ok', mod: 1, among: [0, 1] },
  ] };
  const back = profileCode.decode(profileCode.encode(doc));
  assert.deepStrictEqual(back.fileChoices.map(p => p.file), ['ok']);
});
