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
 * A game folder deployed by a fake Vortex: "alpha" and "beta" both ship shared.archive and Vortex
 * gave it to beta; "gamma" is installed but disabled.
 */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-adopt-'));
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  const vx = path.join(root, 'appdata', 'Vortex');
  const staging = path.join(vx, 'cyberpunk2077', 'mods');
  fs.mkdirSync(path.join(vx, 'state.v2'), { recursive: true });
  fs.mkdirSync(path.join(vx, 'temp', 'state_backups_full'), { recursive: true });
  fs.mkdirSync(path.join(vx, 'downloads', 'cyberpunk2077'), { recursive: true });
  const mods = {
    alpha: { 'archive/pc/mod/alpha.archive': 'A', 'archive/pc/mod/shared.archive': 'from alpha' },
    beta: { 'archive/pc/mod/beta.archive': 'B', 'archive/pc/mod/shared.archive': 'from beta' },
    gamma: { 'r6/scripts/Gamma/g.reds': 'G' },
  };
  for (const [id, files] of Object.entries(mods)) {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(staging, id, rel)), { recursive: true });
      fs.writeFileSync(path.join(staging, id, rel), text);
    }
    fs.writeFileSync(path.join(vx, 'downloads', 'cyberpunk2077', `${id}-1-0.zip`), `zip of ${id}`);
  }
  const deployed = [['alpha', 'archive/pc/mod/alpha.archive'], ['beta', 'archive/pc/mod/beta.archive'], ['beta', 'archive/pc/mod/shared.archive']];
  for (const [src, rel] of deployed) {
    fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true });
    fs.linkSync(path.join(staging, src, rel), path.join(game, rel));
  }
  fs.writeFileSync(path.join(game, 'vortex.deployment.json'), JSON.stringify({
    deploymentMethod: 'hardlink_activator', stagingPath: staging, targetPath: game,
    files: deployed.map(([source, rel]) => ({ relPath: rel.replace(/\//g, '\\'), source, target: '', time: 1 })),
  }));
  const attrs = (id, modId, fileId) => ({ id, type: '', attributes: { modName: id.toUpperCase(), logicalFileName: id.toUpperCase(), modId, fileId, version: '1.0', author: 'someone', fileName: `${id}-1-0.zip` } });
  fs.writeFileSync(path.join(vx, 'temp', 'state_backups_full', 'hourly.json'), JSON.stringify({
    persistent: {
      mods: { cyberpunk2077: { alpha: attrs('alpha', 10, 100), beta: attrs('beta', 20, 200), gamma: attrs('gamma', 30, 300) } },
      profiles: { p1: { id: 'p1', gameId: 'cyberpunk2077', name: 'Main', modState: { alpha: { enabled: true }, beta: { enabled: true } } } },
    },
    settings: { profiles: { lastActiveProfile: { cyberpunk2077: 'p1' } } },
  }));

  const before = process.env.CMM_VORTEX_APPDATA;
  process.env.CMM_VORTEX_APPDATA = path.join(root, 'appdata');
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game });
  const mgr = new ModManager({ settings, log: quiet });
  process.env.CMM_VORTEX_APPDATA = before;
  // Vortex's own program: never really run in tests.
  const cli = [];
  mgr.vortex.exePath = () => 'Vortex.exe';
  mgr.vortex.isRunning = async () => false;
  mgr.vortex.runCli = async (_exe, args) => { cli.push(args); return 'changed'; };
  mgr.vortex.startVortex = () => { throw new Error('Vortex must not be opened'); };
  return { mgr, game, staging, cli };
}

const read = (game, rel) => fs.readFileSync(path.join(game, rel), 'utf8');

test('taking Vortex mods over: same files in the game, this app manages them, Vortex keeps them switched off', async () => {
  const { mgr, game, cli } = setup();
  const preview = mgr.vortexAdoptPreview();
  assert.deepStrictEqual([preview.mods, preview.enabled], [3, 2]);

  const { adopted } = await mgr.adoptFromVortex('all');
  assert.strictEqual(adopted.length, 3);

  // Vortex's record: the enabled ones are switched off there, through its own command line.
  const sets = cli.flat().filter(a => a.includes('modState'));
  assert.ok(sets.some(a => a.includes('alpha.enabled=false')) && sets.some(a => a.includes('beta.enabled=false')));
  const manifest = JSON.parse(fs.readFileSync(path.join(game, 'vortex.deployment.json'), 'utf8'));
  assert.deepStrictEqual(manifest.files, [], 'Vortex no longer owns any of their files');

  // This app: same mods, same versions and Nexus ids, same on/off state, and the same winner.
  const byName = Object.fromEntries(Object.values(mgr.data.mods).map(m => [m.name, m]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['ALPHA', 'BETA', 'GAMMA']);
  assert.deepStrictEqual([byName.ALPHA.enabled, byName.BETA.enabled, byName.GAMMA.enabled], [true, true, false]);
  assert.deepStrictEqual([byName.BETA.modId, byName.BETA.fileId, byName.BETA.version], [20, 200, '1.0']);
  assert.ok(byName.BETA.priority > byName.ALPHA.priority, 'beta won the shared file in Vortex, so it wins here too');
  assert.strictEqual(read(game, 'archive/pc/mod/shared.archive'), 'from beta');
  assert.strictEqual(read(game, 'archive/pc/mod/alpha.archive'), 'A');
  assert.ok(!fs.existsSync(path.join(game, 'r6/scripts/Gamma/g.reds')), 'the disabled one stays out of the game');
  assert.ok(mgr.data.downloads[byName.ALPHA.id], 'its archive came along, so Reinstall works');

  // No longer listed as Vortex mods, and asking again does nothing.
  assert.deepStrictEqual(mgr.vortexView().mods, []);
  assert.strictEqual((await mgr.adoptFromVortex('all')).adopted.length, 0);
});

test('updating a Vortex mod takes it over and updates it here, without opening Vortex', async () => {
  const { mgr } = setup();
  mgr.data.updates = { 'vx:alpha': { fileId: 101, name: 'ALPHA', fileName: 'alpha-2-0.zip', category: 'MAIN', version: '2.0', size: 5 } };
  const queued = [];
  mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  const summary = await mgr.updateMods(['vx:alpha']);
  assert.strictEqual(summary.mods, 1);
  const alpha = Object.values(mgr.data.mods).find(m => m.name === 'ALPHA');
  assert.ok(alpha, 'alpha is this app\'s now');
  assert.deepStrictEqual(queued.map(q => [q.fileId, q.replaces]), [[101, alpha.id]], 'the new version replaces it like any update here');
  assert.ok(!mgr.vortexView().mods.some(m => m.vortexId === 'alpha'));
  assert.ok(mgr.vortexView().mods.some(m => m.vortexId === 'beta'), 'the other Vortex mods stay in Vortex');
});

test('a mod in both apps shows once, and enabling it here switches Vortex\'s copy off', async () => {
  const { mgr, game, cli } = setup();
  // This app has beta too (same Nexus file), enabled.
  mgr.data.mods['200'] = { id: '200', key: '200', name: 'BETA', modName: 'BETA', modId: 20, fileId: 200, game: 'cyberpunk2077', version: '1.0', category: 'MAIN', files: [], enabled: false, priority: 1 };
  const view = mgr.vortexView();
  assert.ok(!view.mods.some(m => m.vortexId === 'beta'), 'Vortex\'s copy is not a second row');
  assert.deepStrictEqual(view.twins['200'], { name: 'BETA', enabled: true });
  assert.ok(view.mods.some(m => m.vortexId === 'alpha'), 'other Vortex mods are still listed');

  await mgr.setEnabled(['200'], true);
  assert.ok(cli.flat().some(a => a.includes('beta.enabled=false')), 'Vortex switched its copy off');
  assert.ok(!cli.flat().some(a => a.includes('alpha.enabled=false')), 'and nothing else');
  const manifest = JSON.parse(fs.readFileSync(path.join(game, 'vortex.deployment.json'), 'utf8'));
  assert.ok(!manifest.files.some(f => f.source === 'beta'));
});

test('a clash left from before waits while Vortex is open, and is settled once it closes', async () => {
  const { mgr, cli } = setup();
  mgr.data.mods['100'] = { id: '100', key: '100', name: 'ALPHA', modName: 'ALPHA', modId: 10, fileId: 100, game: 'cyberpunk2077', version: '1.0', category: 'MAIN', files: [], enabled: true, priority: 1 };
  mgr.vortex.isRunning = async () => true;
  assert.deepStrictEqual(await mgr.switchOffVortexTwins(null, { allowClose: false }), { switched: 0, waiting: 1 });
  assert.strictEqual(cli.length, 0, 'Vortex is not closed behind the user\'s back');
  mgr.vortex.isRunning = async () => false;
  assert.deepStrictEqual(await mgr.switchOffVortexTwins(null, { allowClose: false }), { switched: 1 });
  assert.ok(cli.flat().some(a => a.includes('alpha.enabled=false')));
});

test('"Vortex mods: move them here automatically": only when chosen, only while Vortex is closed, into the active profile', async () => {
  const { mgr, cli } = setup();
  const d = () => mgr.vortex.read();
  assert.strictEqual(mgr.settings.get('vortexAutoMove'), 'ask', 'nobody\'s Vortex mods move unasked');
  assert.strictEqual(mgr.vortexView().pending, 3);
  await mgr.autoMoveVortex(d());
  assert.strictEqual(Object.keys(mgr.data.mods).length, 0, '"ask" moves nothing by itself');

  mgr.settings.update({ vortexAutoMove: 'on' });
  mgr.vortexRunning = true;
  await mgr.autoMoveVortex(d());
  assert.deepStrictEqual([Object.keys(mgr.data.mods).length, cli.length], [0, 0], 'Vortex open: it waits, and Vortex is not closed');

  mgr.vortexRunning = false;
  await mgr.autoMoveVortex(d());
  const names = Object.values(mgr.data.mods).map(m => m.name).sort();
  assert.deepStrictEqual(names, ['ALPHA', 'BETA', 'GAMMA']);
  assert.ok(cli.flat().some(a => a.includes('alpha.enabled=false')), 'switched off in Vortex');
  const active = mgr.data.profiles.list[mgr.data.profiles.active];
  assert.deepStrictEqual(active.enabled.map(id => mgr.data.mods[id].name).sort(), ['ALPHA', 'BETA'], 'the enabled ones are in the active profile');
  assert.strictEqual(mgr.vortexView().pending, 0);
  const before = cli.length;
  await mgr.autoMoveVortex(d());
  assert.strictEqual(cli.length, before, 'nothing left to move: nothing happens');
});

test('enabling and disabling remembers when (for sorting by recent changes)', async () => {
  const { mgr } = setup();
  mgr.data.mods.m = { id: 'm', key: 'm', name: 'Mine', modId: 1, fileId: 1, files: [], enabled: false, priority: 1 };
  const t0 = Date.now();
  await mgr.setEnabled(['m'], true);
  assert.ok(mgr.data.mods.m.enabledAt >= t0);
  await mgr.setEnabled(['m'], false);
  assert.ok(mgr.data.mods.m.disabledAt >= mgr.data.mods.m.enabledAt);
  await mgr.setEnabled(['vx:alpha'], false); // a Vortex mod switched from here
  const alpha = mgr.vortexView().mods.find(v => v.vortexId === 'alpha');
  assert.ok(alpha.disabledAt >= t0, 'Vortex keeps no such times: this app remembers its own switches');
});
