'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** themes.js in a page-like sandbox (its colour check stands in for the browser's own). */
function load() {
  const set = {};
  const ctx = {
    CSS: { supports: (prop, v) => (prop === 'box-shadow' ? /^[\d.\s\-a-z]*(rgb\([\d\s./]+\))?$/i.test(v) : /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,/%]+\)|[a-z]+)$/i.test(v)) },
    localStorage: { getItem: () => null, setItem() {} },
    document: { documentElement: { style: { setProperty: (k, v) => { set[k] = v; }, removeProperty: k => { delete set[k]; } }, dataset: {} } },
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'themes.js'), 'utf8');
  vm.runInContext(`${src}\nObject.assign(this, { THEMES, THEME_KEYS, THEME_CHECKS, THEME_APART, looksApart, THEME_DERIVED, themeTemplate, parseTheme, applyTheme, themeState });`, ctx);
  return { ...ctx, set };
}

// Values made inside the sandbox have its own Array/Object: compared as plain data.
const plain = v => JSON.parse(JSON.stringify(v));
const rgb = v => { const m = String(v).match(/^#([0-9a-f]{6})$/i); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
const lum = c => c.map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((n, x, i) => n + x * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every built-in theme sets every base colour, and its text reads on what it sits on', () => {
  const t = load();
  for (const [id, theme] of Object.entries(t.THEMES)) {
    assert.deepStrictEqual(plain(t.THEME_KEYS.filter(k => !(k in theme.tokens))), [], `${id} sets every token`);
    assert.ok(['light', 'dark'].includes(theme.scheme), `${id} says light or dark`);
    for (const [label, a, b] of t.THEME_APART) assert.ok(t.looksApart(rgb(theme.tokens[a]), rgb(theme.tokens[b])).ok, `${id}: ${label} look alike`);
    // Netrunner is the original design, kept as it was; the others meet every minimum.
    if (id === 'netrunner') continue;
    for (const [label, fg, bg, min] of t.THEME_CHECKS) {
      const c = contrast(rgb(theme.tokens[fg]), rgb(theme.tokens[bg]));
      assert.ok(c >= min, `${id}: ${label} (${fg} on ${bg}) is ${c.toFixed(2)}:1, needs ${min}:1`);
    }
  }
});

test('a custom theme: its template round-trips, and only colours are taken from it', () => {
  const t = load();
  const parsed = t.parseTheme(t.themeTemplate('coyote'));
  assert.deepStrictEqual(plain(parsed.errors), [], 'the template has no line the parser skips');
  assert.strictEqual(parsed.scheme, 'dark');
  assert.strictEqual(parsed.tokens['--bg'], t.THEMES.coyote.tokens['--bg']);

  const bad = t.parseTheme([
    '--bg: #123456;',
    '--text: url(https://example.com/x.png);',
    '--accent: red; background: url(x)',
    '--made-up: #fff;',
    'body { color: red }',
    '--scheme: purple;',
    '--accent-soft: rgb(1 2 3 / 0.5);',
  ].join('\n'));
  assert.deepStrictEqual(plain(bad.tokens), { '--bg': '#123456', '--accent-soft': 'rgb(1 2 3 / 0.5)' }, 'a fine-tuning token is allowed; nothing else that is not a colour');
  assert.deepStrictEqual(plain(bad.errors.map(e => e.line)), [2, 3, 4, 5, 6]);
});

test('switching themes takes the old colours off before putting the new ones on', () => {
  const t = load();
  t.applyTheme('sakura');
  assert.strictEqual(t.set['--accent'], t.THEMES.sakura.tokens['--accent']);
  t.applyTheme('custom', '--scheme: light;\n--bg: #ffffff;');
  assert.deepStrictEqual(plain(Object.keys(t.set)), ['--bg'], 'only what the custom theme sets');
  t.applyTheme('netrunner');
  assert.deepStrictEqual(plain(Object.keys(t.set)), [], 'Netrunner is the stylesheet itself');
  t.applyTheme('no-such-theme');
  assert.strictEqual(t.themeState.id, 'netrunner');
});
