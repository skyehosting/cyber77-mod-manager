'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GameModio } = require('../src/core/modioGame');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

/** A PC where the game's Mods menu installed two mods (one waiting for an update) and one is on its way. */
function makePc(root, { movedRoot = false } = {}) {
  const local = path.join(root, 'Local');
  const pub = path.join(root, 'Public');
  const store = movedRoot ? path.join(root, 'Elsewhere', 'mod.io') : path.join(pub, 'mod.io');
  if (movedRoot) write(path.join(local, 'mod.io', 'globalsettings.json'), JSON.stringify({ RootLocalStoragePath: `${store}/` }));
  const g = path.join(store, '5784');
  const entry = (id, name, state, extra = {}) => ({ ID: id, Profile: { name, name_id: name.toLowerCase().replace(/\W+/g, '-'), profile_url: `https://mod.io/g/cyberpunk-2077/m/${id}`, modfile: { id: id * 10, version: '1.2' }, logo: { thumb_640x360: `https://thumb.modcdn.io/${id}.png` } }, State: state, SizeOnDisk: 100, PathOnDisk: path.join(g, 'mods', String(id)), ...extra });
  write(path.join(g, 'metadata', 'state.json'), JSON.stringify({ Mods: [
    entry(11, 'Quest Core', 1),
    entry(22, 'Neon Hair', 2),
    entry(33, 'On Its Way', 0),
    entry(44, 'Sneaky', 1, { PathOnDisk: path.join(root, 'outside') }),
  ], version: 1 }));
  write(path.join(g, 'mods', '11', 'QuestCore', 'archives', 'questcore.archive'), 'q');
  write(path.join(g, 'mods', '22', 'NeonHair', 'archives', 'neonhair.archive'), 'n');
  write(path.join(g, 'mods', '44', 'x.archive'), 's');
  write(path.join(root, 'outside', 'secret.txt'), 'not the game\'s');
  // The player's mod.io sign-in: never read.
  write(path.join(local, 'mod.io', '5784', 'Player', 'user.json'), JSON.stringify({ OAuth: { token: 'SECRET-TOKEN' }, subscriptions: [11, 22] }));
  return { local, pub, store };
}

test('the game\'s Mods menu: its mod.io mods are read from mod.io\'s state file, files listed, the sign-in never read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-gmio-'));
  const { local, pub } = makePc(root);
  const read = [];
  const orig = fs.readFileSync;
  fs.readFileSync = function (p, ...a) { read.push(String(p)); return orig.call(this, p, ...a); };
  let r;
  try { r = new GameModio({ dirs: () => ({ localAppData: local, publicDir: pub }), log: quiet }).read(); } finally { fs.readFileSync = orig; }
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.mods.map(m => [m.id, m.name, m.state, m.installed, m.fileId, m.version]), [
    [11, 'Quest Core', 'installed', true, 110, '1.2'], [22, 'Neon Hair', 'update pending', true, 220, '1.2'],
    [33, 'On Its Way', 'install pending', false, 330, '1.2'], [44, 'Sneaky', 'installed', true, 440, '1.2'],
  ]);
  assert.deepStrictEqual(r.mods[0].files, ['QuestCore/archives/questcore.archive']);
  assert.deepStrictEqual(r.mods[3].files, ['x.archive'], 'a folder outside the game\'s mods folder is never listed: the usual place is used');
  assert.strictEqual(r.mods[0].url, 'https://mod.io/g/cyberpunk-2077/m/11');
  assert.ok(!read.some(p => /user\.json$/i.test(p)), 'the sign-in file is never opened');
});

test('the game\'s Mods menu: a moved storage root (globalsettings.json) is followed; under Proton C:\\ is the prefix\'s drive_c', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-gmio-'));
  const { local, pub } = makePc(root, { movedRoot: true });
  const r = new GameModio({ dirs: () => ({ localAppData: local, publicDir: pub }), log: quiet }).read();
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.mods.length, 4);
  // Proton: the game wrote a Windows path.
  const pfx = path.join(root, 'pfx');
  const driveC = path.join(pfx, 'drive_c');
  const pLocal = path.join(driveC, 'users', 'steamuser', 'AppData', 'Local');
  write(path.join(pLocal, 'mod.io', 'globalsettings.json'), JSON.stringify({ RootLocalStoragePath: 'C:/users/Public/mod.io/' }));
  write(path.join(driveC, 'users', 'Public', 'mod.io', '5784', 'metadata', 'state.json'), JSON.stringify({ Mods: [{ ID: 5, Profile: { name: 'Under Proton' }, State: 1 }], version: 1 }));
  const p = new GameModio({ dirs: () => ({ localAppData: pLocal, publicDir: path.join(driveC, 'users', 'Public'), driveC }), log: quiet }).read();
  assert.deepStrictEqual(p.mods.map(m => m.name), ['Under Proton']);
  // Nothing there (no game menu used, or not known): nothing found, no error.
  assert.deepStrictEqual(new GameModio({ dirs: () => null, log: quiet }).read(), { found: false, root: '', mods: [] });
});

test('the game\'s Mods menu next to this app\'s mods: the same mod.io mod installed twice, and archives of the same name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-gmio-'));
  const { local, pub } = makePc(root);
  const ud = path.join(root, 'ud');
  fs.mkdirSync(path.join(ud, 'data'), { recursive: true });
  const mod = (id, extra) => ({ id, key: id, name: id, modName: id, modId: 0, fileId: 0, version: '1', type: 'Archive', category: 'MAIN', enabled: true, priority: 1, files: [], warnings: [], ...extra });
  fs.writeFileSync(path.join(ud, 'data', 'library.json'), JSON.stringify({ downloads: {}, nextPriority: 4, mods: {
    'modio-110': mod('modio-110', { source: 'modio', modio: { id: 11, fileId: 110 }, files: ['mods/QuestCore/archives/questcore.archive'] }),
    hair: mod('hair', { files: ['archive/pc/mod/NeonHair.archive'] }),
    other: mod('other', { files: ['archive/pc/mod/other.archive'] }),
  } }));
  const settings = new Settings(ud, null);
  settings.update({ dataDir: path.join(ud, 'data') });
  const before = process.env.CMM_MODIO_GAME_DIRS;
  process.env.CMM_MODIO_GAME_DIRS = `${local}|${pub}`;
  try {
    const mgr = new ModManager({ settings, log: quiet });
    const v = mgr.snapshot().gameModio;
    assert.deepStrictEqual(v.twins, { 'modio-110': 'Quest Core' }, 'installed here and by the game');
    assert.deepStrictEqual(v.clashes, { hair: ['Neon Hair'] }, 'an archive of the same name (case aside)');
    assert.strictEqual(v.mods.find(m => m.id === 11).alsoHere, 'modio-110');
    assert.ok(v.mods.every(m => !('files' in m) && !('path' in m)), 'file lists and folders stay in the main process');
  } finally {
    if (before === undefined) delete process.env.CMM_MODIO_GAME_DIRS; else process.env.CMM_MODIO_GAME_DIRS = before;
  }
});

test('the game\'s Mods menu (audit): a Windows root with backslashes under Proton, other drives through dosdevices, network roots refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-gmio-'));
  const pfx = path.join(root, 'pfx');
  const driveC = path.join(pfx, 'drive_c');
  const local = path.join(driveC, 'users', 'steamuser', 'AppData', 'Local');
  const state = dir => write(path.join(dir, '5784', 'metadata', 'state.json'), JSON.stringify({ Mods: [{ ID: 9, Profile: { name: `In ${path.basename(path.dirname(dir))}` }, State: 1 }], version: 1 }));
  const gm = () => new GameModio({ dirs: () => ({ localAppData: local, publicDir: path.join(driveC, 'users', 'Public'), driveC }), log: quiet }).read();
  write(path.join(local, 'mod.io', 'globalsettings.json'), JSON.stringify({ RootLocalStoragePath: ['C:', 'Games', 'mod.io', ''].join('\\') }));
  state(path.join(driveC, 'Games', 'mod.io'));
  assert.deepStrictEqual(gm().mods.map(m => m.name), ['In Games'], 'C:\\Games\\mod.io is drive_c/Games/mod.io');
  if (process.platform !== 'win32') { // a folder named "d:" (Wine's drive link) only exists outside Windows
    write(path.join(local, 'mod.io', 'globalsettings.json'), JSON.stringify({ RootLocalStoragePath: ['D:', 'Mods', 'mod.io'].join('\\') }));
    state(path.join(pfx, 'dosdevices', 'd:', 'Mods', 'mod.io'));
    assert.deepStrictEqual(gm().mods.map(m => m.name), ['In Mods'], 'D: through dosdevices/d:');
  }
  // Windows: a network root is never looked in (falls back to Public).
  const wl = path.join(root, 'wl');
  write(path.join(wl, 'mod.io', 'globalsettings.json'), JSON.stringify({ RootLocalStoragePath: ['', '', 'nas', 'share', 'mod.io'].join('\\') }));
  const g = new GameModio({ dirs: () => ({ localAppData: wl, publicDir: path.join(root, 'wp') }), log: quiet });
  assert.strictEqual(g.root(), path.join(root, 'wp', 'mod.io'));
});
