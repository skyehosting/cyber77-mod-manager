'use strict';
/* global api, $, $$, h, icon, run, toast, plural, state, store, debounce, pageHooks, snapshotHooks, setSegActive, downloadLinks, goTo */

// ---------------------------------------------------------------- Browse Nexus

const GAME = 'cyberpunk2077';
const modPage = (modId, tab = 'description') => `https://www.nexusmods.com/${GAME}/mods/${modId}?tab=${tab}`;
const fmtCount = n => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const fmtIsoDay = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

const br = {
  q: '',
  category: '',
  sort: store.get('browse.sort', 'endorsements'),
  perPage: store.get('browse.perPage', 20),
  adult: true, // adult mods are always included
  page: 1,
  result: null,
  seq: 0,          // a newer search makes an older answer stale
  loaded: false,   // the first search runs when the page is first opened
  mod: null,       // the mod open in the page view
  tab: 'description',
};

/** Mod ids this app or Vortex already has, to mark them in the results. */
function installedIds() {
  const ids = new Map();
  for (const m of state.snap.mods || []) if (m.modId) ids.set(m.modId, m.enabled || ids.get(m.modId) || false);
  for (const m of state.snap.vortex?.mods || []) if (m.modId) ids.set(m.modId, m.enabled || ids.get(m.modId) || false);
  return ids;
}

async function search() {
  const seq = ++br.seq;
  const status = $('#browse-status');
  status.textContent = 'Searching…';
  status.classList.add('busy');
  const res = await api.searchMods({ query: br.q, category: br.category, sort: br.sort, adult: br.adult, page: br.page, perPage: br.perPage });
  if (seq !== br.seq) return; // the user typed on; a newer search is on its way
  status.classList.remove('busy');
  if (res.error) {
    br.result = null;
    status.textContent = res.error;
    $('#browse-grid').replaceChildren();
    $('#browse-pager').hidden = true;
    return;
  }
  br.result = res.ok;
  renderResults();
}
const searchSoon = debounce(() => { br.page = 1; search(); }, 280);

function renderResults() {
  const r = br.result;
  if (!r) return;
  const have = installedIds();
  const pages = Math.max(1, Math.ceil(r.total / r.perPage));
  $('#browse-status').textContent = r.total || r.mods.length
    ? `${r.total.toLocaleString()} mod${r.total === 1 ? '' : 's'}${br.q ? ` matching "${br.q}"` : ''}${br.category ? ` in ${br.category}` : ''}${r.exact ? ` · mod ${br.q} first` : ''}`
    : `Nothing found${br.q ? ` for "${br.q}"` : ''}. Try fewer words, or another category.`;
  $('#browse-grid').replaceChildren(...r.mods.map(m => {
    const owned = have.has(m.modId);
    const open = () => openMod(m);
    return h('article', { class: 'mod-card', dataset: { id: m.modId } },
      h('button', { class: 'mod-card-hit', 'aria-label': `${m.name} — open its page`, onclick: open }),
      h('div', { class: 'mod-thumb' },
        m.thumbnail ? h('img', { src: m.thumbnail, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }) : icon('package'),
        owned ? h('span', { class: `tag ${have.get(m.modId) ? 'tag-ok' : ''} mod-owned` }, have.get(m.modId) ? 'Installed' : 'Installed · off') : null,
        m.adult ? h('span', { class: 'tag tag-warn mod-adult' }, 'Adult') : null),
      h('div', { class: 'mod-body' },
        h('div', { class: 'mod-name', title: m.name }, m.name),
        h('div', { class: 'mod-by', title: m.updatedAt ? `Updated ${fmtIsoDay(m.updatedAt)}` : '' }, [m.author ? `by ${m.author}` : '', m.category, fmtIsoDay(m.updatedAt)].filter(Boolean).join(' · ')),
        h('p', { class: 'mod-summary', title: m.summary }, m.summary),
        h('div', { class: 'mod-foot' },
          h('span', { class: 'mod-stat', title: `${m.endorsements.toLocaleString()} endorsements` }, icon('heart'), fmtCount(m.endorsements)),
          h('span', { class: 'mod-stat', title: `${m.downloads.toLocaleString()} downloads` }, icon('download'), fmtCount(m.downloads)),
          h('button', { class: 'btn btn-sm btn-primary mod-get', title: `Choose files of ${m.name} to download`, onclick: ev => { ev.stopPropagation(); quickDownload(m.modId); } }, icon('download'), h('span', {}, 'Download')))));
  }));
  $('#browse-pager').hidden = pages <= 1;
  $('#browse-page').textContent = `Page ${r.page} of ${pages.toLocaleString()}`;
  $('#browse-prev').disabled = r.page <= 1;
  $('#browse-next').disabled = r.page >= pages;
}

/** Download through this app: the file picker opens with every file of the mod. */
async function quickDownload(modId) {
  const res = await downloadLinks(`https://www.nexusmods.com/${GAME}/mods/${modId}`);
  if (res?.queued) toast(`Downloading ${plural(res.queued, 'file')}`, 'success', { label: 'Show', fn: () => goTo('downloads') });
}

// ---------------------------------------------------------------- one mod's pages

let view = null; // the <webview>, made once and reused

function showTab(tab, pageUrl = '') {
  br.tab = tab;
  setSegActive('#bd-tabs', 'tab', tab);
  $$('#bd-tabs .seg-btn').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'));
  const url = pageUrl || modPage(br.mod.modId, tab);
  if (!view) {
    view = document.createElement('webview');
    view.className = 'nexus-view';
    view.setAttribute('partition', 'persist:nexus');
    view.setAttribute('src', url);
    view.addEventListener('did-start-loading', () => { $('#bd-load').hidden = false; });
    // Nexus pages keep loading ads long after the page itself is there.
    view.addEventListener('dom-ready', () => { $('#bd-load').hidden = true; });
    view.addEventListener('did-stop-loading', () => { $('#bd-load').hidden = true; });
    view.addEventListener('did-fail-load', ev => {
      if (ev.errorCode === -3 || !ev.isMainFrame) return; // -3: aborted by a newer navigation
      $('#bd-load').hidden = false;
      $('#bd-load').textContent = `Could not load the page (${ev.errorDescription || ev.errorCode})`;
    });
    $('#bd-view').append(view);
  } else {
    $('#bd-load').textContent = 'Loading…';
    view.loadURL(url).catch(() => {});
  }
}

/** The page view without a mod: Nexus's own sign-in page. The login stays for these pages. */
const SIGN_IN = 'https://users.nexusmods.com/auth/sign_in';
function openLogin() {
  br.mod = null;
  $('#browse-list').hidden = true;
  $('#browse-detail').hidden = false;
  $('#browse-detail').classList.add('is-page');
  $('#bd-name').textContent = 'Nexus Mods account';
  $('#bd-meta').textContent = 'Sign in once: the pages shown in Browse remember it. Downloading in this app only needs your API key.';
  $('#bd-thumb').hidden = true;
  showTab('description', SIGN_IN);
  $('#bd-back').focus();
}
$('#browse-login').addEventListener('click', openLogin);

function openMod(m) {
  $('#browse-detail').classList.remove('is-page');
  br.mod = m;
  $('#browse-list').hidden = true;
  $('#browse-detail').hidden = false;
  $('#bd-name').textContent = m.name;
  $('#bd-meta').textContent = [m.author ? `by ${m.author}` : '', m.version ? `v${m.version}` : '', m.category,
    `${fmtCount(m.endorsements)} endorsements`, `${fmtCount(m.downloads)} downloads`, m.updatedAt ? `updated ${fmtIsoDay(m.updatedAt)}` : ''].filter(Boolean).join(' · ');
  const thumb = $('#bd-thumb');
  thumb.hidden = !m.thumbnail;
  if (m.thumbnail) thumb.src = m.thumbnail;
  showTab('description');
  $('#bd-back').focus();
}

function closeMod() {
  $('#browse-detail').hidden = true;
  $('#browse-detail').classList.remove('is-page');
  $('#browse-list').hidden = false;
  const card = br.mod && $(`#browse-grid [data-id="${br.mod.modId}"] .mod-card-hit`);
  br.mod = null;
  (card || $('#browse-q')).focus();
}

$('#bd-back').addEventListener('click', closeMod);
$('#bd-download').addEventListener('click', () => br.mod && quickDownload(br.mod.modId));
$('#bd-external').addEventListener('click', () => api.openNexusPage(br.mod ? modPage(br.mod.modId, br.tab) : SIGN_IN));
$('#bd-tabs').addEventListener('click', ev => {
  const b = ev.target.closest('.seg-btn');
  if (b && br.mod) showTab(b.dataset.tab);
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && !$('#browse-detail').hidden && $('#page-browse').classList.contains('active') && $('#modal-back').hidden) closeMod();
});

// A "Manual download" clicked on a Files page: this app downloads it, with the file picker.
api.onBrowseDownload(d => {
  if (d.modId) quickDownload(d.modId);
  else toast('That download is not a mod file; it was not started.', 'error');
});

// ---------------------------------------------------------------- the search bar

$('#browse-q').addEventListener('input', ev => {
  // Names are matched as you type; a typed number is also looked up as a mod ID.
  br.q = ev.target.value.trim();
  searchSoon();
});
$('#browse-q').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); br.page = 1; search(); } });
$('#browse-cat').addEventListener('change', ev => { br.category = ev.target.value; br.page = 1; search(); });
$('#browse-sort').addEventListener('change', ev => { br.sort = ev.target.value; store.set('browse.sort', br.sort); br.page = 1; search(); });
$('#browse-per').addEventListener('change', ev => { br.perPage = Number(ev.target.value); store.set('browse.perPage', br.perPage); br.page = 1; search(); });
const turn = d => { br.page = Math.max(1, br.page + d); search().then(() => { $('#page-browse').scrollTop = 0; }); };
$('#browse-prev').addEventListener('click', () => turn(-1));
$('#browse-next').addEventListener('click', () => turn(1));

async function loadCategories() {
  const list = await api.modCategories();
  if (!list.ok) return;
  $('#browse-cat').replaceChildren(h('option', { value: '' }, 'All categories'),
    ...list.ok.map(c => h('option', { value: c.name }, `${c.name} (${c.count.toLocaleString()})`)));
  $('#browse-cat').value = br.category;
}

pageHooks.browse = () => {
  if (br.loaded) return;
  br.loaded = true;
  $('#browse-sort').value = br.sort;
  $('#browse-per').value = String(br.perPage);
  loadCategories();
  search();
  setTimeout(() => $('#browse-q').focus());
};
// Installed marks follow installs and removals.
snapshotHooks.push(() => { if (br.result && !$('#browse-list').hidden) renderResults(); });
