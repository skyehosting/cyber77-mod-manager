'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { protontricksLaunch } = require('../src/core/wine');
const { linuxDeployFiles, deployRedmods, redmodFolders, DEPLOY_BAT } = require('../src/core/launcher');
const { linuxLaunchOptions, setsTimezone } = require('../src/core/gameFinder');

/* Linux: REDmod deploy through protontricks inside the game's Proton folder; the time-zone crash fix. */

async function asLinux(fn) {
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', plat); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-redmod-'));

/** A game folder with the REDmod tools and one REDmod, and a Proton folder with drive_c. */
function gameAndPrefix() {
  const root = tmp();
  const game = path.join(root, 'Cyberpunk 2077');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), '');
  fs.mkdirSync(path.join(game, 'tools', 'redmod', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(game, 'tools', 'redmod', 'bin', 'redMod.exe'), '');
  fs.mkdirSync(path.join(game, 'mods', 'MyRedmod'), { recursive: true });
  fs.writeFileSync(path.join(game, 'mods', 'MyRedmod', 'info.json'), '{"name":"MyRedmod"}');
  const prefix = path.join(root, 'compatdata', '1091500', 'pfx');
  fs.mkdirSync(path.join(prefix, 'drive_c'), { recursive: true });
  return { root, game, prefix };
}

test('protontricks-launch: the installed one, else the Flatpak\'s, else none', () => {
  const root = tmp();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  assert.strictEqual(protontricksLaunch(1091500, '/x.bat', ['deploy'], { home: root, pathEnv: bin }), null);
  // The Flatpak needs both flatpak itself and the app.
  fs.mkdirSync(path.join(root, '.local', 'share', 'flatpak', 'app', 'com.github.Matoking.protontricks'), { recursive: true });
  assert.strictEqual(protontricksLaunch(1091500, '/x.bat', [], { home: root, pathEnv: bin }), null, 'no flatpak program');
  fs.writeFileSync(path.join(bin, 'flatpak'), '');
  assert.deepStrictEqual(protontricksLaunch(1091500, '/x.bat', ['deploy'], { home: root, pathEnv: bin }), {
    file: path.join(bin, 'flatpak'),
    args: ['run', '--command=protontricks-launch', 'com.github.Matoking.protontricks', '--appid', '1091500', '/x.bat', 'deploy'],
    via: 'protontricks (Flatpak)',
  });
  fs.writeFileSync(path.join(bin, 'protontricks-launch'), '');
  assert.deepStrictEqual(protontricksLaunch(1091500, '/x.bat', ['deploy'], { home: root, pathEnv: bin }),
    { file: path.join(bin, 'protontricks-launch'), args: ['--appid', '1091500', '/x.bat', 'deploy'], via: 'protontricks' }, 'the installed one first');
  // A folder named so, or a relative PATH entry, is not the program.
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(other, 'protontricks-launch'), { recursive: true });
  assert.strictEqual(protontricksLaunch(1091500, '/x.bat', [], { home: tmp(), pathEnv: [other, 'bin'].join(path.delimiter) }), null);
});

test('the batch file goes into drive_c with CRLF; Vortex\'s REDmod order goes along, CRLF too', async () => {
  const { game, prefix } = gameAndPrefix();
  await asLinux(() => {
    let put = linuxDeployFiles(game, prefix);
    assert.strictEqual(put.bat, path.join(prefix, 'drive_c', 'cmm-redmod-deploy.bat'));
    assert.deepStrictEqual(put.args, ['deploy', '-reportProgress']);
    const bat = fs.readFileSync(put.bat, 'utf8');
    assert.strictEqual(bat, DEPLOY_BAT);
    assert.ok(!/[^\r]\n/.test(bat), 'every line ends CRLF');
    assert.match(bat, /cd \/d "%STEAM_APP_PATH%"\r\ncd tools\\redmod\\bin\r\n/);
    assert.match(bat, /^redMod\.exe %\*\r$/m);
    assert.ok(!/pause/i.test(bat), 'nothing waits for a key: no one could press it');
    assert.ok(fs.statSync(path.join(game, 'r6', 'cache', 'modded')).isDirectory(), 'REDmod stops without the folder it deploys into');
    // Vortex's order: copied CRLF, without blank lines.
    fs.mkdirSync(path.join(game, 'V2077'));
    fs.writeFileSync(path.join(game, 'V2077', 'modlist.txt'), 'B\nA\n\n');
    put = linuxDeployFiles(game, prefix);
    assert.deepStrictEqual(put.args, ['deploy', '-reportProgress', '-modlist=C:\\cmm-redmod-modlist.txt']);
    assert.strictEqual(fs.readFileSync(path.join(prefix, 'drive_c', 'cmm-redmod-modlist.txt'), 'utf8'), 'B\r\nA');
    // The order gone: the old copy is not used.
    fs.rmSync(path.join(game, 'V2077'), { recursive: true });
    put = linuxDeployFiles(game, prefix);
    assert.ok(!fs.existsSync(path.join(prefix, 'drive_c', 'cmm-redmod-modlist.txt')));
  });
});

test('a link left at the batch file\'s name is replaced, never written through', { skip: process.platform === 'win32' && 'needs symlinks without admin rights' }, async () => {
  const { game, prefix } = gameAndPrefix();
  const elsewhere = path.join(tmp(), 'victim.txt');
  fs.writeFileSync(elsewhere, 'keep');
  fs.symlinkSync(elsewhere, path.join(prefix, 'drive_c', 'cmm-redmod-deploy.bat'));
  await asLinux(() => linuxDeployFiles(game, prefix));
  assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), 'keep');
  assert.ok(!fs.lstatSync(path.join(prefix, 'drive_c', 'cmm-redmod-deploy.bat')).isSymbolicLink());
});

test('REDmod deploy on Linux runs through the given launcher, with the batch file and redMod.exe\'s arguments', async () => {
  const { game, prefix } = gameAndPrefix();
  const script = path.join(tmp(), 'fake-launch.js');
  // Stands in for protontricks-launch: prints what it got and exits with the code asked for.
  fs.writeFileSync(script, 'console.log("got " + process.argv.slice(2).join(" | ")); process.exit(process.argv.includes("--fail") ? 3 : 0);');
  const seen = [];
  await asLinux(async () => {
    const launch = extra => (target, args) => ({ file: process.execPath, args: [script, target, ...args, ...extra] });
    let res = await deployRedmods(game, { linux: { prefix, launch: launch([]) }, onLine: l => seen.push(l) });
    assert.strictEqual(res.ok, true);
    assert.match(seen.join('\n'), new RegExp(`got ${path.join(prefix, 'drive_c', 'cmm-redmod-deploy.bat').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} \\| deploy \\| -reportProgress`));
    res = await deployRedmods(game, { linux: { prefix, launch: launch(['--fail']) } });
    assert.strictEqual(res.ok, false, 'a failed run is a failed deploy');
    // No Proton folder known: a failure that says why, nothing run.
    res = await deployRedmods(game, { linux: null });
    assert.strictEqual(res.ok, false);
    assert.match(res.lines[0], /Proton folder/);
  });
});

test('a deploy whose launcher left a program holding its output open still ends (Wine\'s wineserver)', async () => {
  const { game, prefix } = gameAndPrefix();
  const script = path.join(tmp(), 'leaves-one.js');
  // Starts a program that keeps the output open for a minute, then ends at once.
  fs.writeFileSync(script, 'const { spawn } = require("child_process"); spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit", detached: true }).unref(); console.log("deployed");');
  const started = Date.now();
  const res = await asLinux(() => deployRedmods(game, { linux: { prefix, launch: () => ({ file: process.execPath, args: [script] }) } }));
  assert.strictEqual(res.ok, true);
  assert.ok(Date.now() - started < 15000, `ended after ${Date.now() - started} ms`);
});

test('REDmods are found whatever the case of mods/ and info.json (Linux)', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'Mods', 'A'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Mods', 'A', 'Info.JSON'), '{}');
  fs.mkdirSync(path.join(root, 'Mods', 'NotOne'), { recursive: true });
  await asLinux(() => assert.deepStrictEqual(redmodFolders(root), ['A']));
});

test('the time-zone fix: TZ=UTC goes before %command%, once; a line that sets a time zone keeps it', () => {
  assert.strictEqual(setsTimezone('TZ=UTC %command%'), true);
  assert.strictEqual(setsTimezone('TZ=America/Los_Angeles WINEDLLOVERRIDES="winmm=n,b" %command% -modded'), true);
  assert.strictEqual(setsTimezone('%command% TZ=UTC'), false, 'after %command% it is an argument to the game');
  assert.strictEqual(setsTimezone('TZ= %command%'), false);
  assert.strictEqual(setsTimezone(''), false);
  const r = linuxLaunchOptions('WINEDLLOVERRIDES="winmm=n,b" %command% --launcher-skip -modded', { dlls: ['winmm'], tz: 'UTC' });
  assert.deepStrictEqual(r.missing, ['TZ=UTC']);
  assert.strictEqual(r.suggested, 'WINEDLLOVERRIDES="winmm=n,b" TZ=UTC %command% --launcher-skip -modded');
  const kept = linuxLaunchOptions('TZ=Europe/Berlin WINEDLLOVERRIDES="winmm=n,b" %command% --launcher-skip -modded', { dlls: ['winmm'], tz: 'UTC' });
  assert.deepStrictEqual(kept.missing, []);
  assert.strictEqual(kept.suggested, 'TZ=Europe/Berlin WINEDLLOVERRIDES="winmm=n,b" %command% --launcher-skip -modded');
  // Without tz asked for, nothing about it (Play's own check never needs one).
  assert.deepStrictEqual(linuxLaunchOptions('WINEDLLOVERRIDES="winmm=n,b" %command% --launcher-skip -modded', { dlls: ['winmm'] }).missing, []);
  // From nothing: everything, the time zone included.
  assert.strictEqual(linuxLaunchOptions('', { dlls: ['winmm', 'version'], tz: 'UTC' }).suggested, 'WINEDLLOVERRIDES="winmm,version=n,b" TZ=UTC %command% --launcher-skip -modded');
});
