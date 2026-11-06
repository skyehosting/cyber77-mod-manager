'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A mod's picture is asked for again after this long, even when its version did not change.
const MAX_AGE = 30 * 24 * 3600e3;
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
// The only file names this cache writes (and so the only ones it reads back or removes).
const OWN_FILE = /^[a-z0-9]+-\d+-[0-9a-f]{10}\.(jpg|png|webp|gif)$/;
const TIMEOUT = 20e3;
/** A promise that gives up after `ms` (a hung answer must not hold a mod's picture forever). */
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => { const t = setTimeout(() => no(new Error(`${what} took longer than ${ms / 1000} s`)), ms); t.unref?.(); })]);
// Pictures come only from Nexus's own hosts (staticdelivery.nexusmods.com today).
const nexusHost = u => {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === 'https:' && (hostname === 'nexusmods.com' || hostname.endsWith('.nexusmods.com') || hostname.endsWith('.nexus-cdn.com'));
  } catch { return false; }
};

/**
 * The mods' Nexus pictures, kept in a folder of their own (the details panel shows them).
 * `index.json` records, per mod, the address each file came from and the mod version it was
 * checked for. A picture is asked for again when the version changes (a new version may bring a
 * new picture) or after 30 days, and downloaded again only when its address changed.
 */
class ModImages {
  constructor({ dir, nexus, log, fetch: fetchFn = globalThis.fetch }) {
    this.dir = dir;
    this.nexus = nexus;
    this.log = log;
    this.fetch = fetchFn;
    this.busy = new Map();
    this.failed = new Map(); // game:modId → when a download failed (tried again 10 minutes later)
    this.indexFile = path.join(dir, 'index.json');
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) || {}; } catch { this.index = {}; }
    if (typeof this.index !== 'object' || Array.isArray(this.index)) this.index = {};
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.indexFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.index));
      fs.renameSync(tmp, this.indexFile);
    } catch (err) { this.log?.warn?.('Could not save the mod picture index', err.message); }
  }

  /** The cached file of a mod's picture, if there is one (no network). */
  cached(game, modId) {
    const e = this.index[`${game}:${modId}`];
    if (!OWN_FILE.test(String(e?.file || ''))) return null;
    const file = path.join(this.dir, e.file);
    return fs.existsSync(file) ? { file, adult: !!e.adult } : null;
  }

  /**
   * A mod's picture: { file, adult } or null (no picture, or Nexus could not be reached and nothing
   * is cached). One fetch per mod at a time.
   */
  get(game, modId, version = '') {
    modId = Number(modId);
    if (!Number.isInteger(modId) || modId <= 0 || !/^[a-z0-9]+$/.test(String(game))) return Promise.resolve(null);
    const key = `${game}:${modId}`;
    if (this.busy.has(key)) return this.busy.get(key);
    const p = this.load(game, modId, String(version || '')).finally(() => this.busy.delete(key));
    this.busy.set(key, p);
    return p;
  }

  async load(game, modId, version) {
    const k = `${game}:${modId}`;
    const e = this.index[k];
    const have = this.cached(game, modId);
    const fresh = Date.now() - (e?.at || 0) < MAX_AGE;
    if (e && (have || e.none) && e.version === version && fresh) return have;
    // Fetched when its download finished (no version known then): that picture is the installed version's.
    if (e && have && e.version === '' && version && fresh) { e.version = version; this.save(); return have; }
    if (Date.now() - (this.failed.get(k) || 0) < 10 * 60e3) return have;
    let node;
    try {
      [node] = await within(this.nexus.modsByIds(game, [modId], 'pictureUrl adultContent'), TIMEOUT, 'Nexus');
    } catch (err) {
      this.log?.debug?.(`Mod picture: could not ask Nexus about mod ${modId}`, err.message);
      this.failed.set(k, Date.now());
      return have; // offline: the old picture is still right more often than not
    }
    const url = String(node?.pictureUrl || '');
    const adult = !!node?.adultContent;
    if (!url || !nexusHost(url)) {
      this.drop(k);
      this.index[k] = { none: true, version, at: Date.now() };
      this.save();
      return null;
    }
    if (have && e.url === url) {
      Object.assign(e, { version, adult, at: Date.now() });
      this.save();
      return { file: have.file, adult };
    }
    const file = await this.download(`${game}-${modId}`, url);
    if (!file) { this.failed.set(k, Date.now()); return have; }
    this.failed.delete(k);
    this.drop(k, file);
    this.index[k] = { url, file: path.basename(file), version, adult, at: Date.now() };
    this.save();
    return { file, adult };
  }

  /** Downloads one picture into the folder (`name` starts the file name); its path, or null. */
  async download(name, url) {
    try {
      // Redirects are followed by hand, each checked before it is asked: only Nexus hosts, at most 3.
      let at = url;
      let res;
      for (let hop = 0; ; hop++) {
        if (!nexusHost(at)) throw new Error('not a Nexus address');
        res = await this.fetch(at, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
        const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : '';
        if (!next) break;
        res.body?.cancel?.().catch(() => {}); // the redirect's own body is not needed
        if (hop >= 3) throw new Error('too many redirects');
        at = new URL(next, at).href;
      }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = TYPES[type];
      if (!ext) throw new Error(`not a picture (${type || 'no type'})`);
      if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('larger than 10 MB');
      const buf = await readCapped(res, MAX_BYTES);
      if (!buf.length) throw new Error('empty');
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${name}-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 10)}${ext}`);
      fs.writeFileSync(`${file}.part`, buf);
      fs.renameSync(`${file}.part`, file);
      return file;
    } catch (err) {
      this.log?.debug?.(`Mod picture ${name} was not downloaded`, err.message);
      return null;
    }
  }

  /** Removes a mod's old picture file (unless it is `keep`). */
  drop(k, keep = '') {
    const old = this.index[k]?.file;
    if (!OWN_FILE.test(String(old || ''))) return;
    const file = path.join(this.dir, old);
    if (file !== keep) fs.rm(file, { force: true }, () => {});
  }
}

/** The answer's body, read in pieces and given up past `max` bytes (a size header can be missing or wrong). */
async function readCapped(res, max) {
  if (!res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Error('larger than 10 MB');
    return buf;
  }
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { reader.cancel().catch(() => {}); throw new Error('larger than 10 MB'); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

module.exports = { ModImages, nexusHost };
