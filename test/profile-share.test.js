'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';
const has7z = fs.existsSync(SEVEN_ZIP);
const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function makeManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-share-'));
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
  /** Install an archive and pretend it came from Nexus mod `modId`, file `fileId`. */
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
  return { mgr, game, zip, installAs };
}

test('a profile exports its enabled, installed mods in priority order', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, installAs } = makeManager();
  const a = await installAs('Alpha', { 'alpha.archive': 'A', 'shared.archive': 'A' }, 10, 100);
  const b = await installAs('Beta', { 'beta.archive': 'B', 'shared.archive': 'B' }, 20, 200);
  await installAs('Local Thing', { 'local.archive': 'L' }, 0, 0);
  const off = await installAs('Off', { 'off.archive': 'O' }, 30, 300);
  await mgr.setEnabled([off], false);
  await mgr.prioritize([a]); // Alpha now wins the shared file

  const doc = mgr.exportProfile('default');
  assert.strictEqual(doc.format, 'cyber-mod-manager-profile');
  assert.deepStrictEqual(doc.mods.map(m => m.name), ['Beta', 'Local Thing', 'Alpha'], 'enabled only, lowest priority first');
  assert.deepStrictEqual(doc.mods.map(m => m.source), ['nexus', 'local', 'nexus']);
  assert.strictEqual(doc.mods[2].fileId, 100);
  void b;
});

test('importing a profile plans, creates it, and installs downloads into it in the sender\'s order', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, game, zip, installAs } = makeManager();
  // The receiver already has Gamma (same file) installed, plus an unrelated mod that stays out.
  const gamma = await installAs('Gamma', { 'gamma.archive': 'G' }, 40, 400);
  const other = await installAs('Other', { 'other.archive': 'X' }, 90, 900);

  mgr.nexus.getFiles = async (_g, modId) => {
    if (modId === 10) return { files: [{ file_id: 100, name: 'Alpha', file_name: 'Alpha.zip', category_name: 'MAIN', size_in_bytes: 5 }], file_updates: [] };
    // Beta's exact file (200) was deleted from Nexus; 201 replaced it.
    if (modId === 20) return { files: [{ file_id: 201, name: 'Beta', file_name: 'Beta2.zip', category_name: 'MAIN', version: '2.0' }], file_updates: [{ old_file_id: 200, new_file_id: 201 }] };
    if (modId === 50) return { files: [], file_updates: [] };
    throw new Error('unexpected');
  };
  const doc = {
    format: 'cyber-mod-manager-profile', version: 1, name: 'Friend setup',
    mods: [
      { name: 'Beta', modName: 'Beta', game: 'cyberpunk2077', modId: 20, fileId: 200 },
      { name: 'Gamma', modName: 'Gamma', game: 'cyberpunk2077', modId: 40, fileId: 400 },
      { name: 'Their local mod', modId: 0, fileId: 0, source: 'local' },
      { name: 'Gone', modName: 'Gone', game: 'cyberpunk2077', modId: 50, fileId: 500 },
      { name: 'Alpha', modName: 'Alpha', game: 'cyberpunk2077', modId: 10, fileId: 100 },
    ],
  };
  const plan = await mgr.planProfileImport(doc);
  assert.deepStrictEqual(plan.mods.map(m => m.status), ['newer', 'installed', 'local', 'unavailable', 'download']);

  const queued = [];
  mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  const res = await mgr.applyProfileImport(plan.token, 'Friend setup');
  const prof = mgr.data.profiles.list[res.profile];
  assert.strictEqual(prof.name, 'Friend setup');
  assert.strictEqual(mgr.data.profiles.active, res.profile, 'switched to the imported profile');
  assert.strictEqual(mgr.data.mods[gamma].enabled, true);
  assert.strictEqual(mgr.data.mods[other].enabled, false, 'mods not in the profile are off');
  assert.ok(!fs.existsSync(path.join(game, 'archive/pc/mod/other.archive')));
  assert.deepStrictEqual(queued.map(q => q.fileId).sort(), [100, 201]);
  assert.ok(queued.every(q => q.forProfiles.includes(res.profile)));
  await assert.rejects(mgr.applyProfileImport(plan.token, 'again'), /expired/);

  // Downloads finish (Alpha first, then Beta) and install into the profile.
  for (const [q, files] of [[queued.find(x => x.fileId === 100), { 'alpha.archive': 'A', 'shared.archive': 'A' }], [queued.find(x => x.fileId === 201), { 'beta.archive': 'B', 'shared.archive': 'B' }]]) {
    fs.mkdirSync(path.dirname(q.dest), { recursive: true });
    fs.copyFileSync(zip(`${q.fileId}.zip`, files), q.dest);
    mgr.onDownloaded({ ...q, total: 5 });
    await new Promise(r => setTimeout(r, 30));
    await mgr.chain;
    await mgr.chain;
  }
  const alpha = mgr.data.mods['100'];
  const beta = mgr.data.mods['201'];
  assert.ok(alpha.enabled && beta.enabled);
  // The sender's order was Beta < Gamma < Alpha, so Alpha wins the shared file even though Beta installed last.
  assert.ok(beta.priority < mgr.data.mods[gamma].priority && mgr.data.mods[gamma].priority < alpha.priority);
  assert.strictEqual(fs.readFileSync(path.join(game, 'archive/pc/mod/shared.archive'), 'utf8'), 'A');
  assert.deepStrictEqual(mgr.data.profiles.list[res.profile].enabled.sort(), [gamma, '100', '201'].sort());
});

test('import rejects files that are not profiles', async () => {
  const { mgr } = makeManager();
  await assert.rejects(mgr.planProfileImport({ hello: 1 }), /not a Cyber Mod Manager profile/);
  await assert.rejects(mgr.planProfileImport({ format: 'cyber-mod-manager-profile', version: 9, mods: [] }), /newer version/);
});

test('a shared file is validated: bad entries, other games and oversized lists', async () => {
  const { mgr } = makeManager();
  mgr.nexus.getFiles = async () => ({ files: [], file_updates: [] });
  const plan = await mgr.planProfileImport({
    format: 'cyber-mod-manager-profile', version: 1, name: 'x',
    mods: [null, 5, ['a'], { name: 'Skyrim thing', game: 'skyrimspecialedition', modId: 1, fileId: 2 },
      { name: 'Bad ids', modId: -4, fileId: 1.5 }, { name: 'Dup', modId: 7, fileId: 70 }, { name: 'Dup again', modId: 7, fileId: 70 }],
  });
  assert.deepStrictEqual(plan.mods.map(m => [m.name, m.status]), [['Skyrim thing', 'unavailable'], ['Bad ids', 'local'], ['Dup', 'unavailable']]);
  const many = { format: 'cyber-mod-manager-profile', version: 1, mods: Array.from({ length: 1001 }, (_, i) => ({ modId: i + 1, fileId: i + 1 })) };
  await assert.rejects(mgr.planProfileImport(many), /most a profile can hold is 1000/);
});

test('import rolls back completely if it cannot be applied', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, game, installAs } = makeManager();
  const a = await installAs('Alpha', { 'alpha.archive': 'A' }, 10, 100);
  const plan = await mgr.planProfileImport({ format: 'cyber-mod-manager-profile', version: 1, name: 'P', mods: [{ name: 'Alpha', modId: 10, fileId: 100 }] });
  // The game folder disappears between planning and applying.
  fs.renameSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), path.join(game, 'gone.exe'));
  mgr.deployer.store.data.deployed = {}; // nothing deployed, so the configured folder is what's checked
  await assert.rejects(mgr.applyProfileImport(plan.token, 'P'), /folder/);
  assert.strictEqual(mgr.data.profiles.active, 'default');
  assert.strictEqual(Object.keys(mgr.data.profiles.list).length, 1, 'no half-made profile');
  assert.strictEqual(mgr.data.mods[a].enabled, true, 'mods as they were');
  // The plan is still usable once the folder is back.
  fs.renameSync(path.join(game, 'gone.exe'), path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'));
  const res = await mgr.applyProfileImport(plan.token, 'P');
  assert.strictEqual(mgr.data.profiles.active, res.profile);
});

test('each profile keeps its own conflict order', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, game, installAs } = makeManager();
  const a = await installAs('Alpha', { 'shared.archive': 'A' }, 10, 100);
  const b = await installAs('Beta', { 'shared.archive': 'B' }, 20, 200);
  const read = () => fs.readFileSync(path.join(game, 'archive/pc/mod/shared.archive'), 'utf8');
  assert.strictEqual(read(), 'B');
  const other = await mgr.createProfile('Other');
  await mgr.switchProfile(other);
  await mgr.prioritize([a]);            // in "Other", Alpha wins
  assert.strictEqual(read(), 'A');
  await mgr.switchProfile('default');   // "Default" still has Beta winning
  assert.strictEqual(read(), 'B');
  await mgr.switchProfile(other);
  assert.strictEqual(read(), 'A');
  void b;
});

test('two imports waiting for the same download both get the mod', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, game, zip } = makeManager();
  mgr.nexus.getFiles = async () => ({ files: [{ file_id: 100, name: 'Shared', file_name: 'Shared.zip', category_name: 'MAIN', size_in_bytes: 5 }], file_updates: [] });
  const doc = name => ({ format: 'cyber-mod-manager-profile', version: 1, name, mods: [{ name: 'Shared', modName: 'Shared', modId: 10, fileId: 100 }] });
  // Use the real queue (no network: the download never starts on its own here).
  mgr.downloader.pump = () => {};
  const p1 = await mgr.applyProfileImport((await mgr.planProfileImport(doc('One'))).token, 'One');
  const p2 = await mgr.applyProfileImport((await mgr.planProfileImport(doc('Two'))).token, 'Two');
  const jobs = [...mgr.downloader.jobs.values()];
  assert.strictEqual(jobs.length, 1, 'one download, not two');
  assert.deepStrictEqual(jobs[0].forProfiles.sort(), [p1.profile, p2.profile].sort());

  fs.mkdirSync(path.dirname(jobs[0].dest), { recursive: true });
  fs.copyFileSync(zip('Shared.zip', { 'shared.archive': 'S' }), jobs[0].dest);
  mgr.onDownloaded({ ...jobs[0], total: 5 });
  await new Promise(r => setTimeout(r, 30));
  await mgr.chain;
  await mgr.chain;
  assert.deepStrictEqual(mgr.data.profiles.list[p1.profile].enabled, ['100']);
  assert.deepStrictEqual(mgr.data.profiles.list[p2.profile].enabled, ['100']);
  assert.strictEqual(mgr.data.profiles.active, p2.profile);
  assert.strictEqual(mgr.data.mods['100'].enabled, true, 'enabled in the active (second) profile');
  assert.ok(fs.existsSync(path.join(game, 'archive/pc/mod/shared.archive')));
});

test('a profile code carries the mods, order, installer choices and name, and changes with them', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { mgr, installAs } = makeManager();
  const a = await installAs('Alpha', { 'alpha.archive': 'A' }, 10, 100);
  await installAs('Beta', { 'beta.archive': 'B' }, 20, 200);
  await installAs('Local Thing', { 'local.archive': 'L' }, 0, 0);
  mgr.data.mods[a].fomod = true;
  mgr.data.mods[a].fomodChoices = { 0: { 0: [1], 1: [0, 2] } }; // step → group → picked options

  const first = mgr.profileCode('default');
  assert.match(first.code, /^CMM1-[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual([first.mods, first.local], [2, 1]);
  assert.strictEqual(mgr.profilesView().list[0].codeTag, first.tag, 'the card shows the current code');

  // The receiver: Nexus knows both files; names come from Nexus since the code has none.
  const { mgr: other } = makeManager();
  other.nexus.getFiles = async (_g, modId) => ({ files: [{ file_id: modId * 10, name: `Nexus ${modId}`, file_name: `n${modId}.zip`, category_name: 'MAIN', version: '2.0' }] });
  const plan = await other.planProfileCode(`  ${first.code.slice(0, 20)}\n${first.code.slice(20)}  `);
  assert.strictEqual(plan.localCount, 1);
  const order = mgr.exportProfile('default').mods.filter(m => m.modId).map(m => `Nexus ${m.modId}`);
  assert.deepStrictEqual(plan.mods.map(m => m.name), order, 'priority order kept');
  assert.ok(plan.mods.every(m => m.status === 'download'));
  assert.strictEqual(plan.mods.find(m => m.name === 'Nexus 10').choices, true, 'installer choices travel with the code');

  await mgr.setEnabled([a], false);
  assert.notStrictEqual(mgr.profileCode('default').code, first.code, 'disabling a mod changes the code');
  assert.notStrictEqual(mgr.profilesView().list[0].codeTag, first.tag);
});

test('profile codes: damaged, foreign and pasted-JSON input', async () => {
  const profileCode = require('../src/core/profileCode');
  const code = profileCode.encode({ name: 'P', mods: Array.from({ length: 64 }, (_, i) => ({ modId: 1000 + i * 37, fileId: 50000 + i * 911 })) });
  assert.ok(code.length < 600, `64 mods fit in a short code (${code.length} characters)`);
  assert.strictEqual(profileCode.decode(code).mods.length, 64);
  assert.throws(() => profileCode.decode(code.slice(0, -12)), /damaged or incomplete/);
  assert.throws(() => profileCode.decode('hello'), /start with CMM1-/);
  const { mgr } = makeManager();
  await assert.rejects(mgr.planProfileCode('{"format":"something-else","mods":[]}'), /not a Cyber Mod Manager profile/);
  await assert.rejects(mgr.planProfileCode('   '), /Paste a profile code/);
});
