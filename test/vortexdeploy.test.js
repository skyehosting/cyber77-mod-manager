'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planDeploy, runDeploy } = require('../src/core/vortexDeploy');
const { parseFolderName } = require('../src/core/vortex');
const { buildReport } = require('../src/core/report');

/** A fake Vortex setup: staging folders, a game folder, and a hardlink deployment of `deployed`. */
function setup(mods, deployed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-vxd-'));
  const staging = path.join(root, 'staging');
  const game = path.join(root, 'game');
  fs.mkdirSync(game);
  for (const [id, files] of Object.entries(mods)) {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(staging, id, rel)), { recursive: true });
      fs.writeFileSync(path.join(staging, id, rel), content);
    }
  }
  const files = [];
  for (const id of deployed) {
    for (const rel of Object.keys(mods[id])) {
      const winRel = rel.replace(/\//g, '\\');
      fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true });
      fs.linkSync(path.join(staging, id, rel), path.join(game, rel));
      files.push({ relPath: winRel, source: id, target: '', time: 1 });
    }
  }
  const manifest = { instance: 'x', version: 1, deploymentMethod: 'hardlink_activator', gameId: 'cyberpunk2077', deploymentTime: 1, stagingPath: staging, targetPath: game, files };
  const manifestFile = path.join(game, 'vortex.deployment.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return { root, staging, game, manifest, manifestFile };
}

const sameInode = (a, b) => fs.statSync(a).ino === fs.statSync(b).ino;

test('switching versions: old files out, new files hardlinked in, record updated', () => {
  const v = setup({
    old: { 'archive/pc/mod/axl.archive': 'old', 'red4ext/plugins/AXL/AXL.dll': 'old', 'red4ext/plugins/AXL/old-only.txt': 'x' },
    new: { 'archive/pc/mod/axl.archive': 'new', 'red4ext/plugins/AXL/AXL.dll': 'new' },
  }, ['old']);
  const plan = planDeploy({ manifest: v.manifest, gameDir: v.game, changes: [{ vortexId: 'old', enabled: false }, { vortexId: 'new', enabled: true }] });
  assert.strictEqual(plan.deferred.length, 0);
  const r = runDeploy(plan, v.manifest, v.manifestFile);
  assert.deepStrictEqual([r.removed, r.linked], [3, 2]);
  assert.strictEqual(fs.readFileSync(path.join(v.game, 'archive/pc/mod/axl.archive'), 'utf8'), 'new');
  assert.ok(sameInode(path.join(v.game, 'red4ext/plugins/AXL/AXL.dll'), path.join(v.staging, 'new', 'red4ext/plugins/AXL/AXL.dll')));
  assert.ok(!fs.existsSync(path.join(v.game, 'red4ext/plugins/AXL/old-only.txt')));
  const m = JSON.parse(fs.readFileSync(v.manifestFile, 'utf8'));
  assert.deepStrictEqual([...new Set(m.files.map(f => f.source))], ['new']);
  assert.ok(m.files.every(f => f.relPath.includes('\\') && f.target === '' && f.time > 1));
  assert.ok(fs.existsSync(`${v.manifestFile}.cmm-backup`), 'the record Vortex wrote is kept');
});

test('disabling removes only its own files and empty folders, never the standard ones', () => {
  const v = setup({ a: { 'r6/scripts/A/a.reds': 'a' }, b: { 'r6/scripts/B/b.reds': 'b' } }, ['a', 'b']);
  runDeploy(planDeploy({ manifest: v.manifest, gameDir: v.game, changes: [{ vortexId: 'a', enabled: false }] }), v.manifest, v.manifestFile);
  assert.ok(!fs.existsSync(path.join(v.game, 'r6/scripts/A')), 'its empty folder goes');
  assert.ok(fs.existsSync(path.join(v.game, 'r6/scripts/B/b.reds')));
  const v2 = setup({ a: { 'r6/scripts/a.reds': 'a' } }, ['a']);
  runDeploy(planDeploy({ manifest: v2.manifest, gameDir: v2.game, changes: [{ vortexId: 'a', enabled: false }] }), v2.manifest, v2.manifestFile);
  assert.ok(fs.existsSync(path.join(v2.game, 'r6/scripts')), 'r6/scripts stays');
});

test('files two Vortex mods ship, or that are already in the game, are left to Vortex', () => {
  const v = setup({ a: { 'archive/pc/mod/x.archive': 'a' }, b: { 'archive/pc/mod/x.archive': 'b', 'archive/pc/mod/b.archive': 'b' } }, ['a']);
  fs.writeFileSync(path.join(v.game, 'archive/pc/mod/b.archive'), 'manual install');
  const plan = planDeploy({ manifest: v.manifest, gameDir: v.game, changes: [{ vortexId: 'b', enabled: true }] });
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.deferred.map(f => f.relPath.replace(/\\/g, '/')).sort(), ['archive/pc/mod/b.archive', 'archive/pc/mod/x.archive']);
});

test('a freed file goes to the one other enabled mod that ships it; a replaced file is left alone', () => {
  const v = setup({ a: { 'archive/pc/mod/x.archive': 'a' }, b: { 'archive/pc/mod/x.archive': 'b', 'archive/pc/mod/y.archive': 'b' } }, ['b']);
  // Vortex gave x.archive to b; pretend a won it instead, by deploying a's copy.
  const m = v.manifest;
  fs.unlinkSync(path.join(v.game, 'archive/pc/mod/x.archive'));
  fs.linkSync(path.join(v.staging, 'a', 'archive/pc/mod/x.archive'), path.join(v.game, 'archive/pc/mod/x.archive'));
  m.files.find(f => f.relPath.endsWith('x.archive')).source = 'a';
  const plan = planDeploy({ manifest: m, gameDir: v.game, changes: [{ vortexId: 'a', enabled: false }] });
  assert.deepStrictEqual(plan.link.map(f => f.source), ['b']);
  runDeploy(plan, m, v.manifestFile);
  assert.strictEqual(fs.readFileSync(path.join(v.game, 'archive/pc/mod/x.archive'), 'utf8'), 'b');

  const w = setup({ c: { 'bin/x64/global.ini': 'c' } }, ['c']);
  fs.unlinkSync(path.join(w.game, 'bin/x64/global.ini'));
  fs.writeFileSync(path.join(w.game, 'bin/x64/global.ini'), 'edited by hand');
  const p2 = planDeploy({ manifest: w.manifest, gameDir: w.game, changes: [{ vortexId: 'c', enabled: false }] });
  assert.deepStrictEqual([p2.remove.length, p2.keep.length], [0, 1]);
  runDeploy(p2, w.manifest, w.manifestFile);
  assert.strictEqual(fs.readFileSync(path.join(w.game, 'bin/x64/global.ini'), 'utf8'), 'edited by hand');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(w.manifestFile, 'utf8')).files, []);
});

test('only plain hardlink deployments are done here', () => {
  assert.strictEqual(planDeploy({ manifest: { deploymentMethod: 'symlink_activator', stagingPath: 'x', files: [] }, gameDir: 'g', changes: [] }), null);
});

test('Vortex folder and Nexus archive names give name, mod id and version', () => {
  assert.deepStrictEqual(parseFolderName('NightCityNet 34409 0.2.2 2026-10-28T20-40Z D2ZS2nqEC'), { name: 'NightCityNet', modId: 34409, version: '0.2.2' });
  assert.deepStrictEqual(parseFolderName('ArchiveXL-4198-1-28-6-1730000000'), { name: 'ArchiveXL', modId: 4198, version: '1.28.6' });
  assert.deepStrictEqual(parseFolderName('my custom mod'), {});
});

test('the report has every game and mod log error and warning, grouped and in full, and every mod', () => {
  const t = Date.parse('2026-11-01T10:00:00Z');
  const doc = buildReport({
    snap: {
      mods: [{ id: 'm1', name: 'ArchiveXL', modName: 'ArchiveXL', enabled: true, version: '1.28.6', modId: 4198, fileId: 1, type: 'RED4ext', category: 'MAIN', priority: 1, fileCount: 9, roots: ['red4ext/plugins/ArchiveXL'], warnings: [] }],
      conflicts: {}, updates: {}, game: { path: 'C:\\game', valid: true },
      profiles: { active: 'p', list: [{ id: 'p', name: 'Default', count: 1 }] },
    },
    vortex: { installed: true, activeProfileName: 'VP', profiles: [], mods: [{ vortexId: 'v1', name: 'Codeware', modName: 'Codeware', enabled: false, version: '1', modId: 7780, type: 'RED4ext', fileCount: 3 }], deployedPaths: new Map([['red4ext/plugins/codeware/codeware.dll', 'v1']]) },
    gameLog: [
      { level: 'error', source: 'ArchiveXL', file: 'red4ext/plugins/ArchiveXL/ArchiveXL.log', root: 'red4ext/plugins/ArchiveXL', text: 'Failed to load 12 items', time: t },
      { level: 'error', source: 'ArchiveXL', file: 'x', root: 'red4ext/plugins/ArchiveXL', text: 'Failed to load 30 items', time: t + 1000 },
      { level: 'warn', source: 'Codeware', file: 'y', root: 'red4ext/plugins/Codeware', text: 'slow', time: t + 2000 },
      { level: 'info', source: 'Game', text: 'started', time: t },
    ],
    gameStatus: { running: false }, sources: [{ source: 'ArchiveXL', rel: 'x', followed: true }],
    activity: [{ level: 'error', message: 'Download failed', detail: '403', time: t + 3000 }, { level: 'info', message: 'ok', time: t }],
    app: { version: '1.0.0' },
  });
  assert.deepStrictEqual([doc.summary.errors, doc.summary.warnings, doc.summary.mods], [2, 1, 2]);
  assert.strictEqual(doc.problems[0].count, 2, 'repeats of one message are grouped');
  assert.strictEqual(doc.problems[0].mod, 'ArchiveXL');
  assert.strictEqual(doc.allErrorsAndWarnings.length, 3);
  assert.ok(!JSON.stringify(doc).includes('Download failed'), "this app's own log (the Manager tab) is not in the report");
  assert.ok(doc.allErrorsAndWarnings.some(e => e.mod === 'Codeware (Vortex)'), 'Vortex mods are named on their log lines');
  assert.deepStrictEqual(doc.mods.map(m => [m.name, m.managedBy]), [['ArchiveXL', 'Cyber Mod Manager'], ['Codeware', 'Vortex']]);
  assert.strictEqual(doc.mods[0].logErrors, 2);
});
