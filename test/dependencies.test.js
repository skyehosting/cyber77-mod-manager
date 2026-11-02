'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager, pickMainFiles, foundInGame } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function fakeGame() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-dep-'));
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  return { root, game };
}

/** Mods: 1 needs 2 + an off-site tool; 2 needs 3 + RED4ext (2380); 3 needs 1 (a cycle). */
const MODS = {
  1: { name: 'Main Mod', reqs: [{ modId: 2, modName: 'Lib Two' }, { modId: 0, modName: 'Some Tool', external: true, url: 'https://github.com/x/tool' }] },
  2: { name: 'Lib Two', reqs: [{ modId: 3, modName: 'Lib Three' }, { modId: 2380, modName: 'RED4ext' }] },
  3: { name: 'Lib Three', reqs: [{ modId: 1, modName: 'Main Mod' }] },
  2380: { name: 'RED4ext', reqs: [] },
};

function stubNexus(mgr) {
  mgr.nexus.getMod = async (_g, id) => ({ name: MODS[id].name, author: 'someone' });
  mgr.nexus.getFiles = async (_g, id) => ({
    files: [
      { file_id: id * 10, name: `${MODS[id].name} main`, file_name: `m${id}.zip`, category_name: 'MAIN', is_primary: true, uploaded_timestamp: 2 },
      { file_id: id * 10 + 1, name: `${MODS[id].name} optional`, file_name: `o${id}.zip`, category_name: 'OPTIONAL', uploaded_timestamp: 3 },
      { file_id: id * 10 + 2, name: 'old', file_name: `old${id}.zip`, category_name: 'OLD_VERSION', uploaded_timestamp: 1 },
    ],
  });
  mgr.nexus.getRequirements = async (_g, id) => ({
    gameId: '3333',
    requirements: MODS[id].reqs.map(r => ({ gameId: '3333', url: '', notes: '', external: false, ...r })),
  });
  const queued = [];
  mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  return queued;
}

test('requirements are resolved recursively, cycles stop, frameworks in the game are skipped', async () => {
  const { root, game } = fakeGame();
  fs.mkdirSync(path.join(game, 'red4ext'), { recursive: true });
  fs.writeFileSync(path.join(game, 'red4ext', 'RED4ext.dll'), 'dll');
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  const queued = stubNexus(mgr);

  const summary = await mgr.addLinks('https://www.nexusmods.com/cyberpunk2077/mods/1');
  const byMod = {};
  for (const q of queued) (byMod[q.modId] ||= []).push(q);

  // The linked mod: every file in the chosen categories (Main + Optional, not Old).
  assert.deepStrictEqual(byMod[1].map(q => q.fileName).sort(), ['m1.zip', 'o1.zip']);
  assert.strictEqual(byMod[1][0].dependencyOf, '');
  // Dependencies: only the primary main file, tagged with what needs them.
  assert.deepStrictEqual(byMod[2].map(q => q.fileName), ['m2.zip']);
  assert.strictEqual(byMod[2][0].dependencyOf, 'Main Mod');
  assert.deepStrictEqual(byMod[3].map(q => q.fileName), ['m3.zip']);
  assert.strictEqual(byMod[3][0].dependencyOf, 'Lib Two');
  // RED4ext is already in the game folder; the cycle back to mod 1 adds nothing.
  assert.ok(!byMod[2380]);
  assert.strictEqual(queued.filter(q => q.modId === 1).length, 2);
  assert.strictEqual(summary.dependencies, 2);
  assert.deepStrictEqual(summary.external.map(e => e.name), ['Some Tool']);
});

test('dependency resolution can be switched off', async () => {
  const { root, game } = fakeGame();
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game, installDependencies: false });
  const mgr = new ModManager({ settings, log: quiet });
  const queued = stubNexus(mgr);
  await mgr.addLinks('https://www.nexusmods.com/cyberpunk2077/mods/1');
  assert.deepStrictEqual([...new Set(queued.map(q => q.modId))], [1]);
});

test('an installed-but-disabled requirement is enabled instead of downloaded', async () => {
  const { root, game } = fakeGame();
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  stubNexus(mgr);
  mgr.data.mods.x = { id: 'x', key: 'x', modId: 2, name: 'Lib Two', enabled: false, priority: 1, files: [] };
  const status = mgr.dependencyStatus({ modId: 2, modName: 'Lib Two' });
  assert.strictEqual(status.status, 'disabled');
  assert.deepStrictEqual(status.enable, ['x']);
  mgr.data.mods.x.enabled = true;
  assert.strictEqual(mgr.dependencyStatus({ modId: 2, modName: 'Lib Two' }).done, true);
});

test('the plan lists every requirement with its status, and only ticked ones are queued', async () => {
  const { root, game } = fakeGame();
  fs.mkdirSync(path.join(game, 'red4ext'), { recursive: true });
  fs.writeFileSync(path.join(game, 'red4ext', 'RED4ext.dll'), 'dll');
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  const queued = stubNexus(mgr);

  const plan = await mgr.planLinks('https://www.nexusmods.com/cyberpunk2077/mods/1');
  assert.strictEqual(queued.length, 0, 'planning downloads nothing');
  const byName = Object.fromEntries(plan.deps.map(d => [d.name, d]));
  assert.strictEqual(byName['Lib Two'].status, 'missing');
  assert.deepStrictEqual(byName['Lib Two'].requiredBy, ['Main Mod']);
  assert.deepStrictEqual(byName['Lib Two'].files.map(f => f.fileName), ['m2.zip']);
  assert.strictEqual(byName['Lib Three'].status, 'missing');
  assert.strictEqual(byName.RED4ext.status, 'in-game');
  assert.strictEqual(byName['Some Tool'].status, 'external');

  // The user unticks Lib Three.
  const summary = await mgr.queuePlan(plan.token, [2]);
  assert.deepStrictEqual([...new Set(queued.map(q => q.modId))].sort(), [1, 2]);
  assert.strictEqual(summary.dependencies, 1);
  await assert.rejects(mgr.queuePlan(plan.token, []), /expired/);
});

test('pickMainFiles and foundInGame', () => {
  const cat = f => f.category_name;
  assert.deepStrictEqual(pickMainFiles([
    { file_id: 1, category_name: 'MAIN' }, { file_id: 2, category_name: 'MAIN', is_primary: true },
  ], cat).map(f => f.file_id), [2]);
  assert.deepStrictEqual(pickMainFiles([
    { file_id: 1, category_name: 'UPDATE', uploaded_timestamp: 5 }, { file_id: 2, category_name: 'OPTIONAL', uploaded_timestamp: 9 },
    { file_id: 3, category_name: 'OLD_VERSION', uploaded_timestamp: 99 },
  ], cat).map(f => f.file_id), [2]);

  const { game } = fakeGame();
  fs.mkdirSync(path.join(game, 'red4ext', 'plugins', 'mod_settings'), { recursive: true });
  assert.strictEqual(foundInGame(game, { modId: 99999, modName: 'Mod Settings' }), 'red4ext/plugins/mod_settings');
  assert.strictEqual(foundInGame(game, { modId: 2380, modName: 'RED4ext' }), '');
});

test('each requirement records which mods need it, by id, for the requirements tree', async () => {
  const { root, game } = fakeGame();
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  stubNexus(mgr);
  const plan = await mgr.planLinks('https://www.nexusmods.com/cyberpunk2077/mods/1');
  const byName = Object.fromEntries(plan.deps.map(d => [d.name, d]));
  assert.deepStrictEqual(byName['Lib Two'].parents, [1], 'Main Mod needs Lib Two');
  assert.deepStrictEqual(byName['Lib Three'].parents, [2], 'Lib Two needs Lib Three (a requirement of a requirement)');
  assert.deepStrictEqual(byName['Some Tool'].parents, [1]);
  // Lib Three needs Main Mod again (a loop): it is not added as its own requirement.
  assert.ok(!plan.deps.some(d => d.modId === 1));
});
