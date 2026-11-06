'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { readSave, SLOT, appSavesHome, needDir, hashFile, SAVES_UNKNOWN } = require('./saves');

/*
 * The Saves page's Trash: a deleted save is moved here, not removed. Each one is a folder of its own:
 *   <Trash>\<item id>\item.json      where it came from and when it was deleted
 *   <Trash>\<item id>\<slot>\…        the save folder itself, as it was
 * Same drive as the game's saves (Saved Games\Edgerunners Mod Manager\Trash), so a delete and a
 * restore are renames. Nothing leaves the Trash for good until the user deletes it forever or purges
 * the bin. An item whose item.json is missing (cut off half way) still lists, from its save.
 */

const ITEM_ID = /^[a-z0-9]{6,16}-[a-f0-9]{8}$/;
const MAX_ITEMS = 5000;

function defaultTrashDir() {
  if (process.env.CMM_SAVES_TRASH_DIR !== undefined) return process.env.CMM_SAVES_TRASH_DIR;
  const home = appSavesHome();
  return home ? path.join(home, 'Trash') : '';
}

const slotsIn = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && SLOT.test(e.name)).map(e => e.name); } catch { return []; } };
const savHash = async dir => { try { return await hashFile(path.join(dir, 'sav.dat')); } catch { return ''; } };

/** `slot` if free in `taken`, else the next free ManualSave number. */
function freeName(slot, taken) {
  if (!taken.has(slot)) return slot;
  let n = Math.max(0, ...[...taken].map(s => s.match(SLOT)).filter(m => m && m[1] === 'ManualSave').map(m => Number(m[2]))) + 1;
  while (taken.has(`ManualSave-${n}`)) n++;
  return `ManualSave-${n}`;
}

/** A rename; across drives a copy under a temporary name, renamed when whole, then the original goes. */
async function safeMove(src, dst) {
  try { await fsp.rename(src, dst); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const tmp = path.join(path.dirname(dst), `.${path.basename(dst)}.moving`);
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.cp(src, tmp, { recursive: true, preserveTimestamps: true });
    await fsp.rename(tmp, dst);
    await fsp.rm(src, { recursive: true, force: true });
  }
}

const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

class SaveTrash {
  constructor({ root = defaultTrashDir, log } = {}) {
    this.root = () => needDir(root(), 'There is no folder for deleted saves.');
    this.log = log;
  }

  dirOf(id) {
    if (!ITEM_ID.test(String(id))) throw new Error('No such deleted save.');
    return path.join(this.root(), String(id));
  }

  /** The save folder inside an item (the one slot folder it holds), or ''. */
  slotOf(id) {
    const slots = slotsIn(this.dirOf(id));
    return slots.length === 1 ? slots[0] : '';
  }

  /** Every deleted save, newest deletion first (read again only when the Trash folder changed). */
  list() {
    let root;
    try { root = this.root(); } catch { return []; }
    let stamp = '';
    try { stamp = `${root}:${fs.statSync(root).mtimeMs}`; } catch { return []; }
    if (this.cache?.stamp === stamp) return this.cache.list.map(x => ({ ...x, from: { ...x.from } }));
    const out = this.read(root);
    this.cache = { stamp, list: out };
    return out.map(x => ({ ...x, from: { ...x.from } }));
  }

  read(root) {
    let names;
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && ITEM_ID.test(e.name)).map(e => e.name); } catch { return []; }
    const out = [];
    for (const id of names.slice(0, MAX_ITEMS)) {
      const dir = path.join(root, id);
      const slot = this.slotOf(id);
      if (!slot) continue;
      const save = readSave(dir, slot);
      if (!save) continue;
      let info = {};
      try { info = JSON.parse(fs.readFileSync(path.join(dir, 'item.json'), 'utf8')) || {}; } catch { /* listed from the save alone */ }
      let at = Number(info.at) || 0;
      if (!at) { try { at = fs.statSync(dir).mtimeMs; } catch { at = save.time; } }
      const { files, screenshot, ...s } = save;
      out.push({
        id, at, ...s,
        from: { profile: str(info.from?.profile, 40), name: str(info.from?.name, 80), game: info.from?.game === true },
        slot: str(info.slot, 40) || slot,
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** How much the Trash holds on disk (bytes). */
  size() { return this.list().reduce((n, x) => n + (x.size || 0), 0); }

  /**
   * Move a save folder (dir\slot) into the Trash. from: { profile, name, game }. Returns the item id.
   * item.json is written before the move, so a crash leaves either the save where it was (and an empty
   * item, swept by the next list) or the save in the Trash with its record.
   */
  async put(dir, slot, from = {}) {
    if (!SLOT.test(String(slot))) throw new Error('No such save.');
    const src = path.join(needDir(dir, SAVES_UNKNOWN), slot);
    if (!fs.existsSync(path.join(src, 'sav.dat'))) throw new Error(`${slot} is not there any more.`);
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const item = path.join(this.root(), id);
    await fsp.mkdir(item, { recursive: true });
    const record = { at: Date.now(), slot, from: { profile: str(from.profile, 40), name: str(from.name, 80), game: from.game === true } };
    await fsp.writeFile(path.join(item, 'item.json'), JSON.stringify(record, null, 2));
    const dst = path.join(item, slot);
    try {
      await fsp.rename(src, dst);
      this.cache = null;
      return id;
    } catch (err) {
      if (err.code !== 'EXDEV') { await fsp.rm(item, { recursive: true, force: true }).catch(() => {}); throw err; }
    }
    // Another drive: a whole copy first (under a temporary name), then the original goes. Once the copy is
    // whole it is never removed: if the original can't be removed (a locked file), the Trash keeps the copy.
    const tmp = path.join(item, `.${slot}.moving`);
    try {
      await fsp.cp(src, tmp, { recursive: true, preserveTimestamps: true });
      await fsp.rename(tmp, dst);
    } catch (err) {
      await fsp.rm(item, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    try {
      await fsp.rm(src, { recursive: true, force: true });
    } catch (err) {
      this.log?.warn?.(`${slot} is in the Trash, but its original could not be removed (${err.code || err.message}). Remove it by hand when nothing uses it.`);
    }
    this.cache = null;
    return id;
  }

  /**
   * Put a deleted save back into a folder. The same save already there (same sav.dat): nothing is
   * copied, the item just leaves the Trash. A slot name taken there: the next free ManualSave number.
   * Returns { slot, present }.
   */
  async restore(id, toDir) {
    this.cache = null;
    const dir = this.dirOf(id);
    const slot = this.slotOf(id);
    if (!slot) throw new Error('That deleted save is damaged or gone.');
    await fsp.mkdir(needDir(toDir, SAVES_UNKNOWN), { recursive: true });
    const h = await savHash(path.join(dir, slot));
    for (const s of slotsIn(toDir)) {
      if (h && await savHash(path.join(toDir, s)) === h) {
        await fsp.rm(dir, { recursive: true, force: true });
        return { slot: s, present: true };
      }
    }
    const name = freeName(slot, new Set(slotsIn(toDir)));
    await safeMove(path.join(dir, slot), path.join(toDir, name));
    await fsp.rm(dir, { recursive: true, force: true });
    return { slot: name, present: false };
  }

  /** Delete items for good: a list of ids, or 'all'. Returns { removed, freed } (bytes). */
  async purge(ids) {
    this.cache = null;
    const items = this.list();
    const want = ids === 'all' ? items : items.filter(x => new Set((Array.isArray(ids) ? ids : []).map(String)).has(x.id));
    let freed = 0;
    let removed = 0;
    for (const x of want) {
      await fsp.rm(this.dirOf(x.id), { recursive: true, force: true });
      freed += x.size || 0;
      removed++;
    }
    // Leftovers of a delete cut off half way (an item folder with no save in it).
    try {
      for (const e of fs.readdirSync(this.root(), { withFileTypes: true })) {
        const inside = e.isDirectory() && ITEM_ID.test(e.name) ? fs.readdirSync(path.join(this.root(), e.name), { withFileTypes: true }) : null;
        if (inside && !inside.some(d => d.isDirectory()) && !want.some(x => x.id === e.name)) {
          const age = Date.now() - fs.statSync(path.join(this.root(), e.name)).mtimeMs;
          if (age > 60e3) await fsp.rm(path.join(this.root(), e.name), { recursive: true, force: true });
        }
      }
    } catch { /* nothing to sweep */ }
    this.cache = null;
    return { removed, freed };
  }

  /** The deleted save's screenshot file, or ''. */
  screenshot(id) {
    const slot = this.slotOf(id);
    return slot ? path.join(this.dirOf(id), slot, 'screenshot.png') : '';
  }
}

module.exports = { SaveTrash, defaultTrashDir, ITEM_ID };
