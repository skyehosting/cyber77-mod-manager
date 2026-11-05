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
  // Their Nexus categories, read with the requirements.
  mgr.data.modCategories = Object.fromEntries([4198, 4197, 500, 600, 700].map(id => [id, { at, name: id === 500 ? 'Appearance' : 'Modders Resources' }]));
  // Nexus: never really asked in tests.
  mgr.nexus.requirementsMany = async () => { throw new Error('Nexus must not be asked'); };
  mgr.nexus.findModsByName = async () => { throw new Error('Nexus must not be asked'); };
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

test('"off-site" requirements that are Nexus mods: by their link, by a framework name, or found by name on Nexus', async () => {
  const { mgr, game } = setup();
  // As Night City Alive lists them: every one "off-site", most linking to the Nexus page.
  mgr.data.requirements[700] = { at: Date.now(), list: [
    { modId: 0, name: 'REDmod', url: 'https://www.cyberpunk.net/fr/modding-support', external: true },
    { modId: 0, name: 'ArchiveXL (No REDMOD version)', url: 'https://www.nexusmods.com/cyberpunk2077/mods/4198?tab=files', external: true },
    { modId: 0, name: 'TweakXL (No REDMOD version)', url: '', external: true },
    { modId: 0, name: 'Virtual Atelier', url: '', external: true },
    { modId: 0, name: 'Some Tool', url: 'https://example.com/tool', external: true },
    { modId: 0, name: 'Linked elsewhere', url: 'https://www.nexusmods.com/skyrimspecialedition/mods/12604', external: true },
  ] };
  let reqs = mgr.requirementsView();
  assert.deepStrictEqual(states(reqs.ext), {
    REDmod: 'official', ArchiveXL: 'on', TweakXL: 'off', 'Virtual Atelier': 'external', 'Some Tool': 'external', 'Linked elsewhere': 'external',
  });
  // REDmod's tools in the game folder: part of the game.
  fs.mkdirSync(path.join(game, 'tools', 'redmod', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(game, 'tools', 'redmod', 'bin', 'redMod.exe'), 'exe');
  assert.strictEqual(states(mgr.requirementsView().ext).REDmod, 'builtin');
  // Names looked up on Nexus: only an exact name counts, misses are remembered too.
  const asked = [];
  mgr.nexus.findModsByName = async (g, name) => {
    asked.push(name);
    return name === 'Virtual Atelier' ? [{ modId: 2987, name: 'Virtual Atelier' }, { modId: 9, name: 'Virtual Atelier Addon' }] : [{ modId: 5, name: 'Some Tools Pack' }];
  };
  await mgr.matchRequirementNames();
  assert.deepStrictEqual(asked.sort(), ['Linked elsewhere', 'Some Tool', 'Virtual Atelier']);
  reqs = mgr.requirementsView();
  assert.strictEqual(states(reqs.ext)['Virtual Atelier'], 'missing');
  assert.strictEqual(reqs.ext.find(q => q.name === 'Virtual Atelier').modId, 2987, 'Download gets its Nexus id');
  assert.strictEqual(states(reqs.ext)['Some Tool'], 'external', 'a near name is no match');
  asked.length = 0;
  await mgr.matchRequirementNames();
  assert.deepStrictEqual(asked, [], 'not asked again for 30 days');
  // Object built-ins are no names: nothing breaks.
  mgr.data.requirements[700].list.push({ modId: 0, name: 'constructor', url: '', external: true });
  assert.strictEqual(states(mgr.requirementsView().ext).constructor, 'external');
});

test('name matches are careful: one mod of that exact name only, a refused name never blocks the rest, links must be on Nexus', async () => {
  const { mgr } = setup();
  mgr.reqLookupGap = 0;
  mgr.data.requirements[700] = { at: Date.now(), list: [
    { modId: 0, name: 'Bad Name Here', url: '', external: true },
    { modId: 0, name: 'Photo Mode Plus', url: '', external: true },
    { modId: 0, name: 'Good Mod Name', url: '', external: true },
    { modId: 0, name: 'Phantom Liberty', url: 'https://www.cyberpunk.net/en/phantom-liberty', external: true },
    { modId: 0, name: 'Sneaky', url: 'https://example.com/?r=nexusmods.com/cyberpunk2077/mods/5', external: true },
    { modId: 0, name: 'REDmod', url: 'https://example.com/lookalike', external: true },
  ] };
  mgr.nexus.findModsByName = async (g, name) => {
    if (name === 'Bad Name Here') throw Object.assign(new Error('refused'), { status: 400 });
    if (name === 'Photo Mode Plus') return [{ modId: 11, name: 'Photo Mode Plus' }, { modId: 12, name: 'Photo Mode Plus' }];
    return [{ modId: 33, name: 'Good Mod Name' }];
  };
  await mgr.matchRequirementNames();
  const reqs = mgr.requirementsView();
  const by = Object.fromEntries(reqs.ext.map(q => [q.name, q]));
  assert.strictEqual(by['Good Mod Name'].modId, 33, 'looked up although the name before it was refused');
  assert.ok(by['Good Mod Name'].byName, 'the row says it is a match by name');
  assert.strictEqual(by['Photo Mode Plus'].state, 'external', 'two mods of that name: no guess');
  assert.strictEqual(by['Phantom Liberty'].state, 'external', 'only REDmod is CD PROJEKT RED\'s own');
  assert.strictEqual(by.Sneaky.state, 'external', 'a link that only mentions Nexus is not a Nexus link');
  assert.strictEqual(by.REDmod.state, 'official');
  assert.strictEqual(by.REDmod.url, '', 'REDmod never links anywhere but cyberpunk.net');
  // No network: the round stops and backs off.
  mgr.data.reqNames = {};
  let calls = 0;
  mgr.nexus.findModsByName = async () => { calls++; throw Object.assign(new Error('offline'), { status: 0 }); };
  await mgr.matchRequirementNames();
  assert.strictEqual(calls, 1);
  assert.ok(Date.now() - mgr.reqFailedAt < 1000);
});
