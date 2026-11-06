'use strict';
/* global api, Fomod, downloadLinks */
// Load order (index.html): fomod.js, app.js (core UI and shared helpers), gamelog.js, features.js.
// The later scripts use the helpers and hooks defined here (drawerSections, snapshotHooks, pageHooks).

// ---------------------------------------------------------------- helpers

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build DOM safely: strings become text nodes, never HTML. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `i ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const fmtSize = b => {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const CAT_LABEL = { MAIN: 'Main', UPDATE: 'Update', OPTIONAL: 'Optional', OLD_VERSION: 'Old version', MISCELLANEOUS: 'Misc', ARCHIVED: 'Archived', LOCAL: 'Local file' };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

/**
 * A toast with a title, a few lines, an × and a bar that shrinks until it closes (pointing at it
 * pauses it): news that should not vanish unread (Group Mods). action: { label, fn }.
 */
function newsToast({ title, lines = [], action = null, life = 12000, kind = 'info' }) {
  const bar = h('span', { class: 'toast-bar', 'aria-hidden': 'true' });
  bar.style.animationDuration = `${life}ms`;
  const el = h('div', { class: `toast toast-news ${kind}`, role: 'status' }, icon(kind === 'warn' ? 'alert' : 'users'),
    h('span', { class: 'toast-text' }, h('b', { class: 'toast-title' }, title),
      lines.length ? h('ul', { class: 'toast-lines' }, ...lines.slice(0, 5).map(l => h('li', {}, l)), lines.length > 5 ? h('li', { class: 'more' }, `and ${lines.length - 5} more`) : null) : null,
      action ? h('span', { class: 'toast-acts' }, h('button', { class: 'btn btn-sm btn-primary', onclick: () => { el.remove(); action.fn(); } }, action.label)) : null),
    h('button', { class: 'toast-x', 'aria-label': 'Close', title: 'Close', onclick: () => el.remove() }, icon('x')),
    bar);
  $('#toasts').append(el);
  while ($('#toasts').childElementCount > 4) $('#toasts').firstElementChild.remove();
  // Closed by a timer (not the bar's animation: reduced motion turns animations off), paused while the
  // pointer or focus is on it; the bar only shows the time left.
  let left = life;
  let since = Date.now();
  let timer = setTimeout(() => el.remove(), left);
  // Paused while the pointer is on it or focus is in it (each counted once, however they overlap).
  const held = { hover: false, focus: false };
  let paused = false;
  const pause = (why, on) => {
    held[why] = on;
    const now = held.hover || held.focus;
    if (now === paused) return;
    paused = now;
    bar.style.animationPlayState = now ? 'paused' : 'running';
    if (now) { clearTimeout(timer); left -= Date.now() - since; } else { since = Date.now(); clearTimeout(timer); timer = setTimeout(() => el.remove(), Math.max(1500, left)); }
  };
  el.addEventListener('mouseenter', () => pause('hover', true));
  el.addEventListener('mouseleave', () => pause('hover', false));
  el.addEventListener('focusin', () => pause('focus', true));
  el.addEventListener('focusout', () => pause('focus', false));
  return el;
}

function toast(msg, kind = 'info', action = null) {
  const name = kind === 'error' || kind === 'warn' ? 'alert' : kind === 'success' ? 'check' : 'terminal';
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(name), h('span', { class: 'toast-text' }, msg),
    action ? h('button', { class: 'btn btn-sm', onclick: () => { action.fn(); el.remove(); } }, action.label) : null);
  $('#toasts').append(el);
  // At most four at once: the oldest go first, so a burst never runs off the screen.
  while ($('#toasts').childElementCount > 4) $('#toasts').firstElementChild.remove();
  // One with a button stays longer, and never goes while the pointer is on it.
  const life = action ? 15000 : kind === 'error' ? 7000 : 3500;
  let timer = setTimeout(() => el.remove(), life);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(() => el.remove(), 4000); });
}

/** Call the API; errors are already in the activity log, so just toast them. */
async function run(promise, okMsg) {
  const res = await promise;
  if (res && res.error) { toast(res.error, 'error'); return null; }
  if (okMsg) toast(okMsg, 'success');
  return res ? res.ok : null;
}

/** Keep a segmented control's active button and aria-pressed in step. */
function setSegActive(group, attr, value) {
  $$(`${group} .seg-btn`).forEach(b => {
    const on = b.dataset[attr] === value;
    b.classList.toggle('active', on);
    if (b.getAttribute('role') !== 'tab') b.setAttribute('aria-pressed', String(on));
  });
}

window.addEventListener('error', e => api.reportError(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => api.reportError(e.reason?.stack || e.reason));

// ---------------------------------------------------------------- state

const state = {
  snap: { mods: [], downloads: [], jobs: [], conflicts: {}, game: {}, rate: {}, pendingFomod: [] },
  jobs: new Map(),
  settings: null,
  modSel: new Set(),
  // mod id → its requirements shown (true) or hidden; else the setting decides (a damaged value: none)
  reqOpen: (v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}))(store.get('mods.reqOpen', {})),
  searchClosed: new Set(), // while searching (requirements of matches shown): the ones closed by hand
  dlSel: new Set(),
  modFilter: 'all',
  lastModClick: null,
  lastDlClick: null,
  drawerMod: null,
  drawerSig: '',
  keyUser: null,
  gameRunning: false,
  modLogProblems: {},
};

// ---------------------------------------------------------------- navigation

const pageHooks = {};
// Called with the page shown after every page change (a page that works only while shown stops on leaving).
const pageChangeHooks = [];

function goTo(page) {
  if (typeof closeColourPicker === 'function') closeColourPicker(); // theme-editor.js: a picker belongs to its page
  $$('.nav-item').forEach(b => {
    const on = b.dataset.page === page;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  // Back on Settings with changes not saved yet: they stay (only a clean form is read again).
  if (page === 'settings') {
    if (!isDirty()) loadSettings();
    if (state.settingsJump) { showSettingsSection(state.settingsJump, false); state.settingsJump = ''; } else spySettings();
  }
  pageHooks[page]?.();
  for (const fn of pageChangeHooks) fn(page);
}

// ---- Settings sections: one scrolling column, and a list of its sections that follows the scroll

/** Scroll Settings to a section (smoothly when asked from its own list). */
function showSettingsSection(sec, smooth = true) {
  const el = $(`#sec-${sec}`);
  if (!el || el.hidden) return;
  const body = $('#set-body');
  body.scrollTo({ top: el.offsetTop - body.offsetTop, behavior: smooth ? 'smooth' : 'auto' });
  markSettingsSection(sec);
}

function markSettingsSection(sec) {
  $$('.set-nav-item').forEach(b => {
    const on = b.dataset.sec === sec;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
}

/** The section at the top of the column (the last one once the column is scrolled to its end). */
function spySettings() {
  const body = $('#set-body');
  const secs = [...$$('.set-sec')].filter(s => !s.hidden);
  if (!secs.length) return;
  const top = body.scrollTop + 24;
  let cur = secs[0];
  for (const s of secs) if (s.offsetTop - body.offsetTop <= top) cur = s;
  if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) cur = secs[secs.length - 1];
  markSettingsSection(cur.dataset.sec);
}
$('#set-body').addEventListener('scroll', () => spySettings(), { passive: true });
$$('.set-nav-item').forEach(btn => btn.addEventListener('click', () => showSettingsSection(btn.dataset.sec)));

// Credits: the picture lives on the project site (no page there shows it). It loads when the section
// is scrolled near, and stays hidden if it can't load (offline).
const CREDIT_IMG = 'https://skyehosting.github.io/edgerunners-mod-manager/assets/credits/tadpole.png';
{
  const thumb = $('#credit-thumb');
  const img = thumb.querySelector('img');
  img.addEventListener('load', () => { thumb.hidden = false; });
  img.addEventListener('error', () => { thumb.hidden = true; });
  thumb.hidden = false; // an empty frame while it loads
  // Fetched once the section comes near (loading="lazy" starts late inside the scrolling column).
  const near = new IntersectionObserver(seen => {
    if (!seen.some(e => e.isIntersecting)) return;
    near.disconnect();
    img.src = CREDIT_IMG;
  }, { root: $('#set-body'), rootMargin: '0px 0px 600px 0px' });
  near.observe(thumb);
  let open = false;
  thumb.addEventListener('click', () => {
    if (open || !img.complete || !img.naturalWidth) return; // not loaded (yet), or already shown
    open = true;
    showCreditImage().finally(() => { open = false; });
  });
  const showCreditImage = () => withModal(() => new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal credit-view';
    m.setAttribute('aria-labelledby', 'credit-view-title');
    const close = () => { hide(); resolve(); };
    m.replaceChildren(
      h('h3', { id: 'credit-view-title', class: 'sr-only' }, 'Credits picture'),
      h('img', { referrerpolicy: 'no-referrer', alt: img.alt, src: img.currentSrc || img.src, onclick: () => close() }),
      h('div', { class: 'modal-foot' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => close() }, 'Close')),
    );
    const hide = showModal({ onDismiss: close });
  }));
}

$$('.nav-item').forEach(btn => btn.addEventListener('click', () => goTo(btn.dataset.page)));
document.addEventListener('click', ev => {
  const go = ev.target.closest('[data-goto]');
  if (!go) return;
  if (go.dataset.sec) state.settingsJump = go.dataset.sec;
  goTo(go.dataset.goto);
});

// ---- Sidebar: full width, or a narrow rail of icons (remembered; Ctrl+B switches)

function setSidebar(collapsed, remember = true) {
  $('#shell').classList.toggle('side-collapsed', collapsed);
  const t = $('#side-toggle');
  const label = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
  t.title = `${label} (Ctrl+B)`;
  t.setAttribute('aria-label', label);
  t.setAttribute('aria-expanded', String(!collapsed));
  if (remember) store.set('side.collapsed', collapsed);
  if (collapsed) closeProfileMenu(); // the rail has no profile field: its Profiles icon is the way there
}
// Narrow windows fold it to the rail by themselves; widening the window brings back the remembered state.
const narrowWindow = matchMedia('(max-width: 1080px)');
const sideWanted = () => narrowWindow.matches || store.get('side.startCollapsed', false) || store.get('side.collapsed', false);
setSidebar(sideWanted(), false);
narrowWindow.addEventListener('change', () => setSidebar(sideWanted(), false));
$('#side-toggle').addEventListener('click', () => setSidebar(!$('#shell').classList.contains('side-collapsed')));
document.addEventListener('keydown', ev => {
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'b' && !ev.target.closest?.('input, textarea, [contenteditable="true"]')) {
    ev.preventDefault();
    setSidebar(!$('#shell').classList.contains('side-collapsed'));
  }
});
// Settings → Interface: kept on this PC (not in the settings file), applied at once.
$('#s-side-collapsed').checked = !!store.get('side.startCollapsed', false);
$('#s-side-collapsed').addEventListener('change', ev => { store.set('side.startCollapsed', ev.target.checked); if (ev.target.checked) setSidebar(true); });
function setActivityLine(show) {
  document.body.classList.toggle('no-activity', !show);
  store.set('activity.show', show);
}
$('#s-activity-line').checked = store.get('activity.show', true) !== false;
setActivityLine($('#s-activity-line').checked);
$('#s-activity-line').addEventListener('change', ev => setActivityLine(ev.target.checked));
$('#s-app-name').replaceChildren(...APP_NAMES.map(n => h('option', { value: n, selected: n === appName() }, n)));
$('#s-app-name').addEventListener('change', ev => { store.set('app.name', ev.target.value); applyAppName(); });

// ---------------------------------------------------------------- dialogs

/*
 * One dialog at a time: requests queue up (a FOMOD wizard arriving while a confirm is open waits).
 * Focus moves into the dialog, Tab stays inside it, and focus returns to where it was on close.
 */
let modalChain = Promise.resolve();
let modalClose = null;   // what Esc / a backdrop click does for the open dialog
let modalBackdrop = true; // whether a backdrop click closes it

function withModal(fn) {
  const next = modalChain.then(fn);
  modalChain = next.catch(() => {});
  return next;
}

/**
 * Show #modal. `onDismiss` is what Esc (and, if `backdrop`, a click outside) does. The rest of the
 * window is made inert, so Tab and clicks cannot reach it. Returns the function that closes it.
 */
function showModal({ focus = '.btn-primary', onDismiss = null, backdrop = true } = {}) {
  const back = $('#modal-back');
  const m = $('#modal');
  const opener = document.activeElement;
  const openerKey = opener?.closest?.('[data-key]')?.dataset.key || opener?.id || '';
  modalClose = onDismiss;
  modalBackdrop = backdrop;
  $('#shell').inert = true;
  $('#drawer').inert = true;
  back.hidden = false;
  (m.querySelector(focus) || m.querySelector('.btn-primary') || m.querySelector('button, input'))?.focus();
  return () => {
    back.hidden = true;
    modalClose = null;
    modalBackdrop = true;
    // The editor, if open, keeps the window behind it out of reach.
    $('#shell').inert = !!$('#ed-back') && !$('#ed-back').hidden;
    $('#drawer').inert = false;
    restoreFocus(opener, openerKey);
  };
}

/** Focus the opener again; if it was rebuilt or hidden, its replacement (by data-key/id), else the page. */
function restoreFocus(opener, key) {
  const usable = el => el && document.contains(el) && el.offsetParent !== null;
  const target = usable(opener) ? opener
    : key ? (document.querySelector(`[data-key="${CSS.escape(key)}"]`) || document.getElementById(key)) : null;
  if (usable(target)) {
    target.focus();
    return;
  }
  const heading = document.querySelector('.page.active h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

/** Rebuild part of the UI without losing keyboard focus: refocus the control with the same data-key. */
function keepFocus(root, rebuild, fallback) {
  const active = document.activeElement;
  const key = root.contains(active) ? active.closest('[data-key]')?.dataset.key : null;
  rebuild();
  if (!key) return;
  const again = root.querySelector(`[data-key="${CSS.escape(key)}"]`) || (fallback && root.querySelector(fallback));
  again?.focus();
}

function trapFocus(ev, root) {
  if (ev.key !== 'Tab') return;
  const items = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), select, textarea, a[href], [tabindex="0"]')].filter(e => e.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

function modal({ title, sub, body, buttons }) {
  return withModal(() => new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal';
    m.setAttribute('aria-labelledby', 'modal-title');
    m.replaceChildren(
      h('div', { class: 'modal-head' }, h('h3', { id: 'modal-title' }, title), sub ? h('div', { class: 'sub' }, sub) : null),
      h('div', { class: 'modal-body' }, body || ''),
      h('div', { class: 'modal-foot' }, ...buttons.map(b => h('button', { class: `btn ${b.kind || ''}`, dataset: { safe: b.safe ? '1' : '' }, onclick: () => close(b.value) }, b.label))),
    );
    // Focus the safe choice for destructive dialogs, the primary one otherwise.
    const close = v => { hide(); resolve(v); };
    const hide = showModal({ focus: buttons.some(b => b.kind === 'btn-danger') ? '[data-safe="1"]' : '.btn-primary', onDismiss: () => close(false) });
  }));
}

function confirmBox(title, text, okLabel = 'Continue', danger = false) {
  return modal({
    title, body: h('p', {}, text),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: okLabel, value: true, kind: danger ? 'btn-danger' : 'btn-primary' }],
  });
}

$('#modal-back').addEventListener('mousedown', ev => {
  if (ev.target === ev.currentTarget && modalBackdrop && modalClose) modalClose();
});
$('#modal').addEventListener('keydown', ev => trapFocus(ev, $('#modal')));

// ---------------------------------------------------------------- multi-select

/** Click / ctrl-click / shift-click selection over an ordered id list. */
function clickSelect(sel, ids, id, ev, lastKey) {
  if (ev.shiftKey && state[lastKey] && ids.includes(state[lastKey])) {
    const a = ids.indexOf(state[lastKey]);
    const b = ids.indexOf(id);
    if (!ev.ctrlKey) sel.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(ids[i]);
  } else if (ev.ctrlKey || ev.metaKey) {
    if (sel.has(id)) sel.delete(id); else sel.add(id);
    state[lastKey] = id;
  } else {
    sel.clear();
    sel.add(id);
    state[lastKey] = id;
  }
}

/** Update selected rows, checkboxes and the selection bar in place (no table rebuild). */
function paintSelection(tbody, sel, allBox, ids, bar, countEl, head) {
  for (const tr of tbody.querySelectorAll('tr.row')) {
    const on = sel.has(tr.dataset.id);
    tr.classList.toggle('selected', on);
    tr.setAttribute('aria-selected', String(on));
    const cb = tr.querySelector('input[type=checkbox]');
    if (cb) cb.checked = on;
  }
  allBox.checked = ids.length > 0 && ids.every(id => sel.has(id));
  allBox.indeterminate = !allBox.checked && ids.some(id => sel.has(id));
  allBox.disabled = ids.length === 0;
  bar.hidden = sel.size === 0;
  countEl.textContent = `${sel.size} selected`;
  head.classList.toggle('selecting', sel.size > 0);
}

/** Rows are focusable: Enter opens, Space toggles selection, arrows move. */
function rowKeys(ev, sel, id, open, repaint) {
  if (ev.target !== ev.currentTarget) return;
  if (ev.key === 'Enter') { ev.preventDefault(); open(); }
  else if (ev.key === ' ') { ev.preventDefault(); if (sel.has(id)) sel.delete(id); else sel.add(id); repaint(); }
  else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    // The next row, past any rows in between (a mod's requirements under it).
    const step = n => (ev.key === 'ArrowDown' ? n.nextElementSibling : n.previousElementSibling);
    let next = step(ev.currentTarget);
    while (next && !next.classList.contains('row')) next = step(next);
    next?.focus();
  }
}

// ---------------------------------------------------------------- mods page

/** This app's mods and Vortex's, in one list. Vortex rows have ids starting with "vx:". */
function allMods() {
  const vx = (state.snap.vortex?.mods || []).map(v => ({ ...v, priority: '', warnings: [], vortex: true }));
  return [...state.snap.mods, ...vx];
}
const isVx = id => String(id).startsWith('vx:');

/*
 * Versions of one mod file share a row, as in Vortex: same tool, same Nexus mod, same file name
 * once version numbers are taken out ("ArchiveXL" 1.28.3 and 1.28.6). The row shows the enabled
 * version; a version menu switches to another one.
 */
const normFileName = s => String(s || '').toLowerCase()
  .replace(/\bv?\d+(?:[._-]\d+)+[a-z]?\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const groupKey = m => (m.modId ? `${m.vortex ? 'vx' : 'own'}|${m.modId}|${normFileName(m.vortex ? m.fileName || m.name : m.name)}` : '');
state.versionPick = store.get('versionPick', {});

function groupedMods() {
  const groups = new Map();
  const rows = [];
  for (const m of allMods()) {
    const k = groupKey(m);
    if (!k) { rows.push(m); continue; }
    if (!groups.has(k)) { groups.set(k, []); rows.push(k); }
    groups.get(k).push(m);
  }
  return rows.map(r => {
    if (typeof r !== 'string') return r;
    const list = groups.get(r);
    if (list.length === 1) return list[0];
    const versions = [...list].sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
    const on = versions.filter(v => v.enabled);
    const shown = on[0] || versions.find(v => v.id === state.versionPick[r]) || versions[0];
    return { ...shown, versions, groupKey: r };
  });
}

/**
 * The update a row offers, as the id of the installed version it updates: the version shown, or
 * else another installed version of the same mod. One per row, so the count, the Updates filter
 * and Update all agree (and two versions of one mod are not updated twice).
 */
function rowUpdateId(row) {
  const ups = state.snap.updates || {};
  if (ups[row.id]) return row.id;
  return (row.versions || []).find(v => ups[v.id])?.id || null;
}

/** The update for a mod by its id, as its row offers it (the row may show another version of it). */
function updateIdFor(id) {
  const row = groupedMods().find(r => r.id === id);
  return row ? rowUpdateId(row) : (state.snap.updates?.[id] ? id : null);
}

/*
 * Nexus mod categories (Appearance, Gameplay…): each mod's comes from Nexus with its requirements;
 * the list in the Category filter is these, every category Nexus has for the game (read once a
 * week), and any a mod here has. Mods with none known (local ones, or not read yet) are Unassigned.
 */
const DEFAULT_MOD_CATS = ['Animations', 'Appearance', 'Audio', 'Cyberpunk 2077', 'Gameplay', 'Miscellaneous',
  'Modders Resources', 'User Interface', 'Utilities', 'Vehicles', 'Visuals and Graphics'];
const NO_CAT = '__none';
const modCatOf = m => {
  const c = m.modId && state.snap.modCats && Object.hasOwn(state.snap.modCats, m.modId) ? state.snap.modCats[m.modId] : '';
  return typeof c === 'string' ? c : '';
};
state.modCat = '';
state.nexusCats = (() => {
  const c = store.get('nexusModCats', null);
  return c && Array.isArray(c.list) ? c.list.filter(n => typeof n === 'string' && n.length <= 80) : [];
})();

/** Every category Nexus has for the game, once a week (public: no key needed); kept if Nexus can't be reached. */
async function loadNexusCats() {
  const c = store.get('nexusModCats', null);
  if (c && Date.now() - (Number(c.at) || 0) < 7 * 86400000) return;
  const res = await api.nexusModCategories().catch(() => null);
  if (!Array.isArray(res?.ok)) return;
  const list = res.ok.filter(x => !x.value && typeof x.name === 'string' && x.name.trim()).map(x => x.name.trim().slice(0, 80));
  if (!list.length) return;
  state.nexusCats = list;
  store.set('nexusModCats', { at: Date.now(), list });
  if (state.snap) renderModCats();
}

/** The Category filter's choices, each with how many rows it would list (the search and the other filter as they are). */
function renderModCats() {
  const rows = groupedMods().filter(m => passesModFilters(m, false));
  const count = new Map();
  for (const m of rows) { const c = modCatOf(m) || NO_CAT; count.set(c, (count.get(c) || 0) + 1); }
  // One entry per name whatever its case (Nexus's list and a mod's may differ): a mod's own spelling first.
  const seen = new Map();
  for (const n of [...[...count.keys()].filter(c => c !== NO_CAT), ...DEFAULT_MOD_CATS, ...state.nexusCats]) if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  const names = [...seen.values()].sort(nameOrder.compare);
  if (state.modCat && state.modCat !== NO_CAT && !names.includes(state.modCat)) names.push(state.modCat);
  const opts = [['', `All ${sectionList().length ? 'Nexus ' : ''}categories (${rows.length})`], [NO_CAT, `Unassigned (${count.get(NO_CAT) || 0})`],
    ...names.map(n => [n, `${n} (${count.get(n) || 0})`])];
  const sel = $('#mods-cat');
  sel.classList.toggle('is-set', !!state.modCat);
  // Rebuilt only when it changed: a list rebuilt while open would close under the pointer.
  const sig = JSON.stringify(opts);
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.replaceChildren(...opts.map(([value, text]) => h('option', { value }, text)));
  sel.value = state.modCat;
}

function visibleMods() {
  return groupedMods().filter(m => passesModFilters(m, true)).sort(SORTS[state.modSort] || byName);
}
/** The mods whose rows are on screen: the visible ones, less those in a collapsed category. Select all takes these. */
function shownMods() {
  const mods = visibleMods();
  if (!state.secCollapsed?.size || !sectionList().length) return mods;
  return mods.filter(m => !state.secCollapsed.has(sectionOf(m)));
}

// The Show filter: which mods each choice lists, in the order the list offers them.
const MOD_FILTERS = [
  ['all', 'All mods', () => true],
  ['enabled', 'Enabled', m => !!m.enabled],
  ['disabled', 'Disabled', m => !m.enabled],
  ['updates', 'With updates', m => !!rowUpdateId(m)],
  ['problems', 'With problems', m => hasProblem(m)],
  ['conflicts', 'With file conflicts', m => !!state.snap.conflicts[m.id]],
  ['repair', 'Needing repair', m => !!m.health],
  ['vortex', 'In Vortex', m => !!m.vortex],
];
const modFilterTest = f => (MOD_FILTERS.find(x => x[0] === f) || MOD_FILTERS[0])[2];

/** Whether a row is listed: the search, the Category filter (when byCat) and the Show filter (when byShow). */
function passesModFilters(m, byCat, byShow = true) {
  const q = $('#mods-search').value.trim().toLowerCase();
  // By name only (its own and its Nexus mod's): a search for "red4ext" is not every RED4ext plugin.
  if (q && ![m.name, m.modName].filter(Boolean).join(' ').toLowerCase().includes(q)) return false;
  if (byCat && state.modCat && (modCatOf(m) || NO_CAT) !== state.modCat) return false;
  return !byShow || modFilterTest(state.modFilter)(m);
}

/** The Show filter's choices, each with how many it would list (with the search and category as they are). */
function renderModFilter() {
  const rows = groupedMods().filter(m => passesModFilters(m, true, false));
  // Repair and Vortex only when they have something (or are the choice now); the rest always.
  const opts = MOD_FILTERS.map(([value, label, test]) => [value, label, rows.filter(test).length])
    .filter(([value, , n]) => n || !['repair', 'vortex'].includes(value) || value === state.modFilter)
    .map(([value, label, n]) => [value, `${label} (${n})`]);
  const sel = $('#mods-filter');
  sel.classList.toggle('is-set', state.modFilter !== 'all');
  const sig = JSON.stringify(opts);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren(...opts.map(([value, text]) => h('option', { value }, text)));
  }
  sel.value = state.modFilter;
}

// The Mods list order (kept between sessions). The "recent" ones put the latest first and
// show when it happened under each name.
const SORTS = {
  az: (a, b) => byName(a, b),
  za: (a, b) => byName(b, a),
  installed: (a, b) => (b.installedAt || 0) - (a.installedAt || 0) || byName(a, b),
  enabled: (a, b) => (b.enabledAt || 0) - (a.enabledAt || 0) || byName(a, b),
  disabled: (a, b) => (b.disabledAt || 0) - (a.disabledAt || 0) || byName(a, b),
  priority: (a, b) => (Number(b.priority) || -1) - (Number(a.priority) || -1) || byName(a, b),
  // By Nexus category, Unassigned last, then A to Z within each.
  category: (a, b) => (!modCatOf(a) - !modCatOf(b)) || nameOrder.compare(modCatOf(a), modCatOf(b)) || byName(a, b),
};
const SORT_TIME = { installed: ['installedAt', 'installed'], enabled: ['enabledAt', 'enabled'], disabled: ['disabledAt', 'disabled'] };
state.modSort = store.get('modSort', 'az');
// What the Mods page's ⋯ button flags (paintMoreDot): updates waiting, REDmods to deploy.
const moreAttention = { updates: 0, redmod: false };
const ago = t => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
};

// A to Z, ignoring case and accents, with numbers in number order (Mod 2 before Mod 10).
const nameOrder = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const byName = (a, b) => nameOrder.compare(a.name, b.name) || nameOrder.compare(a.version || '', b.version || '');

function versionMenu(m) {
  const label = v => `${v.enabled ? '✓ ' : ''}${v.version ? `v${v.version}` : v.name}`;
  return h('select', {
    class: 'ver-select', 'aria-label': `Version of ${m.name}`, dataset: { key: `${m.groupKey}:ver` },
    onclick: ev => ev.stopPropagation(),
    onchange: ev => pickVersion(m, ev.target.value),
  }, m.versions.map(v => h('option', { value: v.id, selected: v.id === m.id }, label(v))));
}

/** Right-click on a mod: its common actions at the pointer. Esc, a click outside or a scroll closes it. */
function modContextMenu(m, x, y) {
  closeContextMenu();
  const item = (ico, label, fn, extra = {}) => h('button', {
    class: `menu-item${extra.danger ? ' danger' : ''}`, role: 'menuitem',
    onclick: () => { closeContextMenu(true); fn(); },
  }, icon(ico), h('span', { class: 'menu-label' }, label), extra.kbd ? h('span', { class: 'kbd' }, extra.kbd) : null);
  const sep = () => h('div', { class: 'menu-sep', role: 'separator' });
  const menu = h('div', { class: 'menu ctx-menu', id: 'ctx-menu', role: 'menu', 'aria-label': m.name },
    h('div', { class: 'menu-head', title: m.name }, m.name),
    m.enabled ? item('ban', m.vortex ? 'Disable in Vortex' : 'Disable', () => modAction('disable', [m.id]))
      : item('check', m.vortex ? 'Enable in Vortex' : 'Enable', () => modAction('enable', [m.id])),
    item('info', 'Properties', () => openDrawer(m.id), { kbd: 'Enter' }),
    state.modLogProblems[m.id] ? item('activity', 'Show its game log errors', () => openDrawer(m.id, 'logs')) : null,
    item('sparkle', 'Ask AI', () => askAi(`Look at the mod "${m.name}": is anything wrong with it (logs, conflicts, missing files, load order)? What should I do?`)),
    ...(sectionList().length > 1 ? [sep(), ...sectionList().filter(s => s.id !== sectionOf(m)).slice(0, 12).map(s => item('layers', `Move to ${s.name}`, () => moveToSection([m.id], s.id)))] : []),
    sep(),
    m.modId ? item('external', 'Open on Nexus', () => api.openNexus(m.game, m.modId)) : null,
    item('file-code', 'Show files', () => openConfigFor(m.vortex ? `vx:${m.vortexId}` : `app:${m.id}`)),
    m.vortex ? null : sep(),
    m.vortex ? item('download', 'Move to this app', () => moveFromVortex([m.id])) : item('minus-circle', 'Uninstall', () => modAction('uninstall', [m.id]), { danger: true }));
  document.body.append(menu);
  // At the pointer, kept inside the window.
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  const opener = document.activeElement;
  menu.querySelector('.menu-item')?.focus();
  menu.addEventListener('keydown', ev => {
    const list = [...menu.querySelectorAll('.menu-item')];
    const i = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeContextMenu(); opener?.focus?.(); }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    if (ev.key === 'Tab') closeContextMenu();
  });
}
function closeContextMenu() { $('#ctx-menu')?.remove(); }
document.addEventListener('mousedown', ev => { if (!ev.target.closest('#ctx-menu')) closeContextMenu(); });
window.addEventListener('blur', () => closeContextMenu());
document.addEventListener('scroll', () => closeContextMenu(), true);

function paintModSelection() {
  // A row that is not on screen is never acted on by a bulk action: mods in a collapsed category leave the selection.
  if (state.secCollapsed?.size && state.modSel.size && sectionList().length) {
    for (const m of allMods()) if (state.modSel.has(m.id) && state.secCollapsed.has(sectionOf(m))) state.modSel.delete(m.id);
  }
  paintSelection($('#mods-table tbody'), state.modSel, $('#mods-all'), shownMods().map(m => m.id), $('#mods-bulk'), $('#mods-sel-count'), $('#mods-toolbar'));
  const picked = [...state.modSel].map(id => allMods().find(m => m.id === id)).filter(Boolean);
  const onlyVx = picked.length > 0 && picked.every(m => m.vortex);
  for (const act of ['reinstall', 'uninstall', 'delete']) $(`#mods-bulk [data-act="${act}"]`).hidden = onlyVx;
  $('#mods-bulk-update').hidden = !picked.some(m => updateIdFor(m.id));
  $('#mods-bulk-repair').hidden = !picked.some(m => m.health);
  const anyOff = picked.some(m => !m.enabled);
  const anyOn = picked.some(m => m.enabled);
  $('#mods-bulk-enable').hidden = picked.length > 0 && !anyOff;
  $('#mods-bulk-disable').hidden = picked.length > 0 && !anyOn;
  $('#mods-bulk-win').hidden = !picked.some(m => state.snap.conflicts[m.id]);
  // The first action that applies is the primary one.
  $('#mods-bulk-enable').classList.toggle('btn-primary', anyOff);
}

/** Mods that need attention: missing files, install warnings or game-log errors. */
// ---------------------------------------------------------------- requirements under each mod

/** A mod's requirements, resolved by the app: [{ id, modId, name, state, version, url, notes, inferred }]. */
const reqsOf = id => state.snap.reqs?.[id] || [];
/** An enabled mod with a requirement that is off or not installed. */
// What the user chose to ignore for a mod (install warnings, its game-log errors, requirements it lists
// that they don't need): kept by its Nexus mod, so an update keeps it. Missing files are never ignored.
const ignKey = m => (Number(m.modId) > 0 ? `n:${Number(m.modId)}` : String(m.id));
const ignOf = m => state.snap?.ignored?.[ignKey(m)] || {};
const reqKey = q => (Number(q.modId) > 0 ? `m:${Number(q.modId)}` : `n:${q.name}`);
const reqIgnored = (m, q) => (ignOf(m).req || []).includes(reqKey(q));
const liveWarnings = m => (m.warnings || []).filter(w => !(ignOf(m).w || []).includes(w));
const logCount = m => (ignOf(m).log ? 0 : state.modLogProblems[m.id] || 0);
const ignoreProblem = (m, kind, value, on) => run(api.ignoreProblem(m.id, kind, value, on));
const REQ_BAD = new Set(['off', 'missing', 'official']);
const reqProblem = m => !!m.enabled && reqsOf(m.id).some(q => REQ_BAD.has(q.state) && !reqIgnored(m, q));
/** Which enabled mods need each mod: id → [their names]. */
function neededByMap(all = allMods()) {
  const out = new Map();
  for (const m of all) {
    if (!m.enabled) continue;
    for (const q of reqsOf(m.id)) if (q.id) { if (!out.has(q.id)) out.set(q.id, []); out.get(q.id).push(m.name); }
  }
  return out;
}

/*
 * A mod's requirements show under it, opened or closed by the arrow left of its checkbox. Each mod
 * keeps its own choice (kept between sessions); Settings → "Requirements under each mod" decides for
 * the rest. While searching, the mods found show theirs (that is what a search is for), unless closed.
 */
const searching = () => !!$('#mods-search').value.trim();
const reqDefaultOpen = () => state.settings?.reqView !== 'collapsed';
function reqIsOpen(id) {
  if (searching()) return !state.searchClosed.has(id);
  return Object.hasOwn(state.reqOpen, id) ? !!state.reqOpen[id] : reqDefaultOpen();
}
/** Open or close these mods' requirements (and remember it). */
function setReqOpen(ids, open) {
  if (searching()) { for (const id of ids) { if (open) state.searchClosed.delete(id); else state.searchClosed.add(id); } } else {
    for (const id of ids) { delete state.reqOpen[id]; state.reqOpen[id] = !!open; } // (newest last)
    // Kept small: the oldest choices go past 2000 (not pruned by what is listed now, which can be
    // missing mods for a moment, such as Vortex's while it is unreadable).
    const keys = Object.keys(state.reqOpen);
    for (const id of keys.slice(0, Math.max(0, keys.length - 2000))) delete state.reqOpen[id];
    store.set('mods.reqOpen', state.reqOpen);
  }
  renderMods();
}

/** The inset copies of a mod's requirements, under its row (when it is open). */
function reqRows(m, neededBy) {
  const list = reqsOf(m.id);
  if (!list.length || !reqIsOpen(m.id)) return [];
  const rows = [];
  list.forEach((q, i) => {
    const others = q.id ? (neededBy.get(q.id) || []).filter(n => n !== m.name).length : 0;
    const own = q.id ? reqsOf(q.id).map(r => r.name) : [];
    const notes = [others ? `also needed by ${others}` : '', own.length ? `needs ${own.join(', ')}` : '', q.inferred ? 'found from its files' : '', q.byName ? 'matched on Nexus by its name' : ''].filter(Boolean).join(' · ');
    const nexusPage = q.modId ? `https://www.nexusmods.com/cyberpunk2077/mods/${q.modId}` : '';
    const sw = q.id ? h('button', {
      class: `switch sm${q.state === 'on' ? ' on' : ''}`, role: 'switch', 'aria-checked': String(q.state === 'on'),
      'aria-label': `${q.name}, needed by ${m.name}`, title: q.state === 'on' ? 'On: click to switch it off (asks first if mods need it)' : 'Off: click to switch it on',
      dataset: { key: `${m.id}:req:${q.id}` },
      onclick: async ev => {
        ev.stopPropagation();
        if (ev.currentTarget.getAttribute('aria-disabled') === 'true') return;
        const btn = ev.currentTarget;
        btn.setAttribute('aria-disabled', 'true');
        const ok = await setModsEnabled([q.id], q.state !== 'on');
        if (ok === null && document.contains(btn)) btn.removeAttribute('aria-disabled');
      },
    }) : h('span', { class: 'req-noswitch', 'aria-hidden': 'true' });
    const tags = {
      on: [],
      off: [h('span', { class: 'tag tag-warn' }, 'Off')],
      missing: [h('span', { class: 'tag tag-err' }, 'Missing'),
        h('button', { class: 'btn btn-sm', dataset: { key: `${m.id}:req:${q.modId}:dl` }, onclick: ev => { ev.stopPropagation(); downloadLinks(nexusPage); } }, icon('download'), h('span', {}, 'Download'))],
      outside: [h('span', { class: 'tag tag-off', title: 'Installed by hand or by another tool: this app cannot switch it' }, 'In the game folder, not managed here')],
      builtin: [h('span', { class: 'tag tag-ok', title: "CD PROJEKT RED's own modding support: its tools are in the game folder" }, 'Part of the game')],
      official: [h('span', { class: 'tag tag-warn', title: "CD PROJEKT RED's free REDmod DLC: install it from Steam, GOG or Epic" }, 'Not installed'),
        q.url ? h('button', { class: 'btn btn-sm btn-ghost', onclick: ev => { ev.stopPropagation(); api.openLink(q.url); } }, h('span', {}, 'Open page')) : null],
      external: [h('span', { class: 'tag tag-off' }, 'Not on Nexus'),
        q.url ? h('button', { class: 'btn btn-sm btn-ghost', onclick: ev => { ev.stopPropagation(); api.openLink(q.url); } }, h('span', {}, 'Open page')) : null],
    }[q.state] || [];
    if (REQ_BAD.has(q.state) && reqIgnored(m, q)) tags.splice(0, tags.length, h('span', { class: 'tag tag-off', title: 'You marked it as not needed' }, 'Not needed'));
    rows.push(h('tr', { class: `req-row req-${q.state}${i === list.length - 1 ? ' last' : ''}` },
      h('td'),
      // Under the mod's switch: the tree starts there, one step in from the mod.
      h('td', { colspan: '2' }, h('div', { class: 'req-cell' },
        h('span', { class: 'req-line', 'aria-hidden': 'true' }), sw,
        h('button', {
          class: 'req-name', title: [q.id ? `${q.name}: open its details` : `${q.name}: open its Nexus page`, notes, q.notes].filter(Boolean).join('\n'),
          onclick: ev => { ev.stopPropagation(); if (q.id) openDrawer(q.id); else if (nexusPage) api.openLink(nexusPage); },
        }, q.name),
        notes ? h('span', { class: 'req-note' }, notes) : null)),
      h('td', { class: 'status-cell' }, h('div', { class: 'chips-row' }, ...tags)),
      h('td', { class: 'num ver-cell' }, h('span', { class: 'ver-text req-ver' }, q.version || ''))));
  });
  return rows;
}

const hasProblem = m => !!(m.health || liveWarnings(m).length || logCount(m) || reqProblem(m));

/**
 * What a mod's Status says, most pressing first: [{ sev: 'err' | 'warn' | 'info' | 'ok', text,
 * section, detail }]. The list shows the first as one tag (and how many more); the details panel
 * lists them all, each leading to its own section there.
 */
function modStatusItems(m, neededBy, byId = {}) {
  const items = [];
  const names = ids => ids.map(id => byId[id]?.name || String(id).replace(/^vx:/, '')).join(', ');
  const reqs = reqsOf(m.id);
  if (m.enabled) {
    const missing = reqs.filter(q => (q.state === 'missing' || q.state === 'official') && !reqIgnored(m, q)).length;
    const off = reqs.filter(q => q.state === 'off' && !reqIgnored(m, q)).length;
    if (missing) items.push({ sev: 'err', text: missing === 1 ? 'Requirement missing' : `${missing} requirements missing`, section: 'reqs' });
    if (off) items.push({ sev: 'warn', text: off === 1 ? 'Requirement off' : `${off} requirements off`, section: 'reqs' });
  }
  if (m.health) items.push({ sev: m.health.missing ? 'err' : 'warn', text: m.health.missing ? `${plural(m.health.missing, 'file')} missing` : `${plural(m.health.replaced, 'file')} replaced`, section: 'health' });
  const logIssues = logCount(m);
  if (logIssues) items.push({ sev: 'err', text: plural(logIssues, 'log error'), section: 'logs' });
  const warns = liveWarnings(m).length;
  if (warns) items.push({ sev: 'warn', text: plural(warns, 'install warning'), section: 'warnings' });
  const c = state.snap.conflicts[m.id];
  if (c?.loses) items.push({ sev: 'warn', text: `Loses ${plural(c.loses, 'file')}`, section: 'conflicts', detail: `to ${names(c.with)}` });
  const vxHits = state.snap.vortex?.overlaps?.[m.id] || [];
  if (vxHits.length) items.push({ sev: 'warn', text: `Shares files with ${plural(vxHits.length, 'Vortex mod')}`, section: '', detail: `${names(vxHits)}: whichever app deploys last wins them` });
  const upd = state.snap.updates?.[rowUpdateId(m) || m.id];
  if (upd) items.push({ sev: 'info', text: upd.version ? `${upd.version} available` : 'Update available', section: 'update' });
  const needers = neededBy.get(m.id) || [];
  if (needers.length) items.push({ sev: 'info', text: `Needed by ${needers.length}`, section: 'needed', detail: needers.join(', ') });
  if (c?.wins) items.push({ sev: 'ok', text: `Wins ${plural(c.wins, 'file')}`, section: 'conflicts', detail: `over ${names(c.with)}` });
  const twin = state.snap.vortex?.twins?.[m.id];
  if (twin) items.push({ sev: 'info', text: 'Also in Vortex', section: '', detail: `while it is enabled here, Vortex's copy is switched off${twin.enabled && m.enabled ? ' (as soon as Vortex is closed)' : ''}` });
  return items;
}
const SEV_ICON = { err: 'alert', warn: 'alert', info: 'info', ok: 'check' };

/** A mod's Status in the list: its most pressing item as one tag that opens the details panel at Status. */
function statusTag(m, items) {
  if (!items.length) return null;
  const [top] = items;
  const all = items.map(i => i.text).join(', ');
  return h('button', {
    class: `tag tag-${top.sev} status-tag`, dataset: { key: `${m.id}:status` },
    title: `${items.map(i => i.text).join(' · ')}\nClick for the details`, 'aria-label': `${m.name}: ${all}. Show the details`,
    onclick: ev => { ev.stopPropagation(); openDrawer(m.id, 'status'); },
  }, icon(SEV_ICON[top.sev]), h('span', { class: 'status-text' }, top.text), items.length > 1 ? h('span', { class: 'status-more' }, `+${items.length - 1}`) : null);
}

/** The details panel's Status: every item, each with a way to its own section below (when there is one). */
function statusSection(items) {
  if (!items.length) return [];
  return [
    h('h2', { dataset: { section: 'status' } }, 'Status'),
    h('div', { class: 'drawer-list' }, items.map(i => h('div', { class: 'drawer-li' },
      h('span', { class: `sev-dot sev-${i.sev}`, 'aria-hidden': 'true' }),
      h('span', { class: 'drawer-li-text' }, i.text, i.detail ? h('span', { class: 'muted' }, ` · ${i.detail}`) : null),
      i.section ? h('button', {
        class: 'btn btn-sm btn-sq', dataset: { gotoSection: i.section },
        onclick: ev => showDrawerSection(ev.currentTarget.dataset.gotoSection, true),
      }, h('span', {}, 'Show')) : null))),
  ];
}

/** Status items lead to their section only where the panel has one (a Show button with nowhere to go is removed). */
function dropDeadLinks(body) {
  for (const b of body.querySelectorAll('[data-goto-section]')) if (!body.querySelector(`[data-section="${b.dataset.gotoSection}"]`)) b.remove();
}

/**
 * Install warnings in the details panel: each with Ignore (it stops counting as a problem); ignored ones
 * folded under "N ignored", each with Stop ignoring. Notes (things worth knowing, not problems) after.
 */
function warningsSection(m) {
  const ign = new Set(ignOf(m).w || []);
  const live = (m.warnings || []).filter(w => !ign.has(w));
  const off = (m.warnings || []).filter(w => ign.has(w));
  const out = [];
  if (live.length || off.length) out.push(h('h2', { dataset: { section: 'warnings' } }, 'Install warnings'));
  if (live.length) {
    out.push(h('ul', { class: 'warnlist' }, live.map((w, i) => h('li', { class: 'warn-li' }, h('span', {}, w),
      h('button', { class: 'btn btn-sm btn-ghost warn-ignore', dataset: { key: `w:${m.id}:${i}` }, title: 'Stop counting this as a problem (you can undo it)', onclick: () => ignoreProblem(m, 'w', w, true) }, 'Ignore')))));
  }
  if (off.length) {
    const box = h('details', { class: 'ignored-box' }, h('summary', {}, `${plural(off.length, 'ignored warning')}`),
      h('ul', { class: 'warnlist muted-list' }, off.map(w => h('li', { class: 'warn-li' }, h('span', {}, w),
        h('button', { class: 'btn btn-sm btn-ghost warn-ignore', onclick: () => ignoreProblem(m, 'w', w, false) }, 'Stop ignoring')))));
    out.push(box);
  }
  if (m.notes?.length) out.push(h('h2', {}, 'Notes'), h('ul', { class: 'notelist' }, m.notes.map(n => h('li', {}, n))));
  return out;
}

/** The details panel's Requires tab: each mod this one needs, whether it is there and on, and the fix. */
function reqSection(m) {
  const list = reqsOf(m.id);
  if (!list.length) return [h('p', { class: 'empty-inline', dataset: { section: 'reqs' } }, m.modId ? 'This mod needs no other mod.' : 'Not from Nexus: its requirements are not known.')];
  const STATE = { on: ['tag-ok', 'On'], off: ['tag-warn', 'Off'], missing: ['tag-err', 'Missing'], outside: ['tag-off', 'Not managed here'], builtin: ['tag-ok', 'Part of the game'], official: ['tag-warn', 'Not installed'], external: ['tag-off', 'Not on Nexus'] };
  return [
    h('div', { class: 'drawer-list', dataset: { section: 'reqs' } }, list.map(q => {
      const ignored = REQ_BAD.has(q.state) && reqIgnored(m, q);
      const [cls, label] = ignored ? ['tag-off', 'Not needed (ignored)'] : STATE[q.state] || ['tag-off', String(q.state || '')];
      const page = Number(q.modId) > 0 ? `https://www.nexusmods.com/cyberpunk2077/mods/${Number(q.modId)}` : '';
      // A requirement the user doesn't need (an optional one a mod lists): no longer a problem.
      const skip = REQ_BAD.has(q.state) ? h('button', { class: 'btn btn-sm btn-ghost', dataset: { key: `dreq:${reqKey(q)}:ign` }, title: ignored ? 'Count it as a problem again' : 'You don\'t need it: stop counting it as a problem', onclick: () => ignoreProblem(m, 'req', reqKey(q), !ignored) }, ignored ? 'Undo' : 'Not needed') : null;
      const action = q.state === 'off' && q.id
        ? h('button', { class: 'btn btn-sm', dataset: { key: `dreq:${q.id}:on` }, onclick: () => setModsEnabled([q.id], true) }, icon('check'), h('span', {}, 'Enable'))
        : q.state === 'missing' && page
          ? h('button', { class: 'btn btn-sm', dataset: { key: `dreq:${q.modId}:dl` }, onclick: () => downloadLinks(page) }, icon('download'), h('span', {}, 'Download'))
          : ['official', 'external'].includes(q.state) && q.url ? h('button', { class: 'btn btn-sm', onclick: () => api.openLink(q.url) }, h('span', {}, 'Open page')) : null;
      return h('div', { class: 'drawer-li' },
        h('span', { class: 'drawer-li-text' }, q.id || page
          ? h('button', { class: 'link-btn quiet', title: q.id ? `${q.name}: open its details` : `${q.name}: open its Nexus page`, onclick: () => { if (q.id) openDrawer(q.id); else api.openLink(page); } }, q.name)
          : q.name),
        h('span', { class: `tag ${cls}` }, label), ignored ? null : action, skip);
    })),
  ];
}

/** The details panel's Needed by tab: the mods that need this one (each opens its own details). */
function neededSection(m, neededBy) {
  const needers = neededBy.get(m.id) || [];
  if (!needers.length) return [h('p', { class: 'empty-inline', dataset: { section: 'needed' } }, 'No other mod needs this one.')];
  const byName = new Map(allMods().map(x => [x.name, x]));
  return [h('div', { class: 'drawer-list', dataset: { section: 'needed' } }, needers.map(name => {
    const o = byName.get(name);
    return h('div', { class: 'drawer-li' },
      h('span', { class: 'drawer-li-text' }, o ? h('button', { class: 'link-btn quiet', title: `${name}: open its details`, onclick: () => openDrawer(o.id) }, name) : name),
      o ? h('span', { class: `tag ${o.enabled ? 'tag-ok' : 'tag-off'}` }, o.enabled ? 'On' : 'Off') : null);
  }))];
}

// ---------------------------------------------------------------- my categories (sections on the Mods page)
// Only how the list looks: each of the user's categories is a section, in their order, every mod sorted
// within its own by the sort chosen above. None: the plain list as always. The first one made also
// makes "Default", where every mod not put elsewhere is.

const sectionList = () => state.snap?.sections?.list || [];
const secKey = m => (Number(m.modId) > 0 ? `n:${Number(m.modId)}` : String(m.id));
const defaultSection = () => sectionList().find(s => s.def) || sectionList()[0];
/** The id of the category a mod is shown in (Default when it was not put elsewhere). */
function sectionOf(m) {
  const id = state.snap?.sections?.of?.[secKey(m)];
  return id && sectionList().some(s => s.id === id) ? id : defaultSection()?.id || '';
}
state.secCollapsed = new Set(store.get('mods.secCollapsed', []));

/** The visible mods in sections: [{ s, mods, total, collapsed }], or null with no categories. */
function groupBySection(mods, all) {
  const list = sectionList();
  if (!list.length) return null;
  const filtering = searching() || state.modFilter !== 'all' || !!state.modCat;
  return list.map(s => {
    const inIt = mods.filter(m => sectionOf(m) === s.id);
    return { s, mods: inIt, total: all.filter(m => sectionOf(m) === s.id).length, collapsed: state.secCollapsed.has(s.id) };
  }).filter(g => g.mods.length || !filtering); // while filtering, sections with nothing to show stay out
}

function sectionHeader(s, shown, total) {
  const list = sectionList();
  const i = list.findIndex(x => x.id === s.id);
  const collapsed = state.secCollapsed.has(s.id);
  const name = h('span', { class: 'sec-name', title: 'Double-click to rename', dataset: { sec: s.id }, ondblclick: () => startSectionRename(s.id) }, s.name);
  const toggle = () => {
    if (collapsed) state.secCollapsed.delete(s.id);
    else {
      state.secCollapsed.add(s.id);
      // A hidden row is never acted on by a bulk action: its mods leave the selection.
      for (const m of allMods()) if (sectionOf(m) === s.id) state.modSel.delete(m.id);
    }
    store.set('mods.secCollapsed', [...state.secCollapsed]);
    renderMods();
  };
  const onlyDefaultBlocked = s.def && list.length > 1;
  return h('tr', { class: `sec-row${collapsed ? ' collapsed' : ''}`, dataset: { key: `sec:${s.id}` } },
    h('td', { colspan: '5' }, h('div', { class: 'sec-head' },
      h('button', { type: 'button', class: 'sec-chev', 'aria-expanded': String(!collapsed), 'aria-label': `${collapsed ? 'Show' : 'Hide'} the mods in ${s.name}`, dataset: { key: `sec:${s.id}:chev` }, onclick: toggle }, icon('chevron-right')),
      name,
      h('button', { type: 'button', class: 'sec-btn', title: 'Rename', 'aria-label': `Rename ${s.name}`, dataset: { key: `sec:${s.id}:edit` }, onclick: () => startSectionRename(s.id) }, icon('edit')),
      h('span', { class: 'sec-count' }, shown === total ? String(total) : `${shown} of ${total}`),
      h('span', { class: 'sec-acts' },
        h('button', { type: 'button', class: 'sec-btn', title: 'Move up', 'aria-label': `Move ${s.name} up`, disabled: i <= 0, dataset: { key: `sec:${s.id}:up` }, onclick: () => run(api.sectionMove(s.id, -1)) }, icon('arrow-up')),
        h('button', { type: 'button', class: 'sec-btn', title: 'Move down', 'aria-label': `Move ${s.name} down`, disabled: i >= list.length - 1, dataset: { key: `sec:${s.id}:down` }, onclick: () => run(api.sectionMove(s.id, 1)) }, icon('arrow-down')),
        h('button', {
          type: 'button', class: 'sec-btn danger', dataset: { key: `sec:${s.id}:del` }, disabled: onlyDefaultBlocked,
          title: onlyDefaultBlocked ? 'Default holds every mod not in another category: delete the others first' : 'Delete this category (its mods go to Default)',
          'aria-label': `Delete ${s.name}`, onclick: () => deleteSection(s, total),
        }, icon('trash'))))));
}

function sectionEmptyRow(s) {
  return h('tr', { class: 'sec-empty' }, h('td', { colspan: '5' }, s.def ? 'Every mod is in another category.' : 'No mods here yet. Select some and use Move to…, or right-click a mod.'));
}

/** Rename in place: the name becomes a field with everything selected; Enter or leaving it saves, Esc cancels. */
function startSectionRename(id) {
  const el = $(`#mods-table .sec-name[data-sec="${CSS.escape(id)}"]`);
  const s = sectionList().find(x => x.id === id);
  if (!el || !s) return;
  const input = h('input', { type: 'text', class: 'sec-input', value: s.name, maxlength: '40', 'aria-label': 'Category name' });
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== s.name) await run(api.sectionRename(id, v));
    renderMods(); // the field always goes back to the name, saved or not (a refused name too)
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  el.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteSection(s, count) {
  const last = sectionList().length === 1;
  const text = last ? 'This is the last category: the list goes back to one plain list. No mod changes.'
    : `${count ? `Its ${plural(count, 'mod')} go to Default. ` : ''}Only how the list looks changes.`;
  if (await confirmBox(`Delete the category ${s.name}?`, text, 'Delete', true)) await run(api.sectionDelete(s.id));
}

async function newSection() {
  const id = await run(api.sectionCreate(''));
  if (id) { state.renameSection = id; renderMods(); } // its name is ready to type over
}

async function moveToSection(ids, sectionId) {
  const n = await run(api.sectionAssign(ids, sectionId));
  const s = sectionList().find(x => x.id === sectionId);
  if (n) toast(`Moved ${plural(n, 'mod')} to ${s?.name || 'the category'}`, 'success');
}

/** The details panel: which category the mod is in, to change. */
function sectionPicker(m) {
  const sel = h('select', { class: 'sec-pick', 'aria-label': 'Category' },
    ...sectionList().map(s => h('option', { value: s.id }, s.name)));
  sel.value = sectionOf(m);
  sel.addEventListener('change', () => moveToSection([m.id], sel.value));
  return sel;
}

/** The selection bar's Move to…: a small menu of the categories (and a new one). */
function sectionMenu(anchor, ids) {
  closeContextMenu();
  const item = (label, fn) => h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { closeContextMenu(true); fn(); } }, icon('layers'), h('span', { class: 'menu-label' }, label));
  const menu = h('div', { class: 'menu ctx-menu', id: 'ctx-menu', role: 'menu', 'aria-label': 'Move to category' },
    h('div', { class: 'menu-head' }, `Move ${plural(ids.length, 'mod')} to`),
    ...sectionList().map(s => item(s.name, () => moveToSection(ids, s.id))),
    h('div', { class: 'menu-sep', role: 'separator' }),
    item('New category…', async () => { const id = await run(api.sectionCreate('')); if (id) { await moveToSection(ids, id); state.renameSection = id; renderMods(); } }));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('.menu-item')?.focus();
  menu.addEventListener('keydown', ev => {
    const list = [...menu.querySelectorAll('.menu-item')];
    const i = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeContextMenu(); anchor.focus(); }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
  });
}

function renderMods() {
  const all = allMods();
  renderModCats();
  renderModFilter();
  let mods = visibleMods();
  const grouped = groupBySection(mods, all);
  if (grouped) mods = grouped.flatMap(g => (g.collapsed ? [] : g.mods)); // keyboard and Shift-click follow what is shown
  const ids = mods.map(m => m.id);
  for (const id of [...state.modSel]) if (!all.some(m => m.id === id)) state.modSel.delete(id);
  const byId = Object.fromEntries(all.map(m => [m.id, m]));
  const tbody = $('#mods-table tbody');
  const neededBy = neededByMap(all);

  const rowsFor = m => {
    // While the change is applied the switch stays focusable (aria-disabled), so focus isn't lost.
    const switchBtn = h('button', {
      class: `switch${m.enabled ? ' on' : ''}`, role: 'switch', 'aria-checked': m.enabled ? 'true' : 'false',
      'aria-label': m.name, title: m.vortex ? `Managed by Vortex — click to ${m.enabled ? 'disable' : 'enable'} (applied without opening Vortex)` : m.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable',
      dataset: { key: `${m.id}:switch` },
      onclick: async ev => {
        ev.stopPropagation();
        if (switchBtn.getAttribute('aria-disabled') === 'true') return;
        switchBtn.setAttribute('aria-disabled', 'true');
        // A grouped row turns off whichever versions are on.
        const ids = m.enabled && m.versions ? m.versions.filter(v => v.enabled).map(v => v.id) : [m.id];
        const ok = await setModsEnabled(ids, !m.enabled);
        if (ok === null) switchBtn.removeAttribute('aria-disabled');
      },
    });
    const when = SORT_TIME[state.modSort];
    const stamp = when && m[when[0]] ? `${when[1]} ${ago(m[when[0]])}` : when ? `not ${when[1]} since this was recorded` : '';
    const who = m.dependencyOf ? `Required by ${m.dependencyOf}` : [m.modName !== m.name ? m.modName : '', m.author].filter(Boolean).join(' · ');
    const kind = [m.vortex ? 'Vortex' : '', modCatOf(m), m.type, !m.vortex && !m.dependencyOf && m.category && m.category !== 'MAIN' ? CAT_LABEL[m.category] || m.category : ''].filter(Boolean).join(' · ');
    const sub = [who, kind, stamp].filter(Boolean).join(' · ');
    const reqCount = reqsOf(m.id).length;
    const reqOpenNow = reqCount > 0 && reqIsOpen(m.id);
    return [h('tr', {
      class: `row${reqsOf(m.id).length ? ' has-reqs' : ''}`, tabindex: '0', dataset: { id: m.id, key: `${m.id}:row` }, 'aria-selected': 'false',
      onclick: ev => {
        if (ev.target.closest('input,button,select')) return;
        // Ctrl or Shift picks several for the selection bar; a plain click shows the mod in the panel.
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { clickSelect(state.modSel, ids, m.id, ev, 'lastModClick'); paintModSelection(); return; }
        state.lastModClick = m.id;
        openDrawer(m.id, '', false);
      },
      oncontextmenu: ev => { if (!ev.target.closest('input,select')) { ev.preventDefault(); modContextMenu(m, ev.clientX, ev.clientY); } },
      onkeydown: ev => {
        // Right / Left: show or hide its requirements (as in a tree).
        if (reqCount && !ev.altKey && !ev.ctrlKey && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && ev.target === ev.currentTarget) {
          ev.preventDefault();
          if ((ev.key === 'ArrowRight') !== reqOpenNow) setReqOpen([m.id], ev.key === 'ArrowRight');
          return;
        }
        rowKeys(ev, state.modSel, m.id, () => openDrawer(m.id), paintModSelection);
      },
    },
    h('td', {}, h('div', { class: 'check-cell' },
      // Its requirements, shown or hidden; mods with none keep the space, so every checkbox lines up.
      reqCount ? h('button', {
        type: 'button', class: `row-chev${reqOpenNow ? ' open' : ''}`, 'aria-expanded': String(reqOpenNow),
        'aria-label': `${reqOpenNow ? 'Hide' : 'Show'} the ${plural(reqCount, 'requirement')} of ${m.name}`,
        title: `${reqOpenNow ? 'Hide' : 'Show'} its ${plural(reqCount, 'requirement')}`, dataset: { key: `${m.id}:chev` },
        onclick: ev => { ev.stopPropagation(); setReqOpen([m.id], !reqOpenNow); },
      }, icon('chevron-right')) : h('span', { class: 'row-chev-space', 'aria-hidden': 'true' }),
      h('input', {
        type: 'checkbox', 'aria-label': `Select ${m.name}`, tabindex: '-1',
        onchange: ev => { if (ev.target.checked) state.modSel.add(m.id); else state.modSel.delete(m.id); state.lastModClick = m.id; paintModSelection(); },
      }))),
    h('td', {}, switchBtn),
    h('td', {}, h('div', { class: 'cell-name' },
      h('div', { class: 'name-line' },
        h('button', { class: 'name-btn', title: `${m.name} — open details`, dataset: { key: `${m.id}:name` }, onclick: ev => { ev.stopPropagation(); openDrawer(m.id); } }, m.name)),
      sub ? h('div', { class: 'subname', title: sub }, sub) : null)),
    h('td', { class: 'status-cell' }, h('div', { class: 'chips-row' }, statusTag(m, modStatusItems(m, neededBy, byId)))),
    h('td', { class: 'num ver-cell', title: m.versions ? `${m.versions.length} versions installed` : m.version || '' }, m.versions ? versionMenu(m) : h('span', { class: 'ver-text' }, m.version || ''))), ...reqRows(m, neededBy)];
  };
  // The user's categories: a section each, in their order, every mod sorted within its own (none: the
  // plain list as always).
  keepFocus(tbody, () => tbody.replaceChildren(...(grouped ? grouped.flatMap(g => [sectionHeader(g.s, g.mods.length, g.total), ...(g.collapsed ? [] : g.mods.length ? g.mods.flatMap(rowsFor) : [sectionEmptyRow(g.s)])]) : mods.flatMap(rowsFor))), null);
  if (state.renameSection) { const id = state.renameSection; state.renameSection = ''; startSectionRename(id); }
  $('#mods-bulk-cat').hidden = !sectionList().length;

  const withReqs = mods.filter(m => reqsOf(m.id).length); // (the mods listed now: filtered, searched)
  $('#mods-req-all').hidden = !withReqs.length;
  const allOpen = withReqs.length > 0 && withReqs.every(m => reqIsOpen(m.id));
  $('#mods-req-all').lastChild.textContent = allOpen ? 'Collapse all' : 'Expand all';
  $('#mods-req-all').setAttribute('aria-label', allOpen ? 'Hide the requirements under every mod' : 'Show the requirements under every mod');

  markInspected();
  // Empty states: nothing installed vs nothing matching.
  $('#mods-empty').hidden = mods.length > 0;
  $('#mods-card').classList.toggle('is-empty', mods.length === 0);
  $('#page-mods').classList.toggle('no-items', all.length === 0);
  if (!all.length) {
    $('#mods-empty-title').textContent = 'No mods installed';
    $('#mods-empty-text').textContent = 'Download mods from Nexus, or install an archive you already have.';
    $('#mods-empty-actions').hidden = false;
    $('#mods-empty-note').replaceChildren(...[managersNote(state.snap, { compact: true })].filter(Boolean));
  } else {
    $('#mods-empty-note').replaceChildren();
    $('#mods-empty-title').textContent = 'No matching mods';
    $('#mods-empty-text').textContent = 'Try another search or filter.';
    $('#mods-empty-actions').hidden = true;
  }

  // The subtitle summarises what needs attention; each part filters the list to it.
  // This app's mods and Vortex's are counted apart: profiles hold only this app's (as the Profiles page counts them).
  const enabled = state.snap.mods.filter(m => m.enabled).length;
  const conflicts = Object.keys(state.snap.conflicts).length;
  const updates = groupedMods().map(rowUpdateId).filter(Boolean); // one per row, as listed
  const broken = all.filter(m => m.health).length;
  const problems = all.filter(hasProblem).length;
  const sub = $('#mods-sub');
  // Counted as rows: the versions of one mod are one.
  const rows = groupedMods();
  const vxCount = rows.filter(m => m.vortex).length;
  const own = rows.length - vxCount;
  sub.replaceChildren(all.length ? `${plural(own, 'mod')} here · ${enabled} enabled` : 'Nothing installed yet');
  if (vxCount) {
    const vxOn = rows.filter(m => m.vortex && m.enabled).length;
    const prof = state.snap.vortex.activeProfileName;
    sub.append(' · ', h('button', {
      class: 'link-btn quiet', onclick: () => setModFilter('vortex'),
      title: 'Vortex\'s mods follow Vortex\'s own profile, not this app\'s profiles. Settings → Vortex can move them here.',
    }, `${vxCount} in Vortex (${vxOn} on${prof ? `, its profile "${prof}"` : ''})`));
  }
  $('#mods-open-vortex').hidden = !state.snap.vortex?.installed;
  const link = (text, f, cls = '') => h('button', { class: `link-btn quiet ${cls}`, onclick: () => setModFilter(f) }, text);
  if (broken) sub.append(' · ', link(`${plural(broken, 'mod')} need${broken === 1 ? 's' : ''} repair`, 'repair', 'warn'));
  if (conflicts) sub.append(' · ', link(`${plural(conflicts, 'mod')} with file conflicts`, 'conflicts'));
  if (updates.length) sub.append(' · ', link(`${plural(updates.length, 'update')} available`, 'updates'));
  // Problems: what the red count on the old filter tab said, now a link like the others.
  if (problems) sub.append(' · ', link(`${plural(problems, 'mod')} with problems`, 'problems', 'err'));

  const updAll = $('#mods-update-all');
  updAll.hidden = updates.length === 0;
  updAll.querySelector('.menu-label').textContent = `Update all (${updates.length})`;
  updAll.setAttribute('aria-label', `Update all ${plural(updates.length, 'mod')}`);
  moreAttention.updates = updates.length;
  paintMoreDot();
  const checkBtn = $('#mods-check-updates');
  const checked = state.snap.lastUpdateCheck;
  if (!checkBtn.disabled) $('#mods-check-sub').textContent = checked ? `Last checked ${ago(checked)}` : 'Ask Nexus for newer versions of your mods';
  checkBtn.title = checked ? `Last checked ${new Date(checked).toLocaleString()}` : '';
  checkBtn.hidden = all.length === 0;
  $('#mods-redeploy').disabled = enabled === 0;
  $('#mods-purge').disabled = enabled === 0;
  $('#mods-redeploy').hidden = all.length === 0;
  $('#mods-import').hidden = all.length === 0;
  $('#mods-purge').hidden = all.length === 0;
  $('#mods-running').hidden = !state.gameRunning;
  // The sidebar counts everything that loads: this app's mods and Vortex's.
  const allOn = all.filter(m => m.enabled).length;
  const nav = $('#nav-mods-count');
  nav.textContent = all.length ? `${allOn}/${all.length}` : '';
  nav.classList.toggle('attn', broken > 0);
  nav.title = all.length ? `${allOn} of ${all.length} mods enabled${vxCount ? ` (${enabled} here, ${allOn - enabled} in Vortex)` : ''}${broken ? ` · ${broken} need repair` : ''}` : '';
  paintModSelection();
}
function setModFilter(f) {
  state.modFilter = MOD_FILTERS.some(x => x[0] === f) ? f : 'all';
  renderMods();
}

$('#mods-search').addEventListener('input', debounce(() => { state.searchClosed.clear(); renderMods(); }, 120));
// Collapse all / Expand all: every mod with requirements (the button says which it does now).
$('#mods-req-all').addEventListener('click', () => {
  const withReqs = visibleMods().filter(m => reqsOf(m.id).length).map(m => m.id); // the ones listed now
  setReqOpen(withReqs, !withReqs.every(reqIsOpen));
});
$('#mods-cat').addEventListener('change', ev => {
  state.modCat = ev.target.value;
  renderMods();
});
$('#mods-sort').value = state.modSort;
$('#mods-sort').addEventListener('change', ev => {
  state.modSort = ev.target.value;
  store.set('modSort', state.modSort);
  renderMods();
});
$('#mods-filter').addEventListener('change', ev => setModFilter(ev.target.value));
$('#mods-all').addEventListener('change', ev => {
  shownMods().forEach(m => (ev.target.checked ? state.modSel.add(m.id) : state.modSel.delete(m.id)));
  paintModSelection();
});
$('#mods-sel-clear').addEventListener('click', () => { state.modSel.clear(); paintModSelection(); });

document.addEventListener('keydown', ev => {
  const typing = ev.target.closest('input,textarea,select');
  if (ev.ctrlKey && ev.key.toLowerCase() === 'a' && !typing && $('#modal-back').hidden) {
    if ($('#page-mods').classList.contains('active')) { ev.preventDefault(); shownMods().forEach(m => state.modSel.add(m.id)); paintModSelection(); }
    if ($('#page-downloads').classList.contains('active')) { ev.preventDefault(); visibleDownloads().forEach(d => state.dlSel.add(d.key)); paintDlSelection(); }
  }
  if (ev.key === 'Escape') {
    if (!$('#modal-back').hidden) { ev.preventDefault(); if (modalClose) modalClose(); return; }
    if (!$('#drawer').hidden) { closeDrawer(); return; }
    if (!typing) { state.modSel.clear(); state.dlSel.clear(); paintModSelection(); paintDlSelection(); }
  }
});

/** Enable/disable; Vortex mods are switched by Vortex, which closes and reopens to apply them. */
let vortexConfirmed = false;
/** Vortex locks its data while it is open: then it has to close for a change, and reopens after. */
async function confirmVortexClose(count) {
  if (!count || !state.snap.vortex?.running || vortexConfirmed) return true;
  const ok = await confirmBox('Vortex is open', `Vortex locks its data while it is open, so it closes for a moment: the change to ${plural(count, 'Vortex mod')} is applied, and Vortex opens again. Anything in progress in Vortex should finish first. With Vortex closed, changes apply without opening it.`, 'Close Vortex and apply');
  if (ok) vortexConfirmed = true;
  return ok;
}

async function setModsEnabled(ids, enabled) {
  if (!enabled) {
    if (!(await confirmDependents(ids))) return null;
  } else {
    const more = await offerRequirements(ids);
    if (more === null) return null;
    ids = [...ids, ...more];
    // Files these share with enabled mods (or each other) that differ: whose copy loads.
    const plan = (await api.conflictPlan(ids.filter(id => !isVx(id)))).ok || [];
    if (plan.length) {
      const picks = await fileChoiceBox(plan, { enabling: true });
      if (picks === null) return null;
      if (!(await run(api.setFileChoices(picks)))) return null;
    }
  }
  const vx = ids.filter(isVx);
  // Enabling one of ours that Vortex also has switches Vortex's copy off: Vortex closes if open.
  const twins = enabled ? ids.filter(id => state.snap.vortex?.twins?.[id]?.enabled).length : 0;
  if (!(await confirmVortexClose(vx.length + twins))) return null;
  return run(enabled ? api.enable(ids) : api.disable(ids));
}

/** Switching mods off that enabled mods need: list those mods and ask first. */
async function confirmDependents(ids) {
  const off = new Set(ids);
  const all = allMods();
  const byId = Object.fromEntries(all.map(m => [m.id, m]));
  const hit = all.filter(m => m.enabled && !off.has(m.id) && reqsOf(m.id).some(q => q.id && off.has(q.id)));
  if (!hit.length) return true;
  const what = ids.length === 1 ? byId[ids[0]]?.name || 'this mod' : plural(ids.length, 'mod');
  const shown = hit.slice(0, 12);
  return modal({
    title: `Switch off ${what}?`,
    body: h('div', {},
      h('p', {}, `${plural(hit.length, 'enabled mod')} ${hit.length === 1 ? 'needs' : 'need'} ${ids.length === 1 ? 'it' : 'them'}, and will stop working until you switch ${ids.length === 1 ? 'it' : 'them'} back on:`),
      h('ul', { class: 'plain-list' }, ...shown.map(m => h('li', {}, m.name)), hit.length > shown.length ? h('li', {}, `and ${hit.length - shown.length} more`) : null)),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Switch off', value: true, kind: 'btn-primary' }],
  });
}

/** Switching mods on whose requirements are off: offer those too. Returns extra ids, or null to cancel. */
async function offerRequirements(ids) {
  const on = new Set(ids);
  const want = new Map();
  const missing = new Set();
  for (const id of ids) for (const q of reqsOf(id)) {
    if (q.state === 'off' && q.id && !on.has(q.id)) want.set(q.id, q.name);
    if (q.state === 'missing') missing.add(q.name);
  }
  if (!want.size) return [];
  const names = [...want.values()];
  const v = await modal({
    title: `Also switch on ${names.length === 1 ? names[0] : plural(names.length, 'requirement')}?`,
    body: h('div', {},
      h('p', {}, `${ids.length === 1 ? 'This mod needs' : 'These mods need'} ${names.length === 1 ? 'a mod that is' : 'mods that are'} switched off:`),
      h('ul', { class: 'plain-list' }, ...names.map(n => h('li', {}, n))),
      missing.size ? h('p', { class: 'hint' }, `Not installed: ${[...missing].join(', ')}. Its row below the mod has Download.`) : null),
    buttons: [{ label: 'Cancel', value: null, safe: true }, { label: 'Only this', value: 'only' }, { label: 'Switch on all', value: 'all', kind: 'btn-primary' }],
  });
  if (v === null || v === undefined || v === false) return null;
  return v === 'all' ? [...want.keys()] : [];
}

/** The version menu of a grouped row. */
async function pickVersion(m, id) {
  const v = m.versions.find(x => x.id === id);
  if (!v || id === m.id && v.enabled) return;
  const on = m.versions.filter(x => x.enabled);
  if (!on.length) {
    // Nothing enabled: only which version the row shows (and the switch enables) changes.
    state.versionPick[m.groupKey] = id;
    store.set('versionPick', state.versionPick);
    renderMods();
    return;
  }
  if (!(await confirmVortexClose(isVx(id) ? 1 : 0))) { renderMods(); return; }
  const ok = await run(api.switchVersion(on.map(x => x.id).filter(x => x !== id), id), `Switched ${m.name} to ${v.version ? `v${v.version}` : v.name}`);
  if (ok === null) renderMods();
}

async function modAction(act, ids) {
  // Vortex mods: on/off and updates go through Vortex; the rest is done in Vortex itself.
  if (ids.some(isVx) && !['enable', 'disable', 'update'].includes(act)) {
    const own = ids.filter(id => !isVx(id));
    toast(`Vortex mods are ${act === 'delete' || act === 'uninstall' ? 'removed' : 'changed'} in Vortex; ${own.length ? 'only this app\'s mods were included' : 'nothing to do here'}`);
    ids = own;
    if (!ids.length) return null;
  }
  const n = ids.length;
  const what = plural(n, 'mod');
  switch (act) {
    case 'enable': return setModsEnabled(ids, true);
    case 'disable': return setModsEnabled(ids, false);
    case 'prioritize': return run(api.prioritize(ids), n === 1 ? 'This mod now wins its file conflicts' : `${what} now win their file conflicts`);
    case 'update': {
      const withUpdate = [...new Set(ids.map(updateIdFor).filter(Boolean))];
      if (!withUpdate.length) { toast('No updates for the selected mods'); return null; }
      // Vortex mods are updated here: they move to this app first.
      const vx = withUpdate.filter(isVx);
      if (vx.length) {
        const ok = await confirmBox('Update Vortex mods here', `${plural(vx.length, 'Vortex mod')} will move to this app and be updated here, without opening Vortex. Vortex keeps the old version, switched off.`, 'Move and update');
        if (!ok || !(await confirmVortexClose(vx.length))) return null;
      }
      return run(api.updateMods(withUpdate), `Updating ${plural(withUpdate.length, 'mod')} — see Downloads`);
    }
    case 'repair': return run(api.repair(ids), `Repaired ${what}`);
    case 'reinstall':
      if (await confirmBox('Reinstall mods', `Reinstall ${what} from the downloaded archives? Mods with an installer will ask for their options again.`, 'Reinstall')) return run(api.reinstall(ids));
      return null;
    case 'uninstall':
      if (await confirmBox('Uninstall mods', `Uninstall ${what}? Their files leave the game folder. The downloaded archives stay in your library.`, 'Uninstall', true)) {
        await run(api.uninstall(ids), `Uninstalled ${what}`);
        ids.forEach(id => state.modSel.delete(id));
      }
      return null;
    case 'delete': {
      const keys = state.snap.mods.filter(m => ids.includes(m.id)).map(m => m.key);
      if (await confirmBox('Delete mods', `Uninstall ${what} and delete the downloaded archives? This can't be undone.`, 'Delete', true)) {
        await run(api.deleteDownloads(keys), `Deleted ${what}`);
        ids.forEach(id => state.modSel.delete(id));
      }
      return null;
    }
    default: return null;
  }
}

$$('#mods-bulk [data-act]').forEach(b => b.addEventListener('click', () => modAction(b.dataset.act, [...state.modSel])));

const importArchives = () => run(api.importArchives());

// Archives dragged onto the window from Explorer are installed like "Install from file".
let dragDepth = 0;
const hasFiles = ev => [...(ev.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', ev => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth++;
  $('#drop-zone').hidden = false;
});
window.addEventListener('dragover', ev => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', ev => {
  if (!hasFiles(ev)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-zone').hidden = true;
});
window.addEventListener('drop', async ev => {
  ev.preventDefault();
  dragDepth = 0;
  $('#drop-zone').hidden = true;
  const paths = [...(ev.dataTransfer?.files || [])].map(f => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const r = await run(api.installPaths(paths));
  if (r?.profile) { goTo('profiles'); importReview(r.profile); return; } // a shared profile .zip
  if (r) toast(`Installing ${plural(r.count, 'archive')}${r.skipped ? ` · ${r.skipped} skipped (not .zip, .7z or .rar)` : ''}`, 'success');
});
$('#mods-import').addEventListener('click', importArchives);
$('#mods-new-cat').addEventListener('click', newSection);
$('#mods-bulk-cat').addEventListener('click', ev => sectionMenu(ev.currentTarget, [...state.modSel]));
$('#mods-empty-import').addEventListener('click', importArchives);
$('#mods-redeploy').addEventListener('click', () => run(api.redeploy(), 'Deployment checked'));
$('#mods-update-all').addEventListener('click', () => {
  const ids = groupedMods().map(rowUpdateId).filter(Boolean);
  modAction('update', ids);
});
$('#mods-check-updates').addEventListener('click', async ev => {
  const btn = ev.currentTarget;
  if (btn.disabled) return;
  const label = btn.querySelector('.menu-label');
  btn.disabled = true;
  label.textContent = 'Checking…';
  toast('Checking Nexus for updates…');
  try {
    const r = await run(api.checkUpdates());
    if (r) toast(r.available ? `${plural(r.available, 'update')} available` : `All mods are up to date (${plural(r.checked, 'mod')} checked)`, r.available ? 'info' : 'success');
    if (r?.available) setModFilter('updates');
  } finally {
    btn.disabled = false;
    label.textContent = 'Check for updates';
  }
});
$('#mods-purge').addEventListener('click', async () => {
  if (await confirmBox('Disable all mods', 'Take every mod out of the game folder and restore any original files? Mods stay installed and can be enabled again.', 'Disable all', true)) {
    await run(api.purge());
  }
});

// ---------------------------------------------------------------- mod details drawer

// Named seams (not inlined) so the screenshot harness can supply demo data.
// eslint-disable-next-line prefer-const
var fetchModFiles = id => run(api.modFiles(id));
// eslint-disable-next-line prefer-const
var fetchModConflicts = id => run(api.modConflicts(id));

/** Extra drawer sections other modules can add (the game-log page adds "Game log problems"). */
const drawerSections = [];
let drawerOpener = null;
let drawerOpenerKey = '';

/** The panel is shown or not; the page makes room for it, and the mod it shows is marked in the list. */
function setDrawerShown(on) {
  $('#drawer').hidden = !on;
  document.body.classList.toggle('drawer-open', on);
  markInspected();
}
function markInspected() {
  for (const tr of $$('#mods-table tbody tr.row')) tr.classList.toggle('inspect', !$('#drawer').hidden && tr.dataset.id === state.drawerMod);
}

function closeDrawer() {
  state.drawerMod = null;
  drawerTabMod = ''; // opened again later: it starts at Overview
  setDrawerShown(false);
  state.drawerSig = '';
  if (drawerOpener) restoreFocus(drawerOpener, drawerOpenerKey);
  drawerOpener = null;
}

/** What the drawer shows depends on these; a snapshot that changes none of them leaves it alone. */
const drawerSignature = m => JSON.stringify([m.enabled, m.priority, m.installedAt, m.fileCount, m.warnings, m.notes, ignOf(m), m.health, state.snap.conflicts[m.id], state.snap.updates?.[m.id], state.modLogProblems[m.id],
  reqsOf(m.id), state.snap.vortex?.overlaps?.[m.id], state.snap.vortex?.twins?.[m.id], modCatOf(m), neededByMap(allMods()).get(m.id) || []]);
// The tab the details panel shows (it stays while the same mod is open; another mod starts at Overview).
let drawerTab = 'ov';
let drawerTabMod = '';

let drawerSeq = 0;

/**
 * The panel's picture: the mod's Nexus picture (cached by the app), or a placeholder. Adult pictures
 * stay blurred until "Show adult image" (remembered per mod). Asked again only when the mod or its
 * version changes, so redrawing the panel does not flicker.
 */
const drawerImages = new Map();
let drawerImageFor = '';
function paintDrawerImage(m) {
  const key = m.modId ? `${m.game || 'cyberpunk2077'}:${m.modId}:${m.version || ''}` : '';
  if (key === drawerImageFor) return;
  drawerImageFor = key;
  const img = $('#drawer-img');
  const reveal = $('#drawer-reveal');
  const adultKey = `${m.game || 'cyberpunk2077'}:${m.modId}`;
  const show = r => {
    if (drawerImageFor !== key) return; // another mod opened meanwhile
    const shown = new Set(store.get('adultShown', []));
    img.hidden = !r;
    if (r) img.src = r.url; else img.removeAttribute('src');
    const blur = !!r?.adult && !shown.has(adultKey);
    $('#drawer-hero').classList.toggle('is-adult', blur);
    reveal.hidden = !blur;
    reveal.onclick = () => {
      store.set('adultShown', [...new Set([...store.get('adultShown', []), adultKey])].slice(-500));
      $('#drawer-hero').classList.remove('is-adult');
      reveal.hidden = true;
    };
  };
  img.hidden = true;
  reveal.hidden = true;
  $('#drawer-hero').classList.remove('is-adult');
  if (!key) return;
  if (drawerImages.has(key)) { show(drawerImages.get(key)); return; }
  api.modImage(m.game || 'cyberpunk2077', m.modId, m.version || '').then(r => {
    const v = r?.ok || null;
    if (v) drawerImages.set(key, v); // no picture now (offline, an error): asked again next time
    show(v);
  }).catch(() => {});
}
// A picture that fails to load (its cache file was replaced) gives way to the placeholder, and is asked for again next time.
$('#drawer-img').addEventListener('error', ev => {
  ev.currentTarget.hidden = true;
  drawerImages.delete(drawerImageFor);
  drawerImageFor = '';
});

/** The panel's top: the picture, category, name and version, and Open on Nexus Mods. */
function paintDrawerHead(m, cat, sub) {
  paintDrawerImage(m);
  $('#drawer-cat').textContent = cat;
  $('#drawer-title').textContent = m.name;
  $('#drawer-title').title = m.name;
  $('#drawer-sub').textContent = sub;
  const nexus = $('#drawer-nexus');
  nexus.hidden = !m.modId;
  nexus.onclick = () => api.openNexus(m.game, m.modId);
}

/** The actions as square buttons, two to a row (an odd last one takes the whole row). */
function paintDrawerActions(buttons) {
  const list = buttons.filter(Boolean);
  list.forEach(b => b.classList.add('btn-sq'));
  if (list.length % 2) list.at(-1).classList.add('span2');
  $('#drawer-actions').replaceChildren(...list);
}

/**
 * The tabs and their panes. `panes`: [{ key, label, count, bad, nodes }]. Only the chosen pane is
 * shown; Status items and openDrawer(id, section) reach the others through showDrawerSection.
 */
function paintDrawerTabs(panes) {
  if (!panes.some(p => p.key === drawerTab)) drawerTab = 'ov';
  $('#drawer-tabs').replaceChildren(...panes.map(p => h('button', {
    class: 'drawer-tab', role: 'tab', id: `dtab-${p.key}`, 'aria-controls': `dpane-${p.key}`, 'aria-selected': String(p.key === drawerTab),
    tabindex: p.key === drawerTab ? '0' : '-1', dataset: { key: `dtab:${p.key}`, tab: p.key },
    onclick: () => showDrawerTab(p.key),
  }, h('span', {}, p.label), p.count !== undefined && p.count !== '' ? h('span', { class: `drawer-count${p.bad ? ' bad' : ''}` }, String(p.count)) : null)));
  $('#drawer-body').replaceChildren(...panes.map(p => h('div', {
    class: 'dpane', role: 'tabpanel', tabindex: '0', id: `dpane-${p.key}`, 'aria-labelledby': `dtab-${p.key}`, dataset: { pane: p.key }, hidden: p.key !== drawerTab,
  }, ...p.nodes.filter(Boolean))));
  const chosen = $('#drawer-tabs [aria-selected="true"]');
  if (chosen) revealDrawerTab(chosen); // a redrawn row keeps the chosen tab in view
}

function showDrawerTab(key) {
  if (!$(`#dpane-${key}`)) return;
  drawerTab = key;
  for (const t of $$('#drawer-tabs [role="tab"]')) {
    const on = t.dataset.tab === key;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on) revealDrawerTab(t);
  }
  for (const p of $$('#drawer-body .dpane')) p.hidden = p.dataset.pane !== key;
  $('#drawer-body').scrollTop = 0;
}

/**
 * A tab partly or wholly outside the tab row snaps into it (the row only, never the page). An
 * instant snap: smooth scrolling is not always run (seen not to in a window without focus).
 */
function revealDrawerTab(tab) {
  const row = $('#drawer-tabs');
  if (!row.clientWidth) return; // not laid out (the panel is hidden)
  const pad = 8;
  const r = tab.getBoundingClientRect();
  const left = r.left - row.getBoundingClientRect().left + row.scrollLeft;
  const right = left + r.width;
  let to = null;
  if (left - pad < row.scrollLeft) to = left - pad;
  else if (right + pad > row.scrollLeft + row.clientWidth) to = right + pad - row.clientWidth;
  if (to !== null) row.scrollLeft = Math.max(0, to);
}

// The wheel over the tab row scrolls it sideways when the tabs do not fit (and only then).
$('#drawer-tabs').addEventListener('wheel', ev => {
  const row = ev.currentTarget;
  if (row.scrollWidth <= row.clientWidth + 1 || ev.ctrlKey) return;
  if (Math.abs(ev.deltaX) >= Math.abs(ev.deltaY)) return; // a sideways swipe scrolls the row by itself
  const d = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? row.clientWidth : 1);
  // At either end, the wheel goes on to the panel as usual.
  if ((d < 0 && row.scrollLeft <= 0) || (d > 0 && row.scrollLeft >= row.scrollWidth - row.clientWidth - 1)) return;
  ev.preventDefault();
  row.scrollLeft += d;
}, { passive: false });

/** Shows the tab holding a section (status, reqs, needed, conflicts, update, health, logs, warnings, files) and scrolls to it. */
function showDrawerSection(sec, smooth = false) {
  const el = $('#drawer-body').querySelector(`[data-section="${sec}"]`);
  const pane = el?.closest('.dpane');
  if (!pane) return;
  showDrawerTab(pane.dataset.pane);
  el.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
}

// Arrow keys move between the tabs (the tab list is one stop for Tab).
$('#drawer-tabs').addEventListener('keydown', ev => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
  const tabs = $$('#drawer-tabs [role="tab"]');
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  ev.preventDefault();
  const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  showDrawerTab(tabs[next].dataset.tab);
});

/** A newly opened mod starts at Overview; the same mod redrawn keeps its tab (a section asked for picks its own). */
function startDrawerTab(id) {
  if (drawerTabMod !== id) drawerTab = 'ov';
  drawerTabMod = id;
}

async function openDrawer(id, focusSection = '', takeFocus = true) {
  const m = allMods().find(x => x.id === id);
  if (!m) return;
  if (m.vortex) { openVortexDrawer(m, takeFocus && !(!$('#drawer').hidden && state.drawerMod === id), focusSection); return; }
  const seq = ++drawerSeq;
  const wasOpen = !$('#drawer').hidden && state.drawerMod === id;
  if (!wasOpen && $('#drawer').hidden) {
    drawerOpener = document.activeElement;
    drawerOpenerKey = drawerOpener?.closest?.('[data-key]')?.dataset.key || '';
  }
  state.drawerMod = id;
  state.drawerSig = drawerSignature(m);
  const hasConflicts = !!state.snap.conflicts[id];

  const [files, conflicts] = await Promise.all([fetchModFiles(id), hasConflicts ? fetchModConflicts(id) : []]);
  // A newer request (another mod, or a newer snapshot) has started: this result is stale.
  if (seq !== drawerSeq || state.drawerMod !== id) return;
  startDrawerTab(id);

  const drawer = $('#drawer');
  const body = $('#drawer-body');
  const keepScroll = wasOpen ? body.scrollTop : 0;
  const byId = Object.fromEntries(allMods().map(x => [x.id, x.name]));
  const kv = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  const act = (label, name, a, kind = '') => h('button', { class: `btn ${kind}`, dataset: { key: `act:${a}` }, onclick: () => modAction(a, [m.id]) }, icon(name), h('span', {}, label));
  const fileList = files || [];
  const upd = state.snap.updates?.[m.id];

  keepFocus(drawer, () => {
    paintDrawerHead(m, [modCatOf(m) || (m.modId ? 'Nexus mod' : 'Local file'), m.enabled ? '' : 'Disabled'].filter(Boolean).join(' · '),
      [m.author, m.version ? `v${m.version}` : '', m.modName !== m.name ? m.modName : ''].filter(Boolean).join(' · '));
    paintDrawerActions([
      m.enabled ? act('Disable', 'ban', 'disable') : act('Enable', 'check', 'enable', 'btn-primary'),
      upd ? act(upd.version ? `Update to ${upd.version}` : 'Update', 'up-circle', 'update', 'btn-primary') : null,
      hasConflicts && !(conflicts || []).length ? act('Win conflicts', 'arrow-up', 'prioritize') : null,
      h('button', { class: 'btn', title: 'See this mod\'s files and edit them', onclick: () => { closeDrawer?.(); openConfigFor(`app:${m.id}`); } }, icon('file-code'), h('span', {}, 'Edit files')),
      h('button', { class: 'btn', title: 'Ask the AI assistant about this mod', onclick: () => askAi(`Look at the mod "${m.name}": is anything wrong with it (logs, conflicts, missing files, load order)? What should I do?`) }, icon('sparkle'), h('span', {}, 'Ask AI')),
      act('Reinstall', 'rotate', 'reinstall'),
      act('Uninstall', 'minus-circle', 'uninstall', 'btn-danger-text'),
    ]);
    const all = allMods();
    const neededBy = neededByMap(all);
    const items = modStatusItems(m, neededBy, Object.fromEntries(all.map(x => [x.id, x])));
    const problems = items.filter(i => i.sev === 'err' || i.sev === 'warn').length;
    const reqs = reqsOf(m.id);
    paintDrawerTabs([
      {
        key: 'ov', label: 'Overview', count: problems || '', bad: problems > 0,
        nodes: [
          ...statusSection(items),
          h('h2', {}, 'Details'),
          h('dl', { class: 'kv' },
            kv('Status', !m.enabled ? h('span', { class: 'tag' }, 'Disabled')
              : m.health ? h('span', { class: 'tag tag-warn' }, 'Enabled · needs repair') : h('span', { class: 'tag tag-ok' }, 'Enabled')),
            kv('Version', m.version ? `${m.version}${upd?.version ? ` (${upd.version} on Nexus)` : ''}` : '—'),
            m.author ? kv('Author', m.author) : null,
            kv('Type', m.type),
            ...(sectionList().length ? kv('Category', sectionPicker(m)) : []),
            kv(sectionList().length ? 'Nexus category' : 'Category', modCatOf(m) || 'Unassigned'),
            kv('File category', CAT_LABEL[m.category] || m.category),
            m.dependencyOf ? kv('Required by', m.dependencyOf) : null,
            kv('Priority', `${m.priority}${hasConflicts ? ' — higher wins file conflicts' : ''}`),
            kv('Installed', new Date(m.installedAt).toLocaleString()),
            m.modId ? kv('Nexus mod', String(m.modId)) : null,
            m.skipped ? kv('Not installed', `${plural(m.skipped, 'file')} (readmes, images, unknown files)`) : null),
          ...warningsSection(m),
          ...drawerSections.flatMap(fn => fn(m) || []),
        ],
      },
      { key: 'reqs', label: 'Requires', count: reqs.length, bad: reqs.some(q => !reqIgnored(m, q) && (q.state === 'missing' || (m.enabled && q.state === 'off'))), nodes: reqSection(m) },
      { key: 'needed', label: 'Needed by', count: (neededBy.get(m.id) || []).length, nodes: neededSection(m, neededBy) },
      (conflicts || []).length ? { key: 'conflicts', label: 'Conflicts', count: conflicts.length, nodes: conflictSection(m, conflicts) } : null,
      {
        key: 'files', label: 'Files', count: fileList.length || m.fileCount,
        nodes: [fileList.length
          ? h('div', { class: 'filelist', dataset: { section: 'files' } }, fileList.map(f => h('div', {},
            h('span', {}, f.dest),
            m.enabled && !f.deployed ? h('span', { class: 'lost', title: f.owner ? `The copy from ${byId[f.owner] || f.owner} is in the game` : 'Not in the game folder' }, f.owner ? `overridden by ${byId[f.owner] || 'another mod'}` : 'missing') : null)))
          : h('div', { class: 'empty-inline', dataset: { section: 'files' } }, m.fileCount ? 'The file list could not be read. Reinstall the mod to rebuild it.' : 'This mod installed no files.')],
      },
    ].filter(Boolean));
    dropDeadLinks(body);
  }, '#drawer-close');

  setDrawerShown(true);
  if (focusSection) showDrawerSection(focusSection);
  else body.scrollTop = keepScroll;
  if (!wasOpen && takeFocus && !drawer.contains(document.activeElement)) $('#drawer-close').focus();
}

/** A Vortex mod: what Vortex knows about it, and what can be done from here. */
function openVortexDrawer(m, takeFocus = true, focusSection = '') {
  const drawer = $('#drawer');
  if (drawer.hidden) { drawerOpener = document.activeElement; drawerOpenerKey = drawerOpener?.closest?.('[data-key]')?.dataset.key || ''; }
  state.drawerMod = m.id;
  state.drawerSig = drawerSignature(m);
  startDrawerTab(m.id);
  const vx = state.snap.vortex || {};
  const u = state.snap.updates?.[m.id];
  const ours = state.snap.mods.filter(o => (vx.overlaps?.[o.id] || []).includes(m.id));
  const kv = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  keepFocus(drawer, () => {
    paintDrawerHead(m, [modCatOf(m) || 'Vortex', 'Managed by Vortex'].join(' · '), [m.author, m.version ? `v${m.version}` : ''].filter(Boolean).join(' · '));
    paintDrawerActions([
      m.enabled
        ? h('button', { class: 'btn', dataset: { key: 'act:disable' }, onclick: () => modAction('disable', [m.id]) }, icon('ban'), h('span', {}, 'Disable in Vortex'))
        : h('button', { class: 'btn btn-primary', dataset: { key: 'act:enable' }, onclick: () => modAction('enable', [m.id]) }, icon('check'), h('span', {}, 'Enable in Vortex')),
      u ? h('button', { class: 'btn btn-primary', dataset: { key: 'act:update' }, onclick: () => modAction('update', [m.id]) }, icon('up-circle'), h('span', {}, u.version ? `Update to ${u.version}` : 'Update')) : null,
      h('button', { class: 'btn', title: 'This app manages it from now on; Vortex keeps it, switched off', onclick: () => moveFromVortex([m.id]) }, icon('download'), h('span', {}, 'Move to this app')),
      h('button', { class: 'btn', onclick: () => run(api.openVortex()) }, icon('vortex'), h('span', {}, 'Open Vortex')),
      h('button', { class: 'btn', title: 'See this mod\'s files and edit them', onclick: () => { closeDrawer?.(); openConfigFor(`vx:${m.vortexId}`); } }, icon('file-code'), h('span', {}, 'Edit files')),
      h('button', { class: 'btn', title: 'Ask the AI assistant about this mod', onclick: () => askAi(`Look at the Vortex mod "${m.name}": is anything wrong with it? What should I do?`) }, icon('sparkle'), h('span', {}, 'Ask AI')),
    ]);
    const all = allMods();
    const neededBy = neededByMap(all);
    const items = modStatusItems(m, neededBy, Object.fromEntries(all.map(x => [x.id, x])));
    const problems = items.filter(i => i.sev === 'err' || i.sev === 'warn').length;
    const reqs = reqsOf(m.id);
    paintDrawerTabs([
      {
        key: 'ov', label: 'Overview', count: problems || '', bad: problems > 0,
        nodes: [
          ...statusSection(items),
          h('h2', {}, 'Details'),
          h('dl', { class: 'kv' },
            kv('Status', m.enabled ? h('span', { class: 'tag tag-ok' }, 'Deployed by Vortex') : h('span', { class: 'tag' }, 'Disabled in Vortex')),
            kv('Version', m.version || '—'),
            m.author ? kv('Author', m.author) : null,
            kv('Vortex profile', vx.activeProfileName || '—'),
            ...(sectionList().length ? kv('Category', sectionPicker(m)) : []),
            kv(sectionList().length ? 'Nexus category' : 'Category', modCatOf(m) || 'Unassigned'),
            kv('Files in the game', String(m.fileCount)),
            m.installedAt ? kv('Installed', new Date(m.installedAt).toLocaleString()) : null,
            m.modId ? kv('Nexus mod', String(m.modId)) : null,
            kv('Changes', 'Switching it on or off here is done without opening Vortex (if Vortex is open, it closes for a moment). Move to this app to manage it here entirely.')),
          u ? h('h2', { dataset: { section: 'update' } }, 'Update available') : null,
          u ? h('div', { class: 'notice notice-info' }, icon('up-circle'),
            h('div', { class: 'notice-text' }, h('div', { class: 'name' }, `${u.name}${u.version ? ` · v${u.version}` : ''}`), h('div', { class: 'subname' }, 'Updating moves it to this app, which downloads and installs the new version. Vortex is not opened.')),
            h('button', { class: 'btn btn-sm btn-primary btn-sq', onclick: () => modAction('update', [m.id]) }, 'Update')) : null,
          ours.length ? h('h2', {}, `Shares files with this app's mods · ${ours.length}`) : null,
          ours.length ? h('ul', { class: 'warnlist' }, ours.map(o => h('li', {}, `${o.name}: whichever app deploys last wins those files`))) : null,
        ],
      },
      { key: 'reqs', label: 'Requires', count: reqs.length, bad: reqs.some(q => !reqIgnored(m, q) && (q.state === 'missing' || (m.enabled && q.state === 'off'))), nodes: reqSection(m) },
      { key: 'needed', label: 'Needed by', count: (neededBy.get(m.id) || []).length, nodes: neededSection(m, neededBy) },
    ]);
    dropDeadLinks($('#drawer-body'));
  }, '#drawer-close');
  setDrawerShown(true);
  if (focusSection) showDrawerSection(focusSection);
  if (takeFocus && !drawer.contains(document.activeElement)) $('#drawer-close').focus();
}

/** For each other mod sharing files with this one: who wins, which files, and one-click fixes. */
function conflictSection(m, conflicts) {
  if (!conflicts.length) return [];
  return [
    h('h2', { dataset: { section: 'conflicts' } }, `File conflicts · ${conflicts.length}`),
    ...conflicts.map(c => h('div', { class: 'conflict' },
      h('div', { class: 'conflict-head' },
        h('div', { class: 'cell-name' },
          h('span', { class: `conflict-win ${c.weWin ? 'ok' : c.mixed ? 'split' : 'lose'}` }, c.weWin ? 'This mod wins' : c.mixed ? 'Some files from each' : `${c.name} wins`),
          h('span', { class: 'subname' }, `${plural(c.files.length, 'shared file')} with ${c.name}`)),
        m.enabled ? h('button', {
          class: 'btn btn-sm', dataset: { key: `pick:${c.id}` }, title: 'Choose whose copy of each shared file loads',
          onclick: async () => {
            // Every mod that has these files is offered (a third one too).
            const files = (c.items || []).map(i => ({ file: i.file, providers: i.providers, winner: i.winner, same: i.same }));
            const others = [...new Map(files.flatMap(f => f.providers).filter(p => p.id !== m.id).map(p => [p.id, p])).values()];
            const picks = await fileChoiceBox([{ mod: { id: m.id, name: m.name }, others, files }]);
            if (picks && (await run(api.setFileChoices(picks)))) toast('Saved: those files load from the mod you picked', 'success');
          },
        }, 'Choose files…') : null,
        c.weWin
          ? h('button', { class: 'btn btn-sm', dataset: { key: `let:${c.id}` }, title: `Move ${c.name} to the top priority, so it wins over this and every other mod`, onclick: () => modAction('prioritize', [c.id]) }, 'Let the other win')
          : h('button', { class: 'btn btn-sm btn-primary', dataset: { key: `win:${c.id}` }, title: 'Move this mod to the top priority, so it wins over every other mod', onclick: () => modAction('prioritize', [m.id]) }, 'Make this mod win')),
      h('div', { class: 'conflict-files' }, (c.items || c.files.map(file => ({ file }))).slice(0, 50).map(f => h('div', {}, f.file,
        f.same ? h('span', { class: 'muted' }, ' · identical') : f.winner ? h('span', { class: 'muted' }, ` · ${f.winner === m.id ? 'this mod\'s copy' : `${c.name}'s copy`}${f.chosen ? ' (picked)' : ''}`) : null)),
      c.files.length > 50 ? h('div', { class: 'muted' }, `…and ${c.files.length - 50} more`) : null))),
  ];
}

/**
 * Mods that share files: whose copy of each loads. groups: [{ mod, others, files: [{ file, providers,
 * winner, same }] }] (mod, others, providers: { id, name }); a file is in one group only. All of one
 * mod's copies at once, or file by file; identical copies need no choice. Resolves { path: { id,
 * among } } for every file whose copies differ (among: the mods that have it), or null (cancelled).
 */
function fileChoiceBox(groups, { enabling = false } = {}) {
  const picks = new Map(); // path → { id, among }
  const sections = groups.map((g, gi) => {
    const differ = g.files.filter(f => !f.same);
    const same = g.files.filter(f => f.same);
    const everyone = [g.mod, ...g.others];
    for (const f of differ) picks.set(f.file, { id: f.winner, among: f.providers.map(p => p.id) });
    const allFrom = id => differ.every(f => picks.get(f.file).id === id);
    let mode = everyone.find(m => allFrom(m.id))?.id || 'files';
    const sec = h('section', { class: 'fc-pair' });
    const draw = () => keepFocus(sec, () => {
      const opt = (value, label) => h('button', {
        type: 'button', class: `seg-btn${mode === value ? ' active' : ''}`, 'aria-pressed': String(mode === value), title: label,
        dataset: { key: `fc:${gi}:mode:${value}` },
        onclick: () => {
          // "X's files": every file X has comes from X; the list stays open if X lacks some of them.
          if (value !== 'files') for (const f of differ) if (f.providers.some(p => p.id === value)) picks.get(f.file).id = value;
          mode = value === 'files' || allFrom(value) ? value : 'files';
          draw();
        },
      }, h('span', { class: 'fc-trunc' }, label));
      const mixed = new Set(differ.map(f => picks.get(f.file).id)).size > 1;
      const row = f => h('div', { class: 'fc-row' },
        h('span', { class: 'fc-file', title: f.file }, f.file, f.decided ? h('span', { class: 'fc-note' }, ' · chosen before') : null),
        h('span', { class: 'seg seg-sm', role: 'group', 'aria-label': `Whose ${f.file} loads` },
          // (in the order of the buttons above)
          ...[...f.providers].sort((x, y) => everyone.findIndex(e => e.id === x.id) - everyone.findIndex(e => e.id === y.id)).map(m => h('button', {
            type: 'button', class: `seg-btn${picks.get(f.file).id === m.id ? ' active' : ''}`, 'aria-pressed': String(picks.get(f.file).id === m.id), title: m.name,
            dataset: { key: `fc:${gi}:${f.file}:${m.id}` },
            onclick: () => { picks.get(f.file).id = m.id; draw(); },
          }, h('span', { class: 'fc-trunc' }, m.name)))));
      sec.replaceChildren(...[
        h('div', { class: 'fc-head' },
          h('div', { class: 'fc-title' }, `${g.mod.name} and ${g.others.map(o => o.name).join(', ')}`),
          h('div', { class: 'fc-sub' }, `${plural(differ.length, 'shared file')} differ${differ.length === 1 ? 's' : ''}${same.length ? ` · ${plural(same.length, 'identical file')}, no choice needed` : ''}`)),
        h('div', { class: 'seg fc-mode', role: 'group', 'aria-label': 'Whose files load' },
          ...everyone.map(m => opt(m.id, `${m.name}'s files`)), opt('files', 'Pick per file')),
        mode === 'files' ? h('div', { class: 'fc-files' }, ...differ.map(row)) : null,
        mixed ? h('p', { class: 'hint warn' }, 'Mixing files from two copies of the same mod can stop it loading. RED4ext, for one, needs bin/x64/winmm.dll and red4ext/RED4ext.dll from the same copy.') : null,
        same.length && mode === 'files' ? h('p', { class: 'hint' }, `Identical in ${everyone.length > 2 ? 'every copy' : 'both'}: ${same.map(f => f.file).join(', ')}`) : null,
      ].filter(Boolean));
    });
    draw();
    return sec;
  });
  return modal({
    title: enabling ? 'These mods share files' : 'Choose whose files load',
    sub: 'Only one copy of each file can be in the game: pick whose loads',
    body: h('div', { class: 'fc' }, ...sections),
    buttons: [
      { label: 'Cancel', value: false, safe: true },
      { label: enabling ? 'Enable' : 'Save', value: true, kind: 'btn-primary' },
    ],
  }).then(ok => (ok ? Object.fromEntries(picks) : null));
}

$('#drawer-close').addEventListener('click', closeDrawer);

/// ---------------------------------------------------------------- downloads page
/*
 * Downloads in progress in their own panel (progress, speed, time left), then one table of every
 * downloaded archive with whether it is installed, and the downloads that failed or were cancelled.
 */

const dl = { filter: 'all' };
// 'waiting': a free account's file, waiting for its "Slow download" click on Nexus.
const ACTIVE = ['queued', 'downloading', 'waiting'];

function dlRows() {
  const q = $('#dl-search').value.trim().toLowerCase();
  const match = (...t) => !q || t.join(' ').toLowerCase().includes(q);
  const jobs = [...state.jobs.values()].filter(j => j.status !== 'done' && !ACTIVE.includes(j.status)).sort((a, b) => b.id - a.id)
    .filter(j => match(j.name, j.fileName, j.modName))
    .map(j => ({ kind: 'job', id: `job:${j.id}`, j }));
  const recs = state.snap.downloads.filter(d => match(d.name, d.fileName, d.modName))
    .sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0))
    .map(d => ({ kind: 'rec', id: d.key, d }));
  const f = dl.filter;
  if (f === 'failed') return jobs.filter(r => ['error', 'cancelled'].includes(r.j.status));
  if (f === 'new') return recs.filter(r => !r.d.installed);
  if (f === 'installed') return recs.filter(r => r.d.installed);
  return [...jobs, ...recs];
}

function visibleDownloads() { return dlRows().filter(r => r.kind === 'rec').map(r => r.d); }

function paintDlSelection() {
  paintSelection($('#dl-table tbody'), state.dlSel, $('#dl-all'), visibleDownloads().map(d => d.key), $('#dl-bulk'), $('#dl-sel-count'), $('#dl-toolbar'));
}

function jobStatusCell(j) {
  const pct = j.total ? Math.min(100, (j.received / j.total) * 100) : 0;
  if (j.status === 'downloading') {
    const eta = j.speed > 0 && j.total ? Math.max(0, (j.total - j.received) / j.speed) : 0;
    return h('div', { class: 'prog', title: `${fmtSize(j.received)} of ${fmtSize(j.total)}` },
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': j.name, 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div', { style: `width:${pct.toFixed(1)}%` })),
      h('span', { class: 'prog-meta' }, `${Math.floor(pct)}% · ${fmtSize(j.speed)}/s${eta ? ` · ${fmtEta(eta)}` : ''}`));
  }
  if (j.status === 'queued') return h('span', { class: 'status' }, 'Queued');
  if (j.status === 'waiting') {
    return h('span', { class: 'status-wait' },
      h('span', { class: 'status status-warn', title: 'A free Nexus account downloads each file after one click on "Slow download" on Nexus' }, 'Needs a click'),
      getButton(j));
  }
  if (j.status === 'error') return h('span', { class: 'status status-err', title: j.error }, 'Failed');
  return h('span', { class: 'status' }, 'Cancelled');
}

/**
 * Get on a file that waits for a click: first ask Nexus whether the account is Premium now. If it is,
 * every waiting file downloads directly; if not, the file's Nexus page opens for the click.
 */
// One account check covers every waiting file: while it runs, each Get says so and ignores clicks.
// Kept outside the DOM because the rows are rebuilt while it runs (the check itself sends an update).
let gettingJob = false;

function paintGetButton(btn) {
  btn.textContent = gettingJob ? 'Checking…' : 'Get';
  btn.setAttribute('aria-disabled', String(gettingJob)); // not `disabled`: the keyboard focus stays
  btn.setAttribute('aria-busy', String(gettingJob));
}

function getButton(j) {
  const btn = h('button', {
    class: 'btn btn-sm btn-primary get-btn', dataset: { key: `job:${j.id}:get` },
    title: 'Premium: download it directly. Free account: open its Nexus download page',
    'aria-label': `Get ${j.name}`,
    onclick: async () => {
      if (gettingJob) return;
      gettingJob = true;
      document.querySelectorAll('.get-btn').forEach(paintGetButton);
      let r = null;
      try { r = await api.getJob(j.id); } catch { /* treated as not checked */ }
      gettingJob = false;
      document.querySelectorAll('.get-btn').forEach(paintGetButton);
      if (r?.ok?.premium) {
        // Browse's click-per-file flow (if open) says "every file has started" by itself.
        if (!free.active) toast('Your Nexus account is Premium: the waiting files download directly', 'success');
        return;
      }
      if (!r?.ok?.checked) toast('Could not check your Nexus account: opening the file on Nexus instead', 'warn');
      startFreeDownloads(j.id);
    },
  }, 'Get');
  paintGetButton(btn);
  return btn;
}

/** One download in progress: what, how far, how fast, and Cancel (and Get, for a free account's click). */
function progressRow(j) {
  const ico = j.status === 'downloading' ? 'download' : j.status === 'waiting' ? 'alert' : 'clock';
  const cancel = j.status === 'waiting'
    ? h('button', { class: 'btn btn-sm btn-icon btn-cancel', dataset: { key: `job:${j.id}:x` }, title: 'Cancel this download', 'aria-label': `Cancel ${j.name}`, onclick: () => run(api.cancelJob(j.id)) }, icon('x-circle'))
    : h('button', { class: 'btn btn-sm btn-icon btn-ghost', dataset: { key: `job:${j.id}:x` }, title: 'Cancel', 'aria-label': `Cancel ${j.name}`, onclick: () => run(api.cancelJob(j.id)) }, icon('x'));
  const act = j.status === 'waiting' ? [getButton(j), cancel] : cancel;
  const row = h('div', { class: `dlp-row ${j.status}`, role: 'listitem', dataset: { job: String(j.id) } },
    h('span', { class: 'dlp-icon', 'aria-hidden': 'true' }, icon(ico)),
    h('div', { class: 'dlp-name', title: `${j.name}\n${j.fileName || ''}` },
      h('span', { class: 'name' }, j.name),
      h('span', { class: 'dlp-file' }, [j.fileName || j.modName, j.dependencyOf ? `required by ${j.dependencyOf}` : '', j.forProfiles?.length ? 'for an imported profile' : ''].filter(Boolean).join(' · '))),
    h('div', { class: 'dlp-prog' },
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': j.name, 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div')),
      h('span', { class: 'dlp-note' })),
    h('span', { class: 'dlp-speed' }),
    h('div', { class: 'dlp-act' }, act));
  paintProgressRow(row, j);
  return row;
}

/** The live parts of a progress row (every update touches only these). */
function paintProgressRow(row, j) {
  const pct = j.total ? Math.min(100, (j.received / j.total) * 100) : 0;
  const eta = j.speed > 0 && j.total ? Math.max(0, (j.total - j.received) / j.speed) : 0;
  const bar = row.querySelector('.bar');
  bar.hidden = j.status !== 'downloading';
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.firstChild.style.width = `${pct.toFixed(1)}%`;
  row.querySelector('.dlp-note').textContent = j.status === 'downloading'
    ? [`${Math.floor(pct)}%`, j.total ? `${fmtSize(j.received)} of ${fmtSize(j.total)}` : '', eta ? `${fmtEta(eta)} left` : ''].filter(Boolean).join(' · ')
    : j.status === 'waiting' ? 'Needs one click on "Slow download" on Nexus (free account)' : 'Queued · starts when a slot frees up';
  row.querySelector('.dlp-speed').textContent = j.status === 'downloading' && j.speed ? `${fmtSize(j.speed)}/s` : '';
}

function renderDlProgress() {
  const jobs = [...state.jobs.values()].filter(j => ACTIVE.includes(j.status))
    .sort((a, b) => (b.status === 'downloading') - (a.status === 'downloading') || a.id - b.id);
  $('#dl-progress').hidden = !jobs.length;
  $('#dl-progress-n').textContent = jobs.length ? String(jobs.length) : '';
  const list = $('#dl-progress-list');
  keepFocus(list, () => list.replaceChildren(...jobs.map(progressRow)), null);
  paintNetwork();
}

/** The panel's header: the total speed, and how many run and wait. */
function paintNetwork() {
  const jobs = [...state.jobs.values()];
  const running = jobs.filter(j => j.status === 'downloading');
  const speed = running.reduce((n, j) => n + (j.speed || 0), 0);
  const queued = jobs.filter(j => j.status === 'queued').length;
  $('#net-now').textContent = [running.length ? `${fmtSize(speed)}/s · ${running.length} downloading` : 'Waiting', queued ? `${queued} queued` : ''].filter(Boolean).join(' · ');
  $('#net-now').classList.toggle('live', running.length > 0);
  $('#dl-premium').hidden = !(running.length && state.keyUser?.isPremium);
}

const fmtEta = s => (s < 60 ? `${Math.ceil(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);

function renderDownloads() {
  const rows = dlRows();
  const keys = rows.filter(r => r.kind === 'rec').map(r => r.d.key);
  for (const k of [...state.dlSel]) if (!state.snap.downloads.some(d => d.key === k)) state.dlSel.delete(k);
  const tbody = $('#dl-table tbody');
  keepFocus(tbody, () => tbody.replaceChildren(...rows.map(r => {
    if (r.kind === 'job') {
      const j = r.j;
      const sub = [j.modName, j.dependencyOf ? `required by ${j.dependencyOf}` : '', j.forProfiles?.length ? 'for an imported profile' : ''].filter(Boolean).join(' · ');
      const action = ACTIVE.includes(j.status)
        ? h('button', { class: 'btn btn-sm btn-icon btn-ghost', dataset: { key: `job:${j.id}:x` }, title: 'Cancel', 'aria-label': `Cancel ${j.name}`, onclick: () => run(api.cancelJob(j.id)) }, icon('x'))
        : h('button', { class: 'btn btn-sm', dataset: { key: `job:${j.id}:retry` }, title: j.error || 'Try again', onclick: () => run(api.retryJob(j.id)) }, icon('rotate'), h('span', {}, 'Retry'));
      return h('tr', { class: `row job-row ${j.status}`, dataset: { job: String(j.id) } },
        h('td', {}),
        h('td', { title: `${j.name}\n${j.fileName || ''}` }, h('div', { class: 'cell-name' }, h('span', { class: 'name' }, j.name), h('span', { class: 'subname' }, j.error || sub))),
        h('td', { class: 'dim col-cat' }, CAT_LABEL[j.category] || j.category || ''),
        h('td', { class: 'dim col-prio' }, j.version || '—'),
        h('td', { class: 'num dim' }, fmtSize(j.total)),
        h('td', { class: 'status-cell' }, jobStatusCell(j)),
        h('td', { class: 'actions' }, action));
    }
    const d = r.d;
    const status = !d.exists ? h('span', { class: 'status status-err', title: 'The archive is no longer on disk' }, 'Missing')
      : d.installed ? h('span', { class: 'status status-ok' }, 'Installed') : h('span', { class: 'status' }, 'Not installed');
    const sub = [d.modName !== d.name ? d.modName : '', d.dependencyOf ? `required by ${d.dependencyOf}` : '', d.fileName].filter(Boolean).join(' · ');
    return h('tr', {
      class: 'row', tabindex: '0', dataset: { id: d.key, key: `${d.key}:row` }, 'aria-selected': 'false', title: d.installed ? '' : 'Double-click or press Enter to install',
      onclick: ev => {
        if (ev.target.closest('input,button')) return;
        clickSelect(state.dlSel, keys, d.key, ev, 'lastDlClick');
        paintDlSelection();
      },
      ondblclick: ev => { if (!ev.target.closest('input,button') && !d.installed && d.exists) run(api.install([d.key])); },
      onkeydown: ev => rowKeys(ev, state.dlSel, d.key, () => { if (!d.installed && d.exists) run(api.install([d.key])); }, paintDlSelection),
    },
    h('td', {}, h('input', {
      type: 'checkbox', 'aria-label': `Select ${d.name}`, tabindex: '-1',
      onchange: ev => { if (ev.target.checked) state.dlSel.add(d.key); else state.dlSel.delete(d.key); state.lastDlClick = d.key; paintDlSelection(); },
    })),
    h('td', { title: `${d.name}\n${d.fileName}` }, h('div', { class: 'cell-name' }, h('span', { class: 'name' }, d.name), h('span', { class: 'subname' }, sub))),
    h('td', { class: 'dim col-cat' }, CAT_LABEL[d.category] || d.category),
    h('td', { class: 'dim col-prio', title: d.version || '' }, d.version || '—'),
    h('td', { class: 'num dim' }, fmtSize(d.size)),
    h('td', { class: 'status-cell' }, status),
    h('td', { class: 'actions' }, !d.installed && d.exists
      ? h('button', { class: 'btn btn-sm', dataset: { key: `${d.key}:install` }, onclick: () => run(api.install([d.key])) }, icon('package'), h('span', {}, 'Install'))
      : null));
  })), null);

  const total = state.snap.downloads.length;
  const empty = $('#dl-empty');
  empty.hidden = rows.length > 0;
  $('#dl-card').classList.toggle('is-empty', rows.length === 0);
  empty.querySelector('.empty-title').textContent = total || state.jobs.size ? 'Nothing here' : 'No downloads yet';
  empty.querySelector('.empty-text').textContent = total || state.jobs.size
    ? 'Nothing matches this search or filter.'
    : 'Paste a mod link above and pick its files. Downloads show their progress here.';
  paintDlSelection();
  renderDlCounts();
  renderDlProgress();
  paintDlHead();
}

/** Under the title: what the downloads folder holds. */
function paintDlHead() {
  const list = state.snap.downloads.filter(d => d.exists !== false);
  $('#dl-sub').textContent = list.length
    ? `${plural(list.length, 'file')} · ${fmtSize(list.reduce((n, d) => n + (d.size || 0), 0))} in your downloads folder`
    : 'Paste a Nexus Mods link and pick its files';
}

function renderDlCounts() {
  const jobs = [...state.jobs.values()];
  const active = jobs.filter(j => ACTIVE.includes(j.status)).length;
  const failed = jobs.filter(j => ['error', 'cancelled'].includes(j.status)).length;
  $('#dl-failed-count').textContent = failed || '';
  $('#dl-clear').hidden = !jobs.some(j => ['done', 'cancelled', 'error'].includes(j.status));
  const nav = $('#nav-dl-count');
  nav.textContent = active ? `${active} active` : '';
  nav.classList.toggle('live', active > 0);
  nav.title = active ? `${active} downloading` : `${state.snap.downloads.length} downloaded`;
}

/** Live job updates touch only their own row; a finished job re-renders the list. */
function updateJobRow(j) {
  const row = $(`#dl-progress-list [data-job="${j.id}"]`);
  if (!row || !ACTIVE.includes(j.status) || !row.classList.contains(j.status)) { scheduleDlRender(); return; }
  paintProgressRow(row, j);
  paintNetwork();
}
const scheduleDlRender = (() => {
  let t = null;
  return () => { if (!t) t = setTimeout(() => { t = null; renderDownloads(); }, 150); };
})();


$('#dl-search').addEventListener('input', debounce(renderDownloads, 120));
$$('#dl-filter .seg-btn').forEach(b => b.addEventListener('click', () => {
  dl.filter = b.dataset.f;
  setSegActive('#dl-filter', 'f', dl.filter);
  renderDownloads();
}));
$('#dl-all').addEventListener('change', ev => {
  visibleDownloads().forEach(d => (ev.target.checked ? state.dlSel.add(d.key) : state.dlSel.delete(d.key)));
  paintDlSelection();
});
$('#dl-sel-clear').addEventListener('click', () => { state.dlSel.clear(); paintDlSelection(); });

// The links box grows with its content, up to its max-height.
const linksBox = $('#dl-links');
const growLinks = () => {
  linksBox.style.height = 'auto';
  linksBox.style.height = `${linksBox.scrollHeight + 2}px`;
  $('#dl-go').classList.toggle('is-idle', !linksBox.value.trim());
};
linksBox.addEventListener('input', growLinks);

$('#dl-go').addEventListener('click', async () => {
  const text = linksBox.value;
  const btn = $('#dl-go');
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Reading…';
  const hint = $('#dl-hint');
  hint.className = 'hint';
  hint.textContent = '';
  try {
    const r = await downloadLinks(text); // features.js: file picker, then requirements
    if (r) {
      const parts = [`${plural(r.queued, 'file')} queued from ${plural(r.mods, 'mod')}`];
      if (r.dependencies) parts.push(`${plural(r.dependencies, 'required mod')} added`);
      if (r.skipped) parts.push(`${r.skipped} already downloaded`);
      if (r.external.length) parts.push(`${r.external.length} requirement(s) not on Nexus — see Activity`);
      if (r.errors.length) parts.push(`${plural(r.errors.length, 'error')} — see Activity`);
      hint.className = r.errors.length ? 'hint bad' : 'hint ok';
      hint.textContent = parts.join(' · ');
      if (!r.errors.length) { linksBox.value = ''; growLinks(); }
      if (r.queued) { dl.filter = 'all'; setSegActive('#dl-filter', 'f', 'all'); renderDownloads(); }
    }
  } finally {
    btn.disabled = false;
    label.textContent = 'Download';
  }
});
linksBox.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('#dl-go').click(); }
});
$('#dl-clear').addEventListener('click', async () => {
  await run(api.clearJobs());
  for (const [id, j] of state.jobs) if (['done', 'cancelled', 'skipped', 'error'].includes(j.status)) state.jobs.delete(id);
  renderDownloads();
});
$('#dl-open-folder').addEventListener('click', () => run(api.openPath('downloads')));
$$('#dl-bulk [data-act]').forEach(b => b.addEventListener('click', async () => {
  const keys = [...state.dlSel];
  if (!keys.length) return;
  if (b.dataset.act === 'install') await run(api.install(keys));
  if (b.dataset.act === 'installEnable') await run(api.installAndEnable(keys));
  if (b.dataset.act === 'delete') {
    const installed = state.snap.downloads.filter(d => keys.includes(d.key) && d.installed).length;
    const extra = installed ? ` ${installed} of them are installed and will be uninstalled first.` : '';
    if (await confirmBox('Delete downloads', `Delete ${plural(keys.length, 'downloaded archive')}?${extra}`, 'Delete', true)) {
      await run(api.deleteDownloads(keys), 'Deleted');
      state.dlSel.clear();
      paintDlSelection();
    }
  }
}));

// ---------------------------------------------------------------- settings page

const form = {
  gamePath: '#s-game', deployMethod: '#s-deploy', concurrentDownloads: '#s-conc', autoInstall: '#s-auto',
  dataDir: '#s-data', sevenZipPath: '#s-7z', vortexExe: '#s-vx-exe',
  updateEvery: '#s-upd-every', updateUnit: '#s-upd-unit',
  aiProvider: '#s-ai-provider', aiEndpoint: '#s-ai-endpoint', aiModel: '#s-ai-model', aiReasoning: '#s-ai-reasoning', aiMaxSteps: '#s-ai-steps', aiTimeout: '#s-ai-timeout', aiContext: '#s-ai-context', playsKeep: '#s-plays-keep', uiScale: '#s-ui-scale', reqView: '#s-req-view', saveCooldown: '#s-save-cooldown', saveMaxPerProfile: '#s-save-max', groupsPort: '#s-groups-port', launchMode: '#s-launch', vortexAutoMove: '#s-vx-auto', updateMode: '#s-upd-mode', perfInterval: '#s-perf-interval', perfHistory: '#s-perf-history',
};
// ---------------------------------------------------------------- app updates

let upd = null;
let updTick = null;
function renderUpdate(st) {
  if (st) upd = st;
  if (!upd) return;
  const when = upd.lastCheck ? `last checked ${new Date(upd.lastCheck).toLocaleTimeString()}` : '';
  const line = {
    dev: `Version ${upd.current}. Updates are checked in the installed app only (this copy runs from its source folder).`,
    package: `Version ${upd.current}, installed from the .deb package. A new version comes as a new .deb on the download page (or use the AppImage, which updates itself).`,
    idle: upd.mode === 'off' ? `Version ${upd.current}. Automatic update checks are off.` : `Version ${upd.current}.`,
    checking: `Version ${upd.current} · checking…`,
    current: `Version ${upd.current} is the newest${when ? ` · ${when}` : ''}${upd.heldForGame ? ' · checks wait while the game runs' : ''}.`,
    downloading: `Downloading version ${upd.available}… ${upd.progress || 0}%`,
    ready: `Version ${upd.available} is downloaded and installs with a restart.`,
    error: `Version ${upd.current} · could not check for updates (${upd.error})${when ? ` · ${when}` : ''}.`,
  }[upd.status] || '';
  const el = $('#s-upd-state');
  el.textContent = line;
  el.className = `hint${upd.status === 'error' ? ' bad' : upd.status === 'ready' ? ' ok' : ''}`;
  $('#s-upd-check').disabled = ['dev', 'package', 'checking', 'downloading'].includes(upd.status);
  // Installed from the .deb: no checks of its own, so nothing to schedule.
  $('#s-upd-check').closest('.set-ctl').hidden = upd.status === 'package';
  $('#s-upd-mode').closest('.set-row').hidden = upd.status === 'package';
  $('#s-upd-launch-row').hidden = upd.status === 'package';
  updLaunchState();

  // The bar: from the moment a new version is found, until it installs.
  const bar = $('#update-bar');
  clearInterval(updTick);
  bar.hidden = !['downloading', 'ready'].includes(upd.status);
  if (bar.hidden) return;
  const WAIT = {
    game: 'It installs after you close the game.',
    busy: 'The app restarts to install it when downloads and installs finish.',
    ai: 'The app restarts to install it when the AI assistant has finished.',
    view: 'The app restarts to install it when you come back to it.',
  };
  const text = () => {
    const left = upd.restartAt ? Math.max(0, Math.ceil((upd.restartAt - Date.now()) / 1000)) : 0;
    $('#update-text').textContent = upd.status === 'downloading' ? `Version ${upd.available} found · downloading ${upd.progress || 0}%`
      : upd.postponed ? `Version ${upd.available} installs when you close the app.`
        : upd.mode === 'ask' ? `Version ${upd.available} is ready to install.`
          : upd.waiting ? `Version ${upd.available} is ready. ${WAIT[upd.waitingFor] || WAIT.busy}`
            : `Version ${upd.available} is ready. Restarting to install it in ${left} s.`;
  };
  text();
  const ready = upd.status === 'ready';
  $('#update-later').hidden = !ready || !!upd.postponed;
  $('#update-now').hidden = !ready;
  if (ready && upd.restartAt && !upd.postponed) updTick = setInterval(text, 1000);
}
api.onUpdate(renderUpdate);
// ---- the app's scale (Settings → Display)

/** What the scale is now: Windows' for this display, the one chosen, and what is shown. */
function showScale(s) {
  if (!s) return;
  const el = $('#s-ui-scale-now');
  if (!el) return;
  el.textContent = s.chosen
    ? `Shown at ${s.effective}% (Windows sets ${s.system}% for this display).${s.capped ? ` ${s.chosen}% does not fit this display: ${s.max}% is the most it can show.` : ''}`
    : `Shown at ${s.system}%, the scale Windows sets for this display.`;
  el.classList.toggle('warn-text', !!s.capped);
}
api.onScale(showScale);
api.getScale().then(r => showScale(r.ok));
// Ctrl + / Ctrl - changed it: the Display section shows the new value (other unsaved edits are kept).
api.onSettingsChanged(async () => {
  const r = await api.getSettings();
  if (!r.ok || !state.settings) return;
  state.settings.uiScale = r.ok.uiScale;
  $('#s-ui-scale').value = String(r.ok.uiScale || 0);
  // Changed in the AI chat's settings column (or a saved setup switched): the AI section follows.
  // (a field edited here and not saved yet is left as it is)
  const shown = v => String(v ?? '');
  for (const [k, sel] of Object.entries(form)) {
    if (!k.startsWith('ai')) continue;
    const el = $(sel);
    const was = k === 'aiContext' && !state.settings[k] ? '' : shown(state.settings[k]);
    const untouched = el.value === was && document.activeElement !== el;
    state.settings[k] = r.ok[k];
    if (untouched) { el.value = k === 'aiContext' && !r.ok[k] ? '' : shown(r.ok[k]); el.title = shown(r.ok[k]); }
  }
  Object.assign(state.settings, { hasAiKey: r.ok.hasAiKey, aiKeyHint: r.ok.aiKeyHint, aiPresets: r.ok.aiPresets });
  $('#s-ai-key').placeholder = r.ok.hasAiKey ? `Saved key ${r.ok.aiKeyHint} — paste a new one to replace it` : 'Paste your provider\'s API key (not needed for local models)';
  aiPlaceholders();
  updateDirty();
});

// The account type, checked when the app starts.
// Every account check (start, focus, every 30 minutes, downloads): the Premium tag and banners follow it.
api.onKeyUser(u => { state.keyUser = u; renderStatus(); renderDlProgress(); });
api.updateState().then(r => r.ok && renderUpdate(r.ok));
$('#update-later').addEventListener('click', () => run(api.postponeUpdate()));
$('#update-now').addEventListener('click', () => run(api.installUpdate()));
$('#s-upd-check').addEventListener('click', () => run(api.checkForUpdate()));

// ---------------------------------------------------------------- moving mods from Vortex

/** Take Vortex mods over (ids, or all of them): this app manages them from then on. */
async function moveFromVortex(ids = null) {
  const pv = await run(api.vortexAdoptPreview());
  if (!pv) return null;
  const count = ids ? ids.length : pv.mods;
  if (!count) { toast('There are no Vortex mods left to move'); return null; }
  const what = ids ? plural(ids.length, 'Vortex mod') : `all ${plural(pv.mods, 'Vortex mod')} (${pv.enabled} enabled, ${pv.files.toLocaleString()} files)`;
  const ok = await confirmBox('Move mods from Vortex', `${what[0].toUpperCase()}${what.slice(1)} will be managed by this app: same files in the game, same versions and on/off state, updated here from now on. Their files are linked, not copied, so this takes no extra disk space. In Vortex they stay installed but switched off, so you can go back by enabling them there.${pv.already ? ` ${plural(pv.already, 'mod')} you already have here will be matched up instead of added twice.` : ''}`, ids ? 'Move' : 'Move them all');
  if (!ok || !(await confirmVortexClose(pv.enabled))) return null;
  const r = await run(api.adoptVortex(ids || 'all'));
  if (r) toast(`Moved ${plural(r.adopted.length, 'mod')} from Vortex`, 'success', { label: 'Show', fn: () => goTo('mods') });
  // A few Vortex would not let go of (after three tries each): named, still with Vortex, safe to retry.
  if (r?.failed?.length) {
    await modal({
      title: `${plural(r.failed.length, 'mod')} stayed with Vortex`,
      sub: 'Vortex did not let go of them after three tries (it may have been busy, or Windows blocked it)',
      body: h('div', {}, h('ul', { class: 'warnlist' }, ...r.failed.slice(0, 200).map(n => h('li', {}, n))),
        h('p', { class: 'hint' }, 'Nothing about them changed: they are still in Vortex, as they were. Try moving them again in a moment (Settings → Vortex → Move), or close Vortex first if it is open.')),
      buttons: [{ label: 'OK', value: true, kind: 'btn-primary' }],
    });
  }
  if (ids && state.drawerMod && ids.includes(state.drawerMod)) closeDrawer();
  return r;
}
$('#s-vx-move').addEventListener('click', () => moveFromVortex());

/** Settings: the note at the top of the Vortex or MO2 section, when that one is on this PC. */
function paintManagersNote(sel, which) {
  const el = $(sel);
  const o = otherManagers();
  const sig = JSON.stringify(o);
  if (!el || el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.replaceChildren(...[o[which] ? managersNote() : null].filter(Boolean));
}

function renderVortexMove() {
  const vx = state.snap.vortex;
  paintManagersNote('#s-vx-note', 'vortex');
  // Windows: always there, so Vortex.exe can be chosen even when it was not found. Linux: Vortex is a Windows program.
  const win = api.platform === 'win32';
  $('#sec-vortex').hidden = !win && !vx?.installed;
  $('.set-nav-item[data-sec="vortex"]').hidden = !win && !vx?.installed;
  $('#s-vx-exe').closest('.set-row').hidden = !win;
  if (win) {
    $('#s-vx-exe').placeholder = vx?.exeSource === 'found' ? vx.exe : 'Not found: choose Vortex.exe if you use Vortex';
    $('#s-vx-exe-text').textContent = vx?.exeChosenMissing ? `The Vortex.exe chosen here is gone (moved or uninstalled), so it is not used${vx.exe ? `: using ${vx.exe} instead` : ''}. Choose it again, or empty the box and save to let the app find it.`
      : vx?.exeSource === 'manual' ? 'Vortex.exe, as chosen here. Empty the box and save to let the app find it by itself.'
      : vx?.exeSource === 'found' ? 'Vortex.exe, found by itself (shown in the box). Choose another one if that is not the Vortex you use.'
        : 'Vortex.exe was not found. If you use Vortex, choose its Vortex.exe (or Find, after installing it).';
  }
  $('#s-vx-mods-row').hidden = !vx?.installed;
  $('#s-vx-auto-row').hidden = !vx?.installed;
  if (!vx?.installed) return;
  const n = vx.mods?.length || 0;
  $('#s-vx-text').textContent = n
    ? `${plural(n, 'mod')} in Vortex (${vx.mods.filter(m => m.enabled).length} enabled)${vx.adopted ? ` · ${vx.adopted} moved here already` : ''}`
    : `All Vortex mods are managed here${vx.adopted ? ` (${vx.adopted} moved)` : ''}`;
  $('#s-vx-move').disabled = !n;
  // "Vortex mods: ask": once per start, when Vortex has mods this app has not taken over.
  if (state.settings?.vortexAutoMove === 'ask' && vx.pending && !vortexAsked && !document.documentElement.dataset.setup) {
    vortexAsked = true;
    askVortexAutoMove(vx);
  }
}

let vortexAsked = false;

/** Profiles and share codes cover this app's mods only: offer to take over Vortex's, now and from now on. */
async function askVortexAutoMove(vx) {
  const v = await modal({
    title: 'Move your Vortex mods into this app?',
    sub: `${plural(vx.pending, 'mod')} in Vortex`,
    body: h('div', {},
      h('p', {}, 'Profiles and share codes only cover mods this app manages. Moved here, your Vortex mods are in your profiles too, and updated here.'),
      h('ul', { class: 'plain-list' },
        h('li', {}, 'Vortex switches them off and keeps them: nothing is deleted there, and you can switch back.'),
        h('li', {}, 'Their files are linked from disk: no downloads, no extra space. Mods you already have here are matched, not added twice.'),
        h('li', {}, 'With "Always", mods you add in Vortex later move here too, whenever Vortex is closed.'))),
    buttons: [
      { label: 'Not now', value: false, safe: true },
      { label: 'Leave them in Vortex', value: 'off' },
      { label: 'Always move them here', value: 'on', kind: 'btn-primary' },
    ],
  });
  if (!v) return;
  const s = await run(api.setSettings({ vortexAutoMove: v }));
  if (s) state.settings = s;
  if ($('#s-vx-auto')) $('#s-vx-auto').value = v;
  toast(v === 'on' ? (vx.running ? 'Your Vortex mods move here as soon as Vortex is closed' : 'Moving your Vortex mods here…') : 'Vortex mods stay in Vortex (Settings → Vortex changes this)');
}

// ---------------------------------------------------------------- other mod managers

/** Which other mod managers are on this PC: { vortex, mo2, names: 'Vortex and Mod Organizer 2' }. */
function otherManagers(snap = state.snap) {
  const vortex = !!snap?.vortex?.installed;
  const mo2 = !!(snap?.mo2?.instances?.length || snap?.mo2?.programs?.length);
  const names = [vortex ? 'Vortex' : '', mo2 ? 'Mod Organizer 2' : ''].filter(Boolean).join(' and ');
  return { vortex, mo2, names };
}

/**
 * Why this app switches mods off in other mod managers, and what it never does. Shown when Vortex or
 * MO2 is found: in Settings, near the end of the welcome wizard, on an empty Mods page and on a
 * Profiles page with only Default. Null when neither is found.
 */
function managersNote(snap = state.snap, { compact = false } = {}) {
  const o = otherManagers(snap);
  if (!o.vortex && !o.mo2) return null;
  const parts = ['Mod managers that each have mods switched on usually don\u2019t work well together: both add files to the game, and the game ends up with a mix.'];
  if (o.vortex) parts.push('So when a mod is switched on here that Vortex also has on, this app switches Vortex\u2019s copy off, and mods moved from Vortex are switched off there. Vortex\u2019s mods and profiles are never deleted, only switched off: Vortex can switch them on again.');
  if (o.mo2) parts.push('Mod Organizer 2 is only read, never changed: its mods reach the game only when the game is started from MO2.');
  parts.push(`Using a profile from ${o.vortex && o.mo2 ? 'either' : o.vortex ? 'Vortex' : 'MO2'} here (Profiles page) brings its mods over, with the same ones switched on.`);
  return h('div', { class: `mgr-note${compact ? ' compact' : ''}`, role: 'note' },
    h('span', { class: 'mgr-note-icon', 'aria-hidden': 'true' }, icon('info')),
    h('div', { class: 'mgr-note-text' }, h('b', {}, `You also have ${o.names}`), h('span', {}, parts.join(' '))));
}

// ---------------------------------------------------------------- Mod Organizer 2 (read only)

/** Settings → Mod Organizer 2: the setups found, bringing their mods over, folders to look in. */
function renderMo2Settings() {
  const mo = state.snap.mo2;
  const block = $('#s-mo2-block');
  if (!mo || !block) return;
  paintManagersNote('#s-mo2-note', 'mo2');
  const sig = JSON.stringify(mo);
  if (sig === block.dataset.sig) return;
  block.dataset.sig = sig;
  const rows = mo.instances.map(i => {
    const all = !i.left;
    return h('div', { class: 'set-row' },
      h('div', { class: 'set-label' },
        h('span', { class: 'set-name' }, i.name, i.portable ? h('span', { class: 'tag tag-off' }, 'Portable') : null),
        h('p', { class: 'set-desc' }, `${plural(i.mods, 'mod')}${i.here ? `, ${i.here} in this app` : ''} · ${plural(i.profiles.length, 'profile')} · ${i.path}`),
        i.sameGame ? null : h('p', { class: 'set-desc mo2-other' }, `Set up for another copy of the game (${i.gamePath}). Its mods still work here.`)),
      h('div', { class: 'set-ctl set-ctl-auto' },
        h('button', {
          type: 'button', class: 'btn', disabled: all || !i.mods, dataset: { key: `mo2:${i.id}:bring` },
          title: 'Adds its mods to this app, switched off. MO2 keeps them as they are.', onclick: () => bringMo2Mods(i),
        }, icon('mo2'), h('span', {}, all && i.mods ? 'All its mods are here' : 'Bring its mods here'))));
  });
  if (!rows.length) {
    // MO2 is installed, but none of its setups is for Cyberpunk 2077 (yet).
    const at = (mo.programs || [])[0];
    rows.push(h('div', { class: 'set-row' }, h('div', { class: 'set-label' },
      h('span', { class: 'set-name' }, at ? 'Mod Organizer 2 has no Cyberpunk 2077 setup yet' : 'No Mod Organizer 2 setup for Cyberpunk 2077 found'),
      h('p', { class: 'set-desc' }, at
        ? `MO2 is installed in ${at}${mo.programs.length > 1 ? ` (and ${mo.programs.length - 1} other ${mo.programs.length === 2 ? 'folder' : 'folders'})` : ''}. Once you create an instance for Cyberpunk 2077 in MO2, it shows up here by itself.`
        : 'This app looks where MO2 keeps its setups, and in the usual MO2 folders. If yours is somewhere else, add its folder below.'))));
  }
  const folders = mo.folders || [];
  rows.push(h('div', { class: 'set-row' },
    h('div', { class: 'set-label' },
      h('span', { class: 'set-name' }, 'MO2 folders to look in'),
      h('p', { class: 'set-desc' }, 'A portable MO2 (its own folder), or an instance folder, anywhere this app did not find it.'),
      folders.length ? h('ul', { class: 'mo2-folders' }, ...folders.map(f => h('li', {},
        h('span', { class: 'mono', title: f }, f),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': `Stop looking in ${f}`, onclick: () => run(api.removeMo2Folder(f)) }, h('span', {}, 'Remove'))))) : null),
    h('div', { class: 'set-ctl set-ctl-auto' },
      h('button', { type: 'button', class: 'btn', dataset: { key: 'mo2:add' }, onclick: addMo2Folder }, icon('folder'), h('span', {}, 'Add a folder')))));
  rows.push(h('div', { class: 'set-row' }, h('div', { class: 'set-label' },
    h('span', { class: 'set-name' }, 'How it works with MO2'),
    h('p', { class: 'set-desc' }, "MO2 is only read, never changed. Its mods don't touch the game folder, so a game started from this app (or Steam) gets only this app's mods. Started from MO2, MO2 adds its own enabled mods on top."))));
  keepFocus(block, () => block.replaceChildren(...rows));
}

async function addMo2Folder() {
  const dir = await run(api.addMo2Folder());
  if (dir) toast(`Looking in ${dir} too`, 'success');
}

/** Every mod of an MO2 setup into this app: linked from MO2's folders, switched off here. */
async function bringMo2Mods(i) {
  const n = i.left;
  const ok = await confirmBox('Bring mods over from Mod Organizer 2',
    `${plural(n, 'mod')} from "${i.name}" will be added to this app, switched off, in MO2's order. Their files are linked from MO2's folders, not copied, so this takes no extra disk space, and MO2 itself is not changed. To play with an MO2 profile's mods, use "Use here" on the Profiles page.${i.here ? ` ${plural(i.here, 'mod')} already in this app are matched instead of added twice.` : ''}`,
    'Bring them here');
  if (!ok) return;
  const r = await run(api.adoptMo2(i.id));
  if (!r) return;
  const fresh = r.adopted.filter(a => !a.matched).length;
  const notes = [r.failed ? `${r.failed} could not be read` : '', r.skipped ? `${r.skipped} left in MO2` : ''].filter(Boolean).join(', ');
  toast(`Brought ${plural(fresh, 'mod')} over from MO2${notes ? ` (${notes}; details in Activity)` : ''}`, r.failed ? 'warn' : 'success', { label: 'Show', fn: () => goTo('mods') });
}

// The nxm switch is not here: it applies at once, see "Nexus download links" below.
// ---------------------------------------------------------------- Nexus download links (nxm://)

function showNxmState(st) {
  if (!st) return;
  $('#s-nxm').checked = st.on;
  const el = $('#s-nxm-state');
  el.className = `check-sub nxm-state ${st.on && !st.ours ? 'bad' : st.ours ? 'ok' : ''}`;
  el.textContent = st.ours ? `Now: these links open ${appName()}.`
    : st.on ? `Now: ${st.handler || 'nothing'} has these links (it took them back). Turn this off and on again to take them over.`
      : `Now: ${st.handler ? `these links open ${st.handler}` : 'no program handles these links'}.`;
}
async function refreshNxm() { showNxmState(await run(api.nxmStatus())); }

$('#s-nxm').addEventListener('change', async ev => {
  const on = ev.target.checked;
  ev.target.checked = !on; // stays as it was until the change is done
  const st = await run(api.nxmStatus());
  if (!st) return;
  if (on) {
    const ok = await confirmBox('Handle Nexus downloads here?', `"Mod Manager Download" buttons on nexusmods.com will open ${appName()} and download here${st.handler && !/Mod Manager$/.test(st.handler) || st.handler === 'Vortex' ? `, instead of ${st.handler}` : ''}. The current setting is saved, and turning this off puts it back. The first time, your browser asks whether to open Cyber Mod Manager: allow it.${st.handler === 'Vortex' ? ' Vortex takes these links back when it starts, unless "Handle Nexus links" is off in Vortex\'s settings.' : ''}`, 'Handle them here');
    if (!ok) return;
  }
  const res = await run(api.setNxm(on));
  if (!res) { refreshNxm(); return; }
  showNxmState(res);
  if (on && !res.ours) {
    modal({ title: 'Windows did not switch', body: h('p', {}, `Nexus links still open ${res.handler || 'nothing'}. Try again, or check Windows Settings → Apps → Default apps → "Choose defaults by link type" → NXM.`), buttons: [{ label: 'OK', value: true, kind: 'btn-primary' }] });
  } else if (on) {
    modal({ title: 'Nexus downloads come here now', body: h('p', {}, 'Click "Mod Manager Download" on any mod\'s Files tab to try it. Your browser asks once whether to open Cyber Mod Manager.'), buttons: [{ label: 'OK', value: true, kind: 'btn-primary' }] });
  } else {
    toast(res.handler ? `Nexus links open ${res.handler} again` : 'Nexus links are no longer handled by this app', 'success');
  }
});

/** Update when the app opens: only with "Install automatically" (the other choices ask first, or never check). */
function updLaunchState() {
  const auto = $('#s-upd-mode').value === 'auto';
  $('#s-upd-launch').disabled = !auto;
  $('#s-upd-launch-row').classList.toggle('set-locked', !auto);
  $('#s-upd-launch-desc').textContent = auto
    ? 'Before the window opens, a small one checks for a new version and installs it first, so you always start on the newest. "Open now" skips the wait.'
    : 'Only when new versions install automatically (above).';
}
$('#s-upd-mode').addEventListener('change', updLaunchState);
const checks = { autoEnable: '#s-autoenable', installDependencies: '#s-deps', blockAds: '#s-adblock', saveAutoBackup: '#s-save-auto', savePauseUnchanged: '#s-save-pause', updateOnLaunch: '#s-upd-launch', perfGraphs: '#s-perf-graphs', groupsUpnp: '#s-groups-upnp' };

const AI_EXAMPLES = {
  openai: { endpoint: 'https://api.openai.com/v1 (or http://localhost:11434/v1 for Ollama)', model: 'e.g. gpt-5.1, or the model your endpoint serves' },
  anthropic: { endpoint: 'https://api.anthropic.com', model: 'e.g. claude-sonnet-5-5' },
};
function aiPlaceholders() {
  const ex = AI_EXAMPLES[$('#s-ai-provider').value] || AI_EXAMPLES.openai;
  $('#s-ai-endpoint').placeholder = ex.endpoint;
  $('#s-ai-model').placeholder = ex.model;
  // Anthropic's thinking works differently (a token budget): the setting is for OpenAI-compatible models.
  $('#s-ai-reasoning').closest('.set-row').hidden = $('#s-ai-provider').value === 'anthropic';
}
$('#s-ai-provider').addEventListener('change', aiPlaceholders);
$('#s-ai-test').addEventListener('click', async () => {
  const st = $('#s-ai-status');
  if (isDirty() && !(await run(api.setSettings(readForm())))) return;
  st.className = 'hint';
  st.textContent = 'Asking the model to reply…';
  const r = await api.aiTest();
  st.className = r.error ? 'hint bad' : 'hint ok';
  st.textContent = r.error ? r.error : `Connected: ${r.ok}`;
  if (plainHttpRemote($('#s-ai-endpoint').value)) st.textContent += ' Note: this address is plain http, so your key travels unencrypted. Use https:// unless the server is on your own network.';
  await loadSettings();
});

/** An endpoint on plain http that is not this PC or the home network: a key sent there is readable on the way. */
function plainHttpRemote(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return false; }
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fe80:)/i.test(h) || (!h.includes('.') && !h.includes(':')) || /\.(local|lan|home)$/i.test(h);
  return !local;
}

function readForm() {
  const patch = {};
  for (const [k, sel] of Object.entries(form)) patch[k] = $(sel).value;
  patch.aiContext = Number(patch.aiContext) || 0; // empty: automatic
  patch.uiScale = Number(patch.uiScale) || 0; // 0: follow Windows
  for (const [k, sel] of Object.entries(checks)) patch[k] = $(sel).checked;
  patch.categories = $$('#s-cats input').filter(i => i.checked).map(i => i.value);
  const key = $('#s-apikey').value.trim();
  if (key) patch.apiKey = key;
  const aiKey = $('#s-ai-key').value.trim();
  if (aiKey) patch.aiKey = aiKey;
  return patch;
}

function isDirty() {
  const s = state.settings;
  if (!s) return false;
  const p = readForm();
  if (p.apiKey || p.aiKey) return true;
  for (const k of Object.keys(form)) if (String(p[k]) !== String(s[k] ?? '')) return true;
  for (const k of Object.keys(checks)) if (p[k] !== !!s[k]) return true;
  return [...p.categories].sort().join() !== [...s.categories].sort().join();
}

function updateDirty() {
  const dirty = isDirty();
  $('#s-save').disabled = !dirty;
  $('#s-revert').disabled = !dirty;
  const st = $('#save-state');
  st.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
  st.classList.toggle('dirty', dirty);
}

async function loadSettings() {
  const s = await run(api.getSettings());
  if (!s) return;
  state.settings = s;
  $('#s-apikey').value = '';
  $('#s-apikey').placeholder = s.hasApiKey ? `Saved key ${s.apiKeyHint} — paste a new one to replace it` : 'Paste your personal API key';
  $('#s-ai-key').value = '';
  $('#s-ai-key').placeholder = s.hasAiKey ? `Saved key ${s.aiKeyHint} — paste a new one to replace it` : 'Paste your provider\'s API key (not needed for local models)';
  for (const [k, sel] of Object.entries(form)) { $(sel).value = s[k] ?? ''; $(sel).title = String(s[k] ?? ''); }
  aiPlaceholders(); // (after the provider is filled in: it shows or hides the reasoning setting)
  if (!s.aiContext) { $('#s-ai-context').value = ''; $('#s-ai-context').title = ''; } // 0: automatic
  for (const [k, sel] of Object.entries(checks)) $(sel).checked = !!s[k];
  refreshNxm();
  refreshSteamHint();
  $$('#s-cats input').forEach(i => { i.checked = s.categories.includes(i.value); });
  renderStatus();
  renderInstalls();
  updateDirty();
  if (state.snap?.mods) renderMods(); // requirements open or collapsed
  $('#s-save-perprofile').checked = !!s.perProfileSaves;
  updLaunchState();
  $('#s-save-dir').textContent = s.saveBackupDir || 'Saved Games\\Edgerunners Mod Manager\\Save backups (default)';
}
$('#s-save-open').addEventListener('click', () => run(api.openSaves('backups')));
$('#s-save-choose').addEventListener('click', async () => { const d = await run(api.chooseSaveBackupDir()); if (d) { $('#s-save-dir').textContent = d; toast('New backups go there; earlier ones stay where they are', 'success'); } });

$('#settings-form').addEventListener('input', updateDirty);
$('#settings-form').addEventListener('change', updateDirty);
$('#settings-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const s = await run(api.setSettings(readForm()), 'Settings saved');
  if (s) await loadSettings();
});
$('#s-revert').addEventListener('click', loadSettings);
$('#s-validate').addEventListener('click', async () => {
  const status = $('#s-key-status');
  if ($('#s-apikey').value.trim()) await run(api.setSettings({ apiKey: $('#s-apikey').value.trim() }));
  status.className = 'hint';
  status.textContent = 'Checking…';
  const r = await api.validateKey();
  if (r.error) {
    status.className = 'hint bad';
    status.textContent = r.error;
  } else {
    status.className = r.ok.isPremium ? 'hint ok' : 'hint bad';
    status.textContent = `Signed in as ${r.ok.name} — ${r.ok.isPremium ? 'Premium: direct downloads' : 'free account: one click on "Slow download" per file, then the download continues here'}`;
    state.keyUser = r.ok;
  }
  // The key is saved; other edits not saved yet stay in the form.
  $('#s-apikey').value = '';
  if (!isDirty()) await loadSettings(); else updateDirty();
});
$('#s-game-browse').addEventListener('click', async () => {
  const p = await run(api.pickFolder('Select the Cyberpunk 2077 folder'));
  if (p) { $('#s-game').value = p; updateDirty(); }
});
$('#s-game-detect').addEventListener('click', async () => {
  const s = await run(api.detectGame());
  if (s) await loadSettings();
  refreshInstalls();
});
$('#s-data-browse').addEventListener('click', async () => {
  const p = await run(api.pickFolder('Select a data folder'));
  if (p) { $('#s-data').value = p; updateDirty(); }
});
$('#s-vx-exe-browse').addEventListener('click', async () => {
  const p = await run(api.pickFile('Select Vortex.exe', [{ name: 'Vortex', extensions: ['exe'] }]));
  if (p && p[0]) { $('#s-vx-exe').value = p[0]; updateDirty(); }
});
$('#s-vx-exe-find').addEventListener('click', async ev => {
  const b = ev.currentTarget;
  b.disabled = true;
  const r = await run(api.findVortex());
  b.disabled = false;
  if (!r) return;
  if (r.source === 'manual') toast(`Using the Vortex.exe chosen here: ${r.exe}`);
  else toast(r.exe ? `Found Vortex: ${r.exe}` : 'Vortex.exe was not found. Choose it with Change.', r.exe ? 'success' : 'warn');
});
$('#s-7z-browse').addEventListener('click', async () => {
  // Linux: 7-Zip's 7zz (or p7zip's 7z) has no extension to filter by.
  const p = await run(api.platform === 'win32' ? api.pickFile('Select 7z.exe', [{ name: '7-Zip', extensions: ['exe'] }]) : api.pickFile('Select the 7zz (or 7z) program', []));
  if (p && p[0]) { $('#s-7z').value = p[0]; updateDirty(); }
});
if (api.platform !== 'win32') $('#s-7z').closest('.set-row').querySelector('.set-desc').textContent = '7zz (or 7z), used for .zip, .7z and .rar archives. Found by itself when it is installed; .rar needs 7-Zip\'s own 7zz or the p7zip-rar package.';
$$('[data-open]').forEach(b => b.addEventListener('click', () => run(api.openPath(b.dataset.open))));

function renderStatus() {
  const g = state.snap.game || {};
  $('#st-game-dot').className = `dot ${g.valid ? 'ok' : 'bad'}`;
  $('#st-game').textContent = g.valid ? 'Game' : 'No game';
  $('#st-game-row').title = g.valid ? `Game folder: ${g.path}` : 'Set the Cyberpunk 2077 folder in Settings';
  const s = state.settings;
  const hasKey = s?.hasApiKey;
  const user = state.keyUser;
  $('#st-key').textContent = user ? user.name : hasKey ? 'API key saved' : 'No API key';
  $('#st-premium').hidden = !user?.isPremium;
  $('#st-avatar').textContent = user ? (String(user.name).trim()[0] || '?').toUpperCase() : '?';
  $('#st-avatar').classList.toggle('bad', !hasKey);
  const vx = state.snap.vortex;
  $('#st-vx-row').hidden = !vx?.installed;
  const vxState = vx?.installed ? `Vortex ${vx.busy ? 'applying…' : vx.running ? 'open' : 'closed'}` : '';
  if (vx?.installed) {
    $('#st-vx-dot').className = `dot ${vx.running || vx.busy ? 'warn' : ''}`;
    $('#st-vx-row').title = `${vxState} · profile ${vx.activeProfileName || '—'} · ${plural(vx.mods.length, 'mod')}`;
  }
  // One short line under the name: the full counts are in its tooltip.
  const r = state.snap.rate || {};
  const rateFull = r.hourly != null ? `Nexus API: ${r.hourly} requests left this hour, ${r.daily} today` : '';
  const short = n => (n >= 10000 ? `${Math.floor(n / 1000)}k` : n >= 1000 ? `${(Math.floor(n / 100) / 10).toFixed(1)}k` : String(n));
  $('#st-rate').textContent = r.daily != null ? `${short(r.daily)} left` : '';
  $('#st-rate').title = rateFull;
  // The collapsed rail shows only the avatar: everything above is its tooltip.
  $('#side-foot').title = [user ? `${user.name}${user.isPremium ? ' · Premium' : ''}` : hasKey ? 'Nexus API key saved' : 'No Nexus API key',
    g.valid ? 'Game folder found' : 'Game folder not set', vxState, rateFull].filter(Boolean).join('\n');
  renderProfileSwitch();
  const gs = $('#s-game-status');
  gs.className = g.valid ? 'hint ok' : 'hint bad';
  gs.textContent = g.valid ? 'Cyberpunk2077.exe found' : 'bin\\x64\\Cyberpunk2077.exe was not found in this folder';
  // Downloads can't work without a key: say so before the user tries.
  const banner = $('#dl-keybanner');
  banner.hidden = !s || (hasKey && (!state.keyUser || state.keyUser.isPremium));
  banner.classList.toggle('banner-info', !!hasKey);
  banner.classList.toggle('banner-warn', !hasKey);
  $('#dl-keybanner-text').textContent = hasKey
    ? 'Free Nexus account: each file downloads after one click on "Slow download" on Nexus. The app opens each file\'s page in Browse in turn; the download continues here.'
    : 'Add your Nexus Mods API key in Settings before downloading.';
  $('#dl-keybanner [data-goto]').hidden = !!hasKey;
}

// ---------------------------------------------------------------- profile quick switcher

/** Under Play: the active profile; it opens a list of the others, to switch in one click. */
function renderProfileSwitch() {
  const p = state.snap.profiles;
  const active = p?.list.find(x => x.id === p.active);
  $('#prof-switch-name').textContent = active?.name || 'Default';
  $('#prof-switch').title = active ? `Profile: ${active.name} (${plural(active.count ?? 0, 'mod')} on). Click to switch.` : 'Switch profile';
  if (!$('#prof-menu').hidden && !$('#prof-menu').contains(document.activeElement)) paintProfileMenu();
}

function paintProfileMenu() {
  const p = state.snap.profiles;
  const list = p?.list || [];
  const total = (state.snap.mods || []).length;
  $('#prof-menu').replaceChildren(
    h('div', { class: 'menu-head' }, 'Switch profile'),
    ...list.map(x => {
      const on = x.id === p.active;
      return h('button', {
        class: `menu-item prof-menu-item${on ? ' on' : ''}`, role: 'menuitemradio', 'aria-checked': String(on), dataset: { id: x.id },
        onclick: async () => {
          closeProfileMenu(true);
          if (!on) await switchTo(x);
        },
      }, h('span', { class: 'prof-menu-check' }, on ? icon('check') : null),
      h('span', { class: 'menu-label' }, x.name),
      h('span', { class: 'menu-meta' }, `${x.count ?? 0}/${total}`));
    }),
    h('div', { class: 'menu-sep', role: 'separator' }),
    h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { closeProfileMenu(); goTo('profiles'); } }, icon('users'), h('span', { class: 'menu-label' }, 'Manage profiles…')));
}

function openProfileMenu() {
  const menu = $('#prof-menu');
  const btn = $('#prof-switch');
  paintProfileMenu();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  // A dropdown: right under the field, as wide as it, drawn over what is below (nothing moves).
  // It opens upward only when the window is too short below.
  const r = btn.getBoundingClientRect();
  menu.style.width = `${Math.round(r.width)}px`;
  const hgt = menu.offsetHeight;
  const below = r.bottom + 4;
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.top = `${Math.round(below + hgt > innerHeight - 8 && r.top - hgt - 4 > 8 ? r.top - hgt - 4 : below)}px`;
  (menu.querySelector('.menu-item.on') || menu.querySelector('.menu-item'))?.focus();
}

function closeProfileMenu(refocus = false) {
  if ($('#prof-menu').hidden) return;
  $('#prof-menu').hidden = true;
  $('#prof-switch').setAttribute('aria-expanded', 'false');
  if (refocus) $('#prof-switch').focus();
}
$('#prof-switch').addEventListener('click', () => ($('#prof-menu').hidden ? openProfileMenu() : closeProfileMenu()));
$('#prof-menu').addEventListener('keydown', ev => {
  const list = [...$('#prof-menu').querySelectorAll('.menu-item')];
  const i = list.indexOf(document.activeElement);
  if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeProfileMenu(true); }
  if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length]?.focus(); }
  if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
  if (ev.key === 'Tab') closeProfileMenu();
});
document.addEventListener('mousedown', ev => { if (!ev.target.closest('#prof-menu, #prof-switch')) closeProfileMenu(); });
window.addEventListener('resize', () => closeProfileMenu());

// ---------------------------------------------------------------- "More" menu

/** A small menu button: click or Enter opens it, arrows move, Esc or a click outside closes it. */
function menuButton(btnSel, menuSel) {
  const btn = $(btnSel);
  const menu = $(menuSel);
  const items = () => [...menu.querySelectorAll('.menu-item:not([hidden]):not(:disabled)')];
  const close = (refocus = false) => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  };
  const open = () => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  };
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('click', ev => { if (ev.target.closest('.menu-item')) close(); });
  menu.addEventListener('keydown', ev => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(true); }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    if (ev.key === 'Tab') close();
  });
  document.addEventListener('mousedown', ev => { if (!menu.hidden && !ev.target.closest('.menu-wrap')) close(); });
}
menuButton('#mods-more', '#mods-more-menu');
/**
 * The ⋯ button beside the Mods filters: updates and REDmod deploys live in its menu, so it carries a
 * count while updates wait (a plain dot when only REDmods need a deploy), and they are never hidden.
 */
function paintMoreDot() {
  const dot = $('#mods-more-dot');
  const n = moreAttention.updates;
  dot.hidden = !n && !moreAttention.redmod;
  dot.textContent = n ? String(n > 99 ? '99+' : n) : '';
  dot.classList.toggle('plain', !n);
  const why = [n ? plural(n, 'update') + ' available' : '', moreAttention.redmod ? 'REDmods need a deploy' : ''].filter(Boolean).join(', ');
  $('#mods-more').setAttribute('aria-label', why ? `More actions (${why})` : 'More actions');
  $('#mods-more').title = why ? `More actions: ${why}` : 'More actions';
}
$('#mods-open-vortex').addEventListener('click', () => run(api.openVortex()));

// ---------------------------------------------------------------- Play

let installs = [];
async function refreshInstalls() {
  installs = (await run(api.gameInstalls())) || [];
  renderInstalls();
  renderPlay();
}

/**
 * What Play is doing until the game shows up (applying mod changes, deploying REDmods, backing up
 * saves, starting it, waiting for it): shown on the button. '' when nothing is under way.
 */
let playStage = '';
let playStageTimer = 0;
function setPlayStage(text, forMs = 0) {
  playStage = text;
  clearTimeout(playStageTimer);
  // Each stage ends by itself at the latest after forMs (the game may never show up: closed at once, a Steam prompt…).
  if (text && forMs) playStageTimer = setTimeout(() => setPlayStage(''), forMs);
  renderPlay();
}

function renderPlay() {
  const g = state.snap.game || {};
  const here = installs.find(i => i.path.toLowerCase() === String(g.path || '').toLowerCase());
  const running = !!state.gameRunning;
  const btn = $('#play-btn');
  if (running && playStage) { playStage = ''; clearTimeout(playStageTimer); }
  if (!running) stopArmed = false;
  btn.disabled = !g.valid || !!playStage;
  btn.classList.toggle('staging', !!playStage);
  btn.classList.toggle('running', running);
  btn.classList.toggle('armed', running && stopArmed);
  btn.querySelector('use').setAttribute('href', running ? '#i-stop' : '#i-play');
  $('#play-label').textContent = running ? (stopArmed ? 'Close the game?' : 'Running') : playStage || 'Play';
  $('#play-sub').textContent = !g.valid ? 'No game folder' : running ? (stopArmed ? 'Click again' : 'Stop') : playStage ? '' : here?.label || '';
  $('#brand-sub').textContent = here ? `Cyberpunk 2077 · ${here.label}` : 'Cyberpunk 2077';
  btn.title = !g.valid ? 'Set the Cyberpunk 2077 folder in Settings' : running ? (stopArmed ? 'Click again to close the game: unsaved progress is lost' : 'Cyberpunk 2077 is running. Click twice to close it.') : playStage || `Launch Cyberpunk 2077${here ? ` through ${here.label}` : ''}`;
}
// Stop asks twice: the first click arms it for a few seconds, the second closes the game.
let stopArmed = false;
let stopTimer = 0;
/**
 * Linux: the Windows components the mod loaders need in the game's Proton folder, and the command
 * that puts them there. Resolves 'again', 'anyway' (also: not asked again for this folder) or false.
 */
function prereqsBox({ missing, loaders, command, installed }) {
  const copy = h('button', { class: 'btn btn-sm', onclick: async () => { try { await navigator.clipboard.writeText(command); copy.lastChild.textContent = 'Copied'; } catch { toast('Could not copy: select the line and copy it by hand', 'warn'); } } }, icon('copy'), h('span', {}, 'Copy'));
  return modal({
    title: 'Install what the mod loaders need',
    sub: `${loaders.join(' and ')} under Proton`,
    body: h('div', { class: 'steam-opts' },
      h('p', {}, `${loaders.join(' and ')} may need ${missing.join(' and ')} in the game's Proton folder, and protontricks has not put ${missing.length === 1 ? 'it' : 'them'} there. Without ${missing.length === 1 ? 'it' : 'them'} the mod loaders may not start.`),
      installed ? null : h('p', {}, 'First install protontricks (your software centre has it, or Flathub).'),
      h('p', {}, 'Run this in a terminal, once:'),
      h('div', { class: 'steam-opts-line' }, h('code', {}, command), copy),
      h('p', { class: 'hint' }, 'Then press Check again. If vcrun2022 fails to install, add --force before it. Already there another way (your Proton build has it)? Start anyway: this is not asked again.')),
    buttons: [
      { label: 'Cancel', value: false, safe: true },
      { label: 'Start anyway', value: 'anyway' },
      { label: 'Check again', value: 'again', kind: 'btn-primary' },
    ],
  });
}

/**
 * Play through Steam needs the game's Steam launch options to skip the launcher and load REDmods
 * (Steam asks to confirm arguments another program passes, so they cannot come from here).
 * Resolves 'again' (check again), 'anyway' (start as they are) or false.
 */
function steamOptionsBox({ current, missing, suggested, note = '' }) {
  const copy = h('button', { class: 'btn btn-sm', onclick: async () => { try { await navigator.clipboard.writeText(suggested); copy.lastChild.textContent = 'Copied'; } catch { toast('Could not copy: select the line and copy it by hand', 'warn'); } } }, icon('copy'), h('span', {}, 'Copy'));
  return modal({
    title: 'Set the Steam launch options once',
    sub: 'So Steam starts Cyberpunk 2077 modded, without its launcher',
    body: h('div', { class: 'steam-opts' },
      h('p', {}, `Steam starts the game with the launch options in its own settings. Yours are missing ${missing.join(' and ')}${note ? `. ${note}` : `: without them the CD Projekt launcher opens${missing.includes('-modded') ? ' and REDmods do not load' : ''}.`}`),
      h('ol', {},
        h('li', {}, 'In Steam, right-click Cyberpunk 2077 → Properties → General.'),
        h('li', {}, 'Replace what is under Launch Options with:'),
      ),
      h('div', { class: 'steam-opts-line' }, h('code', {}, suggested.split(' ').flatMap((o, i) => [i ? ' ' : null, h('span', {}, o)])), copy),
      current ? h('p', { class: 'hint' }, `Now: ${current}`) : null,
      h('p', { class: 'hint' }, 'Then press Check again. You only do this once.')),
    buttons: [
      { label: 'Cancel', value: false, safe: true },
      { label: 'Open in Steam', value: 'open' },
      { label: 'Start anyway', value: 'anyway' },
      { label: 'Check again', value: 'again', kind: 'btn-primary' },
    ],
  }).then(v => (v === 'open' ? api.openSteamGame().then(() => steamOptionsBox({ current, missing, suggested, note })) : v));
}

/** Under "When you press Play": whether Steam's launch options are ready for Play through Steam. */
async function refreshSteamHint() {
  const el = $('#s-launch-steam');
  if ($('#s-launch').value !== 'steam') { el.hidden = true; return; }
  const r = (await api.steamLaunchOptions())?.ok;
  el.hidden = false;
  el.className = `hint ${r && !r.missing.length ? 'ok' : ''}`;
  el.textContent = !r ? 'Steam\'s settings for the game were not found; this works for Steam copies only.'
    : r.missing.length ? `Add ${r.missing.join(api.platform === 'win32' ? ' ' : ', ')} to the game's launch options in Steam (Properties → General). Play shows how.`
      : `Steam's launch options are ready: ${r.options}`;
}
$('#s-launch').addEventListener('change', refreshSteamHint);
if (api.platform !== 'win32') {
  // Linux: the game always starts through Steam (Proton): nothing to choose here.
  $('#s-launch').closest('.set-ctl').hidden = true;
  $('#s-launch').closest('.set-row').querySelector('.set-desc').textContent = 'On Linux the game starts through Steam (Proton). REDmod deploy runs in the game\'s Proton folder, through protontricks.';
}

/*
 * Linux: the game closed or crashed right after starting, with RED4ext installed: under Proton that
 * is often the time-zone crash (the script compiler aborts when Wine cannot match the time zone).
 * TZ=UTC in the game's Steam launch options fixes it.
 */
api.onTzHint(({ current, suggested }) => {
  const copy = h('button', {
    class: 'btn btn-sm',
    onclick: async () => {
      try { await navigator.clipboard.writeText(suggested); copy.lastChild.textContent = 'Copied'; } catch { toast('Could not copy: select the line and copy it by hand', 'warn'); }
    },
  }, icon('copy'), h('span', {}, 'Copy'));
  const show = () => modal({
    title: 'Cyberpunk 2077 closed right after starting',
    sub: 'A known problem under Proton, with a one-line fix',
    body: h('div', { class: 'steam-opts' },
      h('p', {}, 'With RED4ext installed, the game\'s script compiler crashes at start when Wine cannot match your computer\'s time zone (an open RED4ext and redscript issue). Giving the game a time zone it knows fixes it.'),
      h('ol', {},
        h('li', {}, 'In Steam, right-click Cyberpunk 2077 → Properties → General.'),
        h('li', {}, 'Replace what is under Launch Options with:'),
      ),
      h('div', { class: 'steam-opts-line' }, h('code', {}, suggested.split(' ').flatMap((o, i) => [i ? ' ' : null, h('span', {}, o)])), copy),
      current ? h('p', { class: 'hint' }, `Now: ${current}`) : null,
      h('p', { class: 'hint' }, 'The game\'s clock then shows UTC. A city with your offset that Wine knows works too (TZ=America/Los_Angeles, say).')),
    buttons: [
      { label: 'Don\'t suggest again', value: 'off' },
      { label: 'Open in Steam', value: 'open' },
      { label: 'Close', value: false, kind: 'btn-primary', safe: true },
    ],
  }).then(async v => {
    if (v === 'off') await run(api.setSettings({ tzHintOff: true }));
    if (v === 'open') { await run(api.openSteamGame()); show(); }
  });
  show();
});

$('#play-btn').addEventListener('click', async () => {
  const btn = $('#play-btn');
  if (state.gameRunning) {
    if (!stopArmed) {
      stopArmed = true;
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => { stopArmed = false; renderPlay(); }, 4000);
      renderPlay();
      return;
    }
    clearTimeout(stopTimer);
    stopArmed = false;
    btn.disabled = true;
    $('#play-label').textContent = 'Closing…';
    if (await run(api.stopGame())) toast('Cyberpunk 2077 was closed', 'success');
    setTimeout(renderPlay, 1500);
    return;
  }
  setPlayStage('Getting ready…', 120000);
  let r = await run(api.launchGame());
  // A question comes first (REDmods, Steam's launch options…): Play waits on the player, not busy.
  if (r?.deployFailed || r?.steamOptions || r?.prereqs) setPlayStage('');
  const skip = { skipDeploy: true };
  // REDmod deploy (first, before the other checks) did not happen: say why, and let the player decide.
  if (r?.deployFailed) {
    let go;
    if (r.missingTools) {
      // No REDmod tools: say how to get them, once per session; after that Play just starts the game.
      const pick = redmodToolsAsked ? 'launch' : await redmodToolsBox(true);
      redmodToolsAsked = true;
      if (pick === 'get') await run(api.getRedmodTools());
      go = pick === 'launch';
    } else if (r.cannotRun) {
      // Linux: no protontricks, or not a Steam copy (asked once per run of the app).
      go = await confirmBox('Your REDmods cannot be deployed here yet', r.reason, 'Start without them');
    } else {
      go = await confirmBox('REDmod deploy failed', `Your REDmods may not load (the game uses what was last deployed successfully).\n\n${r.reason}\n\nThe full output is in Game log → Manager.`, 'Launch anyway');
    }
    if (go) setPlayStage('Getting ready…', 120000);
    r = go ? await run(api.launchGame(skip)) : null;
    if (r?.steamOptions || r?.prereqs) setPlayStage('');
  }
  // Through Steam: Steam's launch options for the game must skip the launcher and load REDmods;
  // on Linux also what the mod loaders need in the Proton folder. "Start anyway" holds for the rest.
  while (r?.steamOptions || r?.prereqs) {
    const go = r.steamOptions ? await steamOptionsBox(r.steamOptions) : await prereqsBox(r.prereqs);
    if (go === 'anyway') skip[r.steamOptions ? 'skipSteamCheck' : 'skipPrereqs'] = true;
    if (go) setPlayStage('Getting ready…', 120000);
    r = go ? await run(api.launchGame(skip)) : null;
    if (r?.steamOptions || r?.prereqs) setPlayStage('');
  }
  if (r && !r.deployFailed) {
    toast(`Starting Cyberpunk 2077 through ${r.via}`, 'success');
    // Until the game shows up (the game check sees it within seconds), or 90 s at most.
    if (!state.gameRunning) setPlayStage('Waiting for the game…', 90000);
  } else setPlayStage('');
});
// Each step of Play (from the main process) shows on the button until the game is up.
api.onPlayStage(e => { if (typeof e?.text === 'string') setPlayStage(e.text.slice(0, 60), 120000); });
// REDmod deploy runs before the game when REDmods changed: the Play button shows it.
api.onRedmod(e => {
  if (e.stage === 'deploying') {
    // During Play the stage keeps going (120 s each line at most); a deploy started from the Mods page shows too.
    setPlayStage('Deploying REDmods…', 120000);
    if (e.line) $('#play-btn').title = e.line.slice(0, 200);
  } else if (e.stage === 'done') {
    toast('REDmods deployed', 'success');
    if (playStage === 'Deploying REDmods…') setPlayStage('');
    refreshRedmod(e.status);
  } else if (e.stage === 'failed') {
    if (playStage === 'Deploying REDmods…') setPlayStage('');
    refreshRedmod(e.status);
  }
  if (e.stage === 'deploying') refreshRedmod({ ...(e.status || {}), count: 1, running: true });
});
/**
 * The REDmod tools are missing: what they are, and how to get them for this store (Steam, GOG,
 * Epic…). Resolves 'get' (open the store), 'launch' (start without them, when asked from Play) or false.
 */
let redmodToolsAsked = false;
async function redmodToolsBox(fromPlay) {
  const help = (await api.redmodHelp()).ok || { steps: [], button: 'Get REDmod' };
  const v = await modal({
    title: 'Install the free REDmod tools',
    sub: help.label ? `Your game is the ${help.label} version` : '',
    body: h('div', { class: 'redmod-help' },
      h('p', {}, 'Some of your mods are REDmods. They need CD Projekt\'s free REDmod tools to be deployed (by this app or any other), and this copy of the game does not have them yet.'),
      h('ol', {}, help.steps.map(s => h('li', {}, s))),
      h('p', { class: 'hint' }, fromPlay ? 'Until then the game starts without your REDmods; your other mods work as usual. After installing, Play deploys them by itself.' : 'After installing, Play deploys them by itself.')),
    buttons: [
      { label: fromPlay ? 'Cancel' : 'Close', value: false, safe: true },
      fromPlay ? { label: 'Launch without them', value: 'launch' } : null,
      { label: help.button || 'Get REDmod', value: 'get', kind: 'btn-primary' },
    ].filter(Boolean),
  });
  return v;
}

$('#mods-redmod').addEventListener('click', async () => {
  if ($('#mods-redmod').dataset.state === 'missing') {
    if (await redmodToolsBox(false) === 'get') await run(api.getRedmodTools());
    return;
  }
  const res = await api.deployRedmods();
  refreshRedmod();
  if (res.error) { toast(res.error, 'error'); return; } // a failure is not "no REDmods"
  const r = res.ok;
  if (r === null) toast('There are no REDmods in the game folder');
  else if (r?.missingTools) { if (await redmodToolsBox(false) === 'get') await run(api.getRedmodTools()); }
  else if (r?.cannotRun) modal({ title: 'Your REDmods cannot be deployed here yet', body: h('p', { class: 'pre-wrap' }, r.reason), buttons: [{ label: 'OK', value: true, kind: 'btn-primary' }] });
  else if (r && !r.ok) modal({ title: 'REDmod deploy failed', body: h('p', { class: 'pre-wrap' }, `${r.reason}\n\nThe full output is in Game log → Manager.`), buttons: [{ label: 'OK', value: true, kind: 'btn-primary' }] });
});

/**
 * The Mods page's REDmod button says where REDmods stand: deployed, changed since (Play deploys
 * them first), or the last deploy failed. Only REDmods need deploying; other mods work at once.
 */
let redmodToolsWarned = false;
async function refreshRedmod(st) {
  const s = st || (await api.redmodStatus()).ok;
  const btn = $('#mods-redmod');
  btn.hidden = !s?.count;
  moreAttention.redmod = false;
  paintMoreDot();
  if (!s?.count) return;
  const when = s.last?.at ? new Date(s.last.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const failed = s.last && !s.last.ok;
  const missing = s.tools === false && !s.upToDate;
  const needs = s.protontricks === false && !s.upToDate; // Linux: nothing to run REDmod deploy with
  const mode = s.running ? 'running' : missing ? 'missing' : needs ? 'needs' : failed ? 'failed' : s.upToDate ? 'ok' : 'waiting';
  btn.dataset.state = mode;
  btn.disabled = s.running;
  moreAttention.redmod = mode === 'waiting' || mode === 'failed';
  paintMoreDot();
  $('#mods-redmod-label').textContent = { running: 'Deploying REDmods…', missing: 'REDmod tools missing', needs: 'REDmod needs protontricks', failed: 'REDmod deploy failed', ok: 'REDmods deployed', waiting: 'Deploy REDmods' }[mode];
  // Once per session: REDmods are here (just installed, say) but nothing can deploy them.
  if (missing && !redmodToolsWarned) {
    redmodToolsWarned = true;
    toast('Your REDmods need the free REDmod tools to load', 'warn', { label: 'How to get them', fn: async () => { if (await redmodToolsBox(false) === 'get') await run(api.getRedmodTools()); } });
  }
  btn.title = {
    running: 'REDmod deploy is running',
    missing: 'This copy of the game has no REDmod tools (a free DLC from CD Projekt), so REDmods cannot be deployed. Click to see how to get them.',
    needs: 'REDmod deploy is a Windows program: on Linux it runs in the game\'s Proton folder through protontricks, which is not installed. Click for how to get it.',
    failed: `The last REDmod deploy failed${when ? ` (${when})` : ''}. Click to try again; Play also tries before starting the game.\n\n${s.last?.reason || ''}`,
    ok: `${s.count} REDmods, deployed${when ? ` ${when}` : ''}. Play deploys again by itself when they change. Click to deploy now anyway.`,
    waiting: `Your REDmods changed since the last deploy: Play deploys them before starting the game, or click to do it now.`,
  }[mode];
  $('#mods-redmod-sub').textContent = {
    running: 'Running now', missing: 'Click to see how to get them', needs: 'Click for how to get it', failed: 'Click to try again',
    ok: `${plural(s.count, 'REDmod')}${when ? `, deployed ${when}` : ''}`, waiting: 'Your REDmods changed since the last deploy',
  }[mode];
}

/** Settings: every install found, with its store; one click to use another. */
function renderInstalls() {
  const box = $('#s-installs');
  const current = String(state.settings?.gamePath || '').toLowerCase();
  if (!installs.length) {
    box.replaceChildren(h('span', { class: 'hint' }, 'No install found automatically (Steam, GOG, Epic Games, Xbox app). Use Browse to pick the folder.'));
    return;
  }
  box.replaceChildren(...installs.map(i => {
    const active = i.path.toLowerCase() === current;
    return h('div', { class: `install${active ? ' active' : ''}` },
      h('span', { class: 'tag' }, i.label),
      h('span', { class: 'install-path', title: i.path }, i.path),
      i.installing ? h('span', { class: 'status status-warn' }, `Installing in ${i.label} · ${Math.floor((i.progress || 0) * 100)}%`)
      : active ? h('span', { class: 'status status-ok' }, 'In use')
        : h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { $('#s-game').value = i.path; updateDirty(); } }, 'Use this'));
  }));
}

// ---------------------------------------------------------------- activity log (this app's own messages)

const con = { entries: [], filter: 'all', errs: 0 };

function logLine(e) {
  return h('div', { class: `log ${e.level}` },
    h('span', { class: 't' }, fmtTime(e.time)),
    h('span', { class: 'lv' }, e.level.toUpperCase()),
    h('span', { class: 'm' }, e.message, e.detail ? h('span', { class: 'd' }, e.detail) : null));
}

function shown(e) {
  if (con.filter === 'error') return e.level === 'error';
  if (con.filter === 'warn') return e.level === 'warn' || e.level === 'error';
  return true;
}

/** Toasts sit above the activity panel, whatever its height. */
function syncConsoleHeight() {
  document.documentElement.style.setProperty('--console-cur', `${$('#console').offsetHeight}px`);
}

function setConsoleOpen(open) {
  document.body.classList.toggle('console-open', open);
  $('#console-toggle').setAttribute('aria-expanded', String(open));
  store.set('console.open', open);
  if (open) $('#console-body').scrollTop = $('#console-body').scrollHeight;
  syncConsoleHeight();
}

function addLog(e) {
  con.entries.push(e);
  if (con.entries.length > 2000) con.entries.shift();
  if (e.level === 'error') con.errs++;
  const body = $('#console-body');
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
  if (shown(e)) body.append(logLine(e));
  while (body.childElementCount > 2000) body.firstElementChild.remove();
  if (atEnd) body.scrollTop = body.scrollHeight;
  $('#console-last').textContent = e.message;
  $('#console-time').textContent = new Date(e.time || Date.now()).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  $('#console-dot').className = `dot ${e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : 'ok'}`;
  updateBadges();
  if (e.level === 'error' && !document.body.classList.contains('console-open')) setConsoleOpen(true);
}

function updateBadges() {
  const b = $('#console-errs');
  b.hidden = !con.errs;
  b.textContent = plural(con.errs, 'error');
}

function setConsoleFilter(f) {
  con.filter = f;
  setSegActive('#console-filter', 'f', f);
  const body = $('#console-body');
  body.replaceChildren(...con.entries.filter(shown).map(logLine));
  body.scrollTop = body.scrollHeight;
}

$('#console-toggle').addEventListener('click', () => setConsoleOpen(!document.body.classList.contains('console-open')));
$$('#console-filter .seg-btn').forEach(b => b.addEventListener('click', () => setConsoleFilter(b.dataset.f)));
$('#console-errs').addEventListener('click', () => { setConsoleOpen(true); setConsoleFilter('error'); });
$('#console-clear').addEventListener('click', () => {
  con.entries = [];
  con.errs = 0;
  updateBadges();
  setConsoleFilter(con.filter);
  $('#console-last').textContent = '';
  $('#console-time').textContent = '';
  $('#console-dot').className = 'dot';
});
/** Both export buttons save one report: every error and warning, and every mod with its state. */
async function exportReport() {
  const r = await run(api.exportJson());
  if (r) toast(`Saved a report: ${plural(r.errors, 'error')}, ${plural(r.warnings, 'warning')}, ${plural(r.mods, 'mod')}`, 'success', { label: 'Show in folder', fn: () => api.revealExport() });
}
$('#console-export').addEventListener('click', exportReport);
$('#console-copy').addEventListener('click', async () => {
  const text = con.entries.filter(shown).map(e => `[${new Date(e.time).toISOString()}] ${e.level.toUpperCase()} ${e.message}${e.detail ? `\n  ${e.detail}` : ''}`).join('\n');
  await navigator.clipboard.writeText(text);
  toast('Activity log copied', 'success');
});

// Drag the panel's top edge to resize it; the height is a share of the window, so it scales.
(() => {
  const handle = $('#console-resize');
  let frac = store.get('console.frac', null);
  const apply = f => { document.documentElement.style.setProperty('--console-h', `${(f * 100).toFixed(2)}vh`); syncConsoleHeight(); };
  if (frac) apply(frac);
  handle.addEventListener('pointerdown', ev => {
    handle.setPointerCapture(ev.pointerId);
    const move = e => {
      frac = Math.min(0.7, Math.max(0.12, (window.innerHeight - e.clientY - 40) / window.innerHeight));
      apply(frac);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => handle.removeEventListener(t, end));
      store.set('console.frac', frac);
    };
    handle.addEventListener('pointermove', move);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => handle.addEventListener(t, end));
  });
  if (store.get('console.open', false)) setConsoleOpen(true);
  window.addEventListener('resize', syncConsoleHeight);
  syncConsoleHeight();
})();

// ---------------------------------------------------------------- FOMOD wizard

function enqueueFomod(req) {
  withModal(async () => {
    const selections = await runWizard(req);
    if (selections) await run(api.fomodSubmit(req.token, selections), `Installed ${req.name}`);
    else await run(api.fomodCancel(req.token));
  });
}

const GROUP_HINT = {
  SelectExactlyOne: 'Choose one', SelectAtMostOne: 'Choose one or none', SelectAtLeastOne: 'Choose at least one',
  SelectAll: 'All included', SelectAny: 'Choose any',
};

/** Walk the visible install steps; resolves with { step: { group: [pluginIdx] } } or null. */
function runWizard(req) {
  const cfg = req.config;
  const states = req.fileStates || {};
  const selections = {};
  // A shared profile carries the sender's choices: use the ones that still fit this installer.
  const preset = req.preset || null;
  if (preset) {
    const steps = Object.keys(preset).map(Number).filter(si => cfg.steps[si]).sort((a, b) => a - b);
    for (const si of steps) {
      const step = cfg.steps[si];
      const flags = Fomod.flagsBefore(cfg, selections, states, si);
      selections[si] = {};
      step.groups.forEach((g, gi) => {
        const types = g.plugins.map(p => Fomod.pluginType(p, flags, states));
        let picks = [...new Set((preset[si][gi] || []).filter(pi => pi < g.plugins.length && types[pi] !== 'NotUsable'))];
        if (g.type === 'SelectAll') picks = g.plugins.map((_, i) => i);
        if (g.type === 'SelectExactlyOne' || g.type === 'SelectAtMostOne') picks = picks.slice(0, 1);
        types.forEach((t, i) => { if (t === 'Required' && !picks.includes(i)) picks.push(i); });
        const valid = !Fomod.validateGroup(g, picks);
        selections[si][gi] = valid ? picks : Fomod.defaultSelection(g, flags, states);
      });
    }
  }
  let pos = 0;

  const ensureDefaults = si => {
    if (selections[si]) return;
    const flags = Fomod.flagsBefore(cfg, selections, states, si);
    selections[si] = {};
    cfg.steps[si].groups.forEach((g, gi) => { selections[si][gi] = Fomod.defaultSelection(g, flags, states); });
  };

  return new Promise(resolve => {
    // Nothing to ask (no steps, or none visible): install with the defaults, no dialog.
    if (!cfg.steps.length || !Fomod.visibleSteps(cfg, selections, states).length) { resolve({}); return; }
    const m = $('#modal');
    m.className = 'modal wide';
    m.setAttribute('aria-labelledby', 'fomod-title');
    let hide = null;
    const finish = v => { hide?.(); resolve(v); };
    // A wizard is easy to lose: a backdrop click does nothing, and Esc must be pressed twice.
    let escArmed = false;
    let errLine = null;
    const onDismiss = () => {
      if (escArmed) { finish(null); return; }
      escArmed = true;
      if (errLine) errLine.textContent = 'Press Esc again to cancel this install.';
      setTimeout(() => { escArmed = false; }, 3000);
    };

    const render = (focusFirst = false) => {
      const visible = Fomod.visibleSteps(cfg, selections, states);
      if (!visible.length) { finish({}); return; }
      pos = Math.min(pos, visible.length - 1);
      const si = visible[pos];
      ensureDefaults(si);
      const step = cfg.steps[si];
      const flags = Fomod.flagsBefore(cfg, selections, states, si);
      const info = h('div', { class: 'fomod-info' });
      const showInfo = p => {
        info.replaceChildren(
          p.image
            ? h('img', { class: 'fomod-img', src: req.imageBase + p.image.split('/').map(encodeURIComponent).join('/'), alt: p.name, onerror: e => e.target.replaceWith(h('div', { class: 'fomod-img', 'aria-hidden': 'true' }, icon('package'))) })
            : h('div', { class: 'fomod-img', 'aria-hidden': 'true' }, icon('package')),
          h('div', { class: 'info-name' }, p.name),
          h('div', { class: 'desc' }, p.description || 'No description.'));
      };
      errLine = h('span', { class: 'left', role: 'alert' });

      const groups = step.groups.map((g, gi) => {
        const single = g.type === 'SelectExactlyOne' || g.type === 'SelectAtMostOne';
        return h('fieldset', { class: 'fgroup' },
          h('legend', { class: 'fgroup-name' }, g.name || 'Options', h('span', { class: 'tag' }, GROUP_HINT[g.type] || g.type)),
          g.plugins.map((p, pi) => {
            const type = Fomod.pluginType(p, flags, states);
            const locked = type === 'Required' || g.type === 'SelectAll';
            const disabled = type === 'NotUsable';
            const checked = selections[si][gi].includes(pi);
            const input = h('input', {
              type: single ? 'radio' : 'checkbox', name: `g${si}-${gi}`, checked, disabled: disabled || locked,
              onchange: () => {
                let cur = selections[si][gi];
                if (single) cur = [pi];
                else cur = input.checked ? [...new Set([...cur, pi])] : cur.filter(x => x !== pi);
                selections[si][gi] = cur;
                // Later steps depend on flags set here: drop their choices so defaults are recomputed.
                Object.keys(selections).map(Number).filter(k => k > si).forEach(k => delete selections[k]);
                render();
                m.querySelector(`input[name="g${si}-${gi}"]:checked`)?.focus();
              },
            });
            const badge = type === 'Recommended' ? h('span', { class: 'tag tag-ok' }, 'Recommended')
              : type === 'Required' ? h('span', { class: 'tag' }, 'Required')
                : type === 'NotUsable' ? h('span', { class: 'tag tag-err' }, 'Not usable') : null;
            return h('label', {
              class: `fopt${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}`,
              onmouseenter: () => showInfo(p),
              onfocusin: () => showInfo(p),
              onclick: ev => {
                // Clicking the chosen option of an "at most one" group clears it.
                if (single && g.type === 'SelectAtMostOne' && checked && ev.target === input) {
                  ev.preventDefault();
                  selections[si][gi] = [];
                  render();
                }
              },
            }, input, h('span', { class: 'fopt-text' }, h('span', {}, p.name), badge ? h('span', {}, badge) : null));
          }));
      });
      const firstSel = step.groups.flatMap((g, gi) => selections[si][gi].map(pi => g.plugins[pi]))[0] || step.groups[0]?.plugins[0];
      if (firstSel) showInfo(firstSel);

      const isLast = pos === visible.length - 1;
      m.replaceChildren(
        h('div', { class: 'modal-head' },
          h('h3', { id: 'fomod-title' }, step.name),
          h('div', { class: 'sub' }, `${cfg.moduleName || req.name} · step ${pos + 1} of ${visible.length}${preset ? ' · the sharer\'s choices are filled in' : ''}`),
          h('div', { class: 'steps-track', 'aria-hidden': 'true' }, visible.map((_, i) => h('span', { class: i <= pos ? 'done' : '' })))),
        h('div', { class: 'modal-body' }, h('div', { class: 'fomod' }, h('div', { class: 'fomod-groups' }, groups), info)),
        h('div', { class: 'modal-foot' },
          errLine,
          h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel install'),
          h('button', { class: 'btn', disabled: pos === 0, onclick: () => { pos--; render(true); } }, 'Back'),
          h('button', {
            class: 'btn btn-primary',
            onclick: () => {
              const problems = step.groups.map((g, gi) => Fomod.validateGroup(g, selections[si][gi])).filter(Boolean);
              if (problems.length) { errLine.textContent = problems[0]; return; }
              if (isLast) {
                // Only keep choices for steps that are still visible.
                const out = {};
                for (const v of Fomod.visibleSteps(cfg, selections, states)) { ensureDefaults(v); out[v] = selections[v]; }
                finish(out);
              } else { pos++; render(true); }
            },
          }, isLast ? 'Install' : 'Next')),
      );
      if (focusFirst) (m.querySelector('.fomod-groups input:checked:not(:disabled)') || m.querySelector('.fomod-groups input:not(:disabled)'))?.focus();
    };
    render();
    hide = showModal({ focus: '.fomod-groups input:checked:not(:disabled)', onDismiss, backdrop: false });
  });
}

// ---------------------------------------------------------------- wiring

const snapshotHooks = [];
snapshotHooks.push(() => refreshRedmod()); // the REDmod button on the Mods page

function applySnapshot(snap) {
  state.snap = snap;
  for (const j of snap.jobs) state.jobs.set(j.id, j);
  for (const id of [...state.jobs.keys()]) if (!snap.jobs.some(j => j.id === id)) state.jobs.delete(id);
  snapshotHooks.forEach(fn => fn(snap));
  renderMods();
  renderDownloads();
  renderStatus();
  renderPlay();
  renderVortexMove();
  renderMo2Settings();
  if (state.drawerMod) {
    const m = allMods().find(x => x.id === state.drawerMod);
    if (!m) closeDrawer();
    else if (drawerSignature(m) !== state.drawerSig) openDrawer(m.id);
  }
}

api.onJob(job => {
  const isNew = !state.jobs.has(job.id);
  state.jobs.set(job.id, job);
  if (isNew) scheduleDlRender(); else updateJobRow(job);
  renderDlCounts();
});
api.onToast(t => toast(t.text, t.kind || 'info', typeof t.settings === 'string' && /^[a-z0-9]+$/.test(t.settings)
  ? { label: 'Open Settings', fn: () => { state.settingsJump = t.settings; goTo('settings'); } } : undefined));
api.onSnapshot(applySnapshot);
api.onLog(addLog);
api.onFomod(enqueueFomod);

window.addEventListener('DOMContentLoaded', async () => {
  const logs = await run(api.logs());
  (logs || []).forEach(addLog);
  await loadSettings();
  const snap = await run(api.snapshot());
  if (snap) applySnapshot(snap);
  refreshInstalls();
  loadNexusCats();
});
