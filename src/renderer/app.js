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
  const name = kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'terminal';
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(name), h('span', { class: 'toast-text' }, msg),
    action ? h('button', { class: 'btn btn-sm', onclick: () => { action.fn(); el.remove(); } }, action.label) : null);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), action ? 9000 : kind === 'error' ? 7000 : 3500);
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
  if (page === 'settings') loadSettings();
  pageHooks[page]?.();
}
$$('.nav-item').forEach(btn => btn.addEventListener('click', () => goTo(btn.dataset.page)));
document.addEventListener('click', ev => {
  const go = ev.target.closest('[data-goto]');
  if (go) goTo(go.dataset.goto);
});

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
    $('#shell').inert = false;
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

function visibleMods() {
  const q = $('#mods-search').value.trim().toLowerCase();
  return state.snap.mods.filter(m => {
    if (q && !`${m.name} ${m.modName} ${m.type}`.toLowerCase().includes(q)) return false;
    if (state.modFilter === 'enabled') return m.enabled;
    if (state.modFilter === 'disabled') return !m.enabled;
    if (state.modFilter === 'conflicts') return !!state.snap.conflicts[m.id];
    if (state.modFilter === 'problems') return hasProblem(m);
    if (state.modFilter === 'updates') return !!state.snap.updates?.[m.id];
    if (state.modFilter === 'repair') return !!m.health;
    return true;
  });
}

function conflictCell(m, byId) {
  const c = state.snap.conflicts[m.id];
  if (!c) return h('span', { class: 'muted' }, '—');
  const others = c.with.map(id => byId[id]?.name || id).join(', ');
  const open = ev => { ev.stopPropagation(); openDrawer(m.id, 'conflicts'); };
  return h('span', {},
    c.wins ? h('button', { class: 'tag tag-ok', title: `Wins ${plural(c.wins, 'file')} over ${others} — click to review`, onclick: open }, `wins ${c.wins}`) : null,
    c.loses ? h('button', { class: 'tag tag-warn', title: `Loses ${plural(c.loses, 'file')} to ${others} — click to resolve`, onclick: open }, `loses ${c.loses}`) : null);
}

function paintModSelection() {
  paintSelection($('#mods-table tbody'), state.modSel, $('#mods-all'), visibleMods().map(m => m.id), $('#mods-bulk'), $('#mods-sel-count'), $('#mods-toolbar'));
  const picked = [...state.modSel].map(id => state.snap.mods.find(m => m.id === id)).filter(Boolean);
  $('#mods-bulk-update').hidden = !picked.some(m => state.snap.updates?.[m.id]);
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
  const all = state.snap.mods;
  const mods = visibleMods();
  const ids = mods.map(m => m.id);
  for (const id of [...state.modSel]) if (!all.some(m => m.id === id)) state.modSel.delete(id);
  const byId = Object.fromEntries(all.map(m => [m.id, m]));
  const tbody = $('#mods-table tbody');

  keepFocus(tbody, () => tbody.replaceChildren(...mods.map(m => {
    const logIssues = state.modLogProblems[m.id];
    const upd = state.snap.updates?.[m.id];
    const tagBtn = (cls, title, section, text, extra = {}) => h('button', {
      class: `tag ${cls}`, title, dataset: { key: `${m.id}:${section}` }, ...extra,
      onclick: ev => { ev.stopPropagation(); openDrawer(m.id, section); },
    }, text);
    // While the change is applied the switch stays focusable (aria-disabled), so focus isn't lost.
    const switchBtn = h('button', {
      class: `switch${m.enabled ? ' on' : ''}`, role: 'switch', 'aria-checked': m.enabled ? 'true' : 'false',
      'aria-label': m.name, title: m.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable',
      dataset: { key: `${m.id}:switch` },
      onclick: async ev => {
        ev.stopPropagation();
        if (switchBtn.getAttribute('aria-disabled') === 'true') return;
        switchBtn.setAttribute('aria-disabled', 'true');
        const ok = await run(m.enabled ? api.disable([m.id]) : api.enable([m.id]));
        if (ok === null) switchBtn.removeAttribute('aria-disabled');
      },
    });
    const sub = m.dependencyOf ? `Required by ${m.dependencyOf}` : [m.modName !== m.name ? m.modName : '', m.author].filter(Boolean).join(' · ');
    return h('tr', {
      class: 'row', tabindex: '0', dataset: { id: m.id, key: `${m.id}:row` }, 'aria-selected': 'false',
      onclick: ev => {
        if (ev.target.closest('input,button')) return;
        clickSelect(state.modSel, ids, m.id, ev, 'lastModClick');
        paintModSelection();
      },
      ondblclick: ev => { if (!ev.target.closest('input,button')) openDrawer(m.id); },
      onkeydown: ev => rowKeys(ev, state.modSel, m.id, () => openDrawer(m.id), paintModSelection),
    },
    h('td', {}, h('input', {
      type: 'checkbox', 'aria-label': `Select ${m.name}`, tabindex: '-1',
      onchange: ev => { if (ev.target.checked) state.modSel.add(m.id); else state.modSel.delete(m.id); state.lastModClick = m.id; paintModSelection(); },
    })),
    h('td', {}, switchBtn),
    h('td', {}, h('div', { class: 'cell-name' },
      h('div', { class: 'name-line' },
        h('button', { class: 'name-btn', title: `${m.name} — open details`, dataset: { key: `${m.id}:name` }, onclick: ev => { ev.stopPropagation(); openDrawer(m.id); } }, m.name),
        m.warnings?.length ? tagBtn('tag-warn tag-icon', `${plural(m.warnings.length, 'install warning')} — click to see`, 'warnings', icon('alert'), { 'aria-label': plural(m.warnings.length, 'install warning') }) : null,
        logIssues ? tagBtn('tag-err', 'Errors in this mod\'s game logs — click to see them', 'logs', `${logIssues} log error${logIssues === 1 ? '' : 's'}`) : null,
        m.health ? tagBtn('tag-warn', 'Files missing from the game folder or replaced by another tool — click to repair', 'health', m.health.missing ? `${m.health.missing} missing` : `${m.health.replaced} replaced`) : null,
        upd ? tagBtn('tag-info', `Update available: ${upd.name}${upd.version ? ` v${upd.version}` : ''} — click for details`, 'update', upd.version ? `↑ ${upd.version}` : 'Update') : null),
      sub ? h('div', { class: 'subname', title: sub }, sub) : null)),
    h('td', { title: m.type }, h('span', { class: 'type-text' }, m.type)),
    h('td', { class: 'dim', title: m.version || '' }, m.version || '—'),
    h('td', { class: 'dim col-cat', title: m.dependencyOf ? `Installed because ${m.dependencyOf} requires it` : '' }, m.dependencyOf ? 'Dependency' : CAT_LABEL[m.category] || m.category),
    h('td', { class: 'num dim col-files' }, m.fileCount),
    h('td', { class: 'num dim col-prio' }, m.priority),
    h('td', {}, conflictCell(m, byId)));
  })), null);

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
  const enabled = all.filter(m => m.enabled).length;
  const conflicts = Object.keys(state.snap.conflicts).length;
  const updates = Object.keys(state.snap.updates || {}).filter(id => all.some(m => m.id === id));
  const broken = all.filter(m => m.health).length;
  const problems = all.filter(hasProblem).length;
  const sub = $('#mods-sub');
  sub.replaceChildren(all.length ? `${plural(all.length, 'mod')} installed · ${enabled} enabled` : 'Nothing installed yet');
  const link = (text, f, cls = '') => h('button', { class: `link-btn quiet ${cls}`, onclick: () => setModFilter(f) }, text);
  if (broken) sub.append(' · ', link(`${plural(broken, 'mod')} need${broken === 1 ? 's' : ''} repair`, 'repair', 'warn'));
  if (conflicts) sub.append(' · ', link(`${plural(conflicts, 'mod')} with file conflicts`, 'conflicts'));
  if (updates.length) sub.append(' · ', link(`${plural(updates.length, 'update')} available`, 'updates'));

  $('#mods-upd-count').textContent = updates.length || '';
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
  const nav = $('#nav-mods-count');
  nav.textContent = all.length ? `${enabled}/${all.length}` : '';
  nav.classList.toggle('attn', broken > 0);
  nav.title = all.length ? `${enabled} of ${all.length} mods enabled${broken ? ` · ${broken} need repair` : ''}` : '';
  paintModSelection();
}
function setModFilter(f) {
  state.modFilter = f;
  setSegActive('#mods-filter', 'f', f);
  renderMods();
}

$('#mods-search').addEventListener('input', debounce(renderMods, 120));
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

async function modAction(act, ids) {
  const n = ids.length;
  const what = plural(n, 'mod');
  switch (act) {
    case 'enable': return run(api.enable(ids));
    case 'disable': return run(api.disable(ids));
    case 'prioritize': return run(api.prioritize(ids), n === 1 ? 'This mod now wins its file conflicts' : `${what} now win their file conflicts`);
    case 'update': {
      const withUpdate = ids.filter(id => state.snap.updates?.[id]);
      if (!withUpdate.length) { toast('No updates for the selected mods'); return null; }
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
$('#mods-import').addEventListener('click', importArchives);
$('#mods-empty-import').addEventListener('click', importArchives);
$('#mods-redeploy').addEventListener('click', () => run(api.redeploy(), 'Deployment checked'));
$('#mods-update-all').addEventListener('click', () => {
  const ids = Object.keys(state.snap.updates || {}).filter(id => state.snap.mods.some(m => m.id === id));
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

function closeDrawer() {
  $('#drawer').hidden = true;
  state.drawerMod = null;
  state.drawerSig = '';
  if (drawerOpener) restoreFocus(drawerOpener, drawerOpenerKey);
  drawerOpener = null;
}

/** What the drawer shows depends on these; a snapshot that changes none of them leaves it alone. */
const drawerSignature = m => JSON.stringify([m.enabled, m.priority, m.installedAt, m.fileCount, m.warnings, m.health, state.snap.conflicts[m.id], state.snap.updates?.[m.id], state.modLogProblems[m.id]]);

let drawerSeq = 0;

async function openDrawer(id, focusSection = '') {
  const m = state.snap.mods.find(x => x.id === id);
  if (!m) return;
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
  const byId = Object.fromEntries(state.snap.mods.map(x => [x.id, x.name]));
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

  drawer.hidden = false;
  if (focusSection) body.querySelector(`[data-section="${focusSection}"]`)?.scrollIntoView({ block: 'start' });
  else body.scrollTop = keepScroll;
  if (!wasOpen && !drawer.contains(document.activeElement)) $('#drawer-close').focus();
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

// ---------------------------------------------------------------- downloads page

function visibleDownloads() {
  const q = $('#dl-search').value.trim().toLowerCase();
  return state.snap.downloads.filter(d => !q || `${d.name} ${d.fileName} ${d.modName}`.toLowerCase().includes(q));
}

function paintDlSelection() {
  paintSelection($('#dl-table tbody'), state.dlSel, $('#dl-all'), visibleDownloads().map(d => d.key), $('#dl-bulk'), $('#dl-sel-count'), $('#dl-libhead'));
}

function renderDownloads() {
  const list = visibleDownloads();
  const keys = list.map(d => d.key);
  for (const k of [...state.dlSel]) if (!state.snap.downloads.some(d => d.key === k)) state.dlSel.delete(k);
  const groups = new Map();
  for (const d of list) {
    if (!groups.has(d.modName)) groups.set(d.modName, []);
    groups.get(d.modName).push(d);
  }
  const rows = [];
  for (const [name, items] of groups) {
    const first = items[0];
    const sub = [plural(items.length, 'file'), first.author ? `by ${first.author}` : '', first.dependencyOf ? `required by ${first.dependencyOf}` : ''].filter(Boolean).join(' · ');
    rows.push(h('tr', { class: 'group' }, h('td', { colspan: 6, title: name }, name, h('span', { class: 'sub' }, sub))));
    for (const d of items) {
      const status = !d.exists ? h('span', { class: 'status status-err', title: 'The archive is no longer on disk' }, 'Missing')
        : d.installed ? h('span', { class: 'status status-ok' }, 'Installed')
          : h('span', { class: 'status' }, 'Not installed');
      rows.push(h('tr', {
        class: 'row', tabindex: '0', dataset: { id: d.key }, 'aria-selected': 'false', title: 'Double-click or press Enter to install',
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
      h('td', { title: `${d.name}\n${d.fileName}` }, h('div', { class: 'cell-name' }, h('span', { class: 'name' }, d.name), h('span', { class: 'subname' }, d.fileName))),
      h('td', { class: 'dim col-cat' }, CAT_LABEL[d.category] || d.category),
      h('td', { class: 'dim', title: d.version || '' }, d.version || '—'),
      h('td', { class: 'num dim' }, fmtSize(d.size)),
      h('td', {}, status)));
    }
  }
  $('#dl-table tbody').replaceChildren(...rows);
  const total = state.snap.downloads.length;
  const empty = $('#dl-empty');
  empty.hidden = list.length > 0;
  $('#dl-card').classList.toggle('is-empty', list.length === 0);
  empty.querySelector('.empty-title').textContent = total ? 'No matching downloads' : 'No downloads yet';
  empty.querySelector('.empty-text').textContent = total
    ? 'Try another search.'
    : 'Paste a mod link above. Every file from its Files tab is downloaded, along with the mods it requires.';
  $('#dl-lib-count').textContent = total ? `· ${total}` : '';
  paintDlSelection();
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => b.id - a.id);
  const active = jobs.filter(j => ['queued', 'downloading'].includes(j.status)).length;
  const nav = $('#nav-dl-count');
  nav.textContent = active ? `${active}` : (state.snap.downloads.length || '');
  nav.classList.toggle('live', active > 0);
  nav.title = active ? `${active} downloading` : `${state.snap.downloads.length} downloaded`;
  $('#dl-queue-count').textContent = jobs.length ? `· ${active} active` : '';
  $('#dl-clear').disabled = !jobs.some(j => ['done', 'cancelled'].includes(j.status));
  if (!jobs.length) {
    $('#jobs').replaceChildren(h('div', { class: 'empty-inline' }, 'Nothing downloading'));
    return;
  }
  $('#jobs').replaceChildren(...jobs.map(j => {
    const pct = j.total ? Math.min(100, (j.received / j.total) * 100) : (j.status === 'done' ? 100 : 0);
    let meta;
    if (j.status === 'downloading') meta = `${Math.floor(pct)}% · ${fmtSize(j.speed)}/s`;
    else if (j.status === 'done') meta = `Done · ${fmtSize(j.total)}`;
    else if (j.status === 'queued') meta = 'Queued';
    else if (j.status === 'error') meta = 'Failed';
    else meta = 'Cancelled';
    const sub = [j.modName, CAT_LABEL[j.category] || j.category, j.dependencyOf ? `required by ${j.dependencyOf}` : ''].filter(Boolean).join(' · ');
    let action = h('span');
    if (['queued', 'downloading'].includes(j.status)) {
      action = h('button', { class: 'btn btn-sm btn-icon btn-ghost', title: 'Cancel', 'aria-label': `Cancel ${j.name}`, onclick: () => run(api.cancelJob(j.id)) }, icon('x'));
    } else if (['error', 'cancelled'].includes(j.status)) {
      action = h('button', { class: 'btn btn-sm btn-icon', title: 'Retry', 'aria-label': `Retry ${j.name}`, onclick: () => run(api.retryJob(j.id)) }, icon('rotate'));
    }
    return h('div', { class: `job ${j.status}` },
      h('div', { class: 'job-main' },
        h('div', { class: 'name', title: j.name }, j.name),
        j.error ? h('div', { class: 'job-err', title: j.error }, j.error) : h('div', { class: 'subname', title: sub }, sub)),
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': j.name, 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div', { style: `width:${pct.toFixed(1)}%` })),
      h('div', { class: 'job-meta', title: j.status === 'downloading' ? `${fmtSize(j.received)} of ${fmtSize(j.total)}` : '' }, meta),
      action);
  }));
}

$('#dl-search').addEventListener('input', debounce(renderDownloads, 120));
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
    const r = await downloadLinks(text); // features.js: asks which requirements to include
    if (r) {
      const parts = [`${plural(r.queued, 'file')} queued from ${plural(r.mods, 'mod')}`];
      if (r.dependencies) parts.push(`${plural(r.dependencies, 'required mod')} added`);
      if (r.skipped) parts.push(`${r.skipped} already downloaded`);
      if (r.external.length) parts.push(`${r.external.length} requirement(s) not on Nexus — see Activity`);
      if (r.errors.length) parts.push(`${plural(r.errors.length, 'error')} — see Activity`);
      hint.className = r.errors.length ? 'hint bad' : 'hint ok';
      hint.textContent = parts.join(' · ');
      if (!r.errors.length) { linksBox.value = ''; growLinks(); }
    }
  } finally {
    btn.disabled = false;
    label.textContent = 'Download all files';
  }
});
linksBox.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('#dl-go').click(); }
});
$('#dl-clear').addEventListener('click', async () => {
  await run(api.clearJobs());
  for (const [id, j] of state.jobs) if (['done', 'cancelled', 'skipped'].includes(j.status)) state.jobs.delete(id);
  renderJobs();
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
};
const checks = { autoEnable: '#s-autoenable', installDependencies: '#s-deps' };

function readForm() {
  const patch = {};
  for (const [k, sel] of Object.entries(form)) patch[k] = $(sel).value;
  for (const [k, sel] of Object.entries(checks)) patch[k] = $(sel).checked;
  patch.categories = $$('#s-cats input').filter(i => i.checked).map(i => i.value);
  const key = $('#s-apikey').value.trim();
  if (key) patch.apiKey = key;
  return patch;
}

function isDirty() {
  const s = state.settings;
  if (!s) return false;
  const p = readForm();
  if (p.apiKey) return true;
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
  for (const [k, sel] of Object.entries(form)) { $(sel).value = s[k] ?? ''; $(sel).title = String(s[k] ?? ''); }
  for (const [k, sel] of Object.entries(checks)) $(sel).checked = !!s[k];
  $$('#s-cats input').forEach(i => { i.checked = s.categories.includes(i.value); });
  renderStatus();
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
    status.textContent = `Signed in as ${r.ok.name} — ${r.ok.isPremium ? 'Premium: direct downloads enabled' : 'not Premium: Nexus will refuse download links'}`;
    state.keyUser = r.ok;
  }
  await loadSettings();
});
$('#s-game-browse').addEventListener('click', async () => {
  const p = await run(api.pickFolder('Select the Cyberpunk 2077 folder'));
  if (p) { $('#s-game').value = p; updateDirty(); }
});
$('#s-game-detect').addEventListener('click', async () => {
  const s = await run(api.detectGame());
  if (s) await loadSettings();
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
  $('#st-game').textContent = g.valid ? 'Game folder found' : 'Game folder not set';
  $('#st-game-row').title = g.valid ? `Game folder: ${g.path}` : 'Set the Cyberpunk 2077 folder in Settings';
  const s = state.settings;
  const hasKey = s?.hasApiKey;
  $('#st-key-dot').className = `dot ${hasKey ? 'ok' : 'bad'}`;
  const keyText = state.keyUser ? `${state.keyUser.name}${state.keyUser.isPremium ? ' · Premium' : ''}` : hasKey ? 'API key saved' : 'No API key';
  $('#st-key').textContent = keyText;
  $('#st-key-row').title = keyText;
  const r = state.snap.rate || {};
  $('#st-rate').textContent = r.hourly != null ? `API ${r.hourly}/h · ${r.daily}/day left` : '';
  const gs = $('#s-game-status');
  gs.className = g.valid ? 'hint ok' : 'hint bad';
  gs.textContent = g.valid ? 'Cyberpunk2077.exe found' : 'bin\\x64\\Cyberpunk2077.exe was not found in this folder';
  // Downloads can't work without a key: say so before the user tries.
  const banner = $('#dl-keybanner');
  banner.hidden = !s || (hasKey && (!state.keyUser || state.keyUser.isPremium));
  $('#dl-keybanner-text').textContent = hasKey
    ? 'Your Nexus account is not Premium, so Nexus will refuse direct download links.'
    : 'Add your Nexus Mods API key in Settings before downloading. Direct downloads need a Premium account.';
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
});
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

function applySnapshot(snap) {
  state.snap = snap;
  for (const j of snap.jobs) state.jobs.set(j.id, j);
  for (const id of [...state.jobs.keys()]) if (!snap.jobs.some(j => j.id === id)) state.jobs.delete(id);
  snapshotHooks.forEach(fn => fn(snap));
  renderMods();
  renderDownloads();
  renderJobs();
  renderStatus();
  if (state.drawerMod) {
    const m = snap.mods.find(x => x.id === state.drawerMod);
    if (!m) closeDrawer();
    else if (drawerSignature(m) !== state.drawerSig) openDrawer(m.id);
  }
}

let jobRenderPending = false;
api.onJob(job => {
  state.jobs.set(job.id, job);
  if (!jobRenderPending) {
    jobRenderPending = true;
    requestAnimationFrame(() => { jobRenderPending = false; renderJobs(); });
  }
});
api.onSnapshot(applySnapshot);
api.onLog(addLog);
api.onFomod(enqueueFomod);

window.addEventListener('DOMContentLoaded', async () => {
  const logs = await run(api.logs());
  (logs || []).forEach(addLog);
  await loadSettings();
  const snap = await run(api.snapshot());
  if (snap) applySnapshot(snap);
});
