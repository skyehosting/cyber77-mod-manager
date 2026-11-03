'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PlayHistory, AFTER_MS } = require('../src/core/plays');

/** A stand-in for the log monitor: its events, its lines and the log files it follows. */
function fakeLogs(gameDir) {
  const logs = new EventEmitter();
  logs.entries = [];
  logs.files = new Map();
  logs.addFile = (rel, text) => {
    const full = path.join(gameDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    fs.utimesSync(full, new Date(Date.now()), new Date(Date.now())); // the test's own clock
    logs.files.set(rel, { rel, full });
  };
  let id = 1;
  logs.line = (level, text, extra = {}) => { const e = { id: id++, time: Date.now(), level, source: 'CET', text, ...extra }; logs.entries.push(e); logs.emit('entries', [e]); return e; };
  return logs;
}

const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `cmm-${name}-`));

test('a play keeps its own lines and a copy of the logs written during it; it ends a minute after the game', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 10, 3, 2, 8, 0).getTime() });
  const game = tmp('game');
  const logs = fakeLogs(game);
  logs.addFile('bin/x64/plugins/cyber_engine_tweaks/cyber_engine_tweaks.log', 'old run\n');
  const plays = new PlayHistory({ dir: tmp('plays'), logs });

  logs.line('info', 'before the game');
  t.mock.timers.tick(5000);
  logs.line('success', 'Cyberpunk 2077 started (PID 42)', { source: 'Game', marker: true });
  logs.emit('game', { running: true, since: Date.now(), pid: 42 });
  logs.line('error', 'RainOverhaul: missing record');
  logs.line('warn', 'slow script');
  logs.line('error', 'something', { source: 'Mod Manager' }); // this app's own message: not the game's
  logs.addFile('bin/x64/plugins/cyber_engine_tweaks/cyber_engine_tweaks.log', 'this run\n');
  const [live] = plays.list();
  assert.strictEqual(live.live, true);
  assert.strictEqual(live.id, '20261103-020805');

  t.mock.timers.tick(47 * 60e3);
  logs.emit('game', { running: false });
  logs.line('error', 'written on the way out');
  logs.emit('crash', 'Cyberpunk2077-20261103-025505-1');
  assert.strictEqual(plays.list()[0].closing, true);
  t.mock.timers.tick(AFTER_MS + 1);

  const p = plays.get('20261103-020805');
  assert.strictEqual(p.outcome, 'crashed');
  assert.strictEqual(p.crash, 'Cyberpunk2077-20261103-025505-1');
  assert.deepStrictEqual(p.entries.map(e => e.text), ['Cyberpunk 2077 started (PID 42)', 'RainOverhaul: missing record', 'slow script', 'written on the way out']);
  assert.strictEqual(p.errors, 2);
  assert.strictEqual(p.warns, 1);
  assert.deepStrictEqual(p.files.map(f => f.rel), ['bin/x64/plugins/cyber_engine_tweaks/cyber_engine_tweaks.log']);
  assert.strictEqual(fs.readFileSync(plays.filePath(p.id, p.files[0].rel), 'utf8'), 'this run\n');
  assert.throws(() => plays.filePath(p.id, '../play.json'), /Not a file of that play/);

  // The next play is a separate set.
  t.mock.timers.tick(60e3);
  logs.emit('game', { running: true, since: Date.now() });
  logs.line('info', 'second run');
  assert.strictEqual(plays.list().length, 2);
  assert.deepStrictEqual(plays.get(plays.list()[0].id).entries.map(e => e.text), ['second run']);
  // The play in progress cannot be deleted; an older one can.
  assert.strictEqual(plays.remove([plays.list()[0].id, '20261103-020805']), 1);
  assert.strictEqual(plays.list().length, 1);
});

test('a play the app did not see end (it was closed first) is finished on the next start', () => {
  const dir = tmp('plays');
  const logs = fakeLogs(tmp('game'));
  const d = path.join(dir, '20261102-200000');
  fs.mkdirSync(d);
  const start = new Date(2026, 10, 2, 20, 0, 0).getTime();
  fs.writeFileSync(path.join(d, 'play.json'), JSON.stringify({ id: '20261102-200000', start, end: 0, outcome: '', errors: 1, warns: 0, lines: 2 }));
  fs.writeFileSync(path.join(d, 'timeline.jsonl'), `${JSON.stringify({ time: start, level: 'info', text: 'a' })}\n${JSON.stringify({ time: start + 600e3, level: 'error', text: 'b' })}\n`);
  const plays = new PlayHistory({ dir, logs });
  plays.recover();
  const p = plays.list()[0];
  assert.strictEqual(p.end, start + 600e3);
  assert.strictEqual(p.outcome, 'unknown');
});

test('a play whose last minute the app did not see (closed right after the game) still gets its log files', () => {
  const dir = tmp('plays');
  const game = tmp('game');
  const logs = fakeLogs(game);
  logs.addFile('r6/logs/x.log', 'run\n');
  const d = path.join(dir, '20261103-010000');
  fs.mkdirSync(d);
  const start = Date.now() - 600e3;
  fs.writeFileSync(path.join(d, 'play.json'), JSON.stringify({ id: '20261103-010000', start, end: Date.now() - 10e3, outcome: 'exited', errors: 0, warns: 0, lines: 1 }));
  const plays = new PlayHistory({ dir, logs });
  plays.recover();
  const p = plays.list()[0];
  assert.strictEqual(p.files, 1);
  assert.strictEqual(p.outcome, 'exited', 'how it ended is kept');
});

test('each play remembers the profile that was active when the game started', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 10, 3, 4, 0, 0).getTime() });
  const logs = fakeLogs(tmp('game'));
  let active = { id: 'p1', name: 'Photo mode' };
  const plays = new PlayHistory({ dir: tmp('plays'), logs, profile: () => active });
  logs.emit('game', { running: true, since: Date.now(), pid: 7 });
  active = { id: 'p2', name: 'Vanilla+' }; // switching during the play does not move it
  assert.deepStrictEqual(plays.list()[0].profile, { id: 'p1', name: 'Photo mode' });
  logs.emit('game', { running: false });
  t.mock.timers.tick(AFTER_MS + 1);
  assert.deepStrictEqual(plays.list()[0].profile, { id: 'p1', name: 'Photo mode' });

  const none = new PlayHistory({ dir: tmp('plays'), logs: fakeLogs(tmp('game')), profile: () => { throw new Error('not ready'); } });
  none.logs.emit('game', { running: true, since: Date.now() + 5000, pid: 8 });
  assert.strictEqual(none.list()[0].profile, null);
});
