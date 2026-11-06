'use strict';

// ---------------------------------------------------------------- themes

/*
 * A theme sets the base colours: CSS custom properties on <html>. Everything else (soft tints,
 * borders of chips, hover fills) is mixed from them in styles.css, so a theme needs only these.
 * Netrunner is the stylesheet's own values. A custom theme is the same list as text: one
 * "--token: colour;" per line, and only colours (checked by the browser) are taken from it.
 * Loaded in <head>, before the page draws, so it never flashes the wrong colours.
 */

/** Every base token, in the order the template lists them, with what it colours. */
const THEME_TOKENS = [
  ['Surfaces, darkest to lightest (in a light theme: the page is darker than its cards)', [
    ['--side-bg', 'sidebar, Activity line'], ['--bg', 'the page'], ['--panel', 'detail panels on the right'],
    ['--surface', 'tables, lists, cards'], ['--surface-2', 'table headers, raised cards'], ['--hover-bg', 'a row under the pointer'],
    ['--surface-3', 'the selected row, icon tiles'], ['--nav-active', 'the open page in the sidebar and in Settings'], ['--seg-on', 'the chosen tab of a tab group, progress tracks'],
    ['--menu-bg', 'menus and dropdowns'], ['--console-bg', 'code blocks, log text'],
  ]],
  ['Lines', [
    ['--line-soft', 'between rows'], ['--line', 'around containers'], ['--line-side', 'edges of the sidebar and panels'],
    ['--line-strong', 'around buttons'], ['--line-menu', 'inside menus'], ['--field-line', 'around text fields and toggles'],
  ]],
  ['Text', [
    ['--text', 'titles and names'], ['--text-body', 'reading text (AI answers)'], ['--text-2', 'secondary text'],
    ['--muted', 'details under names, labels'], ['--faint', 'hints, placeholders, times'], ['--disabled', 'switched-off controls'],
  ]],
  ['Accent: the one main button per page, the active nav item', [
    ['--accent', 'the colour'], ['--accent-hover', 'under the pointer'], ['--accent-ink', 'text on it'],
  ]],
  ['States', [
    ['--select', 'selection, checkboxes'], ['--info', 'information, updates'], ['--info-text', 'information as text'],
    ['--ok', 'Play, enabled, installed'], ['--ok-hover', 'Play under the pointer'], ['--ok-ink', 'text on green'], ['--ok-text', 'green as text'],
    ['--running-bg', 'Play while the game runs'], ['--running-hover', 'that, under the pointer'],
    ['--warn', 'warnings'], ['--warn-text', 'warnings as text'],
    ['--err', 'errors'], ['--err-text', 'errors as text'], ['--err-code', 'error lines in logs'], ['--err-ink', 'text on red'],
    ['--violet', 'a profile colour'], ['--violet-text', 'that, as text'],
  ]],
  ['Switches', [
    ['--toggle-on', 'a switch that is on'], ['--toggle-on-knob', 'its knob'], ['--toggle-off', 'a switch that is off'],
    ['--toggle-off-knob', 'its knob'], ['--toggle-edge', 'an outline for a switch that is off (transparent: none)'],
  ]],
  ['Code (the file editor, this editor)', [
    ['--tk-str', 'strings'], ['--tk-num', 'numbers, true/false'], ['--tk-kw', 'keywords'], ['--tk-type', 'types'], ['--tk-fn', 'functions'],
  ]],
  ['Depth', [
    ['--scrim', 'behind dialogs'], ['--shadow', 'menus and dialogs (a box-shadow)'], ['--shadow-sm', 'small raised things (a box-shadow)'],
  ]],
];
/** Colours that mean different things and must not look alike: their hues at least this far apart (degrees), or their lightness. */
const THEME_APART = [['Accent and errors', '--accent', '--err'], ['Accent and warnings', '--accent', '--warn'], ['Warnings and errors', '--warn', '--err'], ['Accent and selection', '--accent', '--select']];
const THEME_KEYS = THEME_TOKENS.flatMap(([, list]) => list.map(([k]) => k));
/** Colours the app puts on top of each other, and the contrast each needs (WCAG: 4.5 text, 3 large text and edges). */
const THEME_CHECKS = [
  ['Titles on the page', '--text', '--bg', 4.5], ['Text on cards', '--text', '--surface', 4.5], ['Secondary text', '--text-2', '--surface', 4.5],
  ['Details under names', '--muted', '--surface', 4.5], ['Hints and times', '--faint', '--surface', 4.5], ['Sidebar labels', '--muted', '--side-bg', 4.5],
  ['Menus', '--text', '--menu-bg', 4.5], ['Details in menus', '--muted', '--menu-bg', 4.5], ['Secondary text in menus', '--text-2', '--menu-bg', 4.5],
  ['Details on the selected row', '--muted', '--surface-3', 4.5], ['Details on chosen tabs', '--muted', '--seg-on', 4.5], ['Details under the pointer', '--muted', '--hover-bg', 4.5], ['Main button', '--accent-ink', '--accent', 4.5], ['Accent as text', '--accent', '--bg', 3],
  ['Play button', '--ok-ink', '--ok', 4.5], ['While the game runs', '--ok-text', '--running-bg', 4.5], ['Text on red', '--err-ink', '--err', 4.5],
  ['Green text', '--ok-text', '--surface', 4.5], ['Red text', '--err-text', '--surface', 4.5], ['Warning text', '--warn-text', '--surface', 4.5],
  ['Information text', '--info-text', '--surface', 4.5], ['Log error lines', '--err-code', '--console-bg', 4.5], ['Text field edges', '--field-line', '--surface', 2.2], ['Open page in the sidebar', '--nav-active', '--side-bg', 1.15],
  ['A switch that is on', '--toggle-on', '--surface', 3], ['The knob of a switch that is off', '--toggle-off-knob', '--toggle-off', 3],
];
const SHADOW_KEYS = new Set(['--shadow', '--shadow-sm']);
// Mixed from the base colours in styles.css; a custom theme may set them too, to fine-tune.
const THEME_DERIVED = ['--accent-soft', '--accent-off', '--accent-off-text', '--accent-off-dim', '--focus-ring', '--select-soft', '--select-strong', '--hover',
  '--ok-soft', '--warn-soft', '--err-soft', '--info-soft', '--ok-line', '--warn-line', '--err-line', '--info-line', '--ok-track',
  '--err-tint', '--crash-tint', '--warn-tint', '--err-soft-hover'];

const THEMES = {
  netrunner: {
    name: 'Netrunner', desc: 'The default: dark, with Night City yellow', scheme: 'dark',
    tokens: {
      '--side-bg': '#0a0c0f', '--bg': '#0d0f12', '--panel': '#0f1215', '--surface': '#111418', '--surface-2': '#13161b', '--hover-bg': '#15181d',
      '--surface-3': '#1a1e24', '--nav-active': '#1a1e24', '--seg-on': '#22262d', '--menu-bg': '#1f232a', '--console-bg': '#0a0c0f',
      '--line-soft': '#1a1d22', '--line': '#1e2228', '--line-side': '#1c2026', '--line-strong': '#2a2f37', '--line-menu': '#2f343d', '--field-line': '#4a505a',
      '--text': '#e6e8eb', '--text-body': '#d5d8dd', '--text-2': '#a3a9b3', '--muted': '#7a808b', '--faint': '#6f7580', '--disabled': '#4a505a',
      '--accent': '#f2dc4b', '--accent-hover': '#f7e46a', '--accent-ink': '#17150a',
      '--select': '#66b8ea', '--info': '#66b8ea', '--info-text': '#7cc4f0',
      '--ok': '#4cc98a', '--ok-hover': '#5cd59a', '--ok-ink': '#07140d', '--ok-text': '#8ee0b5', '--running-bg': '#1b3a2a', '--running-hover': '#214532',
      '--warn': '#edb864', '--warn-text': '#f2c98a', '--err': '#f0675c', '--err-text': '#f58a80', '--err-code': '#f5a39b', '--err-ink': '#1a0705',
      '--violet': '#a78bfa', '--violet-text': '#b9a6fb',
      '--tk-str': '#a8d8a0', '--tk-num': '#f0b479', '--tk-kw': '#c7a0f5', '--tk-type': '#79c0ff', '--tk-fn': '#e8d48b',
      '--scrim': 'rgb(5 6 8 / 0.72)', '--shadow': '0 1.1rem 2.7rem rgb(0 0 0 / 0.55)', '--shadow-sm': '0 1px 2px rgb(0 0 0 / 0.3)',
      '--toggle-on': '#4cc98a', '--toggle-on-knob': '#0a0c0f', '--toggle-off': '#2a2f37', '--toggle-off-knob': '#7a808b', '--toggle-edge': 'transparent',
    },
  },
  david: {
    name: 'We made it, David ~', desc: 'Light: moon-dust greys and white, with a lunar violet', scheme: 'light',
    tokens: {
      '--side-bg': '#e8eaef', '--bg': '#f2f3f6', '--panel': '#eceef2', '--surface': '#ffffff', '--surface-2': '#f7f8fa', '--hover-bg': '#f0f2f5',
      '--surface-3': '#e6e9ef', '--seg-on': '#dde1e8', '--menu-bg': '#ffffff', '--console-bg': '#f0f2f5',
      '--line-soft': '#e4e7ec', '--line': '#d6dae1', '--line-side': '#cfd4dc', '--line-strong': '#c9ced7', '--line-menu': '#d6dae1', '--field-line': '#8a93a2',
      '--text': '#171c28', '--text-body': '#262d3b', '--text-2': '#485163', '--muted': '#565f70', '--faint': '#646d7d', '--disabled': '#98a0ae',
      '--accent': '#6553c9', '--accent-hover': '#7461d6', '--accent-ink': '#ffffff',
      '--select': '#3b7dc4', '--info': '#2f76bb', '--info-text': '#1d61a1',
      '--ok': '#147a49', '--ok-hover': '#178752', '--ok-ink': '#ffffff', '--ok-text': '#136d41', '--running-bg': '#d7efe3', '--running-hover': '#c8e8d8',
      '--warn': '#80500a', '--warn-text': '#7a4c08', '--err': '#a52f27', '--err-text': '#a02c24', '--err-code': '#9a2a22', '--err-ink': '#ffffff',
      '--violet': '#a04fbf', '--violet-text': '#86389f',
      '--tk-str': '#2c7a33', '--tk-num': '#ad5a00', '--tk-kw': '#7a3dbf', '--tk-type': '#1d5fae', '--tk-fn': '#86660a',
      '--scrim': 'rgb(28 33 45 / 0.38)', '--shadow': '0 1.1rem 2.7rem rgb(22 28 40 / 0.24)', '--shadow-sm': '0 1px 2px rgb(22 28 40 / 0.1)',
      '--toggle-on': '#147a49', '--toggle-on-knob': '#ffffff', '--toggle-off': '#d6dae1', '--toggle-off-knob': '#5f6879', '--toggle-edge': 'transparent',
      '--nav-active': '#ffffff',
    },
  },
  coyote: {
    name: 'El Coyote Cojo', desc: 'Warm and cosy: soft leather browns, cream text, caramel', scheme: 'dark',
    tokens: {
      '--side-bg': '#31251e', '--bg': '#3b2e26', '--panel': '#403229', '--surface': '#45362c', '--surface-2': '#4b3b30', '--hover-bg': '#4d3c31',
      '--surface-3': '#544236', '--nav-active': '#544236', '--seg-on': '#58453a', '--menu-bg': '#4f3e35', '--console-bg': '#31251e',
      '--line-soft': '#4f3e33', '--line': '#574538', '--line-side': '#4f3f34', '--line-strong': '#6c5747', '--line-menu': '#735d4c', '--field-line': '#a3896f',
      '--text': '#f7ecdd', '--text-body': '#eee2d0', '--text-2': '#dccab4', '--muted': '#ccb69e', '--faint': '#c0a990', '--disabled': '#75604f',
      '--accent': '#e8b483', '--accent-hover': '#f0c398', '--accent-ink': '#2b1a0d',
      '--select': '#93bcd9', '--info': '#93bcd9', '--info-text': '#add0e8',
      '--ok': '#a3cc9d', '--ok-hover': '#b3d9ad', '--ok-ink': '#1a2818', '--ok-text': '#bde0b7', '--running-bg': '#46533a', '--running-hover': '#4f5d41',
      '--warn': '#e3c94e', '--warn-text': '#f0dc86', '--err': '#ea8070', '--err-text': '#f6b8ab', '--err-code': '#f4b9ad', '--err-ink': '#2b120d',
      '--violet': '#c6a6dc', '--violet-text': '#d7bfe8',
      '--tk-str': '#bcdb9e', '--tk-num': '#f1b683', '--tk-kw': '#d9ade3', '--tk-type': '#a0cbea', '--tk-fn': '#eed596',
      '--scrim': 'rgb(22 13 8 / 0.66)', '--shadow': '0 1.1rem 2.7rem rgb(16 9 5 / 0.5)', '--shadow-sm': '0 1px 2px rgb(16 9 5 / 0.32)',
      '--toggle-on': '#a3cc9d', '--toggle-on-knob': '#31251e', '--toggle-off': '#6c5747', '--toggle-off-knob': '#ccb69e', '--toggle-edge': 'transparent',
    },
  },
  sakura: {
    name: 'Cherry Blossom', desc: 'Light: blossom pinks and white, a little bit cute', scheme: 'light',
    tokens: {
      '--side-bg': '#fde8ef', '--bg': '#fff5f8', '--panel': '#fff0f4', '--surface': '#ffffff', '--surface-2': '#fff7fa', '--hover-bg': '#ffebf2',
      '--surface-3': '#fde2eb', '--seg-on': '#fbd5e2', '--menu-bg': '#ffffff', '--console-bg': '#fff0f4',
      '--line-soft': '#f6dde6', '--line': '#efcdda', '--line-side': '#e9c1d1', '--line-strong': '#ebbdcf', '--line-menu': '#eec6d5', '--field-line': '#c27d99',
      '--text': '#3a1f30', '--text-body': '#47293b', '--text-2': '#6a465a', '--muted': '#77566a', '--faint': '#835f73', '--disabled': '#b895a7',
      '--accent': '#b23a63', '--accent-hover': '#9e3157', '--accent-ink': '#ffffff',
      '--select': '#7a58c9', '--info': '#4a7fc0', '--info-text': '#2f64a3',
      '--ok': '#23784a', '--ok-hover': '#2a8656', '--ok-ink': '#ffffff', '--ok-text': '#1d653f', '--running-bg': '#dff2e6', '--running-hover': '#d0ecda',
      '--warn': '#8a5a00', '--warn-text': '#784e00', '--err': '#bd3a24', '--err-text': '#a82c18', '--err-code': '#a02a1a', '--err-ink': '#ffffff',
      '--violet': '#9666d2', '--violet-text': '#7a49bc',
      '--tk-str': '#36824a', '--tk-num': '#b85a18', '--tk-kw': '#9c3e96', '--tk-type': '#3567ad', '--tk-fn': '#94680f',
      '--scrim': 'rgb(48 20 36 / 0.42)', '--shadow': '0 1.1rem 2.7rem rgb(110 35 75 / 0.15)', '--shadow-sm': '0 1px 2px rgb(110 35 75 / 0.09)',
      '--toggle-on': '#c2456f', '--toggle-on-knob': '#ffffff', '--toggle-off': '#ffffff', '--toggle-off-knob': '#c27d99', '--toggle-edge': '#d495ae',
      '--nav-active': '#ffffff',
    },
  },
  samurai: {
    name: 'Samurai', desc: 'Netrunner\'s dark, with Johnny\'s red', scheme: 'dark',
    tokens: {
      '--side-bg': '#0a0c0f', '--bg': '#0d0f12', '--panel': '#0f1215', '--surface': '#111418', '--surface-2': '#13161b', '--hover-bg': '#15181d',
      '--surface-3': '#1a1e24', '--nav-active': '#241c20', '--seg-on': '#22262d', '--menu-bg': '#1f232a', '--console-bg': '#0a0c0f',
      '--line-soft': '#1a1d22', '--line': '#1e2228', '--line-side': '#1c2026', '--line-strong': '#2a2f37', '--line-menu': '#2f343d', '--field-line': '#4a505a',
      '--text': '#e6e8eb', '--text-body': '#d5d8dd', '--text-2': '#a3a9b3', '--muted': '#8a909b', '--faint': '#7c828d', '--disabled': '#4a505a',
      '--accent': '#f5505c', '--accent-hover': '#f86b75', '--accent-ink': '#14050a',
      '--select': '#66b8ea', '--info': '#66b8ea', '--info-text': '#7cc4f0',
      '--ok': '#4cc98a', '--ok-hover': '#5cd59a', '--ok-ink': '#07140d', '--ok-text': '#8ee0b5', '--running-bg': '#1b3a2a', '--running-hover': '#214532',
      '--warn': '#e9cf52', '--warn-text': '#f0dc86', '--err': '#ff8a3d', '--err-text': '#ffa463', '--err-code': '#ffb47c', '--err-ink': '#1d0d03',
      '--violet': '#a78bfa', '--violet-text': '#b9a6fb',
      '--tk-str': '#a8d8a0', '--tk-num': '#f0b479', '--tk-kw': '#c7a0f5', '--tk-type': '#79c0ff', '--tk-fn': '#e8d48b',
      '--scrim': 'rgb(5 6 8 / 0.72)', '--shadow': '0 1.1rem 2.7rem rgb(0 0 0 / 0.55)', '--shadow-sm': '0 1px 2px rgb(0 0 0 / 0.3)',
      '--accent-off-text': '#c87580',
      '--toggle-on': '#f5505c', '--toggle-on-knob': '#14050a', '--toggle-off': '#2a2f37', '--toggle-off-knob': '#8a909b', '--toggle-edge': 'transparent',
    },
  },
  ncpd: {
    name: 'NCPD', desc: 'Deep navy with a badge-gold yellow', scheme: 'dark',
    tokens: {
      '--side-bg': '#0b1324', '--bg': '#0e172b', '--panel': '#111b31', '--surface': '#132036', '--surface-2': '#16243c', '--hover-bg': '#1a2942',
      '--surface-3': '#1f304d', '--nav-active': '#1f304d', '--seg-on': '#273a5a', '--menu-bg': '#1c2c47', '--console-bg': '#0b1324',
      '--line-soft': '#1b2943', '--line': '#213150', '--line-side': '#1d2c47', '--line-strong': '#2f4366', '--line-menu': '#344a70', '--field-line': '#5a6f93',
      '--text': '#e8edf6', '--text-body': '#d6deeb', '--text-2': '#aebbd0', '--muted': '#97a7c1', '--faint': '#8a9ab4', '--disabled': '#4a5a78',
      '--accent': '#f5c518', '--accent-hover': '#f8d23f', '--accent-ink': '#141005',
      '--select': '#6cb2f0', '--info': '#6cb2f0', '--info-text': '#8cc5f5',
      '--ok': '#4cc98a', '--ok-hover': '#5cd59a', '--ok-ink': '#07140d', '--ok-text': '#8ee0b5', '--running-bg': '#173a33', '--running-hover': '#1d463d',
      '--warn': '#f59e4c', '--warn-text': '#f8b878', '--err': '#f0675c', '--err-text': '#f58a80', '--err-code': '#f5a39b', '--err-ink': '#1a0705',
      '--violet': '#a78bfa', '--violet-text': '#b9a6fb',
      '--tk-str': '#a8d8a0', '--tk-num': '#f0b479', '--tk-kw': '#c7a0f5', '--tk-type': '#79c0ff', '--tk-fn': '#e8d48b',
      '--scrim': 'rgb(4 8 18 / 0.72)', '--shadow': '0 1.1rem 2.7rem rgb(0 4 14 / 0.55)', '--shadow-sm': '0 1px 2px rgb(0 4 14 / 0.3)',
      '--toggle-on': '#4cc98a', '--toggle-on-knob': '#0b1324', '--toggle-off': '#2f4366', '--toggle-off-knob': '#97a7c1', '--toggle-edge': 'transparent',
    },
  },
  corpo: {
    name: 'Corpo', desc: 'Light: crisp white with corporate navy', scheme: 'light',
    tokens: {
      '--side-bg': '#e4e9f2', '--bg': '#f2f5fa', '--panel': '#edf1f7', '--surface': '#ffffff', '--surface-2': '#f7f9fc', '--hover-bg': '#eef2f8',
      '--surface-3': '#e3e9f3', '--nav-active': '#ffffff', '--seg-on': '#d9e1ee', '--menu-bg': '#ffffff', '--console-bg': '#eef2f8',
      '--line-soft': '#e3e8f0', '--line': '#d3dbe7', '--line-side': '#ccd5e3', '--line-strong': '#bfc9d9', '--line-menu': '#ccd5e3', '--field-line': '#8592a8',
      '--text': '#0f1d3a', '--text-body': '#1c2a47', '--text-2': '#3c4a66', '--muted': '#4f5d79', '--faint': '#5c6984', '--disabled': '#a3adbf',
      '--accent': '#1f3f86', '--accent-hover': '#18336e', '--accent-ink': '#ffffff',
      '--select': '#2f6fd0', '--info': '#2a6cc4', '--info-text': '#1d5aa8',
      '--ok': '#157a48', '--ok-hover': '#198a52', '--ok-ink': '#ffffff', '--ok-text': '#126b3f', '--running-bg': '#d8efe3', '--running-hover': '#c9e8d8',
      '--warn': '#8a5800', '--warn-text': '#774c00', '--err': '#b3261e', '--err-text': '#a0221b', '--err-code': '#971f18', '--err-ink': '#ffffff',
      '--violet': '#a04fbf', '--violet-text': '#86389f',
      '--tk-str': '#2c7a33', '--tk-num': '#ad5a00', '--tk-kw': '#7a3dbf', '--tk-type': '#1d5fae', '--tk-fn': '#86660a',
      '--scrim': 'rgb(15 29 58 / 0.38)', '--shadow': '0 1.1rem 2.7rem rgb(15 29 58 / 0.2)', '--shadow-sm': '0 1px 2px rgb(15 29 58 / 0.1)',
      '--toggle-on': '#1f3f86', '--toggle-on-knob': '#ffffff', '--toggle-off': '#dfe5ef', '--toggle-off-knob': '#5c6984', '--toggle-edge': '#bfc9d9',
    },
  },
};

/**
 * Whether two colours ([r, g, b], 0-255) look different enough to mean different things: hues at
 * least 15 degrees apart, or lightness at least 15 points apart. { ok, hue, light }.
 */
function looksApart(a, b) {
  const hsl = ([r, g, b]) => {
    const [x, y, z] = [r / 255, g / 255, b / 255];
    const max = Math.max(x, y, z);
    const min = Math.min(x, y, z);
    const l = (max + min) / 2;
    const d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  };
  const [h1, s1, l1] = hsl(a);
  const [h2, s2, l2] = hsl(b);
  const light = Math.round(Math.abs(l1 - l2) * 100);
  const greyish = s1 < 0.12 || s2 < 0.12;
  const hue = greyish ? 0 : Math.round(Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2)));
  return { ok: hue >= 15 || light >= 15, hue, light };
}

/** The template a custom theme starts from: every token, with what it colours. */
function themeTemplate(from = 'netrunner') {
  const t = THEMES[from] || THEMES.netrunner;
  const pad = Math.max(...THEME_KEYS.map(k => k.length)) + 1;
  const out = [
    '/* Edgerunners Mod Manager theme. Every line: --token: colour;',
    '   Colours: #rgb, #rrggbb, rgb(…), hsl(…), oklch(…) or a colour name. --scheme is light or dark',
    '   (scrollbars and built-in controls follow it). Changes show at once in the whole app. */',
    '',
    `--scheme: ${t.scheme};`,
  ];
  for (const [title, list] of THEME_TOKENS) {
    out.push('', `/* ${title} */`);
    for (const [k, what] of list) out.push(`${`${k}:`.padEnd(pad)} ${t.tokens[k]};  /* ${what} */`);
  }
  const extra = Object.keys(t.tokens).filter(k => !THEME_KEYS.includes(k));
  if (extra.length) out.push('', '/* This theme\'s fine-tuning */', ...extra.map(k => `${`${k}:`.padEnd(pad)} ${t.tokens[k]};`));
  out.push('', '/* Optional fine-tuning. These are mixed from the colours above; to set one yourself, add it as a line,',
    '   e.g. --accent-soft: rgb(242 220 75 / 0.2);',
    ...THEME_DERIVED.map(k => `   ${k}`), '*/', '');
  return out.join('\n');
}

/**
 * A custom theme's text, read line by line: { tokens, scheme, errors: [{ line, text }] }. Only
 * the known tokens are taken, and only values the browser itself reads as a colour (or, for the
 * shadows, as a box-shadow), so the text can never add anything else to the page.
 */
function parseTheme(text) {
  const tokens = {};
  const errors = [];
  let scheme = 'dark';
  const known = new Set([...THEME_KEYS, ...THEME_DERIVED]);
  const src = String(text || '').slice(0, 60000);
  // Comments are blanked out (kept as spaces) so line numbers still match.
  const clean = src.replace(/\/\*[\s\S]*?(\*\/|$)/g, m => m.replace(/[^\n]/g, ' '));
  clean.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(/^(--[\w-]+)\s*:\s*(.+?)\s*;?$/);
    if (!m) { errors.push({ line: i + 1, text: 'Not a "--token: colour;" line' }); return; }
    const [, k, v] = m;
    if (k === '--scheme') {
      if (v === 'light' || v === 'dark') scheme = v; else errors.push({ line: i + 1, text: '--scheme is light or dark' });
      return;
    }
    if (!known.has(k)) { errors.push({ line: i + 1, text: `${k} is not a theme colour` }); return; }
    const ok = !/url\(|expression|[<>{}\\]/i.test(v) && (SHADOW_KEYS.has(k) ? CSS.supports('box-shadow', v) : CSS.supports('color', v));
    if (!ok) { errors.push({ line: i + 1, text: `${k}: "${v.slice(0, 40)}" is not a ${SHADOW_KEYS.has(k) ? 'shadow' : 'colour'}` }); return; }
    tokens[k] = v;
  });
  return { tokens, scheme, errors };
}

const themeState = { id: 'netrunner', applied: [] };
const themeStore = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

/** Put a theme on the page: a built-in one by id, or 'custom' with its text. */
function applyTheme(id, customText = themeStore.get('theme.custom', '')) {
  const root = document.documentElement;
  for (const k of themeState.applied) root.style.removeProperty(k);
  let tokens = {};
  let scheme = 'dark';
  if (id === 'custom') ({ tokens, scheme } = parseTheme(customText));
  else if (THEMES[id] && id !== 'netrunner') ({ tokens, scheme } = THEMES[id]);
  else id = 'netrunner';
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  themeState.applied = Object.keys(tokens);
  themeState.tokens = tokens; // (the effects put these back when they let a colour show through: themefx.js)
  themeState.id = id;
  root.style.colorScheme = scheme;
  root.dataset.theme = id;
  root.dataset.scheme = scheme;
  globalThis.applyThemeFx?.(); // the custom theme's picture, glass and animation (themefx.js), on the new colours
}

applyTheme(themeStore.get('theme', 'netrunner'));

// ---------------------------------------------------------------- the app's name

/** The names the app can go by (Settings > Interface). The first is the default. */
const APP_NAMES = ['Edgerunners Mod Manager', "Lucy's Mod Manager", "David's Mod Manager", "Netrunner's Mod Manager", 'Cyber Mod Manager'];
const appName = () => { const n = themeStore.get('app.name', APP_NAMES[0]); return APP_NAMES.includes(n) ? n : APP_NAMES[0]; };
/** Show the name: the window title and every element marked with the class app-name. */
function applyAppName() {
  document.title = appName();
  for (const el of document.querySelectorAll('.app-name')) el.textContent = appName();
}
document.title = appName();
document.addEventListener('DOMContentLoaded', applyAppName);
// The first run opens on the setup wizard: the app stays hidden until setup.js decides (no flash of it).
if (!themeStore.get('setup.done', false)) document.documentElement.dataset.setup = 'pending';
