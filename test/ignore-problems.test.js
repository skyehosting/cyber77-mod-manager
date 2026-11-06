'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function setup(mods = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-ignore-'));
  const ud = path.join(root, 'ud');
  fs.mkdirSync(path.join(ud, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ud, 'data', 'library.json'), JSON.stringify({ downloads: {}, mods, nextPriority: 3 }));
  const settings = new Settings(ud, null);
  settings.update({ dataDir: path.join(ud, 'data') });
  return new ModManager({ settings, log: quiet });
}
const mod = (id, extra = {}) => ({ id, key: id, name: id, modName: id, modId: 0, fileId: 0, version: '1', type: 'Archive', category: 'MAIN', enabled: true, priority: 1, files: [], warnings: [], ...extra });

test('ignoring: by Nexus mod (an update keeps it), each warning, requirement and the log on its own, undone the same way', () => {
  const mgr = setup({ cet: mod('cet', { modId: 107, fileId: 5, warnings: ['a warning'] }), local: mod('local', { warnings: ['x'] }) });
  mgr.setIgnored('cet', 'w', 'a warning', true);
  mgr.setIgnored('cet', 'req', 'm:4198', true);
  mgr.setIgnored('cet', 'log', '', true);
  assert.deepStrictEqual(mgr.data.ignored['n:107'], { w: ['a warning'], req: ['m:4198'], log: true });
  mgr.setIgnored('local', 'w', 'x', true);
  assert.ok(mgr.data.ignored.local, 'a mod not from Nexus is kept by its row');
  mgr.setIgnored('cet', 'w', 'a warning', false);
  mgr.setIgnored('cet', 'req', 'm:4198', false);
  mgr.setIgnored('cet', 'log', '', false);
  assert.strictEqual(mgr.data.ignored['n:107'], undefined, 'nothing left: the entry goes');
  assert.deepStrictEqual(mgr.snapshot().ignored, { local: { w: ['x'] } });
  assert.throws(() => mgr.setIgnored('cet', 'health', 'x', true), /Unknown kind/);
  assert.throws(() => mgr.setIgnored('nope', 'w', 'x', true), /not installed/);
  assert.throws(() => mgr.setIgnored('cet', 'w', '', true), /Nothing to ignore/);
  assert.throws(() => mgr.setIgnored('cet', 'w', 'made up', true), /not on this mod/, 'only a warning the mod shows');
  assert.throws(() => mgr.setIgnored('cet', 'req', 'junk', true), /Not a requirement/);
});

test('CET installed before: its own version.dll warning becomes a note once; another mod\'s stays a warning', () => {
  const text = "bin/x64/version.dll is a loader DLL slot (CET uses version.dll, RED4ext uses winmm.dll). The game's existing file will be backed up and restored on disable.";
  const mgr = setup({
    cet: mod('cet', { modId: 107, files: ['bin/x64/version.dll', 'bin/x64/plugins/cyber_engine_tweaks.asi'], warnings: [text, 'other'] }),
    asi: mod('asi', { files: ['bin/x64/version.dll'], warnings: [text] }),
  });
  assert.deepStrictEqual([mgr.data.mods.cet.warnings, mgr.data.mods.cet.notes], [['other'], [text]]);
  assert.deepStrictEqual(mgr.data.mods.asi.warnings, [text]);
});

test('my categories: the first makes Default too; delete sends mods to Default; the last one goes back to the plain list', () => {
  const mgr = setup({ a: mod('a', { modId: 11 }), b: mod('b', { modId: 12 }), c: mod('c') });
  assert.deepStrictEqual(mgr.snapshot().sections.list, [], 'none: the plain list');
  const c1 = mgr.sectionCreate();
  let v = mgr.sectionsView();
  assert.deepStrictEqual(v.list.map(s => [s.name, !!s.def]), [['Default', true], ['Category 1', false]]);
  const c2 = mgr.sectionCreate();
  assert.strictEqual(mgr.sectionsView().list[2].name, 'Category 2');
  mgr.sectionAssign(['a', 'c'], c1);
  mgr.sectionAssign(['b'], c2);
  v = mgr.sectionsView();
  assert.deepStrictEqual(v.of, { 'n:11': c1, c: c1, 'n:12': c2 }, 'by Nexus mod (an update keeps it), or by row');
  mgr.sectionRename(c1, '  Clothing  ');
  assert.strictEqual(mgr.sectionsView().list[1].name, 'Clothing');
  assert.throws(() => mgr.sectionRename(c1, '   '), /Give the category a name/);
  mgr.sectionMove(c2, -1);
  assert.deepStrictEqual(mgr.sectionsView().list.map(s => s.name), ['Default', 'Category 2', 'Clothing']);
  const def = mgr.sectionsView().list[0].id;
  assert.throws(() => mgr.sectionDelete(def), /delete the others first/);
  mgr.sectionDelete(c1);
  assert.deepStrictEqual(mgr.sectionsView().of, { 'n:12': c2 }, 'its mods are in Default now');
  mgr.sectionAssign(['b'], def);
  assert.deepStrictEqual(mgr.sectionsView().of, {}, 'Default is where mods are without an entry');
  mgr.sectionDelete(c2);
  mgr.sectionDelete(def);
  assert.deepStrictEqual(mgr.snapshot().sections, { list: [], of: {} }, 'all gone: the plain list again');
  assert.strictEqual(mgr.data.sections, undefined);
  assert.throws(() => mgr.sectionAssign(['a'], 'nope'), /no longer exists/);
});
