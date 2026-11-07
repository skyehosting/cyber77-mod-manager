'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Installer } = require('../src/core/installer');

const SEVEN_ZIP = require('./seven-zip');
const have7z = fs.existsSync(SEVEN_ZIP);
const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

/** An archive of `files` ({ 'path/in/it': text or Buffer }), made with 7-Zip. */
function archive(dir, name, files) {
  const src = fs.mkdtempSync(path.join(dir, 'src-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body);
  }
  const out = path.join(dir, name);
  execFileSync(SEVEN_ZIP, ['a', '-bso0', '-bsp0', out, '*'], { cwd: src });
  return out;
}

// Like "All-in-One Variant Clothing Colors" (Nexus 2927): one .7z of 64 .7z files, each with loose .archive files.
test('an archive of archives: the inner ones are unpacked (one level) and their files placed', { skip: !have7z && '7-Zip not installed' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-nested-'));
  const kicks = archive(tmp, 'VariantsKicks.7z', { 'Variant_KicksBlack.archive': 'black', 'Variant_KicksGold.archive': 'gold' });
  const shirt = archive(tmp, 'TShirtVariantsRed.7z', { 'Variant_TShirtRedGym.archive': 'gym' });
  const inner = archive(tmp, 'deeper.zip', { 'never.archive': 'x' });
  const twice = archive(tmp, 'Twice.7z', { 'Variant_Twice.archive': 'twice', 'deeper.zip': fs.readFileSync(inner) });
  const outer = archive(tmp, 'All-in-One.7z', { 'VariantsKicks.7z': fs.readFileSync(kicks), 'TShirtVariantsRed.7z': fs.readFileSync(shirt), 'Twice.7z': fs.readFileSync(twice) });
  const inst = new Installer({ getSevenZip: () => SEVEN_ZIP, tempDir: () => path.join(tmp, 'temp'), log: quiet });
  const session = await inst.prepare(outer);
  const plan = inst.plan(session, 'Clothing', null, {});
  assert.deepStrictEqual(plan.mappings.map(m => m.dest).sort(), ['archive/pc/mod/Variant_KicksBlack.archive', 'archive/pc/mod/Variant_KicksGold.archive', 'archive/pc/mod/Variant_TShirtRedGym.archive', 'archive/pc/mod/Variant_Twice.archive']);
  assert.ok(!session.files.some(f => /never\.archive$/.test(f)), 'one level only: an archive inside an inner one is not opened');
  assert.ok(session.unpacked >= 3);
  inst.release(session.token);
});

test('an archive that is a mod already: archives inside it are left alone', { skip: !have7z && '7-Zip not installed' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-nested-'));
  const extra = archive(tmp, 'optional.zip', { 'Optional.archive': 'opt' });
  const outer = archive(tmp, 'Mod.zip', { 'archive/pc/mod/Main.archive': 'main', 'extras/optional.zip': fs.readFileSync(extra) });
  const inst = new Installer({ getSevenZip: () => SEVEN_ZIP, tempDir: () => path.join(tmp, 'temp'), log: quiet });
  const session = await inst.prepare(outer);
  const plan = inst.plan(session, 'Mod', null, {});
  assert.deepStrictEqual(plan.mappings.map(m => m.dest), ['archive/pc/mod/Main.archive']);
  assert.ok(!session.unpacked);
  inst.release(session.token);
});

test('(audit) an inner archive with an odd name stays inside; a broken one, or too much, installs nothing', { skip: !have7z && '7-Zip not installed' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-nested-'));
  const good = archive(tmp, 'good.7z', { 'Good.archive': 'x'.repeat(1000) });
  const temp = path.join(tmp, 'temp');
  const inst = new Installer({ getSevenZip: () => SEVEN_ZIP, tempDir: () => temp, log: quiet });
  // Named "..7z": unpacked into a folder inside, never beside the temp folder.
  const odd = archive(tmp, 'odd.7z', { '..7z': fs.readFileSync(good) });
  const s1 = await inst.prepare(odd);
  assert.deepStrictEqual(inst.plan(s1, 'Odd', null, {}).mappings.map(m => m.dest), ['archive/pc/mod/Good.archive']);
  inst.release(s1.token);
  assert.deepStrictEqual(fs.readdirSync(tmp).filter(n => n.startsWith('temp')), ['temp'], 'nothing written next to the temp folder');
  // One inner archive is broken: an error, and nothing left half-unpacked.
  const broken = archive(tmp, 'broken.7z', { 'Fine.7z': fs.readFileSync(good), 'Zbroken.7z': Buffer.from('not an archive at all') });
  await assert.rejects(inst.prepare(broken), /could not be (read|unpacked)/);
  assert.deepStrictEqual(fs.readdirSync(temp), [], 'its temp folder is gone');
  // More than the size budget: refused before anything is unpacked.
  const small = new Installer({ getSevenZip: () => SEVEN_ZIP, tempDir: () => temp, log: quiet, maxInnerBytes: 500 });
  await assert.rejects(small.prepare(archive(tmp, 'big.7z', { 'Big.7z': fs.readFileSync(good) })), /would take more than/);
  assert.deepStrictEqual(fs.readdirSync(temp), []);
});
