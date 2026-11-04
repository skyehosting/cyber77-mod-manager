'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const finder = require('../src/core/gameFinder');
const wine = require('../src/core/wine');

/*
 * Linux detection, on made-up folders (runs on Windows too: the Linux code only joins paths). Steam's
 * layout as seen in a real Ubuntu 26.04 VM (the Linux port audit, 19.3c/19.3d).
 */

const put = (p, text = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const link = (target, at) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, 'junction'); };
const vdf = libs => `"libraryfolders"\n{\n${libs.map((l, i) => `\t"${i}"\n\t{\n\t\t"path"\t\t"${l.path.replace(/\\/g, '\\\\')}"\n${l.mounted === false ? '\t\t"mounted"\t\t"0"\n' : ''}\t\t"apps"\n\t\t{\n\t\t}\n\t}\n`).join('')}}\n`;
const acf = (flags, extra = '') => `"AppState"\n{\n\t"appid"\t\t"1091500"\n\t"StateFlags"\t\t"${flags}"\n\t"installdir"\t\t"Cyberpunk 2077"\n${extra}}\n`;
const game = lib => { put(path.join(lib, 'steamapps', 'common', 'Cyberpunk 2077', 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe'); return path.join(lib, 'steamapps', 'common', 'Cyberpunk 2077'); };
const prefix = (lib, user = 'steamuser') => {
  const pfx = path.join(lib, 'steamapps', 'compatdata', '1091500', 'pfx');
  put(path.join(pfx, 'user.reg'), 'WINE REGISTRY');
  fs.mkdirSync(path.join(pfx, 'drive_c', 'users', user, 'Saved Games', 'CD Projekt Red', 'Cyberpunk 2077'), { recursive: true });
  fs.mkdirSync(path.join(pfx, 'drive_c', 'users', 'Public'), { recursive: true });
  put(path.join(path.dirname(pfx), 'pfx.lock'));
  return pfx;
};

/** As on Linux for the length of fn (platform checks only; paths stay this OS's). */
async function asLinux(home, fn) {
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  const before = { home: process.env.CMM_LINUX_HOME, saves: process.env.CMM_SAVES_DIR };
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env.CMM_LINUX_HOME = home;
  delete process.env.CMM_SAVES_DIR;
  try { return await fn(); } finally {
    Object.defineProperty(process, 'platform', plat);
    for (const [k, v] of [['CMM_LINUX_HOME', before.home], ['CMM_SAVES_DIR', before.saves]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function steamHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-linux-'));
  const home = path.join(root, 'home');
  const steam = path.join(home, '.local', 'share', 'Steam');
  const card = path.join(root, 'media', 'deck', 'SD', 'SteamLibrary');
  fs.mkdirSync(path.join(card, 'steamapps'), { recursive: true });
  put(path.join(steam, 'steamapps', 'libraryfolders.vdf'), vdf([{ path: steam }, { path: card }, { path: path.join(root, 'gone'), mounted: false }]));
  put(path.join(steam, 'config', 'libraryfolders.vdf'), vdf([{ path: steam }, { path: card }]));
  link(steam, path.join(home, '.steam', 'steam')); // as Steam's own steam.sh makes them
  link(steam, path.join(home, '.steam', 'root'));
  return { root, home, steam, card };
}

test('library lists: both formats, unmounted libraries left out', () => {
  assert.deepStrictEqual(finder.parseLibraryFolders(vdf([{ path: '/home/u/.local/share/Steam' }, { path: '/mnt/games', mounted: false }, { path: '/run/media/u/SD/SteamLibrary' }])),
    ['/home/u/.local/share/Steam', '/run/media/u/SD/SteamLibrary']);
  assert.deepStrictEqual(finder.parseLibraryFolders('"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t\t"1"\n\t"1"\t\t"/mnt/games/SteamLibrary"\n}\n'), ['/mnt/games/SteamLibrary']);
});

test('Steam on Linux: one root despite its links, every library, the game installed or still installing', () => {
  const { home, steam, card } = steamHome();
  assert.deepStrictEqual(finder.linuxSteamRoots(home).map(r => r.dir), [fs.realpathSync(steam)], '~/.steam/steam and ~/.steam/root are the same Steam');
  assert.deepStrictEqual(finder.linuxSteamLibraries(home).map(l => l.dir), [fs.realpathSync(steam), fs.realpathSync(card)]);

  // Installed on the SD card; still downloading in the main library (its folder empty so far).
  const dir = game(card);
  put(path.join(card, 'steamapps', 'appmanifest_1091500.acf'), acf(4));
  put(path.join(steam, 'steamapps', 'appmanifest_1091500.acf'), acf(1042, '\t"BytesToDownload"\t\t"1000"\n\t"BytesDownloaded"\t\t"370"\n'));
  fs.mkdirSync(path.join(steam, 'steamapps', 'common', 'Cyberpunk 2077'), { recursive: true });
  const games = finder.linuxSteamGames(home);
  assert.deepStrictEqual(games.map(g => [g.installed, g.progress]), [[false, 0.37], [true, 1]]);
  assert.strictEqual(games[1].path, fs.realpathSync(dir));
});

test('a Flatpak Steam\'s library paths are read as the Flatpak sees them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-linux-'));
  const home = path.join(root, 'home');
  const sandbox = path.join(home, '.var', 'app', 'com.valvesoftware.Steam');
  const steam = path.join(sandbox, '.local', 'share', 'Steam');
  fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
  // Inside the Flatpak, its home is the user's home path: ~/.local/share/Steam there is ~/.var/app/… here.
  put(path.join(steam, 'steamapps', 'libraryfolders.vdf'), vdf([{ path: path.join(home, '.local', 'share', 'Steam') }]));
  const roots = finder.linuxSteamRoots(home);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0].sandboxHome, fs.realpathSync(sandbox));
  assert.deepStrictEqual(finder.linuxSteamLibraries(home).map(l => l.dir), [fs.realpathSync(steam)]);
});

test('the game\'s Proton folder: its own library first, else another (an SD card), else the one used last', () => {
  const { steam, card } = steamHome();
  const dir = game(card);
  const libs = [steam, card];
  assert.strictEqual(wine.steamPrefix(dir, libs, '1091500'), '', 'none before the first launch');
  const internal = prefix(steam);
  assert.strictEqual(wine.steamPrefix(dir, libs, '1091500'), internal, 'game on the card, its prefix on the internal drive');
  const own = prefix(card);
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(path.dirname(own), 'pfx.lock'), old, old);
  assert.strictEqual(wine.steamPrefix(dir, libs, '1091500'), own, 'the game\'s own library wins');
  fs.rmSync(path.dirname(own), { recursive: true });
  const other = path.join(card, '..', 'Other');
  const third = prefix(other);
  fs.utimesSync(path.join(path.dirname(internal), 'pfx.lock'), old, old);
  assert.strictEqual(wine.steamPrefix(dir, [steam, other], '1091500'), third, 'else the one launched last');
});

test('inside a prefix: Proton\'s steamuser, Wine\'s user, the saves and crash folders; a game inside drive_c', () => {
  const { steam } = steamHome();
  const pfx = prefix(steam);
  const f = wine.prefixFolders(pfx);
  assert.strictEqual(f.user, 'steamuser');
  assert.strictEqual(f.saves, path.join(pfx, 'drive_c', 'users', 'steamuser', 'Saved Games', 'CD Projekt Red', 'Cyberpunk 2077'));
  assert.strictEqual(f.crashDir, path.join(pfx, 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'REDEngine', 'ReportQueue'));
  // Plain Wine (Lutris, an offline installer): the Linux user's name.
  const wpfx = path.join(path.dirname(steam), 'wine');
  put(path.join(wpfx, 'system.reg'));
  fs.mkdirSync(path.join(wpfx, 'drive_c', 'users', 'Public'), { recursive: true });
  fs.mkdirSync(path.join(wpfx, 'drive_c', 'users', 'v'), { recursive: true });
  assert.strictEqual(wine.prefixUser(wpfx, 'v'), 'v');
  assert.strictEqual(wine.prefixUser(wpfx, 'someone-else'), 'v', 'else whoever is there (not Public)');
  const gog = path.join(wpfx, 'drive_c', 'GOG Games', 'Cyberpunk 2077');
  fs.mkdirSync(gog, { recursive: true });
  assert.strictEqual(wine.prefixFromPath(gog), wpfx);
  assert.strictEqual(wine.prefixFromPath(path.join(steam, 'steamapps', 'common', 'Cyberpunk 2077')), '', 'not inside a prefix');
  assert.strictEqual(wine.prefixFolders(path.join(steam, 'nothing')), null);
});

test('on Linux the app finds the game, its saves and crash reports from the game folder alone', async () => {
  const { home, steam } = steamHome();
  const dir = game(steam);
  put(path.join(steam, 'steamapps', 'appmanifest_1091500.acf'), acf(4));
  await asLinux(home, async () => {
    const installs = await finder.findInstalls();
    assert.deepStrictEqual(installs.map(i => [i.store, i.path]), [['steam', fs.realpathSync(dir)]]);
    assert.strictEqual(finder.gameWindowsFolders(dir), null, 'not launched yet: no prefix');
    const pfx = prefix(steam);
    assert.strictEqual(finder.gameWindowsFolders(dir).saves, path.join(pfx, 'drive_c', 'users', 'steamuser', 'Saved Games', 'CD Projekt Red', 'Cyberpunk 2077'));
    assert.deepStrictEqual(finder.installingNow(), []);
  });
});

test('on Linux an unknown save folder is never a relative path: reading finds nothing, writing refuses', async () => {
  const { home, steam, root } = steamHome();
  const dir = game(steam);
  const { Settings } = require('../src/core/settings');
  const { ModManager } = require('../src/core/manager');
  const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
  await asLinux(home, async () => {
    const saves = require('../src/core/saves');
    assert.strictEqual(saves.defaultSavesDir(), '', 'no Windows user folder to build one from');
    assert.ok(path.isAbsolute(saves.appSavesHome()) && saves.appSavesHome().endsWith(path.join('.local', 'share', 'Edgerunners Mod Manager')) || !!process.env.XDG_DATA_HOME);
    const settings = new Settings(path.join(root, 'ud'), null);
    settings.update({ gamePath: dir });
    const mgr = new ModManager({ settings, log: quiet });
    assert.strictEqual(mgr.gameSavesDir(), '');
    assert.strictEqual(mgr.crashDir(), '');
    assert.deepStrictEqual(mgr.savesView().saves, []);
    await assert.rejects(mgr.saves.restore('2026-01-01/00-00-00 Manual'), /save folder is not known yet/);
    const other = path.join(root, 'other profile');
    put(path.join(other, 'ManualSave-1', 'sav.dat'), 'save');
    put(path.join(other, 'ManualSave-1', 'metadata.9.json'), JSON.stringify({ Data: { metadata: { playthroughID: 'aaaa', level: 5 } } }));
    await assert.rejects(mgr.profileSaves.copySaves(other, () => true, mgr.gameSavesDir()), /save folder is not known yet/);
    await assert.rejects(mgr.profileSaves.swap('a', 'b'), /save folder is not known yet/);
    // Launched once: Proton made the prefix, and the saves are there.
    const pfx = prefix(steam);
    mgr.foldersCache = null;
    const live = path.join(pfx, 'drive_c', 'users', 'steamuser', 'Saved Games', 'CD Projekt Red', 'Cyberpunk 2077');
    assert.strictEqual(mgr.gameSavesDir(), live);
    assert.strictEqual(mgr.crashDir(), path.join(pfx, 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'REDEngine', 'ReportQueue'));
    assert.strictEqual(mgr.savesView().savesDir, live);
  });
});

test('review fixes: no Steam saves for a game outside Steam, a manifest cannot point out of its library, a huge library list stays quick', async () => {
  const { home, steam, root } = steamHome();
  prefix(steam); // the Steam copy was launched
  const heroic = path.join(home, 'Games', 'Heroic', 'Cyberpunk 2077');
  put(path.join(heroic, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  await asLinux(home, async () => {
    assert.strictEqual(finder.gameWindowsFolders(heroic), null, 'a GOG/Heroic copy never gets the Steam copy\'s prefix');
    assert.ok(finder.gameWindowsFolders(game(steam)), 'the Steam copy does');
  });
  const escape = path.join(root, 'elsewhere');
  put(path.join(escape, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  put(path.join(steam, 'steamapps', 'appmanifest_1091500.acf'), acf(4).replace('"Cyberpunk 2077"', '"../../../elsewhere"'));
  assert.ok(finder.linuxSteamGames(home).every(g => g.path.startsWith(fs.realpathSync(steam))), 'installdir is a folder name only');
  const t = Date.now();
  finder.parseLibraryFolders('\n'.repeat(200000));
  assert.ok(Date.now() - t < 500, 'blank lines do not slow the old-format pattern down');
});

test('on Linux, backups are refused in system folders, Proton folders and the home folder itself', async () => {
  const { home, steam } = steamHome();
  const { backupDirProblem } = require('../src/core/saves');
  await asLinux(home, async () => {
    if (path.sep === '/') {
      assert.match(backupDirProblem('/usr/share/backups', ''), /system folder/);
      assert.match(backupDirProblem(os.homedir(), ''), /home folder itself/);
    }
    assert.match(backupDirProblem(path.join(steam, 'steamapps', 'compatdata', '1091500', 'backups'), ''), /Proton or Wine/);
    assert.strictEqual(backupDirProblem(path.join(home, 'Backups', 'Cyberpunk'), ''), '');
  });
});
