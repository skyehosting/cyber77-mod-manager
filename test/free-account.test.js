'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Downloader } = require('../src/core/downloader');
const { NexusError } = require('../src/core/nexus');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

/** A local file server and a fake Nexus that refuses links without a one-time key, like it does for free accounts. */
async function setup() {
  const server = http.createServer((_req, res) => res.end('ARCHIVE'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/f.zip`;
  const asked = [];
  const nexus = {
    async getDownloadLink(_g, _m, fileId, nxm) {
      asked.push({ fileId, key: nxm.key || '' });
      if (!nxm.key) throw new NexusError('Forbidden (403)', 403);
      return url;
    },
  };
  const dl = new Downloader(nexus, quiet, () => 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-free-'));
  const spec = (fileId, name) => ({ game: 'cyberpunk2077', modId: 1, fileId, name, modName: 'Mod', fileName: `${name}.zip`, dest: path.join(dir, `${name}.zip`), size: 7 });
  const settle = () => new Promise(r => setTimeout(r, 120));
  // Waits for a state instead of guessing how long a download takes (CI machines are slower).
  const until = async (ok, ms = 10000) => {
    for (const end = Date.now() + ms; !ok();) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise(r => setTimeout(r, 20));
    }
  };
  return { server, dl, spec, asked, settle, until };
}

test('a free account: refused files wait for a click, then download with its one-time key', async () => {
  const { server, dl, spec, asked, settle, until } = await setup();
  try {
    const a = dl.enqueue(spec(11, 'alpha'));
    await until(() => a.status === 'waiting');
    assert.strictEqual(a.status, 'waiting', 'Nexus refused a direct link: the file waits');
    assert.strictEqual(dl.freeAccount, true, 'and the account is known to be free from now on');

    const b = dl.enqueue(spec(22, 'beta'));
    await settle();
    assert.strictEqual(b.status, 'waiting', 'later files wait straight away');
    assert.strictEqual(asked.filter(x => x.fileId === 22).length, 0, 'without asking Nexus first');
    assert.strictEqual(dl.enqueue(spec(22, 'beta')), b, 'asking again for a waiting file is the same job');

    assert.strictEqual(dl.provideKey(99, { key: 'k', expires: '1' }), null, 'a key for another file changes nothing');
    assert.strictEqual(dl.provideKey(11, { key: 'k1', expires: '1' }), a);
    await until(() => a.status === 'done');
    assert.strictEqual(a.status, 'done');
    assert.strictEqual(fs.readFileSync(a.dest, 'utf8'), 'ARCHIVE');
    assert.deepStrictEqual(asked.at(-1), { fileId: 11, key: 'k1' });
    assert.strictEqual(b.status, 'waiting', 'the other file still waits for its own click');

    dl.cancel(b.id);
    assert.strictEqual(b.status, 'cancelled');
  } finally {
    server.close();
  }
});

test('a Premium account never waits', async () => {
  const { server, dl, spec, until } = await setup();
  dl.nexus.getDownloadLink = async () => `http://127.0.0.1:${server.address().port}/f.zip`;
  try {
    const a = dl.enqueue(spec(33, 'gamma'));
    await until(() => ['done', 'waiting', 'error'].includes(a.status));
    assert.strictEqual(a.status, 'done');
    assert.strictEqual(dl.freeAccount, false);
  } finally {
    server.close();
  }
});

test('a refused link asks Nexus again: Premium that ended makes files wait', async () => {
  const { server, dl, spec, until } = await setup();
  let checks = 0;
  dl.checkPremium = async () => { checks++; dl.freeAccount = true; return false; };
  try {
    const a = dl.enqueue(spec(44, 'delta'));
    await until(() => a.status === 'waiting');
    assert.strictEqual(checks, 1, 'the account was checked once');
    assert.strictEqual(dl.freeAccount, true);
  } finally {
    server.close();
  }
});

test('Premium still active: a refused file fails with Nexus\'s reason, the account stays Premium', async () => {
  const { server, dl, spec, until } = await setup();
  dl.nexus.getDownloadLink = async () => { throw Object.assign(new NexusError('Forbidden (403)', 403), { detail: 'File is hidden' }); };
  dl.checkPremium = async () => true;
  try {
    const a = dl.enqueue(spec(55, 'eps'));
    await until(() => ['waiting', 'error'].includes(a.status));
    assert.strictEqual(a.status, 'error');
    assert.match(a.error, /Premium: File is hidden/);
    assert.strictEqual(dl.freeAccount, false, 'later files still download directly');
  } finally {
    server.close();
  }
});

test('an account that cannot be checked is treated as free (files wait, nothing fails)', async () => {
  const { server, dl, spec, until } = await setup();
  dl.checkPremium = async () => { throw new Error('offline'); };
  try {
    const a = dl.enqueue(spec(66, 'zeta'));
    await until(() => a.status === 'waiting');
    assert.strictEqual(dl.freeAccount, true);
  } finally {
    server.close();
  }
});

test('Premium again: waiting files download by themselves', async () => {
  const { server, dl, spec, until } = await setup();
  try {
    const a = dl.enqueue(spec(77, 'eta'));
    await until(() => a.status === 'waiting');
    dl.nexus.getDownloadLink = async () => `http://127.0.0.1:${server.address().port}/f.zip`;
    dl.freeAccount = false;
    dl.resumeWaiting();
    await until(() => ['done', 'error'].includes(a.status), 20000);
    assert.strictEqual(a.status, 'done', a.error);
    assert.strictEqual(fs.readFileSync(a.dest, 'utf8'), 'ARCHIVE');
  } finally {
    server.close();
  }
});

test('the manager checks the account once at a time, says changes, and sends each answer', async () => {
  const { ModManager } = require('../src/core/manager');
  const logged = [];
  const log = { info: m => logged.push(['info', m]), warn: m => logged.push(['warn', m]), error() {}, success: m => logged.push(['success', m]), debug() {} };
  const fake = Object.create(ModManager.prototype);
  require('events').EventEmitter.call(fake);
  let premium = true;
  let calls = 0;
  let resumed = 0;
  Object.assign(fake, {
    log, settings: { apiKey: 'k' },
    nexus: { validate: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { name: 'someone', is_premium: premium }; } },
    downloader: { freeAccount: false, resumeWaiting: () => { resumed++; } },
  });
  const sent = [];
  fake.on('account', a => sent.push(a?.isPremium));

  const [x, y] = await Promise.all([fake.recheckAccount(), fake.recheckAccount()]);
  assert.strictEqual(calls, 1, 'two callers share one check');
  assert.strictEqual(x, y);
  assert.strictEqual(await fake.recheckAccount(60e3).then(a => a.isPremium), true);
  assert.strictEqual(calls, 1, 'a fresh answer is reused');

  premium = false;
  await fake.recheckAccount();
  assert.strictEqual(fake.downloader.freeAccount, true);
  assert.ok(logged.some(([k, m]) => k === 'warn' && /Premium has ended/.test(m)));
  premium = true;
  await fake.recheckAccount();
  assert.strictEqual(resumed, 1, 'Premium again: waiting files go ahead');
  assert.deepStrictEqual(sent.slice(0, 3), [true, false, true]);
  assert.strictEqual(logged.filter(([k]) => k === 'success').length, 2, 'the first answer and the comeback; the repeats stay quiet');

  const good = fake.nexus.validate;
  fake.nexus.validate = async () => { calls++; throw new Error('offline'); };
  const before = calls;
  assert.strictEqual(await fake.recheckAccount(), null, 'an error resolves to null');
  assert.strictEqual(await fake.recheckAccount(), null);
  assert.strictEqual(calls - before, 1, 'after a failure, a minute before asking again');
  assert.strictEqual(logged.filter(([k, m]) => k === 'warn' && /Could not check/.test(m)).length, 1);

  // A refused link whose check failed left files waiting; the next Premium answer lets them go.
  fake.downloader.freeAccount = true;
  fake.accountFailAt = 0;
  fake.nexus.validate = good;
  await fake.recheckAccount();
  assert.strictEqual(resumed, 2, 'resumed although the account was Premium all along');

  // An answer for a key that was replaced meanwhile changes nothing.
  premium = false;
  const late = fake.validateKey();
  fake.settings.apiKey = 'k2';
  await assert.rejects(late, /key changed/);
  assert.strictEqual(fake.account.isPremium, true);
  assert.strictEqual(fake.downloader.freeAccount, false);

  fake.settings.apiKey = '';
  assert.strictEqual(await fake.recheckAccount(), null, 'no key: no check');
  assert.strictEqual(fake.account, null, 'and no account');
  assert.strictEqual(sent.at(-1), undefined, 'the window hears it');
});
