'use strict';
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

/*
 * Is Cyberpunk 2077 running, and which process is it.
 *   Windows: tasklist.
 *   Linux: the game is a Wine process (its program is Wine's loader, its short name a thread's, e.g.
 *   "GameThread"), so /proc is searched for a process whose first argument is …\Cyberpunk2077.exe
 *   (S:\steamapps\common\Cyberpunk 2077\bin\x64\Cyberpunk2077.exe under Steam's Proton). Only the
 *   first argument counts: Proton's helpers name the launcher further along their command lines.
 * Research: the Linux port audit (1.4, 19.3d).
 */

const GAME_EXE = 'Cyberpunk2077.exe';

/** A command line's first argument names the game (Windows or Linux path, any case). */
const isGameArg = arg => String(arg).split(/[\\/]/).pop().toLowerCase() === GAME_EXE.toLowerCase();

/**
 * The first argument of one of this user's /proc processes ('' when it is gone, not readable, or
 * someone else's: another user's game is not this app's to watch or close).
 */
async function firstArg(procDir, pid) {
  try {
    const dir = path.join(procDir, String(pid));
    if (typeof process.getuid === 'function' && (await fsp.stat(dir)).uid !== process.getuid()) return '';
    const fh = await fsp.open(path.join(dir, 'cmdline'));
    try {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(4096), 0, 4096, 0); // the first argument is all that counts
      return buffer.subarray(0, bytesRead).toString('utf8').split('\0')[0];
    } finally { await fh.close(); }
  } catch { return ''; }
}

/** Rejects after ms (a read that hangs counts as not knowing). */
const within = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('The process check took too long.')), ms).unref?.())]);

/**
 * The game's process: { pid }, or null when it is not running. Rejects when it cannot tell (no
 * tasklist, no /proc): callers that keep saves safe count that as running.
 */
async function findGameProcess({ procDir = '/proc', known = 0 } = {}) {
  if (process.platform !== 'win32') return within(scanProc(procDir, known), 15000);
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${GAME_EXE}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      const m = String(stdout).match(/"Cyberpunk2077\.exe","(\d+)"/i);
      resolve(m ? { pid: Number(m[1]) } : null);
    });
  });
}

/** known: the game's process last time; still the game, nothing else is read. */
async function scanProc(procDir, known) {
  if (known && isGameArg(await firstArg(procDir, known))) return { pid: Number(known) };
  const pids = (await fsp.readdir(procDir)).filter(n => /^\d+$/.test(n));
  for (let i = 0; i < pids.length; i += 64) {
    const args = await Promise.all(pids.slice(i, i + 64).map(pid => firstArg(procDir, pid)));
    const hit = args.findIndex(isGameArg);
    if (hit >= 0) return { pid: Number(pids[i + hit]) };
  }
  return null;
}

/** Is this process still the game (Linux; a number can be reused once the game is gone)? */
async function isGameProcess(pid, { procDir = '/proc' } = {}) {
  return isGameArg(await firstArg(procDir, pid));
}

module.exports = { findGameProcess, isGameProcess, isGameArg, GAME_EXE };
