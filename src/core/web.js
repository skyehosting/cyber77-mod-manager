'use strict';
const { BrowserWindow, session } = require('electron');

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
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') && !h.includes(':')) return false; // localhost, intranet names
  if (/\.(local|lan|home|internal|localhost|intranet|corp)$/.test(h)) return false;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
  }
  if (h.includes(':') && (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:'))) return false;
  return true;
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
      await this.load(win, u, 2000);
      const r = await this.read(win, EXTRACT_TEXT);
      const text = String(r?.text || '');
      return { url: u, title: r?.title || '', text: text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n[…page cut here]` : text };
    });
  }
}

module.exports = { WebReader, isPublicUrl };
