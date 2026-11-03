'use strict';
/* global api, $, h, askAi, exportReport, icon, run, toast, plural, fmtTime, state, renderMods, renderPlay, pageHooks, snapshotHooks, drawerSections, goTo, setSegActive, debounce, openDrawer, closeDrawer, keepFocus, confirmBox, modal, $$ */

// ---------------------------------------------------------------- game log page

const GL_MAX_ROWS = 1500;
const GL_MAX_ENTRIES = 8000;
const GL_TRIM_SLACK = 1000; // trim in chunks, so counters are rebuilt once per 1000 lines, not per batch
const gl = {
  entries: [],
  clearedAfter: 0,
  paused: false,
  held: 0,
  tab: 'timeline',
  level: 'all',
  source: '',
  q: '',
  sources: new Set(),
  errors: 0,
  warns: 0,
  // Problems grouped as they arrive (unfiltered), so stats never rescan history.
  problemKeys: new Set(),
  rootErrors: new Map(), // mod folder (lower case) → error count, kept as lines arrive
  status: { running: false, since: null },
  sourcesSeq: 0,
  lastId: 0, // the newest line taken in (ids only grow)
  play: null, // a past play being looked at: { id, start, end, outcome, entries, files, … }; null: live
  follow: true, // show Live while the game runs and Latest after; false once an older play is picked
  plays: [],
};

/** The lines on show: a past play's, or the live ones. */
const shownEntries = () => (gl.play ? gl.play.entries : gl.entries);

const relTime = t => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

const isProblem = e => !e.marker && (e.level === 'error' || e.level === 'warn');

function glMatches(e) {
  if (!gl.play && e.id <= gl.clearedAfter) return false;
  if (gl.level === 'error' && e.level !== 'error') return false;
  if (gl.level === 'warn' && e.level !== 'warn' && e.level !== 'error') return false;
  if (gl.source && e.source !== gl.source) return false;
  if (gl.q && !`${e.source} ${e.text}`.toLowerCase().includes(gl.q)) return false;
  return true;
}

const LEVEL_TAG = { error: 'tag-err', warn: 'tag-warn', success: 'tag-ok' };
const LEVEL_TEXT = { error: 'Error', warn: 'Warning', info: 'Info', success: 'Game', debug: 'Debug' };
const LEVEL_SHORT = { error: 'ERROR', warn: 'WARN', info: 'INFO', success: 'GAME', debug: 'DEBUG' };

/** Rows carry data attributes only; one delegated listener on the list handles clicks. */
function glRow(e) {
  return h('div', { class: `lrow lv-${e.level}${e.marker ? ' marker' : ''}${e.crash ? ' crash-row' : ''}` },
    h('span', { class: 'lrow-time', title: new Date(e.time).toLocaleString() }, fmtTime(e.time)),
    h('span', { class: 'lrow-level' }, e.crash ? 'CRASH' : LEVEL_SHORT[e.level] || e.level.toUpperCase()),
    h('button', { class: 'lrow-source', dataset: { source: e.source }, title: e.file ? `${e.file}\nShow only ${e.source}` : `Show only ${e.source}` }, e.source),
    h('span', { class: `lrow-text${e.lines > 3 ? ' clamp' : ''}`, title: e.lines > 3 ? 'Click to expand' : null }, e.text,
      e.crash ? h('button', { class: 'link-btn crash-link', dataset: { crash: e.crash } }, ' See the crash') : null));
}

$('#gl-list').addEventListener('click', ev => {
  const crash = ev.target.closest('.crash-link');
  if (crash) { showCrash(crash.dataset.crash); return; }
  const src = ev.target.closest('.lrow-source');
  if (src) { setSource(src.dataset.source); return; }
  const clamp = ev.target.closest('.lrow-text.clamp');
  if (clamp) { clamp.classList.remove('clamp'); clamp.removeAttribute('title'); }
});

function atBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 40; }

function setEmpty(cardSel, emptySel, isEmpty) {
  $(emptySel).hidden = !isEmpty;
  $(cardSel).classList.toggle('is-empty', isEmpty);
}

function renderTimeline() {
  const rows = [];
  const all = shownEntries();
  for (let i = all.length - 1; i >= 0 && rows.length < GL_MAX_ROWS; i--) if (glMatches(all[i])) rows.push(all[i]);
  rows.reverse();
  $('#gl-list').replaceChildren(...rows.map(glRow));
  const view = $('#gl-timeline');
  view.scrollTop = view.scrollHeight;
  $('#gl-jump').hidden = true;
  setEmpty('#gl-timeline', '#gl-empty', rows.length === 0);
  const filtered = gl.level !== 'all' || gl.source || gl.q;
  $('#gl-empty-title').textContent = filtered ? 'Nothing matches' : gl.play ? 'This play logged nothing' : 'No log lines yet';
  $('#gl-empty-text').textContent = filtered
    ? 'Try another search, level or source.'
    : 'Start the game: new lines from every mod\'s log appear here as they are written.';
}

function appendTimeline(batch) {
  const view = $('#gl-timeline');
  const follow = atBottom(view);
  const list = $('#gl-list');
  const rows = batch.filter(glMatches);
  if (!rows.length) return;
  list.append(...rows.map(glRow));
  while (list.childElementCount > GL_MAX_ROWS) list.firstElementChild.remove();
  setEmpty('#gl-timeline', '#gl-empty', false);
  if (follow) view.scrollTop = view.scrollHeight;
  else $('#gl-jump').hidden = false;
}

/** Group identical problems: numbers, hex and quoted values vary between occurrences. */
function problemKey(e) {
  return `${e.level}|${e.source}|${e.text.split('\n')[0].replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#').replace(/"[^"]*"|'[^']*'/g, '"…"').slice(0, 200)}`;
}

/** Problems matching the current filters, grouped and sorted: errors first, then by count. */
function problems(entries = shownEntries(), match = glMatches) {
  const map = new Map();
  for (const e of entries) {
    if (!isProblem(e) || !match(e)) continue;
    const k = problemKey(e);
    const p = map.get(k);
    if (p) { p.count++; if (e.time >= p.last.time) p.last = e; } else map.set(k, { count: 1, last: e });
  }
  return [...map.values()].sort((a, b) => (a.last.level === b.last.level ? 0 : a.last.level === 'error' ? -1 : 1) || b.count - a.count || b.last.time - a.last.time);
}

function jumpToProblem(e) {
  setSource(e.source, false);
  setSearch(e.text.split('\n')[0].slice(0, 60));
  setTab('timeline');
}

/** The installed mod a log line belongs to, from the folders each mod owns. */
function modFor(e) {
  if (!e.root) return null;
  const root = e.root.toLowerCase();
  return state.snap.mods.find(m => (m.roots || []).some(r => r.toLowerCase() === root)) || null;
}

function modCell(e) {
  const m = modFor(e);
  if (!m) return h('span', { class: 'muted', title: e.root ? 'This log is not from a mod managed here' : 'Not tied to a mod folder' }, '—');
  return h('button', {
    class: 'link-btn quiet', title: `Open ${m.name}`,
    onclick: ev => { ev.stopPropagation(); goTo('mods'); openDrawer(m.id, 'logs'); },
  }, m.name);
}

function renderProblems() {
  const list = problems();
  const tbody = $('#gl-problems tbody');
  keepFocus(tbody, () => tbody.replaceChildren(...list.map(p => h('tr', {
    class: 'row', tabindex: '0', title: 'Open in the timeline (Enter)', dataset: { key: problemKey(p.last) },
    onclick: () => jumpToProblem(p.last),
    onkeydown: ev => { if (ev.key === 'Enter') { ev.preventDefault(); jumpToProblem(p.last); } },
  },
  h('td', { class: 'num' }, h('span', { class: 'count-pill' }, String(p.count))),
  h('td', {}, h('span', { class: `lvl lvl-${p.last.level}` }, LEVEL_SHORT[p.last.level])),
  h('td', { class: 'dim', title: p.last.file || p.last.source }, p.last.source),
  h('td', { class: 'col-cat' }, modCell(p.last)),
  h('td', { class: 'wrap mono-msg', title: p.last.text }, h('span', {}, p.last.text.split('\n')[0])),
  h('td', { class: 'dim', title: new Date(p.last.time).toLocaleString() }, relTime(p.last.time)),
  h('td', { class: 'actions' }, h('button', { class: 'btn btn-sm btn-ghost', title: 'Ask the AI assistant about this problem', 'aria-label': 'Ask AI about this problem', onclick: ev => { ev.stopPropagation(); askAi(`Help me with this ${p.last.level === 'error' ? 'error' : 'warning'} from ${p.last.source} (seen ${p.count} time${p.count === 1 ? '' : 's'}):\n${p.last.text.split('\n')[0]}\nWhat causes it and how do I fix it?`); } }, icon('sparkle'), h('span', {}, 'Ask AI')))))), null);
  setEmpty('#gl-problems', '#gl-prob-empty', list.length === 0);
}
const renderProblemsSoon = (() => {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; if (gl.tab === 'problems' && $('#page-gamelog').classList.contains('active')) renderProblems(); }, 500);
  };
})();

async function renderSources() {
  const seq = ++gl.sourcesSeq;
  if (gl.play) {
    const p = gl.play;
    $('#gl-sources tbody').replaceChildren(...p.files.map(f => h('tr', { class: 'row' },
      h('td', {}, h('div', { class: 'cell-name' }, h('span', { class: 'name' }, f.rel.split('/').pop()), h('span', { class: 'subname' }, 'Saved from this play'))),
      h('td', { class: 'dim mono', title: f.rel }, f.rel),
      h('td', { class: 'num' }, h('span', { class: 'muted' }, '·')),
      h('td', { class: 'num' }, h('span', { class: 'muted' }, '·')),
      h('td', { class: 'dim', title: new Date(f.mtime).toLocaleString() }, fmtWhen(f.mtime)),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-sm btn-icon', title: 'Open the saved file', 'aria-label': `Open ${f.rel}`, onclick: () => run(api.playOpenFile(p.id, f.rel)) }, icon('file')),
        h('button', { class: 'btn btn-sm btn-icon', title: 'Show in folder', 'aria-label': `Show ${f.rel} in folder`, onclick: () => run(api.playRevealFile(p.id, f.rel)) }, icon('folder'))))));
    return;
  }
  const res = await api.gameLogSources(); // polled every 5 s: errors show inline, not as toasts
  if (seq !== gl.sourcesSeq) return; // a newer request is on its way
  const rows = res.ok || [];
  $('#gl-sources').title = res.error ? `Could not read the log list: ${res.error}` : '';
  const shown = rows.filter(r => r.followed || r.errors || r.warns);
  $('#gl-sources tbody').replaceChildren(...shown.map(r => h('tr', { class: 'row' },
    h('td', {}, h('div', { class: 'cell-name' }, h('span', { class: 'name' }, r.source), h('span', { class: 'subname' }, r.followed ? 'Following' : 'Older session'))),
    h('td', { class: 'dim mono', title: r.rel }, r.rel),
    h('td', { class: 'num' }, r.errors ? h('span', { class: 'tag tag-err' }, String(r.errors)) : h('span', { class: 'muted' }, '0')),
    h('td', { class: 'num' }, r.warns ? h('span', { class: 'tag tag-warn' }, String(r.warns)) : h('span', { class: 'muted' }, '0')),
    h('td', { class: 'dim', title: new Date(r.mtime).toLocaleString() }, relTime(r.mtime)),
    h('td', { class: 'actions' },
      h('button', { class: 'btn btn-sm btn-icon', title: 'Open the file', 'aria-label': `Open ${r.rel}`, onclick: () => run(api.openGameFile(r.rel)) }, icon('file')),
      h('button', { class: 'btn btn-sm btn-icon', title: 'Show in folder', 'aria-label': `Show ${r.rel} in folder`, onclick: () => run(api.revealGameFile(r.rel)) }, icon('folder'))))));
}

// ---------------------------------------------------------------- Manager: this app's own record

const mgr = { entries: [], pending: false };
const MGR_LEVEL = { error: ['tag-err', 'Error'], warn: ['tag-warn', 'Warning'], success: ['tag-ok', 'Done'], info: ['', 'Info'] };

function renderManager() {
  const q = gl.q;
  const rows = [];
  for (let i = mgr.entries.length - 1; i >= 0 && rows.length < GL_MAX_ROWS; i--) {
    const e = mgr.entries[i];
    if (gl.level === 'error' && e.level !== 'error') continue;
    if (gl.level === 'warn' && e.level !== 'warn' && e.level !== 'error') continue;
    if (q && !`${e.message} ${e.detail || ''}`.toLowerCase().includes(q)) continue;
    rows.push(e);
  }
  const day = new Date().toDateString();
  $('#gl-manager tbody').replaceChildren(...rows.map(e => {
    const [tag, label] = MGR_LEVEL[e.level] || ['', e.level];
    const d = new Date(e.time);
    return h('tr', { class: 'row' },
      h('td', { class: 'dim', title: d.toLocaleString() }, d.toDateString() === day ? d.toLocaleTimeString() : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
      h('td', {}, h('span', { class: `tag ${tag}` }, label)),
      h('td', { class: 'mgr-msg' }, e.message, e.detail ? h('span', { class: 'mgr-detail' }, e.detail) : null));
  }));
  $('#gl-mgr-empty').hidden = rows.length > 0;
}
function renderManagerSoon() {
  if (mgr.pending) return;
  mgr.pending = true;
  requestAnimationFrame(() => { mgr.pending = false; if (gl.tab === 'manager') renderManager(); });
}
api.logHistory().then(r => {
  if (!r.ok) return;
  // Lines that arrived before the history did are already in it.
  const seen = new Set(r.ok.map(e => `${e.time}|${e.message}`));
  mgr.entries = [...r.ok, ...mgr.entries.filter(e => !seen.has(`${e.time}|${e.message}`))];
  if (gl.tab === 'manager') renderManager();
});
api.onLog(e => {
  if (e.level === 'debug') return;
  mgr.entries.push(e);
  if (mgr.entries.length > 3000) mgr.entries.shift();
  if (gl.tab === 'manager') renderManagerSoon();
});

function renderView() {
  for (const t of ['timeline', 'problems', 'crashes', 'sources', 'manager']) $(`#gl-${t}`).hidden = gl.tab !== t;
  $('#gl-manager-note').hidden = gl.tab !== 'manager';
  // The game's log sources mean nothing for this app's own record.
  $('#gl-source').disabled = gl.tab === 'manager';
  $$('#gl-tabs .seg-btn').forEach(b => {
    const on = b.dataset.tab === gl.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  const noLevel = gl.tab === 'sources' || gl.tab === 'crashes';
  $('#gl-level').classList.toggle('is-disabled', noLevel);
  $$('#gl-level .seg-btn').forEach(b => { b.disabled = noLevel; });
  if (gl.tab === 'timeline') renderTimeline();
  if (gl.tab === 'problems') renderProblems();
  if (gl.tab === 'sources') renderSources();
  if (gl.tab === 'crashes') loadCrashes();
  if (gl.tab === 'manager') renderManager();
}

function renderStats() {
  const errs = gl.play ? gl.play.errors : gl.errors;
  const warns = gl.play ? gl.play.warns : gl.warns;
  $('#gl-errs').textContent = errs;
  $('#gl-warns').textContent = warns;
  $('#gl-stat-err').classList.toggle('has-errors', errs > 0);
  $('#gl-stat-warn').classList.toggle('has-warns', warns > 0);
  const nav = $('#nav-log-count');
  nav.textContent = gl.errors || '';
  nav.classList.toggle('alert', gl.errors > 0);
  nav.title = gl.errors ? `${plural(gl.errors, 'error')} in the game logs` : '';
  const nProb = gl.play ? new Set(gl.play.entries.filter(isProblem).map(problemKey)).size : gl.problemKeys.size;
  $('#gl-prob-count').textContent = nProb ? String(nProb) : '';
}

function renderGameStatus() {
  const s = gl.status;
  state.gameRunning = !!s.running;
  if (gl.play) {
    const p = gl.play;
    $('#gl-game').textContent = PLAY_HOW[p.outcome] || 'Ended';
    $('#gl-game-sub').textContent = `Played ${fmtWhen(p.start)} · ${playLength(p)}`;
    $('#gl-stat-game').classList.remove('is-live');
    $('#gl-srcs').textContent = p.files.length;
    return;
  }
  $('#gl-game').textContent = s.running ? 'Running' : 'Not running';
  $('#gl-game-sub').textContent = s.running && s.since ? `Cyberpunk 2077 · since ${fmtTime(s.since)}` : 'Cyberpunk 2077';
  $('#gl-stat-game').classList.toggle('is-live', !!s.running);
  $('#gl-srcs').textContent = s.followed ?? 0;
}

function syncSourceOptions(force) {
  const sel = $('#gl-source');
  const sources = gl.play ? new Set(gl.play.entries.map(e => e.source)) : gl.sources;
  if (!force && sel.options.length - 1 === sources.size) return;
  const cur = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'All sources'), ...[...sources].sort((a, b) => a.localeCompare(b)).map(s => h('option', { value: s }, s)));
  sel.value = cur;
}

// Errors per installed mod, by the folders each mod owns (red4ext/plugins/X, CET mods/X, …).
// Throttled (not debounced): with logs arriving every 300 ms a debounce would never fire.
function updateModProblems() {
  const next = {};
  for (const m of state.snap.mods) {
    const n = (m.roots || []).reduce((sum, r) => sum + (gl.rootErrors.get(r.toLowerCase()) || 0), 0);
    if (n) next[m.id] = n;
  }
  if (JSON.stringify(next) !== JSON.stringify(state.modLogProblems)) {
    state.modLogProblems = next;
    renderMods();
  }
}
const scheduleModProblems = (() => {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; updateModProblems(); }, 1000);
  };
})();

// The mod details panel lists that mod's log problems, grouped, each one a link into the timeline.
drawerSections.push(m => {
  const roots = new Set((m.roots || []).map(r => r.toLowerCase()));
  if (!roots.size) return [];
  const list = problems(gl.entries, e => e.id > gl.clearedAfter && e.root && roots.has(e.root.toLowerCase())).slice(0, 8);
  if (!list.length) return [];
  return [
    h('h2', { dataset: { section: 'logs' } }, `Game log problems · ${list.length}`),
    h('div', { class: 'mini-log' }, list.map(p => h('button', {
      class: `mini-row lv-${p.last.level}`,
      title: `${p.last.source} · ${new Date(p.last.time).toLocaleString()}\nOpen in the game log`,
      onclick: () => { closeDrawer(); jumpToProblem(p.last); goTo('gamelog'); },
    },
    h('span', { class: `tag ${LEVEL_TAG[p.last.level]}` }, LEVEL_TEXT[p.last.level]),
    h('span', { class: 'mini-text' }, p.last.text.split('\n')[0]),
    p.count > 1 ? h('span', { class: 'count-pill', title: `${p.count} times` }, `×${p.count}`) : null))),
  ];
});

function count(e) {
  if (e.id <= gl.clearedAfter || !isProblem(e)) return;
  if (e.level === 'error') {
    gl.errors++;
    if (e.root) gl.rootErrors.set(e.root.toLowerCase(), (gl.rootErrors.get(e.root.toLowerCase()) || 0) + 1);
  } else gl.warns++;
  gl.problemKeys.add(problemKey(e));
}

/** Rebuild every counter from the retained lines (after trimming, clearing or a reset). */
function recount() {
  gl.errors = 0;
  gl.warns = 0;
  gl.problemKeys.clear();
  gl.rootErrors.clear();
  for (const e of gl.entries) count(e);
}

/** Take in lines; returns the ones that are new (a line sent in the startup history and again live is skipped: ids only grow). */
function ingest(batch) {
  const fresh = [];
  for (const e of batch) {
    if (e.id) {
      if (e.id <= gl.lastId) continue;
      gl.lastId = e.id;
    }
    fresh.push(e);
    gl.entries.push(e);
    gl.sources.add(e.source);
    count(e);
  }
  if (gl.entries.length > GL_MAX_ENTRIES + GL_TRIM_SLACK) {
    gl.entries.splice(0, gl.entries.length - GL_MAX_ENTRIES);
    recount();
  }
  return fresh;
}

function onBatch(all) {
  const batch = ingest(all);
  if (!batch.length) return;
  scheduleModProblems();
  if (gl.play) { renderStats(); return; } // looking at a past play: the live lines wait
  syncSourceOptions();
  renderStats();
  if (gl.paused) { gl.held += batch.length; updatePauseLabel(); return; }
  if (!$('#page-gamelog').classList.contains('active')) return;
  if (gl.tab === 'timeline') appendTimeline(batch);
  else if (gl.tab === 'problems') renderProblemsSoon();
}

function updatePauseLabel() {
  const btn = $('#gl-follow');
  const label = gl.paused ? `Resume${gl.held ? ` (${gl.held} new)` : ''}` : 'Pause';
  btn.setAttribute('aria-pressed', String(gl.paused));
  btn.setAttribute('aria-label', gl.paused ? 'Resume live updates' : 'Pause live updates');
  btn.replaceChildren(icon(gl.paused ? 'play' : 'pause'), h('span', {}, label));
}

// ---------------------------------------------------------------- controls

function setTab(t) { gl.tab = t; renderView(); }

// ---------------------------------------------------------------- plays (each launch of the game: its own set of logs)

const PLAY_HOW = { crashed: 'Crashed', exited: 'Exited', unknown: 'Ended' };
const fmtWhen = t => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const playLength = p => {
  const min = Math.round(((p.end || Date.now()) - p.start) / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};
const playCounts = p => [plural(p.errors || 0, 'error'), plural(p.warns || 0, 'warning')].join(' · ');

/** What the picker shows by itself: Live while the game runs, else the latest play ('' = the live logs). */
const defaultPlay = () => (gl.status.running ? '' : gl.plays[0]?.id || '');
const isLatest = p => !!p && !gl.status.running && gl.plays[0]?.id === p.id;

async function loadPlays() {
  const r = await api.playsList();
  gl.plays = (r.ok || []).filter(p => !p.live);
  if (gl.play && !gl.plays.some(p => p.id === gl.play.id)) gl.follow = true; // its logs were deleted
  const want = gl.follow ? defaultPlay() : gl.play?.id || '';
  // A different play, or the one shown has just finished saving (its last lines are in now).
  if (want !== (gl.play?.id || '') || (gl.play?.closing && !gl.plays.find(p => p.id === gl.play.id)?.closing)) { await showPlay(want); return; }
  paintPlayButton();
  if (!$('#gl-play-menu').hidden) paintPlayMenu();
}

/** Pick from the menu: the top entry follows the game again; an older play stays put. */
function choosePlay(id) {
  gl.follow = id === defaultPlay();
  showPlay(id);
}

function paintPlayButton() {
  const p = gl.play;
  const label = !p ? (gl.status.running ? 'Live' : 'Latest') : isLatest(p) ? `Latest · ${fmtWhen(p.start)}` : fmtWhen(p.start);
  $('#gl-play-label').textContent = label;
  $('#gl-play-btn').classList.toggle('crashed', p?.outcome === 'crashed');
  $('#gl-play-btn').classList.toggle('live', !p && gl.status.running);
  $('#gl-play-btn').title = !p ? (gl.status.running ? 'The game is running: its logs as they are written.' : 'Every log since the app started (no play has ended yet).')
    : `The logs of the play of ${fmtWhen(p.start)}. ${plural(gl.plays.length, 'play')} kept.`;
}

/** The dropdown: Live (while the game runs) or Latest, then every earlier play, newest first; crashed ones stand out. */
function paintPlayMenu() {
  const opt = (id, label, sub, tag, cls) => h('button', {
    class: `play-opt${cls ? ` ${cls}` : ''}`, role: 'option', type: 'button', 'aria-selected': String((gl.play?.id || '') === id),
    onclick: () => { closePlayMenu(); choosePlay(id); },
  },
  h('span', { class: 'play-dot', 'aria-hidden': 'true' }),
  h('span', { class: 'play-opt-main' }, h('span', { class: 'play-opt-title' }, label), h('span', { class: 'play-opt-sub' }, sub)),
  tag);
  const how = p => h('span', { class: `tag ${p.outcome === 'crashed' ? 'tag-err' : p.closing ? 'tag-warn' : ''}` }, p.closing ? 'Saving…' : PLAY_HOW[p.outcome] || 'Ended');
  const playOpt = (p, label) => opt(p.id, label, `${label === 'Latest' ? `${fmtWhen(p.start)} · ${playLength(p)}` : `${playLength(p)} · ${playCounts(p)}`}`, how(p), `${p.outcome === 'crashed' ? 'crashed' : ''}${label === 'Latest' ? ' top' : ''}`);
  const running = gl.status.running;
  const top = running ? opt('', 'Live', `Playing since ${fmtTime(gl.status.since)}`, h('span', { class: 'tag tag-ok' }, 'Running'), 'live running')
    : gl.plays[0] ? playOpt(gl.plays[0], 'Latest') : opt('', 'Latest', 'Every log since the app started', null, 'live');
  const earlier = running ? gl.plays : gl.plays.slice(1);
  $('#gl-play-menu').replaceChildren(...[ // (null would show as the word "null")
    top,
    h('div', { class: 'play-menu-sep' }, earlier.length ? `Earlier plays · ${earlier.length}` : 'Earlier plays appear here once the game exits'),
    ...earlier.map(p => playOpt(p, fmtWhen(p.start))),
    gl.plays.length ? h('button', { class: 'play-menu-foot', type: 'button', onclick: () => { closePlayMenu(); deletePlaysDialog(); } }, icon('trash'), h('span', {}, 'Delete plays…')) : null,
  ].filter(Boolean));
}

function openPlayMenu() {
  paintPlayMenu();
  $('#gl-play-menu').hidden = false;
  $('#gl-play-btn').setAttribute('aria-expanded', 'true');
  ($('#gl-play-menu .play-opt[aria-selected="true"]') || $('#gl-play-menu .play-opt'))?.focus();
}
function closePlayMenu(refocus) {
  if ($('#gl-play-menu').hidden) return;
  $('#gl-play-menu').hidden = true;
  $('#gl-play-btn').setAttribute('aria-expanded', 'false');
  if (refocus) $('#gl-play-btn').focus();
}

$('#gl-play-btn').addEventListener('click', () => ($('#gl-play-menu').hidden ? openPlayMenu() : closePlayMenu()));
$('#gl-play-menu').addEventListener('keydown', ev => {
  const opts = [...$$('#gl-play-menu .play-opt, #gl-play-menu .play-menu-foot')];
  const i = opts.indexOf(document.activeElement);
  if (ev.key === 'ArrowDown') { ev.preventDefault(); opts[Math.min(i + 1, opts.length - 1)]?.focus(); }
  if (ev.key === 'ArrowUp') { ev.preventDefault(); opts[Math.max(i - 1, 0)]?.focus(); }
  if (ev.key === 'Home') { ev.preventDefault(); opts[0]?.focus(); }
  if (ev.key === 'End') { ev.preventDefault(); opts[opts.length - 1]?.focus(); }
  if (ev.key === 'Escape' || ev.key === 'Tab') closePlayMenu(ev.key === 'Escape');
});
document.addEventListener('mousedown', ev => { if (!ev.target.closest('#gl-play-pick')) closePlayMenu(); });

async function showPlay(id) {
  if (!id) { showLive(); return; }
  const r = await api.playGet(id);
  if (r.error) { toast(r.error, 'error'); loadPlays(); return; }
  gl.play = r.ok;
  const p = gl.play;
  $('#gl-play-bar').hidden = false;
  $('#gl-play-bar').classList.toggle('crashed', p.outcome === 'crashed');
  $('#gl-play-title').textContent = isLatest(p) ? `Latest play · ${fmtWhen(p.start)}` : `The play of ${fmtWhen(p.start)}`;
  $('#gl-play-live').textContent = gl.status.running ? 'Back to live' : 'Back to latest';
  $('#gl-play-live').hidden = isLatest(p);
  $('#gl-play-meta').textContent = [playLength(p), PLAY_HOW[p.outcome] || 'Ended', playCounts(p), `${plural(p.files.length, 'log file')} saved`].join('  ·  ');
  $('#gl-play-meta').title = p.note || (p.joinedLate ? 'The app opened while the game was already running: lines from before that are only in the saved files (Sources).' : '');
  for (const sel of ['#gl-follow', '#gl-clear']) $(sel).disabled = true;
  if (gl.tab === 'manager') gl.tab = 'timeline';
  $('#tab-manager').disabled = true;
  setSource('', false);
  afterPlayChange();
}

function showLive() {
  gl.play = null;
  $('#gl-play-bar').hidden = true;
  for (const sel of ['#gl-follow', '#gl-clear']) $(sel).disabled = false;
  $('#tab-manager').disabled = false;
  afterPlayChange();
}

function afterPlayChange() {
  crash.all = false; // a play shows its own crash first
  paintPlayButton();
  syncSourceOptions(true);
  renderStats();
  renderGameStatus();
  updateCrashCount();
  renderView();
}

async function deletePlays(ids) {
  const n = await run(api.playsDelete(ids));
  if (n === undefined) return;
  toast(`Deleted the logs of ${plural(n, 'play')}`, 'success');
  if (gl.play && ids.includes(gl.play.id)) gl.follow = true; // back to Live or Latest
  await loadPlays();
}

/** Tick plays to delete (the one on show first, if any). */
function deletePlaysDialog(preset = []) {
  const picked = new Set(preset);
  const all = h('button', { class: 'btn btn-ghost', type: 'button' });
  const list = h('div', { class: 'play-list' });
  const paint = () => {
    list.replaceChildren(...gl.plays.map(p => h('label', { class: `pick play-row${p.outcome === 'crashed' ? ' crashed' : ''}` },
      h('input', { type: 'checkbox', checked: picked.has(p.id), 'aria-label': `The play of ${fmtWhen(p.start)}`, onchange: ev => { if (ev.target.checked) picked.add(p.id); else picked.delete(p.id); paint(); } }),
      h('span', { class: 'pick-main' },
        h('span', { class: 'pick-name' }, h('span', { class: 'name' }, fmtWhen(p.start)), h('span', { class: `tag ${p.outcome === 'crashed' ? 'tag-err' : ''}` }, PLAY_HOW[p.outcome] || 'Ended')),
        h('span', { class: 'pick-desc' }, `${playLength(p)} · ${playCounts(p)} · ${plural(p.files || 0, 'log file')} saved`)))));
    all.textContent = picked.size && picked.size === gl.plays.length ? 'Select none' : 'Select all';
  };
  paint();
  all.onclick = () => { if (picked.size === gl.plays.length) picked.clear(); else gl.plays.forEach(p => picked.add(p.id)); paint(); };
  return modal({
    title: 'Delete plays',
    sub: 'Their timelines and saved log copies. The game\'s own logs and crash reports are not touched.',
    body: h('div', {}, h('div', { class: 'play-pick-all' }, all), list),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Delete the ticked plays', value: true, kind: 'btn-danger' }],
  }).then(yes => { if (yes && picked.size) deletePlays([...picked]); });
}

$('#gl-play-live').addEventListener('click', () => { gl.follow = true; loadPlays(); });
$('#gl-play-folder').addEventListener('click', () => gl.play && run(api.playOpenFolder(gl.play.id)));
$('#gl-play-delete').addEventListener('click', async () => {
  const p = gl.play;
  if (p && await confirmBox('Delete this play\'s logs?', `The play of ${fmtWhen(p.start)}: its timeline and saved log copies. The game's own logs and crash reports are not touched.`, 'Delete', true)) deletePlays([p.id]);
});
$('#gl-play-ask').addEventListener('click', () => {
  const p = gl.play;
  if (p) askAi(`Look at the logs of my play of ${fmtWhen(p.start)} (play ${p.id}, ${(PLAY_HOW[p.outcome] || 'ended').toLowerCase()} after ${playLength(p)}). What went wrong, is it different from my other plays, and how do I fix it?`);
});
api.onPlays(() => loadPlays());
// ---------------------------------------------------------------- crashes

/*
 * Each crash the game's crash reporter recorded: when, what (an access violation…), the DLL it
 * happened in and that DLL's mod (from the crash dump), and, opened, the errors from the minutes
 * before it, the crash logs mods wrote, and the game's last log lines. Ask AI reads it all.
 */
const crash = { list: null, open: null, details: new Map() };

const crashWhat = c => (/ACCESS_VIOLATION/i.test(c.expression || '') ? 'Access violation' : (c.expression || c.reason || 'Crash').replace(/\s*\(0x[0-9A-F]+\)$/i, ''));
const crashWhere = c => (!c.module ? 'where is unknown (no crash dump)'
  : c.module.system ? `in ${c.module.name} (a Windows file)`
    : c.module.notInGame ? `in ${c.module.name} (not in the game folder: another program's, e.g. a driver or overlay)`
      : `in ${c.module.name}${c.module.mod ? ` · ${c.module.mod}` : ''}`);
const crashAsk = c => `My game crashed at ${new Date(c.time).toLocaleString()} (crash ${c.id}). Read the crash report (get_crash_report), compare it with my other crashes, and tell me what caused it and how to fix it.`;

async function loadCrashes() {
  const r = await api.crashList();
  crash.list = r.ok || [];
  updateCrashCount();
  if (gl.tab === 'crashes') renderCrashes();
}

/** The play a crash ended (by its id, or its time inside the play). */
const playOf = c => gl.plays.find(p => p.crash === c.id || (c.time >= p.start - 60e3 && c.time <= (p.end || Date.now()) + 3 * 60e3)) || null;
/** The crashes on show: the shown play's, or every one. */
const shownCrashes = () => (crash.list || []).filter(c => !gl.play || crash.all || gl.play.crash === c.id || (c.time >= gl.play.start - 60e3 && c.time <= (gl.play.end || Date.now()) + 3 * 60e3));

function updateCrashCount() {
  if (!crash.list) return;
  const n = gl.play ? shownCrashes().length : crash.list.filter(c => Date.now() - c.time < 7 * 86400e3).length;
  $('#gl-crash-count').textContent = n || '';
  $('#gl-crash-count').title = n ? (gl.play ? 'This play crashed' : `${plural(n, 'crash', 'crashes')} in the last 7 days`) : '';
}

async function deleteCrashes(ids) {
  const many = ids.length > 1;
  const ok = await confirmBox(many ? `Delete ${ids.length} crash reports?` : 'Delete this crash report?',
    `${many ? 'Their folders are' : 'Its folder is'} removed from the game's crash report queue (%LOCALAPPDATA%\\REDEngine\\ReportQueue), dump included. The play logs are kept.`, 'Delete', true);
  if (!ok) return;
  const n = await run(api.crashDelete(ids));
  if (n === undefined) return;
  toast(`Deleted ${plural(n, 'crash report')}`, 'success');
  ids.forEach(id => crash.details.delete(id));
  if (ids.includes(crash.open)) crash.open = null;
  loadCrashes();
}

function renderCrashes() {
  const box = $('#gl-crash-list');
  if (!crash.list) { box.replaceChildren(h('p', { class: 'hint crash-empty' }, 'Reading crash reports…')); return; }
  const shown = shownCrashes();
  if (!shown.length) {
    box.replaceChildren(h('div', { class: 'empty crash-empty' }, h('span', { class: 'empty-icon' }, icon('check')),
      h('p', { class: 'empty-title' }, gl.play ? (gl.play.outcome === 'crashed' ? "This play's crash report is gone" : 'This play did not crash') : 'No crashes recorded'),
      h('p', { class: 'empty-text' }, gl.play ? (gl.play.outcome === 'crashed' ? "The game crashed, but its report is no longer in the game's crash report folder (deleted). The play's logs are still here." : `It ${gl.play.outcome === 'unknown' ? 'ended' : 'exited'} without a crash report.`) : 'When the game crashes, its report shows here: where it crashed, in which mod, and what came before.'),
      gl.play && crash.list.length ? h('div', { class: 'empty-actions' }, h('button', { class: 'btn', onclick: () => { crash.all = true; renderCrashes(); } }, `Show all ${plural(crash.list.length, 'crash', 'crashes')}`)) : null));
    return;
  }
  const sameDll = c => (c.module ? crash.list.filter(o => o !== c && o.module?.name === c.module.name).length : 0);
  const head = h('div', { class: 'crash-bar' },
    h('span', { class: 'hint' }, gl.play && !crash.all ? 'The crash that ended this play' : `${plural(shown.length, 'crash report')}, newest first`),
    gl.play && crash.list.length > shown.length ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { crash.all = true; renderCrashes(); } }, `Show all ${crash.list.length} crashes`) : null,
    gl.play && crash.all ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { crash.all = false; renderCrashes(); } }, "Only this play's") : null,
    h('button', { class: 'btn btn-sm btn-ghost', onclick: () => deleteCrashes(shown.map(c => c.id)) }, icon('trash'), h('span', {}, shown.length > 1 ? `Delete all ${shown.length}` : 'Delete')));
  box.replaceChildren(head, ...shown.map(c => {
    const isOpen = crash.open === c.id;
    const repeat = sameDll(c);
    const d = crash.details.get(c.id);
    return h('article', { class: `crash-card${isOpen ? ' open' : ''}`, dataset: { id: c.id } },
      h('div', { class: 'crash-head', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen),
        onclick: () => toggleCrash(c.id), onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleCrash(c.id); } } },
        h('span', { class: 'crash-icon' }, icon('alert')),
        h('div', { class: 'crash-titles' },
          h('div', { class: 'crash-title' }, `${crashWhat(c)} ${crashWhere(c)}`),
          h('div', { class: 'crash-meta' }, [new Date(c.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), c.module ? `${c.module.name}+${c.module.offset}` : ''].filter(Boolean).join('  ·  '))),
        repeat ? h('span', { class: 'tag tag-warn', title: 'The same DLL in more than one crash is a strong lead' }, `same as ${plural(repeat, 'other crash', 'other crashes')}`) : null,
        h('button', { class: 'btn btn-sm', onclick: ev => { ev.stopPropagation(); askAi(crashAsk(c)); } }, icon('sparkle'), h('span', {}, 'Ask AI why')),
        playOf(c) && playOf(c).id !== gl.play?.id ? h('button', { class: 'btn btn-sm btn-ghost', title: 'Show the logs of the play this crash ended', onclick: ev => { ev.stopPropagation(); choosePlay(playOf(c).id); } }, icon('clock'), h('span', {}, 'Its play')) : null,
        h('button', { class: 'btn btn-sm btn-ghost btn-icon', title: 'Open the crash report folder', 'aria-label': 'Open the crash report folder', onclick: ev => { ev.stopPropagation(); run(api.crashOpen(c.id)); } }, icon('folder')),
        h('button', { class: 'btn btn-sm btn-ghost btn-icon', title: 'Delete this crash report', 'aria-label': 'Delete this crash report', onclick: ev => { ev.stopPropagation(); deleteCrashes([c.id]); } }, icon('trash')),
        icon('chevron', `crash-chev${isOpen ? ' open' : ''}`)),
      isOpen ? crashBody(c, d) : null);
  }));
}

function crashBody(c, d) {
  if (!d) return h('div', { class: 'crash-body' }, h('p', { class: 'hint' }, 'Reading the crash…'));
  const section = (title, ...kids) => h('section', { class: 'crash-sec' }, h('h4', {}, title), ...kids);
  return h('div', { class: 'crash-body' },
    section('What happened',
      h('p', {}, `${d.reason || 'Crash'}${d.expression ? `: ${d.expression}` : ''}`),
      d.message ? h('p', { class: 'hint' }, d.message) : null,
      d.module ? h('p', {}, 'In ', h('code', {}, `${d.module.name}+${d.module.offset}`), d.module.mod ? `, from ${d.module.mod}` : '', d.module.file ? h('span', { class: 'hint' }, ` (${d.module.file})`) : '', d.module.notInGame ? ' (not in the game folder: another program\'s, e.g. a driver or overlay, or a mod file since removed)' : '', d.module.system ? ' (a Windows file: the real cause is usually what called it)' : '') : null),
    section(`Errors and warnings in the 10 minutes before (${d.problemsBefore.length})`,
      d.problemsBefore.length ? h('div', { class: 'crash-lines' }, d.problemsBefore.slice(-25).map(e => h('div', { class: `crash-line lv-${e.level}` }, h('span', { class: 'crash-src' }, e.source), h('span', {}, e.text))))
        : h('p', { class: 'hint' }, 'None in the game\'s logs (or the app was not running then).')),
    d.modCrashLogs.length ? section('Crash logs mods wrote', ...d.modCrashLogs.map(l => h('div', {}, h('p', { class: 'hint' }, l.file, l.mod ? ` · ${l.mod}` : ''), h('pre', { class: 'crash-pre' }, l.text)))) : null,
    d.gameLog ? h('details', { class: 'crash-sec' }, h('summary', {}, 'The game\'s last log lines'), h('pre', { class: 'crash-pre' }, d.gameLog)) : null,
    d.modDlls.length ? h('details', { class: 'crash-sec' }, h('summary', {}, `Mod DLLs that were loaded (${d.modDlls.length})`),
      h('div', { class: 'crash-dlls' }, d.modDlls.map(m => h('span', { class: 'tag', title: m.mod || '' }, m.file.split('/').pop())))) : null);
}

async function toggleCrash(id) {
  crash.open = crash.open === id ? null : id;
  renderCrashes();
  if (crash.open && !crash.details.has(id)) {
    const r = await api.crashDetails(id);
    if (r.ok) crash.details.set(id, r.ok);
    renderCrashes();
  }
}

/** Show one crash (from the timeline, or a crash just now). */
async function showCrash(id) {
  goTo('gamelog');
  setTab('crashes');
  await loadCrashes();
  if (crash.open !== id) await toggleCrash(id);
  $(`#gl-crash-list [data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
}

// The game just crashed: say so wherever the user is.
api.onCrash(c => {
  loadCrashes();
  toast(`Cyberpunk 2077 crashed${c.module ? ` ${crashWhere(c)}` : ''}`, 'error', { label: 'See what happened', fn: () => showCrash(c.id) });
});
function setSource(s, rerender = true) {
  gl.source = s;
  syncSourceOptions();
  $('#gl-source').value = s;
  if (rerender) renderView();
}
function setSearch(q) { $('#gl-search').value = q; gl.q = q.trim().toLowerCase(); }
function setLevel(l) {
  gl.level = l;
  setSegActive('#gl-level', 'level', l);
  renderView();
}

$$('#gl-tabs .seg-btn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
// Tabs: arrow keys move between them.
$('#gl-tabs').addEventListener('keydown', ev => {
  if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
  const tabs = $$('#gl-tabs .seg-btn');
  const i = tabs.findIndex(b => b.dataset.tab === gl.tab);
  const next = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  setTab(next.dataset.tab);
  next.focus();
});
$$('#gl-level .seg-btn').forEach(b => b.addEventListener('click', () => setLevel(b.dataset.level)));
$('#gl-source').addEventListener('change', ev => setSource(ev.target.value));
$('#gl-search').addEventListener('input', debounce(ev => { gl.q = ev.target.value.trim().toLowerCase(); renderView(); }, 150));
$('#gl-follow').addEventListener('click', () => {
  gl.paused = !gl.paused;
  if (!gl.paused) { gl.held = 0; renderView(); }
  updatePauseLabel();
});
$('#gl-clear').addEventListener('click', () => {
  gl.clearedAfter = gl.entries.length ? gl.entries[gl.entries.length - 1].id : 0;
  recount();
  renderStats();
  renderView();
  scheduleModProblems();
});
$('#gl-jump').addEventListener('click', () => {
  const view = $('#gl-timeline');
  view.scrollTop = view.scrollHeight;
  $('#gl-jump').hidden = true;
});
$('#gl-timeline').addEventListener('scroll', ev => { if (atBottom(ev.currentTarget)) $('#gl-jump').hidden = true; });
$('#gl-stat-err').addEventListener('click', () => { setLevel('error'); setTab('problems'); });
$('#gl-stat-warn').addEventListener('click', () => { setLevel('warn'); setTab('problems'); });
$('#gl-stat-src').addEventListener('click', () => setTab('sources'));
// Export the lines this view shows (its search, level and source), with every log's details.
$('#gl-export').addEventListener('click', exportReport);

pageHooks.gamelog = () => { renderView(); loadCrashes(); loadPlays(); };
snapshotHooks.push(snap => {
  if (snap.gameStatus) { gl.status = snap.gameStatus; renderGameStatus(); }
  scheduleModProblems();
});

// Live batches that arrive before the initial snapshot wait, so lines stay in order and unique.
let early = [];
api.onGameLog(batch => { if (early) early.push(...batch); else onBatch(batch); });
api.onGameStatus(s => { gl.status = s; renderGameStatus(); renderMods(); renderPlay(); loadPlays(); });
api.onGameLogReset(() => {
  gl.entries = [];
  gl.sources.clear();
  recount();
  renderStats();
  renderView();
});

window.addEventListener('DOMContentLoaded', async () => {
  const snap = await run(api.gameLogSnapshot());
  const held = early || [];
  early = null;
  if (!snap) { if (held.length) onBatch(held); return; }
  ingest(snap.entries);
  const lastId = snap.entries.length ? snap.entries[snap.entries.length - 1].id : 0;
  const later = held.filter(e => e.id > lastId);
  if (later.length) ingest(later);
  gl.status = snap.status;
  syncSourceOptions();
  renderStats();
  renderGameStatus();
  updatePauseLabel();
  updateModProblems();
  if ($('#page-gamelog').classList.contains('active')) renderView();
});

setInterval(() => {
  if ($('#page-gamelog').classList.contains('active') && gl.tab === 'sources') renderSources();
}, 5000);
