'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const SEVEN_ZIP = require('./seven-zip');
const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function makeArchive(dir, name, files) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-src-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), content);
  }
  const out = path.join(dir, name);
  execFileSync(SEVEN_ZIP, ['a', '-bso0', '-bsp0', out, '*'], { cwd: src });
  return out;
}

test('import, install, enable, conflict, uninstall, delete', { skip: !fs.existsSync(SEVEN_ZIP) && 'no 7-Zip' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-mgr-'));
  const game = path.join(root, 'Cyberpunk 2077');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');

  const settings = new Settings(path.join(root, 'userdata'), null);
  settings.update({ gamePath: game, sevenZipPath: SEVEN_ZIP });
  const mgr = new ModManager({ settings, log: quiet });

  const a = makeArchive(root, 'Alpha.zip', { 'Alpha/alpha.archive': 'A', 'Alpha/shared.archive': 'A' });
  const b = makeArchive(root, 'Beta.7z', { 'shared.archive': 'B', 'Beta/init.lua': 'lua' });
  const keys = await mgr.importArchives([a, b]);
  const results = await mgr.install(keys);
  assert.ok(results.every(r => r.id), JSON.stringify(results));
  const [ida, idb] = results.map(r => r.id);
  assert.strictEqual(mgr.data.mods[idb].type, 'CET + Archive');

  await mgr.setEnabled([ida, idb], true);
  const shared = path.join(game, 'archive/pc/mod/shared.archive');
  assert.strictEqual(fs.readFileSync(shared, 'utf8'), 'B', 'later install has higher priority');
  const snap = mgr.snapshot();
  assert.strictEqual(snap.conflicts[ida].loses, 1);
  assert.strictEqual(snap.conflicts[idb].wins, 1);

  await mgr.prioritize([ida]);
  assert.strictEqual(fs.readFileSync(shared, 'utf8'), 'A');

  await mgr.setEnabled([ida], false);
  assert.strictEqual(fs.readFileSync(shared, 'utf8'), 'B');
  assert.ok(!fs.existsSync(path.join(game, 'archive/pc/mod/alpha.archive')));

  await mgr.uninstall([idb]);
  assert.ok(!fs.existsSync(shared));
  assert.ok(!fs.existsSync(path.join(game, 'bin/x64/plugins')), 'created folders removed');
  assert.ok(!mgr.data.mods[idb]);
  assert.ok(mgr.data.downloads[keys[1]], 'archive kept after uninstall');

  await mgr.deleteDownloads(keys);
  assert.deepStrictEqual(Object.keys(mgr.data.mods), []);
  assert.deepStrictEqual(Object.keys(mgr.data.downloads), []);
  assert.deepStrictEqual(fs.readdirSync(game), ['bin']);
});
