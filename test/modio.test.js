'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ModioClient, cleanApiPath, cdnUrl, siteUrl, windowsFile, card } = require('../src/core/modio');
const { Settings } = require('../src/core/settings');
const { Downloader } = require('../src/core/downloader');
const { ModManager } = require('../src/core/manager');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
const KEY = 'a'.repeat(32);

/** A fake mod.io: answers by path; records every URL asked for. */
function fakeFetch(routes) {
  const asked = [];
  const fn = async url => {
    asked.push(url);
    const u = new URL(url);
    const route = routes(u);
    const status = route.status || 200;
    return { ok: status < 400, status, headers: new Map(Object.entries(route.headers || {})), json: async () => route.body };
  };
  fn.asked = asked;
  return fn;
}
const mod = (id, plats, extra = {}) => ({
  id, name_id: `mod-${id}`, name: `Mod ${id}`, submitted_by: { username: 'someone' }, summary: 's',
  logo: { thumb_640x360: `https://thumb.modcdn.io/x/${id}.jpg` }, tags: [{ name: 'Combat' }], stats: { downloads_total: 5 },
  date_updated: 1, date_live: 1, maturity_option: 0, profile_url: `https://mod.io/g/cyberpunk-2077/m/mod-${id}`,
  modfile: { id: id * 10 + 9, version: '1.0', filesize: 3 }, platforms: plats, ...extra,
});

test('mod.io: the API path must be one of mod.io\'s own addresses (the key is never sent anywhere else)', () => {
  assert.strictEqual(cleanApiPath('https://u-12345678.modapi.io/v1/'), 'https://u-12345678.modapi.io/v1');
  assert.strictEqual(cleanApiPath('https://g-5784.modapi.io/v1'), 'https://g-5784.modapi.io/v1');
  assert.strictEqual(cleanApiPath('https://api.mod.io/v1'), 'https://api.mod.io/v1');
  assert.strictEqual(cleanApiPath(''), '');
  for (const bad of ['http://u-1.modapi.io/v1', 'https://evil.example/v1', 'https://u-1.modapi.io.evil.com/v1', 'https://u-1.modapi.io/v1?x=https://api.mod.io/v1', 'https://user@api.mod.io/v1']) {
    assert.throws(() => cleanApiPath(bad), /not a mod\.io API path/, bad);
  }
  assert.strictEqual(cdnUrl('https://thumb.modcdn.io/a.jpg'), 'https://thumb.modcdn.io/a.jpg');
  assert.strictEqual(cdnUrl('https://evil.com/modcdn.io.jpg'), '');
  assert.strictEqual(cdnUrl('javascript:alert(1)'), '');
  assert.strictEqual(siteUrl('https://evil.com'), 'https://mod.io/g/cyberpunk-2077');
});

test('mod.io: the key is stored encrypted-or-plain like the Nexus key, checked, and never shown to the page', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-modio-'));
  const s = new Settings(ud, null);
  assert.throws(() => s.update({ modioKey: 'not a key' }), /not a mod\.io API key/);
  s.update({ modioKey: KEY, modioApiPath: 'https://u-42.modapi.io/v1' });
  assert.strictEqual(s.modioKey, KEY);
  const pub = s.publicView();
  assert.strictEqual(pub.hasModioKey, true);
  assert.ok(!JSON.stringify(pub).includes(KEY), 'the key itself stays in the main process');
  assert.throws(() => s.update({ modioApiPath: 'https://evil.example/v1' }), /not a mod\.io API path/);
});

test('mod.io: searches list only mods with a Windows file, page by page, with the user\'s key', async () => {
  const fetchImpl = fakeFetch(u => {
    if (u.pathname.endsWith('/mods')) {
      const all = [mod(1, [{ platform: 'windows', modfile_live: 11 }]), mod(2, [{ platform: 'ps5', modfile_live: 21 }]), mod(3, [{ platform: 'windows', modfile_live: 31 }, { platform: 'switch2', modfile_live: 39 }]), mod(4, [])];
      return { body: { data: all, result_total: all.length } };
    }
    return { status: 404, body: {} };
  });
  const c = new ModioClient({ getKey: () => KEY, getBase: () => 'https://u-42.modapi.io/v1', log: quiet, fetchImpl });
  const r = await c.search({ query: 'x', sort: 'popular', perPage: 20 });
  assert.deepStrictEqual(r.mods.map(m => [m.id, m.fileId]), [[1, 11], [3, 31], [4, 49]], 'the console-only mod is left out; the Windows file is picked, not the Switch one');
  assert.strictEqual(r.total, 3);
  const u = new URL(fetchImpl.asked[0]);
  assert.strictEqual(u.origin + u.pathname, 'https://u-42.modapi.io/v1/games/5784/mods');
  assert.strictEqual(u.searchParams.get('api_key'), KEY);
  assert.strictEqual(u.searchParams.get('_sort'), '-downloads_total');
  assert.strictEqual(u.searchParams.get('_q'), 'x');
  await c.search({ query: 'x', sort: 'popular', perPage: 20 });
  assert.strictEqual(fetchImpl.asked.length, 1, 'the same search again comes from the cache');
  assert.strictEqual(windowsFile(mod(5, [{ platform: 'windows', modfile_live: 0 }])), 0);
});

test('mod.io: no key, no request; a 429 is waited out, not retried in a loop; a bad key says where to fix it', async () => {
  let calls = 0;
  const noKey = new ModioClient({ getKey: () => '', getBase: () => '', log: quiet, fetchImpl: async () => { calls++; return {}; } });
  await assert.rejects(noKey.tags(), /Settings → mod\.io/);
  assert.strictEqual(calls, 0);
  const slow = new ModioClient({ getKey: () => KEY, getBase: () => '', log: quiet, fetchImpl: fakeFetch(() => ({ status: 429, headers: { 'retry-after': '30' }, body: {} })) });
  await assert.rejects(slow.tags(), /slow down.*30 s/);
  await assert.rejects(slow.tags(), /asked to wait/);
  assert.strictEqual(slow.fetch.asked.length, 1, 'nothing more is sent while mod.io asked to wait');
  const bad = new ModioClient({ getKey: () => KEY, getBase: () => '', log: quiet, fetchImpl: fakeFetch(() => ({ status: 401, body: { error: { message: 'x' } } })) });
  await assert.rejects(bad.tags(), /did not accept the API key/);
});

test('mod.io: a download address must be mod.io\'s, and a file its scan flagged is refused', async () => {
  const file = extra => fakeFetch(() => ({ body: { id: 11, filename: 'a.zip', filehash: { md5: 'a'.repeat(32) }, download: { binary_url: 'https://g-5784.modapi.io/v1/games/5784/mods/1/files/11/download/abc' }, ...extra } }));
  const ok = new ModioClient({ getKey: () => KEY, getBase: () => '', log: quiet, fetchImpl: file() });
  const got = await ok.downloadUrl(1, 11);
  assert.deepStrictEqual({ ...got, checkUrl: undefined }, { url: 'https://g-5784.modapi.io/v1/games/5784/mods/1/files/11/download/abc', md5: 'a'.repeat(32), size: 0, checkUrl: undefined });
  assert.strictEqual(got.checkUrl('https://cdn.modcdn.io/x.zip'), true, 'a redirect to the file servers of mod.io is fine');
  assert.strictEqual(got.checkUrl('https://evil.example/x.zip'), false, 'a redirect anywhere else is not');
  const away = new ModioClient({ getKey: () => KEY, getBase: () => '', log: quiet, fetchImpl: file({ download: { binary_url: 'https://evil.example/a.zip' } }) });
  await assert.rejects(away.downloadUrl(1, 11), err => /not used/.test(err.message) && err.fatal === true);
  const flagged = new ModioClient({ getKey: () => KEY, getBase: () => '', log: quiet, fetchImpl: file({ virus_positive: 1 }) });
  await assert.rejects(flagged.downloadUrl(1, 11), /virus scan/);
});

test('mod.io: a card carries only checked addresses and plain values', () => {
  const c = card(mod(7, [{ platform: 'windows', modfile_live: 71 }], { logo: { thumb_640x360: 'https://evil.com/x.jpg' }, profile_url: 'javascript:alert(1)', maturity_option: 8 }));
  assert.strictEqual(c.logo, '');
  assert.strictEqual(c.url, 'https://mod.io/g/cyberpunk-2077');
  assert.strictEqual(c.mature, true);
});

/** A tiny local server for the downloader: serves `body` at any path. */
function serve(body) {
  return new Promise(resolve => {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body); });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('downloads from mod.io: a fresh address each time, checked against mod.io\'s checksum, no Nexus steps', async () => {
  const body = Buffer.from('a mod file');
  const srv = await serve(body);
  const url = `http://127.0.0.1:${srv.address().port}/f.zip`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-modio-dl-'));
  try {
    const nexus = { getDownloadLink: async () => { throw new Error('Nexus must not be asked'); } };
    const d = new Downloader(nexus, quiet, () => 2);
    d.freeAccount = true; // a free Nexus account never holds back a mod.io file
    let asked = 0;
    let md5 = crypto.createHash('md5').update(body).digest('hex');
    d.resolvers.modio = async () => { asked++; return { url, md5 }; };
    const done = new Promise(r => d.once('done', r));
    d.enqueue({ key: 'modio-11', source: 'modio', modio: { id: 1, fileId: 11 }, fileId: 0, fileName: 'f.zip', modName: 'M', dest: path.join(dir, 'f.zip') });
    await done;
    assert.strictEqual(fs.readFileSync(path.join(dir, 'f.zip'), 'utf8'), 'a mod file');
    assert.strictEqual(asked, 1);
    // A wrong checksum: the file is not kept (and tried again, each time with a fresh address).
    md5 = 'b'.repeat(32);
    const failed = new Promise(r => d.on('update', j => { if (j.key === 'modio-12' && j.status === 'error') r(j); }));
    d.enqueue({ key: 'modio-12', source: 'modio', modio: { id: 1, fileId: 12 }, fileId: 0, fileName: 'g.zip', modName: 'M', dest: path.join(dir, 'g.zip') });
    const j = await failed;
    assert.match(j.error, /checksum/);
    assert.ok(!fs.existsSync(path.join(dir, 'g.zip')) && !fs.existsSync(path.join(dir, 'g.zip.part')));
    assert.strictEqual(asked, 4, 'three tries, each with a fresh address');
  } finally { srv.close(); }
});

test('mod.io in the library: queued under its own key with its source, what it needs comes too, console-only needs are named', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-modio-mgr-'));
  const ud = path.join(root, 'ud');
  fs.mkdirSync(path.join(ud, 'data'), { recursive: true });
  const settings = new Settings(ud, null);
  settings.update({ dataDir: path.join(ud, 'data') });
  const mgr = new ModManager({ settings, log: quiet });
  const queued = [];
  mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  const mods = {
    1: { id: 1, nameId: 'a', name: 'Quest', author: 'x', logo: '', url: 'https://mod.io/g/cyberpunk-2077/m/a', fileId: 11, file: { id: 11, fileName: 'a.zip', version: '2', size: 5, added: 0, virusPositive: 0 }, dependencies: [{ id: 2, name: 'Core', fileId: 21 }, { id: 3, name: 'Console thing', fileId: 0 }] },
    2: { id: 2, nameId: 'b', name: 'Core', author: 'x', logo: '', url: 'https://mod.io/g/cyberpunk-2077/m/b', fileId: 21, file: { id: 21, fileName: 'b.zip', version: '1', size: 5, added: 0, virusPositive: 0 }, dependencies: [] },
  };
  mgr.modio.mod = async id => mods[id];
  const r = await mgr.queueModio(1);
  assert.deepStrictEqual(queued.map(q => [q.key, q.source, q.modio.id, q.modio.fileId, q.dependencyOf, q.modId]), [['modio-11', 'modio', 1, 11, '', 0], ['modio-21', 'modio', 2, 21, 'Quest', 0]]);
  assert.deepStrictEqual(r.noWindows, ['Console thing']);
  assert.ok(queued[0].dest.includes(path.join('mod.io', 'Quest (1)')));
  // Downloaded, then installed: the mod remembers where it came from.
  mgr.onDownloaded({ ...queued[0], total: 5 });
  await mgr.op(async () => {});
  assert.strictEqual(mgr.data.downloads['modio-11'].source, 'modio');
  assert.strictEqual(mgr.data.downloads['modio-11'].modio.fileId, 11);
});

test('mod.io updates: a newer Windows file is found on mod.io (not Nexus) and replaces the old one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-modio-upd-'));
  const ud = path.join(root, 'ud');
  fs.mkdirSync(path.join(ud, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ud, 'data', 'library.json'), JSON.stringify({ downloads: {}, nextPriority: 2, mods: {
    'modio-11': { id: 'modio-11', key: 'modio-11', name: 'Quest', modName: 'Quest', modId: 0, fileId: 0, version: '1', type: 'REDmod', category: 'MAIN', enabled: true, priority: 1, files: [], warnings: [], source: 'modio', modio: { id: 1, fileId: 11 } },
  } }));
  const settings = new Settings(ud, null);
  settings.update({ dataDir: path.join(ud, 'data'), modioKey: KEY });
  const mgr = new ModManager({ settings, log: quiet });
  mgr.nexus.getFiles = async () => { throw new Error('Nexus must not be asked about a mod.io mod'); };
  mgr.modio.current = async ids => new Map(ids.map(id => [id, { id, name: 'Quest', fileId: 12 }]));
  mgr.modio.file = async (modId, fileId) => ({ id: fileId, modId, fileName: 'q2.zip', version: '2', size: 9, added: 0, virusPositive: 0 });
  const r = await mgr.checkUpdates();
  assert.strictEqual(r.available, 1);
  assert.deepStrictEqual([mgr.data.updates['modio-11'].source, mgr.data.updates['modio-11'].fileId, mgr.data.updates['modio-11'].version], ['modio', 12, '2']);
  const queued = [];
  mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  mgr.modio.mod = async () => ({ id: 1, nameId: 'q', name: 'Quest', author: '', logo: '', url: 'https://mod.io/g/cyberpunk-2077/m/q', fileId: 12, file: null, dependencies: [] });
  const s = await mgr.updateMods(['modio-11']);
  assert.strictEqual(s.queued, 1);
  assert.deepStrictEqual([queued[0].key, queued[0].replaces, queued[0].modio.fileId], ['modio-12', 'modio-11', 12]);
});

test('mod.io (audit): no redirects with the key, a hand-edited API path is refused, requests started together are spread out', async () => {
  const opts = [];
  const c = new ModioClient({ getKey: () => KEY, getBase: () => 'https://u-1.modapi.io/v1', log: quiet, fetchImpl: async (url, o) => { opts.push(o); return { ok: true, status: 200, headers: new Map(), json: async () => ({ tag_options: [] }) }; } });
  await c.tags();
  assert.strictEqual(opts[0].redirect, 'error');
  let sent = 0;
  const tampered = new ModioClient({ getKey: () => KEY, getBase: () => 'https://evil.example/v1', log: quiet, fetchImpl: async () => { sent++; return {}; } });
  await assert.rejects(tampered.tags(), /API path in Settings/);
  assert.strictEqual(sent, 0, 'the key never left');
  // 50 a minute: the 51st request started at the same moment waits for a slot.
  const spread = new ModioClient({ getKey: () => KEY, getBase: () => '', log: quiet, fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({}) }) });
  const now = Date.now();
  spread.recent = Array.from({ length: 50 }, () => now - 1000);
  const t0 = Date.now();
  const p = spread.request('/x');
  assert.ok(spread.recent.at(-1) > t0 + 58e3, 'its slot is a minute after the oldest');
  spread.recent = []; // (not waited for here)
  p.catch(() => {});
});

test('mod.io downloads (audit): a 429 makes the file wait, not fail; a flagged file stops at once; the size must match', async () => {
  const body = Buffer.from('a mod file');
  const srv = await serve(body);
  const url = `http://127.0.0.1:${srv.address().port}/f.zip`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-modio-dl2-'));
  try {
    const d = new Downloader({ getDownloadLink: async () => { throw new Error('no Nexus'); } }, quiet, () => 1);
    let calls = 0;
    d.resolvers.modio = async job => {
      calls++;
      if (job.key === 'modio-1' && calls === 1) throw Object.assign(new Error('slow down'), { status: 429, retryAt: Date.now() + 200 });
      if (job.key === 'modio-2') throw Object.assign(new Error('flagged'), { fatal: true });
      if (job.key === 'modio-3') return { url, size: body.length + 5 };
      return { url, size: body.length };
    };
    const ends = new Map();
    d.on('update', j => { if (['done', 'error'].includes(j.status)) ends.set(j.key, j); });
    for (const k of ['modio-1', 'modio-2', 'modio-3']) d.enqueue({ key: k, source: 'modio', modio: {}, fileId: 0, fileName: `${k}.zip`, modName: 'M', dest: path.join(dir, `${k}.zip`) });
    const t = Date.now();
    while (ends.size < 3 && Date.now() - t < 20e3) await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(ends.get('modio-1')?.status, 'done', 'waited out the 429, then downloaded');
    assert.strictEqual(ends.get('modio-2')?.status, 'error');
    assert.strictEqual(ends.get('modio-2')?.attempts, 1, 'no retries for a flagged file');
    assert.match(ends.get('modio-3')?.error || '', /wrong size/);
  } finally { srv.close(); }
});

test('mod.io file names that are not usable names get a safe one, inside the downloads folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-modio-fn-'));
  const ud = path.join(root, 'ud');
  fs.mkdirSync(path.join(ud, 'data'), { recursive: true });
  const settings = new Settings(ud, null);
  settings.update({ dataDir: path.join(ud, 'data') });
  const mgr = new ModManager({ settings, log: quiet });
  const queued = [];
  mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  const m = { id: 9, nameId: 'x', name: '../../Evil', author: '', logo: '', url: '' };
  for (const fileName of ['..', 'NUL.zip', 'con', 'trailing.', '']) mgr.queueModioFile(m, { id: 90 + queued.length, fileName, version: '1', size: 1, added: 0 }, '', { queued: 0, skipped: 0 });
  for (const q of queued) {
    assert.match(path.basename(q.dest), /^modio-\d+\.zip$/);
    assert.ok(path.resolve(q.dest).startsWith(path.resolve(settings.downloadsDir) + path.sep));
  }
});

test('mod.io downloads (audit 2): a file waiting out a 429 frees its slot for the next file, and can be cancelled while it waits', async () => {
  const body = Buffer.from('x');
  const srv = await serve(body);
  const url = `http://127.0.0.1:${srv.address().port}/f.zip`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-modio-dl3-'));
  try {
    const d = new Downloader({ getDownloadLink: async () => { throw new Error('no Nexus'); } }, quiet, () => 1); // one slot
    let firstAsked = 0;
    d.resolvers.modio = async job => {
      if (job.key === 'modio-1') { firstAsked++; throw Object.assign(new Error('slow down'), { status: 429, retryAt: Date.now() + 60e3 }); }
      return { url, size: body.length };
    };
    const done = new Promise(r => d.on('done', j => { if (j.key === 'modio-2') r(); }));
    const a = d.enqueue({ key: 'modio-1', source: 'modio', modio: {}, fileId: 0, fileName: 'a.zip', modName: 'M', dest: path.join(dir, 'a.zip') });
    d.enqueue({ key: 'modio-2', source: 'modio', modio: {}, fileId: 0, fileName: 'b.zip', modName: 'M', dest: path.join(dir, 'b.zip') });
    await done; // the second file got the only slot while the first waits a minute
    assert.strictEqual(a.status, 'queued');
    d.cancel(a.id);
    assert.strictEqual(a.status, 'cancelled');
    assert.strictEqual(a.waitTimer, null, 'its wait is over: it does not come back');
    assert.strictEqual(firstAsked, 1);
  } finally { srv.close(); }
});
