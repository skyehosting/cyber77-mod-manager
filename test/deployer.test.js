'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Deployer } = require('../src/core/deployer');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-deploy-'));
  const game = path.join(root, 'game');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  const stage = (id, files) => {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(staging, id, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return { id, stagingDir: path.join(staging, id), files: Object.keys(files) };
  };
  const dep = new Deployer({ manifestFile: path.join(root, 'deployment.json'), backupDir: path.join(root, 'backups'), log: quiet });
  const read = rel => { try { return fs.readFileSync(path.join(game, rel), 'utf8'); } catch { return null; } };
  return { root, game, stage, dep, read };
}

test('enable places hardlinks, disable removes them and empty folders', () => {
  const { game, stage, dep, read } = setup();
  const a = stage('a', { 'archive/pc/mod/a.archive': 'A', 'r6/scripts/A/a.reds': 'AR' });
  let r = dep.sync(game, [a]);
  assert.strictEqual(r.added, 2);
  assert.strictEqual(read('archive/pc/mod/a.archive'), 'A');
  const st1 = fs.statSync(path.join(game, 'archive/pc/mod/a.archive'), { bigint: true });
  const st2 = fs.statSync(path.join(a.stagingDir, 'archive/pc/mod/a.archive'), { bigint: true });
  assert.strictEqual(st1.ino, st2.ino, 'should be a hardlink');

  r = dep.sync(game, []);
  assert.strictEqual(r.removed, 2);
  assert.strictEqual(fs.existsSync(path.join(game, 'archive')), false, 'created folders are cleaned up');
  assert.strictEqual(fs.existsSync(path.join(game, 'r6')), false);
  assert.ok(fs.existsSync(path.join(game, 'bin/x64/Cyberpunk2077.exe')), 'game files untouched');
});

test('higher priority wins conflicts and the loser comes back when it is disabled', () => {
  const { game, stage, dep, read } = setup();
  const a = stage('a', { 'archive/pc/mod/shared.archive': 'A', 'archive/pc/mod/a.archive': 'A' });
  const b = stage('b', { 'archive/pc/mod/shared.archive': 'B' });
  dep.sync(game, [a, b]);
  assert.strictEqual(read('archive/pc/mod/shared.archive'), 'B');
  dep.sync(game, [b, a]);
  assert.strictEqual(read('archive/pc/mod/shared.archive'), 'A');
  dep.sync(game, [a]);
  assert.strictEqual(read('archive/pc/mod/shared.archive'), 'A');
  dep.sync(game, [b]);
  assert.strictEqual(read('archive/pc/mod/shared.archive'), 'B');
  assert.strictEqual(read('archive/pc/mod/a.archive'), null);
});

test('an existing game file is backed up and restored', () => {
  const { game, stage, dep, read } = setup();
  fs.mkdirSync(path.join(game, 'engine/config/platform/pc'), { recursive: true });
  fs.writeFileSync(path.join(game, 'engine/config/platform/pc/user.ini'), 'ORIGINAL');
  const a = stage('a', { 'engine/config/platform/pc/user.ini': 'MODDED' });
  const b = stage('b', { 'engine/config/platform/pc/user.ini': 'MODDED-B' });
  dep.sync(game, [a]);
  assert.strictEqual(read('engine/config/platform/pc/user.ini'), 'MODDED');
  dep.sync(game, [b]); // ownership moves to b; the backup stays attached
  assert.strictEqual(read('engine/config/platform/pc/user.ini'), 'MODDED-B');
  dep.sync(game, []);
  assert.strictEqual(read('engine/config/platform/pc/user.ini'), 'ORIGINAL');
  assert.ok(fs.existsSync(path.join(game, 'engine/config/platform/pc')), 'pre-existing folders are kept');
});

test('a file replaced by something else is left alone on disable', () => {
  const { game, stage, dep, read } = setup();
  const a = stage('a', { 'archive/pc/mod/a.archive': 'A' });
  dep.sync(game, [a]);
  const p = path.join(game, 'archive/pc/mod/a.archive');
  fs.rmSync(p);
  fs.writeFileSync(p, 'SOMEONE ELSE');
  dep.sync(game, []);
  assert.strictEqual(read('archive/pc/mod/a.archive'), 'SOMEONE ELSE');
});

test('a deleted deployed file is put back on the next sync', () => {
  const { game, stage, dep, read } = setup();
  const a = stage('a', { 'archive/pc/mod/a.archive': 'A' });
  dep.sync(game, [a]);
  fs.rmSync(path.join(game, 'archive/pc/mod/a.archive'));
  const r = dep.sync(game, [a]);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(read('archive/pc/mod/a.archive'), 'A');
});

test('copy mode works and is removed cleanly', () => {
  const { game, stage, dep, read } = setup();
  const a = stage('a', { 'archive/pc/mod/a.archive': 'A' });
  dep.sync(game, [a], 'copy');
  assert.strictEqual(dep.deployed['archive/pc/mod/a.archive'].kind, 'copy');
  assert.strictEqual(read('archive/pc/mod/a.archive'), 'A');
  dep.sync(game, [], 'copy');
  assert.strictEqual(read('archive/pc/mod/a.archive'), null);
});

test('manifest survives a restart', () => {
  const { root, game, stage, dep, read } = setup();
  const a = stage('a', { 'archive/pc/mod/a.archive': 'A' });
  dep.sync(game, [a]);
  const again = new Deployer({ manifestFile: path.join(root, 'deployment.json'), backupDir: path.join(root, 'backups'), log: quiet });
  again.sync(game, []);
  assert.strictEqual(read('archive/pc/mod/a.archive'), null);
});
