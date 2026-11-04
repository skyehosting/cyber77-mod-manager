'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/*
 * Who opens nxm:// links ("Mod Manager Download" on Nexus), read from and written to the user's
 * own registry branch (HKCU\Software\Classes\nxm, no admin rights). Before this app takes the
 * links over, whatever was there (Vortex, another manager) is saved with `reg export`, and it is
 * put back with `reg import` when the user turns the takeover off.
 */
const KEY = 'HKCU\\Software\\Classes\\nxm';

const reg = args => new Promise(resolve => {
  execFile('reg', args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
});

/** The command that opens nxm:// links now ('' when nothing is registered). */
async function readCommand() {
  const r = await reg(['query', `${KEY}\\shell\\open\\command`, '/ve']);
  if (!r.ok) return '';
  const m = r.out.match(/REG_(?:EXPAND_)?SZ\s+(.+)\s*$/m);
  return m ? m[1].trim() : '';
}

/** A readable name for a handler command: "Vortex", "Cyber Mod Manager", or the program's name. */
function describe(command, ownExe) {
  if (!command) return '';
  const exe = (command.match(/^"([^"]+)"/) || command.match(/^(\S+)/) || [])[1] || command;
  if (ownExe && path.resolve(exe).toLowerCase() === path.resolve(ownExe).toLowerCase()) return 'Edgerunners Mod Manager';
  const base = path.basename(exe).replace(/\.exe$/i, '');
  return /^vortex$/i.test(base) ? 'Vortex' : base;
}

/** Save the current registration (if any) to a .reg file. Returns false when there was nothing. */
async function backup(file) {
  const exists = await reg(['query', KEY]);
  if (!exists.ok) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (await reg(['export', KEY, file, '/y'])).ok;
}

/** Remove this app's registration and put back the saved one, if there is one. */
async function restore(file) {
  await reg(['delete', KEY, '/f']);
  if (!file || !fs.existsSync(file)) return false;
  const r = await reg(['import', file]);
  return r.ok;
}

/** Point the link icon at this app too (a previous handler's icon may be left behind). */
function setIcon(exe) {
  return reg(['add', `${KEY}\\DefaultIcon`, '/ve', '/d', `${exe},0`, '/f']);
}

module.exports = { readCommand, describe, backup, restore, setIcon, KEY };
