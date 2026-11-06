'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ModImages, nexusHost } = require('../src/core/modImages');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

/** A fake Nexus (its picture address can change) and a fake web that serves pictures. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-img-'));
  const nexus = { asked: 0, url: 'https://staticdelivery.nexusmods.com/mods/3333/images/1/1-a.png', adult: false, fail: false,
    async modsByIds(_g, ids) { this.asked++; if (this.fail) throw new Error('offline'); return [{ modId: ids[0], pictureUrl: this.url, adultContent: this.adult }]; } };
  const web = { got: 0, type: 'image/png', body: PNG,
    fetch: async url => { web.got++; return { ok: true, status: 200, url, headers: new Map([['content-type', web.type], ['content-length', String(web.body.length)]]), arrayBuffer: async () => web.body }; } };
  const imgs = new ModImages({ dir, nexus, log: quiet, fetch: web.fetch });
  return { dir, nexus, web, imgs };
}

test('a mod picture is downloaded once and reused; a new version asks again but downloads only a new address', async () => {
  const { dir, nexus, web, imgs } = setup();
  const a = await imgs.get('cyberpunk2077', 1, '1.0');
  assert.ok(a && fs.existsSync(a.file), 'downloaded into the folder');
  assert.strictEqual(path.dirname(a.file), dir);
  assert.deepStrictEqual(fs.readFileSync(a.file), PNG);
  assert.strictEqual(a.adult, false);

  assert.deepStrictEqual(await imgs.get('cyberpunk2077', 1, '1.0'), a);
  assert.strictEqual(nexus.asked, 1, 'same version: no question to Nexus');

  const again = new ModImages({ dir, nexus, log: quiet, fetch: web.fetch });
  assert.strictEqual((await again.get('cyberpunk2077', 1, '1.0')).file, a.file, 'the index survives a restart');
  assert.strictEqual(nexus.asked, 1);

  await imgs.get('cyberpunk2077', 1, '1.1');
  assert.strictEqual(nexus.asked, 2, 'a new version: Nexus is asked again');
  assert.strictEqual(web.got, 1, 'the same picture is not downloaded again');

  nexus.url = 'https://staticdelivery.nexusmods.com/mods/3333/images/1/1-b.png';
  nexus.adult = true;
  const b = await imgs.get('cyberpunk2077', 1, '1.2');
  assert.notStrictEqual(b.file, a.file, 'the author changed the picture: a new file');
  assert.strictEqual(b.adult, true);
  assert.strictEqual(web.got, 2);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!fs.existsSync(a.file), 'the old picture is removed');
});

test('only Nexus pictures, only image types; offline keeps the old picture; bad ids ask nothing', async () => {
  const { nexus, web, imgs } = setup();
  assert.strictEqual(await imgs.get('cyberpunk2077', 0, ''), null);
  assert.strictEqual(await imgs.get('../x', 5, ''), null);
  assert.strictEqual(nexus.asked, 0);

  web.type = 'text/html';
  assert.strictEqual(await imgs.get('cyberpunk2077', 2, '1'), null, 'not a picture: nothing kept');
  assert.strictEqual(await imgs.get('cyberpunk2077', 2, '1'), null);
  assert.strictEqual(nexus.asked, 1, 'a failed download is not tried again at once');

  web.type = 'image/png';
  nexus.url = 'https://evil.example.com/x.png';
  assert.strictEqual(await imgs.get('cyberpunk2077', 3, '1'), null, 'not a Nexus host');
  assert.strictEqual(await imgs.get('cyberpunk2077', 3, '1'), null);
  assert.strictEqual(nexus.asked, 2, 'a mod without a picture is remembered (not asked again for the same version)');

  nexus.url = 'https://staticdelivery.nexusmods.com/mods/3333/images/4/4-a.png';
  const kept = await imgs.get('cyberpunk2077', 4, '1');
  nexus.fail = true;
  assert.strictEqual((await imgs.get('cyberpunk2077', 4, '2')).file, kept.file, 'offline: the cached picture is used');

  const [x, y] = await Promise.all([imgs.get('cyberpunk2077', 9, '1'), imgs.get('cyberpunk2077', 9, '1')]);
  assert.strictEqual(x, y, 'two asks for one mod share one fetch');

  assert.ok(nexusHost('https://staticdelivery.nexusmods.com/a.png'));
  assert.ok(!nexusHost('http://staticdelivery.nexusmods.com/a.png'), 'https only');
  assert.ok(!nexusHost('https://nexusmods.com.evil.io/a.png'));
});

test('redirects are checked before they are followed; a picture with no size header stops at 10 MB', async () => {
  const { nexus, imgs } = setup();
  const asked = [];
  imgs.fetch = async url => {
    asked.push(new URL(url).host);
    if (url.includes('/hop')) return { ok: false, status: 302, url, headers: new Map([['location', 'https://127.0.0.1/secret']]) };
    // An endless picture with no content-length: read in pieces until the limit.
    let sent = 0;
    const body = { getReader: () => ({ read: async () => (sent++ < 2000 ? { done: false, value: new Uint8Array(64 * 1024) } : { done: true }), cancel: async () => {} }) };
    return { ok: true, status: 200, url, headers: new Map([['content-type', 'image/png']]), body };
  };
  nexus.url = 'https://staticdelivery.nexusmods.com/hop/1.png';
  assert.strictEqual(await imgs.get('cyberpunk2077', 21, '1'), null);
  assert.deepStrictEqual(asked, ['staticdelivery.nexusmods.com'], 'the redirect to another host was never asked');

  nexus.url = 'https://staticdelivery.nexusmods.com/big/1.png';
  assert.strictEqual(await imgs.get('cyberpunk2077', 22, '1'), null, 'too large: not kept');
});
