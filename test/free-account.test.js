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
