'use strict';
/* global gl, setPlayProfile, choosePlay, confirmBox, api, $, h, icon, run, toast, plural, fmtSize, state, modAction, drawerSections, snapshotHooks, withModal, showModal, keepFocus, pageHooks, goTo, setModFilter, CAT_LABEL, cfg, renderConfig, setSegActive, moveFromVortex, openDrawer, modal */

// ---------------------------------------------------------------- mod details: update and health

drawerSections.push(m => {
  const u = state.snap.updates?.[m.id];
  if (!u) return [];
  return [
    h('h2', { dataset: { section: 'update' } }, 'Update available'),
    h('div', { class: 'notice notice-info' },
      icon('up-circle'),
      h('div', { class: 'notice-text' },
        h('div', { class: 'name' }, `${u.name}${u.version ? ` · v${u.version}` : ''}`),
        h('div', { class: 'subname' }, [`Installed: ${m.version ? `v${m.version}` : m.name}`, u.size ? fmtSize(u.size) : ''].filter(Boolean).join(' · '))),
      h('button', { class: 'btn btn-sm btn-primary', dataset: { key: 'update' }, onclick: () => modAction('update', [m.id]) }, 'Update')),
  ];
});

drawerSections.push(m => {
  if (!m.health) return [];
  const parts = [];
  if (m.health.missing) parts.push(`${plural(m.health.missing, 'file')} missing from the game folder`);
  if (m.health.replaced) parts.push(`${plural(m.health.replaced, 'file')} replaced by another tool`);
  return [
    h('h2', { dataset: { section: 'health' } }, 'Needs repair'),
    h('div', { class: 'notice notice-warn' },
      icon('alert'),
      h('div', { class: 'notice-text' },
        h('div', {}, parts.join(', ')),
        h('div', { class: 'subname' }, 'Repair puts this mod\'s own files back. Replaced files are backed up first.')),
      h('button', { class: 'btn btn-sm', dataset: { key: 'repair' }, onclick: () => modAction('repair', [m.id]) }, icon('wrench'), h('span', {}, 'Repair'))),
  ];
});

// ---------------------------------------------------------------- requirements checklist

const DEP_STATUS = {
  missing: { label: 'Not installed', tag: 'tag-warn', pick: true },
  downloaded: { label: 'Downloaded — will install', tag: '', pick: true },
  disabled: { label: 'Disabled — will enable', tag: '', pick: true },
  installed: { label: 'Installed', tag: '', pick: false },
  'in-game': { label: 'In game folder', tag: '', pick: false },
  queued: { label: 'Downloading', tag: '', pick: false },
  external: { label: 'Not on Nexus', tag: '', pick: false },
  error: { label: 'Could not read', tag: 'tag-err', pick: false },
};
const isHttps = url => /^https:\/\//i.test(url || '');

/**
 * Read the links, let the user pick which files to get (grouped by the mod page's categories), then
 * — if the mods have requirements — show those as a checklist before anything is downloaded.
 */
async function downloadLinks(text) {
  const plan = await run(api.planLinks(text));
  if (!plan) return null;
  if (!plan.mods.length) {
    toast(plan.errors[0] || 'No mods found in those links', 'error');
    return { mods: 0, queued: 0, skipped: 0, dependencies: 0, external: [], errors: plan.errors };
  }
  const files = await chooseFiles(plan);
  if (files === null) {
    toast('Download cancelled');
    return null;
  }
  let chosen = [];
  if (plan.deps.length) {
    chosen = await chooseRequirements(plan, files);
    if (chosen === null) {
      toast('Download cancelled');
      return null;
    }
  }
  return run(api.queuePlan(plan.token, chosen, files));
}

const FILE_GROUPS = [
  ['MAIN', 'Main files'], ['UPDATE', 'Updates'], ['OPTIONAL', 'Optional files'],
  ['MISCELLANEOUS', 'Miscellaneous'], ['OLD_VERSION', 'Old versions'], ['ARCHIVED', 'Archived'],
];
const fmtDate = t => (t ? new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

/** Every file of every mod, by category, ticked as the mod page suggests. Resolves {modId: [fileIds]} or null. */
function chooseFiles(plan) {
  return withModal(() => new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal large';
    m.setAttribute('aria-labelledby', 'files-title');
    const boxes = []; // [checkbox, mod, file]
    const groupBoxes = []; // [checkbox, its file boxes]
    const modCounts = []; // [element, mod, its file boxes]

    const fileRow = (mod, f) => {
      const box = h('input', { type: 'checkbox', checked: !!f.selected, 'aria-label': `Download ${f.name}`, onchange: refresh });
      boxes.push([box, mod, f]);
      const meta = [f.version ? `v${f.version}` : '', f.size ? fmtSize(f.size) : '', fmtDate(f.uploaded)].filter(Boolean).join(' · ');
      return { box, el: h('label', { class: 'pick', title: f.description ? `${f.name}\n\n${f.description}` : f.fileName },
        box,
        h('span', { class: 'pick-main' },
          h('span', { class: 'pick-name' },
            h('span', { class: 'name' }, f.name),
            f.downloaded ? h('span', { class: 'tag', title: 'Already in your downloads: it is not downloaded again' }, 'Downloaded') : null,
            h('span', { class: 'pick-meta' }, meta)),
          f.description ? h('span', { class: 'pick-desc' }, f.description) : null)) };
    };

    const groupEl = (mod, [cat, label], list) => {
      const rows = list.map(f => fileRow(mod, f));
      const mine = rows.map(r => r.box);
      const all = h('input', { type: 'checkbox', 'aria-label': `All ${label.toLowerCase()} of ${mod.name}`, onchange: ev => { mine.forEach(b => { b.checked = ev.target.checked; }); refresh(); } });
      groupBoxes.push([all, mine]);
      const head = h('label', { class: 'pick-group-head' }, all, h('span', {}, label), h('span', { class: 'pick-n' }, String(list.length)));
      // Old and archived files stay folded unless one of them is already ticked.
      const folded = ['OLD_VERSION', 'ARCHIVED'].includes(cat) && !list.some(f => f.selected);
      if (folded) {
        return h('details', { class: 'pick-group' },
          h('summary', {}, h('span', {}, label), h('span', { class: 'pick-n' }, String(list.length))),
          h('label', { class: 'pick-group-head pick-group-inner' }, all, h('span', {}, `All ${label.toLowerCase()}`)),
          h('div', { class: 'pick-rows' }, rows.map(r => r.el)));
      }
      return h('section', { class: 'pick-group' }, head, h('div', { class: 'pick-rows' }, rows.map(r => r.el)));
    };

    const modEl = mod => {
      const start = boxes.length;
      const known = new Set(FILE_GROUPS.map(([c]) => c));
      const groups = [...FILE_GROUPS, ...[...new Set(mod.allFiles.map(f => f.category))].filter(c => !known.has(c)).map(c => [c, CAT_LABEL[c] || c])];
      const els = groups.map(g => [g, mod.allFiles.filter(f => f.category === g[0])]).filter(([, l]) => l.length).map(([g, l]) => groupEl(mod, g, l));
      const mine = boxes.slice(start).map(([b]) => b);
      const counter = h('span', { class: 'pick-mod-count' });
      modCounts.push([counter, mod, mine]);
      const single = plan.mods.length === 1;
      return h('div', { class: 'pick-mod' },
        single ? null : h('div', { class: 'pick-mod-head', title: mod.summary || '' },
          h('span', { class: 'name' }, mod.name),
          mod.author ? h('span', { class: 'subname' }, `by ${mod.author}`) : null,
          counter),
        mod.allFiles.length ? els : h('p', { class: 'hint' }, 'This mod has no files to download.'));
    };

    const countLine = h('span', { class: 'foot-note' });
    const goBtn = h('button', { class: 'btn btn-primary', onclick: () => close(picked()) });
    const picked = () => {
      const out = {};
      for (const mod of plan.mods) out[mod.modId] = [];
      for (const [b, mod, f] of boxes) if (b.checked) out[mod.modId].push(Number(f.fileId));
      return out;
    };
    function refresh() {
      for (const [all, mine] of groupBoxes) {
        const n = mine.filter(b => b.checked).length;
        all.checked = n === mine.length;
        all.indeterminate = n > 0 && n < mine.length;
      }
      for (const [el, , mine] of modCounts) el.textContent = `${mine.filter(b => b.checked).length}/${mine.length}`;
      const ticked = boxes.filter(([b]) => b.checked).map(([, , f]) => f);
      const size = ticked.filter(f => !f.downloaded).reduce((n, f) => n + (f.size || 0), 0);
      countLine.textContent = ticked.length ? `${ticked.length} of ${plural(boxes.length, 'file')}${size ? ` · ${fmtSize(size)} to download` : ''}` : 'Nothing selected';
      goBtn.disabled = !ticked.length;
      goBtn.textContent = plan.deps.length ? 'Next: requirements' : `Download ${plural(ticked.length, 'file')}`;
    }
    const setAll = on => { boxes.forEach(([b]) => { b.checked = on; }); refresh(); };
    const suggested = () => { boxes.forEach(([b, , f]) => { b.checked = !!f.selected; }); refresh(); };

    const one = plan.mods.length === 1 ? plan.mods[0] : null;
    const sub = one ? [one.author ? `by ${one.author}` : '', one.summary].filter(Boolean).join(' · ') : plan.mods.map(x => x.name).join(', ');
    m.replaceChildren(
      h('div', { class: 'modal-head pick-head' },
        h('div', { class: 'pick-head-text' },
          h('h3', { id: 'files-title', title: one ? one.name : '' }, one ? one.name : `Choose files · ${plural(plan.mods.length, 'mod')}`),
          sub ? h('div', { class: 'sub', title: sub }, sub) : null),
        h('span', { class: 'pick-tools', title: 'Ticked to start with: the file categories chosen in Settings' },
          h('button', { class: 'link-btn', onclick: () => setAll(true) }, 'All'),
          h('button', { class: 'link-btn', onclick: () => setAll(false) }, 'None'),
          h('button', { class: 'link-btn', onclick: suggested }, 'Suggested'))),
      h('div', { class: 'modal-body pick-body' }, plan.mods.map(modEl)),
      h('div', { class: 'modal-foot' },
        countLine,
        h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
        goBtn),
    );
    refresh();
    const close = v => { hide(); resolve(v); };
    const hide = showModal({ focus: '.btn-primary', onDismiss: () => close(null) });
  }));
}

function chooseRequirements(plan, files = null) {
  return withModal(() => new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal medium';
    m.setAttribute('aria-labelledby', 'deps-title');
    const fileCount = files ? Object.values(files).reduce((n, x) => n + x.length, 0) : plan.mods.reduce((n, x) => n + x.files.length, 0);
    const pickable = plan.deps.filter(d => DEP_STATUS[d.status]?.pick);
    const idOf = d => (d.modId ? d.modId : `ext:${d.name}`);
    const rootIds = new Set(plan.mods.map(x => x.modId));
    // Older plans carry names only: hang those under the first mod.
    const parentsOf = d => (d.parents?.length ? d.parents : [plan.mods[0]?.modId]);
    const childrenOf = id => plan.deps.filter(d => parentsOf(d).includes(id));
    const nameOf = id => plan.mods.find(x => x.modId === id)?.name || plan.deps.find(d => d.modId === id)?.name || '';
    const boxes = new Map(); // dep id → checkbox

    // Ticking one ticks everything it needs, all the way down.
    const tickDown = (id, seen = new Set()) => {
      for (const c of childrenOf(id)) {
        const cid = idOf(c);
        if (seen.has(cid)) continue;
        seen.add(cid);
        if (boxes.has(cid)) boxes.get(cid).checked = true;
        tickDown(cid, seen);
      }
    };
    // Unticking leaves out what no ticked mod needs any more.
    const pruneOrphans = () => {
      for (let changed = true; changed;) {
        changed = false;
        for (const d of pickable) {
          const box = boxes.get(idOf(d));
          if (!box?.checked) continue;
          const needed = parentsOf(d).some(p => rootIds.has(p) || boxes.get(p)?.checked);
          if (!needed) { box.checked = false; changed = true; }
        }
      }
    };

    const rows = [];
    const drawn = new Set();
    const addRow = (d, depth, parentId, onPath) => {
      const id = idOf(d);
      const st = DEP_STATUS[d.status] || { label: d.status, tag: '' };
      const others = d.requiredBy.filter(n => n !== nameOf(parentId));
      if (drawn.has(id)) {
        rows.push(h('div', { class: 'dep dep-ref', style: `--depth:${depth}` },
          h('span', { class: 'dep-check' }, icon('chevron-right')),
          h('span', { class: 'dep-main' }, h('span', { class: 'name' }, d.name),
            h('span', { class: 'subname' }, onPath.has(id) ? 'Needs a mod above it in turn (a loop): shown once' : 'Also needed here: shown above'))));
        return;
      }
      drawn.add(id);
      let box = null;
      if (st.pick) {
        box = h('input', { type: 'checkbox', checked: true, 'aria-label': `Include ${d.name}`, onchange: ev => {
          if (ev.target.checked) tickDown(id); else pruneOrphans();
          refresh();
        } });
        boxes.set(id, box);
      }
      const fileList = (d.files || []).map(f => `${f.fileName}${f.size ? ` (${fmtSize(f.size)})` : ''}`).join(', ');
      // The status tag says installed/disabled/downloaded; the line adds what it can't.
      const detail = d.status === 'missing' ? fileList : ['in-game', 'error'].includes(d.status) ? d.detail : '';
      const sub = [others.length ? `also needed by ${others.join(', ')}` : '', detail].filter(Boolean).join(' · ');
      rows.push(h(st.pick ? 'label' : 'div', { class: `dep${st.pick ? '' : ' dep-done'}`, style: `--depth:${depth}`, title: d.notes || d.detail || '' },
        h('span', { class: 'dep-check' }, box || icon(d.status === 'external' ? 'external' : 'check')),
        h('span', { class: 'dep-main' },
          h('span', { class: 'name' }, d.name),
          sub ? h('span', { class: 'subname' }, sub) : null),
        d.status === 'external' && isHttps(d.url)
          ? h('a', { class: 'btn btn-sm', href: d.url, target: '_blank', rel: 'noopener', title: d.url }, 'Open page')
          : h('span', { class: `tag ${st.tag}` }, st.label)));
      const path = new Set(onPath).add(id);
      for (const c of childrenOf(id)) addRow(c, depth + 1, id, path);
    };
    for (const mod of plan.mods) {
      const kids = childrenOf(mod.modId);
      if (!kids.length) continue;
      rows.push(h('div', { class: 'dep dep-root', style: '--depth:0' },
        h('span', { class: 'dep-check' }, icon('package')),
        h('span', { class: 'dep-main' }, h('span', { class: 'name' }, mod.name), h('span', { class: 'subname' }, 'Downloading · needs:'))));
      for (const c of kids) addRow(c, 1, mod.modId, new Set([mod.modId]));
    }
    // Anything not reached from a linked mod (should not happen) still gets a row.
    for (const d of plan.deps) if (!drawn.has(idOf(d))) addRow(d, 1, 0, new Set());

    const countLine = h('span', { class: 'foot-note' });
    const goBtn = h('button', { class: 'btn btn-primary', onclick: () => close(pickable.filter(d => boxes.get(idOf(d))?.checked).map(d => d.modId)) });
    function refresh() {
      const ticked = pickable.filter(d => boxes.get(idOf(d))?.checked);
      const downloads = (files ? Object.values(files).filter(x => x.length).length : plan.mods.length) + ticked.filter(d => d.status === 'missing').length;
      const enables = ticked.filter(d => d.status !== 'missing').length;
      countLine.textContent = pickable.length ? `${ticked.length} of ${plural(pickable.length, 'requirement')} selected` : 'Every requirement is already covered';
      goBtn.textContent = `Download ${plural(downloads, 'mod')}${enables ? ` · enable ${enables}` : ''}`;
    }
    const setAll = on => { boxes.forEach(b => { b.checked = on; }); refresh(); };
    const depth = Math.max(0, ...rows.map(r => Number(r.style.getPropertyValue('--depth')) || 0));

    m.replaceChildren(
      h('div', { class: 'modal-head pick-head' },
        h('div', { class: 'pick-head-text' },
          h('h3', { id: 'deps-title' }, 'Requirements'),
          h('div', { class: 'sub sub-wrap' }, pickable.length
            ? `What ${plan.mods.length === 1 ? plan.mods[0].name : 'these mods'} need${depth > 1 ? ', and what those need' : ''}. Ticked ones are downloaded, installed and enabled.`
            : 'Everything these mods need is already here.')),
        pickable.length > 1 ? h('span', { class: 'pick-tools', title: 'Ticking a requirement also ticks what it needs' },
          h('button', { class: 'link-btn', onclick: () => setAll(true) }, 'All'),
          h('button', { class: 'link-btn', onclick: () => setAll(false) }, 'None')) : null),
      h('div', { class: 'modal-body pick-body' }, h('div', { class: 'dep-list dep-tree' }, rows)),
      h('div', { class: 'modal-foot' },
        countLine,
        h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
        goBtn),
    );
    refresh();
    const close = v => { hide(); resolve(v); };
    const hide = showModal({ focus: '.btn-primary', onDismiss: () => close(null) });
  }));
}

// ---------------------------------------------------------------- profiles page

// A named seam (the screenshot harness supplies a demo plan instead of a file dialog).
// eslint-disable-next-line no-var
var pickProfileFile = () => run(api.importProfilePlan());

const IMPORT_STATUS = {
  installed: { label: 'Will enable', tag: '', ok: true },
  downloaded: { label: 'Will install', tag: '', ok: true },
  download: { label: 'Will download', tag: 'tag-info', ok: true },
  newer: { label: 'Newer version', tag: 'tag-warn', ok: true },
  bundled: { label: 'In the zip', tag: 'tag-ok', ok: true },
  local: { label: 'Not available', tag: 'tag-err', ok: false },
  unavailable: { label: 'Not available', tag: 'tag-err', ok: false },
};

const prof = {
  editing: null,     // profile id being renamed
  selected: null,    // profile id shown in the panel
  busy: false,       // a switch/delete/export call is in flight
  sig: '',
};

/** One action at a time. The clicked button shows it is working (disabled, aria-busy, its own label). */
const profGuard = (fn, workingLabel = '') => async ev => {
  if (prof.busy) return;
  prof.busy = true;
  const btn = ev?.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null;
  // Only a button with a text label shows the working label: an icon-only one would lose its icon.
  const label = btn?.querySelector('span:last-child') || null;
  const old = label?.textContent;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); if (workingLabel && label) label.textContent = workingLabel; }
  try { await fn(ev); } finally {
    prof.busy = false;
    if (btn && document.contains(btn)) { btn.disabled = false; btn.removeAttribute('aria-busy'); if (workingLabel && label) label.textContent = old; }
  }
};

const profFocus = key => $('#page-profiles').querySelector(`[data-key="${key}"]`)?.focus();
const initialOf = name => (String(name).trim().match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
const fmtDay = t => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

/**
 * Per-profile saves: a profile with no saves of its own yet starts fresh or gets a copy of `fromId`'s.
 * Before a switch (Cancel stops it: false), or after one made elsewhere (import, "Use here").
 */
async function offerSavesCopy(fromId, x, { after = false } = {}) {
  if (!state.settings?.perProfileSaves || !fromId || fromId === x.id) return true;
  const [count, mine] = await Promise.all([run(api.profileSaveCount(x.id)), run(api.profileSaveCount(fromId))]);
  if (!(count === 0 && mine > 0)) return true;
  const v = await modal({
    title: `"${x.name}" has no saves of its own yet`,
    body: h('p', {}, after
      ? `Start it fresh, or give it a copy of the saves of the profile you were using (${plural(mine, 'save')}). Those stay with that profile either way.`
      : `Start it fresh, or give it a copy of your current saves (${plural(mine, 'save')}). Either way your current saves stay with the profile you are leaving.`),
    buttons: [
      after ? null : { label: 'Cancel', value: null, safe: true },
      { label: 'Start with no saves', value: 'fresh', safe: after },
      { label: 'Copy my saves', value: 'copy', kind: 'btn-primary' },
    ].filter(Boolean),
  });
  if (v === 'copy') return !!(await run(api.copyAllSaves(fromId, x.id), after ? `Copied your saves to "${x.name}"` : '')) || after;
  return after || !!v;
}

async function switchTo(x) {
  if (state.settings?.perProfileSaves) {
    if (state.gameRunning) { toast('Close Cyberpunk 2077 first: each profile has its own saves, and they change with the profile', 'warn'); return null; }
    if (!await offerSavesCopy(state.snap.profiles.active, x)) return null;
  } else if (state.gameRunning) toast('The game is running: the new profile takes effect when you restart it');
  return run(api.switchProfile(x.id), `Switched to "${x.name}"`);
}

function exportProfile(x) {
  return profGuard(async () => {
    const r = await run(api.exportProfile(x.id));
    if (!r) return;
    if (r.risky?.length) { await programFilesWarning(x, r); return; }
    toast(`Exported "${x.name}" (${plural(r.count, 'mod')}${r.local ? `, ${r.local} from local files packed in` : ''})`, 'success', { label: 'Show in folder', fn: () => api.revealExport() });
  }, 'Exporting…');
}

/**
 * A profile zip that carries program files (.dll, .asi, .exe): browsers and virus scanners often
 * flag those, usually wrongly for game mods. Say which, so the sender knows what they share.
 */
async function programFilesWarning(x, r) {
  const files = r.risky.reduce((n, m) => n + m.files.length, 0);
  const show = await modal({
    title: `Exported "${x.name}": it carries program files`,
    sub: `${plural(r.risky.length, 'mod')} from local files in the zip ${r.risky.length === 1 ? 'includes' : 'include'} ${plural(files, 'program file')} (.dll, .asi or .exe)`,
    body: h('div', { class: 'risk-body' },
      h('p', {}, 'Browsers and virus scanners often flag program files in a download. For game mods (frame generation unlockers, DLSS files, script extenders) this is usually a false positive, but not always.'),
      h('div', { class: 'risk-list' }, r.risky.map(m => h('div', { class: 'risk-mod' },
        h('span', { class: 'name' }, m.mod),
        h('span', { class: 'risk-files' }, m.files.map(f => h('code', {}, f.split('/').pop())))))),
      h('p', { class: 'hint' }, 'Only share files you trust and know the source of, and tell whoever gets it what is inside. To leave these out, share the profile code instead: it holds Nexus mods only.')),
    buttons: [{ label: 'Show in folder', value: true }, { label: 'OK', value: false, kind: 'btn-primary' }],
  });
  if (show) api.revealExport();
}

function copyCode(x) {
  return profGuard(async () => {
    const r = await run(api.profileCode(x.id));
    if (!r) return;
    await navigator.clipboard.writeText(r.code);
    // Mods from local files cannot be in a code: say so, and offer the .zip that carries them.
    if (r.local) {
      toast(`Copied the code for "${x.name}" with its ${plural(r.mods, 'Nexus mod')}. ${plural(r.local, 'mod')} from local files ${r.local === 1 ? 'is' : 'are'} not in it: export the profile as a .zip to include ${r.local === 1 ? 'it' : 'them'}.`, 'warn', { label: 'Export as zip', fn: () => exportProfile(x)() });
    } else toast(`Copied the code for "${x.name}": ${plural(r.mods, 'mod')}, ${r.code.length.toLocaleString()} characters`, 'success');
  });
}

/** Names of this app's mods, A to Z, for a list of ids. */
const modNames = ids => {
  const byId = new Map((state.snap.mods || []).map(m => [m.id, m]));
  return ids.map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
};

/** The rename field, or the name with its tags. */
function profTitle(x, active, key) {
  if (prof.editing !== x.id) {
    return h('div', { class: 'prof-title' },
      h('span', { class: 'name', title: x.name }, x.name),
      active ? h('span', { class: 'tag tag-ok' }, 'Active') : null,
      h('button', { class: 'btn btn-sm btn-icon btn-ghost prof-rename', dataset: key('rename'), title: 'Rename', 'aria-label': `Rename ${x.name}`, onclick: () => { prof.editing = x.id; renderProfilesPage(true); } }, icon('edit')));
  }
  const input = h('input', { type: 'text', value: x.name, 'aria-label': `New name for ${x.name}`, maxlength: '60', dataset: key('name-input') });
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (prof.editing === x.id) prof.editing = null;
    if (save && name && name !== x.name) await run(api.renameProfile(x.id, name));
    if (prof.editing) return; // another rename started meanwhile: leave its input alone
    renderProfilesPage(true);
    const back = $('#prof-panel .prof-rename');
    if (back) back.focus(); else profFocus(`${x.id}:rename`);
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  setTimeout(() => { if (document.contains(input)) { input.focus(); input.select(); } });
  return h('div', { class: 'prof-title' }, input);
}

const shareButtons = (x, key) => [
  h('button', { class: 'btn btn-sm', dataset: key('code'), title: 'Copy a code that sets up this profile, as it is now, on someone else\'s PC', 'aria-label': `Copy the share code of ${x.name}`, onclick: copyCode(x) }, icon('copy'), h('span', {}, 'Copy code')),
  h('button', { class: 'btn btn-sm', dataset: key('export'), title: 'Save this profile as a file: a .zip that also carries its mods from local files, or a .json with its Nexus mods', 'aria-label': `Export ${x.name} as a file`, onclick: exportProfile(x) }, icon('share'), h('span', {}, 'Export file')),
];

// A letter on a tint, the same for a profile wherever it is shown.
const AVATAR_TINTS = ['yellow', 'blue', 'green', 'amber', 'violet'];
const tintOf = x => AVATAR_TINTS[[...String(x.id)].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_TINTS.length];
const avatarEl = (x, cls = '') => h('span', { class: `prof-avatar tint-${tintOf(x)} ${cls}`, 'aria-hidden': 'true' }, initialOf(x.name));

/** The plays (Game log) made with a profile, newest first. */
const playsOf = x => (typeof gl === 'undefined' ? [] : gl.plays.filter(p => p.profile?.id === x.id));
const lastPlayed = x => playsOf(x)[0]?.start || 0;

/** Game log: only this profile's plays, starting with its latest. */
function showProfileLogs(x) {
  setPlayProfile(x.id);
  goTo('gamelog');
  const latest = playsOf(x)[0];
  if (latest) choosePlay(latest.id);
}

/** A profile in the list: its name, when it was made and played, how many mods it has on. */
function profileRow(x, p) {
  const key = action => ({ key: `${x.id}:${action}` });
  const active = x.id === p.active;
  const total = (state.snap.mods || []).length;
  const on = x.count ?? (x.mods || []).length;
  const pct = total ? Math.round((on / total) * 100) : 0;
  const played = lastPlayed(x);
  const select = () => { prof.selected = x.id; renderProfilesPage(true); };
  return h('article', {
    class: `prow${active ? ' active' : ''}${prof.selected === x.id ? ' selected' : ''}`, role: 'listitem', tabindex: '0', dataset: key('row'),
    'aria-label': `${x.name}${active ? ' (active profile)' : ''}`, 'aria-current': prof.selected === x.id ? 'true' : null,
    onclick: ev => { if (!ev.target.closest('button, input')) select(); },
    onkeydown: ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); select(); } },
  },
  avatarEl(x),
  h('div', { class: 'prow-main' },
    h('div', { class: 'prow-name' }, h('span', { class: 'name', title: x.name }, x.name), active ? h('span', { class: 'tag tag-ok' }, 'Active') : null,
      x.fromVortex ? h('span', { class: 'tag tag-info', title: 'Made from a Vortex profile ("Use here" under Vortex profiles updates it)' }, 'From Vortex') : null,
      x.fromMo2 ? h('span', { class: 'tag tag-info', title: 'Made from a Mod Organizer 2 profile ("Use here" under MO2 profiles updates it)' }, 'From MO2') : null),
    h('div', { class: 'subname' }, [x.created ? `Created ${fmtDay(x.created)}` : '', `last played ${played ? fmtDay(played) : 'never'}`].filter(Boolean).join(' · '))),
  h('div', { class: 'prow-mods', title: `${on} of this app's ${plural(total, 'mod')} are on in this profile` },
    h('span', { class: 'prow-count' }, h('b', {}, String(on)), ` of ${total} mods on`),
    h('span', { class: `prow-bar${active ? ' on' : ''}`, role: 'img', 'aria-label': `${on} of ${total} mods on` }, h('span', { style: `width: ${pct}%` }))),
  h('div', { class: 'prow-act' },
    active
      ? h('span', { class: 'prow-inuse', title: 'Follows what you turn on and off on the Mods page' }, icon('check'), h('span', {}, 'In use'))
      : h('button', { class: 'btn btn-sm', dataset: key('switch'), onclick: profGuard(() => switchTo(x), 'Switching…') }, icon('refresh'), h('span', {}, 'Switch'))));
}

/** The selected profile: its numbers, how it differs from the active one, its plays, sharing. */
function profilePanel(x, p) {
  const key = action => ({ key: `${x.id}:p-${action}` });
  const active = x.id === p.active;
  const cur = p.list.find(q => q.id === p.active);
  const total = (state.snap.mods || []).length;
  const on = x.count ?? (x.mods || []).length;
  const plays = playsOf(x);
  const stat = (label, value, full = '') => h('div', { class: 'pstat', title: full }, h('b', {}, value), h('span', {}, label));
  const short = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const sec = (title, ...kids) => h('section', { class: 'psec' }, h('h2', {}, title), ...kids);
  // What switching would change: mods on here and off now, and the other way round.
  let compare = null;
  if (!active && cur && Array.isArray(x.mods) && Array.isArray(cur.mods)) {
    const here = new Set(x.mods || []);
    const now = new Set(cur.mods || []);
    const gain = modNames([...here].filter(id => !now.has(id)));
    const lose = modNames([...now].filter(id => !here.has(id)));
    const line = (m, isOn) => h('div', { class: 'pdiff' }, h('span', { class: `dot ${isOn ? 'ok' : ''}`, 'aria-hidden': 'true' }), h('span', { class: 'pdiff-name' }, m.name), h('span', { class: 'pdiff-what' }, isOn ? 'Turned on' : 'Turned off'));
    const rows = [...gain.map(m => line(m, true)), ...lose.map(m => line(m, false))];
    compare = sec(`Compared with ${cur.name}`,
      rows.length ? h('div', { class: 'pdiff-list' }, rows.slice(0, 40)) : h('p', { class: 'hint' }, 'The same mods are on in both.'),
      rows.length > 40 ? h('p', { class: 'hint' }, `+ ${rows.length - 40} more`) : null,
      h('button', { class: 'btn btn-primary pswitch', dataset: key('switch'), onclick: profGuard(() => switchTo(x), 'Switching…') }, icon('refresh'), h('span', {}, `Switch to ${x.name}`)));
  }
  return [
    h('div', { class: 'ppanel-head' },
      avatarEl(x, 'lg'),
      h('div', { class: 'ppanel-title' },
        profTitle(x, false, key),
        h('div', { class: 'subname' }, active ? 'Active · launches with Play' : 'Not active'))),
    h('div', { class: 'pstats' },
      stat('Mods on', `${on}/${total}`),
      stat('Created', x.created ? short(x.created) : '—', x.created ? fmtDay(x.created) : ''),
      stat('Last played', plays[0] ? short(plays[0].start) : 'Never', plays[0] ? fmtDay(plays[0].start) : '')),
    compare,
    active ? sec('In use', h('p', { class: 'hint' }, 'This profile follows what you turn on and off on the Mods page, and which mod wins each file conflict.')) : null,
    sec('Game logs',
      h('p', { class: 'hint' }, plays.length ? `${plural(plays.length, 'play')} with this profile${plays.some(q => q.outcome === 'crashed') ? `, ${plural(plays.filter(q => q.outcome === 'crashed').length, 'crash', 'crashes')}` : ''}.` : 'No plays with this profile yet. Each launch keeps its own logs, filed under the profile it ran with.'),
      plays.length ? h('button', { class: 'btn btn-sm', dataset: key('logs'), onclick: () => showProfileLogs(x) }, icon('activity'), h('span', {}, 'See its game logs')) : null),
    sec('Share',
      h('div', { class: 'pshare' }, h('code', { class: 'pcode', title: 'The fingerprint of its share code: two PCs with the same fingerprint have the same profile' }, x.codeTag ? `CMM-${x.codeTag}` : '—'), ...shareButtons(x, key)),
      h('p', { class: 'hint' }, 'Anyone with this app (Edgerunners Mod Manager, once Cyber Mod Manager) can paste the code under Import to get the same mods and order. Mods from local files travel in an exported .zip.')),
    h('div', { class: 'ppanel-foot' },
      h('button', {
        class: 'btn btn-sm btn-danger', dataset: key('delete'), disabled: active, title: active ? 'Switch to another profile before deleting this one' : 'Delete this profile',
        onclick: profGuard(async () => {
          const saves = await run(api.profileSaveCount(x.id, true));
          const savesNote = saves ? ` Its ${plural(saves, 'save')} are kept, in Saved Games\\Edgerunners Mod Manager\\Profile saves\\Deleted profiles.` : '';
          if (!await confirmBox(`Delete "${x.name}"?`, `Its list of enabled mods and its conflict order are lost. The mods themselves are not touched.${savesNote}`, 'Delete', true)) return;
          await run(api.deleteProfile(x.id), `Deleted "${x.name}"${saves ? '; its saves are kept' : ''}`);
          prof.selected = null;
          renderProfilesPage(true);
        }),
      }, icon('trash'), h('span', {}, 'Delete'))),
  ].filter(Boolean);
}

/** What loads whatever this app's profile is: Vortex's mods and files no mod manager put there. */
function outsideEl() {
  const vx = state.snap.vortex;
  const vxOn = vx?.installed ? (vx.mods || []).filter(m => m.enabled).length : 0;
  const hand = (cfg.list || []).filter(m => m.source === 'hand');
  const handFiles = hand.reduce((n, m) => n + m.fileCount, 0);
  const inGame = (state.snap.gameModio?.mods || []).filter(g => g.installed);
  if (!vxOn && !hand.length && !inGame.length) return null;
  const row = (ico, title, text, ...buttons) => h('div', { class: 'prof-out-row' },
    h('span', { class: 'prof-out-icon' }, icon(ico)),
    h('div', { class: 'prof-out-text' }, h('b', {}, title), h('span', {}, text)),
    h('div', { class: 'prof-out-actions' }, ...buttons));
  return h('section', { class: 'prof-outside', 'aria-label': 'Also loaded, whatever the profile' },
    vxOn ? row('vortex', `Also loaded: ${plural(vxOn, 'mod')} from Vortex`,
      `They follow Vortex's own profile${vx.activeProfileName ? ` ("${vx.activeProfileName}")` : ''}, not these. Move them to this app to put them in profiles.`,
      h('button', { class: 'btn btn-sm', onclick: () => { goTo('mods'); setModFilter('vortex'); } }, h('span', {}, 'Show them')),
      h('button', { class: 'btn btn-sm', onclick: () => moveFromVortex() }, icon('download'), h('span', {}, 'Move to this app'))) : null,
    inGame.length ? row('globe', `Also loaded: ${plural(inGame.length, 'mod')} from the game's Mods menu`,
      'The game installed them from mod.io itself, in its own folder, and switches them in its Mods menu, whatever the profile here.',
      h('button', { class: 'btn btn-sm', onclick: () => showGameModio() }, h('span', {}, 'See them'))) : null,
    hand.length ? row('folder', `Always loaded: ${plural(hand.length, 'folder')} not from a mod manager`,
      `${plural(handFiles, 'file')} installed by hand or by another tool load in every profile. No profile can turn them off.`,
      h('button', { class: 'btn btn-sm', onclick: () => { goTo('config'); cfg.filter = 'hand'; setSegActive('#cfg-filter', 'f', 'hand'); renderConfig(); } }, h('span', {}, 'See them'))) : null);
}

function renderProfilesPage(force = false) {
  const p = state.snap.profiles;
  if (!p) return;
  $('#nav-prof-count').textContent = '';
  const vx = state.snap.vortex;
  if (!p.list.some(x => x.id === prof.selected)) prof.selected = p.active;
  const plays = typeof gl === 'undefined' ? [] : gl.plays.map(q => [q.id, q.profile?.id]);
  const mo = state.snap.mo2;
  const next = JSON.stringify([p, prof.editing, prof.selected, vx?.profiles, vx?.mods?.length, vx?.installed, mo?.instances, mo?.programs?.length, (state.snap.gameModio?.mods || []).length, (state.snap.mods || []).length, (cfg.list || []).length, plays]);
  // Never throw away a rename in progress.
  if (!force && (next === prof.sig || prof.editing)) return;
  prof.sig = next;
  const page = $('#page-profiles');
  const active = p.list.find(x => x.id === p.active) || p.list[0];
  const others = p.list.filter(x => x !== active);
  const sel = p.list.find(x => x.id === prof.selected) || active;
  keepFocus(page, () => {
    $('#prof-grid').replaceChildren(...[active, ...others].map(x => profileRow(x, p)));
    // Only Default so far: what using another manager's profile here does, and why mods get switched off there.
    $('#prof-outside').replaceChildren(...[outsideEl(), p.list.length === 1 ? managersNote(state.snap, { compact: true }) : null].filter(Boolean));
    $('#prof-panel').replaceChildren(...profilePanel(sel, p));
  }, '#prof-new');
  const vxList = vx?.installed ? vx.profiles || [] : [];
  $('#vx-prof-head').hidden = !vxList.length;
  $('#vx-prof-grid').replaceChildren(...vxList.map(vortexProfileRow));
  $('#vx-prof-grid').hidden = !vxList.length;
  const many = (mo?.instances || []).length > 1;
  const moList = (mo?.instances || []).flatMap(i => i.profiles.map(x => ({ ...x, instance: i.name, many })));
  $('#mo2-prof-head').hidden = !moList.length;
  $('#mo2-prof-grid').replaceChildren(...moList.map(mo2ProfileRow));
  $('#mo2-prof-grid').hidden = !moList.length;
  // Files no mod manager put there: read once, then this page shows them too.
  if (!cfg.list && !prof.readingHand) {
    prof.readingHand = true;
    api.cfgList().then(r => { if (r.ok) { cfg.list = r.ok; renderProfilesPage(true); } }).finally(() => { prof.readingHand = false; });
  }
}

function vortexProfileRow(x) {
  return h('div', { class: `vrow${x.active ? ' active' : ''}`, role: 'listitem', 'aria-label': `Vortex profile ${x.name}${x.active ? ' (active in Vortex)' : ''}` },
    h('span', { class: 'vrow-icon', 'aria-hidden': 'true' }, icon('vortex')),
    h('span', { class: 'vrow-name' }, h('span', { class: 'name', title: x.name }, x.name), x.active ? h('span', { class: 'tag tag-info' }, 'Active in Vortex') : null),
    h('span', { class: 'vrow-count' }, `${x.count} ${x.count === 1 ? 'mod' : 'mods'} enabled`),
    h('span', { class: 'vrow-acts' },
      x.active ? h('button', { class: 'btn btn-sm btn-ghost', dataset: { key: `vx:${x.id}:mods` }, onclick: () => { goTo('mods'); setModFilter('vortex'); } }, h('span', {}, 'Show its mods')) : null,
      h('button', {
        class: 'btn btn-sm', dataset: { key: `vx:${x.id}:use` }, title: 'Set this app up the way this Vortex profile is: its mods, and only them, in a profile here',
        'aria-label': `Use the Vortex profile ${x.name} in this app`, onclick: useVortexProfile(x),
      }, icon('import'), h('span', {}, 'Use here'))));
}

/** A Vortex profile in this app: what it would do first, then it moves the mods over and switches. */
function useVortexProfile(x) {
  return profGuard(async () => {
    const plan = await run(api.vortexProfilePlan(x.id));
    if (!plan) return;
    const offBox = h('input', { type: 'checkbox', checked: true });
    const lines = [
      `${plural(plan.mods, 'mod')} enabled in it${plan.here ? `, ${plan.here} already in this app` : ''}.`,
      plan.move ? `${plural(plan.move, 'mod')} move from Vortex into this app: their files are linked from Vortex's folders (no copies), and Vortex keeps them, switched off.` : '',
      plan.profile ? `The profile "${plan.profile}" (made from it before) is updated to match, and becomes the active one.`
        : `A profile called "${plan.name} (Vortex)" is made with exactly these mods, and becomes the active one.`,
      plan.vortexRunning && (plan.move || plan.others) ? 'Vortex is open: it closes for a moment while its records change, and opens again.' : '',
    ].filter(Boolean);
    const ok = await modal({
      title: `Use "${plan.name}" from Vortex?`,
      body: h('div', { class: 'vx-use' },
        ...lines.map(t => h('p', {}, t)),
        plan.others ? h('label', { class: 'check' }, offBox, h('span', {},
          h('span', {}, `Switch off the ${plural(plan.others, 'other Vortex mod')} on now`),
          h('span', { class: 'check-sub' }, "So the game gets only this profile's mods. Vortex keeps them; switch them back on there any time."))) : null),
      buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Use here', value: true, kind: 'btn-primary' }],
    });
    if (!ok) return;
    if (state.gameRunning) toast('The game is running: the new setup takes effect when you restart it');
    const was = state.snap.profiles.active;
    const r = await run(api.useVortexProfile(x.id, { switchOffOthers: offBox.checked }));
    if (!r) return;
    prof.selected = r.id;
    await offerSavesCopy(was, r, { after: true });
    toast(`Now using "${r.name}" (${plural(r.enabled, 'mod')} enabled${r.moved ? `, ${r.moved} moved from Vortex` : ''})`, 'success');
  }, 'Setting up…');
}

function mo2ProfileRow(x) {
  return h('div', { class: `vrow${x.selected ? ' active' : ''}`, role: 'listitem', 'aria-label': `Mod Organizer 2 profile ${x.name}${x.many ? ` in ${x.instance}` : ''}` },
    h('span', { class: 'vrow-icon', 'aria-hidden': 'true' }, icon('mo2')),
    h('span', { class: 'vrow-name' }, h('span', { class: 'name', title: x.name }, x.name),
      x.many ? h('span', { class: 'tag tag-off', title: 'The MO2 setup it belongs to' }, x.instance) : null,
      x.selected ? h('span', { class: 'tag tag-info', title: 'The profile MO2 opens with' }, 'Selected in MO2') : null,
      x.profile ? h('span', { class: 'tag tag-ok', title: `"Use here" updates "${x.profile}"` }, 'Used here') : null),
    h('span', { class: 'vrow-count' }, `${x.count} ${x.count === 1 ? 'mod' : 'mods'} enabled`),
    h('span', { class: 'vrow-acts' },
      h('button', { class: 'btn btn-sm btn-ghost', dataset: { key: `mo2:${x.id}:mods` }, 'aria-label': `Show the mods of the MO2 profile ${x.name}`, onclick: () => showMo2ProfileMods(x) }, h('span', {}, 'Show its mods')),
      h('button', {
        class: 'btn btn-sm', dataset: { key: `mo2:${x.id}:use` }, disabled: !x.count,
        title: x.count ? 'Set this app up the way this MO2 profile is: its mods, and only them, in their order, in a profile here' : 'No mods are enabled in this profile in MO2',
        'aria-label': `Use the MO2 profile ${x.name} in this app`, onclick: useMo2Profile(x),
      }, icon('import'), h('span', {}, 'Use here'))));
}

/** An MO2 profile's enabled mods, in MO2's order (the lower one wins a shared file). */
async function showMo2ProfileMods(x) {
  const mods = await run(api.mo2ProfileMods(x.id));
  if (!mods) return;
  const here = mods.filter(m => m.here).length;
  await modal({
    title: `"${x.name}" in Mod Organizer 2`,
    sub: `${plural(mods.length, 'mod')} enabled${here ? `, ${here} already in this app` : ''} · top to bottom as MO2 lists them; the lower one wins a shared file`,
    body: mods.length ? h('ol', { class: 'mo2-mods' }, ...mods.map((m, n) => h('li', {},
      h('span', { class: 'n' }, String(n + 1)),
      h('span', { class: 'nm', title: m.name }, m.name, m.version ? h('span', { class: 'ver' }, `v${m.version}`) : null),
      m.here ? h('span', { class: 'tag tag-ok' }, 'In this app') : h('span', { class: 'tag tag-off', title: '"Use here" brings it over' }, 'Comes over'))))
      : h('p', {}, 'No mods are enabled in this profile.'),
    buttons: [{ label: 'Close', value: false, safe: true }, { label: 'Use here', value: true, kind: 'btn-primary' }],
  }).then(v => { if (v) useMo2Profile(x)(); });
}

/** An MO2 profile in this app: what it would do first, then it brings the mods over and switches. */
function useMo2Profile(x) {
  return profGuard(async () => {
    const plan = await run(api.mo2ProfilePlan(x.id));
    if (!plan) return;
    const lines = [
      `${plural(plan.mods, 'mod')} enabled in it${plan.here ? `, ${plan.here} already in this app` : ''}.`,
      plan.move ? `${plural(plan.move, 'mod')} come over from MO2: their files are linked from MO2's folders (no copies), and MO2 keeps them as they are.` : '',
      plan.profile ? `The profile "${plan.profile}" (made from it before) is updated to match, in MO2's order, and becomes the active one.`
        : `A profile called "${plan.name} (MO2)" is made with exactly these mods, in MO2's order, and becomes the active one.`,
      plan.empty ? `${plural(plan.empty, 'mod')} in it ${plan.empty === 1 ? 'is' : 'are'} left out: empty in MO2, or MO2's own workaround that only works inside MO2.` : '',
    ].filter(Boolean);
    const ok = await modal({
      title: `Use "${plan.name}" from Mod Organizer 2?`,
      body: h('div', { class: 'vx-use' }, ...lines.map(t => h('p', {}, t))),
      buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Use here', value: true, kind: 'btn-primary' }],
    });
    if (!ok) return;
    if (state.gameRunning) toast('The game is running: the new setup takes effect when you restart it');
    const was = state.snap.profiles.active;
    const r = await run(api.useMo2Profile(x.id));
    if (!r) return;
    prof.selected = r.id;
    await offerSavesCopy(was, r, { after: true });
    toast(`Now using "${r.name}" (${plural(r.enabled, 'mod')} enabled${r.moved ? `, ${r.moved} brought over from MO2` : ''}${r.failed ? `; ${r.failed} could not be read, details in Activity` : ''})`, r.failed ? 'warn' : 'success');
  }, 'Setting up…');
}

/** New profile: a name, and whether it starts with what is enabled now. */
function newProfileDialog() {
  return withModal(() => new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal';
    m.setAttribute('aria-labelledby', 'np-title');
    const nameInput = h('input', { type: 'text', placeholder: 'e.g. Photo mode, Vanilla+, Playthrough 2', 'aria-label': 'Profile name', maxlength: '60' });
    const copyBox = h('input', { type: 'checkbox', checked: true });
    const err = h('span', { class: 'left', role: 'alert' });
    let busy = false;
    const create = async () => {
      if (busy) return;
      err.textContent = '';
      const name = nameInput.value.trim();
      if (!name) { err.textContent = 'Give the profile a name.'; nameInput.focus(); return; }
      busy = true;
      const res = await api.createProfile(name, copyBox.checked);
      busy = false;
      if (res.error) { err.textContent = res.error; nameInput.focus(); return; }
      toast(`Created "${name}"`, 'success');
      close(res.ok);
    };
    nameInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); create(); } });
    m.replaceChildren(
      h('div', { class: 'modal-head' }, h('h3', { id: 'np-title' }, 'New profile'), h('div', { class: 'sub' }, 'A separate set of enabled mods and conflict order')),
      h('div', { class: 'modal-body' },
        h('label', { class: 'label' }, 'Name', nameInput),
        h('label', { class: 'check' }, copyBox, h('span', {}, h('span', {}, 'Start with the mods enabled now'), h('span', { class: 'check-sub' }, 'Untick for an empty profile. Nothing changes in the game folder until you activate it.')))),
      h('div', { class: 'modal-foot' }, err,
        h('button', { class: 'btn', onclick: () => { if (!busy) close(null); } }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: create }, 'Create')),
    );
    // Closed once only, and not while the profile is being created (a second close would hide the next dialog).
    let closed = false;
    const close = v => { if (closed) return; closed = true; hide(); resolve(v); };
    const hide = showModal({ focus: 'input[type=text]', onDismiss: () => { if (!busy) close(null); } });
  }));
}

/** The import review: every mod in the shared profile and what importing does with it. */
function importReview(plan) {
  return withModal(() => new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal medium';
    m.setAttribute('aria-labelledby', 'imp-title');
    let busy = false;
    let finished = false;
    const count = s => plan.mods.filter(x => s.includes(x.status)).length;
    const downloadSize = plan.mods.filter(x => ['download', 'newer'].includes(x.status)).reduce((n, x) => n + (x.size || 0), 0);
    const toDownload = count(['download', 'newer']);
    const usable = count(['installed', 'downloaded', 'download', 'newer', 'bundled']);
    // Downloads need an API key (and, without Premium, a click per file): say so before the user commits.
    const keyProblem = toDownload && (!state.settings?.hasApiKey ? 'no-key' : '');
    const freeAccount = toDownload && state.keyUser && !state.keyUser.isPremium;
    const canGet = toDownload && !keyProblem;
    const nameBox = h('input', { type: 'text', value: plan.name, 'aria-label': 'Profile name', maxlength: '60' });
    const label = h('span', {}, canGet || !toDownload ? 'Import and activate' : 'Import what I have');
    const applyBtn = h('button', { class: 'btn btn-primary', disabled: !usable, title: usable ? '' : 'None of these mods can be set up here' }, label);
    applyBtn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      applyBtn.disabled = true;
      applyBtn.setAttribute('aria-busy', 'true');
      label.textContent = 'Importing…';
      const was = state.snap.profiles.active;
      const r = await run(api.importProfileApply(plan.token, nameBox.value.trim() || plan.name));
      busy = false;
      if (!r) { applyBtn.disabled = false; applyBtn.removeAttribute('aria-busy'); label.textContent = 'Import and activate'; return; }
      finished = true;
      toast(`Profile "${r.name}" created and active${r.downloading ? ` — downloading ${plural(r.downloading, 'mod')}` : ''}`, 'success');
      close(r);
      offerSavesCopy(was, { id: r.profile, name: r.name }, { after: true });
    });
    // Problems first: the rows the receiver has to act on are never below the fold.
    const rank = x => (IMPORT_STATUS[x.status]?.ok ? (x.status === 'newer' ? 1 : 2) : 0);
    const rows = [...plan.mods].sort((a, b) => rank(a) - rank(b));
    m.replaceChildren(
      h('div', { class: 'modal-head' }, h('h3', { id: 'imp-title' }, 'Import profile'), h('div', { class: 'sub' }, `Shared profile · ${plural(plan.mods.length, 'mod')}`)),
      h('div', { class: 'modal-body' },
        keyProblem ? h('div', { class: 'banner banner-warn', role: 'status' }, icon('key'),
          h('span', {}, `${plural(toDownload, 'mod')} must be downloaded, and no Nexus API key is set. Import now to enable what you already have; after adding your key in Settings, retry them in Downloads.`)) : null,
        freeAccount ? h('div', { class: 'banner banner-info', role: 'status' }, icon('info'),
          h('span', {}, `Free Nexus account: each of the ${plural(toDownload, 'file')} to download needs one click on "Slow download". After importing, the app opens each file's page in turn.`)) : null,
        plan.localCount ? h('div', { class: 'banner banner-info', role: 'status' }, icon('info'),
          h('span', {}, `The sender also has ${plural(plan.localCount, 'mod')} installed from local files. Codes and profile files can't carry those: ask them for the archives.`)) : null,
        // Program files that came in the zip run with the game: name them before anything installs.
        plan.mods.some(x => x.programs?.length) ? h('div', { class: 'banner banner-warn', role: 'status' }, icon('alert'),
          h('span', {}, `Program files in the zip: ${plan.mods.filter(x => x.programs?.length).map(x => `${x.name} (${x.programs.map(f => f.split('/').pop()).join(', ')})`).join('; ')}. They run with the game. Import them only if you trust who sent this.`)) : null,
        h('label', { class: 'label' }, 'Name', nameBox),
        h('div', { class: 'imp-stats' },
          h('span', {}, h('b', {}, String(count(['installed']))), ' already installed'),
          toDownload ? h('span', {}, h('b', {}, String(toDownload)), ` to download${downloadSize ? ` (${fmtSize(downloadSize)})` : ''}`) : null,
          count(['downloaded']) ? h('span', {}, h('b', {}, String(count(['downloaded']))), ' to install') : null,
          count(['local', 'unavailable']) ? h('span', {}, h('b', {}, String(count(['local', 'unavailable']))), ' not available') : null),
        // What else comes with it: the sender's archive load order and their picks of whose file loads.
        plan.archives || plan.picks ? h('p', { class: 'hint' }, `Also brings the sender's ${[
          plan.archives ? `archive load order (${plural(plan.archives, 'archive')}; the load order is shared by all your profiles)` : '',
          plan.picks ? `choices of whose copy loads for ${plural(plan.picks, 'shared file')} (where you already chose, your choice stays)` : '',
        ].filter(Boolean).join(' and ')}.`) : null,
        h('div', { class: 'dep-list imp-list' }, rows.map(x => {
          const st = IMPORT_STATUS[x.status] || { label: x.status, tag: '', ok: false };
          return h('div', { class: `dep${st.ok ? '' : ' dep-done'}` },
            h('span', { class: 'dep-check' }, icon(st.ok ? 'check' : 'x')),
            h('span', { class: 'dep-main' },
              h('span', { class: 'name' }, x.name),
              h('span', { class: 'subname', title: x.detail }, [x.version ? `v${x.version}` : '', x.detail, x.fomod ? (x.choices ? "installer: the sharer's choices are filled in" : 'installer: you choose its options') : ''].filter(Boolean).join(' · '))),
            h('span', { class: `tag ${st.tag}` }, st.label));
        })),
        h('p', { class: 'hint imp-hint' }, 'Importing creates this profile and activates it: only its mods are enabled. Your other profiles keep their own mods and conflict order.')),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn', onclick: () => { if (!busy) close(null); } }, 'Cancel'),
        applyBtn),
    );
    const close = v => {
      if (!finished) api.importProfileCancel(plan.token);
      hide();
      resolve(v);
    };
    const hide = showModal({ focus: '.btn-primary', onDismiss: () => { if (!busy) close(null); } });
  }));
}

$('#prof-new').addEventListener('click', async () => {
  const id = await newProfileDialog();
  if (id) setTimeout(() => profFocus(`${id}:switch`));
});
/** Import: a pasted share code (or profile JSON), or a profile file (.zip with its local mods, or .json). Resolves the plan, or null. */
function importDialog() {
  return withModal(() => new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal medium';
    m.setAttribute('aria-labelledby', 'imp-src-title');
    const box = h('textarea', { class: 'code-box', rows: '5', spellcheck: 'false', placeholder: 'Paste a profile code (it starts with CMM1-)', 'aria-label': 'Profile code' });
    const err = h('span', { class: 'left', role: 'alert' });
    const read = h('button', { class: 'btn btn-primary', disabled: true }, h('span', {}, 'Read code'));
    let busy = false;
    box.addEventListener('input', () => { read.disabled = !box.value.trim(); err.textContent = ''; });
    read.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      read.disabled = true;
      read.firstChild.textContent = 'Reading…';
      const r = await api.importProfileCode(box.value);
      busy = false;
      read.firstChild.textContent = 'Read code';
      read.disabled = false;
      if (r.error) { err.textContent = r.error; box.focus(); return; }
      close(r.ok);
    });
    const fromFile = h('button', { class: 'btn foot-left', onclick: async () => {
      if (busy) return;
      const plan = await pickProfileFile();
      if (plan) close(plan);
    } }, icon('import'), h('span', {}, 'Choose a file (.zip or .json)…'));
    m.replaceChildren(
      h('div', { class: 'modal-head' }, h('h3', { id: 'imp-src-title' }, 'Import a profile'), h('div', { class: 'sub' }, 'Someone\'s profile code, or the profile file they sent you (a profile .zip can also be dropped anywhere on the app)')),
      h('div', { class: 'modal-body' }, box,
        h('p', { class: 'hint' }, 'Next you see every mod in it and what importing does with each one; nothing changes until you confirm.')),
      h('div', { class: 'modal-foot' }, fromFile, err, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), read),
    );
    // Something code-like on the clipboard is filled in already.
    navigator.clipboard.readText().then(t => {
      if (/^\s*CMM1-/.test(t || '') && !box.value) { box.value = t.trim(); read.disabled = false; }
    }).catch(() => {});
    const close = v => { if (busy) return; hide(); resolve(v); };
    const hide = showModal({ focus: 'textarea', onDismiss: () => close(null) });
  }));
}

$('#prof-import').addEventListener('click', profGuard(async () => {
  const plan = await importDialog();
  if (plan) await importReview(plan);
}));

pageHooks.profiles = () => renderProfilesPage(true);
snapshotHooks.push(() => renderProfilesPage());
