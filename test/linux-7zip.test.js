'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sevenZip } = require('../src/core/manager');
const { Settings } = require('../src/core/settings');

/* 7-Zip on Linux: 7-Zip's own 7zz or p7zip's 7z/7za, found on PATH; chosen by hand without .exe. */

async function asLinux(fn) {
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', plat); }
}

test('on Linux 7-Zip is found on PATH (7zz first), and a chosen 7zz or 7z is accepted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-7z-'));
  const a = path.join(root, 'usr-bin');
  const b = path.join(root, 'tools');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, '7z'), '', { mode: 0o755 });
  fs.writeFileSync(path.join(b, '7zz'), '', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'usr-bin', '7zz')); // a folder by that name is not 7-Zip
  fs.writeFileSync(path.join(b, '7za'), '', { mode: 0o644 }); // nor (on Linux) a file that cannot run
  const before = process.env.PATH;
  try {
    await asLinux(async () => {
      process.env.PATH = [a, b].join(path.delimiter);
      assert.strictEqual(sevenZip(''), path.join(a, '7z'), 'the first folder on PATH that has one');
      process.env.PATH = [b, a].join(path.delimiter);
      assert.strictEqual(sevenZip(''), path.join(b, '7zz'));
      assert.strictEqual(sevenZip(path.join(a, '7z')), path.join(a, '7z'), 'a chosen one that exists wins');
      process.env.PATH = '';
      assert.strictEqual(sevenZip(''), '', 'none: nothing made up');
      const s = new Settings(path.join(root, 'ud'), null);
      assert.strictEqual(s.get('sevenZipPath'), '', 'no Windows default on Linux');
      for (const ok of ['/usr/bin/7zz', '/usr/bin/7z', '/usr/bin/7za']) assert.doesNotThrow(() => s.update({ sevenZipPath: ok }), ok);
      for (const bad of ['/usr/bin/7z.exe', '/usr/bin/bash', 'C:\\7-Zip\\7z.exe']) assert.throws(() => s.update({ sevenZipPath: bad }), /7zz/, bad);
    });
  } finally { process.env.PATH = before; }
});
