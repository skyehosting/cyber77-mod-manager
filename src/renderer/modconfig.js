'use strict';
/* global api, $, $$, h, icon, run, fmtSize, plural, pageHooks, setSegActive, openEditor, goTo */

// ---------------------------------------------------------------- mod config

/*
 * Every mod's files as a tree: this app's mods and Vortex's (enabled or not) and files no mod
 * manager put in the game folder. Paths start at the game folder. A text file shows a pencil when
 * pointed at; it opens the file in the built-in editor (editor.js).
 */
const cfg = { list: null, filter: 'all', q: '', open: new Set(), files: new Map(), folders: new Map() };

const SOURCE_TAG = { vortex: 'Vortex', hand: 'Not from a manager' };

async function loadConfig() {
  const r = await run(api.cfgList());
  if (!r) return;
  cfg.list = r;
  // Open mods are read again (files may have been added or changed); uninstalled ones just close.
  for (const k of [...cfg.open]) if (!r.some(m => m.key === k)) { cfg.open.delete(k); cfg.files.delete(k); }
  await Promise.all([...cfg.open].map(k => loadModFiles(k)));
  renderConfig();
}

async function loadModFiles(key) {
  const r = await run(api.cfgFiles(key));
  if (!r) { cfg.open.delete(key); return; }
  cfg.files.set(key, r);
  if (!cfg.folders.has(key)) {
    // Small mods open fully; larger ones show their top folders.
    const open = new Set();
    const tree = buildTree(r.files);
    const walk = (node, depth) => {
      for (const f of node.dirs.values()) {
        if (r.files.length <= 30 || depth === 0) open.add(f.path);
        walk(f, depth + 1);
      }
    };
    walk(tree, 0);
    cfg.folders.set(key, open);
  }
}

/** Folders and files; a folder holding only one folder is shown as one ("bin/x64/plugins/…"). */
function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i].toLowerCase();
      if (!node.dirs.has(key)) node.dirs.set(key, { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
      node = node.dirs.get(key);
    }
    node.files.push(f);
  }
  const squash = node => {
    for (const [k, d] of node.dirs) {
      let cur = d;
      while (cur.dirs.size === 1 && !cur.files.length) {
        const only = [...cur.dirs.values()][0];
        cur = { ...only, name: `${cur.name}/${only.name}` };
      }
      node.dirs.set(k, cur);
      squash(cur);
    }
    return node;
  };
  return squash(root);
}

function shown() {
  const q = cfg.q.trim().toLowerCase();
  return (cfg.list || []).filter(m => {
    if (cfg.filter === 'enabled' && (!m.enabled || m.source === 'hand')) return false;
    if (cfg.filter === 'disabled' && m.enabled) return false;
    if (cfg.filter === 'vortex' && m.source !== 'vortex') return false;
    if (cfg.filter === 'hand' && m.source !== 'hand') return false;
    return !q || `${m.name} ${m.folder || ''}`.toLowerCase().includes(q);
  });
}

function fileRow(mod, f, depth) {
  const open = () => openEditor({ loc: f.loc, mod: mod.name, note: f.note, vortex: mod.source === 'vortex' || !!cfg.files.get(mod.key)?.vortex });
  const name = f.rel.split('/').pop();
  return h('div', {
    class: `cfg-file${f.editable ? ' editable' : ''}`, role: 'treeitem', tabindex: '0', style: `--depth:${depth}`, title: f.rel,
    onkeydown: ev => { if (ev.key === 'Enter' && f.editable) { ev.preventDefault(); open(); } },
    ondblclick: () => { if (f.editable) open(); },
  },
  icon(f.editable ? 'file-code' : 'file'),
  h('span', { class: 'cfg-name' }, name),
  f.note ? h('span', { class: 'cfg-note' }, f.note) : null,
  h('span', { class: 'cfg-size' }, f.size >= 0 ? fmtSize(f.size) : 'missing'),
  f.editable
    ? h('button', { class: 'btn btn-icon btn-sm cfg-edit', title: `Edit ${name}`, 'aria-label': `Edit ${name}`, tabindex: '-1', onclick: ev => { ev.stopPropagation(); open(); } }, icon('edit'))
    : h('span', { class: 'cfg-edit-gap', 'aria-hidden': 'true' }));
}

function folderEl(mod, node, depth) {
  const openSet = cfg.folders.get(mod.key);
  const kids = [];
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const d of dirs) {
    const isOpen = openSet.has(d.path);
    const toggle = () => { if (isOpen) openSet.delete(d.path); else openSet.add(d.path); renderConfig(); };
    kids.push(h('div', {
      class: 'cfg-dir', role: 'treeitem', tabindex: '0', 'aria-expanded': String(isOpen), style: `--depth:${depth}`, title: d.path,
      onclick: toggle, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } },
    }, icon('chevron-right', `cfg-chev${isOpen ? ' open' : ''}`), icon('folder'), h('span', { class: 'cfg-name' }, d.name)));
    if (isOpen) kids.push(...folderEl(mod, d, depth + 1));
  }
  const files = [...node.files].sort((a, b) => a.rel.localeCompare(b.rel, undefined, { sensitivity: 'base' }));
  for (const f of files) kids.push(fileRow(mod, f, depth));
  return kids;
}

function renderConfig() {
  const list = shown();
  const all = cfg.list || [];
  $('#cfg-sub').textContent = all.length
    ? `${plural(all.filter(m => m.source !== 'hand').length, 'mod')} and ${plural(all.filter(m => m.source === 'hand').length, 'folder')} not from a manager. Point at a text file and click the pencil to edit it.`
    : 'Every mod\'s files, enabled or not. Point at a text file and click the pencil to edit it.';
  const box = $('#cfg-list');
  if (!list.length) {
    box.replaceChildren(h('p', { class: 'empty-text cfg-empty' }, cfg.list ? 'No mods match.' : 'Reading the mod folders…'));
    return;
  }
  box.replaceChildren(...list.map(m => {
    const isOpen = cfg.open.has(m.key);
    const toggle = async () => {
      if (isOpen) cfg.open.delete(m.key);
      else { cfg.open.add(m.key); if (!cfg.files.has(m.key)) await loadModFiles(m.key); }
      renderConfig();
    };
    const head = h('div', {
      class: 'cfg-mod', role: 'treeitem', tabindex: '0', 'aria-expanded': String(isOpen), dataset: { key: m.key },
      onclick: toggle, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } },
    },
    icon('chevron-right', `cfg-chev${isOpen ? ' open' : ''}`),
    h('span', { class: 'cfg-mod-name' }, m.name, m.version ? h('span', { class: 'cfg-ver' }, ` v${m.version}`) : null),
    m.folder ? h('span', { class: 'cfg-folder' }, m.folder) : null,
    SOURCE_TAG[m.source] ? h('span', { class: 'tag' }, SOURCE_TAG[m.source]) : null,
    m.source === 'hand' ? null : h('span', { class: `tag ${m.enabled ? 'tag-ok' : 'tag-off'}` }, m.enabled ? 'Enabled' : 'Disabled'),
    h('span', { class: 'cfg-count' }, plural(m.fileCount, 'file')));
    const files = cfg.files.get(m.key);
    return h('div', { class: `cfg-group${isOpen ? ' open' : ''}` }, head,
      isOpen && files ? h('div', { class: 'cfg-tree', role: 'group' }, files.files.length ? folderEl(m, buildTree(files.files), 1) : h('p', { class: 'hint cfg-none' }, 'No files.')) : null);
  }));
}

/** From a mod's details: show its files here. */
async function openConfigFor(key) {
  goTo('config');
  cfg.filter = 'all';
  cfg.q = '';
  $('#cfg-search').value = '';
  setSegActive('#cfg-filter', 'f', 'all');
  if (!cfg.list) await loadConfig();
  cfg.open.add(key);
  await loadModFiles(key);
  renderConfig();
  $(`#cfg-list [data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'start' });
}

$('#cfg-search').addEventListener('input', ev => { cfg.q = ev.target.value; renderConfig(); });
$$('#cfg-filter .seg-btn').forEach(b => b.addEventListener('click', () => {
  cfg.filter = b.dataset.f;
  setSegActive('#cfg-filter', 'f', cfg.filter);
  renderConfig();
}));
$('#cfg-refresh').addEventListener('click', () => { cfg.files.clear(); loadConfig(); });
pageHooks.config = loadConfig;
