'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');
const { VortexBridge, escapeKey } = require('../src/core/vortex');
const { parseModUrl, parseNxm } = require('../src/core/nexus');
const { storeOf } = require('../src/core/gameFinder');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function fakeGame(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-sbs-'));
  const game = path.join(root, extra.dir || 'game');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  return { root, game };
}

test('mod links are read in any form; nxm links carry their key', () => {
  for (const url of [
    'https://www.nexusmods.com/cyberpunk2077/mods/107',
    'https://www.nexusmods.com/cyberpunk2077/mods/107?tab=description',
    'nexusmods.com/cyberpunk2077/mods/107/',
    'https://next.nexusmods.com/games/cyberpunk2077/mods/107?tab=files',
  ]) assert.deepStrictEqual(parseModUrl(url), { game: 'cyberpunk2077', modId: 107, fileId: 0 }, url);
  assert.strictEqual(parseModUrl('https://www.nexusmods.com/cyberpunk2077/mods/107?tab=files&file_id=4242').fileId, 4242);
  assert.strictEqual(parseModUrl('https://example.com/mods/1'), null);
  assert.deepStrictEqual(parseNxm('nxm://cyberpunk2077/mods/107/files/4242?key=abc&expires=99&user_id=1'),
    { game: 'cyberpunk2077', modId: 107, fileId: 4242, key: 'abc', expires: '99' });
  assert.strictEqual(parseNxm('https://www.nexusmods.com/cyberpunk2077/mods/107'), null);
});

test('Vortex keys escape dots and backslashes', () => {
  assert.strictEqual(escapeKey('Mod 1.2.3-107'), 'Mod 1\\.2\\.3-107');
  assert.strictEqual(escapeKey('a\\b'), 'a\\\\b');
});

test('Vortex mods are read with the live deployed state and the active profile', () => {
  const { root, game } = fakeGame();
  const appData = path.join(root, 'appdata');
  const vx = path.join(appData, 'Vortex');
  fs.mkdirSync(path.join(vx, 'state.v2'), { recursive: true });
  fs.mkdirSync(path.join(vx, 'temp', 'state_backups_full'), { recursive: true });
  fs.mkdirSync(path.join(vx, 'cyberpunk2077', 'mods', 'late-install'), { recursive: true });
  fs.writeFileSync(path.join(vx, 'temp', 'state_backups_full', 'hourly.json'), JSON.stringify({
    persistent: {
      mods: { cyberpunk2077: {
        a: { id: 'a', type: '', attributes: { modName: 'Alpha', logicalFileName: 'Alpha Main', modId: 11, fileId: 110, version: '1.0', author: 'x' } },
        b: { id: 'b', type: '', attributes: { modName: 'Beta', modId: 22, version: '2.0' } },
      } },
      profiles: {
        p1: { id: 'p1', gameId: 'cyberpunk2077', name: 'Main', modState: { a: { enabled: true }, b: { enabled: true } } },
        p2: { id: 'p2', gameId: 'cyberpunk2077', name: 'Other', modState: { b: { enabled: true } } },
        p3: { id: 'p3', gameId: 'skyrimse', name: 'Not this game', modState: {} },
      },
    },
    settings: { profiles: { lastActiveProfile: { cyberpunk2077: 'p1' } } },
  }));
  // Live: Vortex has placed only Alpha's files (Beta was disabled since the snapshot).
  fs.writeFileSync(path.join(game, 'vortex.deployment.json'), JSON.stringify({
    files: [{ relPath: 'archive\\pc\\mod\\alpha.archive', source: 'a' }, { relPath: 'r6\\scripts\\alpha.reds', source: 'a' }],
  }));
  const bridge = new VortexBridge({ getGameDir: () => game, log: quiet, appData });
  const data = bridge.read();
  assert.strictEqual(data.installed, true);
  assert.strictEqual(data.activeProfileName, 'Main');
  assert.deepStrictEqual(data.profiles.map(p => [p.name, p.active, p.enabledIds.length]), [['Main', true, 2], ['Other', false, 1]]);
  const byId = Object.fromEntries(data.mods.map(m => [m.vortexId, m]));
  assert.strictEqual(byId.a.id, 'vx:a');
  assert.strictEqual(byId.a.modId, 11);
  assert.strictEqual(byId.a.enabled, true);
  assert.strictEqual(byId.a.fileCount, 2);
  assert.strictEqual(byId.b.enabled, false, 'the deployment record wins over an old snapshot');
  assert.ok(byId['late-install'], 'a staging folder newer than the snapshot is listed');
  assert.strictEqual(data.deployedPaths.get('archive/pc/mod/alpha.archive'), 'a');
  // No Vortex at all: nothing, and no error.
  assert.deepStrictEqual(new VortexBridge({ getGameDir: () => game, log: quiet, appData: path.join(root, 'none') }).read().mods, []);
});

function stubNexus(mgr) {
  mgr.nexus.getMod = async () => ({ name: 'Picker Mod', author: 'someone', summary: '[b]Bold[/b] summary' });
  mgr.nexus.getFiles = async () => ({
    files: [
      { file_id: 10, name: 'Main', file_name: 'main.zip', category_name: 'MAIN', is_primary: true, uploaded_timestamp: 5, description: '<b>The</b> main file' },
      { file_id: 11, name: 'Optional', file_name: 'opt.zip', category_name: 'OPTIONAL', uploaded_timestamp: 6 },
      { file_id: 12, name: 'Old', file_name: 'old.zip', category_name: 'OLD_VERSION', uploaded_timestamp: 1 },
    ],
  });
  mgr.nexus.getRequirements = async () => ({ gameId: '3333', requirements: [] });
  const queued = [];
  mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  return queued;
}

test('the plan lists every file for the picker, and the picked files are what is queued', async () => {
  const { root, game } = fakeGame();
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  const queued = stubNexus(mgr);

  const plan = await mgr.planLinks('https://www.nexusmods.com/cyberpunk2077/mods/5?tab=description');
  const m = plan.mods[0];
  assert.strictEqual(m.summary, 'Bold summary');
  assert.deepStrictEqual(m.allFiles.map(f => [f.fileId, f.category, f.selected]), [[11, 'OPTIONAL', true], [10, 'MAIN', true], [12, 'OLD_VERSION', false]], 'the categories in Settings are preselected');
  assert.strictEqual(m.allFiles.find(f => f.fileId === 10).description, 'The main file');

  await mgr.queuePlan(plan.token, [], { 5: [11, 12] });
  assert.deepStrictEqual(queued.map(q => q.fileName).sort(), ['old.zip', 'opt.zip']);

  // A link to one file preselects just that file.
  const one = await mgr.planLinks('https://www.nexusmods.com/cyberpunk2077/mods/5?tab=files&file_id=11');
  assert.deepStrictEqual(one.mods[0].allFiles.filter(f => f.selected).map(f => f.fileId), [11]);
});

test('an nxm link queues that one file with its key', async () => {
  const { root, game } = fakeGame();
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  const queued = stubNexus(mgr);
  const r = await mgr.handleNxm('nxm://cyberpunk2077/mods/5/files/11?key=k1&expires=123');
  assert.strictEqual(r.queued, 1);
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].fileName, 'opt.zip');
  assert.deepStrictEqual(queued[0].nxm, { key: 'k1', expires: '123' });
  await assert.rejects(mgr.handleNxm('nxm://cyberpunk2077/mods/5/files/999?key=k'), /no longer on Nexus/);
});

test('the store of a game folder is told from its files', async () => {
  const gog = fakeGame({ dir: 'Cyberpunk GOG' }).game;
  fs.writeFileSync(path.join(gog, 'goggame-1423049311.info'), '{}');
  assert.strictEqual((await storeOf(gog)).store, 'gog');
  const steam = fakeGame({ dir: 'steamapps' }).game;
  assert.strictEqual((await storeOf(steam)).store, 'steam');
  const plain = fakeGame({ dir: 'Games' }).game;
  assert.strictEqual((await storeOf(plain)).store, 'custom');
  assert.strictEqual((await storeOf(path.join(plain, 'nope'))).store, 'custom');
});
