'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { caseResolver } = require('../src/core/fileCase');
const { Deployer } = require('../src/core/deployer');

/*
 * File-name case on Linux: a mod's files go where the game already has its folders, whatever case
 * the mod spells them in (the game, under Wine, sees only one of two spellings). Runs on Windows too.
 */

async function asLinux(fn) {
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', plat); }
}
const put = (p, text = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
function game() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-case-'));
  const dir = path.join(root, 'game');
  put(path.join(dir, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  fs.mkdirSync(path.join(dir, 'archive', 'pc', 'content'), { recursive: true }); // as the game ships
  return { root, dir };
}

test('paths take the game folder\'s case; new known folders the game\'s lower case; a mod\'s own folders theirs, one spelling each', async () => {
  const { dir } = game();
  await asLinux(async () => {
    const where = caseResolver(dir);
    assert.strictEqual(where.resolve('Archive/PC/Mod/Rain.archive'), 'archive/pc/mod/Rain.archive');
    assert.strictEqual(where.resolve('BIN\\X64\\version.dll'), 'bin/x64/version.dll');
    assert.strictEqual(where.resolve('R6/Scripts/MyMod/a.reds'), 'r6/scripts/MyMod/a.reds', 'not there yet: the game\'s spelling for its folders, the mod\'s for its own');
    assert.strictEqual(where.resolve('r6/scripts/MYMOD/b.reds'), 'r6/scripts/MyMod/b.reds', 'one spelling per folder, even before it is made');
    assert.strictEqual(where.resolve('Red4ext/Plugins/ArchiveXL/Bundle/x.xl'), 'red4ext/plugins/ArchiveXL/Bundle/x.xl', 'plugin-internal names kept');
    assert.ok(where.exists('BIN/x64/CYBERPUNK2077.EXE'));
    assert.ok(!where.exists('bin/x64/version.dll'));
    assert.ok(!caseResolver(dir).exists('r6/scripts/MyMod/a.reds'), 'a check never counts a folder only planned');
  });
});

test('Windows ignores case: paths are used as they are', () => {
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.strictEqual(caseResolver(game().dir).resolve('Archive\\PC\\Mod\\a.archive'), 'Archive/PC/Mod/a.archive');
  } finally { Object.defineProperty(process, 'platform', plat); }
});

test('deploying on Linux: a mixed-case mod lands in the game\'s folders, and its own folders go when it is disabled', async () => {
  const { root, dir } = game();
  const staging = path.join(root, 'staging', 'a');
  for (const rel of ['Archive/PC/Mod/a.archive', 'R6/Scripts/A/a.reds', 'R6/Scripts/A/b.reds']) put(path.join(staging, rel), rel);
  await asLinux(async () => {
    const dep = new Deployer({ manifestFile: path.join(root, 'deploy.json'), backupDir: path.join(root, 'backup'), log: { warn() {}, info() {}, error() {} } });
    const mod = { id: 'a', stagingDir: staging, files: ['Archive/PC/Mod/a.archive', 'R6/Scripts/A/a.reds', 'R6/Scripts/A/b.reds'] };
    assert.strictEqual(dep.sync(dir, [mod]).added, 3);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'archive', 'pc', 'mod', 'a.archive'), 'utf8'), 'Archive/PC/Mod/a.archive');
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'r6', 'scripts')), ['A']);
    assert.deepStrictEqual(Object.values(dep.deployed).map(e => e.dest).sort(), ['archive/pc/mod/a.archive', 'r6/scripts/A/a.reds', 'r6/scripts/A/b.reds']);
    assert.strictEqual(dep.sync(dir, []).removed, 3);
    assert.ok(!fs.existsSync(path.join(dir, 'r6')), 'the folders made for it are cleaned up (A kept its case)');
    assert.ok(fs.existsSync(path.join(dir, 'archive', 'pc', 'content')), 'the game\'s own folders stay');
  });
});

test('Linux disks only: with both Archive and archive there, the game\'s own spelling wins', { skip: process.platform === 'win32' }, () => {
  const { dir } = game();
  fs.mkdirSync(path.join(dir, 'Archive', 'PC', 'Mod'), { recursive: true }); // left by another tool
  assert.strictEqual(caseResolver(dir).resolve('Archive/PC/Mod/a.archive'), 'archive/pc/mod/a.archive');
  assert.strictEqual(caseResolver(dir).resolve('archive/PC/mod/b.archive'), 'archive/pc/mod/b.archive');
});

test('an existing folder of a mod keeps its spelling; paths out of the game folder are refused; installers cannot look outside', async () => {
  const { root, dir } = game();
  fs.mkdirSync(path.join(dir, 'r6', 'scripts', 'MyMod'), { recursive: true }); // made earlier, as the mod spelt it then
  const { Installer } = require('../src/core/installer');
  await asLinux(async () => {
    const where = caseResolver(dir);
    assert.strictEqual(where.resolve('R6/scripts/mymod/new.reds'), 'r6/scripts/MyMod/new.reds');
    assert.throws(() => where.resolve('bin/../../outside.txt'), /inside the game folder/);
    assert.strictEqual(where.resolve('./bin/./x64/a.dll'), 'bin/x64/a.dll');
    assert.strictEqual(where.exists('../game/bin/x64/Cyberpunk2077.exe'), false);
    fs.writeFileSync(path.join(root, 'secret.txt'), 'x');
    const inst = new Installer({ getSevenZip: () => '', tempDir: () => root, log: {} });
    const items = [{ file: '..\\secret.txt' }, { file: 'BIN\\X64\\cyberpunk2077.exe' }];
    const session = { fomod: { config: { steps: [], conditional: [{ cond: { items } }] } } };
    assert.deepStrictEqual(inst.fileStates(session, dir), { '..\\secret.txt': 'Missing', 'bin\\x64\\cyberpunk2077.exe': 'Active' });
  });
});

test('Linux disks only: a file placed under another spelling moves to the folder the game sees; the user\'s own file is left', { skip: process.platform === 'win32' }, () => {
  const { root, dir } = game();
  const staging = path.join(root, 'staging', 'a');
  put(path.join(staging, 'Archive/PC/Mod/a.archive'), 'mod');
  const dep = new Deployer({ manifestFile: path.join(root, 'deploy.json'), backupDir: path.join(root, 'backup'), log: { warn() {}, info() {}, error() {} } });
  // As an older version would have placed it: in a second "Archive" folder the game may not see.
  fs.mkdirSync(path.join(dir, 'Archive', 'PC', 'Mod'), { recursive: true });
  fs.linkSync(path.join(staging, 'Archive/PC/Mod/a.archive'), path.join(dir, 'Archive/PC/Mod/a.archive'));
  const st = fs.statSync(path.join(dir, 'Archive/PC/Mod/a.archive'), { bigint: true });
  dep.store.data.gameDir = dir;
  dep.store.data.deployed['archive/pc/mod/a.archive'] = { dest: 'Archive/PC/Mod/a.archive', owner: 'a', kind: 'link', ino: st.ino.toString(), size: 3, backup: null };
  dep.sync(dir, [{ id: 'a', stagingDir: staging, files: ['Archive/PC/Mod/a.archive'] }]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'archive/pc/mod/a.archive'), 'utf8'), 'mod');
  assert.ok(!fs.existsSync(path.join(dir, 'Archive/PC/Mod/a.archive')), 'moved, not copied');
  assert.strictEqual(dep.deployed['archive/pc/mod/a.archive'].dest, 'archive/pc/mod/a.archive');
  // Two mods with the same file in different case: one file, the later mod's.
  const b = path.join(root, 'staging', 'b');
  put(path.join(b, 'ARCHIVE/pc/MOD/a.archive'), 'b');
  dep.sync(dir, [{ id: 'a', stagingDir: staging, files: ['Archive/PC/Mod/a.archive'] }, { id: 'b', stagingDir: b, files: ['ARCHIVE/pc/MOD/a.archive'] }]);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'archive', 'pc', 'mod')), ['a.archive']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'archive/pc/mod/a.archive'), 'utf8'), 'b');
});
