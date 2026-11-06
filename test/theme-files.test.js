'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { ThemeFiles, cleanTheme, sniffImage, safeName } = require('../src/core/themeFiles');

// The smallest real pictures: a PNG and a JPEG header (enough for the sniffing).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-themes-'));
  const trashed = [];
  const t = new ThemeFiles({ dir: path.join(root, 'Themes'), assets: path.join(root, 'assets'), trash: async f => { trashed.push(f); fs.rmSync(f); } });
  return { root, t, trashed };
}

test('themes: saved by name in the folder with their pictures and code, loaded back whole', () => {
  const { t } = setup();
  const bg = t.putAsset('background', PNG);
  assert.match(bg, /^file:/);
  const saved = t.save('Cherry Blossom', { colors: '--bg: #1a0f17;', fx: { bg: { dim: 30 }, particles: { preset: 'petals', count: 90 } }, code: 'fx.frame = () => {};', imageUrls: { background: bg } });
  assert.strictEqual(path.basename(saved.file), 'Cherry Blossom.emmtheme');
  assert.deepStrictEqual(t.list().map(x => x.name), ['Cherry Blossom']);
  t.clearAssets('background');
  const back = t.load('Cherry Blossom');
  assert.strictEqual(back.colors, '--bg: #1a0f17;');
  assert.strictEqual(back.fx.bg.dim, 30);
  assert.strictEqual(back.fx.particles.preset, 'petals');
  assert.strictEqual(back.code, 'fx.frame = () => {};');
  assert.ok(back.imageUrls.background, 'the picture came back with it');
  assert.deepStrictEqual(fs.readFileSync(t.assetFile(back.imageUrls.background)), PNG);
});

test('themes: a picture is only ever a real PNG / JPEG / WebP / GIF; names are safe file names in the folder', () => {
  const { t } = setup();
  assert.deepStrictEqual(sniffImage(JPG), { type: 'image/jpeg', ext: 'jpg' });
  assert.strictEqual(sniffImage(Buffer.from('<svg onload=alert(1)>....')), null);
  assert.throws(() => t.putAsset('background', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), /not a PNG/);
  assert.throws(() => t.putAsset('script', PNG), /Unknown picture/);
  for (const bad of ['../../evil', 'a/b', 'C:\\x', 'nul', 'trailing. ']) {
    const f = t.fileOf(bad);
    assert.strictEqual(path.dirname(f), path.resolve(t.dir), bad);
  }
  assert.strictEqual(safeName('  My   Theme  '), 'My Theme');
  assert.throws(() => t.fileOf('   '), /Give the theme a name/);
  // A picture URL that is not one of the kept pictures is never read into a theme.
  const outside = path.join(path.dirname(t.dir), 'secret.png');
  fs.writeFileSync(outside, PNG);
  assert.strictEqual(t.assetFile(pathToFileURL(outside).href), null);
  const saved = t.save('X', { colors: '', imageUrls: { background: pathToFileURL(outside).href } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(saved.file, 'utf8')).images, {});
});

test('themes: a theme file from someone else is checked: numbers in range, pictures sniffed, sizes capped', () => {
  const clean = cleanTheme({ format: 'edgerunners-theme', name: 'Odd', colors: 'x'.repeat(70000), fx: { bg: { dim: 500, blur: -3, fit: 'weird' }, glass: { blur: 99 }, particles: { preset: 'nuke', layer: 'everywhere', count: 1e9, colors: ['red', '#ABCDEF', 'javascript:'] }, extra: 1 }, images: {}, code: '' });
  assert.strictEqual(clean.colors.length, 60000);
  assert.deepStrictEqual([clean.fx.bg.dim, clean.fx.bg.blur, clean.fx.bg.fit, clean.fx.glass.blur], [90, 0, 'cover', 40]);
  assert.deepStrictEqual([clean.fx.particles.preset, clean.fx.particles.layer, clean.fx.particles.count, clean.fx.particles.colors], ['none', 'background', 400, ['#abcdef']]);
  assert.strictEqual('extra' in clean.fx, false);
  assert.throws(() => cleanTheme({ format: 'something-else' }), /not an Edgerunners Mod Manager theme/);
  assert.throws(() => cleanTheme({ images: { background: { data: Buffer.from('not a picture at all').toString('base64') } } }), /not a PNG/);
  assert.throws(() => cleanTheme({ code: 'x'.repeat(200 << 10) }), /larger than 100 KB/);
});

test('themes: delete goes to the recycle bin; import copies a checked file in, never over another', async () => {
  const { root, t, trashed } = setup();
  t.save('Mine', { colors: '' });
  const outside = path.join(root, 'from-a-friend.emmtheme');
  fs.writeFileSync(outside, JSON.stringify({ format: 'edgerunners-theme', version: 1, name: 'Mine', colors: '--bg: #000;', fx: {}, images: {}, code: '' }));
  assert.strictEqual(t.importFile(outside), 'Mine 2');
  assert.deepStrictEqual(t.list().map(x => x.name), ['Mine', 'Mine 2']);
  fs.writeFileSync(outside, '{ not json');
  assert.throws(() => t.importFile(outside), /damaged/);
  assert.strictEqual(await t.remove('Mine'), true);
  assert.strictEqual(path.basename(trashed[0]), 'Mine.emmtheme');
  assert.deepStrictEqual(t.list().map(x => x.name), ['Mine 2']);
});

test('the sealed animation frame: its one script is the one its CSP allows (by sha256); no network, no files, no other scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'fx-sandbox.html'), 'utf8').replace(/\r\n/g, '\n');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.strictEqual(scripts.length, 1);
  assert.ok(!/<script\s+src=/i.test(html), 'a sandboxed frame cannot load script files');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const hash = crypto.createHash('sha256').update(scripts[0]).digest('base64');
  assert.ok(csp.includes(`'sha256-${hash}'`), 'the CSP hash matches the script (re-hash after editing it)');
  for (const part of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'"]) assert.ok(csp.includes(part), part);
  assert.ok(csp.includes('worker-src blob:'), 'the code runs in a worker started from the frame');
  assert.match(scripts[0], /new Worker\(/);
  assert.match(scripts[0], /3000/, 'a watchdog stops a frame that hangs');
  const outside = scripts[0].split('\n').filter(l => !l.includes('const WORKER = ')).join('\n');
  assert.ok(!/new Function/.test(outside), 'the code is never run in the frame itself, only in the worker');
  assert.ok(!/script-src[^;]*'self'/.test(csp) && !/script-src[^;]*https?:/.test(csp));
  // The window loads it sandboxed: scripts only, no same-origin (no reach into the app).
  const fxjs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'themefx.js'), 'utf8');
  assert.match(fxjs, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.ok(!/allow-same-origin/.test(fxjs));
});

test('themes (audit): Windows device names with a dot are never file names; imports never write through a link or past 99 copies', () => {
  const { root, t } = setup();
  for (const n of ['con.x', 'NUL.v2', 'com1.theme']) assert.match(path.basename(t.fileOf(n)), /^Theme /, n);
  const src = path.join(root, 'a.emmtheme');
  fs.writeFileSync(src, JSON.stringify({ format: 'edgerunners-theme', name: 'Same', colors: '', fx: {}, images: {}, code: '' }));
  fs.mkdirSync(t.dir, { recursive: true });
  // A link sitting where the import would go (pointing nowhere): the name counts as taken, nothing is written through it.
  const target = path.join(root, 'elsewhere.txt');
  let linked = false;
  try { fs.symlinkSync(target, path.join(t.dir, 'Same.emmtheme')); linked = true; } catch { /* no symlinks allowed here (Windows without the right): skip that part */ }
  const name = t.importFile(src);
  if (linked) { assert.strictEqual(name, 'Same 2'); assert.ok(!fs.existsSync(target), 'nothing written through the link'); }
  for (let i = 2; i <= 99; i++) if (!t.exists(`Same ${i}`)) fs.writeFileSync(t.fileOf(`Same ${i}`), '{}');
  if (!t.exists('Same')) fs.writeFileSync(t.fileOf('Same'), '{}');
  assert.throws(() => t.importFile(src), /too many themes named/);
});
