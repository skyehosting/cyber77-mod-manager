'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

/*
 * Mods that share files: whose copy of each file loads (picked in the conflict window), the rest by
 * priority. Two mods here both ship RED4ext (as a flight mod and a co-op mod can), one an identical
 * licence file.
 */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-fc-'));
  const game = path.join(root, 'Cyberpunk 2077');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  const settings = new Settings(path.join(root, 'userdata'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  const mod = (id, name, priority, files) => {
    for (const [rel, text] of Object.entries(files)) {
      const f = path.join(settings.stagingDir, id, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    mgr.data.mods[id] = { id, key: id, name, modName: name, enabled: false, priority, files: Object.keys(files), installedAt: Date.now(), warnings: [] };
  };
  mod('flight', 'Let There Be Flight', 1, {
    'bin/x64/winmm.dll': 'loader 1.31', 'red4ext/RED4ext.dll': 'red4ext 1.31', 'red4ext/LICENSE.txt': 'MIT', 'red4ext/plugins/flight/flight.dll': 'flight',
  });
  mod('coop', 'NightCoop', 2, {
    'bin/x64/winmm.dll': 'loader coop build', 'red4ext/RED4ext.dll': 'red4ext coop build', 'red4ext/LICENSE.txt': 'MIT', 'red4ext/plugins/coop/coop.dll': 'coop',
  });
  const inGame = rel => fs.readFileSync(path.join(game, rel), 'utf8');
  return { mgr, game, inGame };
}

test('enabling a mod that shares files: the window is asked for the files that differ, identical ones need no choice', async () => {
  const { mgr } = setup();
  await mgr.setEnabled(['flight'], true);
  const plan = mgr.conflictPlan(['coop']);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].mod.id, 'coop');
  assert.deepStrictEqual(plan[0].others.map(o => o.id), ['flight']);
  const byFile = Object.fromEntries(plan[0].files.map(f => [f.file, f]));
  assert.deepStrictEqual(Object.keys(byFile).sort(), ['bin/x64/winmm.dll', 'red4ext/LICENSE.txt', 'red4ext/RED4ext.dll']);
  assert.strictEqual(byFile['red4ext/LICENSE.txt'].same, true, 'the same bytes: nothing to choose');
  assert.strictEqual(byFile['red4ext/RED4ext.dll'].same, false);
  assert.strictEqual(byFile['red4ext/RED4ext.dll'].winner, 'coop', 'without a pick, the higher priority');
  assert.deepStrictEqual(byFile['red4ext/RED4ext.dll'].providers.map(p => p.id), ['flight', 'coop']);
  assert.deepStrictEqual(mgr.conflictPlan(['flight']), [], 'already enabled: nothing to ask');
});

test('the files picked load from the mod picked, whatever the priority; the rest by priority', async () => {
  const { mgr, inGame } = setup();
  await mgr.setEnabled(['flight'], true);
  // Flight's RED4ext (both of its files), the co-op mod's own plugin of course.
  assert.deepStrictEqual(await mgr.setFileChoices({ 'bin/x64/winmm.dll': { id: 'flight', among: ['flight','coop'] }, 'red4ext/RED4ext.dll': { id: 'flight', among: ['flight','coop'] } }), { saved: 2 });
  await mgr.setEnabled(['coop'], true);
  assert.strictEqual(inGame('bin/x64/winmm.dll'), 'loader 1.31');
  assert.strictEqual(inGame('red4ext/RED4ext.dll'), 'red4ext 1.31');
  assert.strictEqual(inGame('red4ext/plugins/coop/coop.dll'), 'coop');
  assert.strictEqual(inGame('red4ext/plugins/flight/flight.dll'), 'flight');
  assert.deepStrictEqual(mgr.conflictPlan(['coop']), [], 'enabled');
  // The counts and details follow the picks.
  const snap = mgr.snapshot();
  assert.strictEqual(snap.conflicts.flight.wins, 2);
  assert.strictEqual(snap.conflicts.coop.wins, 1, 'the licence file: same bytes, the higher priority places it');
  const d = mgr.conflictDetails('coop')[0];
  assert.strictEqual(d.mixed, true);
  assert.strictEqual(d.items.find(x => x.file === 'red4ext/RED4ext.dll').winner, 'flight');
  assert.strictEqual(d.items.find(x => x.file === 'red4ext/RED4ext.dll').chosen, true);
  // Changed mind: the co-op mod's copies; then forgotten (null): back to priority.
  await mgr.setFileChoices({ 'bin/x64/winmm.dll': { id: 'coop', among: ['flight','coop'] }, 'red4ext/RED4ext.dll': { id: 'coop', among: ['flight','coop'] } });
  assert.strictEqual(inGame('red4ext/RED4ext.dll'), 'red4ext coop build');
  await mgr.setFileChoices({ 'bin/x64/winmm.dll': { id: 'flight', among: ['flight','coop'] }, 'red4ext/RED4ext.dll': null });
  assert.strictEqual(inGame('bin/x64/winmm.dll'), 'loader 1.31');
  assert.strictEqual(inGame('red4ext/RED4ext.dll'), 'red4ext coop build', 'no pick: the higher priority');
});

test('a pick for a mod that is off, or that lacks the file, changes nothing; "Make this mod win" clears picks against it', async () => {
  const { mgr, inGame } = setup();
  await mgr.setEnabled(['flight', 'coop'], true);
  assert.deepStrictEqual(await mgr.setFileChoices({ 'red4ext/plugins/coop/coop.dll': { id: 'flight', among: [] }, 'nope.dll': { id: 'coop', among: [] }, 'bin/x64/winmm.dll': { id: 'toString', among: [] }, '__proto__': { id: 'coop', among: [] } }), { saved: 0 });
  await mgr.setFileChoices({ 'red4ext/RED4ext.dll': { id: 'flight', among: ['flight','coop'] } });
  assert.strictEqual(inGame('red4ext/RED4ext.dll'), 'red4ext 1.31');
  await mgr.setEnabled(['flight'], false);
  assert.strictEqual(inGame('red4ext/RED4ext.dll'), 'red4ext coop build', 'the picked mod off: the other copy goes in');
  await mgr.setEnabled(['flight'], true);
  assert.strictEqual(inGame('red4ext/RED4ext.dll'), 'red4ext 1.31', 'back on: the pick holds');
  await mgr.prioritize(['coop']);
  assert.strictEqual(inGame('red4ext/RED4ext.dll'), 'red4ext coop build', '"Make this mod win" wins every file');
  assert.ok(!mgr.pickOf('red4ext/RED4ext.dll'));
});

test('uninstalling a mod forgets its picks', async () => {
  const { mgr } = setup();
  await mgr.setEnabled(['flight', 'coop'], true);
  await mgr.setFileChoices({ 'red4ext/RED4ext.dll': { id: 'flight', among: ['flight','coop'] }, 'bin/x64/winmm.dll': { id: 'coop', among: ['flight','coop'] } });
  await mgr.uninstall(['flight']);
  assert.deepStrictEqual(mgr.data.fileChoices, { 'bin/x64/winmm.dll': { id: 'coop', among: ['coop', 'flight'] } });
});

test('a third mod with the same file is asked about, even after a pick between the first two; one choice per file across all three', async () => {
  const { mgr, inGame } = setup();
  const f = path.join(mgr.settings.stagingDir, 'loader', 'bin/x64/winmm.dll');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'loader standalone');
  mgr.data.mods.loader = { id: 'loader', key: 'loader', name: 'RED4ext', modName: 'RED4ext', enabled: false, priority: 3, files: ['bin/x64/winmm.dll'], installedAt: Date.now(), warnings: [] };
  await mgr.setEnabled(['flight', 'coop'], true);
  await mgr.setFileChoices({ 'bin/x64/winmm.dll': { id: 'flight', among: ['flight', 'coop'] } });
  // The new, higher-priority mod: not silently put above or below the pick; asked, with all three.
  const plan = mgr.conflictPlan(['loader']);
  assert.strictEqual(plan.length, 1);
  assert.deepStrictEqual(plan[0].files.map(x => x.file), ['bin/x64/winmm.dll']);
  assert.deepStrictEqual(plan[0].files[0].providers.map(p => p.id).sort(), ['coop', 'flight', 'loader']);
  assert.strictEqual(plan[0].files[0].winner, 'loader', 'a pick made without it does not outvote it: priority until asked');
  // Enabled without the window (a profile switch does that): priority, not the old pick; off again: the pick.
  await mgr.setEnabled(['loader'], true);
  assert.strictEqual(inGame('bin/x64/winmm.dll'), 'loader standalone');
  await mgr.setEnabled(['loader'], false);
  assert.strictEqual(inGame('bin/x64/winmm.dll'), 'loader 1.31', 'the pick between the first two holds again');
  await mgr.setFileChoices({ 'bin/x64/winmm.dll': { id: 'loader', among: ['flight', 'coop', 'loader'] } });
  await mgr.setEnabled(['loader'], true);
  assert.strictEqual(inGame('bin/x64/winmm.dll'), 'loader standalone');
  assert.deepStrictEqual(mgr.conflictPlan(['loader']), [], 'enabled now');
  await mgr.setEnabled(['loader'], false);
  assert.deepStrictEqual(mgr.conflictPlan(['loader']), [], 'decided among all three: not asked again');
  assert.strictEqual(inGame('bin/x64/winmm.dll'), 'loader coop build', 'the picked one off: the higher priority of the other two');
});

test("a pick moves to a mod's new version when it updates", () => {
  const { mgr } = setup();
  mgr.data.fileChoices = { 'red4ext/red4ext.dll': { id: 'flight', among: ['flight', 'coop'] }, 'red4ext/plugins/flight/flight.dll': { id: 'flight', among: ['flight'] } };
  // What finishInstall does for an update (the new version lacks one of the files).
  const files = ['bin/x64/winmm.dll', 'red4ext/RED4ext.dll'];
  const prev = { id: 'flight' };
  const id = 'flight2';
  const has = new Set(files.map(x => x.toLowerCase()));
  for (const [file, pick] of Object.entries(mgr.data.fileChoices)) {
    if (pick.among?.includes(prev.id)) pick.among = pick.among.map(x => (x === prev.id ? id : x));
    if (pick.id === prev.id) { if (has.has(file)) pick.id = id; else delete mgr.data.fileChoices[file]; }
  }
  assert.deepStrictEqual(mgr.data.fileChoices, { 'red4ext/red4ext.dll': { id: 'flight2', among: ['flight2', 'coop'] } });
});
