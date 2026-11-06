'use strict';
/*
 * mod.io, the second place to get Cyberpunk 2077 mods (CD PROJEKT RED's official mod.io game).
 *
 * Read only, with the user's own API key and API path from mod.io/me/access (mod.io's API Access
 * Terms: a key is kept secure and used only by its own account, so this app never ships one).
 * Requests stay well under mod.io's limit (60 a minute for a user's key), lists are cached for a
 * short while, and a 429 is waited out, never retried in a loop. Mods are listed only when they
 * have a Windows file (mod.io keeps one file per platform; Linux plays the Windows game).
 */

const GAME_ID = 5784; // Cyberpunk 2077 on mod.io (name_id cyberpunk-2077)
const DEFAULT_BASE = 'https://api.mod.io/v1';
const SITE = 'https://mod.io/g/cyberpunk-2077';
const PER_MINUTE = 50; // mod.io allows 60 a minute for a user's key: some room for the user's other tools
const LIST_TTL = 2 * 60e3;
const GAME_TTL = 24 * 3600e3;
const MAX_LIST = 500; // mods read for one search (100 a request); the whole game has fewer today
// Tests and demos only: a stand-in mod.io on this PC (set by whoever starts the app; never saved).
const TEST_BASE = /^http:\/\/127\.0\.0\.1:\d{2,5}\/v1$/.test(process.env.CMM_MODIO_BASE || '') ? process.env.CMM_MODIO_BASE : '';

/** mod.io's API addresses: its main one and the per-game / per-user ones it gives out (https only). */
const API_PATH = /^https:\/\/(api\.mod\.io|[a-z]-\d{1,12}\.modapi\.io)\/v1$/;
function cleanApiPath(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!API_PATH.test(s)) throw new Error('That is not a mod.io API path. Copy it from mod.io/me/access: it looks like https://u-12345678.modapi.io/v1.');
  return s;
}

/** An address on mod.io's own servers (https), where files may be downloaded from (and redirected to). */
function onModio(u) {
  try {
    const url = new URL(String(u || ''));
    if (TEST_BASE && url.origin === new URL(TEST_BASE).origin) return true;
    return url.protocol === 'https:' && /(^|\.)(mod\.io|modapi\.io|modcdn\.io)$/.test(url.hostname);
  } catch { return false; }
}

/** A picture on mod.io's image servers (https), or ''. */
function cdnUrl(u) {
  try {
    const url = new URL(String(u || ''));
    return url.protocol === 'https:' && /(^|\.)modcdn\.io$/.test(url.hostname) ? url.href : '';
  } catch { return ''; }
}

/** A page on mod.io itself, or the game's page. */
function siteUrl(u) {
  try {
    const url = new URL(String(u || ''));
    return url.protocol === 'https:' && url.hostname === 'mod.io' ? url.href : SITE;
  } catch { return SITE; }
}

// The site's sorts, as mod.io's API names them (descending with '-').
const SORTS = {
  trending: '-downloads_today',
  recent: '-date_live',
  updated: '-date_updated',
  popular: '-downloads_total',
  subscribers: '-subscribers_total',
  rated: '-ratings_weighted_aggregate',
  name: 'name',
};
const PERIOD_DAYS = { day: 1, week: 7, month: 31, quarter: 92, year: 366 };

class ModioError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** The live Windows file of a mod (its id), or 0. A mod without platform files has one file for all. */
function windowsFile(m) {
  const plats = Array.isArray(m.platforms) ? m.platforms : [];
  if (!plats.length) return Number(m.modfile?.id) || 0;
  return Number(plats.find(p => p.platform === 'windows')?.modfile_live) || 0;
}

/** A mod as the Browse page shows it (only what it needs, checked). */
function card(m) {
  const stats = m.stats || {};
  return {
    id: Number(m.id), nameId: String(m.name_id || ''), name: String(m.name || '').slice(0, 200),
    author: String(m.submitted_by?.username || '').slice(0, 80), summary: String(m.summary || '').slice(0, 600),
    logo: cdnUrl(m.logo?.thumb_640x360 || m.logo?.thumb_320x180 || m.logo?.original),
    tags: (Array.isArray(m.tags) ? m.tags : []).map(t => String(t?.name || '')).filter(Boolean).slice(0, 40),
    downloads: Number(stats.downloads_total) || 0, subscribers: Number(stats.subscribers_total) || 0,
    rating: Number(stats.ratings_percentage_positive) || 0, ratings: (Number(stats.ratings_positive) || 0) + (Number(stats.ratings_negative) || 0),
    updatedAt: (Number(m.date_updated) || 0) * 1000, liveAt: (Number(m.date_live) || 0) * 1000,
    mature: Number(m.maturity_option) > 0, fileId: windowsFile(m), url: siteUrl(m.profile_url),
    version: String(m.modfile?.version || '').slice(0, 60), size: Number(m.modfile?.filesize) || 0,
  };
}

/** Plain text of a mod's description (mod.io gives HTML; the page shows text only). */
function plainText(m) {
  if (typeof m.description_plaintext === 'string' && m.description_plaintext.trim()) return m.description_plaintext.slice(0, 20000);
  return String(m.description || '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
}

class ModioClient {
  /** getKey(): the user's API key; getBase(): their API path ('' = mod.io's main one). */
  constructor({ getKey, getBase, log, fetchImpl = (...a) => fetch(...a) }) {
    this.getKey = getKey;
    this.getBase = getBase;
    this.log = log;
    this.fetch = fetchImpl;
    this.cache = new Map();
    this.recent = []; // times of the last requests (a minute's worth)
    this.blockedUntil = 0; // after a 429: no requests before this
  }

  get hasKey() { return !!this.getKey(); }

  async request(pathname, query = {}) {
    const key = this.getKey();
    if (!key) throw new ModioError('Add your mod.io API key in Settings → mod.io first.', 0);
    if (Date.now() < this.blockedUntil) throw Object.assign(new ModioError(`mod.io asked to wait: try again in ${Math.ceil((this.blockedUntil - Date.now()) / 1000)} s.`, 429), { retryAt: this.blockedUntil });
    // Stay under the limit: each request takes its slot at once (requests started together are spread
    // out too), at the earliest time the minute before it holds fewer than PER_MINUTE.
    const now = Date.now();
    this.recent = this.recent.filter(t => t > now - 60e3);
    const at = this.recent.length >= PER_MINUTE ? Math.max(now, this.recent[this.recent.length - PER_MINUTE] + 60e3 + 50) : now;
    this.recent.push(at);
    if (at > now) await new Promise(r => setTimeout(r, at - now));
    // mod.io may have asked to wait while this one waited for its slot.
    if (Date.now() < this.blockedUntil) throw Object.assign(new ModioError(`mod.io asked to wait: try again in ${Math.ceil((this.blockedUntil - Date.now()) / 1000)} s.`, 429), { retryAt: this.blockedUntil });
    // The API path is checked again on every use (settings.json can be edited by hand): the key only ever goes to mod.io.
    let base = DEFAULT_BASE;
    try { base = TEST_BASE || cleanApiPath(this.getBase()) || DEFAULT_BASE; } catch { throw new ModioError('The mod.io API path in Settings is not one of mod.io\'s addresses: fix it in Settings → mod.io.', 0); }
    const params = new URLSearchParams({ ...query, api_key: key });
    let res;
    try {
      res = await this.fetch(`${base}${pathname}?${params}`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20e3) });
    } catch (err) {
      throw new ModioError(`Could not reach mod.io (${err.name === 'TimeoutError' ? 'no answer in 20 s' : err.message}).`, 0);
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 60;
      this.blockedUntil = Date.now() + Math.min(wait || 60, 3600) * 1000;
      throw Object.assign(new ModioError(`mod.io asked to slow down: try again in ${wait || 60} s.`, 429), { retryAt: this.blockedUntil });
    }
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = String(body?.error?.message || '').slice(0, 300);
      const hints = {
        401: 'mod.io did not accept the API key. Check it (and the API path) in Settings → mod.io.',
        403: 'mod.io refused this request (403).',
        404: 'Not found on mod.io (404): the mod or file may have been removed.',
      };
      throw new ModioError(`${hints[res.status] || `mod.io error ${res.status}`}${msg && res.status !== 401 ? ` (${msg})` : ''}`, res.status);
    }
    return body || {};
  }

  async cached(k, ttl, fn) {
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await fn();
    this.cache.set(k, { at: Date.now(), value });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  /** The game's tag groups (Gameplay, Characters…, Languages), with counts; hidden ones left out. */
  async tags() {
    return this.cached('game', GAME_TTL, async () => {
      const g = await this.request(`/games/${GAME_ID}`);
      return (Array.isArray(g.tag_options) ? g.tag_options : []).filter(t => !t.hidden).map(t => ({
        name: String(t.name || ''),
        tags: (Array.isArray(t.tags) ? t.tags : []).map(String).map(name => ({ name, count: Number(t.tag_count_map?.[name]) || 0 })),
      }));
    });
  }

  /**
   * One page of mods with a Windows file. mod.io filters and sorts; the list is read whole (the game
   * has a few hundred mods at most) so pages count only mods this app can install.
   */
  async search({ query = '', tag = '', lang = '', sort = 'trending', period = '', page = 1, perPage = 20 } = {}) {
    const q = { _sort: SORTS[sort] || SORTS.trending, _limit: '100' };
    if (query) q._q = String(query).slice(0, 100);
    const tags = [tag, lang].map(t => String(t || '').slice(0, 100)).filter(Boolean);
    if (tags.length) q.tags = tags.join(',');
    if (PERIOD_DAYS[period]) q['date_live-min'] = String(Math.floor(Date.now() / 1000) - PERIOD_DAYS[period] * 86400);
    const all = await this.cached(`list:${JSON.stringify(q)}`, LIST_TTL, async () => {
      const out = [];
      for (let offset = 0; offset < MAX_LIST; offset += 100) {
        const r = await this.request(`/games/${GAME_ID}/mods`, { ...q, _offset: String(offset) });
        const data = Array.isArray(r.data) ? r.data : [];
        out.push(...data);
        if (data.length < 100 || out.length >= (Number(r.result_total) || 0)) break;
      }
      return out.map(card).filter(m => m.fileId);
    });
    const per = [20, 40, 60, 80].includes(Number(perPage)) ? Number(perPage) : 20;
    const pages = Math.max(1, Math.ceil(all.length / per));
    const p = Math.min(Math.max(1, Number(page) || 1), pages);
    return { mods: all.slice((p - 1) * per, p * per), total: all.length, page: p, perPage: per };
  }

  /** One mod for its page: pictures, description, its Windows file and what it needs. */
  async mod(id) {
    const modId = Number(id);
    if (!(modId > 0)) throw new ModioError('Not a mod.io mod.', 0);
    return this.cached(`mod:${modId}`, LIST_TTL, async () => {
      const m = await this.request(`/games/${GAME_ID}/mods/${modId}`);
      const c = card(m);
      const [file, deps] = await Promise.all([
        c.fileId ? this.file(modId, c.fileId).catch(() => null) : null,
        this.dependencies(modId).catch(() => []),
      ]);
      const images = (Array.isArray(m.media?.images) ? m.media.images : []).map(i => cdnUrl(i.thumb_1280x720 || i.original)).filter(Boolean).slice(0, 30);
      return { ...c, description: plainText(m), images, file, dependencies: deps };
    });
  }

  /** A file of a mod: its version, size and checksum (no download address: that is asked for fresh). */
  async file(modId, fileId) {
    const f = await this.request(`/games/${GAME_ID}/mods/${Number(modId)}/files/${Number(fileId)}`);
    return {
      id: Number(f.id), modId: Number(f.mod_id) || Number(modId), fileName: String(f.filename || `${fileId}.zip`).slice(0, 200),
      version: String(f.version || '').slice(0, 60), size: Number(f.filesize) || 0, md5: /^[a-f0-9]{32}$/i.test(f.filehash?.md5 || '') ? f.filehash.md5.toLowerCase() : '',
      added: (Number(f.date_added) || 0) * 1000, changelog: String(f.changelog || '').replace(/<[^>]+>/g, '').slice(0, 4000),
      virusStatus: Number(f.virus_status) || 0, virusPositive: Number(f.virus_positive) || 0,
    };
  }

  /** A mod's files for PC, newest first: [{ id, version, fileName, size, added, changelog, live }]. */
  async files(modId) {
    const id = Number(modId);
    const [m, r] = await Promise.all([this.mod(id), this.request(`/games/${GAME_ID}/mods/${id}/files`, { _sort: '-date_added', _limit: '50' })]);
    const pc = f => {
      const plats = Array.isArray(f.platforms) ? f.platforms : [];
      return !plats.length || plats.some(p => p.platform === 'windows' && Number(p.status) !== 2); // 2: denied
    };
    return (Array.isArray(r.data) ? r.data : []).filter(pc).map(f => ({
      id: Number(f.id), version: String(f.version || '').slice(0, 60), fileName: String(f.filename || '').slice(0, 200),
      size: Number(f.filesize) || 0, added: (Number(f.date_added) || 0) * 1000, changelog: String(f.changelog || '').replace(/<[^>]+>/g, '').slice(0, 2000),
      virusPositive: Number(f.virus_positive) || 0, live: Number(f.id) === m.fileId,
    })).filter(f => f.id > 0);
  }

  /** Where to download a file right now (mod.io's address can expire, so it is never kept). */
  async downloadUrl(modId, fileId) {
    const f = await this.request(`/games/${GAME_ID}/mods/${Number(modId)}/files/${Number(fileId)}`);
    const url = String(f.download?.binary_url || '');
    const final = msg => Object.assign(new ModioError(msg, 0), { fatal: true });
    if (!onModio(url)) throw final('mod.io gave no download address on mod.io for this file; it was not used.');
    if (Number(f.virus_positive) === 1) throw final('mod.io\'s virus scan flagged this file as malicious; it was not downloaded.');
    return { url: new URL(url).href, md5: /^[a-f0-9]{32}$/i.test(f.filehash?.md5 || '') ? f.filehash.md5.toLowerCase() : '', size: Number(f.filesize) || 0, checkUrl: onModio };
  }

  /** The mods a mod needs (all levels mod.io lists), as cards; ones without a Windows file are marked. */
  async dependencies(modId) {
    const r = await this.request(`/games/${GAME_ID}/mods/${Number(modId)}/dependencies`, { recursive: 'true' });
    const list = Array.isArray(r.data) ? r.data : [];
    return list.slice(0, 50).map(d => ({ id: Number(d.mod_id || d.id), name: String(d.name || '').slice(0, 200), fileId: windowsFile(d), url: siteUrl(d.profile_url) }))
      .filter(d => d.id > 0);
  }

  /** The current Windows file of each mod (id → card), for update checks: one request per 100 mods. */
  async current(ids) {
    const list = [...new Set(ids.map(Number).filter(n => n > 0))];
    const out = new Map();
    for (let i = 0; i < list.length; i += 100) {
      const r = await this.request(`/games/${GAME_ID}/mods`, { 'id-in': list.slice(i, i + 100).join(','), _limit: '100' });
      for (const m of Array.isArray(r.data) ? r.data : []) out.set(Number(m.id), card(m));
    }
    return out;
  }
}

module.exports = { ModioClient, ModioError, cleanApiPath, cdnUrl, siteUrl, onModio, windowsFile, card, plainText, GAME_ID, SITE, SORTS };
