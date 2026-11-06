'use strict';
/* global api, $, $$, h, icon, run, toast, confirmBox, store, themeFx, themeState, applyTheme, renderThemeGrid, sendWindowBackground, fmtSize, debounce */

// ---------------------------------------------------------------- Settings > Interface > Custom: Theme Studio
// The custom theme as a suite: Colours (the editor in theme-editor.js), Background, Glass, Animation
// and Library (named themes saved in Documents/Edgerunners Mod Manager/Themes). Every change shows at
// once; the effects themselves are themefx.js, the files the main process (core/themeFiles.js).

// One block: these names stay out of the other pages' (scripts share one global scope).
{
const TABS = [['colors', 'Colours'], ['bg', 'Background'], ['glass', 'Glass'], ['anim', 'Animation'], ['lib', 'Library']];
const PRESET_NAMES = [['none', 'None'], ['petals', 'Cherry blossom petals'], ['snow', 'Snow'], ['rain', 'Rain'], ['embers', 'Embers'], ['bubbles', 'Bubbles'], ['stars', 'Twinkling stars'], ['custom', 'My own code']];
const LAYER_NAMES = [['background', 'Behind the app', 'Over the background picture only: the sidebar and panels stay on top'], ['page', 'Over the page', 'Over the open page, not the sidebar'], ['top', 'Over everything', 'Over the whole window (it never gets in the way of the pointer)']];
const CODE_EXAMPLE = `// Falling petals, drawn by hand. fx.setup runs once (and on resize); fx.frame every frame.
const petals = [];
fx.setup = (ctx, w, h) => {
  petals.length = 0;
  for (let i = 0; i < 70; i++) petals.push({ x: fx.random(0, w), y: fx.random(0, h), r: fx.random(4, 9), a: fx.random(0, 6.3) });
};
fx.frame = (ctx, t, dt, w, h) => {
  ctx.clearRect(0, 0, w, h);
  for (const p of petals) {
    p.y += 30 * fx.speed * dt;
    p.x += Math.sin(t + p.a) * 20 * dt;
    if (p.y > h + 10) { p.y = -10; p.x = fx.random(0, w); }
    ctx.fillStyle = fx.colors[0] || '#ffc0d9';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, p.r, p.r * 0.6, t + p.a, 0, Math.PI * 2);
    ctx.fill();
  }
};`;

const studio = { tab: store.get('theme.studioTab', 'colors'), built: false, codeError: '' };

/** A labelled slider that applies as it moves. */
function slider(label, value, min, max, step, unit, onInput, hint = '') {
  const out = h('span', { class: 'ts-val' }, `${value}${unit}`);
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
  input.addEventListener('input', () => { out.textContent = `${input.value}${unit}`; onInput(Number(input.value)); });
  return h('label', { class: 'ts-field' }, h('span', { class: 'ts-label' }, label, hint ? h('span', { class: 'ts-hint' }, hint) : null), h('span', { class: 'ts-slider' }, input, out));
}
function select(label, value, options, onChange) {
  const sel = h('select', { 'aria-label': label }, ...options.map(([v, text]) => h('option', { value: v }, text)));
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return h('label', { class: 'ts-field' }, h('span', { class: 'ts-label' }, label), sel);
}
function toggle(label, on, onChange, hint = '') {
  const box = h('input', { type: 'checkbox', class: 'toggle', checked: !!on });
  box.addEventListener('change', () => onChange(box.checked));
  return h('label', { class: 'ts-field ts-toggle' }, h('span', { class: 'ts-label' }, label, hint ? h('span', { class: 'ts-hint' }, hint) : null), box);
}
/** A picture of the theme (background or particle): what it is now, choose another, or remove it. */
function picture(kind, label, note) {
  const url = themeFx.images[kind];
  const pick = async () => {
    const r = await run(api.themePickImage(kind));
    if (r) { themeFx.setImage(kind, r); paintStudio(); }
  };
  const remove = async () => { await run(api.themeClearImage(kind)); themeFx.setImage(kind, ''); paintStudio(); };
  return h('div', { class: 'ts-picture' },
    h('div', { class: 'ts-pic-frame' }, url ? h('img', { src: url, alt: '' }) : h('span', { class: 'muted' }, 'No picture')),
    h('div', { class: 'ts-pic-side' },
      h('span', { class: 'ts-label' }, label), h('span', { class: 'ts-hint' }, note),
      h('div', { class: 'ts-row' },
        h('button', { type: 'button', class: 'btn btn-sm', onclick: pick }, icon('folder'), h('span', {}, url ? 'Change…' : 'Choose a picture…')),
        url ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: remove }, icon('trash'), h('span', {}, 'Remove')) : null)));
}

// ---------------------------------------------------------------- the panes

function paneBackground() {
  const s = themeFx.settings.bg;
  const up = patch => themeFx.update({ bg: patch });
  return [
    picture('background', 'Background picture', 'PNG, JPEG, WebP or GIF, up to 20 MB. It fills the window behind the app.'),
    h('div', { class: 'ts-grid' },
      select('Fit', s.fit, [['cover', 'Fill the window'], ['contain', 'Whole picture'], ['center', 'Centred, its own size'], ['tile', 'Tiled']], v => up({ fit: v })),
      slider('Dim', s.dim, 0, 90, 1, '%', v => up({ dim: v }), 'Darkens the picture, so text stays readable'),
      slider('Blur', s.blur, 0, 30, 1, ' px', v => up({ blur: v })),
      slider('Page and sidebar', s.page, 0, 100, 1, '%', v => up({ page: v }), 'How solid they are: lower lets the picture show through'),
      slider('Panels and cards', s.panels, 0, 100, 1, '%', v => up({ panels: v }), 'Tables, cards, the details panel')),
    h('p', { class: 'ts-note' }, 'See-through parts apply while there is a picture, or an animation behind the app. The readability checks in Colours measure the solid colours: keep panels solid enough for text.'),
  ];
}

function paneGlass() {
  const s = themeFx.settings.glass;
  return [
    h('div', { class: 'ts-grid' }, slider('Frosted glass', s.blur, 0, 40, 1, ' px', v => themeFx.update({ glass: { blur: v } }), 'Blurs what is behind see-through panels, the sidebar, menus and dialogs')),
    h('p', { class: 'ts-note' }, 'Glass shows over a background picture or an animation behind the app, with panels set below 100% in Background. 0 turns it off. Strong blur costs more for the graphics card.'),
  ];
}

function paneAnimation() {
  const p = themeFx.settings.particles;
  const up = patch => { themeFx.update({ particles: patch }); };
  const custom = p.preset === 'custom';
  const layers = h('div', { class: 'ts-layers', role: 'radiogroup', 'aria-label': 'Where the animation is drawn' },
    ...LAYER_NAMES.map(([v, text, tip]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(p.layer === v), class: `ts-layer${p.layer === v ? ' on' : ''}`, title: tip,
      onclick: () => { up({ layer: v }); paintStudio(); },
    }, h('span', { class: `ts-layer-pic ts-layer-${v}`, 'aria-hidden': 'true' }, h('i'), h('b'), h('em')), h('span', {}, text))));
  const colours = h('div', { class: 'ts-colours' },
    ...p.colors.map((c, i) => {
      const inp = h('input', { type: 'color', value: c, 'aria-label': `Colour ${i + 1}` });
      inp.addEventListener('input', debounce(() => { const list = themeFx.settings.particles.colors.slice(); list[i] = inp.value; up({ colors: list }); }, 120));
      return h('span', { class: 'ts-colour' }, inp,
        p.colors.length > 1 ? h('button', { type: 'button', class: 'btn btn-icon btn-ghost btn-sm', 'aria-label': `Remove colour ${i + 1}`, onclick: () => { up({ colors: p.colors.filter((_, j) => j !== i) }); paintStudio(); } }, icon('x')) : null);
    }),
    p.colors.length < 6 ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { up({ colors: [...p.colors, '#ffffff'] }); paintStudio(); } }, icon('plus'), h('span', {}, 'Colour')) : null);
  const codeBox = h('textarea', { class: 'ts-code mono', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Animation code', rows: '14' });
  codeBox.value = themeFx.code || CODE_EXAMPLE;
  codeBox.addEventListener('keydown', ev => ev.stopPropagation()); // the page's shortcuts stay out of the editor
  const err = h('p', { class: `ts-code-err${studio.codeError ? '' : ' ok'}`, role: 'status' }, studio.codeError ? `Stopped: ${studio.codeError}`
    : themeFx.codeWaiting ? 'This code came with a theme file and has not run yet. Read it, then press Run.'
      : 'Runs sealed off: it can only draw on its own canvas (no files, no internet, no access to the app), and is stopped if a frame takes over 3 seconds.');
  return [
    h('div', { class: 'ts-grid' },
      select('Effect', p.preset, PRESET_NAMES, v => { up({ preset: v }); studio.codeError = ''; paintStudio(); })),
    h('div', { class: 'ts-field' }, h('span', { class: 'ts-label' }, 'Draw it'), layers),
    p.preset !== 'none' && !custom ? h('div', { class: 'ts-grid' },
      slider('How many', p.count, 5, 400, 5, '', v => up({ count: v })),
      slider('Size', p.size, 0.3, 4, 0.1, '×', v => up({ size: v })),
      slider('Speed', p.speed, 0.1, 4, 0.1, '×', v => up({ speed: v })),
      slider('Wind', p.wind, -3, 3, 0.1, '', v => up({ wind: v }), 'Left or right'),
      toggle('Spin', p.spin, v => up({ spin: v }))) : null,
    p.preset !== 'none' ? h('div', { class: 'ts-field' }, h('span', { class: 'ts-label' }, 'Colours'), colours) : null,
    p.preset !== 'none' ? picture('particle', 'Particle picture', custom ? 'Given to your code as fx.image.' : 'Your own shape, e.g. a petal picture with a transparent background.') : null,
    p.preset !== 'none' && !custom && themeFx.images.particle ? h('div', { class: 'ts-grid' }, toggle('Use the picture as the particle', p.useImage, v => up({ useImage: v }))) : null,
    custom ? h('div', { class: 'ts-field ts-code-wrap' },
      h('span', { class: 'ts-label' }, 'Your animation', h('span', { class: 'ts-hint' }, 'Set fx.setup(ctx, w, h) and fx.frame(ctx, t, dt, w, h). You also get fx.colors, fx.image, fx.speed and fx.random(a, b).')),
      codeBox,
      h('div', { class: 'ts-row' },
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => { studio.codeError = ''; themeFx.setCode(codeBox.value); err.className = 'ts-code-err ok'; err.textContent = 'Running.'; } }, icon('play'), h('span', {}, 'Run')),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { codeBox.value = CODE_EXAMPLE; } }, h('span', {}, 'Example'))),
      err) : null,
    h('div', { class: 'ts-grid' }, toggle('Follow "reduce motion"', themeFx.settings.reduceMotion, v => themeFx.update({ reduceMotion: v }), 'When your system asks for less motion, the animation stays off')),
  ];
}

async function paneLibrary(box) {
  const nameIn = h('input', { type: 'text', maxlength: '60', placeholder: 'Cherry Blossom', 'aria-label': 'Theme name', value: store.get('theme.studioName', '') });
  const save = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('Give the theme a name first', 'warn'); return; }
    store.set('theme.studioName', name);
    const theme = { colors: store.get('theme.custom', ''), fx: themeFx.settings, code: themeFx.code, imageUrls: themeFx.images };
    let r = await api.themeSave(name, theme, false);
    if (r.error && /saved already/.test(r.error)) {
      if (!(await confirmBox(`Replace "${name}"?`, 'A theme with that name is saved already. Saving replaces it with the theme as it is now.', 'Replace'))) return;
      r = await api.themeSave(name, theme, true);
    }
    if (r.error) { toast(r.error, 'error'); return; }
    toast(`Saved "${r.ok.name}"`, 'success', { label: 'Open folder', fn: () => run(api.themesOpenFolder()) });
    paintStudio();
  };
  nameIn.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
  box.replaceChildren(
    h('div', { class: 'ts-save' },
      h('label', { class: 'ts-field' }, h('span', { class: 'ts-label' }, 'Save this theme as'), nameIn),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: save }, icon('save'), h('span', {}, 'Save'))),
    h('p', { class: 'muted' }, 'Loading…'));
  const r = await api.themesList();
  if (studio.tab !== 'lib') return;
  const list = r.ok?.list || [];
  const load = async t => {
    if (!(await confirmBox(`Load "${t.name}"?`, 'It replaces your custom theme as it is now (save that first if you want to keep it).', 'Load'))) return;
    const got = await run(api.themeLoad(t.name));
    if (!got) return;
    if (got.code && got.fx?.particles?.preset === 'custom') toast(`"${t.name}" has its own animation code. It does not run until you press Run in Animation; it can then draw anywhere on its layer, but reach nothing else`, 'info');
    applyLoaded(got);
    nameIn.value = got.name;
    store.set('theme.studioName', got.name);
    toast(`Loaded "${got.name}"`, 'success');
  };
  const remove = async t => {
    if (!(await confirmBox(`Delete "${t.name}"?`, 'The theme file goes to the recycle bin.', 'Delete', true))) return;
    if (await run(api.themeRemove(t.name))) { toast(`"${t.name}" is in the recycle bin`, 'success'); paintStudio(); }
  };
  box.lastChild.replaceWith(
    h('div', { class: 'ts-lib-head' },
      h('span', { class: 'ts-label' }, `Saved themes (${list.length})`),
      h('span', { class: 'ts-hint ts-path', title: r.ok?.dir || '' }, r.ok?.dir || ''),
      h('span', { class: 'ts-row' },
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => run(api.themesOpenFolder()) }, icon('folder'), h('span', {}, 'Open folder')),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: async () => { const n = await run(api.themeImport()); if (n) { toast(`Imported "${n}"`, 'success'); paintStudio(); } } }, icon('download'), h('span', {}, 'Import…')))),
    list.length ? h('ul', { class: 'ts-lib' }, ...list.map(t => h('li', {},
      h('span', { class: 'ts-lib-name' }, h('b', {}, t.name), h('span', { class: 'ts-hint' }, `${fmtSize(t.size)} · ${new Date(t.at).toLocaleDateString()}`)),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load(t) }, h('span', {}, 'Load')),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': `Delete ${t.name}`, onclick: () => remove(t) }, icon('trash')))))
      : h('p', { class: 'muted' }, 'No themes saved yet. Name this one above and save it; the file can be shared, and Import adds one someone sent you.'));
}

/** A theme loaded from a file: its colours into the editor, its effects on the page. */
function applyLoaded(t) {
  const ta = $('#theme-ed-text');
  store.set('theme.custom', t.colors || '');
  ta.value = t.colors || '';
  themeFx.load(t);
  ta.dispatchEvent(new Event('input')); // the editor repaints and applies the colours
  if (themeState.id === 'custom') { applyTheme('custom', ta.value); sendWindowBackground(); }
  renderThemeGrid();
  paintStudio();
}

// ---------------------------------------------------------------- the tabs

function paintStudio() {
  const tabs = $('#theme-tabs');
  if (!tabs) return;
  tabs.replaceChildren(...TABS.map(([id, text]) => h('button', {
    type: 'button', role: 'tab', class: `seg-btn${studio.tab === id ? ' active' : ''}`, 'aria-selected': String(studio.tab === id), dataset: { tab: id },
    onclick: () => { studio.tab = id; store.set('theme.studioTab', id); paintStudio(); tabs.querySelector(`[data-tab="${id}"]`)?.focus(); },
  }, text)));
  const colours = studio.tab === 'colors';
  $('#theme-ed .theme-ed-main').hidden = !colours;
  $('#theme-ed .theme-ed-head').classList.toggle('ts-colours-only', !colours);
  const pane = $('#theme-pane');
  pane.hidden = colours;
  if (colours) return;
  if (studio.tab === 'lib') { paneLibrary(pane); return; }
  pane.replaceChildren(...(studio.tab === 'bg' ? paneBackground() : studio.tab === 'glass' ? paneGlass() : paneAnimation()).filter(Boolean));
}

themeFx.onCodeError = msg => {
  studio.codeError = msg;
  const err = $('#theme-pane .ts-code-err');
  if (err) { err.className = 'ts-code-err'; err.textContent = `Stopped: ${msg}`; }
};
paintStudio();
}
