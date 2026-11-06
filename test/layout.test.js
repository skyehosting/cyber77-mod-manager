'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planLayout } = require('../src/core/layout');

const dests = plan => Object.fromEntries(plan.mappings.map(m => [m.src, m.dest]));

test('loose .archive and .xl go to archive/pc/mod', () => {
  const p = planLayout(['Cool Jacket.archive', 'Cool Jacket.archive.xl', 'readme.txt'], 'Cool Jacket');
  assert.deepStrictEqual(dests(p), {
    'Cool Jacket.archive': 'archive/pc/mod/Cool Jacket.archive',
    'Cool Jacket.archive.xl': 'archive/pc/mod/Cool Jacket.archive.xl',
  });
  assert.strictEqual(p.type, 'ArchiveXL');
  assert.deepStrictEqual(p.skipped, ['readme.txt']);
  assert.deepStrictEqual(p.warnings, []);
});

test('game-root layout inside a wrapper folder keeps its structure', () => {
  const p = planLayout([
    'MyMod v1.2/archive/pc/mod/a.archive',
    'MyMod v1.2/r6/scripts/MyMod/main.reds',
    'MyMod v1.2/bin/x64/plugins/cyber_engine_tweaks/mods/MyMod/init.lua',
    'MyMod v1.2/README.md',
  ], 'MyMod');
  assert.deepStrictEqual(dests(p), {
    'MyMod v1.2/archive/pc/mod/a.archive': 'archive/pc/mod/a.archive',
    'MyMod v1.2/r6/scripts/MyMod/main.reds': 'r6/scripts/MyMod/main.reds',
    'MyMod v1.2/bin/x64/plugins/cyber_engine_tweaks/mods/MyMod/init.lua': 'bin/x64/plugins/cyber_engine_tweaks/mods/MyMod/init.lua',
  });
  assert.match(p.type, /Archive/);
  assert.match(p.type, /CET/);
  assert.match(p.type, /Redscript/);
});

test('CET mod folder without the bin prefix goes under cyber_engine_tweaks/mods', () => {
  const p = planLayout(['SimpleMenu/init.lua', 'SimpleMenu/modules/ui.lua', 'SimpleMenu/modules/init.lua', 'SimpleMenu/data/cfg.json'], 'Simple Menu');
  assert.deepStrictEqual(dests(p), {
    'SimpleMenu/init.lua': 'bin/x64/plugins/cyber_engine_tweaks/mods/SimpleMenu/init.lua',
    'SimpleMenu/modules/ui.lua': 'bin/x64/plugins/cyber_engine_tweaks/mods/SimpleMenu/modules/ui.lua',
    'SimpleMenu/modules/init.lua': 'bin/x64/plugins/cyber_engine_tweaks/mods/SimpleMenu/modules/init.lua',
    'SimpleMenu/data/cfg.json': 'bin/x64/plugins/cyber_engine_tweaks/mods/SimpleMenu/data/cfg.json',
  });
  assert.strictEqual(p.type, 'CET');
});

test('CET init.lua at the archive root uses the mod name', () => {
  const p = planLayout(['init.lua', 'db.lua'], 'Fast Travel: Anywhere');
  assert.strictEqual(dests(p)['init.lua'], 'bin/x64/plugins/cyber_engine_tweaks/mods/Fast Travel Anywhere/init.lua');
});

test('loose redscript gets its own r6/scripts folder', () => {
  const p = planLayout(['BetterLoot/loot.reds', 'BetterLoot/util/helpers.reds'], 'Better Loot');
  assert.deepStrictEqual(dests(p), {
    'BetterLoot/loot.reds': 'r6/scripts/BetterLoot/loot.reds',
    'BetterLoot/util/helpers.reds': 'r6/scripts/BetterLoot/util/helpers.reds',
  });
  const root = planLayout(['loot.reds'], 'Better Loot');
  assert.strictEqual(dests(root)['loot.reds'], 'r6/scripts/Better Loot/loot.reds');
});

test('RED4ext plugin DLL goes to red4ext/plugins/<name> with its config', () => {
  const p = planLayout(['MyPlugin/MyPlugin.dll', 'MyPlugin/config.toml', 'MyPlugin/readme.txt'], 'My Plugin');
  assert.deepStrictEqual(dests(p), {
    'MyPlugin/MyPlugin.dll': 'red4ext/plugins/MyPlugin/MyPlugin.dll',
    'MyPlugin/config.toml': 'red4ext/plugins/MyPlugin/config.toml',
  });
  assert.strictEqual(p.type, 'RED4ext');
});

test('ASI plugin goes to bin/x64/plugins', () => {
  const p = planLayout(['FpsBoost.asi', 'FpsBoost.ini'], 'FPS');
  assert.deepStrictEqual(dests(p), { 'FpsBoost.asi': 'bin/x64/plugins/FpsBoost.asi', 'FpsBoost.ini': 'bin/x64/plugins/FpsBoost.ini' });
  assert.strictEqual(p.type, 'ASI');
});

test('TweakXL yaml goes to r6/tweaks/<name>', () => {
  const p = planLayout(['Tweaks/MoreAmmo.yaml'], 'More Ammo');
  assert.strictEqual(dests(p)['Tweaks/MoreAmmo.yaml'], 'r6/tweaks/Tweaks/MoreAmmo.yaml');
  assert.strictEqual(p.type, 'TweakXL');
});

test('REDmod folder with info.json goes to mods/<name>', () => {
  const p = planLayout(['MyRedmod/info.json', 'MyRedmod/archives/a.archive', 'MyRedmod/scripts/x.script'], 'R');
  assert.deepStrictEqual(dests(p), {
    'MyRedmod/info.json': 'mods/MyRedmod/info.json',
    'MyRedmod/archives/a.archive': 'mods/MyRedmod/archives/a.archive',
    'MyRedmod/scripts/x.script': 'mods/MyRedmod/scripts/x.script',
  });
  assert.strictEqual(p.type, 'REDmod');
  // Already under mods/ in the archive.
  const q = planLayout(['mods/MyRedmod/info.json', 'mods/MyRedmod/archives/a.archive'], 'R');
  assert.strictEqual(dests(q)['mods/MyRedmod/archives/a.archive'], 'mods/MyRedmod/archives/a.archive');
});

test('a folder called mods without info.json is not taken as REDmod', () => {
  const p = planLayout(['mods/Thing/init.lua'], 'Thing');
  assert.strictEqual(dests(p)['mods/Thing/init.lua'], 'bin/x64/plugins/cyber_engine_tweaks/mods/Thing/init.lua');
});

test('fomod folder is never installed', () => {
  const p = planLayout(['fomod/ModuleConfig.xml', 'fomod/info.xml', 'a.archive'], 'X');
  assert.deepStrictEqual(dests(p), { 'a.archive': 'archive/pc/mod/a.archive' });
});

test('same archive name in two variant folders warns and keeps one', () => {
  const p = planLayout(['Black/jacket.archive', 'White/jacket.archive'], 'Jacket');
  assert.strictEqual(p.mappings.length, 1);
  assert.match(p.warnings[0], /both install to archive\/pc\/mod\/jacket\.archive/);
});

test('unknown files are skipped with a warning', () => {
  const p = planLayout(['weird.bin', 'a.archive'], 'X');
  assert.deepStrictEqual(p.skipped, ['weird.bin']);
  assert.match(p.warnings[0], /weird\.bin/);
});

test('loader DLL slot in bin/x64: a warning for another mod, a note for CET itself', () => {
  const p = planLayout(['bin/x64/version.dll', 'archive/pc/mod/x.archive'], 'Something else');
  assert.ok(p.warnings.some(w => /loader DLL/.test(w)));
  const cet = planLayout(['bin/x64/version.dll', 'bin/x64/plugins/cyber_engine_tweaks.asi'], 'CET');
  assert.ok(!cet.warnings.some(w => /loader DLL/.test(w)) && cet.notes.some(w => /loader DLL/.test(w)));
});

test('input loader xml and engine ini', () => {
  const p = planLayout(['keys.xml', 'tweak.ini'], 'X');
  assert.deepStrictEqual(dests(p), { 'keys.xml': 'r6/input/keys.xml', 'tweak.ini': 'engine/config/platform/pc/tweak.ini' });
});

test('CET\'s own version.dll and RED4ext\'s own winmm.dll are notes, not warnings; anyone else\'s is a warning', () => {
  const cet = planLayout(['bin/x64/version.dll', 'bin/x64/global.ini', 'bin/x64/plugins/cyber_engine_tweaks.asi', 'bin/x64/plugins/cyber_engine_tweaks/LICENSE'], 'Cyber Engine Tweaks');
  assert.deepStrictEqual(cet.warnings, []);
  assert.strictEqual(cet.notes.length, 1);
  const r4 = planLayout(['bin/x64/winmm.dll', 'red4ext/RED4ext.dll'], 'RED4ext');
  assert.deepStrictEqual([r4.warnings.length, r4.notes.length], [0, 1]);
  const other = planLayout(['bin/x64/version.dll', 'archive/pc/mod/x.archive'], 'Some ASI loader');
  assert.deepStrictEqual([other.warnings.length, other.notes.length], [1, 0]);
});
