'use strict';
/* global api, $, $$, h, icon, run, toast, plural, fmtSize, fmtCount, fmtIsoDay, state, store, debounce, goTo, pageHooks, snapshotHooks, setSegActive, loadSettings, showSettingsSection */

// ---------------------------------------------------------------- Browse Mods: mod.io
// The Browse page's second source: Cyberpunk 2077 mods on mod.io (src/core/modio.js), with the
// user's own API key. Nexus Mods stays as it was (browse.js); a two-part switch beside the title
// picks the source, and the choice is remembered. mod.io's branding stays on screen (its terms).

// One block: these names stay out of the other pages' (scripts share one global scope).
{
const mio = {
  source: store.get('browse.source', 'nexus') === 'modio' ? 'modio' : 'nexus',
  q: '', tag: '', lang: '',
  sort: store.get('modio.sort', 'trending'),
  period: store.get('modio.period', ''),
  perPage: store.get('modio.perPage', 20),
  page: 1, result: null, seq: 0, loaded: false, tagsLoaded: false,
  mod: null, // the card whose page is open
  shown: new Set(), // mature mods shown this session
};
const nexusHook = pageHooks.browse; // the Nexus side's first-open step (browse.js)

const hasKey = () => !!state.settings?.hasModioKey;
const ownedIds = () => {
  const ids = new Map();
  for (const m of state.snap?.mods || []) if (m.modio?.id) ids.set(m.modio.id, m.enabled || ids.get(m.modio.id) || false);
  return ids;
};
const blurred = m => m.mature && !state.settings?.showMature && !mio.shown.has(m.id);

// ---------------------------------------------------------------- the switch

function mioSetSource(src) {
  mio.source = src === 'modio' ? 'modio' : 'nexus';
  store.set('browse.source', mio.source);
  $('#page-browse').classList.toggle('modio-mode', mio.source === 'modio');
  setSegActive('.browse-source', 'source', mio.source);
  if (!$('#page-browse').classList.contains('active')) return;
  if (mio.source === 'modio') openModio(); else nexusHook?.();
}
$$('.browse-source .seg-btn').forEach(b => b.addEventListener('click', () => {
  mioSetSource(b.dataset.source);
  // The switch is drawn on both sides: the focus stays on the one now shown.
  $(`#page-browse .${mio.source === 'modio' ? 'modio-list' : 'browse-list'} .browse-source [data-source="${mio.source}"]`)?.focus();
}));

pageHooks.browse = () => {
  $('#page-browse').classList.toggle('modio-mode', mio.source === 'modio');
  setSegActive('.browse-source', 'source', mio.source);
  if (mio.source === 'modio') openModio(); else nexusHook?.();
};

async function openModio() {
  if (!state.settings) await loadSettings();
  paintKey();
  if (!hasKey()) return;
  if (!mio.tagsLoaded) loadTags();
  if (!mio.loaded) {
    mio.loaded = true;
    $('#modio-sort').value = mio.sort;
    $('#modio-period').value = mio.period;
    $('#modio-per').value = String(mio.perPage);
    mioSearch();
    setTimeout(() => $('#modio-q').focus());
  }
}

// ---------------------------------------------------------------- no key yet

/** Without a key: what it is, where to get one, and a place to paste it (with the API path). */
function paintKey() {
  const box = $('#modio-key');
  const missing = !hasKey();
  box.hidden = !missing;
  $('#modio-bar').hidden = missing;
  $('#modio-grid').hidden = missing;
  if (missing) $('#modio-pager').hidden = true;
  if (!missing) { box.replaceChildren(); return; }
  if (box.childElementCount) return;
  const key = h('input', { type: 'password', id: 'modio-key-in', spellcheck: 'false', autocomplete: 'off', placeholder: '32 letters and digits', 'aria-label': 'mod.io API key' });
  const pathIn = h('input', { type: 'text', id: 'modio-path-in', class: 'mono', spellcheck: 'false', placeholder: 'https://u-12345678.modapi.io/v1', 'aria-label': 'mod.io API path', value: state.settings?.modioApiPath || '' });
  const status = h('p', { class: 'hint', role: 'status' });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('check'), h('span', {}, 'Save and browse'));
  const form = h('form', { class: 'modio-key-form' },
    h('label', { class: 'modio-field' }, h('span', {}, 'API key'), key),
    h('label', { class: 'modio-field' }, h('span', {}, 'API path'), pathIn),
    save);
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (!key.value.trim()) { status.className = 'hint bad'; status.textContent = 'Paste your API key first.'; key.focus(); return; }
    save.disabled = true;
    status.className = 'hint';
    status.textContent = 'Checking with mod.io…';
    const saved = await run(api.setSettings({ modioKey: key.value.trim(), modioApiPath: pathIn.value.trim() }));
    if (saved) {
      const r = await api.modioTest();
      if (r.error) { status.className = 'hint bad'; status.textContent = r.error; } else { key.value = ''; await loadSettings(); keyChanged(); }
    } else status.textContent = '';
    save.disabled = false;
  });
  box.replaceChildren(h('div', { class: 'modio-key-card' },
    h('h2', {}, 'Connect your mod.io account'),
    h('p', {}, 'mod.io lets apps read its mods with an API key, and its terms keep each key to its own account, so this app uses yours. It is free: on mod.io, open your account’s API Access page, accept the API terms, and create a read-only key. Copy the key and the API path shown with it.'),
    h('div', { class: 'modio-key-links' },
      h('button', { type: 'button', class: 'btn', onclick: () => api.openModioPage('https://mod.io/me/access') }, icon('external'), h('span', {}, 'Open mod.io API Access')),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { goTo('settings'); setTimeout(() => showSettingsSection('modio'), 50); } }, h('span', {}, 'Settings → mod.io'))),
    form, status,
    h('p', { class: 'muted modio-key-note' }, 'The key is stored encrypted on this PC and only sent to mod.io. Browsing and downloading need no mod.io sign-in.')));
}

/** The key or API path changed (here or in Settings): start over with it. */
function keyChanged() {
  mio.loaded = false;
  mio.tagsLoaded = false;
  mio.result = null;
  $('#modio-key').replaceChildren();
  if ($('#page-browse').classList.contains('active') && mio.source === 'modio') openModio(); else paintKey();
}

// ---------------------------------------------------------------- the list

async function loadTags() {
  const r = await api.modioTags();
  if (!r.ok) return;
  mio.tagsLoaded = true;
  const groups = r.ok.filter(g => g.tags.length);
  const langs = groups.find(g => /^languages?$/i.test(g.name));
  const opt = t => h('option', { value: t.name }, t.count ? `${t.name} (${t.count.toLocaleString()})` : t.name);
  $('#modio-cat').replaceChildren(h('option', { value: '' }, 'All categories'),
    ...groups.filter(g => g !== langs).map(g => h('optgroup', { label: g.name }, ...g.tags.filter(t => t.count).map(opt))));
  $('#modio-cat').value = mio.tag;
  $('#modio-lang').replaceChildren(h('option', { value: '' }, 'Any language'), ...(langs?.tags || []).filter(t => t.count).map(opt));
  $('#modio-lang').value = mio.lang;
  $('#modio-lang').hidden = !langs;
}

async function mioSearch() {
  const seq = ++mio.seq;
  const status = $('#modio-status');
  status.textContent = 'Searching…';
  status.classList.add('busy');
  const res = await api.modioSearch({ query: mio.q, tag: mio.tag, lang: mio.lang, sort: mio.sort, period: mio.period, page: mio.page, perPage: mio.perPage });
  if (seq !== mio.seq) return; // a newer search is on its way
  status.classList.remove('busy');
  if (res.error) {
    mio.result = null;
    status.textContent = res.error;
    $('#modio-grid').replaceChildren();
    $('#modio-pager').hidden = true;
    return;
  }
  mio.result = res.ok;
  mio.page = res.ok.page;
  mioRender();
}
const mioSearchSoon = debounce(() => { mio.page = 1; mioSearch(); }, 350);

function cardFor(m, have) {
  const owned = have.has(m.id);
  const blur = blurred(m);
  return h('article', { class: 'mod-card', dataset: { mid: m.id } },
    h('button', { class: 'mod-card-hit', 'aria-label': `${m.name} — open its page`, onclick: () => mioOpenMod(m) }),
    h('div', { class: `mod-thumb${blur ? ' is-mature' : ''}` },
      m.logo ? h('img', { src: m.logo, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }) : icon('package'),
      owned ? h('span', { class: `tag ${have.get(m.id) ? 'tag-ok' : ''} mod-owned` }, have.get(m.id) ? 'Installed' : 'Installed · off') : null,
      m.mature ? h('span', { class: 'tag tag-warn mod-adult' }, 'Mature') : null),
    h('div', { class: 'mod-body' },
      h('div', { class: 'mod-name', title: m.name }, m.name),
      h('div', { class: 'mod-by' }, [m.author ? `by ${m.author}` : '', m.tags[0] || '', fmtIsoDay(m.updatedAt)].filter(Boolean).join(' · ')),
      h('p', { class: 'mod-summary', title: m.summary }, m.summary),
      h('div', { class: 'mod-foot' },
        h('span', { class: 'mod-stat', title: `${m.downloads.toLocaleString()} downloads` }, icon('download'), fmtCount(m.downloads)),
        h('span', { class: 'mod-stat', title: `${m.subscribers.toLocaleString()} subscribers on mod.io` }, icon('users'), fmtCount(m.subscribers)),
        h('button', { class: 'btn btn-sm mod-get', title: `Download ${m.name} (and what it needs)`, onclick: ev => { ev.stopPropagation(); download(m); } }, icon('download'), h('span', {}, 'Download')))));
}

function mioRender() {
  const r = mio.result;
  if (!r) return;
  const pages = Math.max(1, Math.ceil(r.total / r.perPage));
  const where = [mio.tag, mio.lang].filter(Boolean).join(', ');
  $('#modio-status').textContent = r.total
    ? `${r.total.toLocaleString()} mod${r.total === 1 ? '' : 's'} for PC${mio.q ? ` matching "${mio.q}"` : ''}${where ? ` in ${where}` : ''}`
    : `Nothing found${mio.q ? ` for "${mio.q}"` : ''}. Try fewer words, or another category.`;
  const have = ownedIds();
  $('#modio-grid').replaceChildren(...r.mods.map(m => cardFor(m, have)));
  $('#modio-pager').hidden = pages <= 1;
  $('#modio-page').textContent = `Page ${r.page} of ${pages.toLocaleString()}`;
  $('#modio-prev').disabled = r.page <= 1;
  $('#modio-next').disabled = r.page >= pages;
}

/** Download a mod and the mods it needs that are not here yet. */
async function download(m) {
  const r = await run(api.modioDownload(m.id, true));
  if (!r) return;
  if (r.queued) toast(`Downloading ${plural(r.queued, 'file')} from mod.io${r.queued > 1 ? ' (with what it needs)' : ''}`, 'success', { label: 'Show', fn: () => goTo('downloads') });
  else if (r.skipped) toast(`${m.name} is downloaded already: Downloads can install it`, 'info', { label: 'Show', fn: () => goTo('downloads') });
  if (r.noWindows?.length) toast(`${m.name} also needs ${r.noWindows.join(', ')}, which mod.io has for consoles only`, 'warn');
}

// ---------------------------------------------------------------- one mod's page

async function mioOpenMod(m) {
  mio.mod = m;
  $('#modio-list').hidden = true;
  $('#modio-detail').hidden = false;
  $('#md-name').textContent = m.name;
  $('#md-meta').textContent = [m.author ? `by ${m.author}` : '', m.version ? `v${m.version}` : '', `${fmtCount(m.downloads)} downloads`, m.updatedAt ? `updated ${fmtIsoDay(m.updatedAt)}` : ''].filter(Boolean).join(' · ');
  $('#md-thumb').hidden = !m.logo || blurred(m);
  if (m.logo) $('#md-thumb').src = m.logo;
  $('#md-body').replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  $('#md-back').focus();
  const r = await api.modioMod(m.id);
  if (mio.mod !== m) return; // another mod was opened meanwhile
  if (r.error) { $('#md-body').replaceChildren(h('p', { class: 'hint bad' }, r.error)); return; }
  paintMod(r.ok);
}

function paintMod(d) {
  const have = ownedIds();
  const f = d.file;
  const blur = blurred(d);
  const pics = [d.logo, ...d.images].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i);
  const big = h('img', { class: 'md-pic', alt: '', referrerpolicy: 'no-referrer', src: pics[0] || '' });
  const gallery = pics.length ? h('div', { class: `md-gallery${blur ? ' is-mature' : ''}` },
    h('div', { class: 'md-pic-frame' }, big,
      blur ? h('button', { type: 'button', class: 'btn btn-sm md-reveal', onclick: () => { mio.shown.add(d.id); paintMod(d); $('#md-thumb').hidden = !d.logo; mioRender(); } }, icon('eye'), h('span', {}, 'Show mature pictures')) : null),
    pics.length > 1 ? h('div', { class: 'md-thumbs', role: 'list' }, ...pics.map((u, i) => h('button', {
      type: 'button', class: `md-thumb-btn${i === 0 ? ' on' : ''}`, role: 'listitem', 'aria-label': `Picture ${i + 1} of ${pics.length}`,
      onclick: ev => { big.src = u; $$('#md-body .md-thumb-btn').forEach(b => b.classList.toggle('on', b === ev.currentTarget)); },
    }, h('img', { src: u, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })))) : null) : null;
  const fact = (k, v) => (v ? h('div', { class: 'md-fact' }, h('dt', {}, k), h('dd', {}, v)) : null);
  const facts = h('dl', { class: 'md-facts' },
    fact('Version', f?.version || d.version),
    fact('File', f ? `${f.fileName} · ${fmtSize(f.size)}` : 'No Windows file'),
    fact('Uploaded', f?.added ? fmtIsoDay(f.added) : ''),
    fact('Released', d.liveAt ? fmtIsoDay(d.liveAt) : ''),
    fact('Downloads', d.downloads.toLocaleString()),
    fact('Subscribers', d.subscribers.toLocaleString()),
    fact('Rating', d.ratings ? `${d.rating}% positive (${d.ratings.toLocaleString()})` : ''),
    fact('Tags', d.tags.join(', ')));
  const scan = f && f.virusStatus === 1 && f.virusPositive === 2
    ? h('p', { class: 'banner banner-warn' }, icon('alert'), h('span', {}, 'mod.io’s virus scan marks this file as possibly harmful (it contains a program). Only download it if you trust its maker.'))
    : null;
  const deps = d.dependencies.length ? h('section', { class: 'md-sec' }, h('h2', {}, 'Needs'),
    h('ul', { class: 'md-deps' }, ...d.dependencies.map(x => h('li', {},
      h('span', { class: 'md-dep-name' }, x.name || `Mod ${x.id}`),
      have.has(x.id) ? h('span', { class: 'tag tag-ok' }, 'Installed')
        : x.fileId ? h('span', { class: 'tag' }, 'Comes with the download') : h('span', { class: 'tag tag-warn', title: 'mod.io has this one for consoles only' }, 'No PC file'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => api.openModioPage(x.url) }, icon('external'), h('span', {}, 'mod.io')))))) : null;
  const changelog = f?.changelog ? h('section', { class: 'md-sec' }, h('h2', {}, `What changed in ${f.version || 'this version'}`), h('p', { class: 'md-text' }, f.changelog)) : null;
  $('#md-body').replaceChildren(
    h('div', { class: `md-top${gallery ? '' : ' no-pics'}` }, gallery, h('div', { class: 'md-side' }, scan, facts, deps)),
    h('section', { class: 'md-sec' }, h('h2', {}, 'About'), h('p', { class: 'md-text' }, d.description || d.summary || '')),
    changelog,
    h('p', { class: 'md-brand' }, 'From ', h('button', { type: 'button', class: 'link-btn', onclick: () => api.openModioPage(d.url) }, 'mod.io'), ', the official Cyberpunk 2077 mod site.'));
  $('#md-download').disabled = !d.fileId;
  $('#md-download').title = d.fileId ? `Download ${d.name}${d.dependencies.length ? ' and what it needs' : ''}` : 'mod.io has no PC file for this mod';
}

function mioCloseMod() {
  $('#modio-detail').hidden = true;
  $('#modio-list').hidden = false;
  mioRender(); // installed marks may have changed while the page was open
  const card = mio.mod && $(`#modio-grid [data-mid="${Number(mio.mod.id)}"] .mod-card-hit`);
  mio.mod = null;
  (card || $('#modio-q')).focus();
}

$('#md-back').addEventListener('click', mioCloseMod);
$('#md-download').addEventListener('click', () => mio.mod && download(mio.mod));
$('#md-external').addEventListener('click', () => mio.mod && api.openModioPage(mio.mod.url));
$('#modio-brand').addEventListener('click', () => api.openModioPage('https://mod.io/g/cyberpunk-2077'));
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && mio.source === 'modio' && !$('#modio-detail').hidden && $('#page-browse').classList.contains('active') && $('#modal-back').hidden) mioCloseMod();
});

// ---------------------------------------------------------------- the search bar

$('#modio-q').addEventListener('input', ev => { mio.q = ev.target.value.trim(); mioSearchSoon(); });
$('#modio-q').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); mio.page = 1; mioSearch(); } });
$('#modio-cat').addEventListener('change', ev => { mio.tag = ev.target.value; mio.page = 1; mioSearch(); });
$('#modio-lang').addEventListener('change', ev => { mio.lang = ev.target.value; mio.page = 1; mioSearch(); });
$('#modio-sort').addEventListener('change', ev => { mio.sort = ev.target.value; store.set('modio.sort', mio.sort); mio.page = 1; mioSearch(); });
$('#modio-period').addEventListener('change', ev => { mio.period = ev.target.value; store.set('modio.period', mio.period); mio.page = 1; mioSearch(); });
$('#modio-per').addEventListener('change', ev => { mio.perPage = Number(ev.target.value); store.set('modio.perPage', mio.perPage); mio.page = 1; mioSearch(); });
const mioTurn = d => { mio.page = Math.max(1, mio.page + d); mioSearch().then(() => { $('#page-browse').scrollTop = 0; }); };
$('#modio-prev').addEventListener('click', () => mioTurn(-1));
$('#modio-next').addEventListener('click', () => mioTurn(1));

// Installed marks follow installs and removals; the mature setting follows Settings.
snapshotHooks.push(() => { if (mio.result && !$('#modio-list').hidden && mio.source === 'modio') mioRender(); });

$('#page-browse').classList.toggle('modio-mode', mio.source === 'modio');
setSegActive('.browse-source', 'source', mio.source);
window.modioPage = { keyChanged, setSource: mioSetSource };
}
