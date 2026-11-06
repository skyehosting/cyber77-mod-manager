'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

/** A game folder, saves (two playthroughs) and two profiles, all in a temp folder of their own. */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-psaves-'));
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  const saves = path.join(root, 'saves');
  const save = (dir, name, pt, text = `save ${name}`) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'sav.dat'), text);
    fs.writeFileSync(path.join(dir, name, 'metadata.9.json'), JSON.stringify({ Data: { metadata: { playthroughID: pt, level: 5 } } }));
  };
  save(saves, 'ManualSave-1', 'aaaa');
  save(saves, 'AutoSave-0', 'aaaa');
  save(saves, 'QuickSave-0', 'bbbb');
  fs.writeFileSync(path.join(saves, 'user.gls'), 'sign-in token');
  const settings = new Settings(path.join(root, 'ud'), null);
  settings.update({ gamePath: game, saveBackupDir: path.join(root, 'backups') });
  const mgr = new ModManager({ settings, log: quiet });
  mgr.saves.savesDir = () => saves;
  mgr.profileSaves.root = () => path.join(root, 'profile saves');
  mgr.trash.root = () => path.join(root, 'trash');
  mgr.data.profiles.list.p2 = { id: 'p2', name: 'Photo mode', enabled: [], created: Date.now() };
  const first = mgr.data.profiles.active;
  return { mgr, saves, root, first, save };
}
const slots = dir => { try { return fs.readdirSync(dir).filter(n => /-\d+$/.test(n)).sort(); } catch { return []; } };

test('each profile has its own saves: they move out and in at a switch, with a backup first', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  assert.strictEqual(mgr.savesOwner(), first);
  await mgr.switchProfile('p2');
  assert.deepStrictEqual(slots(saves), [], 'the new profile starts with no saves');
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf(first)), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0'], 'the first profile\'s saves wait in its folder');
  assert.ok(fs.existsSync(path.join(saves, 'user.gls')), 'the files beside the saves never move');
  assert.ok(JSON.parse(fs.readFileSync(path.join(mgr.profileSaves.dirOf(first), 'profile.json'), 'utf8')).profile, 'the folder says whose it is');
  assert.ok(mgr.saves.list().some(b => b.reason === 'switch'), 'a backup before the switch');
  await mgr.switchProfile(first);
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0'], 'back again');
  assert.strictEqual(fs.readFileSync(path.join(saves, 'ManualSave-1', 'sav.dat'), 'utf8'), 'save ManualSave-1');
});

test('no switch (and nothing moved) while the game runs', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  mgr.gameRunning = () => true;
  await assert.rejects(mgr.switchProfile('p2'), /Close Cyberpunk 2077 first/);
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
  assert.strictEqual(mgr.data.profiles.active, first);
});

test('a switch never deletes a save: one that looks like another profile\'s (a cloud copy) stays with the profile in use', async () => {
  const { mgr, saves, first, save } = setup();
  await mgr.setPerProfileSaves(true);
  await mgr.switchProfile('p2');
  save(saves, 'ManualSave-9', 'cccc', 'photo mode save'); // played in Photo mode
  // Steam Cloud brings the first profile's ManualSave-1 back, byte for byte.
  fs.cpSync(path.join(mgr.profileSaves.dirOf(first), 'ManualSave-1'), path.join(saves, 'ManualSave-1'), { recursive: true });
  await mgr.switchProfile(first);
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf('p2')), ['ManualSave-1', 'ManualSave-9'], 'kept (a duplicate at worst), never deleted');
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
});

test('"Copy my saves" then a switch keeps everything played since (new and changed saves)', async () => {
  const { mgr, saves, first, save } = setup();
  await mgr.setPerProfileSaves(true);
  save(saves, 'ManualSave-2', 'aaaa', 'new progress');
  fs.writeFileSync(path.join(saves, 'AutoSave-0', 'sav.dat'), 'autosave overwritten');
  await mgr.copyAllSaves(first, 'p2');
  await mgr.switchProfile('p2');
  const mine = mgr.profileSaves.dirOf(first);
  assert.deepStrictEqual(slots(mine), ['AutoSave-0', 'ManualSave-1', 'ManualSave-2', 'QuickSave-0'], 'the first profile keeps all its saves');
  assert.strictEqual(fs.readFileSync(path.join(mine, 'AutoSave-0', 'sav.dat'), 'utf8'), 'autosave overwritten');
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'ManualSave-2', 'QuickSave-0'], 'and the new profile has its copies');
});

test('"Copy here" into the profile in use survives the next switch', async () => {
  const { mgr, saves, first, save } = setup();
  await mgr.setPerProfileSaves(true);
  save(mgr.profileSaves.dirOf('p2'), 'ManualSave-7', 'dddd', 'photo mode character');
  await mgr.copyPlaythrough('dddd', 'p2', [first]);
  assert.ok(slots(saves).includes('ManualSave-7'));
  await mgr.switchProfile('p2');
  assert.ok(slots(mgr.profileSaves.dirOf(first)).includes('ManualSave-7'), 'the copy went out with the first profile');
});

test('a slot already in the leaving profile\'s folder is never overwritten: the incoming one gets a free number', async () => {
  const { mgr, saves, first, save } = setup();
  await mgr.setPerProfileSaves(true);
  save(mgr.profileSaves.dirOf(first), 'ManualSave-1', 'aaaa', 'a stale but unique copy');
  await mgr.switchProfile('p2');
  const mine = mgr.profileSaves.dirOf(first);
  const texts = slots(mine).map(n => fs.readFileSync(path.join(mine, n, 'sav.dat'), 'utf8')).sort();
  assert.deepStrictEqual(texts, ['a stale but unique copy', 'save AutoSave-0', 'save ManualSave-1', 'save QuickSave-0']);
  assert.deepStrictEqual(slots(saves), []);
});

test('a switch cut off half way (crash) is undone the next time, unless the new owner was already saved', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  // The moves happen, then the app dies before it records the new owner.
  await mgr.profileSaves.swap(first, 'p2');
  assert.deepStrictEqual(slots(saves), []);
  await mgr.recoverProfileSaves();
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0'], 'undone: the saves are back with their owner');
  assert.strictEqual(mgr.savesOwner(), first);
  // Same, but the owner was recorded: the switch stands.
  await mgr.profileSaves.swap(first, 'p2');
  mgr.data.profileSaves.owner = 'p2';
  await mgr.recoverProfileSaves();
  assert.deepStrictEqual(slots(saves), []);
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf(first)), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
  await mgr.switchProfile(first);
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
});

test('the game check runs again after the backup, right before anything moves', async () => {
  const { mgr, saves } = setup();
  await mgr.setPerProfileSaves(true);
  let calls = 0;
  mgr.gameRunning = async () => ++calls > 1; // started during the backup
  await assert.rejects(mgr.switchProfile('p2'), /Close Cyberpunk 2077 first/);
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
});

test('deleting a profile keeps its saves, in a folder of deleted profiles', async () => {
  const { mgr, first, save } = setup();
  await mgr.setPerProfileSaves(true);
  save(mgr.profileSaves.dirOf('p2'), 'ManualSave-3', 'eeee');
  const r = await mgr.deleteProfile('p2');
  assert.ok(r.savesKeptIn && slots(r.savesKeptIn).includes('ManualSave-3'), 'moved, not lost');
  assert.ok(!fs.existsSync(mgr.profileSaves.dirOf('p2')));
  // The profile whose saves are in the game's folder (feature off, then switched away) loses that role.
  await mgr.setPerProfileSaves(false);
  mgr.data.profiles.list.p3 = { id: 'p3', name: 'Third', enabled: [], created: Date.now() };
  await mgr.switchProfile('p3');
  await mgr.deleteProfile(first);
  assert.strictEqual(mgr.data.profileSaves.owner, undefined);
});

test('turning it on again after switching with it off: the saves belong to the profile in use, or the one chosen', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  await mgr.setPerProfileSaves(false);
  await mgr.switchProfile('p2');
  assert.strictEqual(mgr.savesView().perProfileWas, first, 'the page can ask whose they are');
  await mgr.setPerProfileSaves(true, { owner: first });
  assert.strictEqual(mgr.savesOwner(), 'p2', 'the first profile\'s saves were swapped out for the one in use');
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf(first)), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
  assert.deepStrictEqual(slots(saves), []);
  await mgr.setPerProfileSaves(false);
  await mgr.switchProfile(first);
  await mgr.setPerProfileSaves(true);
  assert.strictEqual(mgr.savesOwner(), first, 'no choice given: the profile in use');
});

test('profile ids are checked as the app\'s own (not Object built-ins)', async () => {
  const { mgr, first } = setup();
  await mgr.setPerProfileSaves(true);
  await assert.rejects(mgr.switchProfile('constructor'), /no longer exists/);
  assert.strictEqual((await mgr.copyPlaythrough('aaaa', first, ['constructor', 'toString'])).profiles, 0);
  assert.throws(() => mgr.profileSaveCount('valueOf'), /no longer exists/);
});

test('importing a profile with per-profile saves swaps the saves like a switch', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  mgr.profileImports.set('tok', { name: 'Shared build', rows: [] });
  const r = await mgr.applyProfileImport('tok', '');
  assert.strictEqual(mgr.savesOwner(), r.profile);
  assert.deepStrictEqual(slots(saves), []);
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf(first)), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
});

test('copying a playthrough to another profile; a taken slot name gets a new number', async () => {
  const { mgr, first, save } = setup();
  await mgr.setPerProfileSaves(true);
  save(mgr.profileSaves.dirOf('p2'), 'ManualSave-1', 'zzzz', 'photo mode\'s own manual save 1');
  const r = await mgr.copyPlaythrough('aaaa', first, ['p2']);
  assert.deepStrictEqual([r.copied, r.renamed], [2, 1]);
  const p2 = slots(mgr.profileSaves.dirOf('p2'));
  assert.deepStrictEqual(p2, ['AutoSave-0', 'ManualSave-1', 'ManualSave-2']);
  assert.strictEqual(fs.readFileSync(path.join(mgr.profileSaves.dirOf('p2'), 'ManualSave-1', 'sav.dat'), 'utf8'), 'photo mode\'s own manual save 1', 'its own save is untouched');
  assert.strictEqual(fs.readFileSync(path.join(mgr.profileSaves.dirOf('p2'), 'ManualSave-2', 'sav.dat'), 'utf8'), 'save ManualSave-1');
  assert.strictEqual(mgr.profileSaveCount('p2'), 3);
  // Copying the same again adds nothing new for identical slots.
  const again = await mgr.copyPlaythrough('aaaa', first, ['p2']);
  assert.deepStrictEqual([again.copied, again.renamed], [0, 0], 'copying the same again adds nothing');
  assert.strictEqual(mgr.profileSaveCount('p2'), 3);
});

test('a switch whose mods cannot be placed puts the saves back', async () => {
  const { mgr, saves } = setup();
  await mgr.setPerProfileSaves(true);
  mgr.deploy = () => { throw new Error('a file is locked'); };
  await assert.rejects(mgr.switchProfile('p2'), /locked/);
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0'], 'the saves are back where they were');
  assert.strictEqual(mgr.savesOwner(), mgr.data.profiles.active);
});

test('turned off: switching leaves the saves alone', async () => {
  const { mgr, saves } = setup();
  await mgr.setPerProfileSaves(true);
  await mgr.setPerProfileSaves(false);
  await mgr.switchProfile('p2');
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0'], 'off: nothing moved');
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf('p2')), []);
});

test('README.txt beside the saves says where everything is, once something is kept', async () => {
  const { mgr, root, first, save } = setup();
  const home = path.join(root, 'home');
  mgr.savesHome = () => home;
  assert.strictEqual(mgr.writeSavesReadme(), '', 'nothing kept yet: no file');
  await mgr.setPerProfileSaves(true);
  await mgr.switchProfile('p2');
  save(mgr.profileSaves.dirOf('p2'), 'ManualSave-4', 'ffff');
  const text = fs.readFileSync(mgr.writeSavesReadme(), 'utf8');
  assert.match(text, /THE GAME'S SAVE FOLDER/);
  assert.ok(text.includes(mgr.saves.root()), 'the backup folder');
  assert.ok(text.includes(`"${mgr.data.profiles.list[first].name}" (3 saves)`), 'the other profile, by name, with its count');
  assert.ok(text.includes('these are the saves of the profile "Photo mode"'));
  assert.ok(!/sign-in token/.test(text));
});

test('a finished switch leaves no journal behind, so a later choice of owner stands', async () => {
  const { mgr, saves, first, save } = setup();
  mgr.data.profiles.list.p3 = { id: 'p3', name: 'Third', enabled: [], created: Date.now() };
  save(mgr.profileSaves.dirOf('p3'), 'ManualSave-8', 'gggg', 'third profile save');
  await mgr.setPerProfileSaves(true);
  await mgr.switchProfile('p2');
  assert.ok(!fs.existsSync(mgr.profileSaves.journal), 'cleared once the new owner was written');
  save(saves, 'ManualSave-2', 'cccc', 'played in p2');
  await mgr.setPerProfileSaves(false);
  await mgr.switchProfile('p3');
  // On again: the saves in the game's folder are said to be p3's own (no swap needed).
  await mgr.setPerProfileSaves(true, { owner: 'p3' });
  assert.strictEqual(mgr.savesOwner(), 'p3');
  await mgr.switchProfile(first);
  assert.ok(slots(mgr.profileSaves.dirOf('p3')).includes('ManualSave-2'), 'filed under the profile chosen');
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
});

test('an undo that cannot finish sets its journal aside instead of blocking every switch', async () => {
  const { mgr, saves, first, root } = setup();
  await mgr.setPerProfileSaves(true);
  await mgr.profileSaves.swap(first, 'p2');
  // A planted line pointing outside the save folders is ignored; one of the real moves cannot go back.
  fs.appendFileSync(mgr.profileSaves.journal, `${JSON.stringify({ src: path.join(root, 'elsewhere', 'ManualSave-1'), dst: path.join(root, 'ud') })}\n`);
  const realMove = mgr.profileSaves.readJournal().moves[0];
  const fsp = require('fs/promises');
  const rename = fsp.rename;
  fsp.rename = async (from, to) => { if (path.resolve(from) === path.resolve(realMove.dst)) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return rename(from, to); };
  try { await mgr.recoverProfileSaves(); } finally { fsp.rename = rename; }
  assert.ok(fs.existsSync(path.join(root, 'ud')), 'the planted line moved nothing');
  assert.ok(!fs.existsSync(mgr.profileSaves.journal), 'the journal is out of the way');
  assert.ok(fs.readdirSync(path.dirname(mgr.profileSaves.journal)).some(n => n.startsWith('.switch.log.failed-')), 'and kept aside for reference');
  assert.ok(fs.existsSync(realMove.dst), 'the save that could not go back is still where it was');
  await mgr.switchProfile('p2');
  assert.strictEqual(mgr.savesOwner(), 'p2', 'switching works again');
});

test('half-made copies left by a cut-off copy are cleared', async () => {
  const { mgr, saves } = setup();
  await mgr.setPerProfileSaves(true);
  fs.mkdirSync(path.join(saves, '.ManualSave-5.copying'));
  fs.mkdirSync(path.join(saves, '.ManualSave-6.moving'));
  await mgr.recoverProfileSaves();
  assert.ok(!fs.existsSync(path.join(saves, '.ManualSave-5.copying')));
  assert.ok(!fs.existsSync(path.join(saves, '.ManualSave-6.moving')));
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
});

test('a playthrough kept in another profile\'s folder shows its picture, read from that folder', async () => {
  const { mgr, saves, first } = setup();
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('picture')]);
  for (const slot of ['ManualSave-1', 'AutoSave-0']) fs.writeFileSync(path.join(saves, slot, 'screenshot.png'), png);
  await mgr.setPerProfileSaves(true);
  await mgr.switchProfile('p2');
  const pt = mgr.savesView().perProfile.playthroughs[first].find(p => p.id === 'aaaa');
  assert.strictEqual(pt.shot.profile, first);
  assert.ok(['ManualSave-1', 'AutoSave-0'].includes(pt.shot.folder));
  assert.strictEqual(mgr.saveScreenshot(pt.shot.folder, first), `data:image/png;base64,${png.toString('base64')}`);
  assert.strictEqual(mgr.saveScreenshot(pt.shot.folder), '', 'not in the game\'s folder now');
  assert.throws(() => mgr.saveScreenshot('ManualSave-1', 'toString'), /Unknown profile/);
  for (const bad of [path.win32.join('..', 'ManualSave-1'), path.posix.join('..', 'ManualSave-1'), path.join(saves, 'ManualSave-1')]) {
    assert.throws(() => mgr.saveScreenshot(bad, first), /No such save/, bad);
  }
});

test('one save from another profile can be copied into this one, alone and only once', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  await mgr.switchProfile('p2'); // the first profile's saves wait in its folder
  const pt = mgr.savesView().perProfile.playthroughs[first].find(p => p.id === 'aaaa');
  assert.deepStrictEqual(pt.saves.map(s => s.folder).sort(), ['AutoSave-0', 'ManualSave-1'], 'each save of the playthrough is listed');
  assert.ok(pt.saves.every(s => s.profile === first));

  const r = await mgr.copySaves(first, ['ManualSave-1'], ['p2']);
  assert.deepStrictEqual([r.copied, r.present], [1, 0]);
  assert.deepStrictEqual(slots(saves), ['ManualSave-1'], 'only that save came over, not the whole playthrough');
  assert.strictEqual(fs.readFileSync(path.join(saves, 'ManualSave-1', 'sav.dat'), 'utf8'), 'save ManualSave-1');
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf(first)), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0'], 'a copy: the other profile keeps it');

  const again = await mgr.copySaves(first, ['ManualSave-1'], ['p2']);
  assert.deepStrictEqual([again.copied, again.present], [0, 1], 'the same save is not copied twice');

  await assert.rejects(mgr.copySaves(first, ['..', 'sav.dat'], ['p2']), /No such save/);
  mgr.gameRunning = () => true;
  await assert.rejects(mgr.copySaves(first, ['AutoSave-0'], ['p2']), /Close Cyberpunk 2077 first/);
  assert.deepStrictEqual(slots(saves), ['ManualSave-1']);
});

test('copying single saves: a taken slot name gets a new number, saves already there are counted, built-in ids refused', async () => {
  const { mgr, first, save } = setup();
  await mgr.setPerProfileSaves(true);
  const p2 = mgr.profileSaves.dirOf('p2');
  save(p2, 'ManualSave-1', 'zzzz', 'photo mode\'s own manual save 1');
  fs.cpSync(path.join(mgr.saves.savesDir(), 'AutoSave-0'), path.join(p2, 'AutoSave-0'), { recursive: true }); // already there, byte for byte
  const r = await mgr.copySaves(first, ['ManualSave-1', 'AutoSave-0'], ['p2']);
  assert.deepStrictEqual([r.copied, r.renamed, r.present], [1, 1, 1]);
  assert.deepStrictEqual(slots(p2), ['AutoSave-0', 'ManualSave-1', 'ManualSave-2']);
  assert.strictEqual(fs.readFileSync(path.join(p2, 'ManualSave-1', 'sav.dat'), 'utf8'), 'photo mode\'s own manual save 1', 'its own save is untouched');
  assert.strictEqual(fs.readFileSync(path.join(p2, 'ManualSave-2', 'sav.dat'), 'utf8'), 'save ManualSave-1');
  for (const bad of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(mgr.copySaves(bad, ['ManualSave-1'], ['p2']), /no longer exists/);
    assert.deepStrictEqual(await mgr.copySaves(first, ['ManualSave-1'], [bad]), { copied: 0, renamed: 0, present: 0, profiles: 0 });
  }
});

test('turned off after a switch: saves left in a profile\'s folder still show, with their pictures, and copy into the game', async () => {
  const { mgr, saves, first } = setup();
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('picture')]);
  fs.writeFileSync(path.join(saves, 'ManualSave-1', 'screenshot.png'), png);
  assert.strictEqual(mgr.savesView().stored, null, 'never on: nothing waits anywhere');
  // On, a new profile (it starts with no saves), then off: the first profile's saves stay in its folder.
  await mgr.setPerProfileSaves(true);
  await mgr.switchProfile('p2');
  await mgr.setPerProfileSaves(false);
  assert.deepStrictEqual(slots(saves), [], 'the game sees none of them');
  const view = mgr.savesView();
  assert.strictEqual(view.perProfile, null);
  assert.strictEqual(view.stored.owner, 'p2', 'the game\'s folder is the profile in use\'s');
  assert.deepStrictEqual(view.stored.playthroughs[first].map(p => p.id).sort(), ['aaaa', 'bbbb']);
  assert.deepStrictEqual(view.stored.playthroughs.p2, [], 'the game\'s own saves are not listed as waiting (only p2\'s own, empty, folder)');
  assert.strictEqual(mgr.saveScreenshot('ManualSave-1', first), `data:image/png;base64,${png.toString('base64')}`, 'its picture, from its folder');
  // One save, then a whole playthrough, into the game's saves.
  assert.strictEqual((await mgr.copySaves(first, ['QuickSave-0'], [view.stored.owner])).copied, 1);
  assert.strictEqual((await mgr.copyPlaythrough('aaaa', first, [view.stored.owner])).copied, 2);
  assert.deepStrictEqual(slots(saves), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0']);
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf(first)), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0'], 'copies: the originals stay');
  // Switched back with it off (nothing moves): that profile's own folder still shows, the game's saves do not.
  await mgr.switchProfile(first);
  const again = mgr.savesView().stored;
  assert.strictEqual(again.owner, 'p2');
  assert.strictEqual(again.playthroughs[first].length, 2);
  assert.deepStrictEqual(again.playthroughs.p2, []);
});

test('turned off, then the profile that last had the game\'s saves deleted: the profile in use\'s own folder still shows and copies in', async () => {
  const { mgr, saves, first } = setup();
  await mgr.setPerProfileSaves(true);
  await mgr.switchProfile('p2'); // the first profile's saves go to its folder
  await mgr.setPerProfileSaves(false);
  await mgr.switchProfile(first); // off: nothing moves; the game's folder still holds p2's (none)
  await mgr.deleteProfile('p2');
  assert.strictEqual(mgr.savesOwner(), first, 'the owner falls back to the profile in use');
  const stored = mgr.savesView().stored;
  assert.ok(stored, 'its saves, in its own folder, are not taken for the game\'s');
  assert.deepStrictEqual(stored.playthroughs[first].map(p => p.id).sort(), ['aaaa', 'bbbb']);
  // Its pictures come from its own folder too (not the game's, although it is the "owner").
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('own')]);
  fs.writeFileSync(path.join(mgr.profileSaves.dirOf(first), 'ManualSave-1', 'screenshot.png'), png);
  assert.strictEqual(mgr.saveScreenshot('ManualSave-1', first), `data:image/png;base64,${png.toString('base64')}`);
  // Copied from its own folder into the game, although it is the "owner".
  assert.strictEqual((await mgr.copyPlaythrough('bbbb', first, [stored.owner])).copied, 1);
  assert.deepStrictEqual(slots(saves), ['QuickSave-0']);
  assert.deepStrictEqual(slots(mgr.profileSaves.dirOf(first)), ['AutoSave-0', 'ManualSave-1', 'QuickSave-0'], 'the originals stay');
  // Not while the game runs.
  mgr.gameRunning = () => true;
  await assert.rejects(mgr.copySaves(first, ['ManualSave-1'], [first]), /Close Cyberpunk 2077 first/);
});
