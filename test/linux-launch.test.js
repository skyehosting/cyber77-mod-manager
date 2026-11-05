'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { linuxLaunchOptions, parseDllOverrides } = require('../src/core/gameFinder');
const { launchGame } = require('../src/core/launcher');

/* Play on Linux: always through Steam (Proton), and the launch options the mods need there. */

async function asLinux(fn) {
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', plat); }
}
const gameDir = () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-launch-')), 'Cyberpunk 2077');
  fs.mkdirSync(path.join(dir, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  return dir;
};

test('on Linux Play opens the game through Steam, never runs the .exe; other copies are told to use their launcher', async () => {
  await asLinux(async () => {
    const dir = gameDir();
    const opened = [];
    const run = () => { throw new Error('the Windows program must not be run'); };
    for (const mode of ['direct', 'steam']) {
      const r = await launchGame({ gameDir: dir, store: 'steam', mode }, async u => opened.push(u), run);
      assert.strictEqual(r.via, 'Steam');
    }
    assert.deepStrictEqual(opened, ['steam://rungameid/1091500', 'steam://rungameid/1091500']);
    await assert.rejects(launchGame({ gameDir: dir, store: 'custom' }, async u => opened.push(u), run), /Heroic, Lutris/);
    const { Settings } = require('../src/core/settings');
    const s = new Settings(path.join(path.dirname(dir), 'ud'), null);
    s.update({ launchMode: 'direct' });
    assert.strictEqual(s.get('launchMode'), 'steam', 'nothing else can start it on Linux');
  });
});

test('Wine DLL overrides are read by meaning, whatever the form', () => {
  assert.deepStrictEqual(parseDllOverrides('"winmm,version=n,b"'), { winmm: 'n,b', version: 'n,b' });
  assert.deepStrictEqual(parseDllOverrides('winmm=n,b;version=n,b;dxgi=n'), { winmm: 'n,b', version: 'n,b', dxgi: 'n' });
  assert.deepStrictEqual(parseDllOverrides('version.dll=native,builtin'), { version: 'native,builtin' });
  for (const junk of ['', '=;;=,', null, '"', 'no-equals']) assert.deepStrictEqual(parseDllOverrides(junk), {}, String(junk));
});

test('the launch options line on Linux: what is missing, and a line that keeps what is there', () => {
  const both = { dlls: ['winmm', 'version'] };
  const cases = [
    ['', 'WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 3],
    ['--launcher-skip -modded', 'WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 1],
    ['WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 'WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 0],
    ['WINEDLLOVERRIDES="winmm=n,b;version=n,b" %command% --launcher-skip -modded', 'WINEDLLOVERRIDES="winmm=n,b;version=n,b" %command% --launcher-skip -modded', 0],
    // Another mod's override (OptiScaler) is kept.
    ['WINEDLLOVERRIDES=dxgi=n,b %command% --launcher-skip', 'WINEDLLOVERRIDES="dxgi,winmm,version=n,b" %command% --launcher-skip -modded', 2],
    // Given twice: the shell keeps the last; merged into one.
    ['WINEDLLOVERRIDES="winmm=n,b" WINEDLLOVERRIDES="version=n,b" %command% --launcher-skip -modded', 'WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 1],
    ['WINEDLLOVERRIDES="winmm=n,b" WINEDLLOVERRIDES="winmm=b;version=n,b" %command% --launcher-skip -modded', 'WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 1],
    // Lines it cannot safely edit get a clean one: an unclosed quote, %command% inside quotes or spelt otherwise.
    ['WINEDLLOVERRIDES="winmm=n,b %command% -x', 'WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 3],
    ['sh -c "%command%"', 'WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 3],
    ['WINEDLLOVERRIDES="winmm,version=n,b" %COMMAND% --launcher-skip -modded', 'WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 3],
    ['WINEDLLOVERRIDES="winmm,version=n,b"; %command% --launcher-skip -modded', 'WINEDLLOVERRIDES="winmm,version=n,b" %command% --launcher-skip -modded', 3],
    // A lower-case name sets nothing on Linux.
    ['winedlloverrides="winmm,version=n,b" %command% --launcher-skip -modded', 'WINEDLLOVERRIDES="winmm,version=n,b" winedlloverrides="winmm,version=n,b" %command% --launcher-skip -modded', 1],
    // Settings go before a wrapper program.
    ['gamemoderun %command%', 'WINEDLLOVERRIDES="winmm,version=n,b" gamemoderun %command% --launcher-skip -modded', 3],
    // Builtin first is not enough: the mod's DLL must win.
    ['WINEDLLOVERRIDES=version=b,n %command% --launcher-skip -modded', 'WINEDLLOVERRIDES="version,winmm=n,b" %command% --launcher-skip -modded', 1],
  ];
  for (const [current, suggested, n] of cases) {
    const r = linuxLaunchOptions(current, both);
    assert.strictEqual(r.missing.length, n, current);
    assert.strictEqual(r.suggested, suggested, current);
  }
  assert.match(linuxLaunchOptions('', { dlls: ['version'] }).missing[0], /Wine setting for Cyber Engine Tweaks/);
  assert.deepStrictEqual(linuxLaunchOptions('--launcher-skip', { dlls: [], modded: false }), { missing: [], suggested: '--launcher-skip', wine: false }, 'no mod loaders: no Wine setting asked for');
  assert.strictEqual(linuxLaunchOptions('WINEDLLOVERRIDES="winmm,version=n,b" %command%', both).wine, false, 'only --launcher-skip and -modded lack: no Wine note');
  assert.doesNotThrow(() => linuxLaunchOptions('"unterminated WINEDLLOVERRIDES=', both));
});
