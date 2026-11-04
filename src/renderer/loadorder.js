'use strict';
/* global api, $, $, h, icon, run, toast, plural, pageHooks, snapshotHooks */

// ---------------------------------------------------------------- archive load order

/*
 * The game loads archive/pc/mod/*.archive top to bottom; when two change the same thing, the
 * higher one wins. Auto-sort puts mods above what they need; dragging (or the arrows) overrides.
 */
const lo = { view: null, dragging: null, sig: '', q: '' };

async function loadLoadOrder() {
  const r = await run(api.loadOrder());
  if (r) { lo.view = r; renderLoadOrder(); }
}

/** Save a new order (all archive names, top first) and show it. */
async function saveOrder(order, done = '') {
  lo.saving = true;
  const r = await run(api.saveLoadOrder(order)).finally(() => { lo.saving = false; });
  if (!r) return;
  lo.view = r;
  renderLoadOrder();
  if (done) toast(done, 'success');
}

function move(i, to) {
  if (lo.saving) return; // the order shown is not saved yet: the next move starts from the saved one
  const order = lo.view.archives.map(a => a.name);
  if (to < 0 || to >= order.length || to === i) return;
  const [n] = order.splice(i, 1);
  order.splice(to, 0, n);
  saveOrder(order).then(() => $(`#lo-list [data-key="${CSS.escape(n)}"]`)?.focus());
}

/**
 * A row's number, which takes a new one: type 20 on the 37th and it becomes the 20th, the rows
 * from 20 to 36 each move down one. Enter or leaving the box applies it; Esc puts the number back.
 */
function posInput(a, i) {
  const n = lo.view.archives.length;
  const input = h('input', {
    class: 'lo-pos', type: 'text', inputmode: 'numeric', value: String(i + 1), maxlength: String(String(n).length),
    'aria-label': `Position of ${a.name}, 1 to ${n}`, title: `Type a new position (1 to ${n}) and press Enter`,
    draggable: 'false',
  });
  const apply = () => {
    const want = Number.parseInt(input.value, 10);
    if (!Number.isFinite(want) || want === i + 1) { input.value = String(i + 1); return; }
    move(i, Math.min(n, Math.max(1, want)) - 1);
  };
  // A text box in a draggable row: while it has the focus, the row does not drag (so the mouse selects text).
  input.addEventListener('focus', () => { input.closest('.lo-row').draggable = false; input.select(); });
  input.addEventListener('blur', () => { input.closest('.lo-row')?.setAttribute('draggable', 'true'); apply(); });
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); });
  input.addEventListener('keydown', ev => {
    if (ev.altKey) return; // Alt+arrows: the row moves itself
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
    if (ev.key === 'Escape') { ev.preventDefault(); input.value = String(i + 1); input.blur(); }
  });
  return input;
}

function renderLoadOrder() {
  const v = lo.view;
  if (!v) return;
  $('#lo-status').textContent = !v.archives.length ? 'No archive mods in archive\\pc\\mod.'
    : v.custom ? `${plural(v.archives.length, 'archive')} · drag rows to reorder · saved to modlist.txt` : `${plural(v.archives.length, 'archive')} · the game's default: alphabetical · drag rows to reorder`;
  $('#lo-reset').disabled = !v.custom;
  $('#lo-auto').disabled = !v.archives.length;
  const SRC = { app: '', vortex: 'Vortex', other: 'Not from a mod manager' };
  // A search shows the matching rows at their real places (their numbers stay).
  const q = lo.q;
  const shown = v.archives.map((a, i) => [a, i]).filter(([a]) => !q || `${a.name} ${a.mod || ''}`.toLowerCase().includes(q));
  $('#lo-list').replaceChildren(...(shown.length ? [] : [h('p', { class: 'empty-text lo-none' }, q ? 'No archives match.' : 'No archive mods.')]), ...shown.map(([a, i]) => {
    const needs = a.modId && v.needs[a.modId];
    const row = h('div', {
      class: 'lo-row', draggable: 'true', tabindex: '0', role: 'listitem', dataset: { key: a.name },
      'aria-label': `${i + 1}. ${a.name}${a.mod ? `, ${a.mod}` : ''}. Alt+Up or Alt+Down moves it.`,
      onkeydown: ev => {
        if (!ev.altKey) return;
        if (ev.key === 'ArrowUp') { ev.preventDefault(); move(i, i - 1); }
        if (ev.key === 'ArrowDown') { ev.preventDefault(); move(i, i + 1); }
      },
      ondragstart: ev => { lo.dragging = i; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', a.name); row.classList.add('dragging'); },
      ondragend: () => { lo.dragging = null; row.classList.remove('dragging'); $$('.lo-row.drop-before, .lo-row.drop-after').forEach(r => r.classList.remove('drop-before', 'drop-after')); },
      ondragover: ev => {
        if (lo.dragging === null) return;
        ev.preventDefault();
        const after = ev.offsetY > row.offsetHeight / 2;
        row.classList.toggle('drop-after', after);
        row.classList.toggle('drop-before', !after);
      },
      ondragleave: () => row.classList.remove('drop-before', 'drop-after'),
      ondrop: ev => {
        ev.preventDefault();
        const from = lo.dragging;
        if (from === null) return;
        let to = ev.offsetY > row.offsetHeight / 2 ? i + 1 : i;
        if (from < to) to--;
        move(from, to);
      },
    },
      h('span', { class: 'lo-grip', 'aria-hidden': 'true' }, '⋮⋮'),
      posInput(a, i),
      h('span', { class: 'lo-main' },
        h('span', { class: 'lo-name', title: a.name }, a.name),
        h('span', { class: 'lo-mod' }, [a.mod || SRC.other, needs ? `needs ${needs.join(', ')}` : ''].filter(Boolean).join(' · '))),
      a.source === 'vortex' ? h('span', { class: 'tag tag-vortex' }, 'Vortex') : null,
      h('span', { class: 'lo-moves' },
        h('button', { class: 'btn btn-sm btn-icon btn-ghost', title: 'Move up (loads earlier, wins more)', 'aria-label': `Move ${a.name} up`, disabled: i === 0, onclick: () => move(i, i - 1) }, icon('arrow-up')),
        h('button', { class: 'btn btn-sm btn-icon btn-ghost', title: 'Move down', 'aria-label': `Move ${a.name} down`, disabled: i === v.archives.length - 1, onclick: () => move(i, i + 1) }, icon('arrow-down'))));
    return row;
  }));
}

$('#lo-auto').addEventListener('click', async ev => {
  const btn = ev.currentTarget;
  const before = lo.view;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Sorting…';
  const r = await run(api.autoSortLoadOrder());
  btn.querySelector('span').textContent = 'Auto-sort';
  btn.disabled = false;
  if (!r) return;
  lo.view = r;
  renderLoadOrder();
  toast(r.moved ? `Sorted: ${plural(r.moved, 'archive')} moved so mods load above what they need` : 'Already in order: every mod loads above what it needs', 'success',
    r.moved ? { label: 'Undo', fn: () => (before.custom ? saveOrder(before.archives.map(a => a.name), 'Order restored') : run(api.resetLoadOrder()).then(x => { if (x) { lo.view = x; renderLoadOrder(); } })) } : null);
});
$('#lo-reset').addEventListener('click', async () => {
  const r = await run(api.resetLoadOrder());
  if (r) { lo.view = r; renderLoadOrder(); toast('Back to the game\'s default order (alphabetical)', 'success'); }
});

$('#lo-search').addEventListener('input', ev => { lo.q = ev.target.value.trim().toLowerCase(); renderLoadOrder(); });
pageHooks.loadorder = () => loadLoadOrder();
// Installs and removals change the archives: refresh while the page is open.
snapshotHooks.push(snap => {
  if (!$('#page-loadorder').classList.contains('active')) return;
  const sig = snap.mods.filter(m => m.enabled).map(m => m.id).join();
  if (sig !== lo.sig) { lo.sig = sig; loadLoadOrder(); }
});
