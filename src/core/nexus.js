'use strict';
const API = 'https://api.nexusmods.com/v1';
const GRAPHQL = 'https://api.nexusmods.com/v2/graphql';
// Nexus's GraphQL answers at most 20 mods per request (it reports more found, but returns 20): asking
// for more left the rest out, and those were taken as mods with no requirements.
const GRAPHQL_PAGE = 20;
/** A Nexus category name as shown: one line, no control characters, at most 80 characters. */
const categoryName = v => String(v || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 80);
/** Browse's "Adult (18+)" entry: only mods flagged as adult content. */
const ADULT_ONLY = '__adult';
// Browse's time filter: how many days back each choice reaches.
const PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const APP_NAME = 'CyberModManager';
const APP_VERSION = '1.0.0';

class NexusError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Parse a Nexus Mods link into { game, modId }.
 * Accepts e.g. https://www.nexusmods.com/cyberpunk2077/mods/107?tab=files
 */
function parseModUrl(input) {
  const text = String(input || '').trim();
  // Any Nexus mod page: www./next./no host prefix, /games/, any tab, with or without a scheme.
  const m = text.match(/nexusmods\.com\/(?:games\/)?([a-z0-9_-]+)\/mods\/(\d+)/i);
  if (!m) return null;
  // A link to one file (…?tab=files&file_id=123) pre-selects that file.
  const f = text.match(/[?&](?:file_id|id)=(\d+)/i);
  return { game: m[1].toLowerCase(), modId: Number(m[2]), fileId: f ? Number(f[1]) : 0 };
}

/**
 * A requirement listed as "off-site" whose link is a mod page on Nexus for the same game is that
 * Nexus mod: authors do this ("CET (No REDMOD version)" linking to mods/107). Takes and returns
 * { modId, url, external, … }.
 */
function requirementOnNexus(req, game) {
  if (!req?.external) return req;
  // A link that IS on Nexus (not one that only mentions a Nexus address somewhere in it).
  if (!/^https?:\/\/(www\.|next\.)?nexusmods\.com\//i.test(req.url || '')) return req;
  const p = parseModUrl(req.url);
  return p && p.game === game && p.modId ? { ...req, modId: p.modId, external: false } : req;
}

/**
 * A Nexus "Mod Manager Download" link:
 *   nxm://cyberpunk2077/mods/107/files/123456?key=…&expires=…&user_id=…
 * The key and expiry let any account (Premium or not) get that one file's download link.
 */
function parseNxm(input) {
  const m = String(input || '').match(/^nxm:\/\/([a-z0-9_-]+)\/mods\/(\d+)\/files\/(\d+)(?:\?(.*))?$/i);
  if (!m) return null;
  const q = new URLSearchParams(m[4] || '');
  return { game: m[1].toLowerCase(), modId: Number(m[2]), fileId: Number(m[3]), key: q.get('key') || '', expires: q.get('expires') || '' };
}

/** Thin client for the Nexus Mods public v1 API (header auth with `apikey`). */
class NexusClient {
  constructor(getKey, log) {
    this.getKey = getKey;
    this.log = log;
    this.rate = { hourly: null, daily: null };
  }

  async request(pathname) {
    const key = this.getKey();
    if (!key) throw new NexusError('No Nexus Mods API key set. Add it on the Settings page.', 0);
    let res;
    try {
      res = await fetch(`${API}${pathname}`, {
        headers: {
          apikey: key,
          Accept: 'application/json',
          'Application-Name': APP_NAME,
          'Application-Version': APP_VERSION,
        },
      });
    } catch (err) {
      throw new NexusError(`Network error calling Nexus API: ${err.message}`, 0);
    }
    const hourly = res.headers.get('x-rl-hourly-remaining');
    const daily = res.headers.get('x-rl-daily-remaining');
    if (hourly !== null) this.rate = { hourly: Number(hourly), daily: Number(daily) };

    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* body not JSON */ }
      const hints = {
        401: 'API key rejected (401). Check the key on the Settings page.',
        403: 'Forbidden (403). Without Premium, Nexus gives a download only after a click on "Slow download".',
        404: 'Not found (404). Check the mod link.',
        429: 'Rate limit reached (429). Nexus allows 20,000 requests a day / 500 an hour after that.',
      };
      throw new NexusError(`${hints[res.status] || `Nexus API error ${res.status}`}${msg ? ` — ${msg}` : ''}`, res.status);
    }
    return res.json();
  }

  validate() { return this.request('/users/validate.json'); }

  getMod(game, modId) { return this.request(`/games/${game}/mods/${modId}.json`); }

  getFiles(game, modId) { return this.request(`/games/${game}/mods/${modId}/files.json`); }

  /**
   * Many mods' nodes from legacyModsByDomain (`fields`: what to read of each), GRAPHQL_PAGE a request.
   * If an answer still says it found more than it returned (the page got smaller), the ones left out
   * are asked again, fewer at a time: a mod is only missing when Nexus does not have it.
   */
  async modsByIds(game, modIds, fields) {
    const nodes = [];
    const ask = async ids => {
      const data = await this.graphql(`query($ids: [CompositeDomainWithIdInput!]!) {
        legacyModsByDomain(ids: $ids) { totalCount nodes { modId ${fields} } } }`,
      { ids: ids.map(modId => ({ gameDomain: game, modId })) }, 'read requirements');
      const got = data.legacyModsByDomain?.nodes || [];
      nodes.push(...got);
      const found = Number(data.legacyModsByDomain?.totalCount) || 0;
      if (found > got.length && ids.length > 1) {
        const have = new Set(got.map(n => Number(n.modId)));
        const left = ids.filter(id => !have.has(id));
        const step = Math.max(1, Math.floor(got.length / 2) || 1);
        for (let i = 0; i < left.length; i += step) await ask(left.slice(i, i + step));
      }
    };
    const ids = [...new Set(modIds.map(Number).filter(n => n > 0))];
    for (let i = 0; i < ids.length; i += GRAPHQL_PAGE) await ask(ids.slice(i, i + GRAPHQL_PAGE));
    return nodes;
  }

  /** Which mods each of these mods requires (Nexus ids), many at once: Map modId → [modId]. */
  async getRequirementsMany(game, modIds) {
    const out = new Map();
    for (const n of await this.modsByIds(game, modIds, 'modRequirements { nexusRequirements { nodes { modId url externalRequirement } } }')) {
      out.set(Number(n.modId), (n.modRequirements?.nexusRequirements?.nodes || [])
        .map(r => requirementOnNexus({ modId: Number(r.modId) || 0, url: r.url || '', external: !!r.externalRequirement }, game))
        .filter(r => !r.external).map(r => r.modId).filter(Boolean));
    }
    return out;
  }

  /**
   * Every requirement of many mods at once, with names and links (the Mods page lists them):
   * Map modId → [{ modId, name, url, notes, external }]. Public data: no API key needed.
   * `cats` (a Map), if given, gets each mod's Nexus category name (modId → "Appearance") from the same answer.
   */
  async requirementsMany(game, modIds, cats = null) {
    const out = new Map();
    for (const n of await this.modsByIds(game, modIds, 'modCategory { name } modRequirements { nexusRequirements { nodes { modId modName url notes externalRequirement } } }')) {
      cats?.set(Number(n.modId), categoryName(n.modCategory?.name));
      out.set(Number(n.modId), (n.modRequirements?.nexusRequirements?.nodes || []).map(r => requirementOnNexus({
        modId: Number(r.modId) || 0, name: String(r.modName || '').slice(0, 200), url: /^https?:\/\//i.test(r.url || '') ? r.url : '',
        notes: String(r.notes || '').slice(0, 300), external: !!r.externalRequirement,
      }, game)));
    }
    return out;
  }

  /**
   * Nexus requirements of a mod, from the v2 GraphQL API (v1 has no requirements endpoint).
   * Returns [{ modId, modName, gameId, url, notes, external }] plus the mod's own gameId.
   */
  async getRequirements(game, modId) {
    const query = `query($ids: [CompositeDomainWithIdInput!]!) {
      legacyModsByDomain(ids: $ids) { nodes { modId gameId modRequirements {
        nexusRequirements { nodes { modId modName gameId url notes externalRequirement } } } } } }`;
    let res;
    try {
      res = await fetch(GRAPHQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.getKey(), 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION },
        body: JSON.stringify({ query, variables: { ids: [{ gameDomain: game, modId: Number(modId) }] } }),
      });
    } catch (err) {
      throw new NexusError(`Network error reading requirements: ${err.message}`, 0);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors?.length) {
      throw new NexusError(`Could not read requirements (${res.status}): ${body.errors?.[0]?.message || res.statusText}`, res.status);
    }
    const node = body.data?.legacyModsByDomain?.nodes?.[0];
    if (!node) return { gameId: null, requirements: [] };
    const reqs = node.modRequirements?.nexusRequirements?.nodes || [];
    return {
      gameId: String(node.gameId),
      requirements: reqs.map(r => {
        const q = requirementOnNexus({
          modId: Number(r.modId), modName: r.modName, gameId: String(r.gameId),
          url: r.url || '', notes: r.notes || '', external: !!r.externalRequirement,
        }, game);
        return q.external || !r.externalRequirement ? q : { ...q, gameId: String(node.gameId) }; // linked to a mod page of this game
      }),
    };
  }

  /** Mods of a game whose name matches (Nexus's own name search): [{ modId, name }], at most 10. */
  async findModsByName(game, name) {
    const data = await this.graphql(`query($game: String!, $name: String!) {
      mods(filter: { gameDomainName: [{ value: $game }], nameStemmed: [{ value: $name, op: MATCHES }] }, count: 10) { nodes { modId name } } }`,
    { game, name: String(name).slice(0, 100) }, 'search mods');
    return (data.mods?.nodes || []).map(n => ({ modId: Number(n.modId) || 0, name: String(n.name || '') })).filter(n => n.modId);
  }

  /** A v2 GraphQL query. Public data needs no key; the key is sent when there is one. */
  async graphql(query, variables, what) {
    const headers = { 'Content-Type': 'application/json', 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION };
    const key = this.getKey();
    if (key) headers.apikey = key;
    let res;
    try {
      res = await fetch(GRAPHQL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    } catch (err) {
      throw new NexusError(`Network error ${what}: ${err.message}`, 0);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors?.length) throw new NexusError(`Could not ${what} (${res.status}): ${body.errors?.[0]?.message || res.statusText}`, res.status);
    return body.data;
  }

  /**
   * Search a game's mods like the site does. `query` matches words of mod names as typed (prefix
   * match); a number is also looked up as a mod id, which comes first.
   * sort: endorsements | downloads | updatedAt | createdAt | name | relevance
   */
  /**
   * period ('day' | 'week' | 'month' | 'year' | '' for all time) keeps mods from that time: updated
   * in it when sorted by last update, else published in it (as Nexus's own "time" filter).
   */
  async searchMods({ game = 'cyberpunk2077', gameId = 3333, query = '', category = '', sort = 'endorsements', period = '', adult = false, page = 1, perPage = 20 } = {}) {
    const fields = 'modId name summary author version category adultContent downloads endorsements thumbnailUrl pictureUrl updatedAt createdAt uploader { name }';
    const q = String(query || '').trim().slice(0, 100);
    const filter = { gameDomainName: [{ value: game }] };
    if (q) filter.name = [{ value: q, op: 'WILDCARD' }];
    // ADULT_ONLY is not a Nexus category: it is the "adult content" flag, used as one in Browse.
    if (category === ADULT_ONLY) filter.adultContent = [{ value: true }];
    else {
      if (category) filter.categoryName = [{ value: String(category) }];
      if (!adult) filter.adultContent = [{ value: false }];
    }
    const SORTS = { endorsements: 'DESC', downloads: 'DESC', updatedAt: 'DESC', createdAt: 'DESC', name: 'ASC', relevance: 'DESC' };
    const key = SORTS[sort] ? sort : 'endorsements';
    const days = PERIOD_DAYS[period];
    if (days) {
      // Nexus wants Unix seconds here (an ISO date makes its search fail).
      const since = String(Math.floor((Date.now() - days * 86400000) / 1000));
      filter[key === 'updatedAt' ? 'updatedAt' : 'createdAt'] = [{ value: since, op: 'GTE' }];
    }
    const count = Math.min(Math.max(Number(perPage) || 20, 1), 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * count;
    const gql = `query($f: ModsFilter, $s: [ModsSort!], $count: Int, $offset: Int) {
      mods(filter: $f, sort: $s, count: $count, offset: $offset) { totalCount nodes { ${fields} } } }`;
    const byName = this.graphql(gql, { f: filter, s: [{ [key]: { direction: SORTS[key] } }], count, offset }, 'search Nexus');
    // "4198" is also mod 4198 (first page only).
    const byId = /^\d{1,7}$/.test(q) && offset === 0
      ? this.graphql(`query($f: ModsFilter) { mods(filter: $f, count: 1) { nodes { ${fields} } } }`,
        { f: { gameId: [{ value: String(gameId) }], modId: [{ value: q }] } }, 'look up that mod id').catch(() => null)
      : Promise.resolve(null);
    const [named, exact] = await Promise.all([byName, byId]);
    const pick = n => ({
      modId: n.modId, name: n.name, summary: n.summary || '', author: n.author || n.uploader?.name || '', version: n.version || '',
      category: n.category || '', adult: !!n.adultContent, downloads: n.downloads || 0, endorsements: n.endorsements || 0,
      thumbnail: n.thumbnailUrl || '', picture: n.pictureUrl || '', updatedAt: n.updatedAt || '', createdAt: n.createdAt || '',
    });
    const first = (exact?.mods?.nodes || []).filter(n => adult || !n.adultContent).map(pick);
    const rest = (named.mods?.nodes || []).map(pick).filter(m => !first.some(f => f.modId === m.modId));
    return { total: named.mods?.totalCount || 0, page: Math.floor(offset / count) + 1, perPage: count, exact: first.length > 0, mods: [...first, ...rest] };
  }

  /** The game's mod categories with how many mods each has (the site's category filter). */
  async modCategories(game = 'cyberpunk2077') {
    const [data, adult] = await Promise.all([
      this.graphql(`query($f: ModsFilter) { mods(filter: $f, facets: { categoryName: [] }, count: 0) { facetsData } }`,
        { f: { gameDomainName: [{ value: game }] } }, 'read the categories'),
      this.graphql('query($f: ModsFilter) { mods(filter: $f, count: 0) { totalCount } }',
        { f: { gameDomainName: [{ value: game }], adultContent: [{ value: true }] } }, 'count adult mods').catch(() => null),
    ]);
    const list = Object.entries(data.mods?.facetsData?.categoryName || {}).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
    // Adult mods, as their own entry first (they are spread over the real categories on Nexus).
    return [{ name: 'Adult (18+)', value: ADULT_ONLY, count: adult?.mods?.totalCount ?? 0 }, ...list];
  }

  /** Premium accounts get CDN links straight from the API. Returns the preferred URI. */
  async getDownloadLink(game, modId, fileId, { key = '', expires = '' } = {}) {
    const q = key && expires ? `?key=${encodeURIComponent(key)}&expires=${encodeURIComponent(expires)}` : '';
    const links = await this.request(`/games/${game}/mods/${modId}/files/${fileId}/download_link.json${q}`);
    if (!Array.isArray(links) || !links.length || !links[0].URI) {
      throw new NexusError('Nexus returned no download link for this file.', 0);
    }
    return links[0].URI;
  }
}

module.exports = { ADULT_ONLY, NexusClient, NexusError, parseModUrl, parseNxm, requirementOnNexus };
