'use strict';
/* global api, $, $$, h, icon, toast, store, debounce, highlight, confirmBox, THEMES, THEME_KEYS, THEME_CHECKS, THEME_APART, SHADOW_KEYS, looksApart, themeState, themeTemplate, parseTheme, applyTheme */

// ---------------------------------------------------------------- Settings > Interface: themes

/*
 * One card per theme (a small picture of the app in its colours), and Custom: an editor for the
 * theme as text. Every change applies at once. Readability is checked as you type: each pair of
 * colours the app puts on top of each other is measured against the usual contrast minimums.
 */

const THEME_ORDER = ['netrunner', 'samurai', 'ncpd', 'david', 'corpo', 'coyote', 'sakura', 'custom'];
const customText = () => store.get('theme.custom', '') || themeTemplate('netrunner');

/** A colour as [r, g, b, a] (0-255, alpha 0-1), read by the browser itself; null if it is not one. */
const colourCanvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
function rgbaOf(value) {
  if (!value || !CSS.supports('color', value)) return null;
  colourCanvas.clearRect(0, 0, 1, 1);
  colourCanvas.fillStyle = '#000';
  colourCanvas.fillStyle = value;
  colourCanvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colourCanvas.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

/** A theme's value for a token, following var(--x) to the token it names (missing ones are Netrunner's). */
function tokenValue(tokens, k, depth = 0) {
  const v = tokens[k] ?? THEMES.netrunner.tokens[k];
  const ref = String(v || '').match(/^var\((--[\w-]+)\)$/);
  return ref && depth < 6 ? tokenValue(tokens, ref[1], depth + 1) : v;
}

/** WCAG contrast of a text colour over a background (a see-through text colour is laid on it first). */
function contrastOf(fg, bg) {
  if (!fg || !bg) return null;
  const over = fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
  const lum = ([r, g, b]) => [r, g, b].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [a, b] = [lum(over), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const hexOf = c => `#${c.slice(0, 3).map(x => Math.round(x).toString(16).padStart(2, '0')).join('')}`;

/** The window's own colour follows the page's, so it opens in the theme (no dark flash). */
function sendWindowBackground() {
  const bg = rgbaOf(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  if (bg) api.setWindowBackground(hexOf(bg)).catch(() => {});
}

/** A small picture of the app in a theme's colours: its tokens are set on the picture only. */
function themeMini(tokens) {
  const mini = h('span', { class: 'theme-mini', 'aria-hidden': 'true' },
    h('span', { class: 'tm-side' }, h('span', { class: 'tm-brand' }), h('span', { class: 'tm-play' }), h('span', { class: 'tm-nav on' }), h('span', { class: 'tm-nav' }), h('span', { class: 'tm-nav' })),
    h('span', { class: 'tm-main' },
      h('span', { class: 'tm-title' }), h('span', { class: 'tm-btn' }),
      h('span', { class: 'tm-card' },
        h('span', { class: 'tm-row' }, h('span', { class: 'tm-dot ok' }), h('span', { class: 'tm-line' }), h('span', { class: 'tm-chip' })),
        h('span', { class: 'tm-row' }, h('span', { class: 'tm-dot' }), h('span', { class: 'tm-line short' }), h('span', { class: 'tm-chip err' })))));
  for (const k of THEME_KEYS) { const v = tokenValue(tokens, k); if (v) mini.style.setProperty(k, v); }
  return mini;
}

function renderThemeGrid() {
  const custom = parseTheme(customText());
  $('#theme-grid').replaceChildren(...THEME_ORDER.map(id => {
    const t = id === 'custom' ? { name: 'Custom', desc: custom.errors.length ? `Your own · ${custom.errors.length} line${custom.errors.length === 1 ? '' : 's'} skipped` : 'Your own: write it, or paste one', tokens: custom.tokens } : THEMES[id];
    const on = themeState.id === id;
    return h('button', {
      type: 'button', class: `theme-card${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', dataset: { theme: id },
      onclick: () => { chooseTheme(id); $(`#theme-grid [data-theme="${id}"]`)?.focus(); },
      onkeydown: ev => {
        const i = THEME_ORDER.indexOf(id);
        const to = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
        if (!to) return;
        ev.preventDefault();
        const next = THEME_ORDER[(i + to + THEME_ORDER.length) % THEME_ORDER.length];
        chooseTheme(next);
        $(`#theme-grid [data-theme="${next}"]`)?.focus();
      },
    }, themeMini(t.tokens),
    h('span', { class: 'theme-card-text' },
      h('span', { class: 'theme-card-name' }, on ? icon('check') : null, t.name),
      h('span', { class: 'theme-card-desc' }, t.desc)));
  }));
}

function chooseTheme(id) {
  store.set('theme', id);
  applyTheme(id, customText());
  renderThemeGrid();
  showThemeEditor(id === 'custom');
  sendWindowBackground();
}

// ---------------------------------------------------------------- the custom theme editor

const ted = { shown: false };

function showThemeEditor(on) {
  $('#theme-ed').hidden = !on;
  if (!on) closeColourPicker();
  if (!on || ted.shown) { ted.shown = on; return; }
  ted.shown = true;
  const ta = $('#theme-ed-text');
  if (!ta.value) ta.value = customText();
  paintThemeEditor();
}

function paintThemeEditor() {
  const ta = $('#theme-ed-text');
  const text = ta.value;
  $('#theme-ed-hl').innerHTML = highlight(text, 'theme'); // highlight() escapes every piece of the text
  $('#theme-ed-gutter').textContent = Array.from({ length: text.split('\n').length }, (_, i) => i + 1).join('\n');
  paintSwatches(text);
  syncThemeScroll();
  const parsed = parseTheme(text);
  $('#theme-ed-checks').replaceChildren(...THEME_CHECKS.map(([label, fgK, bgK, min]) => {
    const bg = rgbaOf(tokenValue(parsed.tokens, bgK));
    const fg = rgbaOf(tokenValue(parsed.tokens, fgK));
    const c = contrastOf(fg, bg && bg[3] === 1 ? bg : bg && [...bg.slice(0, 3), 1]);
    const ok = c != null && c >= min;
    return h('li', { class: `theme-check${ok ? '' : ' low'}`, title: `${fgK} on ${bgK}: ${c ? c.toFixed(2) : '?'}:1 (at least ${min}:1 reads well)` },
      swatch(tokenValue(parsed.tokens, fgK), tokenValue(parsed.tokens, bgK), min >= 3),
      h('span', { class: 'theme-check-label' }, label),
      h('span', { class: 'theme-check-n' }, c ? `${c.toFixed(1)}:1${ok ? '' : ' · low'}` : '?'));
  }));
  // Colours with different meanings (the main button, errors, warnings, selection) must not look alike.
  $('#theme-ed-apart').replaceChildren(...THEME_APART.map(([label, aK, bK]) => {
    const a = rgbaOf(tokenValue(parsed.tokens, aK));
    const b = rgbaOf(tokenValue(parsed.tokens, bK));
    const r = a && b ? looksApart(a, b) : null;
    const ok = !!r?.ok;
    const pair = h('span', { class: 'theme-apart-pair' }, h('span', { class: 'theme-apart-dot' }), h('span', { class: 'theme-apart-dot' }));
    if (a) pair.firstChild.style.background = tokenValue(parsed.tokens, aK);
    if (b) pair.lastChild.style.background = tokenValue(parsed.tokens, bK);
    return h('li', { class: `theme-check${ok ? '' : ' low'}`, title: `${aK} and ${bK}: hues ${r?.hue ?? '?'}° apart, lightness ${r?.light ?? '?'} points apart (15 or more of either tells them apart)` },
      pair, h('span', { class: 'theme-check-label' }, label), h('span', { class: 'theme-check-n' }, ok ? 'distinct' : 'look alike'));
  }));
  // Lines that are not colours, then the checks above that failed: the tick only when all is well.
  const low = $$('#theme-ed-checks .low, #theme-ed-apart .low').length;
  $('#theme-ed-problems').replaceChildren(...[ // (null would show as the word "null")
    ...parsed.errors.slice(0, 40).map(e => h('li', { class: 'theme-problem' }, h('button', { type: 'button', class: 'link-btn', onclick: () => goToThemeLine(e.line) }, `Line ${e.line}`), ` ${e.text}`)),
    low ? h('li', { class: 'theme-problem' }, `${low} check${low === 1 ? '' : 's'} above ${low === 1 ? 'is' : 'are'} marked: those colours are hard to read or to tell apart`) : null,
    !parsed.errors.length && !low ? h('li', { class: 'theme-ok' }, icon('check'), 'Every line is a colour, and every check passes') : null,
  ].filter(Boolean));
}

/** 'Aa' in a text colour on a background colour (each checked to be a colour first). */
function swatch(fg, bg, text = true) {
  // Text pairs show 'Aa'; an edge or a fill on a background shows that fill as a small block.
  const chip = text ? null : h('span', { class: 'theme-check-chip' });
  const el = h('span', { class: 'theme-check-swatch' }, chip || 'Aa');
  if (CSS.supports('color', bg)) el.style.background = bg;
  if (CSS.supports('color', fg)) (chip || el).style[chip ? 'background' : 'color'] = fg;
  return el;
}

function syncThemeScroll() {
  const ta = $('#theme-ed-text');
  $('#theme-ed-hl').scrollTop = ta.scrollTop;
  $('#theme-ed-hl').scrollLeft = ta.scrollLeft;
  $('#theme-ed-gutter').scrollTop = ta.scrollTop;
  $('#theme-ed-sw').style.transform = `translateY(${-ta.scrollTop}px)`;
}

// ---------------------------------------------------------------- the colour picker

/*
 * Beside each colour line, a swatch of that colour. Clicking it opens a small picker (a
 * saturation/brightness square, a hue slider, R G B and hex boxes) that writes the colour into
 * that line as you go, so the app changes with it.
 */

const COLOUR_LINE = /^(\s*)(--[\w-]+)(\s*:\s*)([^;]*?)(\s*;.*)?$/;

function paintSwatches(text) {
  const ta = $('#theme-ed-text');
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 20;
  const top = parseFloat(cs.paddingTop) || 0;
  const known = new Set(THEME_KEYS);
  // Comments are blanked (same length) so a line inside one is not offered.
  const clean = text.replace(/\/\*[\s\S]*?(\*\/|$)/g, m => m.replace(/[^\n]/g, ' ')).split('\n');
  $('#theme-ed-sw').replaceChildren(...clean.flatMap((line, i) => {
    const m = line.match(COLOUR_LINE);
    if (!m || !known.has(m[2]) || SHADOW_KEYS.has(m[2]) || !rgbaOf(m[4].trim())) return [];
    const b = h('button', {
      type: 'button', class: 'theme-sw', title: `Pick a colour for ${m[2]}`, 'aria-label': `Pick a colour for ${m[2]}`, dataset: { line: String(i) },
      onclick: ev => openColourPicker(i, m[2], ev.currentTarget),
    });
    b.style.top = `${top + i * lh + (lh - 14) / 2}px`;
    b.style.background = m[4].trim();
    return [b];
  }));
}

/** Put a colour into one line of the theme text, keeping the rest of the line (its comment) as it was. */
function setThemeLine(i, value) {
  const ta = $('#theme-ed-text');
  const lines = ta.value.split('\n');
  const m = lines[i]?.match(COLOUR_LINE);
  if (!m) return;
  lines[i] = `${m[1]}${m[2]}${m[3]}${value}${m[5] ?? ';'}`;
  const keep = ta.scrollTop;
  ta.value = lines.join('\n');
  ta.scrollTop = keep;
  paintThemeEditor();
  saveCustomTheme();
}

const toHsv = ([r, g, b]) => {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const d = max - Math.min(x, y, z);
  const hue = !d ? 0 : max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  return [(hue * 60 + 360) % 360, max ? d / max : 0, max];
};
const fromHsv = (hh, s, v) => {
  const f = n => { const k = (n + hh / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
};

const cp = { el: null, line: -1, hsv: [0, 0, 0], alpha: 1, opener: null };

function openColourPicker(line, token, opener) {
  closeColourPicker();
  const value = $('#theme-ed-text').value.split('\n')[line].match(COLOUR_LINE)?.[4].trim();
  const c = rgbaOf(value);
  if (!c) return;
  // A fully transparent colour: what you pick should show, so it starts opaque.
  Object.assign(cp, { line, hsv: toHsv(c), alpha: c[3] || 1, opener, before: value });
  const num = (label, i) => h('label', { class: 'cp-num' }, h('span', {}, label),
    h('input', { type: 'number', min: '0', max: '255', step: '1', 'aria-label': label === 'R' ? 'Red' : label === 'G' ? 'Green' : 'Blue', dataset: { ch: String(i) } }));
  const el = h('div', { class: 'cpick', role: 'dialog', 'aria-label': `Colour for ${token}` },
    h('div', { class: 'cp-head' }, h('code', {}, token), h('span', { class: 'cp-pair' }, h('span', { class: 'cp-old', title: 'Before' }), h('span', { class: 'cp-new', title: 'Now' }))),
    h('div', { class: 'cp-sv', tabindex: '0', 'aria-label': 'Saturation and brightness: arrow keys move', role: 'slider' }, h('span', { class: 'cp-dot' })),
    h('input', { class: 'cp-hue', type: 'range', min: '0', max: '360', step: '1', 'aria-label': 'Hue' }),
    h('div', { class: 'cp-row' }, num('R', 0), num('G', 1), num('B', 2),
      h('label', { class: 'cp-num cp-hex' }, h('span', {}, 'Hex'), h('input', { type: 'text', maxlength: '7', spellcheck: 'false', 'aria-label': 'Hex' }))),
    h('div', { class: 'cp-foot' },
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { setThemeLine(cp.line, cp.before); closeColourPicker(true); } }, 'Undo'),
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => closeColourPicker(true) }, 'Done')));
  el.querySelector('.cp-old').style.background = value;
  document.body.append(el);
  cp.el = el;
  // Beside the swatch, inside the window.
  const r = opener.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.right + 10, innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(r.top - 20, innerHeight - hgt - 8))}px`;

  const sv = el.querySelector('.cp-sv');
  const pickAt = ev => {
    const b = sv.getBoundingClientRect();
    cp.hsv[1] = Math.min(1, Math.max(0, (ev.clientX - b.left) / b.width));
    cp.hsv[2] = 1 - Math.min(1, Math.max(0, (ev.clientY - b.top) / b.height));
    commitColour();
  };
  sv.addEventListener('pointerdown', ev => { sv.setPointerCapture(ev.pointerId); pickAt(ev); });
  sv.addEventListener('pointermove', ev => { if (sv.hasPointerCapture(ev.pointerId)) pickAt(ev); });
  sv.addEventListener('keydown', ev => {
    const step = ev.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[ev.key];
    if (!d) return;
    ev.preventDefault();
    cp.hsv[1] = Math.min(1, Math.max(0, cp.hsv[1] + d[0]));
    cp.hsv[2] = Math.min(1, Math.max(0, cp.hsv[2] + d[1]));
    commitColour();
  });
  el.querySelector('.cp-hue').addEventListener('input', ev => { cp.hsv[0] = Number(ev.target.value); commitColour(); });
  el.querySelectorAll('.cp-num input[type=number]').forEach(inp => inp.addEventListener('input', () => {
    const rgb = [...el.querySelectorAll('.cp-num input[type=number]')].map(x => Math.min(255, Math.max(0, Math.round(Number(x.value) || 0))));
    cp.hsv = toHsv(rgb);
    commitColour(true);
  }));
  el.querySelector('.cp-hex input').addEventListener('input', ev => {
    const v = ev.target.value.trim();
    if (!/^#?[0-9a-f]{6}$/i.test(v)) return;
    cp.hsv = toHsv(rgbaOf(v.startsWith('#') ? v : `#${v}`));
    commitColour(false, true);
  });
  el.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeColourPicker(true); } });
  paintPicker();
  sv.focus();
}

/** The picker's controls from its colour; `fromNums`/`fromHex` leave the box being typed in alone. */
function paintPicker(fromNums = false, fromHex = false) {
  const el = cp.el;
  const rgb = fromHsv(...cp.hsv);
  el.querySelector('.cp-sv').style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${cp.hsv[0]} 100% 50%))`;
  const dot = el.querySelector('.cp-dot');
  dot.style.left = `${cp.hsv[1] * 100}%`;
  dot.style.top = `${(1 - cp.hsv[2]) * 100}%`;
  el.querySelector('.cp-sv').setAttribute('aria-valuetext', `saturation ${Math.round(cp.hsv[1] * 100)}%, brightness ${Math.round(cp.hsv[2] * 100)}%`);
  el.querySelector('.cp-hue').value = String(Math.round(cp.hsv[0]));
  if (!fromNums) el.querySelectorAll('.cp-num input[type=number]').forEach((x, i) => { x.value = String(rgb[i]); });
  if (!fromHex) el.querySelector('.cp-hex input').value = hexOf(rgb);
  el.querySelector('.cp-new').style.background = hexOf(rgb);
}

function commitColour(fromNums = false, fromHex = false) {
  paintPicker(fromNums, fromHex);
  const rgb = fromHsv(...cp.hsv);
  // A see-through colour stays see-through (only its colour changes).
  setThemeLine(cp.line, cp.alpha < 1 ? `rgb(${rgb.join(' ')} / ${Math.round(cp.alpha * 100) / 100})` : hexOf(rgb));
}

function closeColourPicker(refocus = false) {
  if (!cp.el) return;
  cp.el.remove();
  cp.el = null;
  if (refocus) $(`#theme-ed-sw [data-line="${cp.line}"]`)?.focus();
}
document.addEventListener('pointerdown', ev => { if (cp.el && !ev.target.closest('.cpick, .theme-sw')) closeColourPicker(); });
addEventListener('resize', () => closeColourPicker());
// Leaving the page (the sidebar, Ctrl+B, a link) closes it too.
$$('.nav-item, [data-goto]').forEach(b => b.addEventListener('click', () => closeColourPicker()));

function goToThemeLine(n) {
  const ta = $('#theme-ed-text');
  const lines = ta.value.split('\n');
  const start = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
  ta.focus();
  ta.setSelectionRange(start, start + (lines[n - 1] || '').length);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, (n - 4) * lh);
  syncThemeScroll();
}

const saveCustomTheme = debounce(() => {
  const text = $('#theme-ed-text').value;
  store.set('theme.custom', text);
  if (themeState.id === 'custom') { applyTheme('custom', text); sendWindowBackground(); }
  renderThemeGrid();
}, 200);

$('#theme-ed-text').addEventListener('input', () => { paintThemeEditor(); saveCustomTheme(); });
$('#theme-ed-text').addEventListener('scroll', syncThemeScroll);
// The editor's own keys stay in it (the page's shortcuts would otherwise act on them). Tab still leaves it.
$('#theme-ed-text').addEventListener('keydown', ev => ev.stopPropagation());

$('#theme-ed-base').replaceChildren(...Object.entries(THEMES).map(([id, t]) => h('option', { value: id }, t.name)));
$('#theme-ed-load').addEventListener('click', async () => {
  const id = $('#theme-ed-base').value;
  const ta = $('#theme-ed-text');
  if (ta.value.trim() && ta.value !== themeTemplate(id) && !await confirmBox('Replace your custom theme?', `Its text is replaced with ${THEMES[id].name}'s colours, to change from there.`, 'Replace')) return;
  ta.value = themeTemplate(id);
  paintThemeEditor();
  saveCustomTheme();
  ta.focus();
});
$('#theme-ed-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#theme-ed-text').value);
  toast('Theme copied', 'success');
});

renderThemeGrid();
showThemeEditor(themeState.id === 'custom');
