'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VortexBridge, exeFromRegValue, isVortexExe, expandEnv } = require('../src/core/vortex');
const { Settings } = require('../src/core/settings');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
// The fake Vortex.exe files live in the temp folder: a drive path only on Windows.
const WIN = { skip: process.platform !== 'win32' && 'Vortex.exe paths are Windows drive paths' };

/** A folder with a Vortex.exe in it (an empty file stands in for the program). */
function fakeVortex(name = 'Vortex.exe') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-vxexe-'));
  const exe = path.join(dir, name);
  fs.writeFileSync(exe, '');
  return { dir, exe };
}

/** A bridge whose registry is `values` ("key|name" → value), with no Vortex in the usual places. */
function bridge(values, opts = {}) {
  const asked = [];
  const b = new VortexBridge({
    getGameDir: () => '', log: quiet, appData: path.join(os.tmpdir(), 'cmm-no-vortex'), platform: 'win32',
    reg: async (key, name) => { asked.push(`${key}|${name}`); return values[`${key}|${name}`] || ''; }, ...opts,
  });
  b.asked = asked;
  return b;
}

const UNINSTALL = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\57979c68-f490-55b8-8fed-8b017a5af2fe';

test('registry values name the program: quoted or bare, without the icon index or arguments', () => {
  assert.strictEqual(exeFromRegValue('D:\\Apps\\Vortex\\Vortex.exe,0'), 'D:\\Apps\\Vortex\\Vortex.exe');
  assert.strictEqual(exeFromRegValue('"D:\\My Apps\\Vortex\\Vortex.exe" -d "%1"'), 'D:\\My Apps\\Vortex\\Vortex.exe');
  assert.strictEqual(exeFromRegValue('"D:\\Apps\\Vortex\\Vortex.exe",0'), 'D:\\Apps\\Vortex\\Vortex.exe');
  assert.strictEqual(exeFromRegValue(''), '');
  assert.ok(isVortexExe('D:\\Apps\\Vortex\\Vortex.exe') && isVortexExe('C:/x/vortex.EXE'));
  assert.ok(!isVortexExe('Vortex.exe') && !isVortexExe('D:\\x\\NotVortex.exe') && !isVortexExe('D:\\x\\Vortex.exe.bat') && !isVortexExe(null));
  // On a drive only: not a network share, not "\Vortex.exe" (the current drive's root).
  assert.ok(!isVortexExe('\\\\server\\share\\Vortex.exe') && !isVortexExe('\\Vortex.exe') && !isVortexExe('//server/share/Vortex.exe'));
  // REG_EXPAND_SZ values: %VARIABLES% filled in (any case); an unknown one stays.
  process.env.CMM_TEST_VXDIR = 'E:\\Mods';
  assert.strictEqual(expandEnv('%cmm_test_vxdir%\\Vortex\\Vortex.exe'), 'E:\\Mods\\Vortex\\Vortex.exe');
  assert.strictEqual(expandEnv('%NO_SUCH_VAR_HERE%\\x'), '%NO_SUCH_VAR_HERE%\\x');
  delete process.env.CMM_TEST_VXDIR;
});

test('Vortex installed anywhere is found through its uninstall entry', WIN, async () => {
  const { exe } = fakeVortex();
  const b = bridge({ [`HKCU\\${UNINSTALL}|DisplayIcon`]: `${exe},0` });
  assert.strictEqual(await b.findExe(), exe);
  assert.deepStrictEqual(b.exeInfo(), { exe, source: 'found', chosenMissing: false });
  assert.strictEqual(b.exePath(), exe);
});

test('else through the nxm link handler, when Vortex has it; another program there is not taken for Vortex', WIN, async () => {
  const { exe } = fakeVortex();
  const b = bridge({ 'HKCR\\nxm\\shell\\open\\command|': `"${exe}" -d "%1"` });
  assert.strictEqual(await b.findExe(), exe);
  const other = fakeVortex('Cyber Mod Manager.exe');
  const c = bridge({ 'HKCU\\Software\\Classes\\nxm\\shell\\open\\command|': `"${other.exe}" "%1"` });
  assert.strictEqual(await c.findExe(), '');
});

test('the uninstall entry wins over the link handler, though all are asked at once', WIN, async () => {
  const a = fakeVortex();
  const b = fakeVortex();
  const v = bridge({ [`HKLM\\${UNINSTALL}|DisplayIcon`]: `${a.exe},0`, 'HKCR\\nxm\\shell\\open\\command|': `"${b.exe}" -d "%1"` });
  assert.strictEqual(await v.findExe(), a.exe);
  assert.strictEqual(v.asked.length, 7);
});

test('a registry entry pointing where there is no Vortex.exe (uninstalled, moved) finds nothing; a failing lookup is no lookup', async () => {
  const b = bridge({ [`HKLM\\${UNINSTALL}|DisplayIcon`]: 'Z:\\Gone\\Vortex.exe,0' });
  assert.strictEqual(await b.findExe(), '');
  const c = bridge({}, { reg: async () => { throw new Error('reg failed'); } });
  assert.strictEqual(await c.findExe(), '');
});

test('InstallLocation (a folder) is enough', WIN, async () => {
  const { dir, exe } = fakeVortex();
  const b = bridge({ [`HKLM\\${UNINSTALL}|InstallLocation`]: `"${dir}"` });
  assert.strictEqual(await b.findExe(), exe);
});

test('the Vortex.exe chosen in Settings wins; one that is not Vortex.exe, or not there, is ignored (and said so)', WIN, async () => {
  const found = fakeVortex();
  const chosen = fakeVortex();
  let setting = chosen.exe;
  const b = bridge({ [`HKLM\\${UNINSTALL}|DisplayIcon`]: found.exe }, { getExe: () => setting });
  await b.findExe();
  assert.deepStrictEqual(b.exeInfo(), { exe: chosen.exe, source: 'manual', chosenMissing: false });
  setting = fakeVortex('Other.exe').exe;
  assert.deepStrictEqual(b.exeInfo(), { exe: found.exe, source: 'found', chosenMissing: true });
  setting = path.join(chosen.dir, 'gone', 'Vortex.exe');
  assert.deepStrictEqual(b.exeInfo(), { exe: found.exe, source: 'found', chosenMissing: true }, 'Settings says the chosen one is gone');
});

test('Linux: Vortex is a Windows program, so nothing is looked up and none is used', async () => {
  const b = bridge({ [`HKLM\\${UNINSTALL}|DisplayIcon`]: 'C:\\Vortex\\Vortex.exe' }, { platform: 'linux', getExe: () => 'C:\\Vortex\\Vortex.exe' });
  assert.strictEqual(await b.findExe(), '');
  assert.deepStrictEqual(b.asked, []);
  assert.deepStrictEqual(b.exeInfo(), { exe: '', source: '', chosenMissing: false });
});

test('Settings takes only a drive path to an existing Vortex.exe (it is run), and an empty one to find it again', WIN, () => {
  const s = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-vxset-')), null);
  assert.strictEqual(s.get('vortexExe'), '');
  const { exe, dir } = fakeVortex();
  s.update({ vortexExe: `  ${exe}  ` });
  assert.strictEqual(s.get('vortexExe'), exe);
  const bad = fakeVortex('evil.exe');
  assert.throws(() => s.update({ vortexExe: bad.exe }), /Vortex\.exe/);
  assert.throws(() => s.update({ vortexExe: 'Vortex.exe' }), /Vortex\.exe/);
  assert.throws(() => s.update({ vortexExe: '\\\\server\\share\\Vortex.exe' }), /Vortex\.exe/, 'not from a network share');
  assert.throws(() => s.update({ vortexExe: path.join(dir, 'nope', 'Vortex.exe') }), /no Vortex\.exe/);
  assert.strictEqual(s.get('vortexExe'), exe, 'a refused one leaves the setting as it was');
  // Vortex moved or uninstalled after it was chosen: saving any other setting still works (the old path comes back with every Save).
  fs.rmSync(exe);
  s.update({ vortexExe: exe, concurrentDownloads: 3 });
  assert.strictEqual(s.get('concurrentDownloads'), 3);
  s.update({ vortexExe: '' });
  assert.strictEqual(s.get('vortexExe'), '');
});

test('Settings on Linux: an empty Vortex.exe (the hidden box) saves fine', () => {
  const s = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-vxset-')), null);
  s.update({ vortexExe: '', concurrentDownloads: 2 });
  assert.strictEqual(s.get('vortexExe'), '');
});
