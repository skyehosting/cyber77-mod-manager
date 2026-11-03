'use strict';
/* global api, $, h, icon, run, toast, plural, fmtSize, state, modAction, drawerSections, snapshotHooks, withModal, showModal, keepFocus, pageHooks, goTo, setModFilter, CAT_LABEL, cfg, renderConfig, setSegActive, moveFromVortex, openDrawer, modal */

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
  confirming: null,  // profile id waiting for delete confirmation
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

function switchTo(x) {
  if (state.gameRunning) toast('The game is running: the new profile takes effect when you restart it');
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
    profFocus(`${x.id}:rename`);
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  setTimeout(() => { if (document.contains(input)) { input.focus(); input.select(); } });
  return h('div', { class: 'prof-title' }, input);
}

function deleteConfirm(x, key) {
  return h('article', { class: 'card prof-card confirming', 'aria-label': `Delete ${x.name}?` },
    h('div', { class: 'prof-head' }, h('span', { class: 'prof-avatar', 'aria-hidden': 'true' }, initialOf(x.name)), h('div', { class: 'prof-title' }, h('span', { class: 'name' }, `Delete "${x.name}"?`))),
    h('p', { class: 'prof-meta' }, 'Its list of enabled mods and its conflict order are lost. The mods themselves are not touched.'),
    h('div', { class: 'prof-actions' },
      h('button', { class: 'btn btn-sm', dataset: key('cancel'), onclick: () => { prof.confirming = null; renderProfilesPage(true); profFocus(`${x.id}:delete`); } }, 'Cancel'),
      h('button', { class: 'btn btn-sm btn-danger', dataset: key('confirm'), onclick: profGuard(async () => { await run(api.deleteProfile(x.id), `Deleted "${x.name}"`); prof.confirming = null; renderProfilesPage(true); }) }, 'Delete')));
}

const shareButtons = (x, key) => [
  h('button', { class: 'btn btn-sm', dataset: key('code'), title: 'Copy a code that sets up this profile, as it is now, on someone else\'s PC', 'aria-label': `Copy the share code of ${x.name}`, onclick: copyCode(x) }, icon('copy'), h('span', {}, 'Copy code')),
  h('button', { class: 'btn btn-sm btn-icon btn-ghost', dataset: key('export'), title: 'Save this profile as a file: a .zip that also carries its mods from local files, or a .json with its Nexus mods', 'aria-label': `Export ${x.name} as a file`, onclick: exportProfile(x) }, icon('share')),
];

/** A profile: its name, how many of this app's mods it has active, and what can be done with it. */
function profileCard(x, p) {
  const key = action => ({ key: `${x.id}:${action}` });
  if (prof.confirming === x.id) return deleteConfirm(x, key);
  const active = x.id === p.active;
  const total = (state.snap.mods || []).length;
  const on = active ? modNames(x.mods || []).length : (x.count ?? (x.mods || []).length);
  const pct = total ? Math.round((on / total) * 100) : 0;
  return h('article', { class: `card pcard${active ? ' active' : ''}`, 'aria-label': `${x.name}${active ? ' (active profile)' : ''}` },
    h('div', { class: 'pcard-head' },
      h('span', { class: 'prof-avatar', 'aria-hidden': 'true' }, initialOf(x.name)),
      profTitle(x, false, key), // the badge says it is active
      active ? h('span', { class: 'pcard-badge' }, h('span', { class: 'pcard-dot', 'aria-hidden': 'true' }), 'Active') : null),
    h('div', { class: 'pcard-count' },
      h('b', {}, String(on)), h('span', { class: 'pcard-of' }, ` / ${total}`),
      h('span', { class: 'pcard-label' }, on === 1 ? 'mod active' : 'mods active')),
    h('div', { class: 'pcard-bar', role: 'img', 'aria-label': `${on} of ${total} mods active` }, h('span', { style: `width: ${pct}%` })),
    h('div', { class: 'pcard-meta' }, [`of this app's ${plural(total, 'mod')}`, x.created ? `created ${fmtDay(x.created)}` : ''].filter(Boolean).join(' · ')),
    h('div', { class: 'pcard-actions' },
      active
        ? h('span', { class: 'pcard-inuse', title: 'Follows what you turn on and off on the Mods page' }, icon('check'), h('span', {}, 'In use'))
        : h('button', { class: 'btn btn-sm btn-primary', dataset: key('switch'), onclick: profGuard(() => switchTo(x), 'Switching…') }, icon('play'), h('span', {}, 'Activate')),
      h('span', { class: 'spacer' }),
      ...shareButtons(x, key),
      active ? null : h('button', {
        class: 'btn btn-sm btn-icon btn-ghost', dataset: key('delete'), title: 'Delete', 'aria-label': `Delete ${x.name}`,
        onclick: () => { prof.confirming = x.id; renderProfilesPage(true); profFocus(`${x.id}:cancel`); },
      }, icon('trash'))));
}

/** What loads whatever this app's profile is: Vortex's mods and files no mod manager put there. */
function outsideEl() {
  const vx = state.snap.vortex;
  const vxOn = vx?.installed ? (vx.mods || []).filter(m => m.enabled).length : 0;
  const hand = (cfg.list || []).filter(m => m.source === 'hand');
  const handFiles = hand.reduce((n, m) => n + m.fileCount, 0);
  if (!vxOn && !hand.length) return null;
  const row = (ico, title, text, ...buttons) => h('div', { class: 'prof-out-row' },
    h('span', { class: 'prof-out-icon' }, icon(ico)),
    h('div', { class: 'prof-out-text' }, h('b', {}, title), h('span', {}, text)),
    h('div', { class: 'prof-out-actions' }, ...buttons));
  return h('section', { class: 'card prof-outside', 'aria-label': 'Also loaded, whatever the profile' },
    h('div', { class: 'prof-mods-label' }, 'Also loaded, whatever the profile'),
    vxOn ? row('vortex', `${plural(vxOn, 'mod')} from Vortex`,
      `They follow Vortex's own profile${vx.activeProfileName ? ` ("${vx.activeProfileName}")` : ''}, not these. Move them to this app to put them in profiles.`,
      h('button', { class: 'btn btn-sm', onclick: () => { goTo('mods'); setModFilter('vortex'); } }, h('span', {}, 'Show them')),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => moveFromVortex() }, icon('download'), h('span', {}, 'Move to this app'))) : null,
    hand.length ? row('folder', `${plural(hand.length, 'folder')} not from a mod manager`,
      `${plural(handFiles, 'file')} installed by hand (or by another tool) are always loaded; no profile turns them off.`,
      h('button', { class: 'btn btn-sm', onclick: () => { goTo('config'); cfg.filter = 'hand'; setSegActive('#cfg-filter', 'f', 'hand'); renderConfig(); } }, icon('file-code'), h('span', {}, 'See them'))) : null);
}

function renderProfilesPage(force = false) {
  const p = state.snap.profiles;
  if (!p) return;
  $('#nav-prof-count').textContent = p.list.length > 1 ? String(p.list.length) : '';
  const vx = state.snap.vortex;
  const next = JSON.stringify([p, prof.editing, prof.confirming, prof.showAll, vx?.profiles, vx?.mods?.length, (state.snap.mods || []).length, (cfg.list || []).length]);
  // Never throw away a rename in progress.
  if (!force && (next === prof.sig || prof.editing)) return;
  prof.sig = next;
  const page = $('#page-profiles');
  const active = p.list.find(x => x.id === p.active) || p.list[0];
  const others = p.list.filter(x => x !== active);
  keepFocus(page, () => {
    $('#prof-active').replaceChildren();
    $('#prof-others-head').hidden = true;
    $('#prof-grid').replaceChildren(...[active, ...others].map(x => profileCard(x, p)));
    $('#prof-outside').replaceChildren(...[outsideEl()].filter(Boolean));
  }, '#prof-new');
  const vxList = vx?.installed ? vx.profiles || [] : [];
  $('#vx-prof-head').hidden = !vxList.length;
  $('#vx-prof-grid').replaceChildren(...vxList.map(vortexProfileCard));
  // Files no mod manager put there: read once, then this page shows them too.
  if (!cfg.list && !prof.readingHand) {
    prof.readingHand = true;
    api.cfgList().then(r => { if (r.ok) { cfg.list = r.ok; renderProfilesPage(true); } }).finally(() => { prof.readingHand = false; });
  }
}

function vortexProfileCard(x) {
  return h('article', { class: `card pcard pcard-vortex${x.active ? ' active' : ''}`, 'aria-label': `Vortex profile ${x.name}${x.active ? ' (active in Vortex)' : ''}` },
    h('div', { class: 'pcard-head' },
      h('span', { class: 'prof-avatar', 'aria-hidden': 'true' }, icon('vortex')),
      h('div', { class: 'prof-title' }, h('span', { class: 'name', title: x.name }, x.name)),
      x.active ? h('span', { class: 'pcard-badge vortex' }, h('span', { class: 'pcard-dot', 'aria-hidden': 'true' }), 'Active in Vortex') : null),
    h('div', { class: 'pcard-count' }, h('b', {}, String(x.count)), h('span', { class: 'pcard-label' }, x.count === 1 ? 'mod enabled' : 'mods enabled')),
    h('div', { class: 'pcard-actions' },
      x.active
        ? h('button', { class: 'btn btn-sm', onclick: () => { goTo('mods'); setModFilter('vortex'); } }, h('span', {}, 'Show its mods'))
        : h('span', { class: 'pcard-meta' }, 'Switch to it in Vortex')));
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
        h('label', { class: 'check' }, copyBox, h('span', {}, 'Start with the mods enabled now'), h('span', { class: 'check-sub' }, 'Untick for an empty profile. Nothing changes in the game folder until you activate it.'))),
      h('div', { class: 'modal-foot' }, err,
        h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: create }, 'Create')),
    );
    const close = v => { hide(); resolve(v); };
    const hide = showModal({ focus: 'input[type=text]', onDismiss: () => close(null) });
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
      const r = await run(api.importProfileApply(plan.token, nameBox.value.trim() || plan.name));
      busy = false;
      if (!r) { applyBtn.disabled = false; applyBtn.removeAttribute('aria-busy'); label.textContent = 'Import and activate'; return; }
      finished = true;
      toast(`Profile "${r.name}" created and active${r.downloading ? ` — downloading ${plural(r.downloading, 'mod')}` : ''}`, 'success');
      close(r);
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
        h('label', { class: 'label' }, 'Name', nameBox),
        h('div', { class: 'imp-stats' },
          h('span', {}, h('b', {}, String(count(['installed']))), ' already installed'),
          toDownload ? h('span', {}, h('b', {}, String(toDownload)), ` to download${downloadSize ? ` (${fmtSize(downloadSize)})` : ''}`) : null,
          count(['downloaded']) ? h('span', {}, h('b', {}, String(count(['downloaded']))), ' to install') : null,
          count(['local', 'unavailable']) ? h('span', {}, h('b', {}, String(count(['local', 'unavailable']))), ' not available') : null),
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
