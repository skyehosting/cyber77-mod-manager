'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

/**
 * A game folder with RED4ext installed by hand (outside this app), and mods here:
 * ArchiveXL (on), TweakXL (off), a hair mod (needs ArchiveXL on Nexus), a weather mod (needs TweakXL
 * and a mod that is not installed), a script mod with no Nexus page (its files need redscript), and
 * a mod whose requirement is hosted off Nexus.
 */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-req-'));
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  fs.mkdirSync(path.join(game, 'red4ext'), { recursive: true });
  fs.writeFileSync(path.join(game, 'red4ext', 'RED4ext.dll'), 'by hand');
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  const mod = (id, name, modId, enabled, files) => {
    mgr.data.mods[id] = { id, key: id, name, modName: name, modId, fileId: 0, game: 'cyberpunk2077', version: '1.0', files, enabled, priority: mgr.data.nextPriority++ };
  };
  mod('axl', 'ArchiveXL', 4198, true, ['red4ext/plugins/ArchiveXL/ArchiveXL.dll', 'r6/scripts/ArchiveXL/ArchiveXL.reds']);
  mod('txl', 'TweakXL', 4197, false, ['red4ext/plugins/TweakXL/TweakXL.dll']);
  mod('hair', 'Hair Pack', 500, true, ['archive/pc/mod/hair.archive']);
  mod('rain', 'Rain Overhaul', 600, true, ['archive/pc/mod/rain.archive', 'r6/tweaks/rain.yaml']);
  mod('local', 'My Script Mod', 0, true, ['r6/scripts/Mine/mine.reds']);
  mod('ext', 'Uses An Outside Tool', 700, false, ['archive/pc/mod/ext.archive']);
  const at = Date.now();
  mgr.data.requirements = {
    4198: { at, list: [{ modId: 2380, name: 'RED4ext' }] },
    4197: { at, list: [{ modId: 2380, name: 'RED4ext' }] },
    500: { at, list: [{ modId: 4198, name: 'ArchiveXL' }] },
    600: { at, list: [{ modId: 4197, name: 'TweakXL' }, { modId: 8000, name: 'Native Settings UI', notes: 'For the menu' }] },
    700: { at, list: [{ modId: 0, name: 'Some Tool', url: 'https://example.com/tool', external: true }] },
  };
  // Nexus: never really asked in tests.
  mgr.nexus.requirementsMany = async () => { throw new Error('Nexus must not be asked'); };
  return { mgr, game };
}

const states = list => Object.fromEntries((list || []).map(q => [q.name, q.state]));

test('requirements resolve against what is installed: on, off, missing, outside, off Nexus, from files', () => {
  const { mgr } = setup();
  const reqs = mgr.requirementsView();
  assert.deepStrictEqual(states(reqs.hair), { ArchiveXL: 'on' });
  assert.strictEqual(reqs.hair[0].id, 'axl', 'the copy points at the real mod, so its switch switches it');
  // The weather mod: TweakXL is off; Native Settings UI is not installed; its tweak file needs TweakXL (already listed).
  assert.deepStrictEqual(states(reqs.rain), { TweakXL: 'off', 'Native Settings UI': 'missing' });
  assert.strictEqual(reqs.rain.find(q => q.name === 'Native Settings UI').modId, 8000, 'Download needs its Nexus id');
  // RED4ext is in the game folder from somewhere else: shown, without a switch.
  assert.deepStrictEqual(states(reqs.axl), { RED4ext: 'outside', redscript: 'missing' });
  assert.ok(!reqs.axl.find(q => q.name === 'RED4ext').id);
  // A mod with no Nexus page: its .reds file needs redscript, found from its files.
  assert.deepStrictEqual(states(reqs.local), { redscript: 'missing' });
  assert.ok(reqs.local[0].inferred);
  assert.deepStrictEqual(reqs.ext.map(q => [q.state, q.url]), [['external', 'https://example.com/tool']]);
  assert.ok(!reqs.txl.some(q => q.name === 'TweakXL'), 'a framework never needs itself');
});

test('a required mod with several versions here: the copy follows the enabled one', () => {
  const { mgr } = setup();
  mgr.data.mods.axl.enabled = false;
  mgr.data.mods['axl-new'] = { ...mgr.data.mods.axl, id: 'axl-new', key: 'axl-new', version: '2.0', enabled: true, priority: mgr.data.nextPriority++ };
  const hair = mgr.requirementsView().hair[0];
  assert.deepStrictEqual([hair.id, hair.version, hair.state], ['axl-new', '2.0', 'on']);
});

test('mods never looked up are fetched from Nexus once, in one batch, then cached', async () => {
  const { mgr } = setup();
  const asked = [];
  mgr.nexus.requirementsMany = async (game, ids) => { asked.push(ids); return new Map([[900, [{ modId: 4198, name: 'ArchiveXL' }]]]); };
  mgr.data.mods.new = { id: 'new', key: 'new', name: 'New Mod', modName: 'New Mod', modId: 900, files: ['archive/pc/mod/new.archive'], enabled: true, priority: 99 };
  assert.strictEqual(await mgr.refreshRequirements(), 1);
  assert.deepStrictEqual(asked, [[900]], 'only the mod never looked up');
  assert.deepStrictEqual(states(mgr.requirementsView().new), { ArchiveXL: 'on' });
  assert.strictEqual(await mgr.refreshRequirements(), 0, 'fresh: not asked again');
  // Old entries (over 3 days) are read again; a mod Nexus no longer has is cached empty.
  for (const e of Object.values(mgr.data.requirements)) e.at -= 4 * 86400000;
  mgr.nexus.requirementsMany = async () => new Map();
  assert.strictEqual(await mgr.refreshRequirements(), 6);
  assert.deepStrictEqual(mgr.data.requirements[900].list, []);
});

test('the snapshot carries requirements for the Mods page', () => {
  const { mgr } = setup();
  const snap = mgr.snapshot();
  assert.ok(snap.reqs && snap.reqs.hair && snap.reqs.rain);
});
