'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GameLogMonitor, parseLine, sourceName, groupKey, ownerRoot } = require('../src/core/gameLogs');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

test('parses the common log formats', () => {
  let p = parseLine('[2026-11-01 20:39:45.636] [warning ] [ 58348] [RED4ext] REDGraph is incompatible');
  assert.strictEqual(p.level, 'warn');
  assert.strictEqual(p.text, '[RED4ext] REDGraph is incompatible');
  p = parseLine('[2026-10-28 00:14:27 UTC-04:00] [info] [__cdecl Options::Options(struct Paths &)] [47492] CET version v1.38.1');
  assert.strictEqual(p.level, 'info');
  assert.strictEqual(p.text, 'CET version v1.38.1');
  assert.strictEqual(new Date(p.time).toISOString(), '2026-10-28T04:14:27.000Z');
  p = parseLine('[INFO - Sun, 1 Nov 2026 20:39:51 -0500] Compiling files');
  assert.strictEqual(p.level, 'info');
  assert.strictEqual(new Date(p.time).toISOString(), '2026-11-02T01:39:51.000Z');
  p = parseLine('[2026-11-01 20:40:18.083] [12308] [error] Vehicle: Unknown property detachableParts.');
  assert.strictEqual(p.level, 'error');
  // No explicit level: wording decides, but counters and identifiers are not problems.
  assert.strictEqual(parseLine('[2026-10-28 23:30:17 UTC-04:00] [58904] [LUT Switcher] Error: service unavailable').level, 'error');
  assert.strictEqual(parseLine('[20:39:42.099] DLSS-G reader installed=1 failure=0').level, null);
  assert.strictEqual(parseLine('[info] Editor/Audio/ShowPauseWarning = false').level, 'info');
});

test('names sources and groups rotated logs', () => {
  assert.strictEqual(sourceName('red4ext/plugins/ArchiveXL/ArchiveXL-2026-11-01-20-39-43.log'), 'ArchiveXL');
  assert.strictEqual(sourceName('red4ext/logs/red4ext-2026-11-01-20-39-42.log'), 'RED4ext');
  assert.strictEqual(sourceName('r6/logs/redscript_rCURRENT.log'), 'redscript');
  assert.strictEqual(sourceName('bin/x64/plugins/cyber_engine_tweaks/mods/LUTSwitcher/LUTSwitcher.log'), 'CET · LUTSwitcher');
  assert.strictEqual(sourceName('bin/x64/plugins/cyber_engine_tweaks/scripting.log'), 'CET scripting');
  assert.strictEqual(groupKey('red4ext/logs/red4ext-2026-11-01-20-39-42.log'), groupKey('red4ext/logs/red4ext-2026-11-01-19-11-10.log'));
  assert.strictEqual(groupKey('r6/logs/redscript_rCURRENT.log'), groupKey('r6/logs/redscript_r2026-11-01_19-11-19.log'));
  assert.strictEqual(ownerRoot('red4ext/plugins/TweakXL/TweakXL-2026.log'), 'red4ext/plugins/TweakXL');
  assert.strictEqual(ownerRoot('bin/x64/plugins/cyber_engine_tweaks/mods/AMM/AMM.log'), 'bin/x64/plugins/cyber_engine_tweaks/mods/AMM');
});

test('follows the newest log of each group and picks up appended lines and new sessions', () => {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-logs-'));
  const logs = path.join(game, 'red4ext', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const now = new Date();
  const stamp = d => `[${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}.000]`;
  const old = path.join(logs, 'red4ext-2026-01-01-10-00-00.log');
  fs.writeFileSync(old, `${stamp(now)} [error] old session error\n`);
  fs.utimesSync(old, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const cur = path.join(logs, 'red4ext-2026-01-02-10-00-00.log');
  fs.writeFileSync(cur, `${stamp(now)} [info] starting\n`);

  const mon = new GameLogMonitor({ getGameDir: () => game, log: quiet, crashDir: path.join(game, 'none') });
  const seen = [];
  mon.on('entries', b => seen.push(...b));
  mon.scan(true);
  mon.pollFiles();
  mon.flush();
  assert.deepStrictEqual(seen.map(e => e.text), ['starting'], 'only the newest file of the group');

  fs.appendFileSync(cur, `${stamp(now)} [error] Something broke\n  at frame 1\n  at frame 2\n`);
  mon.pollFiles();
  mon.flush();
  const err = seen.find(e => e.text.startsWith('Something broke'));
  assert.ok(err);
  assert.strictEqual(err.level, 'error');
  assert.match(err.text, /at frame 2/, 'continuation lines join the entry');
  assert.strictEqual(err.source, 'RED4ext');

  // A new session file appears: it becomes the followed one and is read from the top.
  const next = path.join(logs, 'red4ext-2026-01-03-10-00-00.log');
  fs.writeFileSync(next, `${stamp(now)} [warning] new session\n`);
  mon.scan(false);
  mon.pollFiles();
  mon.flush();
  assert.ok(seen.some(e => e.text === 'new session' && e.level === 'warn'));
  assert.ok(!seen.some(e => e.text === 'old session error'));
});
