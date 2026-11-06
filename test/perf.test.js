'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const perf = require('../src/core/perf');
const { updateBeforeOpening } = require('../src/core/launchUpdate');

// Rates over about a second of real time, plus however long the second reading takes on a busy
// machine (seen: 58 ms under the full suite): within 15%. A wrong formula is off by far more.
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 0.15 + 0.5, `${msg || ''} ${a} is not about ${b}`);
const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

test('Windows: a sampler line becomes a sample; nonsense is no sample', () => {
  const line = '{"cpu":12.5,"gpu":{"name":"NVIDIA GeForce RTX 4070 Ti","util":20.9,"vramUsed":2423525376,"vramTotal":12576620544},"disk":{"r":0,"w":346339.6},"net":{"rx":27825.6,"tx":200189.2},"game":{"pid":17920,"start":1793854247912,"cpu":null,"mem":142286848,"gpu":0,"vram":140722176,"ioR":null,"ioW":null}}';
  const s = perf.fromWinLine(line, { total: 32e9, free: 20e9 });
  assert.strictEqual(s.system.cpu, 12.5);
  assert.strictEqual(s.system.memUsed, 12e9);
  assert.strictEqual(s.system.gpuName, 'NVIDIA GeForce RTX 4070 Ti');
  assert.strictEqual(s.system.vramTotal, 12576620544);
  assert.deepStrictEqual(s.game, { pid: 17920, startedAt: 1793854247912, cpu: null, mem: 142286848, gpu: 0, vram: 140722176, ioRead: null, ioWrite: null });
  const noGame = perf.fromWinLine('{"cpu":150,"disk":{"r":-5,"w":"x"}}', { total: 1, free: 0 });
  assert.strictEqual(noGame.system.cpu, 100, 'kept within 0 to 100');
  assert.strictEqual(noGame.system.diskRead, 0);
  assert.strictEqual(noGame.system.diskWrite, null, 'not a number: not known');
  assert.strictEqual(noGame.game, null);
  assert.strictEqual(perf.fromWinLine('#< CLIXML'), null);
  assert.strictEqual(perf.fromWinLine('{"error":"pdh"}'), null);
  assert.strictEqual(perf.fromWinLine('{"cpu":1,"game":{"pid":"1"}}', { total: 1, free: 0 }).game, null, 'a game without a whole-number pid is none');
});

test('Linux parsers: /proc/stat, meminfo, diskstats (whole disks), net/dev (not lo), pid stat, fdinfo, nvidia-smi', () => {
  assert.deepStrictEqual(perf.parseProcStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4'), [150, 1000]);
  assert.deepStrictEqual(perf.parseMeminfo('MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    8000000 kB\n'), { total: 16000000 * 1024, available: 8000000 * 1024 });
  const ds = [
    '   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0',
    '   8       1 sda1 100 0 2000 0 50 0 4000 0 0 0 0',
    ' 259       0 nvme0n1 1 0 10 0 1 0 20 0 0 0 0',
    ' 259       1 nvme0n1p1 1 0 10 0 1 0 20 0 0 0 0',
    '   7       0 loop0 1 0 999 0 1 0 999 0 0 0 0',
  ].join('\n');
  assert.deepStrictEqual(perf.parseDiskstats(ds), { r: 2010 * 512, w: 4020 * 512 });
  const nd = 'Inter-|   Receive |  Transmit\n face |bytes packets\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 5 0 0 0 0 0 0 2000 7 0 0 0 0 0 0\nwlan0:500 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0';
  assert.deepStrictEqual(perf.parseNetDev(nd), { rx: 1500, tx: 2100 });
  assert.strictEqual(perf.parsePidStat('4242 (Cyberpunk2077.e) S 1 2 3 4 5 6 7 8 9 10 300 200 0 0'), 500);
  assert.strictEqual(perf.parsePidStat('4242 (Game (x) y) S 1 2 3 4 5 6 7 8 9 10 30 20 0 0'), 50, 'a name with spaces and brackets');
  const fdi = perf.parseFdinfo('pos:\t0\ndrm-driver:\tamdgpu\ndrm-client-id:\t42\ndrm-engine-gfx:\t1000000 ns\ndrm-engine-compute:\t5 ns\ndrm-memory-vram:\t2048 KiB\n');
  assert.deepStrictEqual(fdi, { client: '42', engines: { gfx: 1000000, compute: 5 }, vram: 2048 * 1024 });
  assert.strictEqual(perf.parseFdinfo('pos: 0\nflags: 02\n'), null, 'not a GPU file');
  assert.deepStrictEqual(perf.parseNvidiaLine('NVIDIA GeForce RTX 3080, 57, 4096, 10240'), { name: 'NVIDIA GeForce RTX 3080', util: 57, used: 4096 * 1048576, total: 10240 * 1048576 });
  assert.strictEqual(perf.parseNvidiaLine('garbage'), null);
  assert.strictEqual(perf.clampMs(10), 500);
  assert.strictEqual(perf.clampMs('nope'), 1000);
  assert.strictEqual(perf.clampMs(1e9), 10000);
});

/** A /proc and /sys of a Linux PC with an AMD card and the game running as process 4242. */
function fakeLinux() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-perf-'));
  const proc = path.join(root, 'proc');
  const sys = path.join(root, 'sys');
  const w = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
  const set = n => {
    w(path.join(proc, 'stat'), `cpu  ${100 * n} 0 ${100 * n} ${800 * n} 0 0 0 0\n`);
    w(path.join(proc, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n');
    w(path.join(proc, 'diskstats'), `   8 0 sda 1 0 ${2 * n} 0 1 0 ${4 * n} 0 0 0 0\n`);
    w(path.join(proc, 'net', 'dev'), `  eth0: ${1000 * n} 0 0 0 0 0 0 0 ${500 * n} 0 0 0 0 0 0 0\n`);
    w(path.join(proc, '4242', 'stat'), `4242 (GameThread) S 1 2 3 4 5 6 7 8 9 10 ${50 * n} ${50 * n} 0 0`);
    w(path.join(proc, '4242', 'status'), 'Name: GameThread\nVmRSS:\t  2048 kB\n');
    w(path.join(proc, '4242', 'io'), `read_bytes: ${4096 * n}\nwrite_bytes: ${1024 * n}\n`);
    const card = path.join(sys, 'class', 'drm', 'card1', 'device');
    w(path.join(card, 'vendor'), '0x1002\n');
    w(path.join(card, 'gpu_busy_percent'), `${30 + n}\n`);
    w(path.join(card, 'mem_info_vram_used'), '1073741824\n');
    w(path.join(card, 'mem_info_vram_total'), '8589934592\n');
  };
  return { proc, sys, set };
}

test('Linux: the PC and the game, from /proc and /sys (rates from two readings)', async () => {
  const { proc, sys, set } = fakeLinux();
  set(1);
  const samples = [];
  const src = new perf.LinuxSource({ log: quiet, proc, sys, findGame: async () => ({ pid: 4242 }), stillGame: async () => true });
  src.emit = s => samples.push(s);
  src.ms = 1000;
  src.prev = null;
  src.game = null;
  src.gameCheckAt = 0;
  await src.sample();
  assert.strictEqual(samples[0].system.cpu, null, 'the first reading has nothing to compare with');
  assert.strictEqual(samples[0].system.memUsed, 750 * 1024);
  assert.strictEqual(samples[0].system.gpu, 31);
  assert.strictEqual(samples[0].system.vramTotal, 8589934592);
  assert.strictEqual(samples[0].game.pid, 4242);
  assert.strictEqual(samples[0].game.mem, 2048 * 1024);
  // One second later (as far as the readings know).
  src.prev.at -= 1000;
  src.game.at -= 1000;
  set(2);
  await src.sample();
  const s = samples[1].system;
  assert.strictEqual(Math.round(s.cpu), 20, '200 busy ticks of 1000');
  near(s.diskRead, 2 * 512);
  near(s.diskWrite, 4 * 512);
  near(s.netDown, 1000);
  near(s.netUp, 500);
  const g = samples[1].game;
  near(g.cpu, 100 / os.cpus().length, '100 ticks in a second is one core:');
  near(g.ioRead, 4096);
  near(g.ioWrite, 1024);
  src.stop();
});

test('Linux: no game, no graphics card files: the PC numbers still come, the rest is not known', async () => {
  const { proc, sys, set } = fakeLinux();
  set(1);
  fs.rmSync(path.join(sys, 'class'), { recursive: true });
  const samples = [];
  const src = new perf.LinuxSource({ log: quiet, proc, sys, findGame: async () => null, stillGame: async () => false });
  src.emit = s => samples.push(s);
  src.prev = null; src.game = null; src.gameCheckAt = 0;
  await src.sample();
  assert.strictEqual(samples[0].game, null);
  assert.strictEqual(samples[0].system.gpu, null);
  assert.strictEqual(samples[0].system.gpuName, '');
  assert.strictEqual(samples[0].system.memTotal, 1000 * 1024);
});

/** A stand-in for the PowerShell child: lines written to its stdout. */
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {};
  c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {};
  c.stdin = new EventEmitter(); c.stdin.end = data => { c.sent = data; };
  c.kill = () => { c.killed = true; };
  return c;
}

test('Windows: the sampler gets the C# on its input and its lines become samples; two failures fall back to CPU and memory', async () => {
  const children = [];
  const src = new perf.WindowsSource({ log: quiet, restartMs: 5, spawnFn: (cmd, args) => { const c = fakeChild(); c.cmd = cmd; c.args = args; children.push(c); return c; } });
  const samples = [];
  const tick = ms => new Promise(r => setTimeout(r, ms));
  src.start(1000, s => samples.push(s));
  assert.match(children[0].cmd, /[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i, 'Windows\' own PowerShell, by its full path');
  assert.ok(children[0].args.includes('-EncodedCommand') && !children[0].args.join(' ').includes('Sampler.Run(') , 'the script is encoded');
  assert.match(children[0].sent, /namespace CmmPerf/, 'the C# came on standard input');
  children[0].stdout.emit('data', '{"cpu":5}\n{"cpu":');
  children[0].stdout.emit('data', '6}\n');
  assert.deepStrictEqual(samples.map(s => s.system.cpu), [5, 6], 'lines split across chunks are whole again');
  // It dies after a line or two (it never ran 15 s), then again: no endless restarts, but CPU and
  // memory from Node, with a note. The restart waits a moment.
  children[0].emit('exit', 1);
  assert.strictEqual(children.length, 1, 'not restarted at once');
  await tick(30);
  assert.strictEqual(children.length, 2, 'restarted after a moment');
  children[1].emit('exit', 1);
  await tick(30);
  assert.strictEqual(children.length, 2, 'not a third time');
  assert.ok(src.timer, 'the basic readings run');
  src.stop();
  assert.strictEqual(src.timer, null);
  // Stopped on purpose: its exit starts nothing again.
  const before = children.length;
  const s2 = new perf.WindowsSource({ log: quiet, spawnFn: () => { const c = fakeChild(); children.push(c); return c; } });
  s2.start(1000, () => {});
  const c = children[children.length - 1];
  s2.stop();
  c.emit('exit', 0);
  await tick(30);
  assert.strictEqual(children.length, before + 1);
  assert.ok(c.killed);
});

test('the Windows sampler\'s C# is plain ASCII (it is read through the console\'s code page)', () => {
  const cs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'perfWin.cs'), 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(cs), 'perfWin.cs has a character outside ASCII');
});

test('Linux: a stopped reading starts no nvidia-smi and shows nothing', async () => {
  const { proc, sys, set } = fakeLinux();
  set(1);
  const card = path.join(sys, 'class', 'drm', 'card1', 'device');
  fs.writeFileSync(path.join(card, 'vendor'), '0x10de\n'); // an NVIDIA card
  const spawned = [];
  const src = new perf.LinuxSource({ log: quiet, proc, sys, findGame: async () => null, stillGame: async () => false, spawnFn: () => { const c = fakeChild(); spawned.push(c); return c; } });
  const shown = [];
  src.start(1000, s => shown.push(s));
  src.stop(); // before the first reading got to the graphics card
  await new Promise(r => setTimeout(r, 50));
  assert.deepStrictEqual([spawned.length, shown.length], [0, 0]);
  // Running: one nvidia-smi, by the documented loop option; stopped with the page.
  src.start(1000, s => shown.push(s));
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(spawned.length, 1);
  src.stop();
  assert.ok(spawned[0].killed);
});

test('PerfMonitor: start, a new interval restarts, stop stops (once)', () => {
  const calls = [];
  const source = { start: ms => calls.push(['start', ms]), stop: () => calls.push(['stop']) };
  const m = new perf.PerfMonitor({ source });
  m.start(1000);
  m.start(1000);
  m.start(2000);
  m.stop();
  m.stop();
  assert.deepStrictEqual(calls, [['start', 1000], ['start', 2000], ['stop']]);
});

/** electron-updater's autoUpdater, as far as the check before opening uses it. */
function fakeUpdater(onCheck) {
  const u = new EventEmitter();
  u.checkForUpdates = () => { setImmediate(() => onCheck(u)); return Promise.resolve(); };
  return u;
}

test('Update before opening: nothing newer opens the app; a download installs; errors, silence and Open now never hold it', async () => {
  const said = [];
  const none = await updateBeforeOpening({ autoUpdater: fakeUpdater(u => u.emit('update-not-available')), say: t => said.push(t) });
  assert.strictEqual(none.outcome, 'none');
  assert.strictEqual(said[0], 'Checking for updates…');

  const got = await updateBeforeOpening({
    autoUpdater: fakeUpdater(u => { u.emit('update-available', { version: '1.1.99' }); u.emit('download-progress', { percent: 42.4 }); u.emit('update-downloaded', { version: '1.1.99' }); }),
    say: t => said.push(t),
  });
  assert.deepStrictEqual([got.outcome, got.version], ['install', '1.1.99']);
  assert.ok(said.includes('Downloading version 1.1.99… 42%'));

  const err = await updateBeforeOpening({ autoUpdater: fakeUpdater(u => u.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\nmore'))) });
  assert.deepStrictEqual([err.outcome, err.error], ['error', 'net::ERR_INTERNET_DISCONNECTED']);

  const silent = await updateBeforeOpening({ autoUpdater: fakeUpdater(() => {}), check: 30 });
  assert.strictEqual(silent.outcome, 'timeout');

  const stalled = await updateBeforeOpening({ autoUpdater: fakeUpdater(u => u.emit('update-available', { version: '2.0.0' })), stall: 30 });
  assert.deepStrictEqual([stalled.outcome, stalled.version], ['background', '2.0.0'], 'a download with no progress is left to the background');

  const u = fakeUpdater(() => {});
  const skipped = await updateBeforeOpening({ autoUpdater: u, skip: Promise.resolve() });
  assert.strictEqual(skipped.outcome, 'skip');
  assert.strictEqual(u.listenerCount('update-downloaded'), 0, 'its listeners are gone afterwards');

  const thrown = await updateBeforeOpening({ autoUpdater: { on() {}, removeListener() {}, checkForUpdates: () => { throw new Error('no network'); } } });
  assert.strictEqual(thrown.outcome, 'error');
});
