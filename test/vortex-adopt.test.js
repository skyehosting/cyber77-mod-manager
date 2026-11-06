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
      profiles: {
        p1: { id: 'p1', gameId: 'cyberpunk2077', name: 'Main', modState: { alpha: { enabled: true }, beta: { enabled: true } } },
        p2: { id: 'p2', gameId: 'cyberpunk2077', name: 'Photo', modState: { alpha: { enabled: false }, gamma: { enabled: true } } },
      },
    },
    settings: { profiles: { lastActiveProfile: { cyberpunk2077: 'p1' } } },
  }));

  // Vortex deployed, then wrote its snapshot; both a while ago (what this app does next is newer).
  const ago = s => new Date(Date.now() - s * 1000);
  fs.utimesSync(path.join(game, 'vortex.deployment.json'), ago(120), ago(120));
  fs.utimesSync(path.join(vx, 'temp', 'state_backups_full', 'hourly.json'), ago(60), ago(60));

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

test('using a Vortex profile here: its mods move over, a profile gets exactly its setup, Vortex stops placing the rest', async () => {
  const { mgr, game, cli } = setup();
  const plan = mgr.vortexProfilePlan('p2');
  assert.deepStrictEqual([plan.name, plan.mods, plan.here, plan.move, plan.others], ['Photo', 1, 0, 1, 2]);

  const r = await mgr.useVortexProfile('p2');
  assert.deepStrictEqual([r.name, r.enabled, r.moved], ['Photo (Vortex)', 1, 1]);
  const prof = mgr.data.profiles.list[mgr.data.profiles.active];
  assert.strictEqual(prof.name, 'Photo (Vortex)', 'this app switched to it');
  assert.deepStrictEqual(prof.enabled.map(id => mgr.data.mods[id].name), ['GAMMA']);
  assert.strictEqual(read(game, 'r6/scripts/Gamma/g.reds'), 'G', 'its mod is in the game');
  const sets = cli.flat().filter(a => a.includes('modState'));
  assert.ok(sets.some(a => a.includes('alpha.enabled=false')) && sets.some(a => a.includes('beta.enabled=false')), 'Vortex switched off what the profile does not have');
  assert.ok(!fs.existsSync(path.join(game, 'archive/pc/mod/alpha.archive')));

  // Again: the same profile is updated, not a second one made.
  const n = Object.keys(mgr.data.profiles.list).length;
  await mgr.useVortexProfile('p2');
  assert.strictEqual(Object.keys(mgr.data.profiles.list).length, n);
  await assert.rejects(() => mgr.useVortexProfile('nope'), /no longer exists/);
});

test('a twin installed over Vortex\'s copy, then switched off: Vortex\'s files do not come back', async () => {
  const { mgr, game } = setup();
  // This app installs beta (same Nexus file) while Vortex's beta is in the game: its files are set aside.
  const files = ['archive/pc/mod/beta.archive', 'archive/pc/mod/shared.archive'];
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(mgr.settings.stagingDir, '200', rel)), { recursive: true });
    fs.writeFileSync(path.join(mgr.settings.stagingDir, '200', rel), 'ours');
  }
  mgr.data.mods['200'] = { id: '200', key: '200', name: 'BETA', modName: 'BETA', modId: 20, fileId: 200, game: 'cyberpunk2077', version: '1.0', category: 'MAIN', files, enabled: true, priority: 1 };
  mgr.deploy();
  assert.strictEqual(read(game, 'archive/pc/mod/beta.archive'), 'ours');
  await mgr.switchOffVortexTwins(['200']);
  await mgr.setEnabled(['200'], false);
  for (const rel of files) assert.ok(!fs.existsSync(path.join(game, rel)), `${rel}: off here and off in Vortex, so not in the game`);
  assert.strictEqual(read(game, 'archive/pc/mod/alpha.archive'), 'A', 'other Vortex mods are untouched');
});

test('an original that is not Vortex\'s, or whose Vortex mod is still placed, is still put back', async () => {
  const { mgr, game } = setup();
  fs.writeFileSync(path.join(game, 'archive', 'pc', 'mod', 'own.archive'), 'by hand');
  const files = ['archive/pc/mod/own.archive', 'archive/pc/mod/alpha.archive'];
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(mgr.settings.stagingDir, '300', rel)), { recursive: true });
    fs.writeFileSync(path.join(mgr.settings.stagingDir, '300', rel), 'ours');
  }
  mgr.data.mods['300'] = { id: '300', key: '300', name: 'OTHER', modName: 'OTHER', modId: 99, fileId: 999, game: 'cyberpunk2077', version: '1.0', category: 'MAIN', files, enabled: true, priority: 1 };
  mgr.deploy();
  await mgr.setEnabled(['300'], false);
  assert.strictEqual(read(game, 'archive/pc/mod/own.archive'), 'by hand');
  assert.strictEqual(read(game, 'archive/pc/mod/alpha.archive'), 'A', 'alpha is still on in Vortex');
});

test('Vortex files left in the game for a mod Vortex has off are cleared at start, with Vortex\'s empty folders', async () => {
  const { mgr, game, staging } = setup();
  // gamma is off in Vortex's active profile and not in its record, yet its file is in the game (an older version put it back).
  fs.mkdirSync(path.join(game, 'r6', 'scripts', 'Gamma'), { recursive: true });
  fs.linkSync(path.join(staging, 'gamma', 'r6', 'scripts', 'Gamma', 'g.reds'), path.join(game, 'r6', 'scripts', 'Gamma', 'g.reds'));
  fs.writeFileSync(path.join(game, 'r6', 'scripts', 'Gamma', '__folder_managed_by_vortex'), '{}');
  // A copy of the same file (not Vortex's link): someone's own, left alone.
  fs.mkdirSync(path.join(game, 'r6', 'scripts', 'Mine'), { recursive: true });
  fs.copyFileSync(path.join(staging, 'gamma', 'r6', 'scripts', 'Gamma', 'g.reds'), path.join(game, 'r6', 'scripts', 'Mine', 'g.reds'));
  mgr.vortex.isRunning = async () => true;
  assert.deepStrictEqual(await mgr.clearVortexLeftovers(), { removed: 0 }, 'never while Vortex is open');
  mgr.vortex.isRunning = async () => false;
  const r = await mgr.clearVortexLeftovers();
  assert.strictEqual(r.removed, 1);
  assert.ok(!fs.existsSync(path.join(game, 'r6', 'scripts', 'Gamma')), 'the folder Vortex made for it went too');
  assert.ok(fs.existsSync(path.join(game, 'r6', 'scripts')), 'the game\'s own folders stay');
  assert.ok(fs.existsSync(path.join(staging, 'gamma', 'r6', 'scripts', 'Gamma', 'g.reds')), 'Vortex still has it');
  assert.ok(fs.existsSync(path.join(game, 'r6', 'scripts', 'Mine', 'g.reds')));
  assert.strictEqual(read(game, 'archive/pc/mod/beta.archive'), 'B', 'mods Vortex places are untouched');
});

test('Vortex files are left alone whenever it is not certain they are left behind', async () => {
  const leftover = (game, staging, id, rel) => {
    fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(staging, id, rel)), { recursive: true });
    if (!fs.existsSync(path.join(staging, id, rel))) fs.writeFileSync(path.join(staging, id, rel), id);
    fs.linkSync(path.join(staging, id, rel), path.join(game, rel));
  };
  // A mod Vortex installed after its last snapshot (it may be on), placed through another record.
  {
    const { mgr, game, staging } = setup();
    leftover(game, staging, 'delta', 'mods/Delta/info.json');
    assert.deepStrictEqual(await mgr.clearVortexLeftovers(), { removed: 0 });
  }
  // A record that cannot be read.
  {
    const { mgr, game, staging } = setup();
    leftover(game, staging, 'gamma', 'r6/scripts/Gamma/g.reds');
    fs.writeFileSync(path.join(game, 'vortex.deployment.redmod.json'), '{ not json');
    assert.deepStrictEqual(await mgr.clearVortexLeftovers(), { removed: 0 });
    fs.writeFileSync(path.join(game, 'vortex.deployment.redmod.json'), JSON.stringify({ files: [{ relPath: path.win32.join('r6', 'scripts', 'Gamma', 'g.reds'), source: 'gamma' }] }));
    assert.deepStrictEqual(await mgr.clearVortexLeftovers(), { removed: 0 }, 'listed by a record of another mod type');
  }
  // Vortex deployed after its snapshot: the snapshot may be out of date.
  {
    const { mgr, game, staging } = setup();
    leftover(game, staging, 'gamma', 'r6/scripts/Gamma/g.reds');
    fs.utimesSync(path.join(game, 'vortex.deployment.json'), new Date(), new Date());
    assert.deepStrictEqual(await mgr.clearVortexLeftovers(), { removed: 0 });
  }
  // A mod enabled here ships the path (taken over from Vortex: the same file), with this app's record lost.
  {
    const { mgr, game, staging } = setup();
    leftover(game, staging, 'gamma', 'r6/scripts/Gamma/g.reds');
    mgr.data.mods['300'] = { id: '300', key: '300', name: 'GAMMA', modId: 30, fileId: 300, game: 'cyberpunk2077', version: '1.0', category: 'MAIN', files: ['r6/scripts/Gamma/g.reds'], enabled: true, priority: 1 };
    assert.deepStrictEqual(await mgr.clearVortexLeftovers(), { removed: 0 });
  }
});

test('hundreds of Vortex mods: their changes go to Vortex in batches that fit a Windows command line', async () => {
  const { cliBatches, CLI_BUDGET } = require('../src/core/vortex');
  const sets = Array.from({ length: 600 }, (_, i) => `persistent.profiles.rJ3kQ1xYz.modState.A Very Long Vortex Mod Name With Spaces-${i}-2-12-1-1730000000.enabled=false`);
  const exe = 'C:\Users\Someone\AppData\Local\Programs\vortex\Vortex.exe';
  const batches = cliBatches(exe, sets);
  assert.ok(batches.length > 1);
  for (const b of batches) {
    const len = exe.length + 3 + b.reduce((n, a) => n + a.length + 3, 0);
    assert.ok(len <= CLI_BUDGET && len < 32767, `a batch of ${len} characters`);
    assert.ok(b.every((a, i) => (i % 2 === 0 ? a === '--set' : a !== '--set')));
  }
  assert.deepStrictEqual(batches.flat().filter(a => a !== '--set'), sets, 'every change once, in order');
});

test('a batch that fails puts the earlier ones back, and Vortex reopens if it was open', async () => {
  const { mgr, cli } = setup();
  const { cliBatches } = require('../src/core/vortex');
  const data = mgr.vortex.read();
  // Pretend there are enough changes for three batches: the second one fails.
  const many = Array.from({ length: 700 }, (_, i) => ({ vortexId: `${'x'.repeat(60)}-${i}`, enabled: false }));
  let calls = 0;
  mgr.vortex.retryDelay = 1;
  // The second batch fails all three of its tries (calls 2, 3 and 4).
  mgr.vortex.runCli = async (_exe, args) => { calls++; cli.push(args); if (calls >= 2 && calls <= 4) throw new Error('database locked'); return 'changed'; };
  let reopened = false;
  mgr.vortex.isRunning = async () => false;
  mgr.vortex.startVortex = () => { reopened = true; };
  mgr.vortex.isRunning = (() => { let first = true; return async () => { if (first) { first = false; return true; } return false; }; })();
  mgr.vortex.closeVortex = async () => {};
  assert.ok(cliBatches('Vortex.exe', many.map(c => `persistent.profiles.p1.modState.${c.vortexId}.enabled=false`)).length >= 3);
  await assert.rejects(mgr.vortex.apply(many), /part 2 of \d+.*Nothing was changed/);
  const first = cli[0].filter(a => a !== '--set');
  const undo = cli.slice(4).flat().filter(a => a !== '--set');
  const second = cli[1].filter(a => a !== '--set');
  assert.strictEqual(undo.length, first.length + second.length, 'the first batch is put back, and the failed one too (it may have been written in part)');
  assert.ok(undo.every(a => a.endsWith('.enabled=true')), 'to how they were (enabled)');
  assert.ok(reopened, 'Vortex was open, so it opens again');
  assert.ok(data.activeProfile);
});

test('moving from Vortex: a batch is tried three times; one that still fails stays with Vortex and is named, the rest move', async () => {
  const { mgr, cli } = setup();
  mgr.vortex.retryDelay = 1;
  let calls = 0;
  // alpha and beta are enabled: one batch. Fail it twice, then let it through: retries make it work.
  mgr.vortex.runCli = async (_exe, args) => { calls++; cli.push(args); if (args.some(a => a.includes('modState')) && calls <= 2) throw new Error('database locked'); return 'changed'; };
  const r = await mgr.adoptFromVortex('all');
  assert.strictEqual(r.adopted.length, 3, 'three tries were enough');
  assert.deepStrictEqual(r.failed, []);
});

test('moving from Vortex: a batch that fails all three tries leaves its mods with Vortex, untouched, and names them', async () => {
  const { mgr, game } = setup();
  mgr.vortex.retryDelay = 1;
  let tries = 0;
  mgr.vortex.runCli = async (_exe, args) => { if (args.some(a => a.includes('modState'))) { tries++; throw new Error('database locked'); } return 'changed'; };
  await assert.rejects(mgr.adoptFromVortex('all'), /after 3 tries.*Nothing was changed/, 'nothing went through: nothing to move');
  assert.strictEqual(tries, 4, 'three tries, then one run that puts the batch back as it was');
  assert.ok(fs.existsSync(path.join(game, 'archive/pc/mod/alpha.archive')), 'Vortex\'s files stay in the game');
  assert.deepStrictEqual(Object.keys(mgr.data.mods), [], 'nothing was taken over');
});

test('toggling Vortex mods (all or nothing): a later batch failing three times puts the earlier ones back', async () => {
  const { mgr, cli } = setup();
  mgr.vortex.retryDelay = 1;
  const many = Array.from({ length: 700 }, (_, i) => ({ vortexId: `${'x'.repeat(60)}-${i}`, enabled: false }));
  mgr.vortex.runCli = async (_exe, args) => { cli.push(args); if (cli.length >= 2 && cli.length <= 4) throw new Error('locked'); return 'changed'; };
  await assert.rejects(mgr.vortex.apply(many), /part 2 of \d+\) after 3 tries.*Nothing was changed/);
  const undo = cli.slice(4).flat().filter(a => a !== '--set');
  assert.ok(undo.length > 0 && undo.every(a => a.endsWith('.enabled=true')), 'the first batch put back');
});

test('a Vortex mod from mod.io keeps its mod.io ids apart (never matched to a Nexus mod), and keeps them when moved here', async () => {
  const { mgr, staging } = setup();
  const file = path.join(path.dirname(path.dirname(staging)), 'temp', 'state_backups_full', 'hourly.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.persistent.mods.cyberpunk2077.gamma.attributes.source = 'modio';
  fs.writeFileSync(file, JSON.stringify(st));
  const g = mgr.vortex.read().mods.find(m => m.vortexId === 'gamma');
  assert.strictEqual(g.modId, 0, 'not a Nexus id');
  assert.deepStrictEqual(g.modio, { id: 30, fileId: 300 });
  const a = mgr.vortex.read().mods.find(m => m.vortexId === 'alpha');
  assert.strictEqual(a.modId, 10, 'no source recorded: Nexus, as before');
});
