'use strict';
const { BrowserWindow, session } = require('electron');
const dns = require('dns').promises;
const net = require('net');

/*
 * Web search and page reading for the AI assistant, whatever its provider. A hidden, sandboxed
 * browser window (its own session, no Node, no downloads) loads DuckDuckGo's plain results page or
 * the page asked for, and the text is read out of it. One page at a time.
 */
const PARTITION = 'persist:ai-web';
const READ_LIMIT = 14000;

// Runs in the page, isolated from its scripts (so a page's own rules cannot block it).
const EXTRACT_RESULTS = `(() => [...document.querySelectorAll('.result')].slice(0, 8).map(r => {
  const a = r.querySelector('.result__a');
  let url = a ? a.href : '';
  const m = url.match(/[?&]uddg=([^&]+)/);
  if (m) url = decodeURIComponent(m[1]);
  return { title: a ? a.innerText.trim() : '', url, snippet: (r.querySelector('.result__snippet') || {}).innerText || '' };
}).filter(x => x.title && /^https?:/.test(x.url) && !/duckduckgo\\.com\\/y\\.js/.test(x.url)))()`;
const EXTRACT_TEXT = `(() => ({ title: document.title, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n') }))()`;

/**
 * Only public web pages: never this PC, the local network or link-local addresses (the user's own
 * servers, router pages). The AI picks these URLs, so text it read could try to point it there.
 */
function isPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  // "localhost." and "printer." are the same names with the root's dot: it does not make them public.
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h.includes('.') && !h.includes(':')) return false; // localhost, intranet names
  if (/\.(local|lan|home|internal|localhost|intranet|corp|arpa)$/.test(h)) return false;
  return !privateAddress(h);
}

/** An IP address of this PC, the local network, link-local or a reserved range. */
function privateAddress(h) {
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) {
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateAddress(mapped[1]);
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  }
  return false;
}

/**
 * A public URL whose name also points at public addresses: a name like 127.0.0.1.nip.io is public
 * text for a private place. Names are looked up once a minute at most.
 */
const looked = new Map();
async function reachesPublic(url) {
  if (!isPublicUrl(url)) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (net.isIP(host)) return true; // already checked as an address
  const hit = looked.get(host);
  if (hit && Date.now() - hit.at < 60e3) return hit.ok;
  let ok = false;
  try {
    const all = await dns.lookup(host, { all: true });
    ok = all.length > 0 && all.every(a => !privateAddress(a.address.toLowerCase()));
  } catch { ok = false; }
  looked.set(host, { ok, at: Date.now() });
  return ok;
}

class WebReader {
  constructor() {
    this.win = null;
    this.chain = Promise.resolve();
  }

  window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const ses = session.fromPartition(PARTITION);
    ses.on('will-download', ev => ev.preventDefault());
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    // Every request this window makes, for as long as it lives (pages, redirects, later navigations
    // by a page's own scripts, images, frames, fetches), goes to the public web only.
    ses.webRequest.onBeforeRequest((details, cb) => {
      if (!/^https?:/i.test(details.url)) { cb({ cancel: !/^(about|data|blob|chrome-error):/i.test(details.url) }); return; }
      reachesPublic(details.url).then(ok => cb({ cancel: !ok }), () => cb({ cancel: true }));
    });
    this.win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.setAudioMuted(true);
    return this.win;
  }

  /** One page load at a time; each gives up after 25 s. */
  run(fn) {
    const job = this.chain.then(() => Promise.race([
      fn(this.window()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The page took too long to load.')), 25000)),
    ]));
    this.chain = job.catch(() => {});
    return job;
  }

  /** Load a page and wait for its content (not for every ad and tracker it pulls in). */
  async load(win, url, settle) {
    const wc = win.webContents;
    const ready = new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = (_e, code, desc, _u, mainFrame) => { if (mainFrame && code !== -3) { cleanup(); reject(new Error(`Could not open the page (${desc || code}).`)); } };
      const cleanup = () => { wc.removeListener('dom-ready', done); wc.removeListener('did-fail-load', fail); };
      wc.once('dom-ready', done);
      wc.on('did-fail-load', fail);
    });
    // A redirect or navigation may not lead off the public web either.
    const guard = (ev, to) => { if (!isPublicUrl(to)) ev.preventDefault(); };
    wc.on('will-redirect', guard);
    wc.on('will-navigate', guard);
    ready.finally(() => { wc.removeListener('will-redirect', guard); wc.removeListener('will-navigate', guard); }).catch(() => {});
    wc.loadURL(url).catch(() => {}); // settles when every ad is in: not waited for
    await ready;
    await new Promise(r => setTimeout(r, settle));
  }

  read(win, code) {
    return win.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]);
  }

  search(query) {
    const q = String(query || '').trim().slice(0, 300);
    if (!q) return Promise.reject(new Error('Nothing to search for.'));
    return this.run(async win => {
      await this.load(win, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, 600);
      return this.read(win, EXTRACT_RESULTS);
    });
  }

  page(url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return Promise.reject(new Error('Only http(s) pages can be read.'));
    if (!isPublicUrl(u)) return Promise.reject(new Error('Only public web pages can be read, not this PC or the local network.'));
    return this.run(async win => {
      if (!await reachesPublic(u)) throw new Error('Only public web pages can be read, not this PC or the local network.');
      await this.load(win, u, 2000);
      const r = await this.read(win, EXTRACT_TEXT);
      win.webContents.loadURL('about:blank').catch(() => {}); // the page stops running once read
      const text = String(r?.text || '');
      return { url: u, title: r?.title || '', text: text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n[…page cut here]` : text };
    });
  }
}

module.exports = { WebReader, isPublicUrl, reachesPublic };
