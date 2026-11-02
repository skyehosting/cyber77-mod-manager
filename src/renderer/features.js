'use strict';
/* global api, $, h, icon, run, toast, plural, fmtSize, state, modAction, drawerSections, snapshotHooks, withModal, showModal, keepFocus, pageHooks, goTo, setModFilter, CAT_LABEL */

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
      const meta = [f.version ? `v${f.version}` : '', f.size ? fmtSize(f.size) : '', fmtDate(f.uploaded)].filter(Boolean);
      return { box, el: h('label', { class: 'pick' },
        h('span', { class: 'pick-check' }, box),
        h('span', { class: 'pick-main' },
          h('span', { class: 'pick-name' },
            h('span', { class: 'name', title: f.fileName }, f.name),
            f.downloaded ? h('span', { class: 'tag', title: 'Already in your downloads: it is not downloaded again' }, 'Downloaded') : null),
          f.description ? h('span', { class: 'pick-desc', title: f.description }, f.description) : null),
        h('span', { class: 'pick-meta' }, meta.map(x => h('span', {}, x)))) };
    };

    const groupEl = (mod, [cat, label], list) => {
      const rows = list.map(f => fileRow(mod, f));
      const mine = rows.map(r => r.box);
      const all = h('input', { type: 'checkbox', 'aria-label': `All ${label.toLowerCase()} of ${mod.name}`, onchange: ev => { mine.forEach(b => { b.checked = ev.target.checked; }); refresh(); } });
      groupBoxes.push([all, mine]);
      const head = h('div', { class: 'pick-group-head' },
        h('label', { class: 'pick-all' }, all, h('span', {}, label)),
        h('span', { class: 'count' }, String(list.length)));
      // Old and archived files stay folded unless one of them is already ticked.
      const folded = ['OLD_VERSION', 'ARCHIVED'].includes(cat) && !list.some(f => f.selected);
      if (folded) {
        return h('details', { class: 'pick-group' },
          h('summary', {}, h('span', {}, label), h('span', { class: 'count' }, String(list.length))),
          h('div', { class: 'pick-group-head pick-group-inner' }, h('label', { class: 'pick-all' }, all, h('span', {}, `Select all ${label.toLowerCase()}`))),
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
      return h('div', { class: 'pick-mod' },
        h('div', { class: 'pick-mod-head' },
          h('div', { class: 'pick-mod-title' },
            h('span', { class: 'name' }, mod.name),
            h('span', { class: 'subname' }, [mod.author ? `by ${mod.author}` : '', plural(mod.allFiles.length, 'file')].filter(Boolean).join(' · '))),
          counter),
        mod.summary ? h('p', { class: 'pick-summary' }, mod.summary) : null,
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
      for (const [el, , mine] of modCounts) el.textContent = `${mine.filter(b => b.checked).length} of ${mine.length} selected`;
      const ticked = boxes.filter(([b]) => b.checked).map(([, , f]) => f);
      const size = ticked.filter(f => !f.downloaded).reduce((n, f) => n + (f.size || 0), 0);
      countLine.textContent = ticked.length ? `${plural(ticked.length, 'file')}${size ? ` · ${fmtSize(size)} to download` : ''}` : 'Nothing selected';
      goBtn.disabled = !ticked.length;
      goBtn.textContent = plan.deps.length ? 'Next: requirements' : `Download ${plural(ticked.length, 'file')}`;
    }
    const setAll = on => { boxes.forEach(([b]) => { b.checked = on; }); refresh(); };
    const suggested = () => { boxes.forEach(([b, , f]) => { b.checked = !!f.selected; }); refresh(); };

    const total = plan.mods.reduce((n, x) => n + x.allFiles.length, 0);
    m.replaceChildren(
      h('div', { class: 'modal-head' },
        h('h3', { id: 'files-title' }, 'Choose files'),
        h('div', { class: 'sub' }, `${plan.mods.length === 1 ? plan.mods[0].name : plural(plan.mods.length, 'mod')} · ${plural(total, 'file')} on Nexus`)),
      h('div', { class: 'pick-tools' },
        h('span', { class: 'hint' }, 'Files in the categories chosen in Settings are ticked. Untick what you do not want, or add older versions.'),
        h('span', { class: 'pick-tools-btns' },
          h('button', { class: 'link-btn', onclick: () => setAll(true) }, 'Select all'),
          h('button', { class: 'link-btn', onclick: () => setAll(false) }, 'Select none'),
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
    const boxes = [];
    const fileCount = files ? Object.values(files).reduce((n, x) => n + x.length, 0) : plan.mods.reduce((n, x) => n + x.files.length, 0);
    const pickable = plan.deps.filter(d => DEP_STATUS[d.status]?.pick);

    const depRow = d => {
      const st = DEP_STATUS[d.status] || { label: d.status, tag: '' };
      const box = st.pick ? h('input', { type: 'checkbox', checked: true, 'aria-label': `Include ${d.name}`, onchange: refresh }) : null;
      if (box) boxes.push([box, d]);
      const files = (d.files || []).map(f => `${f.fileName}${f.size ? ` (${fmtSize(f.size)})` : ''}`).join(', ');
      // The status tag already says installed/disabled/downloaded; the line adds what it can't.
      const detail = d.status === 'missing' ? files : ['in-game', 'error'].includes(d.status) ? d.detail : '';
      return h(st.pick ? 'label' : 'div', { class: `dep${st.pick ? '' : ' dep-done'}` },
        h('span', { class: 'dep-check' }, box || icon(d.status === 'external' ? 'external' : 'check')),
        h('span', { class: 'dep-main' },
          h('span', { class: 'name' }, d.name),
          h('span', { class: 'subname', title: d.detail || '' }, [`Needed by ${d.requiredBy.join(', ')}`, detail].filter(Boolean).join(' · '))),
        d.status === 'external' && isHttps(d.url)
          ? h('a', { class: 'btn btn-sm', href: d.url, target: '_blank', rel: 'noopener', title: d.url }, 'Open page')
          : h('span', { class: `tag ${st.tag}` }, st.label));
    };

    const countLine = h('span', { class: 'foot-note' });
    const goBtn = h('button', { class: 'btn btn-primary', onclick: () => close(boxes.filter(([b]) => b.checked).map(([, d]) => d.modId)) });
    function refresh() {
      const ticked = boxes.filter(([b]) => b.checked).map(([, d]) => d);
      const downloads = (files ? Object.values(files).filter(x => x.length).length : plan.mods.length) + ticked.filter(d => d.status === 'missing').length;
      const enables = ticked.filter(d => d.status !== 'missing').length;
      countLine.textContent = pickable.length ? `${ticked.length} of ${plural(pickable.length, 'requirement')} selected` : 'Every requirement is already covered';
      goBtn.textContent = `Download ${plural(downloads, 'mod')}${enables ? ` · ${enables === 1 ? 'enable 1' : `enable ${enables}`}` : ''}`;
    }

    m.replaceChildren(
      h('div', { class: 'modal-head' },
        h('h3', { id: 'deps-title' }, 'Review requirements'),
        h('div', { class: 'sub' }, `${plan.mods.map(x => x.name).join(', ')} · ${plural(fileCount, 'file')}`)),
      h('div', { class: 'modal-body' },
        h('p', { class: 'modal-lead' }, pickable.length
          ? 'These mods need other mods to work. Ticked ones are downloaded, installed and enabled with them.'
          : 'These mods need other mods, and you already have all of them.'),
        h('div', { class: 'dep-list' }, plan.deps.map(depRow)),
        pickable.length > 1 ? h('div', { class: 'dep-tools' },
          h('button', { class: 'link-btn', onclick: () => { boxes.forEach(([b]) => { b.checked = true; }); refresh(); } }, 'Select all'),
          h('button', { class: 'link-btn', onclick: () => { boxes.forEach(([b]) => { b.checked = false; }); refresh(); } }, 'Select none')) : null),
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
  const label = btn?.querySelector('span:last-child') || btn;
  const old = label?.textContent;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); if (workingLabel && label) label.textContent = workingLabel; }
  try { await fn(ev); } finally {
    prof.busy = false;
    if (btn && document.contains(btn)) { btn.disabled = false; btn.removeAttribute('aria-busy'); if (workingLabel && label) label.textContent = old; }
  }
};

const profFocus = key => $('#prof-grid').querySelector(`[data-key="${key}"]`)?.focus();
const initialOf = name => (String(name).trim().match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
const fmtDay = t => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function switchTo(x) {
  if (state.gameRunning) toast('The game is running: the new profile takes effect when you restart it');
  return run(api.switchProfile(x.id), `Switched to "${x.name}"`);
}

function exportProfile(x) {
  return profGuard(async () => {
    const r = await run(api.exportProfile(x.id));
    if (r) toast(`Exported "${x.name}" (${plural(r.count, 'mod')})`, 'success', { label: 'Show in folder', fn: () => api.revealExport() });
  }, 'Exporting…');
}

function copyCode(x) {
  return profGuard(async () => {
    const r = await run(api.profileCode(x.id));
    if (!r) return;
    await navigator.clipboard.writeText(r.code);
    toast(`Copied the code for "${x.name}": ${plural(r.mods, 'mod')}${r.local ? ` (${r.local} from local files left out)` : ''}, ${r.code.length.toLocaleString()} characters`, 'success');
  });
}

function profileCard(x, p) {
  const active = x.id === p.active;
  const key = action => ({ key: `${x.id}:${action}` });
  const head = (...extra) => h('div', { class: 'prof-head' },
    h('span', { class: 'prof-avatar', 'aria-hidden': 'true' }, initialOf(x.name)),
    ...extra);

  if (prof.confirming === x.id) {
    return h('article', { class: 'card prof-card confirming', 'aria-label': `Delete ${x.name}?` },
      head(h('div', { class: 'prof-title' }, h('span', { class: 'name' }, `Delete "${x.name}"?`))),
      h('p', { class: 'prof-meta' }, 'Its list of enabled mods and its conflict order are lost. The mods themselves are not touched.'),
      h('div', { class: 'prof-actions' },
        h('button', { class: 'btn btn-sm', dataset: key('cancel'), onclick: () => { prof.confirming = null; renderProfilesPage(true); profFocus(`${x.id}:delete`); } }, 'Cancel'),
        h('button', { class: 'btn btn-sm btn-danger', dataset: key('confirm'), onclick: profGuard(async () => { await run(api.deleteProfile(x.id), `Deleted "${x.name}"`); prof.confirming = null; renderProfilesPage(true); }) }, 'Delete')));
  }

  let title;
  if (prof.editing === x.id) {
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
    title = h('div', { class: 'prof-title' }, input);
  } else {
    title = h('div', { class: 'prof-title' },
      h('span', { class: 'name', title: x.name }, x.name),
      active ? h('span', { class: 'tag tag-ok' }, 'Active') : null);
  }

  return h('article', { class: `card prof-card${active ? ' active' : ''}`, 'aria-label': `${x.name}${active ? ' (active)' : ''}` },
    head(title,
      h('button', { class: 'btn btn-sm btn-icon btn-ghost', dataset: key('rename'), title: 'Rename', 'aria-label': `Rename ${x.name}`, onclick: () => { prof.editing = x.id; renderProfilesPage(true); } }, icon('edit'))),
    h('div', { class: 'prof-stats' },
      h('div', { class: 'prof-stat' }, h('b', {}, String(x.count)), h('span', {}, x.count === 1 ? 'mod enabled' : 'mods enabled')),
      x.created ? h('div', { class: 'prof-stat' }, h('b', {}, fmtDay(x.created)), h('span', {}, 'created')) : null,
      x.codeTag ? h('div', { class: 'prof-stat', title: 'This tag changes whenever the profile\'s mods change: a code you copy is always the profile as it is now' }, h('b', { class: 'code-tag' }, x.codeTag), h('span', {}, 'share code')) : null),
    h('div', { class: 'prof-actions' },
      active
        ? h('span', { class: 'prof-live' }, icon('check'), h('span', {}, 'In use'))
        : h('button', { class: 'btn btn-sm btn-primary', dataset: key('switch'), onclick: profGuard(() => switchTo(x), 'Switching…') }, icon('play'), h('span', {}, 'Activate')),
      h('button', { class: 'btn btn-sm', dataset: key('code'), title: 'Copy a code that sets up this profile, as it is now, on someone else\'s PC', 'aria-label': `Copy the share code of ${x.name}`, onclick: copyCode(x) }, icon('copy'), h('span', {}, 'Copy code')),
      h('button', { class: 'btn btn-sm btn-icon btn-ghost', dataset: key('export'), title: 'Save this profile as a .json file', 'aria-label': `Export ${x.name} as a file`, onclick: exportProfile(x) }, icon('share')),
      h('button', {
        class: 'btn btn-sm btn-icon btn-ghost', dataset: key('delete'),
        title: active ? 'Activate another profile to delete this one' : p.list.length === 1 ? 'The only profile cannot be deleted' : 'Delete',
        'aria-label': `Delete ${x.name}`,
        disabled: active || p.list.length === 1,
        onclick: () => { prof.confirming = x.id; renderProfilesPage(true); profFocus(`${x.id}:cancel`); },
      }, icon('trash'))));
}

function vortexProfileCard(x) {
  return h('article', { class: `card prof-card prof-vortex${x.active ? ' active' : ''}`, 'aria-label': `Vortex profile ${x.name}${x.active ? ' (active in Vortex)' : ''}` },
    h('div', { class: 'prof-head' },
      h('span', { class: 'prof-avatar', 'aria-hidden': 'true' }, icon('vortex')),
      h('div', { class: 'prof-title' }, h('span', { class: 'name', title: x.name }, x.name), x.active ? h('span', { class: 'tag tag-vortex' }, 'Active in Vortex') : null)),
    h('div', { class: 'prof-stats' },
      h('div', { class: 'prof-stat' }, h('b', {}, String(x.count)), h('span', {}, x.count === 1 ? 'mod enabled' : 'mods enabled'))),
    h('div', { class: 'prof-actions' },
      x.active
        ? h('button', { class: 'btn btn-sm', onclick: () => { goTo('mods'); setModFilter('vortex'); } }, h('span', {}, 'Show its mods'))
        : h('span', { class: 'prof-live muted' }, h('span', {}, 'Switch to it in Vortex'))));
}

function renderProfilesPage(force = false) {
  const p = state.snap.profiles;
  if (!p) return;
  $('#nav-prof-count').textContent = p.list.length > 1 ? String(p.list.length) : '';
  const vx = state.snap.vortex;
  const next = JSON.stringify([p, prof.editing, prof.confirming, vx?.profiles]);
  // Never throw away a rename in progress.
  if (!force && (next === prof.sig || prof.editing)) return;
  prof.sig = next;
  const grid = $('#prof-grid');
  keepFocus(grid, () => grid.replaceChildren(...p.list.map(x => profileCard(x, p))), '#prof-new');
  const vxList = vx?.installed ? vx.profiles || [] : [];
  $('#vx-prof-head').hidden = !vxList.length;
  $('#vx-prof-grid').replaceChildren(...vxList.map(vortexProfileCard));
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
    const usable = count(['installed', 'downloaded', 'download', 'newer']);
    // Downloads need a Premium API key: say so before the user commits.
    const keyProblem = toDownload && (!state.settings?.hasApiKey ? 'no-key' : state.keyUser && !state.keyUser.isPremium ? 'not-premium' : '');
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
          h('span', {}, keyProblem === 'no-key'
            ? `${plural(toDownload, 'mod')} must be downloaded, and no Nexus API key is set. Import now to enable what you already have; after adding your key in Settings, retry them in Downloads.`
            : `${plural(toDownload, 'mod')} must be downloaded, but your Nexus account is not Premium, so Nexus will refuse the downloads. Get them from their mod pages instead.`)) : null,
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
/** Import: a pasted share code (or profile JSON), or a .json file. Resolves the plan, or null. */
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
    } }, icon('import'), h('span', {}, 'Choose a .json file…'));
    m.replaceChildren(
      h('div', { class: 'modal-head' }, h('h3', { id: 'imp-src-title' }, 'Import a profile'), h('div', { class: 'sub' }, 'Someone\'s profile code, or a profile file they sent you')),
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
