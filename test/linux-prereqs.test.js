'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prefixComponents, missingComponents, protontricksCommand } = require('../src/core/wine');
const { Deployer } = require('../src/core/deployer');

/* Linux: what the mod loaders need in the game's Proton folder; copying mods across file systems. */

async function asLinux(fn) {
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', plat); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-prereq-'));

test('the Proton folder\'s components come from its winetricks.log; CET needs both, RED4ext the runtime', () => {
  const pfx = tmp();
  assert.deepStrictEqual(missingComponents(pfx, ['cet', 'red4ext']), ['vcrun2022', 'd3dcompiler_47'], 'nothing installed yet');
  assert.deepStrictEqual(missingComponents(pfx, []), [], 'no mod loaders: nothing needed');
  fs.writeFileSync(path.join(pfx, 'winetricks.log'), 'remove_mono\r\nVCRUN2022\n');
  assert.deepStrictEqual([...prefixComponents(pfx)], ['remove_mono', 'vcrun2022']);
  assert.deepStrictEqual(missingComponents(pfx, ['red4ext']), []);
  assert.deepStrictEqual(missingComponents(pfx, ['cet']), ['d3dcompiler_47']);
});

test('the protontricks command: installed, its Flatpak, or a note that it needs installing', () => {
  const root = tmp();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const none = protontricksCommand('1091500', ['vcrun2022', 'd3dcompiler_47'], { home: root, pathEnv: bin });
  assert.deepStrictEqual(none, { command: 'protontricks 1091500 vcrun2022 d3dcompiler_47', installed: false });
  fs.mkdirSync(path.join(root, '.local', 'share', 'flatpak', 'app', 'com.github.Matoking.protontricks'), { recursive: true });
  assert.deepStrictEqual(protontricksCommand('1091500', ['vcrun2022'], { home: root, pathEnv: bin }),
    { command: 'flatpak run com.github.Matoking.protontricks 1091500 vcrun2022', installed: true });
  fs.writeFileSync(path.join(bin, 'protontricks'), '');
  assert.deepStrictEqual(protontricksCommand('1091500', ['vcrun2022'], { home: root, pathEnv: bin }),
    { command: 'protontricks 1091500 vcrun2022', installed: true }, 'the installed one first');
});

test('on Linux a mod that cannot be hardlinked is copied (a reflink where the file system can)', async () => {
  const root = tmp();
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  const staging = path.join(root, 'staging', 'a');
  fs.mkdirSync(path.join(staging, 'archive', 'pc', 'mod'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'archive', 'pc', 'mod', 'a.archive'), 'A');
  const warned = [];
  await asLinux(async () => {
    const dep = new Deployer({ manifestFile: path.join(root, 'deploy.json'), backupDir: path.join(root, 'backup'), log: { warn: m => warned.push(m), info() {}, error() {} } });
    const orig = fs.linkSync;
    fs.linkSync = () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
    try { dep.sync(game, [{ id: 'a', stagingDir: staging, files: ['archive/pc/mod/a.archive'] }]); } finally { fs.linkSync = orig; }
    const e = Object.values(dep.deployed)[0];
    assert.strictEqual(e.kind, 'copy');
    assert.strictEqual(fs.readFileSync(path.join(game, 'archive', 'pc', 'mod', 'a.archive'), 'utf8'), 'A');
    assert.match(warned[0], /same file system \(partition\)/);
  });
});

test('a winetricks.log too big to be one is not read', () => {
  const pfx = tmp();
  fs.writeFileSync(path.join(pfx, 'winetricks.log'), Buffer.alloc((1 << 20) + 1, 'a'));
  assert.deepStrictEqual([...prefixComponents(pfx)], []);
});

test('Proton folders waived for the prerequisites are kept as full paths only, at most 20', () => {
  const { Settings } = require('../src/core/settings');
  const s = new Settings(path.join(tmp(), 'ud'), null);
  assert.deepStrictEqual(s.get('prereqsWaived'), []);
  const abs = path.resolve(tmp(), 'pfx');
  s.update({ prereqsWaived: [abs, 'relative/pfx', 42] });
  assert.deepStrictEqual(s.get('prereqsWaived'), [abs]);
  s.update({ prereqsWaived: Array.from({ length: 30 }, (_, i) => path.resolve(abs, String(i))) });
  assert.strictEqual(s.get('prereqsWaived').length, 20);
});
