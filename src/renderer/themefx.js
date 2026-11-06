'use strict';
/* global api, themeState, rgbaOf */
/* exported themeFx */

// ---------------------------------------------------------------- Theme Studio: effects
// A custom theme's extras on top of its colours: a background picture (fit, dim, blur), see-through
// page and panels, frosted glass, and an animation layer (built-in particles, or the theme's own code
// run in a sealed frame: fx-sandbox.html). Only for the Custom theme; the built-in themes stay as they are.
// Settings live in local storage (small); pictures in the app's data folder (main process: themeFiles.js).

// One block: these names stay out of the other pages' (scripts share one global scope).
{
const FX_DEFAULT = {
  bg: { fit: 'cover', dim: 20, blur: 0, page: 70, panels: 85 },
  glass: { blur: 0 },
  particles: { preset: 'none', layer: 'background', count: 60, size: 1, speed: 1, wind: 0.4, spin: true, useImage: false, colors: ['#ffc0d9', '#ff9ec4', '#fff0f5'] },
  reduceMotion: true,
};
const PAGE_TOKENS = ['--bg', '--side-bg'];
const PANEL_TOKENS = ['--surface', '--surface-2', '--surface-3', '--panel', '--hover-bg', '--nav-active', '--seg-on', '--console-bg'];
const GLASS_TOKENS = ['--menu-bg'];

const fxStore = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
/** The settings, every value in its range (the same rules as the main process: themeFiles.js cleanFx). */
function cleanSettings(f = {}) {
  const bg = f.bg || {};
  const p = f.particles || {};
  const d = FX_DEFAULT;
  const colors = (Array.isArray(p.colors) ? p.colors : []).filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 6);
  return {
    bg: { fit: oneOf(bg.fit, ['cover', 'contain', 'tile', 'center'], 'cover'), dim: clamp(bg.dim, 0, 90, d.bg.dim), blur: clamp(bg.blur, 0, 30, 0), page: clamp(bg.page, 0, 100, d.bg.page), panels: clamp(bg.panels, 0, 100, d.bg.panels) },
    glass: { blur: clamp(f.glass?.blur, 0, 40, 0) },
    particles: {
      preset: oneOf(p.preset, ['none', 'petals', 'snow', 'rain', 'embers', 'bubbles', 'stars', 'custom'], 'none'), layer: oneOf(p.layer, ['background', 'page', 'top'], 'background'),
      count: Math.round(clamp(p.count, 5, 400, 60)), size: clamp(p.size, 0.3, 4, 1), speed: clamp(p.speed, 0.1, 4, 1), wind: clamp(p.wind, -3, 3, 0.4),
      spin: p.spin !== false, useImage: !!p.useImage, colors: colors.length ? colors : d.particles.colors.slice(),
    },
    reduceMotion: f.reduceMotion !== false,
  };
}

const fx = {
  settings: cleanSettings(fxStore.get('theme.fx', FX_DEFAULT)),
  images: fxStore.get('theme.images', { background: '', particle: '' }) || { background: '', particle: '' },
  code: fxStore.get('theme.code', '') || '',
  armed: fxStore.get('theme.codeArmed', false) === true, // the theme's code runs only after the user pressed Run (once)
  animKey: '', // what the running animation was made from: the same again is not restarted
  set: [], // tokens set here (made see-through), to put back
  engine: null,
  onCodeError: null, // the Studio shows the custom code's errors
};

const root = document.documentElement;
function el(id, make) {
  let e = document.getElementById(id);
  if (!e) { e = make(); e.id = id; }
  return e;
}

// ---------------------------------------------------------------- background, see-through, glass

function clearLook() {
  // Each colour made see-through goes back to the theme's own (or to the stylesheet's, if the theme has none).
  for (const k of fx.set) { const v = themeState.tokens?.[k]; if (v) root.style.setProperty(k, v); else root.style.removeProperty(k); }
  fx.set = [];
  root.classList.remove('fx-image', 'fx-glass', 'fx-see');
  document.getElementById('fx-bg')?.remove();
}

/** The colour a token has now, with its opacity made `alpha` (0-1); null if it is not a plain colour. */
function seeThrough(k, alpha) {
  const v = getComputedStyle(root).getPropertyValue(k).trim();
  const c = v && rgbaOf(v);
  if (!c) return null;
  return `rgb(${c[0]} ${c[1]} ${c[2]} / ${Math.round(c[3] * alpha * 1000) / 1000})`;
}

function applyLook() {
  clearLook();
  if (themeState.id !== 'custom') return;
  const s = fx.settings;
  const image = fx.images.background;
  if (image) {
    const solid = getComputedStyle(root).getPropertyValue('--bg').trim();
    root.style.setProperty('--fx-bg-solid', solid);
    fx.set.push('--fx-bg-solid');
    const bg = el('fx-bg', () => document.createElement('div'));
    bg.setAttribute('aria-hidden', 'true');
    document.body.prepend(bg);
    bg.style.backgroundImage = `url("${encodeURI(decodeURI(image)).replace(/"/g, '%22')}")`;
    bg.dataset.fit = s.bg.fit;
    root.style.setProperty('--fx-dim', String(s.bg.dim / 100));
    root.style.setProperty('--fx-bg-blur', `${s.bg.blur}px`);
    fx.set.push('--fx-dim', '--fx-bg-blur');
    root.classList.add('fx-image');
  }
  // See-through: with a picture (or animation behind the page) the page and panels let it show.
  if (image || (s.particles.preset !== 'none' && s.particles.layer === 'background')) {
    const page = s.bg.page / 100;
    const panels = s.bg.panels / 100;
    for (const [list, a] of [[PAGE_TOKENS, page], [PANEL_TOKENS, panels], [s.glass.blur ? GLASS_TOKENS : [], Math.max(panels, 0.75)]]) {
      for (const k of list) { const v = seeThrough(k, a); if (v) { root.style.setProperty(k, v); fx.set.push(k); } }
    }
    root.classList.add('fx-see');
  }
  if (s.glass.blur) {
    root.style.setProperty('--fx-glass-blur', `${s.glass.blur}px`);
    fx.set.push('--fx-glass-blur');
    root.classList.add('fx-glass');
  }
}

// ---------------------------------------------------------------- particles (built in)

const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);

/** One particle of a preset, at a random place (or, `top`, coming in from its edge). */
function spawn(preset, w, h, s, fresh) {
  const size = s.size;
  const colour = s.colors[Math.floor(Math.random() * s.colors.length)];
  const p = { x: rnd(0, w), y: fresh ? rnd(0, h) : -20, rot: rnd(0, TAU), vr: s.spin ? rnd(-1.2, 1.2) : 0, phase: rnd(0, TAU), colour, life: 1 };
  switch (preset) {
    case 'petals': return { ...p, r: rnd(5, 10) * size, vy: rnd(18, 40), sway: rnd(14, 34), flip: rnd(0.8, 2.2) };
    case 'snow': return { ...p, r: rnd(1.2, 3.6) * size, vy: rnd(12, 34), sway: rnd(6, 18) };
    case 'rain': return { ...p, r: rnd(10, 22) * size, vy: rnd(380, 620), sway: 0 };
    case 'embers': return { ...p, y: fresh ? rnd(0, h) : h + 10, r: rnd(1, 2.6) * size, vy: -rnd(20, 55), sway: rnd(8, 24), fade: rnd(0.15, 0.4) };
    case 'bubbles': return { ...p, y: fresh ? rnd(0, h) : h + 20, r: rnd(4, 14) * size, vy: -rnd(14, 36), sway: rnd(6, 16) };
    case 'stars': return { ...p, y: rnd(0, h), r: rnd(0.6, 2) * size, vy: 0, sway: 0, tw: rnd(0.5, 2.2) };
    default: return p;
  }
}

function drawPetal(ctx, p, t) {
  const r = p.r;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.scale(1, 0.35 + 0.65 * Math.abs(Math.sin(t * p.flip + p.phase))); // the petal turning over as it falls
  const g = ctx.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, p.colour);
  g.addColorStop(1, 'rgba(255,255,255,0.85)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, r);
  ctx.bezierCurveTo(r * 0.9, r * 0.4, r * 0.75, -r * 0.8, r * 0.18, -r); // to the notch at the tip
  ctx.lineTo(0, -r * 0.72);
  ctx.lineTo(-r * 0.18, -r);
  ctx.bezierCurveTo(-r * 0.75, -r * 0.8, -r * 0.9, r * 0.4, 0, r);
  ctx.fill();
  ctx.restore();
}

class Particles {
  constructor(canvas, settings, image) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.s = settings;
    this.image = image; // a picture as the particle shape (optional)
    this.list = [];
    this.last = 0;
    this.raf = 0;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.list.length) for (let i = 0; i < this.s.count; i++) this.list.push(spawn(this.s.preset, w, h, this.s, true));
  }

  start() { if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(t => this.tick(t)); } }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  tick(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = now / 1000;
    const { ctx, w, h, s } = this;
    const preset = s.preset;
    ctx.clearRect(0, 0, w, h);
    const wind = s.wind * 30;
    for (let i = 0; i < this.list.length; i++) {
      let p = this.list[i];
      p.y += p.vy * s.speed * dt;
      p.x += (wind + Math.sin(t * 0.9 + p.phase) * (p.sway || 0)) * s.speed * dt;
      p.rot += p.vr * s.speed * dt;
      if (preset === 'embers') p.life -= p.fade * dt;
      const gone = p.y > h + 30 || p.y < -40 || p.x < -60 || p.x > w + 60 || p.life <= 0;
      if (gone) { p = this.list[i] = spawn(preset, w, h, s, false); if (p.x < 0 || p.x > w) p.x = rnd(0, w); }
      this.draw(p, t);
    }
    this.raf = requestAnimationFrame(x => this.tick(x));
  }

  draw(p, t) {
    const { ctx } = this;
    const preset = this.s.preset;
    if (this.image && this.s.useImage) {
      const r = p.r * 2.2;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = preset === 'embers' ? Math.max(0, p.life) : 1;
      ctx.drawImage(this.image, -r / 2, -r / 2, r, r * (this.image.height / this.image.width || 1));
      ctx.restore();
      return;
    }
    ctx.fillStyle = p.colour;
    ctx.strokeStyle = p.colour;
    switch (preset) {
      case 'petals': drawPetal(ctx, p, t); break;
      case 'snow': ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; break;
      case 'rain': {
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(1, p.r / 14);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - this.s.wind * p.r * 0.4, p.y - p.r);
        ctx.stroke();
        ctx.globalAlpha = 1;
        break;
      }
      case 'embers': {
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.shadowColor = p.colour;
        ctx.shadowBlur = p.r * 6;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
        break;
      }
      case 'bubbles': ctx.globalAlpha = 0.6; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; break;
      case 'stars': ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * p.tw + p.phase)); ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------- the animation layer

/** Where the animation is drawn: behind the app, over the page (not the sidebar), or over everything. */
function layerHost(layer) {
  if (layer === 'page') return document.querySelector('.shell > .main') || document.querySelector('.main');
  return document.body;
}

function stopAnimation() {
  fx.engine?.stop?.();
  fx.engine = null;
  document.getElementById('fx-anim')?.remove();
}

/** A picture (file URL of the theme in use) as an ImageBitmap, or null. */
async function loadBitmap(url) {
  if (!url) return null;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } catch { return null; }
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

async function startAnimation() {
  stopAnimation();
  const s = fx.settings;
  const p = s.particles;
  if (themeState.id !== 'custom' || p.preset === 'none') return;
  if (s.reduceMotion && reducedMotion.matches) return;
  if (p.preset === 'custom' && !fx.armed) return; // code from a theme file: not until Run is pressed
  const host = layerHost(p.layer);
  if (!host) return;
  const token = {};
  fx.engine = token;
  const image = p.useImage || p.preset === 'custom' ? await loadBitmap(fx.images.particle) : null;
  if (fx.engine !== token) return; // changed meanwhile
  if (p.preset === 'custom') {
    // The theme's own code: only in the sealed frame (no app, no files, no network; it can only draw).
    const frame = document.createElement('iframe');
    frame.id = 'fx-anim';
    frame.className = `fx-anim fx-layer-${p.layer}`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.src = 'fx-sandbox.html';
    // Its frames come from here (the sealed frame's own timer is not dependable): one tick per frame of the app.
    let raf = 0;
    let errored = false;
    let started = false;
    const loop = () => { frame.contentWindow?.postMessage({ type: 'tick' }, '*'); raf = requestAnimationFrame(loop); };
    const onMsg = ev => {
      if (ev.source !== frame.contentWindow || !ev.data || typeof ev.data !== 'object') return;
      if (ev.data.type === 'ready') {
        if (started || errored) return; // once per frame
        started = true;
        frame.contentWindow.postMessage({ type: 'run', code: fx.code, colors: p.colors, speed: p.speed, image }, '*');
        if (!raf) raf = requestAnimationFrame(loop); // (a hidden window gets no animation frames anyway)
      }
      if (ev.data.type === 'error' && !errored) { errored = true; cancelAnimationFrame(raf); raf = 0; fx.onCodeError?.(String(ev.data.message || 'error').slice(0, 300)); }
    };
    window.addEventListener('message', onMsg);
    fx.engine = {
      frame,
      stop: () => { cancelAnimationFrame(raf); raf = 0; window.removeEventListener('message', onMsg); },
      pause: () => { cancelAnimationFrame(raf); raf = 0; },
      resume: () => { if (!raf && started && !errored) { frame.contentWindow?.postMessage({ type: 'resume' }, '*'); raf = requestAnimationFrame(loop); } },
    };
    host.append(frame);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.id = 'fx-anim';
  canvas.className = `fx-anim fx-layer-${p.layer}`;
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);
  const engine = new Particles(canvas, p, image);
  fx.engine = engine;
  if (!document.hidden) engine.start();
}

// Hidden window: no drawing. A new size: the canvas follows.
document.addEventListener('visibilitychange', () => {
  const e = fx.engine;
  if (e instanceof Particles) { if (document.hidden) e.stop(); else e.start(); }
  else if (e?.frame) { if (document.hidden) e.pause(); else e.resume(); }
});
window.addEventListener('resize', () => { if (fx.engine instanceof Particles) fx.engine.resize(); });
reducedMotion.addEventListener?.('change', () => startAnimation());

// ---------------------------------------------------------------- the API for the Studio

function animationKey() {
  return JSON.stringify([themeState.id, fx.settings.particles, fx.settings.reduceMotion, fx.images.particle, fx.code, fx.armed]);
}
function applyAll(force = false) {
  applyLook();
  const key = animationKey();
  if (force || key !== fx.animKey) { fx.animKey = key; startAnimation(); }
}

const themeFx = {
  get settings() { return fx.settings; },
  get images() { return { ...fx.images }; },
  get code() { return fx.code; },
  defaults: () => cleanSettings(FX_DEFAULT),
  clean: cleanSettings,
  /** Change settings (a part of them); saved, and shown at once. */
  update(patch) {
    const s = fx.settings;
    fx.settings = cleanSettings({ ...s, ...patch, bg: { ...s.bg, ...(patch.bg || {}) }, glass: { ...s.glass, ...(patch.glass || {}) }, particles: { ...s.particles, ...(patch.particles || {}) } });
    fxStore.set('theme.fx', fx.settings);
    const animChanged = JSON.stringify(s.particles) !== JSON.stringify(fx.settings.particles) || s.reduceMotion !== fx.settings.reduceMotion;
    applyLook();
    if (animChanged) { fx.animKey = animationKey(); startAnimation(); }
  },
  setImage(kind, url) {
    fx.images = { ...fx.images, [kind]: url || '' };
    fxStore.set('theme.images', fx.images);
    applyAll(kind === 'particle');
  },
  /** The user's Run: this code may run (now, and when the app opens). */
  setCode(code) {
    fx.code = String(code || '').slice(0, 100 << 10);
    fx.armed = true;
    fxStore.set('theme.code', fx.code);
    fxStore.set('theme.codeArmed', true);
    fx.animKey = animationKey();
    if (fx.settings.particles.preset === 'custom') startAnimation();
  },
  /** Code from a theme file that has not been run here yet. */
  get codeWaiting() { return fx.settings.particles.preset === 'custom' && !!fx.code && !fx.armed; },
  /** A whole theme's effects at once (loaded from a file). */
  load({ fx: settings, imageUrls, code }) {
    fx.settings = cleanSettings(settings || FX_DEFAULT);
    fx.images = { background: imageUrls?.background || '', particle: imageUrls?.particle || '' };
    fx.code = String(code || '');
    fx.armed = false; // a theme file's code waits for the user's Run
    fxStore.set('theme.fx', fx.settings);
    fxStore.set('theme.images', fx.images);
    fxStore.set('theme.code', fx.code);
    fxStore.set('theme.codeArmed', false);
    applyAll(true);
  },
  set onCodeError(fn) { fx.onCodeError = fn; },
  apply: applyAll,
};
window.themeFx = themeFx;
// The colours are put on the page (themes.js) before this runs; from now on each change of theme re-applies the effects.
window.applyThemeFx = applyAll;
applyAll();
}
