'use strict';
const fs = require('fs');
const path = require('path');

/*
 * File-name case in the game folder on Linux. The game runs under Wine, which finds a file whatever
 * its case; a Linux disk keeps "Archive" and "archive" as two folders, and Wine then shows the game
 * only one of them: a mod placed in the other is silently not loaded. So a path a mod brings is put
 * where the game folder already has it (its case on disk, folder by folder), and folders that do not
 * exist yet get the game's own lower case for its known folders (archive/pc/mod, r6/scripts, …); a
 * mod's own folders keep theirs. Windows ignores case: paths are used as they are.
 * Research: the Linux port audit (1.2, 19.1, N4, N7).
 */

// The game's folders, lower case as the game has them (and as the frameworks install them).
const KNOWN = new Set([
  'archive', 'archive/pc', 'archive/pc/mod', 'bin', 'bin/x64', 'bin/x64/plugins', 'bin/x64/plugins/cyber_engine_tweaks',
  'bin/x64/plugins/cyber_engine_tweaks/mods', 'r6', 'r6/scripts', 'r6/tweaks', 'r6/config', 'r6/input', 'r6/cache', 'r6/logs',
  'red4ext', 'red4ext/plugins', 'engine', 'engine/config', 'engine/config/base', 'engine/config/platform',
  'engine/config/platform/pc', 'engine/tools', 'mods', 'tools',
]);

/**
 * Paths under `base` in the case to use there. resolve(rel) gives rel ('/'-separated) as it is on
 * disk, or as it will be made; names it hands out for folders not made yet count as there for the
 * paths after them (one spelling per folder). exists(rel): is it there, whatever its case.
 */
function caseResolver(base) {
  const folders = new Map(); // folder → Map(lower-case name → its spellings: on disk, plus ones handed out)
  const spellings = dir => {
    if (!folders.has(dir)) {
      const byLower = new Map();
      let list = [];
      try { list = fs.readdirSync(dir); } catch { /* not there (yet) */ }
      for (const n of list.sort()) byLower.set(n.toLowerCase(), [...(byLower.get(n.toLowerCase()) || []), n]);
      folders.set(dir, byLower);
    }
    return folders.get(dir);
  };
  function resolve(rel, plan = true) {
    const parts = String(rel).split(/[\\/]/).filter(p => p && p !== '.');
    if (parts.includes('..')) throw new Error(`Not a path inside the game folder: ${rel}`);
    if (process.platform === 'win32') return parts.join('/');
    const out = [];
    let dir = base;
    let key = '';
    for (const p of parts) {
      const lower = p.toLowerCase();
      key = key ? `${key}/${lower}` : lower;
      const known = KNOWN.has(key) ? lower : '';
      const byLower = spellings(dir);
      const same = byLower.get(lower) || [];
      // The game's own spelling if it is there, else always the same one of those there (sorted
      // first): two spellings of a folder must never split one mod from another.
      let name = (known && same.includes(known) && known) || same[0];
      if (!name) {
        name = known || p;
        if (plan) byLower.set(lower, [name]);
      }
      out.push(name);
      dir = path.join(dir, name);
    }
    return out.join('/');
  }
  const exists = rel => { try { return fs.existsSync(path.join(base, resolve(rel, false))); } catch { return false; } };
  return { resolve, exists };
}

module.exports = { caseResolver, KNOWN };
