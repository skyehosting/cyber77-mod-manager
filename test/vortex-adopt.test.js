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
