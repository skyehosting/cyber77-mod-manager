'use strict';
const fs = require('fs');
const path = require('path');

/*
 * Archive load order. The game loads the .archive files in archive/pc/mod in ASCII order of their
 * names, or in the order of archive/pc/mod/modlist.txt when that file exists. When two archives
 * change the same thing, the one loaded FIRST wins. REDmods load after all of these.
 *
 * Auto-sort puts every mod that needs another mod above the mod it needs (so an add-on or patch
 * wins over the framework or mod it changes), and otherwise keeps the order there is now.
 * The list written to modlist.txt always names every archive, so nothing depends on how the game
 * treats unlisted ones.
 */

const MOD_DIR = ['archive', 'pc', 'mod'];
const ascii = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function archiveDir(gameDir) { return path.join(gameDir, ...MOD_DIR); }
function modlistFile(gameDir) { return path.join(archiveDir(gameDir), 'modlist.txt'); }

/** The .archive files there are now, by name. */
function listArchives(gameDir) {
  try {
    return fs.readdirSync(archiveDir(gameDir), { withFileTypes: true })
      .filter(e => e.isFile() && /\.archive$/i.test(e.name)).map(e => e.name);
  } catch {
    return [];
  }
}

/** The order the game uses now: modlist.txt's names first (those that exist), then the rest. */
function currentOrder(gameDir) {
  const names = listArchives(gameDir);
  const have = new Set(names);
  let listed = [];
  try {
    listed = fs.readFileSync(modlistFile(gameDir), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(n => n && have.has(n));
  } catch { /* no modlist: alphabetical */ }
  const seen = new Set(listed);
  return { custom: listed.length > 0, order: [...new Set(listed), ...names.filter(n => !seen.has(n)).sort(ascii)] };
}

/**
 * A saved order with archives added since put where they would sort by name among the others,
 * and archives that are gone left out.
 */
function mergeOrder(saved, names) {
  const have = new Set(names);
  const out = saved.filter(n => have.has(n));
  const known = new Set(out);
  for (const n of names.filter(x => !known.has(x)).sort(ascii)) {
    const at = out.findIndex(x => ascii(x, n) > 0);
    if (at < 0) out.push(n); else out.splice(at, 0, n);
  }
  return out;
}

/**
 * Requirements first-loaded: each archive whose mod needs another mod goes above every archive of
 * the mod it needs. Kahn's algorithm, taking the next archive in the current order whenever there
 * is a choice; a loop (A needs B needs A) falls back to the current order.
 * owner: archive name → mod key; needs: mod key → [mod keys it requires].
 */
function autoSort(order, owner, needs) {
  const before = new Map(order.map(n => [n, new Set()])); // n must come after each of these
  for (const a of order) {
    const ma = owner.get(a);
    if (!ma) continue;
    for (const req of needs.get(ma) || []) {
      for (const b of order) if (b !== a && owner.get(b) === req) before.get(b).add(a); // a above b
    }
  }
  const out = [];
  const done = new Set();
  while (out.length < order.length) {
    const ready = order.filter(n => !done.has(n) && [...before.get(n)].every(x => done.has(x)));
    const next = ready.length ? ready[0] : order.find(n => !done.has(n)); // a loop: keep the current order
    done.add(next);
    out.push(next);
  }
  return out;
}

/** Write modlist.txt naming every archive (the previous one is kept once as a backup). */
function writeOrder(gameDir, order) {
  const file = modlistFile(gameDir);
  const names = listArchives(gameDir);
  const full = mergeOrder(order, names);
  if (fs.existsSync(file) && !fs.existsSync(`${file}.cmm-backup`)) fs.copyFileSync(file, `${file}.cmm-backup`);
  fs.writeFileSync(`${file}.tmp`, `${full.join('\r\n')}\r\n`);
  fs.renameSync(`${file}.tmp`, file);
  return full;
}

/** Back to the game's default (alphabetical): modlist.txt goes. */
function resetOrder(gameDir) {
  try { fs.unlinkSync(modlistFile(gameDir)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

module.exports = { listArchives, currentOrder, mergeOrder, autoSort, writeOrder, resetOrder, modlistFile, ascii };
