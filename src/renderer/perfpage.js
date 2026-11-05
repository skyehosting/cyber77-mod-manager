'use strict';
/* global api, $, h, icon, run, state, pageChangeHooks */

/*
 * The Performance page: the PC's CPU, memory, GPU, video memory, disk and network, and the same for
 * the game's own process, read by the main process (core/perf.js) every interval, only while this
 * page is shown and the window can be seen (Pause stops it too). The tiles are made once; each
 * reading changes their numbers and graphs only, so a pointer resting on a graph stays put.
 * Settings → Performance: how often, how much history, graphs or not.
 */

const pf = { on: false, paused: false, hist: [], built: false };
const perfSetting = (k, d) => (state.settings && state.settings[k] !== undefined ? state.settings[k] : d);

// ---- numbers as words
const okNum = v => typeof v === 'number' && Number.isFinite(v);
const pctText = v => (okNum(v) ? `${v < 10 ? v.toFixed(1) : Math.round(v)}%` : '—');
function bytesText(b) {
  if (!okNum(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? Math.round(n) : n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
const rateText = b => (okNum(b) ? `${bytesText(b)}/s` : '—');
// Network in bits per second, as Task Manager and internet plans say it.
function bitsText(b) {
  if (!okNum(b)) return '—';
  const bits = b * 8;
  const u = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let i = 0;
  let n = bits;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${i === 0 ? Math.round(n) : n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
const share = (a, b) => (okNum(a) && okNum(b) && b > 0 ? (a / b) * 100 : null);
const sum = (a, b) => (okNum(a) || okNum(b) ? (a || 0) + (b || 0) : null);
function runningFor(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/*
 * The tiles. value: the big number; sub: the line under it; series: what the graph draws (one line,
 * or two with a legend); max: a fixed top (percentages) or none (the graph fits its highest point);
 * fmt: a point's value in words (the graph's readout).
 */
const SYSTEM_TILES = [
  { key: 'cpu', label: 'CPU', value: s => pctText(s.system.cpu), sub: () => `${navigator.hardwareConcurrency || '?'} logical processors`, series: [s => s.system.cpu], max: 100, fmt: [pctText] },
  {
    key: 'mem', label: 'Memory', value: s => pctText(share(s.system.memUsed, s.system.memTotal)),
    sub: s => `${bytesText(s.system.memUsed)} of ${bytesText(s.system.memTotal)} in use`, series: [s => share(s.system.memUsed, s.system.memTotal)], max: 100, fmt: [pctText],
  },
  { key: 'gpu', label: 'GPU', value: s => pctText(s.system.gpu), sub: s => s.system.gpuName || 'No graphics card found', series: [s => s.system.gpu], max: 100, fmt: [pctText] },
  {
    key: 'vram', label: 'Video memory', value: s => (okNum(s.system.vramTotal) ? pctText(share(s.system.vramUsed, s.system.vramTotal)) : bytesText(s.system.vramUsed)),
    sub: s => (okNum(s.system.vramTotal) ? `${bytesText(s.system.vramUsed)} of ${bytesText(s.system.vramTotal)} in use` : 'Its size is not known'),
    series: [s => (okNum(s.system.vramTotal) ? share(s.system.vramUsed, s.system.vramTotal) : null)], max: 100, fmt: [pctText],
  },
  {
    key: 'disk', label: 'Disk', value: s => rateText(sum(s.system.diskRead, s.system.diskWrite)),
    sub: s => [['Read', rateText(s.system.diskRead)], ['Write', rateText(s.system.diskWrite)]], series: [s => s.system.diskRead, s => s.system.diskWrite], fmt: [rateText, rateText],
  },
  {
    key: 'net', label: 'Network', value: s => bitsText(sum(s.system.netDown, s.system.netUp)),
    sub: s => [['Down', bitsText(s.system.netDown)], ['Up', bitsText(s.system.netUp)]], series: [s => s.system.netDown, s => s.system.netUp], fmt: [bitsText, bitsText],
  },
];
const GAME_TILES = [
  { key: 'gcpu', label: 'CPU', value: s => pctText(s.game?.cpu), sub: () => 'Of the whole CPU, all its cores', series: [s => s.game?.cpu], max: 100, fmt: [pctText] },
  {
    key: 'gmem', label: 'Memory', value: s => bytesText(s.game?.mem),
    sub: s => (okNum(share(s.game?.mem, s.system.memTotal)) ? `${pctText(share(s.game.mem, s.system.memTotal))} of your memory` : ''), series: [s => s.game?.mem], fmt: [bytesText],
  },
  { key: 'ggpu', label: 'GPU', value: s => pctText(s.game?.gpu), sub: s => (okNum(s.game?.gpu) ? 'Its busiest engine' : 'Not given for this graphics card'), series: [s => s.game?.gpu], max: 100, fmt: [pctText] },
  {
    key: 'gvram', label: 'Video memory', value: s => bytesText(s.game?.vram),
    sub: s => (okNum(share(s.game?.vram, s.system.vramTotal)) ? `${pctText(share(s.game.vram, s.system.vramTotal))} of ${bytesText(s.system.vramTotal)}` : okNum(s.game?.vram) ? '' : 'Not given for this graphics card'),
    series: [s => s.game?.vram], fmt: [bytesText],
  },
  {
    key: 'gio', label: 'Reads and writes', value: s => rateText(sum(s.game?.ioRead, s.game?.ioWrite)),
    sub: s => [['Read', rateText(s.game?.ioRead)], ['Write', rateText(s.game?.ioWrite)]], series: [s => s.game?.ioRead, s => s.game?.ioWrite], fmt: [rateText, rateText],
  },
];

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const el = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

/** One tile: its label, number, line under it and graph (the graph's readout shows where the pointer is). */
function perfTile(t) {
  const graph = svgEl('svg', { class: 'perf-graph', viewBox: '0 0 100 32', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const lines = t.series.map((_, i) => {
    if (t.series.length === 1) graph.append(svgEl('path', { class: 'perf-area', d: '' }));
    const p = svgEl('path', { class: `perf-line perf-s${i}`, d: '', 'vector-effect': 'non-scaling-stroke' });
    graph.append(p);
    return p;
  });
  const cross = svgEl('line', { class: 'perf-cross', x1: '0', x2: '0', y1: '0', y2: '32', 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
  graph.append(cross);
  const tile = h('div', { class: 'perf-tile', dataset: { key: t.key } },
    h('div', { class: 'perf-tile-head' }, h('span', { class: 'perf-label' }, t.label), h('span', { class: 'perf-readout', 'aria-hidden': 'true' })),
    h('div', { class: 'perf-value', role: 'status', 'aria-live': 'off' }, '—'),
    h('div', { class: 'perf-sub' }),
    h('div', { class: 'perf-graph-wrap' }, graph));
  const readout = tile.querySelector('.perf-readout');
  const wrap = tile.querySelector('.perf-graph-wrap');
  // The pointer over a graph: that moment's values, and how long ago.
  wrap.addEventListener('pointermove', ev => {
    const pts = pf.hist;
    if (pts.length < 2) return;
    const r = wrap.getBoundingClientRect();
    const span = perfHistoryMs();
    const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const at = pts[pts.length - 1].at - (1 - x) * span;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
    const bx = 100 - ((pts[pts.length - 1].at - best.at) / span) * 100;
    cross.setAttribute('x1', bx);
    cross.setAttribute('x2', bx);
    cross.setAttribute('visibility', 'visible');
    const ago = Math.round((Date.now() - best.at) / 1000);
    const vals = t.series.map((f, i) => (t.series.length > 1 ? `${t.sub(best)[i][0]} ` : '') + t.fmt[i](f(best))).join(' · ');
    readout.textContent = `${ago ? `${ago} s ago` : 'now'}: ${vals}`;
  });
  wrap.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); readout.textContent = ''; });
  return { t, tile, lines, area: graph.querySelector('.perf-area') };
}

function perfHistoryMs() { return Math.max(10, Number(perfSetting('perfHistory', 60)) || 60) * 1000; }

function buildPerf() {
  if (pf.built) return;
  pf.built = true;
  pf.sys = SYSTEM_TILES.map(perfTile);
  pf.game = GAME_TILES.map(perfTile);
  $('#perf-system').replaceChildren(...pf.sys.map(x => x.tile));
  $('#perf-game').replaceChildren(...pf.game.map(x => x.tile));
}

/** A tile's graph from the history: x is time (newest at the right edge), y from 0 to the top. */
function perfGraph(x, pts, span) {
  const end = pts.length ? pts[pts.length - 1].at : 0;
  const values = x.t.series.map(f => pts.map(p => f(p)));
  const top = x.t.max || Math.max(1, ...values.flat().filter(okNum)) * 1.15;
  x.t.series.forEach((_, i) => {
    let d = '';
    let pen = false;
    pts.forEach((p, j) => {
      const v = values[i][j];
      if (!okNum(v)) { pen = false; return; }
      const px = (100 - ((end - p.at) / span) * 100).toFixed(2);
      const py = (32 - (Math.min(v, top) / top) * 30).toFixed(2);
      d += `${pen ? 'L' : 'M'}${px} ${py}`;
      pen = true;
    });
    x.lines[i].setAttribute('d', d);
    // One line: a faint area under it, closed down to the baseline.
    if (x.area) {
      const m = d.match(/^M([\d.]+)/);
      const last = d.match(/([\d.]+) [\d.]+$/);
      x.area.setAttribute('d', m && last && !d.slice(1).includes('M') ? `${d}L${last[1]} 32L${m[1]} 32Z` : '');
    }
  });
}

function paintPerfTiles(list, s, pts, span, graphs) {
  for (const x of list) {
    x.tile.querySelector('.perf-value').textContent = x.t.value(s);
    const sub = x.t.sub(s);
    // Two lines: the legend is the line under the number (a swatch per line, in its colour).
    x.tile.querySelector('.perf-sub').replaceChildren(...(Array.isArray(sub)
      ? sub.map(([name, val], i) => h('span', { class: 'perf-legend' }, h('span', { class: `perf-swatch perf-s${i}`, 'aria-hidden': 'true' }), `${name} ${val}`))
      : [sub || '']));
    x.tile.classList.toggle('no-graph', !graphs);
    if (graphs) perfGraph(x, pts, span);
  }
}

function renderPerf(s) {
  buildPerf();
  const span = perfHistoryMs();
  const graphs = perfSetting('perfGraphs', true) !== false;
  pf.hist.push(s);
  while (pf.hist.length && s.at - pf.hist[0].at > span + (s.ms || 1000)) pf.hist.shift();
  paintPerfTiles(pf.sys, s, pf.hist, span, graphs);
  const game = s.game;
  $('#perf-game').hidden = !game;
  $('#perf-game-empty').hidden = !!game;
  if (game) {
    // The game's graphs from the moment it is this process (a restarted game starts a new history).
    const pts = pf.hist.filter(p => p.game?.pid === game.pid);
    paintPerfTiles(pf.game, s, pts, span, graphs);
  }
  $('#perf-game-meta').textContent = game ? [`Process ${game.pid}`, game.startedAt ? `running for ${runningFor(Date.now() - game.startedAt)}` : ''].filter(Boolean).join(' · ') : '';

  const notes = Array.isArray(s.notes) ? s.notes.filter(n => typeof n === 'string').slice(0, 3) : [];
  const sig = JSON.stringify(notes);
  if ($('#perf-notes').dataset.sig !== sig) {
    $('#perf-notes').dataset.sig = sig;
    $('#perf-notes').replaceChildren(...notes.map(n => h('div', { class: 'banner banner-cloud', role: 'note' }, icon('info'), h('span', {}, n))));
  }
}

function perfSubText() {
  const ms = Number(perfSetting('perfInterval', 1000)) || 1000;
  const every = ms === 500 ? 'every half second' : ms === 1000 ? 'every second' : `every ${ms / 1000} seconds`;
  return pf.paused ? 'Paused: the numbers are not read now' : `Your PC and the game, read ${every} while this page is open`;
}

async function startPerf() {
  if (pf.on || pf.paused || document.hidden || !$('#page-perf').classList.contains('active')) return;
  pf.on = true;
  buildPerf();
  $('#perf-sub').textContent = perfSubText();
  const r = await run(api.perfStart());
  if (!r) pf.on = false;
}
function stopPerf() {
  if (!pf.on) return;
  pf.on = false;
  api.perfStop().catch(() => {});
}

api.onPerf(s => { if (pf.on && s && s.system) renderPerf(s); });
pageChangeHooks.push(page => { if (page === 'perf') { pf.hist = []; startPerf(); } else stopPerf(); });
// Not while the window is minimized or hidden: nobody is looking.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPerf(); else startPerf(); });
$('#perf-pause').addEventListener('click', ev => {
  pf.paused = !pf.paused;
  const b = ev.currentTarget;
  b.setAttribute('aria-pressed', String(pf.paused));
  b.querySelector('use').setAttribute('href', pf.paused ? '#i-play' : '#i-pause');
  b.querySelector('span').textContent = pf.paused ? 'Resume' : 'Pause';
  b.setAttribute('aria-label', pf.paused ? 'Resume' : 'Pause');
  if (pf.paused) stopPerf(); else startPerf();
  $('#perf-sub').textContent = perfSubText();
});
