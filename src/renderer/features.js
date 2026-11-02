'use strict';
/* global api, $, h, icon, run, toast, plural, fmtSize, state, modAction, drawerSections, snapshotHooks, withModal, showModal, keepFocus */

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
 * Read the links, then — if the mods have requirements — show them as a checklist before anything
 * is downloaded. Requirements that are missing start ticked; ones already covered are shown so the
 * user can see why they are skipped.
 */
async function downloadLinks(text) {
  const plan = await run(api.planLinks(text));
  if (!plan) return null;
  if (!plan.mods.length) {
    toast(plan.errors[0] || 'No mods found in those links', 'error');
    return { mods: 0, queued: 0, skipped: 0, dependencies: 0, external: [], errors: plan.errors };
  }
  let chosen = [];
  if (plan.deps.length) {
    chosen = await chooseRequirements(plan);
    if (chosen === null) {
      toast('Download cancelled');
      return null;
    }
  }
  return run(api.queuePlan(plan.token, chosen));
}

function chooseRequirements(plan) {
  return withModal(() => new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal medium';
    m.setAttribute('aria-labelledby', 'deps-title');
    const boxes = [];
    const fileCount = plan.mods.reduce((n, x) => n + x.files.length, 0);
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
      const downloads = plan.mods.length + ticked.filter(d => d.status === 'missing').length;
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

// ---------------------------------------------------------------- profiles

function renderProfiles(p) {
  if (!p) return;
  const sel = $('#profile-select');
  const want = p.list.map(x => `${x.id}:${x.name}:${x.count}`).join('|');
  if (sel.dataset.sig !== want) {
    sel.replaceChildren(...p.list.map(x => h('option', { value: x.id }, `${x.name} · ${x.count}`)));
    sel.dataset.sig = want;
  }
  sel.value = p.active;
  const active = p.list.find(x => x.id === p.active);
  const btn = $('#profile-manage');
  btn.title = `Manage profiles (active: ${active?.name || '—'})`;
  btn.setAttribute('aria-label', `Manage profiles. Active profile: ${active?.name || 'none'}`);
  btn.dataset.initial = (active?.name || '?').trim().charAt(0).toUpperCase();
}

$('#profile-select').addEventListener('change', async ev => {
  const id = ev.target.value;
  const p = state.snap.profiles?.list.find(x => x.id === id);
  if (state.gameRunning) toast('The game is running: the new profile takes effect when you restart it');
  const ok = await run(api.switchProfile(id), p ? `Switched to "${p.name}"` : null);
  if (ok === null) renderProfiles(state.snap.profiles);
});

let profilesRedraw = null;
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

function openProfiles() {
  return withModal(() => new Promise(resolve => {
    const m = $('#modal');
    m.className = 'modal medium';
    m.setAttribute('aria-labelledby', 'prof-title');
    let view = 'list';      // 'list' | 'import'
    let importPlan = null;
    let sig = '';
    let editing = null;     // profile id being renamed
    let editToken = 0;      // a newer rename makes an older save's redraw stale
    let confirming = null;  // profile id waiting for delete confirmation
    let busy = false;       // a create/delete/import call is in flight
    let closed = false;     // async work that finishes after closing must not touch #modal

    const list = h('div', { class: 'prof-list' });
    const nameInput = h('input', { type: 'text', placeholder: 'New profile name', 'aria-label': 'New profile name', maxlength: '60' });
    const copyBox = h('input', { type: 'checkbox', checked: true });
    const err = h('span', { class: 'left', role: 'alert' });
    // One action at a time. The clicked button shows it is working (disabled, aria-busy, its own label).
    const guard = (fn, workingLabel = '') => async ev => {
      if (busy) return;
      busy = true;
      const btn = ev?.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null;
      const label = btn?.querySelector('span:last-child') || btn;
      const old = label?.textContent;
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); if (workingLabel && label) label.textContent = workingLabel; }
      try { await fn(ev); } finally {
        busy = false;
        if (btn && document.contains(btn)) { btn.disabled = false; btn.removeAttribute('aria-busy'); if (workingLabel && label) label.textContent = old; }
      }
    };

    const row = (x, p) => {
      const active = x.id === p.active;
      const key = action => ({ key: `${x.id}:${action}` });
      if (confirming === x.id) {
        return h('div', { class: 'prof prof-confirm' },
          h('span', { class: 'prof-main' }, h('span', { class: 'name' }, `Delete "${x.name}"?`), h('span', { class: 'subname' }, 'Its list of enabled mods is lost. Mods themselves are not touched.')),
          h('button', { class: 'btn btn-sm', dataset: key('cancel'), onclick: () => { confirming = null; draw(true); list.querySelector(`[data-key="${x.id}:delete"]`)?.focus(); } }, 'Cancel'),
          h('button', { class: 'btn btn-sm btn-danger', dataset: key('confirm'), onclick: guard(async () => { await run(api.deleteProfile(x.id), `Deleted "${x.name}"`); confirming = null; draw(true); }) }, 'Delete'));
      }
      if (editing === x.id) {
        const token = ++editToken;
        const input = h('input', { type: 'text', value: x.name, 'aria-label': `New name for ${x.name}`, maxlength: '60' });
        let done = false;
        const finish = async save => {
          if (done) return;
          done = true;
          const name = input.value.trim();
          if (editing === x.id) editing = null;
          if (save && name && name !== x.name) await run(api.renameProfile(x.id, name));
          // Another rename started meanwhile: leave its input alone.
          if (token !== editToken || editing) return;
          draw(true);
          list.querySelector(`[data-key="${x.id}:rename"]`)?.focus();
        };
        input.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
          if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', () => finish(!cancelEdit));
        setTimeout(() => { input.focus(); input.select(); });
        return h('div', { class: `prof${active ? ' active' : ''}` }, h('span', { class: 'prof-main' }, input));
      }
      return h('div', { class: `prof${active ? ' active' : ''}` },
        h('span', { class: 'prof-main' }, h('span', { class: 'name' }, x.name), h('span', { class: 'subname' }, `${plural(x.count, 'mod')} enabled`)),
        active ? h('span', { class: 'tag tag-ok' }, 'Active') : h('button', { class: 'btn btn-sm', dataset: key('switch'), onclick: guard(() => run(api.switchProfile(x.id), `Switched to "${x.name}"`)) }, 'Switch'),
        h('button', { class: 'btn btn-sm', dataset: key('export'), title: 'Save this profile to a file you can send to someone', 'aria-label': `Export ${x.name}`, onclick: guard(async () => { const r = await run(api.exportProfile(x.id)); if (r) toast(`Exported "${x.name}" (${plural(r.count, 'mod')})`, 'success', { label: 'Show in folder', fn: () => api.revealExport() }); }) }, icon('share'), h('span', {}, 'Export')),
        h('button', { class: 'btn btn-sm btn-icon btn-ghost', dataset: key('rename'), title: 'Rename', 'aria-label': `Rename ${x.name}`, onclick: () => { editing = x.id; draw(true); } }, icon('edit')),
        h('button', {
          class: 'btn btn-sm btn-icon btn-ghost', dataset: key('delete'),
          title: active ? 'Switch to another profile to delete this one' : 'Delete', 'aria-label': `Delete ${x.name}`,
          disabled: active || p.list.length === 1,
          onclick: () => { confirming = x.id; draw(true); list.querySelector(`[data-key="${x.id}:cancel"]`)?.focus(); },
        }, icon('trash')));
    };
    let cancelEdit = false;

    const create = guard(async () => {
      err.textContent = '';
      const name = nameInput.value.trim();
      if (!name) { err.textContent = 'Give the profile a name.'; nameInput.focus(); return; }
      const res = await api.createProfile(name, copyBox.checked);
      if (res.error) { err.textContent = res.error; return; }
      nameInput.value = '';
      toast(`Created "${name}"`, 'success');
    });
    nameInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); create(); } });

    const startImport = guard(async () => {
      err.textContent = '';
      const plan = await pickProfileFile();
      if (!plan) return;
      if (closed) { api.importProfileCancel(plan.token); return; }
      importPlan = plan;
      view = 'import';
      render();
    }, 'Reading…');
    const leaveImport = () => {
      if (busy) return false;
      if (importPlan) api.importProfileCancel(importPlan.token);
      importPlan = null;
      view = 'list';
      return true;
    };

    /** The import review: every mod in the shared profile and what importing does with it. */
    const importView = () => {
      const plan = importPlan;
      const count = s => plan.mods.filter(x => s.includes(x.status)).length;
      const downloadSize = plan.mods.filter(x => ['download', 'newer'].includes(x.status)).reduce((n, x) => n + (x.size || 0), 0);
      const toDownload = count(['download', 'newer']);
      const usable = count(['installed', 'downloaded', 'download', 'newer']);
      // Downloads need a Premium API key: say so before the user commits.
      const keyProblem = toDownload && (!state.settings?.hasApiKey ? 'no-key' : state.keyUser && !state.keyUser.isPremium ? 'not-premium' : '');
      const canGet = toDownload && !keyProblem;
      const nameBox = h('input', { type: 'text', value: plan.name, 'aria-label': 'Profile name', maxlength: '60' });
      const apply = guard(async () => {
        const r = await run(api.importProfileApply(plan.token, nameBox.value.trim() || plan.name));
        if (!r || closed) return;
        toast(`Profile "${r.name}" created and active${r.downloading ? ` — downloading ${plural(r.downloading, 'mod')}` : ''}`, 'success');
        importPlan = null;
        view = 'list';
        render();
      }, 'Importing…');
      // Problems first: the rows the receiver has to act on are never below the fold.
      const rank = x => (IMPORT_STATUS[x.status]?.ok ? (x.status === 'newer' ? 1 : 2) : 0);
      const rows = [...plan.mods].sort((a, b) => rank(a) - rank(b));
      return {
        title: 'Import profile',
        sub: `Shared profile · ${plural(plan.mods.length, 'mod')}`,
        body: [
          keyProblem ? h('div', { class: 'banner banner-warn', role: 'status' }, icon('key'),
            h('span', {}, keyProblem === 'no-key'
              ? `${plural(toDownload, 'mod')} must be downloaded, and no Nexus API key is set. Import now to enable what you already have; after adding your key in Settings, retry them in Downloads.`
              : `${plural(toDownload, 'mod')} must be downloaded, but your Nexus account is not Premium, so Nexus will refuse the downloads. Get them from their mod pages instead.`)) : null,
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
          h('p', { class: 'hint imp-hint' }, 'Importing creates this profile and switches to it: only its mods are enabled. Your other profiles keep their own mods and conflict order.'),
        ],
        foot: [
          h('button', { class: 'btn', onclick: () => { if (leaveImport()) render(); } }, 'Back'),
          h('button', { class: 'btn btn-primary', disabled: !usable, title: usable ? '' : 'None of these mods can be set up here', onclick: apply },
            h('span', {}, canGet || !toDownload ? 'Import and switch' : 'Import what I have')),
        ],
        focus: '.btn-primary',
      };
    };

    const listView = () => ({
      title: 'Profiles',
      sub: 'Each profile remembers which mods are enabled. Switching applies it to the game folder.',
      body: [
        list,
        h('div', { class: 'prof-new' },
          h('div', { class: 'field-row' }, nameInput, h('button', { class: 'btn', onclick: create }, icon('plus'), h('span', {}, 'Create'))),
          h('label', { class: 'check' }, copyBox, h('span', {}, 'Start with the mods enabled now (untick for an empty profile)'))),
      ],
      foot: [
        h('button', { class: 'btn foot-left', onclick: startImport, title: 'Set up a profile someone shared with you' }, icon('import'), h('span', {}, 'Import from file')),
        h('button', { class: 'btn btn-primary', onclick: () => close() }, 'Done'),
      ],
    });

    const render = () => {
      if (closed) return;
      const v = view === 'import' ? importView() : listView();
      m.replaceChildren(
        h('div', { class: 'modal-head' }, h('h3', { id: 'prof-title' }, v.title), h('div', { class: 'sub' }, v.sub)),
        h('div', { class: 'modal-body' }, ...v.body),
        h('div', { class: 'modal-foot' }, err, ...v.foot),
      );
      if (view === 'list') draw(true);
      (m.querySelector(v.focus || '.btn-primary'))?.focus();
    };

    const draw = (force = false) => {
      if (closed || view !== 'list') return;
      const p = state.snap.profiles;
      const next = JSON.stringify([p, editing, confirming]);
      if (!force && (next === sig || editing)) return; // never throw away a rename in progress
      sig = next;
      keepFocus(list, () => list.replaceChildren(...p.list.map(x => row(x, p))), null);
    };

    render();
    profilesRedraw = draw;
    const close = () => {
      closed = true;
      if (importPlan) api.importProfileCancel(importPlan.token);
      profilesRedraw = null;
      hide();
      resolve();
    };
    const hide = showModal({
      focus: '.btn-primary',
      // Esc (or a click outside) first backs out of a rename, a delete confirmation or the import review.
      onDismiss: () => {
        if (editing) { cancelEdit = true; editing = null; draw(true); cancelEdit = false; return; }
        if (confirming) { confirming = null; draw(true); return; }
        if (view === 'import') { if (leaveImport()) render(); return; }
        if (busy) return;
        close();
      },
    });
  }));
}

$('#profile-manage').addEventListener('click', openProfiles);

snapshotHooks.push(snap => {
  renderProfiles(snap.profiles);
  profilesRedraw?.();
});
