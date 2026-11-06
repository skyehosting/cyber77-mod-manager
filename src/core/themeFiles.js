'use strict';
/*
 * Theme Studio files: custom themes saved by name in Documents/Edgerunners Mod Manager/Themes as
 * <name>.emmtheme (JSON, one file carries a whole theme: colours, effects, pictures, animation code),
 * and the pictures of the theme in use, kept in the app's data (userData/theme-assets).
 *
 * Everything read from a file is checked here before the page sees it: sizes, names, numbers in
 * their ranges, pictures that really are PNG / JPEG / WebP / GIF. The colour text is checked again by
 * the page (parseTheme); animation code only ever runs in the sandboxed frame (renderer/fx-sandbox.html).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');

const EXT = '.emmtheme';
const MAX_FILE = 45 << 20; // a theme file, pictures included (two pictures of 20 MB, in base64)
const MAX_IMAGE = 20 << 20; // one picture
const MAX_CODE = 100 << 10; // custom animation code
const MAX_COLORS = 60000;
const KINDS = ['background', 'particle'];
const PRESETS = ['none', 'petals', 'snow', 'rain', 'embers', 'bubbles', 'stars', 'custom'];
const LAYERS = ['background', 'page', 'top'];
const FITS = ['cover', 'contain', 'tile', 'center'];

/** What a picture really is, from its first bytes (never from its name): { type, ext } or null. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { type: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { type: 'image/gif', ext: 'gif' };
  return null;
}

/** A name usable as a file name on Windows and Linux (the theme's name as typed, made safe), or ''. */
function safeName(name) {
  let n = String(name || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '');
  // Windows device names, also with a dot after them (con.x is still CON): never a file name.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `Theme ${n}`;
  return n;
}

const num = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const pick = (v, list, d) => (list.includes(v) ? v : d);
const colour = v => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);

/** A theme's effect settings, every value in its range (unknown keys dropped). */
function cleanFx(fx) {
  const f = fx && typeof fx === 'object' ? fx : {};
  const bg = f.bg && typeof f.bg === 'object' ? f.bg : {};
  const glass = f.glass && typeof f.glass === 'object' ? f.glass : {};
  const p = f.particles && typeof f.particles === 'object' ? f.particles : {};
  const colours = (Array.isArray(p.colors) ? p.colors : []).map(colour).filter(Boolean).slice(0, 6);
  return {
    bg: {
      fit: pick(bg.fit, FITS, 'cover'), dim: num(bg.dim, 0, 90, 20), blur: num(bg.blur, 0, 30, 0),
      page: num(bg.page, 0, 100, 70), panels: num(bg.panels, 0, 100, 85),
    },
    glass: { blur: num(glass.blur, 0, 40, 0) },
    particles: {
      preset: pick(p.preset, PRESETS, 'none'), layer: pick(p.layer, LAYERS, 'background'),
      count: Math.round(num(p.count, 5, 400, 60)), size: num(p.size, 0.3, 4, 1), speed: num(p.speed, 0.1, 4, 1),
      wind: num(p.wind, -3, 3, 0.4), spin: p.spin !== false, useImage: !!p.useImage,
      colors: colours.length ? colours : ['#ffc0d9', '#ff9ec4', '#fff0f5'],
    },
    reduceMotion: f.reduceMotion !== false,
  };
}

/** A whole theme (from a file, or from the page to be saved), checked: { name, colors, fx, images, code }. */
function cleanTheme(t) {
  if (!t || typeof t !== 'object') throw new Error('That is not a theme.');
  if (t.format !== undefined && t.format !== 'edgerunners-theme') throw new Error('That is not an Edgerunners Mod Manager theme.');
  const images = {};
  for (const k of KINDS) {
    const im = t.images?.[k];
    if (!im || typeof im.data !== 'string') continue;
    if (im.data.length > Math.ceil(MAX_IMAGE / 3) * 4 + 4) throw new Error(`The theme's ${k} picture is larger than 20 MB.`);
    const buf = Buffer.from(im.data, 'base64');
    const kind = sniffImage(buf);
    if (!kind) throw new Error(`The theme's ${k} picture is not a PNG, JPEG, WebP or GIF picture.`);
    images[k] = { type: kind.type, data: buf.toString('base64') };
  }
  const code = typeof t.code === 'string' ? t.code : '';
  if (code.length > MAX_CODE) throw new Error('The theme\'s animation code is larger than 100 KB.');
  const colors = typeof t.colors === 'string' ? t.colors.slice(0, MAX_COLORS) : '';
  return { name: safeName(t.name) || 'My theme', colors, fx: cleanFx(t.fx), images, code };
}

class ThemeFiles {
  /** dir: where named themes are saved; assets: where the theme in use keeps its pictures. */
  constructor({ dir, assets, trash = null }) {
    this.dir = dir;
    this.assets = assets;
    this.trash = trash; // (file) => Promise: to the recycle bin (Electron's shell.trashItem)
  }

  fileOf(name) {
    const n = safeName(name);
    if (!n) throw new Error('Give the theme a name.');
    const file = path.join(this.dir, `${n}${EXT}`);
    if (path.dirname(path.resolve(file)) !== path.resolve(this.dir)) throw new Error('That name cannot be used.');
    return file;
  }

  /** The saved themes: [{ name, file, size, at }] (by name; files only, never their contents). */
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => n.toLowerCase().endsWith(EXT)); } catch { return []; }
    return names.slice(0, 500).map(n => {
      let st = null;
      try { st = fs.statSync(path.join(this.dir, n)); } catch { /* gone */ }
      return st?.isFile() ? { name: n.slice(0, -EXT.length), size: st.size, at: st.mtimeMs } : null;
    }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Is that name taken (a link counts, even one pointing nowhere)? */
  exists(name) { try { fs.lstatSync(this.fileOf(name)); return true; } catch { return false; } }

  /**
   * Save the theme in use under a name. Its pictures come from the theme-assets folder (the page names
   * them by their file URL; only files in that folder are read).
   */
  save(name, theme) {
    const images = {};
    for (const k of KINDS) {
      const url = theme?.imageUrls?.[k];
      if (!url) continue;
      const file = this.assetFile(url);
      if (!file) continue;
      images[k] = { data: fs.readFileSync(file).toString('base64') };
    }
    const clean = cleanTheme({ ...theme, name, images, format: 'edgerunners-theme' });
    const file = this.fileOf(name);
    fs.mkdirSync(this.dir, { recursive: true });
    const body = JSON.stringify({ format: 'edgerunners-theme', version: 1, name: clean.name, colors: clean.colors, fx: clean.fx, images: clean.images, code: clean.code });
    const tmp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, file); } catch (err) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } throw err; }
    return { name: clean.name, file };
  }

  /** Read a theme file (a saved one by name, or any path chosen by the user) and make it the theme in use. */
  loadFile(file) {
    const t = this.loadFileRaw(file);
    const imageUrls = {};
    for (const k of KINDS) imageUrls[k] = t.images[k] ? this.putAsset(k, Buffer.from(t.images[k].data, 'base64')) : '';
    return { name: t.name, colors: t.colors, fx: t.fx, code: t.code, imageUrls };
  }

  load(name) { return this.loadFile(this.fileOf(name)); }

  /** A saved theme to the recycle bin (never deleted outright). */
  async remove(name) {
    const file = this.fileOf(name);
    if (!fs.existsSync(file)) return false;
    if (this.trash) await this.trash(file); else fs.rmSync(file);
    return true;
  }

  /** A theme file from anywhere, copied into the folder (checked first); returns its name there. */
  importFile(src) {
    const t = this.loadFileRaw(src);
    let name = t.name;
    for (let i = 2; this.exists(name); i++) {
      if (i > 99) throw new Error(`There are too many themes named "${t.name}": rename one first.`);
      name = `${t.name} ${i}`;
    }
    const file = this.fileOf(name);
    fs.mkdirSync(this.dir, { recursive: true });
    // Written beside it, then renamed into place; 'wx': never through a link that sits there.
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ format: 'edgerunners-theme', version: 1, ...t, name }), { flag: 'wx' });
      fs.renameSync(tmp, file);
    } catch (err) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } throw err; }
    return name;
  }

  loadFileRaw(file) {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) throw new Error('That theme file is too large (over 60 MB).');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('That theme file is damaged (not readable as a theme).'); }
    return cleanTheme(raw);
  }

  // ---------------------------------------------------------------- the pictures of the theme in use

  /** Keep a picture for the theme in use; returns its file URL. The previous one of that kind goes. */
  putAsset(kind, buf) {
    if (!KINDS.includes(kind)) throw new Error('Unknown picture.');
    if (buf.length > MAX_IMAGE) throw new Error('That picture is larger than 20 MB.');
    const im = sniffImage(buf);
    if (!im) throw new Error('That is not a PNG, JPEG, WebP or GIF picture.');
    fs.mkdirSync(this.assets, { recursive: true });
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const file = path.join(this.assets, `${kind}-${hash}.${im.ext}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    this.clearAssets(kind, file);
    return pathToFileURL(file).href;
  }

  /** A picture file chosen by the user: checked, then kept like above. */
  putAssetFile(kind, src) {
    const st = fs.statSync(src);
    if (!st.isFile() || st.size > MAX_IMAGE) throw new Error('That picture is larger than 20 MB.');
    return this.putAsset(kind, fs.readFileSync(src));
  }

  /** Remove the kept pictures of a kind (but `keep`). */
  clearAssets(kind, keep = '') {
    let names = [];
    try { names = fs.readdirSync(this.assets); } catch { return; }
    for (const n of names) {
      const f = path.join(this.assets, n);
      if (n.startsWith(`${kind}-`) && path.resolve(f) !== path.resolve(keep || '')) { try { fs.rmSync(f, { force: true }); } catch { /* in use: next time */ } }
    }
  }

  /** The file behind a picture URL, if it is one of the kept pictures (else null). */
  assetFile(url) {
    let file;
    try { file = fileURLToPath(String(url).split('?')[0]); } catch { return null; }
    const dir = path.resolve(this.assets);
    const f = path.resolve(file);
    return path.dirname(f) === dir && fs.existsSync(f) ? f : null;
  }
}

module.exports = { ThemeFiles, cleanTheme, cleanFx, sniffImage, safeName, EXT, PRESETS, LAYERS };
