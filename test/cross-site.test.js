'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rank, nameScore } = require('../src/core/crossMatch');
const { cleanMod } = require('../src/core/groups/log');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

test('the same mod on the other site: ranked by name, author and version; only a strong match is called likely', () => {
  const want = { name: 'Night City Interactions', author: 'Deceptious', version: '2.1' };
  const r = rank(want, [
    { id: 1, name: 'Night City Interactions [DQC]', author: 'Deceptious', version: '2.1' },
    { id: 2, name: 'Night City Interactions', author: 'SomeoneElse', version: '1.0' },
    { id: 3, name: 'Better Night Sky', author: 'Deceptious', version: '2.1' },
    { id: 4, name: 'Totally Different Mod', author: 'X', version: '' },
  ]);
  assert.deepStrictEqual(r.map(c => c.id), [1, 2, 3, 4]);
  assert.strictEqual(r[0].likely, true);
  assert.match(r[0].why, /same author/);
  assert.strictEqual(r[3].likely, false);
  assert.ok(r[3].score < 0.4);
  assert.strictEqual(nameScore('Here\'s Brendan', 'Heres Brendan!'), 1, 'punctuation and accents do not count');
});

test('group lists: a mod.io mod is an entry with negative ids (older apps skip it); never a Nexus mod id and a mod.io file', () => {
  const e = cleanMod({ modId: -6338259, fileId: -101, name: 'Deceptious Quest Core', author: 'Deceptious', version: '3.6.1', reqs: [{ modId: -5, name: 'Dep' }, { modId: 7, name: 'Nexus req on a mod.io entry' }] });
  assert.deepStrictEqual([e.modId, e.fileId, e.author, e.reqs], [-6338259, -101, 'Deceptious', [{ modId: -5, name: 'Dep' }]]);
  assert.strictEqual(cleanMod({ modId: -5, fileId: 9, name: 'Mixed' }), null, 'a mod on one site, its file on the other: refused');
  assert.strictEqual(cleanMod({ modId: 0, fileId: 1, name: 'Zero' }), null);
  assert.strictEqual(cleanMod({ modId: 4198, fileId: 777, name: 'ArchiveXL' }).modId, 4198, 'Nexus entries as before');
  // What an app from before mod.io support did with it (positive ids only): skipped, not misread.
  const posInt = v => (Number.isSafeInteger(v) && v > 0 ? v : null);
  assert.strictEqual(posInt(e.modId), null);
});

function mgrWith(mods = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-cross-'));
  const ud = path.join(root, 'ud');
  fs.mkdirSync(path.join(ud, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ud, 'data', 'library.json'), JSON.stringify({ downloads: {}, mods, nextPriority: 3 }));
  const settings = new Settings(ud, null);
  settings.update({ dataDir: path.join(ud, 'data') });
  return new ModManager({ settings, log: quiet });
}

test('matches across sites: only a mod on one site to a mod on the other is remembered; it shows in the snapshot', () => {
  const mgr = mgrWith();
  assert.throws(() => mgr.crossLink(-10, -100, -20), /Not a match between Nexus Mods and mod\.io/, 'mod.io to mod.io');
  assert.throws(() => mgr.crossLink(10, -100, -20), /Not a match/, 'an entry with ids on two sites');
  assert.throws(() => mgr.crossLink(0, 0, 5), /Not a match/);
  mgr.crossLink(-10, -100, 4198);
  assert.deepStrictEqual({ ...mgr.snapshot().crossLinks['-10'], at: 0 }, { target: 4198, file: -100, at: 0 });
});

test('finding on the other site: Nexus results ranked for a mod.io mod, mod.io results for a Nexus mod', async () => {
  const mgr = mgrWith();
  mgr.nexus.searchMods = async ({ query }) => ({ mods: [
    { modId: 55, name: 'Something Else', author: 'Y', version: '1', thumbnail: '' },
    { modId: 44, name: query, author: 'Deceptious', version: '3.6.1', thumbnail: 'https://staticdelivery.nexusmods.com/x.jpg' },
  ] });
  const n = await mgr.crossFind({ name: 'Deceptious Quest Core', author: 'Deceptious', version: '3.6.1', to: 'nexus' });
  assert.deepStrictEqual([n[0].site, n[0].id, n[0].likely], ['nexus', 44, true]);
  mgr.modio.search = async () => ({ mods: [{ id: 9, name: 'ArchiveXL', author: 'psiberx', version: '1.0', logo: '', summary: '', mature: false, fileId: 90 }] });
  const m = await mgr.crossFind({ name: 'ArchiveXL', author: 'psiberx', to: 'modio' });
  assert.deepStrictEqual([m[0].site, m[0].id], ['modio', 9]);
  await assert.rejects(mgr.crossFind({ name: '   ', to: 'nexus' }), /No name/);
});

test('a mod.io download with the requirements the user ticked (not all of them), and its PC files only', async () => {
  const mgr = mgrWith();
  const queued = [];
  mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  const mk = (id, deps = []) => ({ id, nameId: `m${id}`, name: `Mod ${id}`, author: '', logo: '', url: 'https://mod.io/g/cyberpunk-2077', fileId: id * 10, file: { id: id * 10, fileName: `${id}.zip`, version: '1', size: 1, added: 0, virusPositive: 0 }, dependencies: deps });
  const mods = { 1: mk(1, [{ id: 2, name: 'Two', fileId: 20 }, { id: 3, name: 'Three', fileId: 30 }]), 2: mk(2), 3: mk(3) };
  mgr.modio.mod = async id => mods[id];
  await mgr.queueModio(1, { deps: [3] });
  assert.deepStrictEqual(queued.map(q => q.modio.id), [1, 3], 'only the ticked requirement');
  // Its files: only those for PC (or for every platform), newest first, the live one marked.
  mgr.modio.request = async () => ({ data: [
    { id: 12, version: '1.2', filename: 'b.zip', filesize: 2, date_added: 2, platforms: [{ platform: 'windows', status: 1 }] },
    { id: 11, version: '1.1-ps5', filename: 'p.zip', filesize: 2, date_added: 1, platforms: [{ platform: 'ps5', status: 1 }] },
    { id: 10, version: '1.0', filename: 'a.zip', filesize: 2, date_added: 0, platforms: [] },
  ] });
  mgr.modio.mod = async () => ({ fileId: 12 });
  const files = await mgr.modio.files(1);
  assert.deepStrictEqual(files.map(f => [f.id, f.live]), [[12, true], [10, false]]);
});

test('cross-site (audit): a file pinned on a list must be one of the mod\'s PC files; a match can be forgotten', async () => {
  const mgr = mgrWith();
  mgr.downloader.enqueue = spec => spec;
  mgr.modio.mod = async () => ({ id: 1, nameId: 'a', name: 'Quest', author: '', logo: '', url: '', fileId: 12, file: { id: 12, fileName: 'a.zip', version: '1', size: 1, added: 0, virusPositive: 0 }, dependencies: [] });
  mgr.modio.files = async () => [{ id: 12 }, { id: 10 }];
  await assert.rejects(mgr.queueModio(1, { fileId: 11 }), /not a PC file/, 'a console file (or one that is gone)');
  mgr.modio.file = async (_m, f) => ({ id: f, fileName: 'old.zip', version: '0.9', size: 1, added: 0, virusPositive: 0 });
  const r = await mgr.queueModio(1, { fileId: 10, withDeps: false });
  assert.strictEqual(r.queued, 1, 'an older PC file is fine');
  mgr.crossLink(-1, -12, 4198);
  assert.strictEqual(mgr.crossUnlink(-1), true);
  assert.strictEqual(mgr.snapshot().crossLinks['-1'], undefined);
  assert.strictEqual(mgr.crossUnlink(-1), false);
});
