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

function goTo(page) {
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
  t.querySelector('use').setAttribute('href', collapsed ? '#i-panel-open' : '#i-panel');
  if (remember) store.set('side.collapsed', collapsed);
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
    const next = ev.key === 'ArrowDown' ? ev.currentTarget.nextElementSibling : ev.currentTarget.previousElementSibling;
    (next?.classList.contains('row') ? next : (ev.key === 'ArrowDown' ? next?.nextElementSibling : next?.previousElementSibling))?.focus();
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

function visibleMods() {
  const q = $('#mods-search').value.trim().toLowerCase();
  return groupedMods().filter(m => {
    // By name only (its own and its Nexus mod's): a search for "red4ext" is not every RED4ext plugin.
    if (q && ![m.name, m.modName].filter(Boolean).join(' ').toLowerCase().includes(q)) return false;
    if (state.modFilter === 'enabled') return m.enabled;
    if (state.modFilter === 'disabled') return !m.enabled;
    if (state.modFilter === 'conflicts') return !!state.snap.conflicts[m.id];
    if (state.modFilter === 'problems') return hasProblem(m);
    if (state.modFilter === 'updates') return !!rowUpdateId(m);
    if (state.modFilter === 'repair') return !!m.health;
    if (state.modFilter === 'vortex') return !!m.vortex;
    return true;
  }).sort(SORTS[state.modSort] || byName);
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
};
const SORT_TIME = { installed: ['installedAt', 'installed'], enabled: ['enabledAt', 'enabled'], disabled: ['disabledAt', 'disabled'] };
state.modSort = store.get('modSort', 'az');
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

function conflictCell(m, byId) {
  const c = state.snap.conflicts[m.id];
  const vxHits = state.snap.vortex?.overlaps?.[m.id] || [];
  const vxTag = vxHits.length ? h('button', {
    class: 'tag tag-warn', title: `Shares files with Vortex mods: ${vxHits.map(id => byId[id]?.name || id.slice(3)).join(', ')}. One app will overwrite the other's files.`,
    onclick: ev => { ev.stopPropagation(); openDrawer(m.id); },
  }, `Vortex ${vxHits.length}`) : null;
  if (!c) return vxTag;
  const others = c.with.map(id => byId[id]?.name || id).join(', ');
  const open = ev => { ev.stopPropagation(); openDrawer(m.id, 'conflicts'); };
  return h('span', { class: 'chips-row' },
    vxTag,
    c.wins ? h('button', { class: 'tag tag-ok', title: `Wins ${plural(c.wins, 'file')} over ${others} — click to review`, onclick: open }, `Wins ${c.wins}`) : null,
    c.loses ? h('button', { class: 'tag tag-warn', title: `Loses ${plural(c.loses, 'file')} to ${others} — click to resolve`, onclick: open }, `Loses ${c.loses}`) : null);
}

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
  paintSelection($('#mods-table tbody'), state.modSel, $('#mods-all'), visibleMods().map(m => m.id), $('#mods-bulk'), $('#mods-sel-count'), $('#mods-toolbar'));
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
const hasProblem = m => !!(m.health || m.warnings?.length || state.modLogProblems[m.id]);

function renderMods() {
  const all = allMods();
  const mods = visibleMods();
  const ids = mods.map(m => m.id);
  for (const id of [...state.modSel]) if (!all.some(m => m.id === id)) state.modSel.delete(id);
  const byId = Object.fromEntries(all.map(m => [m.id, m]));
  const tbody = $('#mods-table tbody');

  keepFocus(tbody, () => tbody.replaceChildren(...mods.map(m => {
    const logIssues = state.modLogProblems[m.id];
    const upd = state.snap.updates?.[rowUpdateId(m) || m.id]; // the same update the Updates filter counts
    const tagBtn = (cls, title, section, text, extra = {}) => h('button', {
      class: `tag ${cls}`, title, dataset: { key: `${m.id}:${section}` }, ...extra,
      onclick: ev => { ev.stopPropagation(); openDrawer(m.id, section); },
    }, text);
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
    const kind = [m.vortex ? 'Vortex' : '', m.type, !m.vortex && !m.dependencyOf && m.category && m.category !== 'MAIN' ? CAT_LABEL[m.category] || m.category : ''].filter(Boolean).join(' · ');
    const sub = [who, kind, stamp].filter(Boolean).join(' · ');
    return h('tr', {
      class: 'row', tabindex: '0', dataset: { id: m.id, key: `${m.id}:row` }, 'aria-selected': 'false',
      onclick: ev => {
        if (ev.target.closest('input,button,select')) return;
        // Ctrl or Shift picks several for the selection bar; a plain click shows the mod in the panel.
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { clickSelect(state.modSel, ids, m.id, ev, 'lastModClick'); paintModSelection(); return; }
        state.lastModClick = m.id;
        openDrawer(m.id, '', false);
      },
      oncontextmenu: ev => { if (!ev.target.closest('input,select')) { ev.preventDefault(); modContextMenu(m, ev.clientX, ev.clientY); } },
      onkeydown: ev => rowKeys(ev, state.modSel, m.id, () => openDrawer(m.id), paintModSelection),
    },
    h('td', {}, h('input', {
      type: 'checkbox', 'aria-label': `Select ${m.name}`, tabindex: '-1',
      onchange: ev => { if (ev.target.checked) state.modSel.add(m.id); else state.modSel.delete(m.id); state.lastModClick = m.id; paintModSelection(); },
    })),
    h('td', {}, switchBtn),
    h('td', {}, h('div', { class: 'cell-name' },
      h('div', { class: 'name-line' },
        h('button', { class: 'name-btn', title: `${m.name} — open details`, dataset: { key: `${m.id}:name` }, onclick: ev => { ev.stopPropagation(); openDrawer(m.id); } }, m.name)),
      sub ? h('div', { class: 'subname', title: sub }, sub) : null)),
    h('td', { class: 'status-cell' }, h('div', { class: 'chips-row' },
        state.snap.vortex?.twins?.[m.id] ? h('span', { class: 'tag tag-vortex', title: `Also installed in Vortex. While it is enabled here, Vortex's copy is switched off${state.snap.vortex.twins[m.id].enabled && m.enabled ? ' (as soon as Vortex is closed)' : ''}.` }, 'Also in Vortex') : null,
        m.warnings?.length ? tagBtn('tag-warn tag-icon', `${plural(m.warnings.length, 'install warning')} — click to see`, 'warnings', icon('alert'), { 'aria-label': plural(m.warnings.length, 'install warning') }) : null,
        logIssues ? tagBtn('tag-err', 'Errors in this mod\'s game logs — click to see them', 'logs', `${logIssues} log error${logIssues === 1 ? '' : 's'}`) : null,
        m.health ? tagBtn('tag-warn', 'Files missing from the game folder or replaced by another tool — click to repair', 'health', m.health.missing ? `${m.health.missing} missing` : `${m.health.replaced} replaced`) : null,
        upd ? tagBtn('tag-info', `Update available: ${upd.name}${upd.version ? ` v${upd.version}` : ''} — click for details`, 'update', upd.version ? `${upd.version} available` : 'Update', { 'aria-label': `Update to ${upd.version || 'a newer version'}` }) : null,
        conflictCell(m, byId))),
    h('td', { class: 'num ver-cell', title: m.versions ? `${m.versions.length} versions installed` : m.version || '' }, m.versions ? versionMenu(m) : m.version || ''));
  })), null);

  markInspected();
  // Empty states: nothing installed vs nothing matching.
  $('#mods-empty').hidden = mods.length > 0;
  $('#mods-card').classList.toggle('is-empty', mods.length === 0);
  $('#page-mods').classList.toggle('no-items', all.length === 0);
  if (!all.length) {
    $('#mods-empty-title').textContent = 'No mods installed';
    $('#mods-empty-text').textContent = 'Download mods from Nexus, or install an archive you already have.';
    $('#mods-empty-actions').hidden = false;
  } else {
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
  $('#mods-filter-vortex').hidden = !vxCount;
  $('#mods-vx-count').textContent = vxCount || '';
  $('#mods-open-vortex').hidden = !state.snap.vortex?.installed;
  const link = (text, f, cls = '') => h('button', { class: `link-btn quiet ${cls}`, onclick: () => setModFilter(f) }, text);
  if (broken) sub.append(' · ', link(`${plural(broken, 'mod')} need${broken === 1 ? 's' : ''} repair`, 'repair', 'warn'));
  if (conflicts) sub.append(' · ', link(`${plural(conflicts, 'mod')} with file conflicts`, 'conflicts'));
  if (updates.length) sub.append(' · ', link(`${plural(updates.length, 'update')} available`, 'updates'));

  $('#mods-upd-count').textContent = updates.length || '';
  // Counted like the Conflicts filter: rows (versions of one mod are one) with a file conflict.
  $('#mods-conf-count').textContent = rows.filter(m => state.snap.conflicts[m.id]).length || '';
  $('#mods-prob-count').textContent = problems || '';
  const updAll = $('#mods-update-all');
  updAll.hidden = updates.length === 0;
  updAll.querySelector('span').textContent = `Update all (${updates.length})`;
  updAll.setAttribute('aria-label', `Update all ${plural(updates.length, 'mod')}`);
  const checkBtn = $('#mods-check-updates');
  const checked = state.snap.lastUpdateCheck;
  checkBtn.title = `Ask Nexus for newer versions of your mods${checked ? ` (last checked ${new Date(checked).toLocaleString()})` : ''}`;
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
  state.modFilter = f;
  setSegActive('#mods-filter', 'f', f);
  renderMods();
}

$('#mods-search').addEventListener('input', debounce(renderMods, 120));
$('#mods-sort').value = state.modSort;
$('#mods-sort').addEventListener('change', ev => {
  state.modSort = ev.target.value;
  store.set('modSort', state.modSort);
  renderMods();
});
$$('#mods-filter .seg-btn').forEach(b => b.addEventListener('click', () => setModFilter(b.dataset.f)));
$('#mods-all').addEventListener('change', ev => {
  visibleMods().forEach(m => (ev.target.checked ? state.modSel.add(m.id) : state.modSel.delete(m.id)));
  paintModSelection();
});
$('#mods-sel-clear').addEventListener('click', () => { state.modSel.clear(); paintModSelection(); });

document.addEventListener('keydown', ev => {
  const typing = ev.target.closest('input,textarea,select');
  if (ev.ctrlKey && ev.key.toLowerCase() === 'a' && !typing && $('#modal-back').hidden) {
    if ($('#page-mods').classList.contains('active')) { ev.preventDefault(); visibleMods().forEach(m => state.modSel.add(m.id)); paintModSelection(); }
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
  const vx = ids.filter(isVx);
  // Enabling one of ours that Vortex also has switches Vortex's copy off: Vortex closes if open.
  const twins = enabled ? ids.filter(id => state.snap.vortex?.twins?.[id]?.enabled).length : 0;
  if (!(await confirmVortexClose(vx.length + twins))) return null;
  return run(enabled ? api.enable(ids) : api.disable(ids));
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
$('#mods-empty-import').addEventListener('click', importArchives);
$('#mods-redeploy').addEventListener('click', () => run(api.redeploy(), 'Deployment checked'));
$('#mods-update-all').addEventListener('click', () => {
  const ids = groupedMods().map(rowUpdateId).filter(Boolean);
  modAction('update', ids);
});
$('#mods-check-updates').addEventListener('click', async ev => {
  const btn = ev.currentTarget;
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Checking…';
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
  setDrawerShown(false);
  state.drawerSig = '';
  if (drawerOpener) restoreFocus(drawerOpener, drawerOpenerKey);
  drawerOpener = null;
}

/** What the drawer shows depends on these; a snapshot that changes none of them leaves it alone. */
const drawerSignature = m => JSON.stringify([m.enabled, m.priority, m.installedAt, m.fileCount, m.warnings, m.health, state.snap.conflicts[m.id], state.snap.updates?.[m.id], state.modLogProblems[m.id]]);

let drawerSeq = 0;

async function openDrawer(id, focusSection = '', takeFocus = true) {
  const m = allMods().find(x => x.id === id);
  if (!m) return;
  if (m.vortex) { openVortexDrawer(m, takeFocus); return; }
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

  const drawer = $('#drawer');
  const body = $('#drawer-body');
  const keepScroll = wasOpen ? body.scrollTop : 0;
  const byId = Object.fromEntries(allMods().map(x => [x.id, x.name]));
  const kv = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  const act = (label, name, a, kind = '') => h('button', { class: `btn btn-sm ${kind}`, dataset: { key: `act:${a}` }, onclick: () => modAction(a, [m.id]) }, icon(name), h('span', {}, label));
  const fileList = files || [];

  keepFocus(drawer, () => {
    $('#drawer-title').textContent = m.name;
    $('#drawer-sub').textContent = [m.modName !== m.name ? m.modName : '', m.version ? `v${m.version}` : '', m.author].filter(Boolean).join(' · ');
    const nexus = $('#drawer-nexus');
    nexus.hidden = !m.modId;
    nexus.onclick = () => api.openNexus(m.game, m.modId);
    $('#drawer-actions').replaceChildren(...[
      m.enabled ? act('Disable', 'ban', 'disable') : act('Enable', 'check', 'enable', 'btn-primary'),
      hasConflicts && !(conflicts || []).length ? act('Win conflicts', 'arrow-up', 'prioritize') : null,
      act('Reinstall', 'rotate', 'reinstall'),
      h('button', { class: 'btn btn-sm btn-ghost', title: 'See this mod\'s files and edit them', onclick: () => { closeDrawer?.(); openConfigFor(`app:${m.id}`); } }, icon('file-code'), h('span', {}, 'Edit files')),
      h('button', { class: 'btn btn-sm btn-ghost', title: 'Ask the AI assistant about this mod', onclick: () => askAi(`Look at the mod "${m.name}": is anything wrong with it (logs, conflicts, missing files, load order)? What should I do?`) }, icon('sparkle'), h('span', {}, 'Ask AI')),
      act('Uninstall', 'minus-circle', 'uninstall'),
    ].filter(Boolean));
    body.replaceChildren(...[
      h('dl', { class: 'kv' },
        kv('Status', !m.enabled ? h('span', { class: 'tag' }, 'Disabled')
          : m.health ? h('span', { class: 'tag tag-warn' }, 'Enabled · needs repair') : h('span', { class: 'tag tag-ok' }, 'Enabled')),
        kv('Type', m.type),
        kv('Category', CAT_LABEL[m.category] || m.category),
        m.dependencyOf ? kv('Required by', m.dependencyOf) : null,
        kv('Priority', `${m.priority}${hasConflicts ? ' — higher wins file conflicts' : ''}`),
        kv('Installed', new Date(m.installedAt).toLocaleString()),
        m.skipped ? kv('Not installed', `${plural(m.skipped, 'file')} (readmes, images, unknown files)`) : null),
      ...conflictSection(m, conflicts || []),
      m.warnings?.length ? h('h2', { dataset: { section: 'warnings' } }, 'Install warnings') : null,
      m.warnings?.length ? h('ul', { class: 'warnlist' }, m.warnings.map(w => h('li', {}, w))) : null,
      ...drawerSections.flatMap(fn => fn(m) || []),
      h('h2', {}, `Files · ${fileList.length || m.fileCount}`),
      fileList.length
        ? h('div', { class: 'filelist' }, fileList.map(f => h('div', {},
          h('span', {}, f.dest),
          m.enabled && !f.deployed ? h('span', { class: 'lost', title: f.owner ? `The copy from ${byId[f.owner] || f.owner} is in the game` : 'Not in the game folder' }, f.owner ? `overridden by ${byId[f.owner] || 'another mod'}` : 'missing') : null)))
        : h('div', { class: 'empty-inline' }, m.fileCount ? 'The file list could not be read. Reinstall the mod to rebuild it.' : 'This mod installed no files.'),
    ].filter(Boolean));
  }, '#drawer-close');

  setDrawerShown(true);
  if (focusSection) body.querySelector(`[data-section="${focusSection}"]`)?.scrollIntoView({ block: 'start' });
  else body.scrollTop = keepScroll;
  if (!wasOpen && takeFocus && !drawer.contains(document.activeElement)) $('#drawer-close').focus();
}

/** A Vortex mod: what Vortex knows about it, and what can be done from here. */
function openVortexDrawer(m, takeFocus = true) {
  const drawer = $('#drawer');
  if (drawer.hidden) { drawerOpener = document.activeElement; drawerOpenerKey = drawerOpener?.closest?.('[data-key]')?.dataset.key || ''; }
  state.drawerMod = m.id;
  state.drawerSig = drawerSignature(m);
  const vx = state.snap.vortex || {};
  const u = state.snap.updates?.[m.id];
  const ours = state.snap.mods.filter(o => (vx.overlaps?.[o.id] || []).includes(m.id));
  const kv = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  keepFocus(drawer, () => {
    $('#drawer-title').textContent = m.name;
    $('#drawer-sub').textContent = ['Managed by Vortex', m.version ? `v${m.version}` : '', m.author].filter(Boolean).join(' · ');
    const nexus = $('#drawer-nexus');
    nexus.hidden = !m.modId;
    nexus.onclick = () => api.openNexus(m.game, m.modId);
    $('#drawer-actions').replaceChildren(...[
      m.enabled
        ? h('button', { class: 'btn btn-sm', dataset: { key: 'act:disable' }, onclick: () => modAction('disable', [m.id]) }, icon('ban'), h('span', {}, 'Disable in Vortex'))
        : h('button', { class: 'btn btn-sm btn-primary', dataset: { key: 'act:enable' }, onclick: () => modAction('enable', [m.id]) }, icon('check'), h('span', {}, 'Enable in Vortex')),
      h('button', { class: 'btn btn-sm', title: 'This app manages it from now on; Vortex keeps it, switched off', onclick: () => moveFromVortex([m.id]) }, icon('download'), h('span', {}, 'Move to this app')),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => run(api.openVortex()) }, icon('vortex'), h('span', {}, 'Open Vortex')),
      h('button', { class: 'btn btn-sm btn-ghost', title: 'See this mod\'s files and edit them', onclick: () => { closeDrawer?.(); openConfigFor(`vx:${m.vortexId}`); } }, icon('file-code'), h('span', {}, 'Edit files')),
      h('button', { class: 'btn btn-sm btn-ghost', title: 'Ask the AI assistant about this mod', onclick: () => askAi(`Look at the Vortex mod "${m.name}": is anything wrong with it? What should I do?`) }, icon('sparkle'), h('span', {}, 'Ask AI')),
    ]);
    $('#drawer-body').replaceChildren(...[
      h('dl', { class: 'kv' },
        kv('Status', m.enabled ? h('span', { class: 'tag tag-ok' }, 'Deployed by Vortex') : h('span', { class: 'tag' }, 'Disabled in Vortex')),
        kv('Vortex profile', vx.activeProfileName || '—'),
        kv('Files in the game', String(m.fileCount)),
        m.installedAt ? kv('Installed', new Date(m.installedAt).toLocaleString()) : null,
        kv('Changes', 'Switching it on or off here is done without opening Vortex (if Vortex is open, it closes for a moment). Move to this app to manage it here entirely.')),
      u ? h('h2', { dataset: { section: 'update' } }, 'Update available') : null,
      u ? h('div', { class: 'notice notice-info' }, icon('up-circle'),
        h('div', { class: 'notice-text' }, h('div', { class: 'name' }, `${u.name}${u.version ? ` · v${u.version}` : ''}`), h('div', { class: 'subname' }, 'Updating moves it to this app, which downloads and installs the new version. Vortex is not opened.')),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => modAction('update', [m.id]) }, 'Update')) : null,
      ours.length ? h('h2', {}, `Shares files with this app's mods · ${ours.length}`) : null,
      ours.length ? h('ul', { class: 'warnlist' }, ours.map(o => h('li', {}, `${o.name}: whichever app deploys last wins those files`))) : null,
    ].filter(Boolean));
  }, '#drawer-close');
  setDrawerShown(true);
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
          h('span', { class: `conflict-win ${c.weWin ? 'ok' : 'lose'}` }, c.weWin ? 'This mod wins' : `${c.name} wins`),
          h('span', { class: 'subname' }, `${plural(c.files.length, 'shared file')} with ${c.name}`)),
        c.weWin
          ? h('button', { class: 'btn btn-sm', dataset: { key: `let:${c.id}` }, title: `Move ${c.name} to the top priority, so it wins over this and every other mod`, onclick: () => modAction('prioritize', [c.id]) }, 'Let the other win')
          : h('button', { class: 'btn btn-sm btn-primary', dataset: { key: `win:${c.id}` }, title: 'Move this mod to the top priority, so it wins over every other mod', onclick: () => modAction('prioritize', [m.id]) }, 'Make this mod win')),
      h('div', { class: 'conflict-files' }, c.files.slice(0, 50).map(f => h('div', {}, f)), c.files.length > 50 ? h('div', { class: 'muted' }, `…and ${c.files.length - 50} more`) : null))),
  ];
}

$('#drawer-close').addEventListener('click', closeDrawer);

/// ---------------------------------------------------------------- downloads page
/*
 * One list, like Vortex: downloads in progress at the top with live progress and speed, then every
 * downloaded archive with whether it is installed. A network panel graphs the total speed.
 */

const dl = { filter: 'all', speeds: new Array(120).fill(0), sessionBytes: 0, peak: 0, lastReceived: new Map() };
// 'waiting': a free account's file, waiting for its "Slow download" click on Nexus.
const ACTIVE = ['queued', 'downloading', 'waiting'];

function dlRows() {
  const q = $('#dl-search').value.trim().toLowerCase();
  const match = (...t) => !q || t.join(' ').toLowerCase().includes(q);
  const jobs = [...state.jobs.values()].filter(j => j.status !== 'done').sort((a, b) => (ACTIVE.includes(b.status) - ACTIVE.includes(a.status)) || b.id - a.id)
    .filter(j => match(j.name, j.fileName, j.modName))
    .map(j => ({ kind: 'job', id: `job:${j.id}`, j }));
  const recs = state.snap.downloads.filter(d => match(d.name, d.fileName, d.modName))
    .sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0))
    .map(d => ({ kind: 'rec', id: d.key, d }));
  const f = dl.filter;
  if (f === 'active') return jobs.filter(r => ACTIVE.includes(r.j.status));
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
      h('button', { class: 'btn btn-sm btn-primary', dataset: { key: `job:${j.id}:get` }, title: 'Open its Nexus download page', onclick: () => startFreeDownloads(j.id) }, 'Get'));
  }
  if (j.status === 'error') return h('span', { class: 'status status-err', title: j.error }, 'Failed');
  return h('span', { class: 'status' }, 'Cancelled');
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
      ondblclick: ev => { if (!ev.target.closest('input,button')) run(api.install([d.key])); },
      onkeydown: ev => rowKeys(ev, state.dlSel, d.key, () => run(api.install([d.key])), paintDlSelection),
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
}

function renderDlCounts() {
  const jobs = [...state.jobs.values()];
  const active = jobs.filter(j => ACTIVE.includes(j.status)).length;
  const failed = jobs.filter(j => ['error', 'cancelled'].includes(j.status)).length;
  $('#dl-active-count').textContent = active || '';
  $('#dl-failed-count').textContent = failed || '';
  $('#dl-clear').disabled = !jobs.some(j => ['done', 'cancelled', 'error'].includes(j.status));
  const nav = $('#nav-dl-count');
  nav.textContent = active ? `${active} active` : '';
  nav.classList.toggle('live', active > 0);
  nav.title = active ? `${active} downloading` : `${state.snap.downloads.length} downloaded`;
}

/** Live job updates touch only their own row; a finished job re-renders the list. */
function updateJobRow(j) {
  const tr = $(`#dl-table tr[data-job="${j.id}"]`);
  if (!tr || !ACTIVE.includes(j.status)) { scheduleDlRender(); return; }
  tr.className = `row job-row ${j.status}`;
  tr.querySelector('.status-cell').replaceChildren(jobStatusCell(j));
  tr.querySelector('.num').textContent = fmtSize(j.total);
}
const scheduleDlRender = (() => {
  let t = null;
  return () => { if (!t) t = setTimeout(() => { t = null; renderDownloads(); }, 150); };
})();

// The network panel: total speed sampled every second, two minutes of history.
function sampleNetwork() {
  const jobs = [...state.jobs.values()];
  const speed = jobs.filter(j => j.status === 'downloading').reduce((n, j) => n + (j.speed || 0), 0);
  for (const j of jobs) {
    const prev = dl.lastReceived.get(j.id) || 0;
    if (j.received > prev) dl.sessionBytes += j.received - prev;
    dl.lastReceived.set(j.id, j.received || 0);
  }
  dl.speeds.push(speed);
  dl.speeds.shift();
  dl.peak = Math.max(dl.peak, speed);
  const active = jobs.filter(j => j.status === 'downloading').length;
  $('#net-now').textContent = active ? `${fmtSize(speed)}/s` : 'Idle';
  $('#net-now').classList.toggle('live', active > 0);
  $('#net-active').textContent = active;
  $('#net-queued').textContent = jobs.filter(j => j.status === 'queued').length;
  $('#net-total').textContent = fmtSize(dl.sessionBytes) === '—' ? '0 B' : fmtSize(dl.sessionBytes);
  $('#net-peak').textContent = dl.peak ? `${fmtSize(dl.peak)}/s` : '—';
  const max = Math.max(...dl.speeds, 1024 * 1024);
  const pts = dl.speeds.map((v, i) => `${i},${(40 - (v / max) * 36).toFixed(2)}`);
  $('#net-graph .net-line').setAttribute('d', `M${pts.join(' L')}`);
  $('#net-graph .net-area').setAttribute('d', `M0,40 L${pts.join(' L')} L119,40 Z`);
}
setInterval(sampleNetwork, 1000);

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
const growLinks = () => { linksBox.style.height = 'auto'; linksBox.style.height = `${linksBox.scrollHeight + 2}px`; };
linksBox.addEventListener('input', growLinks);

$('#dl-go').addEventListener('click', async () => {
  const text = linksBox.value;
  const btn = $('#dl-go');
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Reading files…';
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
    label.textContent = 'Choose files';
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
  dataDir: '#s-data', sevenZipPath: '#s-7z',
  updateEvery: '#s-upd-every', updateUnit: '#s-upd-unit',
  aiProvider: '#s-ai-provider', aiEndpoint: '#s-ai-endpoint', aiModel: '#s-ai-model', aiTimeout: '#s-ai-timeout', aiContext: '#s-ai-context', playsKeep: '#s-plays-keep', uiScale: '#s-ui-scale', launchMode: '#s-launch', vortexAutoMove: '#s-vx-auto', updateMode: '#s-upd-mode',
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
  $('#s-upd-check').disabled = upd.status === 'dev' || upd.status === 'checking' || upd.status === 'downloading';

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
  updateDirty();
});

// The account type, checked when the app starts.
api.onKeyUser(u => { state.keyUser = u; renderStatus(); });
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
  if (ids && state.drawerMod && ids.includes(state.drawerMod)) closeDrawer();
  return r;
}
$('#s-vx-move').addEventListener('click', () => moveFromVortex());

function renderVortexMove() {
  const vx = state.snap.vortex;
  $('#sec-vortex').hidden = !vx?.installed;
  $('.set-nav-item[data-sec="vortex"]').hidden = !vx?.installed;
  if (!vx?.installed) return;
  const n = vx.mods?.length || 0;
  $('#s-vx-text').textContent = n
    ? `${plural(n, 'mod')} in Vortex (${vx.mods.filter(m => m.enabled).length} enabled)${vx.adopted ? ` · ${vx.adopted} moved here already` : ''}`
    : `All Vortex mods are managed here${vx.adopted ? ` (${vx.adopted} moved)` : ''}`;
  $('#s-vx-move').disabled = !n;
  // "Vortex mods: ask": once per start, when Vortex has mods this app has not taken over.
  if (state.settings?.vortexAutoMove === 'ask' && vx.pending && !vortexAsked) {
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

// The nxm switch is not here: it applies at once, see "Nexus download links" below.
// ---------------------------------------------------------------- Nexus download links (nxm://)

function showNxmState(st) {
  if (!st) return;
  $('#s-nxm').checked = st.on;
  const el = $('#s-nxm-state');
  el.className = `check-sub nxm-state ${st.on && !st.ours ? 'bad' : st.ours ? 'ok' : ''}`;
  el.textContent = st.ours ? 'Now: these links open Cyber Mod Manager.'
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
    const ok = await confirmBox('Handle Nexus downloads here?', `"Mod Manager Download" buttons on nexusmods.com will open Cyber Mod Manager and download here${st.handler && st.handler !== 'Cyber Mod Manager' ? `, instead of ${st.handler}` : ''}. The current setting is saved, and turning this off puts it back. The first time, your browser asks whether to open Cyber Mod Manager: allow it.${st.handler === 'Vortex' ? ' Vortex takes these links back when it starts, unless "Handle Nexus links" is off in Vortex\'s settings.' : ''}`, 'Handle them here');
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

const checks = { autoEnable: '#s-autoenable', installDependencies: '#s-deps', blockAds: '#s-adblock' };

const AI_EXAMPLES = {
  openai: { endpoint: 'https://api.openai.com/v1 (or http://localhost:11434/v1 for Ollama)', model: 'e.g. gpt-5.1, or the model your endpoint serves' },
  anthropic: { endpoint: 'https://api.anthropic.com', model: 'e.g. claude-sonnet-5-5' },
};
function aiPlaceholders() {
  const ex = AI_EXAMPLES[$('#s-ai-provider').value] || AI_EXAMPLES.openai;
  $('#s-ai-endpoint').placeholder = ex.endpoint;
  $('#s-ai-model').placeholder = ex.model;
}
$('#s-ai-provider').addEventListener('change', aiPlaceholders);
$('#s-ai-test').addEventListener('click', async () => {
  const st = $('#s-ai-status');
  if (isDirty()) await run(api.setSettings(readForm()));
  st.className = 'hint';
  st.textContent = 'Asking the model to reply…';
  const r = await api.aiTest();
  st.className = r.error ? 'hint bad' : 'hint ok';
  st.textContent = r.error ? r.error : `Connected: ${r.ok}`;
  await loadSettings();
});

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
  aiPlaceholders();
  for (const [k, sel] of Object.entries(form)) { $(sel).value = s[k] ?? ''; $(sel).title = String(s[k] ?? ''); }
  if (!s.aiContext) { $('#s-ai-context').value = ''; $('#s-ai-context').title = ''; } // 0: automatic
  for (const [k, sel] of Object.entries(checks)) $(sel).checked = !!s[k];
  refreshNxm();
  refreshSteamHint();
  $$('#s-cats input').forEach(i => { i.checked = s.categories.includes(i.value); });
  renderStatus();
  renderInstalls();
  updateDirty();
}

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
$('#s-7z-browse').addEventListener('click', async () => {
  const p = await run(api.pickFile('Select 7z.exe', [{ name: '7-Zip', extensions: ['exe'] }]));
  if (p && p[0]) { $('#s-7z').value = p[0]; updateDirty(); }
});
$$('[data-open]').forEach(b => b.addEventListener('click', () => run(api.openPath(b.dataset.open))));

function renderStatus() {
  const g = state.snap.game || {};
  $('#st-game-dot').className = `dot ${g.valid ? 'ok' : 'bad'}`;
  $('#st-game').textContent = g.valid ? 'Game folder' : 'No game folder';
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
  if (vx?.installed) {
    $('#st-vx').textContent = `Vortex ${vx.busy ? 'applying…' : vx.running ? 'open' : 'closed'}`;
    $('#st-vx-dot').className = `dot ${vx.running || vx.busy ? 'warn' : ''}`;
    $('#st-vx-row').title = `Vortex profile: ${vx.activeProfileName || '—'} · ${plural(vx.mods.length, 'mod')}`;
  }
  const r = state.snap.rate || {};
  $('#st-rate').textContent = r.hourly != null ? `API ${r.hourly}/h · ${r.daily}/day left` : '';
  // The collapsed rail shows only the avatar: everything above is its tooltip.
  $('#side-foot').title = [user ? `${user.name}${user.isPremium ? ' · Premium' : ''}` : hasKey ? 'Nexus API key saved' : 'No Nexus API key',
    g.valid ? 'Game folder found' : 'Game folder not set', vx?.installed ? $('#st-vx').textContent : '', $('#st-rate').textContent].filter(Boolean).join(' · ');
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
  if (!$('#prof-menu').hidden) paintProfileMenu();
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
  // Below the button in the sidebar; beside it on the narrow rail. Kept inside the window.
  const r = btn.getBoundingClientRect();
  const rail = $('#shell').classList.contains('side-collapsed');
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  const left = rail ? r.right + 8 : r.left;
  const top = rail ? r.top : r.bottom + 6;
  menu.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(top, innerHeight - hgt - 8))}px`;
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
  const items = () => [...menu.querySelectorAll('.menu-item:not([hidden])')];
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
$('#mods-open-vortex').addEventListener('click', () => run(api.openVortex()));

// ---------------------------------------------------------------- Play

let installs = [];
async function refreshInstalls() {
  installs = (await run(api.gameInstalls())) || [];
  renderInstalls();
  renderPlay();
}

function renderPlay() {
  const g = state.snap.game || {};
  const here = installs.find(i => i.path.toLowerCase() === String(g.path || '').toLowerCase());
  const running = !!state.gameRunning;
  const btn = $('#play-btn');
  if (!running) stopArmed = false;
  btn.disabled = !g.valid;
  btn.classList.toggle('running', running);
  btn.classList.toggle('armed', running && stopArmed);
  btn.querySelector('use').setAttribute('href', running ? '#i-stop' : '#i-play');
  $('#play-label').textContent = running ? (stopArmed ? 'Close the game?' : 'Running') : 'Play';
  $('#play-sub').textContent = !g.valid ? 'No game folder' : running ? (stopArmed ? 'Click again' : 'Stop') : here?.label || '';
  $('#brand-sub').textContent = here ? `Cyberpunk 2077 · ${here.label}` : 'Cyberpunk 2077';
  btn.title = !g.valid ? 'Set the Cyberpunk 2077 folder in Settings' : running ? (stopArmed ? 'Click again to close the game: unsaved progress is lost' : 'Cyberpunk 2077 is running. Click twice to close it.') : `Launch Cyberpunk 2077${here ? ` through ${here.label}` : ''}`;
}
// Stop asks twice: the first click arms it for a few seconds, the second closes the game.
let stopArmed = false;
let stopTimer = 0;
/**
 * Play through Steam needs the game's Steam launch options to skip the launcher and load REDmods
 * (Steam asks to confirm arguments another program passes, so they cannot come from here).
 * Resolves 'again' (check again), 'anyway' (start as they are) or false.
 */
function steamOptionsBox({ current, missing, suggested }) {
  const copy = h('button', { class: 'btn btn-sm', onclick: async () => { await navigator.clipboard.writeText(suggested); copy.lastChild.textContent = 'Copied'; } }, icon('copy'), h('span', {}, 'Copy'));
  return modal({
    title: 'Set the Steam launch options once',
    sub: 'So Steam starts Cyberpunk 2077 modded, without its launcher',
    body: h('div', { class: 'steam-opts' },
      h('p', {}, `Steam starts the game with the launch options in its own settings. Yours are missing ${missing.join(' and ')}: without them the CD Projekt launcher opens${missing.includes('-modded') ? ' and REDmods do not load' : ''}.`),
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
  }).then(v => (v === 'open' ? api.openSteamGame().then(() => steamOptionsBox({ current, missing, suggested })) : v));
}

/** Under "When you press Play": whether Steam's launch options are ready for Play through Steam. */
async function refreshSteamHint() {
  const el = $('#s-launch-steam');
  if ($('#s-launch').value !== 'steam') { el.hidden = true; return; }
  const r = (await api.steamLaunchOptions())?.ok;
  el.hidden = false;
  el.className = `hint ${r && !r.missing.length ? 'ok' : ''}`;
  el.textContent = !r ? 'Steam\'s settings for the game were not found; this works for Steam copies only.'
    : r.missing.length ? `Add ${r.missing.join(' ')} to the game's launch options in Steam (Properties → General). Play shows how.`
      : `Steam's launch options are ready: ${r.options}`;
}
$('#s-launch').addEventListener('change', refreshSteamHint);

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
  btn.disabled = true;
  $('#play-label').textContent = 'Starting…';
  let r = await run(api.launchGame());
  // Through Steam: Steam's launch options for the game must skip the launcher and load REDmods.
  while (r?.steamOptions) {
    const go = await steamOptionsBox(r.steamOptions);
    r = go ? await run(api.launchGame({ skipDeploy: true, skipSteamCheck: go === 'anyway' })) : null;
  }
  // No REDmod tools: say how to get them, once per session; after that Play just starts the game.
  if (r?.deployFailed && r.missingTools) {
    const go = redmodToolsAsked ? 'launch' : await redmodToolsBox(true);
    redmodToolsAsked = true;
    if (go === 'get') await run(api.getRedmodTools());
    r = go === 'launch' ? await run(api.launchGame({ skipDeploy: true })) : null;
  }
  // REDmod deploy failed: say why, and let the player decide.
  if (r?.deployFailed) {
    const go = await confirmBox('REDmod deploy failed', `Your REDmods may not load (the game uses what was last deployed successfully).\n\n${r.reason}\n\nThe full output is in Game log → Manager.`, 'Launch anyway');
    r = go ? await run(api.launchGame({ skipDeploy: true })) : null;
  }
  if (r && !r.deployFailed) toast(`Starting Cyberpunk 2077 through ${r.via}`, 'success');
  setTimeout(renderPlay, 4000);
});
// REDmod deploy runs before the game when REDmods changed: the Play button shows it.
api.onRedmod(e => {
  if (e.stage === 'deploying') {
    $('#play-label').textContent = 'Deploying REDmods…';
    if (e.line) $('#play-btn').title = e.line.slice(0, 200);
  } else if (e.stage === 'done') {
    toast('REDmods deployed', 'success');
    renderPlay();
    refreshRedmod(e.status);
  } else if (e.stage === 'failed') {
    renderPlay();
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
  if (!s?.count) return;
  const when = s.last?.at ? new Date(s.last.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const failed = s.last && !s.last.ok;
  const missing = s.tools === false && !s.upToDate;
  const mode = s.running ? 'running' : missing ? 'missing' : failed ? 'failed' : s.upToDate ? 'ok' : 'waiting';
  btn.dataset.state = mode;
  btn.disabled = s.running;
  $('#mods-redmod-label').textContent = { running: 'Deploying REDmods…', missing: 'REDmod tools missing', failed: 'REDmod deploy failed', ok: 'REDmods deployed', waiting: 'Deploy REDmods' }[mode];
  // Once per session: REDmods are here (just installed, say) but nothing can deploy them.
  if (missing && !redmodToolsWarned) {
    redmodToolsWarned = true;
    toast('Your REDmods need the free REDmod tools to load', 'warn', { label: 'How to get them', fn: async () => { if (await redmodToolsBox(false) === 'get') await run(api.getRedmodTools()); } });
  }
  btn.title = {
    running: 'REDmod deploy is running',
    missing: 'This copy of the game has no REDmod tools (a free DLC from CD Projekt), so REDmods cannot be deployed. Click to see how to get them.',
    failed: `The last REDmod deploy failed${when ? ` (${when})` : ''}. Click to try again; Play also tries before starting the game.\n\n${s.last?.reason || ''}`,
    ok: `${s.count} REDmods, deployed${when ? ` ${when}` : ''}. Play deploys again by itself when they change. Click to deploy now anyway.`,
    waiting: `Your REDmods changed since the last deploy: Play deploys them before starting the game, or click to do it now.`,
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
      active ? h('span', { class: 'status status-ok' }, 'In use')
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
api.onToast(t => toast(t.text, t.kind || 'info'));
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
});
