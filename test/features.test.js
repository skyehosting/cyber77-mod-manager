'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');
const { findUpdate } = require('../src/core/updates');

const SEVEN_ZIP = require('./seven-zip');
const has7z = fs.existsSync(SEVEN_ZIP);
const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-feat-'));
  const game = path.join(root, 'Cyberpunk 2077');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  const settings = new Settings(path.join(root, 'userdata'), null);
  settings.update({ gamePath: game, sevenZipPath: SEVEN_ZIP });
  const mgr = new ModManager({ settings, log: quiet });
  const zip = (name, files) => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-src-'));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), content);
    }
    const out = path.join(root, name);
    execFileSync(SEVEN_ZIP, ['a', '-bso0', '-bsp0', out, '*'], { cwd: src });
    return out;
  };
  return { root, game, mgr, zip };
}

async function installEnabled(mgr, archive) {
  const [key] = await mgr.importArchives([archive]);
  const [res] = await mgr.install([key]);
  await mgr.setEnabled([res.id], true);
  return res.id;
}

test('findUpdate follows the update chain, falls back by name, ignores cycles', () => {
  const files = [
    { file_id: 1, name: 'Main', category_name: 'OLD_VERSION', uploaded_timestamp: 1 },
    { file_id: 2, name: 'Main', category_name: 'OLD_VERSION', uploaded_timestamp: 2 },
    { file_id: 3, name: 'Main', category_name: 'MAIN', uploaded_timestamp: 3 },
    { file_id: 9, name: 'Optional thing', category_name: 'OPTIONAL', uploaded_timestamp: 9 },
  ];
  const chain = [{ old_file_id: 1, new_file_id: 2 }, { old_file_id: 2, new_file_id: 3 }];
  assert.strictEqual(findUpdate(files, chain, 1).file_id, 3);
  assert.strictEqual(findUpdate(files, chain, 3), null, 'already the newest');
  assert.strictEqual(findUpdate(files, [], 1).file_id, 3, 'unlinked: newest current file with the same name');
  assert.strictEqual(findUpdate(files, [{ old_file_id: 3, new_file_id: 3 }], 3), null);
  assert.strictEqual(findUpdate(files, [{ old_file_id: 9, new_file_id: 1 }, { old_file_id: 1, new_file_id: 9 }], 9), null, 'cycle');
});

test('a mod deleted from the game folder by hand is detected and shown as disabled', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { game, mgr, zip } = setup();
  // The game already has an original file that the mod overrides; it must come back.
  fs.mkdirSync(path.join(game, 'engine', 'config', 'platform', 'pc'), { recursive: true });
  fs.writeFileSync(path.join(game, 'engine/config/platform/pc/user.ini'), 'ORIGINAL');
  const id = await installEnabled(mgr, zip('Gone.zip', { 'gone.archive': 'A', 'user.ini': 'MODDED' }));
  assert.strictEqual(fs.readFileSync(path.join(game, 'engine/config/platform/pc/user.ini'), 'utf8'), 'MODDED');

  // The user deletes the mod's files themselves.
  fs.rmSync(path.join(game, 'archive/pc/mod/gone.archive'));
  fs.rmSync(path.join(game, 'engine/config/platform/pc/user.ini'));
  const removed = mgr.verifyDeployment();
  assert.deepStrictEqual(removed, ['Gone']);
  assert.strictEqual(mgr.data.mods[id].enabled, false);
  assert.strictEqual(fs.readFileSync(path.join(game, 'engine/config/platform/pc/user.ini'), 'utf8'), 'ORIGINAL', 'original restored');
  assert.deepStrictEqual(mgr.data.profiles.list.default.enabled, [], 'the active profile follows');

  // Enabling it again puts it back.
  await mgr.setEnabled([id], true);
  assert.ok(fs.existsSync(path.join(game, 'archive/pc/mod/gone.archive')));
});

test('a partly damaged mod is flagged and repaired', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { game, mgr, zip } = setup();
  const id = await installEnabled(mgr, zip('Two.zip', { 'a.archive': 'A', 'b.archive': 'B' }));
  fs.rmSync(path.join(game, 'archive/pc/mod/a.archive'));
  assert.deepStrictEqual(mgr.verifyDeployment(), []);
  assert.deepStrictEqual(mgr.data.mods[id].health, { missing: 1, replaced: 0 });
  assert.strictEqual(mgr.data.mods[id].enabled, true);
  await mgr.repair([id]);
  assert.ok(fs.existsSync(path.join(game, 'archive/pc/mod/a.archive')));
  assert.strictEqual(mgr.data.mods[id].health, undefined);
});

test('profiles: create, switch, rename, delete', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { game, mgr, zip } = setup();
  const a = await installEnabled(mgr, zip('A.zip', { 'a.archive': 'A' }));
  const b = await installEnabled(mgr, zip('B.zip', { 'b.archive': 'B' }));
  const lite = await mgr.createProfile('Lite', { copyCurrent: false });
  await mgr.switchProfile(lite);
  assert.ok(!fs.existsSync(path.join(game, 'archive/pc/mod/a.archive')), 'empty profile: nothing deployed');
  await mgr.setEnabled([b], true);
  assert.deepStrictEqual(mgr.data.profiles.list[lite].enabled, [b]);
  await mgr.switchProfile('default');
  assert.ok(fs.existsSync(path.join(game, 'archive/pc/mod/a.archive')));
  assert.ok(fs.existsSync(path.join(game, 'archive/pc/mod/b.archive')));
  assert.deepStrictEqual(mgr.data.profiles.list.default.enabled.sort(), [a, b].sort());
  await mgr.renameProfile(lite, 'Performance');
  assert.strictEqual(mgr.profilesView().list.find(p => p.id === lite).name, 'Performance');
  await assert.rejects(mgr.createProfile('performance'), /already exists/);
  await assert.rejects(mgr.deleteProfile('default'), /Switch to another profile/);
  await mgr.deleteProfile(lite);
  assert.strictEqual(mgr.profilesView().list.length, 1);
});

test('updating a mod swaps the new version in, keeping priority, state and profiles', { skip: !has7z && 'no 7-Zip' }, async () => {
  const { root, game, mgr, zip } = setup();
  // Pretend the installed mod came from Nexus: mod 50, file 500.
  const oldArc = zip('Thing-1.zip', { 'thing.archive': 'v1', 'old-only.archive': 'x' });
  const [key] = await mgr.importArchives([oldArc]);
  Object.assign(mgr.data.downloads[key], { modId: 50, fileId: 500, version: '1.0', modName: 'Thing' });
  const [res] = await mgr.install([key]);
  const oldId = res.id;
  Object.assign(mgr.data.mods[oldId], { modId: 50, fileId: 500, version: '1.0', game: 'cyberpunk2077' });
  await mgr.setEnabled([oldId], true);
  const prio = mgr.data.mods[oldId].priority;

  mgr.nexus.getFiles = async () => ({
    files: [
      { file_id: 500, name: 'Thing', category_name: 'OLD_VERSION', file_name: 'Thing-1.zip', version: '1.0' },
      { file_id: 501, name: 'Thing', category_name: 'MAIN', file_name: 'Thing-2.zip', version: '2.0', size_in_bytes: 10 },
    ],
    file_updates: [{ old_file_id: 500, new_file_id: 501 }],
  });
  const check = await mgr.checkUpdates();
  assert.strictEqual(check.available, 1);
  assert.strictEqual(mgr.data.updates[oldId].version, '2.0');

  // The download is simulated: drop the new archive where the job would put it, then finish.
  const newArc = zip('Thing-2.zip', { 'thing.archive': 'v2' });
  let job = null;
  mgr.downloader.enqueue = spec => { job = spec; return spec; };
  await mgr.updateMods([oldId]);
  assert.strictEqual(job.replaces, oldId);
  fs.mkdirSync(path.dirname(job.dest), { recursive: true });
  fs.copyFileSync(newArc, job.dest);
  mgr.onDownloaded({ ...job, total: 10 });
  await new Promise(r => setTimeout(r, 50));
  await mgr.chain;
  await mgr.chain;

  const mods = Object.values(mgr.data.mods);
  assert.strictEqual(mods.length, 1, 'old version removed');
  const now = mods[0];
  assert.strictEqual(now.version, '2.0');
  assert.strictEqual(now.enabled, true);
  assert.strictEqual(now.priority, prio);
  assert.deepStrictEqual(mgr.data.profiles.list.default.enabled, [now.id]);
  assert.strictEqual(fs.readFileSync(path.join(game, 'archive/pc/mod/thing.archive'), 'utf8'), 'v2');
  assert.ok(!fs.existsSync(path.join(game, 'archive/pc/mod/old-only.archive')), 'files only in the old version are gone');
  assert.deepStrictEqual(mgr.data.updates, {});
  void root;
});
