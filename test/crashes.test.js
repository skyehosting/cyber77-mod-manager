'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CrashReports, readDump, parseStack, crashTime } = require('../src/core/crashes');

/** A minimal minidump: an exception at `address` and one module per [name, base, size]. */
function makeDump(address, modules) {
  const names = modules.map(([n]) => Buffer.from(n, 'utf16le'));
  const dirRva = 32;
  const exRva = dirRva + 24;
  const mlRva = exRva + 40;
  let nameRva = mlRva + 4 + modules.length * 108;
  const size = nameRva + names.reduce((s, b) => s + 4 + b.length, 0);
  const b = Buffer.alloc(size);
  b.writeUInt32LE(0x504d444d, 0);
  b.writeUInt32LE(2, 8);
  b.writeUInt32LE(dirRva, 12);
  b.writeUInt32LE(6, dirRva); b.writeUInt32LE(40, dirRva + 4); b.writeUInt32LE(exRva, dirRva + 8);
  b.writeUInt32LE(4, dirRva + 12); b.writeUInt32LE(4 + modules.length * 108, dirRva + 16); b.writeUInt32LE(mlRva, dirRva + 20);
  b.writeUInt32LE(0xC0000005, exRva + 8);
  b.writeBigUInt64LE(BigInt(address), exRva + 24);
  b.writeUInt32LE(modules.length, mlRva);
  modules.forEach(([, base, len], i) => {
    const o = mlRva + 4 + i * 108;
    b.writeBigUInt64LE(BigInt(base), o);
    b.writeUInt32LE(len, o + 8);
    b.writeUInt32LE(nameRva, o + 20);
    b.writeUInt32LE(names[i].length, nameRva);
    names[i].copy(b, nameRva + 4);
    nameRva += 4 + names[i].length;
  });
  return b;
}

test('readDump finds the module the crash address is in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-dump-'));
  const f = path.join(dir, 'Cyberpunk2077.dmp');
  fs.writeFileSync(f, makeDump(0x180012345, [['Cyberpunk2077.exe', 0x140000000, 0x1000000], ['some_mod.dll', 0x180000000, 0x100000]]));
  const d = readDump(f);
  assert.strictEqual(d.code, '0xC0000005');
  assert.strictEqual(d.module.name, 'some_mod.dll');
  assert.strictEqual(d.module.offset, '0x12345');
  assert.strictEqual(readDump(path.join(dir, 'none.dmp')), null);
});

test('parseStack and crashTime read the crash reporter\'s files', () => {
  const s = parseStack('Error reason: Unhandled exception\nExpression: EXCEPTION_ACCESS_VIOLATION (0xC0000005)\nMessage: x\n');
  assert.strictEqual(s.reason, 'Unhandled exception');
  assert.match(s.expression, /ACCESS_VIOLATION/);
  assert.strictEqual(crashTime('Cyberpunk2077-20261102-020828-1-2'), new Date(2026, 10, 2, 2, 8, 28).getTime());
});

test('a crash names the mod whose file it was in, found by file name in the game folder', () => {
  const q = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-queue-'));
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-game-'));
  const add = (name, dump) => { fs.mkdirSync(path.join(q, name)); fs.writeFileSync(path.join(q, name, 'Cyberpunk2077.dmp'), dump); fs.writeFileSync(path.join(q, name, 'stacktrace.txt'), 'Error reason: Unhandled exception\n'); };
  add('Cyberpunk2077-20261102-020828-a', makeDump(0x180000010, [['flight.dll', 0x180000000, 0x1000]]));
  add('Cyberpunk2077-20261101-020828-b', makeDump(0x190000010, [['190_E658703.dll', 0x190000000, 0x1000]]));
  const files = { index: () => ({ files: [{ rel: 'red4ext/plugins/flight/flight.dll', mtime: 0 }], own: { files: new Map([['red4ext/plugins/flight/flight.dll', { mod: 'Let There Be Flight' }]]) } }) };
  const cr = new CrashReports({ dir: () => q, gameDir: () => game, gameLogs: { entries: [] }, files });
  const [newest, older] = cr.list();
  assert.strictEqual(newest.module.mod, 'Let There Be Flight');
  assert.strictEqual(newest.module.file, 'red4ext/plugins/flight/flight.dll');
  assert.strictEqual(newest.module.notInGame, false);
  assert.strictEqual(older.module.notInGame, true);
  assert.strictEqual(cr.details('latest').id, newest.id);
});
