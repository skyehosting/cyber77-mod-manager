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

test('mod search: names as typed, a number also as a mod id (first), filters and paging', async () => {
  const { NexusClient } = require('../src/core/nexus');
  const sent = [];
  const node = (modId, name, extra = {}) => ({ modId, name, summary: 's', author: 'a', version: '1', category: 'Gameplay', adultContent: false, downloads: 5, endorsements: 7, thumbnailUrl: 't', pictureUrl: 'p', updatedAt: '2026-01-01T00:00:00Z', createdAt: '', ...extra });
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.variables);
    const byId = body.variables.f.modId;
    const nodes = byId ? [node(4198, 'ArchiveXL')] : [node(1, 'Mod 4198 fan pack'), node(4198, 'ArchiveXL')];
    return { ok: true, status: 200, json: async () => ({ data: { mods: { totalCount: byId ? 1 : 41, nodes } } }) };
  };
  try {
    const n = new NexusClient(() => '', { info() {} });
    const r = await n.searchMods({ query: '4198', category: 'Gameplay', sort: 'downloads', page: 1, perPage: 20 });
    assert.deepStrictEqual(r.mods.map(m => m.modId), [4198, 1], 'the exact id first, no duplicate');
    assert.strictEqual(r.total, 41);
    const named = sent.find(v => !v.f.modId);
    assert.deepStrictEqual(named.f.name, [{ value: '4198', op: 'WILDCARD' }]);
    assert.deepStrictEqual(named.f.categoryName, [{ value: 'Gameplay' }]);
    assert.deepStrictEqual(named.f.adultContent, [{ value: false }], 'adult mods are left out unless asked for');
    assert.deepStrictEqual(named.s, [{ downloads: { direction: 'DESC' } }]);
    sent.length = 0;
    const p3 = await n.searchMods({ query: 'rain', page: 3, perPage: 40, sort: 'bogus' });
    assert.strictEqual(sent.length, 1, 'a name is not looked up as an id');
    assert.deepStrictEqual([sent[0].offset, sent[0].count, p3.page], [80, 40, 3]);
    assert.deepStrictEqual(sent[0].s, [{ endorsements: { direction: 'DESC' } }], 'an unknown sort falls back');
  } finally {
    global.fetch = realFetch;
  }
});

test('the nxm handler is named from its registered command', () => {
  const { describe } = require('../src/core/nxmHandler');
  const own = String.raw`C:\Apps\Cyber Mod Manager\electron.exe`;
  assert.strictEqual(describe(String.raw`"C:\Program Files\Black Tree Gaming Ltd\Vortex\Vortex.exe" -d "%1"`, own), 'Vortex');
  assert.strictEqual(describe(`"${own}" "C:\\app" "%1"`, own), 'Cyber Mod Manager');
  assert.strictEqual(describe(String.raw`C:\Users\x\Desktop\DMM.exe "%1"`, own), 'DMM');
  assert.strictEqual(describe('', own), '');
});

test('a clicked "Slow download" (nxm link) continues the file that waits for it', async () => {
  const { root, game } = fakeGame();
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  mgr.nexus.getDownloadLink = async () => { throw Object.assign(new Error('stop here'), { status: 404 }); };
  mgr.downloader.freeAccount = true;
  const job = mgr.downloader.enqueue({ game: 'cyberpunk2077', modId: 5, fileId: 11, name: 'Optional', modName: 'Picker Mod', fileName: 'opt.zip', dest: path.join(root, 'opt.zip') });
  assert.strictEqual(job.status, 'waiting');
  let fetched = false;
  mgr.nexus.getMod = async () => { fetched = true; return {}; };
  const r = await mgr.handleNxm('nxm://cyberpunk2077/mods/5/files/11?key=k2&expires=9');
  assert.deepStrictEqual([r.resumed, r.file], [true, 'Optional']);
  assert.deepStrictEqual(job.nxm, { key: 'k2', expires: '9' });
  assert.strictEqual(fetched, false, 'no second download is made for it');
  assert.strictEqual(mgr.downloader.jobs.size, 1);
});

test('Browse "Adult (18+)" asks Nexus for adult mods only', async () => {
  const { NexusClient, ADULT_ONLY } = require('../src/core/nexus');
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body).variables);
    return { ok: true, status: 200, json: async () => ({ data: { mods: { totalCount: 0, nodes: [] } } }) };
  };
  try {
    await new NexusClient(() => '', { info() {} }).searchMods({ category: ADULT_ONLY });
    assert.deepStrictEqual(sent[0].f.adultContent, [{ value: true }]);
    assert.strictEqual(sent[0].f.categoryName, undefined, 'not a Nexus category name');
  } finally {
    global.fetch = realFetch;
  }
});

test('Play starts the game directly, with -modded when there are REDmods; REDmod changes are noticed', async () => {
  const { launchGame, redmodFingerprint } = require('../src/core/launcher');
  const { game } = fakeGame();
  const calls = [];
  const fakeRun = (exe, args) => { calls.push([path.basename(exe), args]); return { on() {}, unref() {} }; };
  const opened = [];
  const r1 = await launchGame({ gameDir: game, store: 'steam' }, async u => opened.push(u), fakeRun);
  assert.deepStrictEqual([r1.via, calls[0]], ['the game directly', ['Cyberpunk2077.exe', []]]);
  assert.deepStrictEqual(opened, [], 'no steam:// link (and so no Steam prompt)');

  const before = redmodFingerprint(game);
  fs.mkdirSync(path.join(game, 'mods', 'My REDmod', 'archives'), { recursive: true });
  fs.writeFileSync(path.join(game, 'mods', 'My REDmod', 'info.json'), '{"name":"My REDmod"}');
  const added = redmodFingerprint(game);
  assert.notStrictEqual(added, before, 'adding a REDmod needs a deploy');
  assert.strictEqual(redmodFingerprint(game), added, 'nothing changed: no deploy');
  fs.writeFileSync(path.join(game, 'mods', 'My REDmod', 'archives', 'x.archive'), 'x');
  assert.notStrictEqual(redmodFingerprint(game), added, 'a changed REDmod needs a deploy');

  await launchGame({ gameDir: game, store: 'steam' }, async u => opened.push(u), fakeRun);
  assert.deepStrictEqual(calls[1][1], ['-modded']);
  await launchGame({ gameDir: game, store: 'steam', mode: 'store' }, async u => opened.push(u), fakeRun);
  assert.deepStrictEqual(opened, ['steam://run/1091500//-modded/'], 'through Steam only when chosen');
});
