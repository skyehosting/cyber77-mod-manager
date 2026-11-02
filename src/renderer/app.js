'use strict';
/* global api, Fomod */

// ---------------------------------------------------------------- helpers

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

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

const fmtSize = b => {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const CAT_LABEL = { MAIN: 'Main', UPDATE: 'Update', OPTIONAL: 'Optional', OLD_VERSION: 'Old version', MISCELLANEOUS: 'Misc', ARCHIVED: 'Archived', LOCAL: 'Local file' };

function toast(msg, kind = 'info') {
  const el = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

/** Call the API; errors are already in the console, so just toast them. */
async function run(promise, okMsg) {
  const res = await promise;
  if (res && res.error) { toast(res.error, 'error'); return null; }
  if (okMsg) toast(okMsg, 'success');
  return res ? res.ok : null;
}

window.addEventListener('error', e => api.reportError(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => api.reportError(e.reason?.stack || e.reason));

// ---------------------------------------------------------------- state

const state = {
  snap: { mods: [], downloads: [], jobs: [], conflicts: {}, game: {}, rate: {} },
  jobs: new Map(),
  settings: null,
  modSel: new Set(),
  dlSel: new Set(),
  modFilter: 'all',
  lastModClick: null,
  lastDlClick: null,
  drawerMod: null,
};

// ---------------------------------------------------------------- navigation

$$('.nav-item').forEach(btn => btn.addEventListener('click', () => {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${btn.dataset.page}`));
  if (btn.dataset.page === 'settings') loadSettings();
}));

// ---------------------------------------------------------------- confirm modal

function modal({ title, sub, body, wide, buttons }) {
  return new Promise(resolve => {
    const m = $('#modal');
    m.className = `modal${wide ? ' wide' : ''}`;
    m.replaceChildren(
      h('div', { class: 'modal-head' }, h('h3', {}, title), sub ? h('div', { class: 'sub' }, sub) : null),
      h('div', { class: 'modal-body' }, body || ''),
      h('div', { class: 'modal-foot' }, ...buttons.map(b => h('button', {
        class: `btn ${b.kind || ''}`, onclick: () => { close(); resolve(b.value); },
      }, b.label))),
    );
    $('#modal-back').hidden = false;
    const close = () => { $('#modal-back').hidden = true; };
  });
}

function confirmBox(title, text, okLabel = 'Continue', danger = false) {
  return modal({
    title, body: h('p', {}, text),
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }],
  });
}

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

// ---------------------------------------------------------------- mods page

function visibleMods() {
  const q = $('#mods-search').value.trim().toLowerCase();
  return state.snap.mods.filter(m => {
    if (q && !`${m.name} ${m.modName} ${m.type}`.toLowerCase().includes(q)) return false;
    if (state.modFilter === 'enabled') return m.enabled;
    if (state.modFilter === 'disabled') return !m.enabled;
    if (state.modFilter === 'conflicts') return !!state.snap.conflicts[m.id];
    return true;
  });
}

function renderMods() {
  const mods = visibleMods();
  const ids = mods.map(m => m.id);
  for (const id of [...state.modSel]) if (!state.snap.mods.some(m => m.id === id)) state.modSel.delete(id);
  const byId = Object.fromEntries(state.snap.mods.map(m => [m.id, m]));
  const tbody = $('#mods-table tbody');
  tbody.replaceChildren(...mods.map(m => {
    const c = state.snap.conflicts[m.id];
    const sel = state.modSel.has(m.id);
    let conflict = '';
    if (c) {
      const others = c.with.map(id => byId[id]?.name || id).join(', ');
      conflict = h('span', {},
        c.wins ? h('span', { class: 'tag ok', title: `Wins over: ${others}` }, `wins ${c.wins}`) : null,
        c.loses ? h('span', { class: 'tag warn', title: `Overwritten by: ${others}` }, `loses ${c.loses}`) : null);
    }
    const tr = h('tr', {
      class: `row${sel ? ' selected' : ''}`,
      onclick: ev => {
        if (ev.target.closest('input,button')) return;
        clickSelect(state.modSel, ids, m.id, ev, 'lastModClick');
        renderMods();
      },
      ondblclick: () => openDrawer(m.id),
    },
    h('td', {}, h('input', {
      type: 'checkbox', checked: sel,
      onclick: ev => { ev.stopPropagation(); },
      onchange: ev => { if (ev.target.checked) state.modSel.add(m.id); else state.modSel.delete(m.id); state.lastModClick = m.id; renderMods(); },
    })),
    h('td', {}, h('button', {
      class: `switch${m.enabled ? ' on' : ''}`, title: m.enabled ? 'Disable' : 'Enable',
      onclick: async ev => { ev.stopPropagation(); await run(m.enabled ? api.disable([m.id]) : api.enable([m.id])); },
    })),
    h('td', {},
      h('div', { class: 'name' }, m.name, m.warnings?.length ? h('span', { class: 'tag warn', title: m.warnings.join('\n'), style: 'margin-left:6px' }, '!') : null),
      h('div', { class: 'subname' }, m.modName !== m.name ? m.modName : '', m.author ? ` · ${m.author}` : '')),
    h('td', {}, h('span', { class: 'tag cyan' }, m.type)),
    h('td', {}, m.version || '—'),
    h('td', {}, CAT_LABEL[m.category] || m.category),
    h('td', { class: 'num' }, m.fileCount),
    h('td', { class: 'num' }, m.priority),
    h('td', {}, conflict));
    return tr;
  }));
  $('#mods-empty').hidden = mods.length > 0;
  $('#mods-empty').textContent = state.snap.mods.length
    ? 'No mods match this filter.'
    : 'No mods installed yet. Add a Nexus link on the Downloads page, or install an archive from a file.';
  const n = state.modSel.size;
  $('#mods-sel-count').textContent = `${n} selected`;
  $$('#mods-bulk .btn').forEach(b => { b.disabled = n === 0; });
  const all = $('#mods-all');
  all.checked = ids.length > 0 && ids.every(id => state.modSel.has(id));
  all.indeterminate = !all.checked && ids.some(id => state.modSel.has(id));
  $('#nav-mods-count').textContent = `${state.snap.mods.filter(m => m.enabled).length}/${state.snap.mods.length}`;
}

$('#mods-search').addEventListener('input', renderMods);
$$('#mods-filter .seg-btn').forEach(b => b.addEventListener('click', () => {
  $$('#mods-filter .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  state.modFilter = b.dataset.f;
  renderMods();
}));
$('#mods-all').addEventListener('change', ev => {
  const ids = visibleMods().map(m => m.id);
  ids.forEach(id => (ev.target.checked ? state.modSel.add(id) : state.modSel.delete(id)));
  renderMods();
});
document.addEventListener('keydown', ev => {
  if (ev.ctrlKey && ev.key.toLowerCase() === 'a' && $('#page-mods').classList.contains('active') && !ev.target.closest('input,textarea')) {
    ev.preventDefault();
    visibleMods().forEach(m => state.modSel.add(m.id));
    renderMods();
  }
  if (ev.key === 'Escape') { $('#drawer').hidden = true; }
});

$$('#mods-bulk .btn').forEach(b => b.addEventListener('click', async () => {
  const ids = [...state.modSel];
  if (!ids.length) return;
  const n = ids.length;
  switch (b.dataset.act) {
    case 'enable': await run(api.enable(ids)); break;
    case 'disable': await run(api.disable(ids)); break;
    case 'prioritize': await run(api.prioritize(ids)); break;
    case 'reinstall':
      if (await confirmBox('Reinstall', `Reinstall ${n} mod(s) from their downloaded archives? FOMOD mods will ask for their options again.`)) await run(api.reinstall(ids));
      break;
    case 'uninstall':
      if (await confirmBox('Uninstall', `Uninstall ${n} mod(s)? Their files leave the game folder; the downloaded archives stay in the library.`, 'Uninstall', true)) {
        await run(api.uninstall(ids), `Uninstalled ${n} mod(s)`);
        state.modSel.clear();
      }
      break;
    case 'delete': {
      const keys = state.snap.mods.filter(m => ids.includes(m.id)).map(m => m.key);
      if (await confirmBox('Delete', `Uninstall ${n} mod(s) AND delete their downloaded archives? This cannot be undone.`, 'Delete', true)) {
        await run(api.deleteDownloads(keys), `Deleted ${n} mod(s)`);
        state.modSel.clear();
      }
      break;
    }
    default:
  }
}));

$('#mods-import').addEventListener('click', () => run(api.importArchives()));
$('#mods-redeploy').addEventListener('click', () => run(api.redeploy(), 'Deployment checked'));
$('#mods-purge').addEventListener('click', async () => {
  if (await confirmBox('Disable all mods', 'Take every mod out of the game folder and restore any original files? Mods stay installed and can be enabled again.', 'Disable all', true)) {
    await run(api.purge());
  }
});

// ---------------------------------------------------------------- mod details drawer

async function openDrawer(id) {
  const m = state.snap.mods.find(x => x.id === id);
  if (!m) return;
  state.drawerMod = id;
  $('#drawer-title').textContent = m.name;
  $('#drawer-sub').textContent = `${m.modName}${m.version ? ` · v${m.version}` : ''}`;
  const files = (await run(api.modFiles(id))) || [];
  const byId = Object.fromEntries(state.snap.mods.map(x => [x.id, x.name]));
  $('#drawer-body').replaceChildren(...[
    h('div', { class: 'kv' },
      h('div', {}, 'Status'), h('div', {}, m.enabled ? 'Enabled' : 'Disabled'),
      h('div', {}, 'Type'), h('div', {}, m.type),
      h('div', {}, 'Category'), h('div', {}, CAT_LABEL[m.category] || m.category),
      h('div', {}, 'Priority'), h('div', {}, m.priority),
      h('div', {}, 'Installed'), h('div', {}, new Date(m.installedAt).toLocaleString()),
      h('div', {}, 'Skipped files'), h('div', {}, m.skipped || 0),
      m.modId ? h('div', {}, 'Nexus') : null,
      m.modId ? h('div', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); api.openNexus(m.game, m.modId); } }, `Mod page #${m.modId}`)) : null),
    m.warnings?.length ? h('div', {}, h('h2', {}, 'Warnings'), h('ul', { class: 'warnlist' }, m.warnings.map(w => h('li', {}, w)))) : null,
    h('h2', { style: 'margin:12px 0 6px' }, `Files (${files.length})`),
    h('div', { class: 'filelist' }, files.map(f => h('div', {},
      h('span', {}, f.dest),
      m.enabled && !f.deployed ? h('span', { class: 'lost', title: f.owner ? `Provided by ${byId[f.owner] || f.owner}` : 'Not deployed' }, f.owner ? 'overridden' : 'missing') : null))),
  ].filter(Boolean));
  $('#drawer').hidden = false;
}
$('#drawer-close').addEventListener('click', () => { $('#drawer').hidden = true; });

// ---------------------------------------------------------------- downloads page

function visibleDownloads() {
  const q = $('#dl-search').value.trim().toLowerCase();
  return state.snap.downloads.filter(d => !q || `${d.name} ${d.fileName} ${d.modName}`.toLowerCase().includes(q));
}

function renderDownloads() {
  const list = visibleDownloads();
  const keys = list.map(d => d.key);
  for (const k of [...state.dlSel]) if (!state.snap.downloads.some(d => d.key === k)) state.dlSel.delete(k);
  const rows = [];
  let group = null;
  for (const d of list) {
    if (d.modName !== group) {
      group = d.modName;
      const count = list.filter(x => x.modName === group).length;
      rows.push(h('tr', { class: 'group' }, h('td', { colspan: 6 }, group, h('span', { class: 'sub' }, `${count} file(s)${d.author ? ` · by ${d.author}` : ''}`))));
    }
    const sel = state.dlSel.has(d.key);
    const status = !d.exists ? h('span', { class: 'tag err' }, 'Missing')
      : d.installed ? h('span', { class: 'tag ok' }, 'Installed')
        : h('span', { class: 'tag' }, 'Not installed');
    rows.push(h('tr', {
      class: `row${sel ? ' selected' : ''}`,
      onclick: ev => {
        if (ev.target.closest('input,button')) return;
        clickSelect(state.dlSel, keys, d.key, ev, 'lastDlClick');
        renderDownloads();
      },
      ondblclick: () => run(api.install([d.key])),
    },
    h('td', {}, h('input', {
      type: 'checkbox', checked: sel,
      onclick: ev => ev.stopPropagation(),
      onchange: ev => { if (ev.target.checked) state.dlSel.add(d.key); else state.dlSel.delete(d.key); state.lastDlClick = d.key; renderDownloads(); },
    })),
    h('td', {}, h('div', { class: 'name' }, d.name), h('div', { class: 'subname' }, d.fileName)),
    h('td', {}, CAT_LABEL[d.category] || d.category),
    h('td', {}, d.version || '—'),
    h('td', { class: 'num' }, fmtSize(d.size)),
    h('td', {}, status)));
  }
  $('#dl-table tbody').replaceChildren(...rows);
  $('#dl-empty').hidden = list.length > 0;
  const n = state.dlSel.size;
  $('#dl-sel-count').textContent = `${n} selected`;
  $$('#dl-bulk .btn').forEach(b => { b.disabled = n === 0; });
  const all = $('#dl-all');
  all.checked = keys.length > 0 && keys.every(k => state.dlSel.has(k));
  all.indeterminate = !all.checked && keys.some(k => state.dlSel.has(k));
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => b.id - a.id);
  const active = jobs.filter(j => ['queued', 'downloading'].includes(j.status)).length;
  const nav = $('#nav-dl-count');
  nav.textContent = active ? `${active} active` : state.snap.downloads.length;
  nav.classList.toggle('live', active > 0);
  if (!jobs.length) {
    $('#jobs').replaceChildren(h('div', { class: 'empty small' }, 'Nothing downloading.'));
    return;
  }
  $('#jobs').replaceChildren(...jobs.map(j => {
    const pct = j.total ? Math.min(100, (j.received / j.total) * 100) : (j.status === 'done' ? 100 : 0);
    let meta = '';
    if (j.status === 'downloading') meta = `${fmtSize(j.received)} / ${fmtSize(j.total)} · ${fmtSize(j.speed)}/s`;
    else if (j.status === 'done') meta = `Done · ${fmtSize(j.total)}`;
    else meta = j.status[0].toUpperCase() + j.status.slice(1);
    return h('div', { class: `job ${j.status}` },
      h('div', { style: 'min-width:0' },
        h('div', { class: 'name', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, j.name),
        h('div', { class: 'subname' }, `${j.modName} · ${CAT_LABEL[j.category] || j.category}`),
        j.error ? h('div', { class: 'job-err', title: j.error }, j.error) : null),
      h('div', { class: 'bar' }, h('div', { style: `width:${pct.toFixed(1)}%` })),
      h('div', { class: 'job-meta' }, meta),
      ['queued', 'downloading'].includes(j.status)
        ? h('button', { class: 'btn small', onclick: () => run(api.cancelJob(j.id)) }, 'Cancel')
        : ['error', 'cancelled'].includes(j.status)
          ? h('button', { class: 'btn small', onclick: () => run(api.retryJob(j.id)) }, 'Retry')
          : h('span'));
  }));
}

$('#dl-search').addEventListener('input', renderDownloads);
$('#dl-all').addEventListener('change', ev => {
  visibleDownloads().forEach(d => (ev.target.checked ? state.dlSel.add(d.key) : state.dlSel.delete(d.key)));
  renderDownloads();
});
$('#dl-go').addEventListener('click', async () => {
  const text = $('#dl-links').value;
  const btn = $('#dl-go');
  btn.disabled = true;
  btn.textContent = 'Reading files…';
  const hint = $('#dl-hint');
  hint.className = 'hint';
  hint.textContent = '';
  try {
    const r = await run(api.addLinks(text));
    if (r) {
      hint.className = r.errors.length ? 'hint bad' : 'hint ok';
      hint.textContent = `${r.mods} mod(s): ${r.queued} file(s) queued, ${r.skipped} already downloaded${r.errors.length ? ` · ${r.errors.length} error(s), see console` : ''}`;
      if (!r.errors.length) $('#dl-links').value = '';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download all files';
  }
});
$('#dl-links').addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.ctrlKey) $('#dl-go').click(); });
$('#dl-clear').addEventListener('click', async () => {
  await run(api.clearJobs());
  for (const [id, j] of state.jobs) if (['done', 'cancelled', 'skipped'].includes(j.status)) state.jobs.delete(id);
  renderJobs();
});
$('#dl-open-folder').addEventListener('click', () => run(api.openPath('downloads')));
$$('#dl-bulk .btn').forEach(b => b.addEventListener('click', async () => {
  const keys = [...state.dlSel];
  if (!keys.length) return;
  if (b.dataset.act === 'install') await run(api.install(keys));
  if (b.dataset.act === 'installEnable') await run(api.installAndEnable(keys));
  if (b.dataset.act === 'delete') {
    const installed = state.snap.downloads.filter(d => keys.includes(d.key) && d.installed).length;
    const extra = installed ? ` ${installed} of them are installed and will be uninstalled first.` : '';
    if (await confirmBox('Delete downloads', `Delete ${keys.length} downloaded archive(s)?${extra}`, 'Delete', true)) {
      await run(api.deleteDownloads(keys), 'Deleted');
      state.dlSel.clear();
    }
  }
}));

// ---------------------------------------------------------------- settings page

async function loadSettings() {
  const s = await run(api.getSettings());
  if (!s) return;
  state.settings = s;
  $('#s-apikey').value = '';
  $('#s-apikey').placeholder = s.hasApiKey ? `Saved (${s.apiKeyHint}) — paste a new key to replace it` : 'Paste your key from nexusmods.com → Site preferences → API keys';
  $('#s-game').value = s.gamePath || '';
  $('#s-deploy').value = s.deployMethod;
  $('#s-conc').value = s.concurrentDownloads;
  $('#s-auto').value = s.autoInstall;
  $('#s-autoenable').checked = !!s.autoEnable;
  $('#s-data').value = s.dataDir;
  $('#s-7z').value = s.sevenZipPath;
  $$('#s-cats input').forEach(i => { i.checked = s.categories.includes(i.value); });
  renderStatus();
}

function settingsPatch() {
  const patch = {
    gamePath: $('#s-game').value,
    deployMethod: $('#s-deploy').value,
    concurrentDownloads: $('#s-conc').value,
    autoInstall: $('#s-auto').value,
    autoEnable: $('#s-autoenable').checked,
    dataDir: $('#s-data').value,
    sevenZipPath: $('#s-7z').value,
    categories: $$('#s-cats input').filter(i => i.checked).map(i => i.value),
  };
  const key = $('#s-apikey').value.trim();
  if (key) patch.apiKey = key;
  return patch;
}

$('#settings-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const s = await run(api.setSettings(settingsPatch()), 'Settings saved');
  if (s) await loadSettings();
});
$('#s-validate').addEventListener('click', async () => {
  const status = $('#s-key-status');
  if ($('#s-apikey').value.trim()) await run(api.setSettings(settingsPatch()));
  status.className = 'hint';
  status.textContent = 'Checking…';
  const r = await api.validateKey();
  if (r.error) {
    status.className = 'hint bad';
    status.textContent = r.error;
  } else {
    status.className = r.ok.isPremium ? 'hint ok' : 'hint bad';
    status.textContent = `Signed in as ${r.ok.name} — ${r.ok.isPremium ? 'Premium: direct downloads enabled' : 'not Premium: Nexus will refuse API download links'}`;
    state.keyUser = r.ok;
  }
  await loadSettings();
});
$('#s-game-browse').addEventListener('click', async () => {
  const p = await run(api.pickFolder('Select the Cyberpunk 2077 folder'));
  if (p) $('#s-game').value = p;
});
$('#s-game-detect').addEventListener('click', async () => {
  const s = await run(api.detectGame());
  if (s) $('#s-game').value = s.gamePath;
});
$('#s-data-browse').addEventListener('click', async () => {
  const p = await run(api.pickFolder('Select a data folder'));
  if (p) $('#s-data').value = p;
});
$('#s-7z-browse').addEventListener('click', async () => {
  const p = await run(api.pickFile('Select 7z.exe', [{ name: '7-Zip', extensions: ['exe'] }]));
  if (p && p[0]) $('#s-7z').value = p[0];
});
$$('[data-open]').forEach(b => b.addEventListener('click', () => run(api.openPath(b.dataset.open))));

function renderStatus() {
  const g = state.snap.game || {};
  $('#st-game-dot').className = `dot ${g.valid ? 'ok' : 'bad'}`;
  $('#st-game').textContent = g.valid ? 'Game folder found' : 'Game folder not set';
  $('#st-game').title = g.path || '';
  const s = state.settings;
  const hasKey = s?.hasApiKey;
  $('#st-key-dot').className = `dot ${hasKey ? 'ok' : 'bad'}`;
  $('#st-key').textContent = state.keyUser ? `${state.keyUser.name}${state.keyUser.isPremium ? ' · Premium' : ''}` : hasKey ? 'API key saved' : 'No API key';
  const r = state.snap.rate || {};
  $('#st-rate').textContent = r.hourly != null ? `API: ${r.hourly} left this hour · ${r.daily} today` : '';
  const gs = $('#s-game-status');
  if (gs && $('#page-settings').classList.contains('active')) {
    gs.className = g.valid ? 'hint ok' : 'hint bad';
    gs.textContent = g.valid ? 'Cyberpunk2077.exe found.' : 'bin\\x64\\Cyberpunk2077.exe not found in this folder.';
  }
}

// ---------------------------------------------------------------- console

const con = { entries: [], filter: 'all', errs: 0, warns: 0 };

function logLine(e) {
  return h('div', { class: `log ${e.level}` },
    h('span', { class: 't' }, fmtTime(e.time)),
    h('span', { class: 'lv' }, e.level.toUpperCase()),
    e.message,
    e.detail ? h('span', { class: 'd' }, e.detail) : null);
}

function shown(e) {
  if (con.filter === 'error') return e.level === 'error';
  if (con.filter === 'warn') return e.level === 'warn' || e.level === 'error';
  return true;
}

function addLog(e) {
  con.entries.push(e);
  if (con.entries.length > 2000) con.entries.shift();
  if (e.level === 'error') con.errs++;
  if (e.level === 'warn') con.warns++;
  const body = $('#console-body');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
  if (shown(e)) body.append(logLine(e));
  while (body.childElementCount > 2000) body.firstElementChild.remove();
  if (atBottom) body.scrollTop = body.scrollHeight;
  $('#console-last').textContent = e.message;
  updateBadges();
  if (e.level === 'error' && !document.body.classList.contains('console-open')) {
    document.body.classList.add('console-open');
    body.scrollTop = body.scrollHeight;
  }
}

function updateBadges() {
  $('#console-errs').hidden = !con.errs;
  $('#console-errs').textContent = `${con.errs} error${con.errs === 1 ? '' : 's'}`;
  $('#console-warns').hidden = !con.warns;
  $('#console-warns').textContent = `${con.warns} warning${con.warns === 1 ? '' : 's'}`;
}

function rerenderConsole() {
  const body = $('#console-body');
  body.replaceChildren(...con.entries.filter(shown).map(logLine));
  body.scrollTop = body.scrollHeight;
}

$('#console-toggle').addEventListener('click', () => {
  document.body.classList.toggle('console-open');
  $('#console-body').scrollTop = $('#console-body').scrollHeight;
});
$$('#console-filter .seg-btn').forEach(b => b.addEventListener('click', () => {
  $$('#console-filter .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  con.filter = b.dataset.f;
  rerenderConsole();
}));
$('#console-clear').addEventListener('click', () => {
  con.entries = [];
  con.errs = 0;
  con.warns = 0;
  updateBadges();
  rerenderConsole();
  $('#console-last').textContent = '';
});
$('#console-copy').addEventListener('click', async () => {
  const text = con.entries.filter(shown).map(e => `[${new Date(e.time).toISOString()}] ${e.level.toUpperCase()} ${e.message}${e.detail ? `\n  ${e.detail}` : ''}`).join('\n');
  await navigator.clipboard.writeText(text);
  toast('Console copied');
});

// ---------------------------------------------------------------- FOMOD wizard

const fomodQueue = [];
let fomodBusy = false;

function enqueueFomod(req) {
  fomodQueue.push(req);
  if (!fomodBusy) nextFomod();
}

async function nextFomod() {
  const req = fomodQueue.shift();
  if (!req) { fomodBusy = false; return; }
  fomodBusy = true;
  const selections = await runWizard(req);
  if (selections) await run(api.fomodSubmit(req.token, selections), `Installed ${req.name}`);
  else await run(api.fomodCancel(req.token));
  nextFomod();
}

/** Walk the visible install steps; resolves with { step: { group: [pluginIdx] } } or null. */
function runWizard(req) {
  const cfg = req.config;
  const states = req.fileStates || {};
  const selections = {};
  let pos = 0;

  const ensureDefaults = si => {
    if (selections[si]) return;
    const flags = Fomod.flagsBefore(cfg, selections, states, si);
    selections[si] = {};
    cfg.steps[si].groups.forEach((g, gi) => { selections[si][gi] = Fomod.defaultSelection(g, flags, states); });
  };

  return new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal wide';
    $('#modal-back').hidden = false;
    const finish = v => { $('#modal-back').hidden = true; resolve(v); };

    if (!cfg.steps.length) { finish({}); return; }

    const render = () => {
      const visible = Fomod.visibleSteps(cfg, selections, states);
      if (!visible.length) { finish({}); return; }
      pos = Math.min(pos, visible.length - 1);
      const si = visible[pos];
      ensureDefaults(si);
      const step = cfg.steps[si];
      const flags = Fomod.flagsBefore(cfg, selections, states, si);
      const info = h('div', { class: 'fomod-info' });
      const showInfo = p => {
        info.replaceChildren(...[
          p.image ? h('img', { src: req.imageBase + p.image.split('/').map(encodeURIComponent).join('/'), alt: '', onerror: e => e.target.remove() }) : null,
          h('div', { class: 'name', style: 'margin-bottom:6px' }, p.name),
          h('div', { class: 'desc' }, p.description || 'No description.'),
        ].filter(Boolean));
      };
      const errLine = h('span', { class: 'left' });

      const groups = step.groups.map((g, gi) => {
        const single = g.type === 'SelectExactlyOne' || g.type === 'SelectAtMostOne';
        const typeLabel = { SelectExactlyOne: 'choose one', SelectAtMostOne: 'choose one or none', SelectAtLeastOne: 'choose at least one', SelectAll: 'all required', SelectAny: 'choose any' }[g.type] || g.type;
        return h('div', { class: 'fgroup' },
          h('div', { class: 'fgroup-name' }, g.name || 'Options', h('span', { class: 'tag' }, typeLabel)),
          g.plugins.map((p, pi) => {
            const type = Fomod.pluginType(p, flags, states);
            const locked = type === 'Required' || g.type === 'SelectAll';
            const disabled = type === 'NotUsable';
            const sel = selections[si][gi];
            const checked = sel.includes(pi);
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
              },
            });
            return h('label', {
              class: `fopt${disabled ? ' disabled' : ''}`,
              onmouseenter: () => showInfo(p),
              onclick: ev => {
                // Clicking a selected radio in an "at most one" group clears it.
                if (single && g.type === 'SelectAtMostOne' && checked && ev.target === input) {
                  ev.preventDefault();
                  selections[si][gi] = [];
                  render();
                }
              },
            }, input, h('div', {}, h('div', {}, p.name),
              type !== 'Optional' ? h('span', { class: `tag ${type === 'Recommended' ? 'ok' : type === 'NotUsable' ? 'err' : ''}`, style: 'margin-top:3px' }, type) : null));
          }));
      });
      const firstSel = step.groups.flatMap((g, gi) => selections[si][gi].map(pi => g.plugins[pi]))[0] || step.groups[0]?.plugins[0];
      if (firstSel) showInfo(firstSel);

      const isLast = pos === visible.length - 1;
      m.replaceChildren(
        h('div', { class: 'modal-head' },
          h('h3', {}, `${cfg.moduleName || req.name} — ${step.name}`),
          h('div', { class: 'sub steps' }, `${req.name} · step ${pos + 1} of ${visible.length}`)),
        h('div', { class: 'modal-body' }, h('div', { class: 'fomod' }, h('div', { class: 'fomod-groups' }, groups), info)),
        h('div', { class: 'modal-foot' },
          errLine,
          h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
          h('button', { class: 'btn', disabled: pos === 0, onclick: () => { pos--; render(); } }, 'Back'),
          h('button', {
            class: 'btn primary',
            onclick: () => {
              const problems = step.groups.map((g, gi) => Fomod.validateGroup(g, selections[si][gi])).filter(Boolean);
              if (problems.length) { errLine.textContent = problems[0]; return; }
              if (isLast) {
                // Only keep choices for steps that are still visible.
                const out = {};
                for (const v of Fomod.visibleSteps(cfg, selections, states)) { ensureDefaults(v); out[v] = selections[v]; }
                finish(out);
              } else { pos++; render(); }
            },
          }, isLast ? 'Install' : 'Next')),
      );
    };
    render();
  });
}

// ---------------------------------------------------------------- wiring

function applySnapshot(snap) {
  state.snap = snap;
  for (const j of snap.jobs) state.jobs.set(j.id, j);
  for (const id of [...state.jobs.keys()]) if (!snap.jobs.some(j => j.id === id)) state.jobs.delete(id);
  renderMods();
  renderDownloads();
  renderJobs();
  renderStatus();
  if (!$('#drawer').hidden && state.drawerMod) {
    if (snap.mods.some(m => m.id === state.drawerMod)) openDrawer(state.drawerMod);
    else $('#drawer').hidden = true;
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

(async () => {
  const logs = await run(api.logs());
  (logs || []).forEach(addLog);
  await loadSettings();
  const snap = await run(api.snapshot());
  if (snap) applySnapshot(snap);
  if (state.settings && !state.settings.hasApiKey) {
    toast('Add your Nexus Mods API key on the Settings page to start downloading.');
  }
})();
