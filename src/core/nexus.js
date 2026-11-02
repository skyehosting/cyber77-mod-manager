'use strict';
const API = 'https://api.nexusmods.com/v1';
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
  const m = text.match(/nexusmods\.com\/(?:games\/)?([a-z0-9_-]+)\/mods\/(\d+)/i);
  if (!m) return null;
  return { game: m[1].toLowerCase(), modId: Number(m[2]) };
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
        403: 'Forbidden (403). Direct API download links need a Premium account.',
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

  /** Premium accounts get CDN links straight from the API. Returns the preferred URI. */
  async getDownloadLink(game, modId, fileId) {
    const links = await this.request(`/games/${game}/mods/${modId}/files/${fileId}/download_link.json`);
    if (!Array.isArray(links) || !links.length || !links[0].URI) {
      throw new NexusError('Nexus returned no download link for this file.', 0);
    }
    return links[0].URI;
  }
}

module.exports = { NexusClient, NexusError, parseModUrl };
