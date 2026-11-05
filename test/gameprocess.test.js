'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findGameProcess, isGameProcess, isGameArg } = require('../src/core/gameProcess');

/*
 * Finding the running game on Linux, on a made-up /proc with the processes a real Steam + Proton launch
 * had in an Ubuntu 26.04 VM (the Linux port audit, 19.3d). Runs on Windows too.
 */

const proc = list => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-proc-'));
  for (const [pid, argv] of Object.entries(list)) {
    fs.mkdirSync(path.join(dir, pid));
    fs.writeFileSync(path.join(dir, pid, 'cmdline'), `${argv.join('\0')}\0`);
  }
  fs.mkdirSync(path.join(dir, 'self')); // not a process number
  fs.writeFileSync(path.join(dir, 'self', 'cmdline'), 'S:\\Cyberpunk2077.exe\0');
  return dir;
};
async function asLinux(fn) {
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', plat); }
}

const STEAM = '/home/raven/.local/share/Steam';
const launch = {
  25837: [`${STEAM}/ubuntu12_32/reaper`, 'SteamLaunch', 'AppId=1091500', '--', `${STEAM}/steamapps/common/Cyberpunk 2077/REDprelauncher.exe`],
  25918: ['python3', `${STEAM}/steamapps/common/Proton - Experimental/proton`, 'waitforexitandrun', `${STEAM}/steamapps/common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe`],
  25920: ['c:\\windows\\system32\\steam.exe', `${STEAM}/steamapps/common/Cyberpunk 2077/REDprelauncher.exe`],
  2001: ['/usr/bin/gnome-shell'],
};

test('the game\'s first argument names it, in either kind of path and any case', () => {
  assert.ok(isGameArg('S:\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe'));
  assert.ok(isGameArg('/home/u/Games/cyberpunk/bin/x64/CYBERPUNK2077.EXE'));
  assert.ok(!isGameArg('C:\\windows\\system32\\steam.exe'));
  assert.ok(!isGameArg('Cyberpunk2077.exe.bak'));
});

test('on Linux the running game is found in /proc by its first argument only', async () => {
  await asLinux(async () => {
    const before = proc(launch);
    assert.strictEqual(await findGameProcess({ procDir: before }), null, 'Proton and Steam name the game further along: not the game');
    const running = proc({ ...launch, 26271: ['S:\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe'] });
    assert.deepStrictEqual(await findGameProcess({ procDir: running }), { pid: 26271 });
    assert.strictEqual(await isGameProcess(26271, { procDir: running }), true);
    assert.strictEqual(await isGameProcess(25920, { procDir: running }), false);
    assert.strictEqual(await isGameProcess(99999, { procDir: running }), false, 'gone');
    // Many processes: still found (read in batches).
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [String(3000 + i), ['/usr/bin/x']]));
    assert.deepStrictEqual(await findGameProcess({ procDir: proc({ ...many, 3301: ['C:\\GOG Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe'] }) }), { pid: 3301 });
    await assert.rejects(findGameProcess({ procDir: path.join(before, 'missing') }), 'no /proc: it cannot tell');
  });
});

test('a known game process is checked alone, and a full look follows once it is gone', async () => {
  await asLinux(async () => {
    const dir = proc({ ...launch, 26271: ['S:\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe'] });
    assert.deepStrictEqual(await findGameProcess({ procDir: dir, known: 26271 }), { pid: 26271 });
    fs.rmSync(path.join(dir, '26271'), { recursive: true });
    assert.strictEqual(await findGameProcess({ procDir: dir, known: 26271 }), null, 'gone: a full look finds nothing');
  });
});
