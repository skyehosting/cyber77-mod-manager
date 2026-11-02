'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore } = require('../src/core/jsonStore');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-store-')), 'settings.json');

test('saved settings survive a damaged or missing file, from their backup', () => {
  const file = tmpFile();
  const a = new JsonStore(file, { apiKeyEnc: '', gamePath: '' });
  a.data.apiKeyEnc = 'secret-1';
  a.save();
  a.data.gamePath = 'C:\Game';
  a.save(); // the first version is now the backup
  assert.strictEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).apiKeyEnc, 'secret-1');

  fs.writeFileSync(file, '{"apiKeyEnc": "half writ'); // damaged
  const b = new JsonStore(file, { apiKeyEnc: '', gamePath: '' });
  assert.strictEqual(b.restored, true);
  assert.strictEqual(b.data.apiKeyEnc, 'secret-1', 'the key comes back from the backup');
  assert.ok(fs.readdirSync(path.dirname(file)).some(f => f.includes('.corrupt-')), 'the damaged file is kept to look at');

  b.save(); // a damaged file never replaces a good backup
  assert.strictEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).apiKeyEnc, 'secret-1');

  fs.unlinkSync(file); // gone altogether
  assert.strictEqual(new JsonStore(file, { apiKeyEnc: '' }).data.apiKeyEnc, 'secret-1');
});

test('a first start has defaults and no backup', () => {
  const s = new JsonStore(tmpFile(), { x: 1 });
  assert.deepStrictEqual([s.data, s.restored], [{ x: 1 }, false]);
});
