'use strict';
/* global api, $, $$, h, icon, run, toast, modal, confirmBox, plural, pageHooks, keepFocus, fmtSize, ago, state, goTo */

// ---------------------------------------------------------------- the Saves page (Manage saves)
// Playthroughs (a character's saves, newest first) and backups (by day). Backups and restores run in
// the app (src/core/saves.js); this page shows them and asks before anything changes.

const sv = { view: null, tab: 'playthroughs', open: new Set(), shots: new Map(), loading: false, again: false, busy: '' };

const LIFE_PATHS = { StreetKid: 'Street Kid', Nomad: 'Nomad', Corporate: 'Corpo' };
const SLOT_LABEL = { ManualSave: 'Manual save', AutoSave: 'Autosave', QuickSave: 'Quick save', PointOfNoReturnSave: 'Point of no return', EndGameSave: 'End of game' };
const REASON_LABEL = {
  manual: 'Manual', play: 'Before play', 'play-mods': 'Before play: mods changed', 'game-start': 'Game started',
  restore: 'Before restore', switch: 'Before profile switch', delete: 'Before deleting saves',
};
const SAFETY = new Set(['restore', 'switch', 'delete']);
const own = (table, k) => (Object.hasOwn(table, k) ? table[k] : k);
const ptTitle = p => [own(LIFE_PATHS, p.lifePath) || 'Unknown life path', p.gender ? `${p.gender} V` : ''].filter(Boolean).join(' · ');
/** Play time: "41 h 3 min", "52 min", or '' when the save does not say. */
function hours(s) {
  const min = Math.round((Number(s) || 0) / 60);
  if (!min) return '';
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}
/** "Manual save 83", from the slot folder's name (ManualSave-83). */
const slotName = s => {
  const m = String(s.folder).match(/^([A-Za-z]+)-(\d+)$/);
  return m ? `${own(SLOT_LABEL, m[1])} ${m[2]}` : String(s.folder);
};
const when = t => new Date(t).toLocaleString();

async function loadSaves() {
  // A change while a read is running: read once more when it is done.
  if (sv.loading) { sv.again = true; return; }
  sv.loading = true;
  try {
    do {
      sv.again = false;
      const v = await run(api.savesView());
      if (v) { sv.view = v; pruneShots(v); renderSaves(); }
    } while (sv.again);
  } finally {
    sv.loading = false;
  }
}

// ---- screenshots: read once per save as it is now (a slot the game reuses gets its new picture)

// A save in another profile's folder carries `profile`.
const shotKey = s => `${s.profile ? `${s.profile}/` : ''}${s.folder}:${Math.round(s.time)}:${s.size}`;
/**
 * Saves in profiles' own folders, the game's aside: with per-profile saves on, or (off) the ones those
 * folders still hold from when it was on. { owner, playthroughs } or null.
 */
const profileFolders = v => v?.perProfile || v?.stored || null;
function pruneShots(v) {
  const keep = new Set(v.saves.map(shotKey));
  for (const list of Object.values(profileFolders(v)?.playthroughs || {})) {
    for (const p of list) for (const s of [p.shot, ...(p.saves || [])]) if (s) keep.add(shotKey(s));
  }
  for (const k of sv.shots.keys()) if (!keep.has(k)) sv.shots.delete(k);
}
function shotEl(save, cls) {
  const img = h('img', { class: cls, alt: '', decoding: 'async' });
  if (!save) { img.classList.add('none'); return img; }
  // A click shows it large (and does not open or close the row it sits in).
  img.addEventListener('click', e => {
    if (!img.src) return;
    e.stopPropagation();
    e.preventDefault();
    zoomShot(img, e);
  });
  const key = shotKey(save);
  let p = sv.shots.get(key);
  if (!p) {
    p = api.saveScreenshot(save.folder, save.profile || '').then(r => r?.ok || '');
    sv.shots.set(key, p);
    p.then(url => { if (!url) setTimeout(() => { if (sv.shots.get(key) === p) sv.shots.delete(key); }, 60000); }); // none yet: asked again in a minute
  }
  p.then(url => { if (url) img.src = url; else img.classList.add('none'); });
  return img;
}

// ---- a save's picture, large: grows out of the thumbnail, gone the moment the pointer leaves it

let zoom = null;
function closeZoom() {
  if (!zoom) return;
  zoom.el.remove();
  zoom.off.abort();
  zoom = null;
}
function zoomShot(img, e) {
  closeZoom();
  const from = img.getBoundingClientRect();
  const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 16 / 9;
  const m = 16;
  // Up to twice the picture's own size (save pictures are small), within the window.
  const w = Math.min(innerWidth - 2 * m, (innerHeight - 2 * m) * ratio, Math.max(img.naturalWidth * 2, 640));
  const ht = w / ratio;
  // Centred on the pointer, kept in the window: the pointer starts on the picture, so only moving away closes it.
  const x = Math.min(Math.max(e.clientX - w / 2, m), innerWidth - m - w);
  const y = Math.min(Math.max(e.clientY - ht / 2, m), innerHeight - m - ht);
  const el = h('img', { class: 'shot-zoom', src: img.src, alt: '' });
  Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${ht}px` });
  document.body.append(el);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.animate([
      { transform: `translate(${from.left - x}px, ${from.top - y}px) scale(${from.width / w}, ${from.height / ht})`, borderRadius: '0.5rem' },
      { transform: 'none' },
    ], { duration: 200, easing: 'cubic-bezier(.2, .7, .2, 1)' });
  }
  const off = new AbortController();
  const opts = { signal: off.signal, capture: true };
  const outside = ev => ev.clientX < x || ev.clientX > x + w || ev.clientY < y || ev.clientY > y + ht;
  addEventListener('pointermove', ev => { if (outside(ev)) closeZoom(); }, opts);
  // A click on it lands on it (not on the row below) and closes it; a press elsewhere (touch) just closes it.
  el.addEventListener('click', closeZoom, { signal: off.signal });
  addEventListener('pointerdown', ev => { if (outside(ev)) closeZoom(); }, opts);
  addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.stopPropagation(); closeZoom(); } }, opts);
  for (const t of ['wheel', 'resize', 'blur']) addEventListener(t, closeZoom, opts);
  zoom = { el, off };
}

function renderSaves() {
  const v = sv.view;
  if (!v) return;
  const page = $('#page-saves');
  const pts = v.playthroughs;
  const lastRegular = v.backups.find(b => !SAFETY.has(b.reason));
  const backupText = v.backups.length
    ? [`${plural(v.backups.length, 'backup')}${v.diskSize ? ` (${fmtSize(v.diskSize)} on disk)` : ''}`, lastRegular ? `last backup ${ago(lastRegular.at)}` : ''].filter(Boolean).join(' · ')
    : 'no backup yet';
  $('#saves-sub').textContent = [v.saves.length ? `${plural(v.saves.length, 'save')} in ${plural(pts.length, 'playthrough')}` : 'No saves on this PC yet', backupText].join(' · ');
  $('#saves-backup').disabled = !v.saves.length || !!sv.busy;
  $('#saves-perprofile').checked = !!v.perProfile;
  // No standing banner (the page explains itself). Only the unusual case shows: the saves in the game are
  // not the active profile's (a switch could not swap them). Steam Cloud is said where it matters: Restore.
  const pp = v.perProfile;
  const ownerName = pp ? v.profiles.find(p => p.id === pp.owner)?.name || '' : '';
  $('#saves-cloud').replaceChildren(...(pp && pp.owner !== pp.active ? [h('div', { class: 'banner banner-cloud', role: 'note' }, icon('users'),
    h('span', {}, `The saves in the game now are "${ownerName}"'s, the profile that had them last.`))] : []));
  // Tabs: this profile's playthroughs (all of them with per-profile saves off), other profiles', backups.
  // (off: the tab shows only while profiles' own folders still hold saves from when it was on)
  if (sv.tab === 'others' && !profileFolders(v)) sv.tab = 'playthroughs';
  $('#saves-pt-label').textContent = pp ? 'Active profile' : 'Playthroughs';
  $('#saves-tab-others').hidden = !profileFolders(v);
  $$('#saves-tabs .seg-btn').forEach(b => { const on = b.dataset.t === sv.tab; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  $('#saves-pt-count').textContent = pts.length || '';
  $('#saves-ot-count').textContent = otherCount(v) || '';
  $('#saves-bk-count').textContent = v.backups.length || '';
  const body = { backups: backupsView, others: otherProfilesView }[sv.tab] || playthroughsView;
  keepFocus(page, () => $('#saves-body').replaceChildren(...body(v)));
}

// ---- playthroughs

/** Per-profile saves off: where to turn them on (copying playthroughs between profiles comes with it). */
function perProfileHint(v) {
  if (v.perProfile) return [];
  // Saves the game cannot see, left in profiles' own folders when per-profile saves was turned off.
  const stored = waitingCount(v);
  if (stored) {
    // (no saves in the game at all: the empty state's own button leads there)
    return !v.playthroughs.length ? [] : [h('p', { class: 'sv-foot sv-hint' }, icon('users'),
      h('span', {}, `${plural(stored, 'playthrough')} ${stored === 1 ? 'is' : 'are'} still in profiles' own folders, from when each profile had its own saves. The game does not see ${stored === 1 ? 'it' : 'them'} until copied in. `,
        h('button', { class: 'link-btn', dataset: { key: 'pt:stored-hint' }, onclick: () => { sv.tab = 'others'; renderSaves(); } }, 'Show them')))];
  }
  const open = () => $('#saves-perprofile').focus();
  return [h('p', { class: 'sv-foot sv-hint' }, icon('users'),
    h('span', {}, v.profiles.length > 1
      ? 'Want each profile to keep its own saves, and to copy playthroughs between profiles? Turn on "Saves per profile" at the end of the bar above. '
      : 'With a second profile, each profile can keep its own saves, and playthroughs can be copied between them: "Saves per profile", at the end of the bar above. ',
    h('button', { class: 'link-btn', dataset: { key: 'pt:perprofile-hint' }, onclick: open }, 'Show me the switch')))];
}

function playthroughsView(v) {
  if (!v.playthroughs.length) {
    const elsewhere = otherCount(v);
    return [h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('save')), h('div', { class: 'empty-title' }, 'No saves yet'),
      h('div', { class: 'empty-text' }, v.savesDir ? `Saves appear here once you play. This app reads them from ${v.savesDir}.`
        // Linux: the save folder is inside the game's Proton folder, which Steam makes at the first launch.
        : 'The game\'s save folder is not known yet. Start Cyberpunk 2077 once from Steam; its saves show here after that.'),
      elsewhere ? h('button', { class: 'btn btn-sm', dataset: { key: 'pt:to-others' }, onclick: () => { sv.tab = 'others'; renderSaves(); } }, icon('users'), h('span', {}, `${plural(elsewhere, 'playthrough')} in other profiles`)) : null),
    ...perProfileHint(v)];
  }
  const byFolder = new Map(v.saves.map(s => [s.folder, s]));
  return [h('div', { class: 'sv-list', role: 'list', 'aria-label': 'Playthroughs' }, ...v.playthroughs.map(p => {
    const open = sv.open.has(p.id);
    const tags = [p.gameVersion ? h('span', { class: 'tag tag-off' }, `Game ${p.gameVersion}`) : null, p.phantomLiberty ? h('span', { class: 'tag tag-info' }, 'Phantom Liberty') : null];
    const elsewhere = v.perProfile ? Object.entries(v.perProfile.playthroughs).filter(([pid, list]) => pid !== v.perProfile.owner && list.some(x => x.id === p.id)).map(([pid]) => v.profiles.find(x => x.id === pid)?.name).filter(Boolean) : [];
    if (elsewhere.length) tags.push(h('span', { class: 'tag tag-off', title: `Also in ${elsewhere.join(', ')}` }, `Also in ${elsewhere.length === 1 ? elsewhere[0] : plural(elsewhere.length, 'profile')}`));
    const facts = [p.level ? `Level ${p.level}` : '', hours(p.playTime) ? `${hours(p.playTime)} played` : '', plural(p.count, 'save'), p.time ? `last saved ${ago(p.time)}` : '', p.size ? fmtSize(p.size) : ''];
    const row = h('button', {
      class: 'sv-pt', 'aria-expanded': String(open), dataset: { key: `pt:${p.id}` },
      onclick: () => { if (open) sv.open.delete(p.id); else sv.open.add(p.id); renderSaves(); },
    },
    shotEl(byFolder.get(p.latest), 'sv-thumb'),
    h('span', { class: 'sv-main' },
      h('span', { class: 'sv-title' }, ptTitle(p), ...tags),
      h('span', { class: 'sv-sub' }, facts.filter(Boolean).join(' · '))),
    icon('chevron-right', `sv-chev${open ? ' turn' : ''}`));
    const copyBtn = v.perProfile && v.profiles.length > 1 ? h('div', { class: 'sv-pt-acts' }, h('button', { class: 'btn btn-sm', dataset: { key: `pt:${p.id}:copy` }, 'aria-label': `Copy the playthrough ${ptTitle(p)} to another profile`, onclick: () => copyToProfiles(v, p) }, icon('copy'), h('span', {}, 'Copy to profile…'))) : null;
    if (!open) return h('div', { class: 'sv-item', role: 'listitem' }, row);
    const saves = p.saves.map(f => byFolder.get(f)).filter(Boolean);
    return h('div', { class: 'sv-item open', role: 'listitem' }, row, copyBtn,
      h('div', { class: 'sv-saves', role: 'list', 'aria-label': `Saves of ${ptTitle(p)}` }, ...saves.map(s => h('div', { class: 'sv-save', role: 'listitem' },
        shotEl(s, 'sv-mini'),
        h('span', { class: 'sv-sname' }, slotName(s), h('span', { class: 'sv-folder' }, s.folder)),
        h('span', { class: 'sv-cell' }, s.level ? `Level ${s.level}` : ''),
        h('span', { class: 'sv-cell' }, hours(s.playTime)),
        h('span', { class: 'sv-cell', title: s.time ? when(s.time) : '' }, s.time ? ago(s.time) : ''),
        h('span', { class: 'sv-cell num' }, s.gameVersion ? `v${s.gameVersion}` : '')))));
  })), ...perProfileHint(v)];
}

// ---- other profiles (per-profile saves): their playthroughs, each open to its saves, to copy whole or one save

/** The other profiles that keep saves: [{ id, name, list }]. */
function otherProfiles(v) {
  const pp = profileFolders(v);
  if (!pp) return [];
  // Off, the profile in use can have saves of its own waiting in its folder too.
  const active = state.snap?.profiles?.active;
  // (on: the owner's saves are the game's; off, the game's folder is no profile's and every own folder counts)
  return Object.entries(pp.playthroughs).filter(([pid, list]) => (pid !== pp.owner || !v.perProfile) && list.length)
    .map(([pid, list]) => {
      const name = v.profiles.find(x => x.id === pid)?.name || pid;
      return { id: pid, name: !v.perProfile && pid === active ? `${name} (this profile's own folder)` : name, list };
    });
}
const otherCount = v => otherProfiles(v).reduce((n, o) => n + o.list.length, 0);
/** Off: playthroughs left in profiles' own folders that the game's saves do not have (copied in: not counted). */
const waitingCount = v => new Set(otherProfiles(v).flatMap(o => o.list.map(p => p.id)).filter(id => !v.playthroughs.some(x => x.id === id))).size;

/**
 * Copy saves from another profile into this one; the toast says what happened. "This one" is read when
 * clicked (a switch since the page was drawn changes it).
 */
async function copyHere(from, what, call) {
  const owner = profileFolders(sv.view)?.owner;
  if (!owner) return;
  const r = await run(call(owner));
  if (!r) return;
  if (!r.copied) toast(r.present ? `Already ${sv.view?.perProfile ? 'in this profile' : 'in the game\'s saves'}: ${what} was not copied again` : 'Nothing was copied');
  else toast(`Copied ${plural(r.copied, 'save')} from "${from}"${r.renamed ? ` (${r.renamed} under a new slot name)` : ''}`, 'success');
}

function otherProfilesView(v) {
  const pp = v.perProfile;
  const groups = otherProfiles(v);
  if (!groups.length) {
    return [h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('users')), h('div', { class: 'empty-title' }, 'No saves in other profiles'),
      h('div', { class: 'empty-text' }, pp ? 'Each profile keeps its own saves. When another profile has some, they show here, and you can copy a playthrough or a single save into this one.'
        : 'No profile\'s own folder holds saves now.'))];
  }
  return [...groups.map(g => h('section', { class: 'sv-day', 'aria-label': g.name },
      h('div', { class: 'section-head' }, h('h2', {}, g.name), h('span', { class: 'section-note' }, plural(g.list.length, 'playthrough'))),
      h('div', { class: 'sv-list', role: 'list', 'aria-label': `Playthroughs of ${g.name}` }, ...g.list.map(p => otherPlaythrough(v, g, p)))))];
}

function otherPlaythrough(v, g, p) {
  const key = `o:${g.id}:${p.id}`;
  const open = sv.open.has(key);
  const here = v.playthroughs.some(x => x.id === p.id);
  const title = ptTitle(p);
  const dest = v.perProfile ? 'this profile' : "the game's saves";
  const row = h('button', {
    class: 'sv-pt', 'aria-expanded': String(open), dataset: { key: `other:${g.id}:${p.id}` },
    onclick: () => { if (open) sv.open.delete(key); else sv.open.add(key); renderSaves(); },
  },
  shotEl(p.shot, 'sv-thumb'),
  h('span', { class: 'sv-main' },
    h('span', { class: 'sv-title' }, title, here ? h('span', { class: 'tag tag-off' }, v.perProfile ? 'Also in this profile' : "Also in the game's saves") : null),
    h('span', { class: 'sv-sub' }, [p.level ? `Level ${p.level}` : '', plural(p.count, 'save'), p.time ? `last saved ${ago(p.time)}` : ''].filter(Boolean).join(' · '))),
  icon('chevron-right', `sv-chev${open ? ' turn' : ''}`));
  const copyAll = h('span', { class: 'sv-acts' }, h('button', {
    class: 'btn btn-sm', dataset: { key: `other:${g.id}:${p.id}:all` }, 'aria-label': `Copy the whole playthrough ${title} from ${g.name} into ${dest}`,
    onclick: () => copyHere(g.name, 'this playthrough', owner => api.copyPlaythrough(p.id, g.id, [owner])),
  }, icon('copy'), h('span', {}, 'Copy playthrough')));
  const head = h('div', { class: 'sv-row' }, row, copyAll);
  if (!open) return h('div', { class: 'sv-item', role: 'listitem' }, head);
  return h('div', { class: 'sv-item open', role: 'listitem' }, head,
    h('div', { class: 'sv-saves', role: 'list', 'aria-label': `Saves of ${title} in ${g.name}` }, ...(p.saves || []).map(s => h('div', { class: 'sv-save has-act', role: 'listitem' },
      shotEl(s, 'sv-mini'),
      h('span', { class: 'sv-sname' }, slotName(s), h('span', { class: 'sv-folder' }, s.folder)),
      h('span', { class: 'sv-cell' }, s.level ? `Level ${s.level}` : ''),
      h('span', { class: 'sv-cell' }, hours(s.playTime)),
      h('span', { class: 'sv-cell', title: s.time ? when(s.time) : '' }, s.time ? ago(s.time) : ''),
      h('span', { class: 'sv-cell num' }, s.gameVersion ? `v${s.gameVersion}` : ''),
      h('span', { class: 'sv-acts' }, h('button', {
        class: 'btn btn-sm', dataset: { key: `other:${g.id}:${s.folder}` }, 'aria-label': `Copy ${slotName(s)} from ${g.name} into ${dest}`,
        onclick: () => copyHere(g.name, 'this save', owner => api.copySaves(g.id, [s.folder], [owner])),
      }, icon('copy'), h('span', {}, 'Copy here')))))));
}

/** Copy a playthrough to other profiles (a taken slot name gets the next free ManualSave number). */
async function copyToProfiles(v, p) {
  const boxes = v.profiles.filter(x => x.id !== v.perProfile.owner).map(x => ({ x, box: h('input', { type: 'checkbox', value: x.id }) }));
  const ok = await modal({
    title: `Copy ${ptTitle(p)} to…`, sub: `${plural(p.count, 'save')}, level ${p.level}`,
    body: h('div', { class: 'sv-restore' }, ...boxes.map(({ x, box }) => h('label', { class: 'check' }, box, h('span', {}, x.name))),
      h('p', { class: 'hint' }, 'A copy: this profile keeps its saves. Where a slot name is taken, the copy gets the next free manual save number.')),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Copy', value: true, kind: 'btn-primary' }],
  });
  if (!ok) return;
  const targets = boxes.filter(b => b.box.checked).map(b => b.x.id);
  if (!targets.length) { toast('No profile was ticked: nothing was copied'); return; }
  const r = await run(api.copyPlaythrough(p.id, v.perProfile.owner, targets));
  if (r) toast(`Copied ${plural(r.copied, 'save')} to ${plural(r.profiles, 'profile')}${r.renamed ? ` (${r.renamed} under a new slot name)` : ''}`, 'success');
}

// ---- backups

/** "Today", "Yesterday", or the date. */
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function backupsView(v) {
  const foot = h('p', { class: 'sv-foot' }, `Backups are plain folders in ${v.backupDir}. Uninstalling this app never removes them. `,
    h('button', { class: 'link-btn', onclick: () => run(api.openSaves('backups')) }, 'Open the folder'));
  if (!v.backups.length) {
    return [h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('save')), h('div', { class: 'empty-title' }, 'No backups yet'),
      h('div', { class: 'empty-text' }, 'A backup is made before you play (Settings, Save manager), or now with Back up now.')), foot];
  }
  const days = new Map();
  for (const b of v.backups) {
    const k = new Date(b.at).toDateString();
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(b);
  }
  return [...[...days.values()].map(list => h('section', { class: 'sv-day', 'aria-label': dayLabel(list[0].at) },
    h('div', { class: 'section-head' }, h('h2', {}, dayLabel(list[0].at)), h('span', { class: 'section-note' }, plural(list.length, 'backup'))),
    h('div', { class: 'sv-list', role: 'list' }, ...list.map(backupRow)))), foot];
}

function backupRow(b) {
  const pts = new Set(b.saves.map(s => s.playthrough)).size;
  const of = `the backup of ${when(b.at)}${b.label ? ` (${b.label})` : ''}`;
  const key = part => ({ key: `bk:${b.id}:${part}` });
  return h('div', { class: `sv-bk${b.pinned ? ' pinned' : ''}`, role: 'listitem', dataset: { key: `bk:${b.id}` } },
    h('span', { class: 'sv-time', title: when(b.at) }, new Date(b.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    h('span', { class: 'sv-main' },
      h('span', { class: 'sv-title' },
        b.label ? h('span', { class: 'sv-label' }, b.label) : null,
        h('span', { class: `tag ${SAFETY.has(b.reason) ? 'tag-warn' : b.reason === 'manual' ? 'tag-info' : 'tag-off'}` }, own(REASON_LABEL, b.reason)),
        b.pinned ? h('span', { class: 'tag tag-ok' }, 'Pinned') : null),
      h('span', { class: 'sv-sub' }, [plural(b.saves.length, 'save'), plural(pts, 'playthrough'), b.profileName ? `profile ${b.profileName}` : '', b.mods ? `${plural(b.mods, 'mod')} on` : ''].filter(Boolean).join(' · '))),
    h('span', { class: 'sv-acts' },
      b.saves.length ? h('button', { class: 'btn btn-sm', dataset: key('restore'), disabled: !!sv.busy, title: `Restore ${of}`, 'aria-label': `Restore ${of}`, onclick: () => restoreBackup(b) }, icon('history'), h('span', {}, 'Restore…')) : null,
      h('button', { class: 'btn btn-sm btn-ghost', dataset: key('pin'), title: b.pinned ? 'Unpin: may be removed when there are more backups than the limit' : 'Pin: never removed automatically', 'aria-label': `${b.pinned ? 'Unpin' : 'Pin'} ${of}`,
        onclick: () => run(api.updateSaveBackup(b.id, { pinned: !b.pinned })) }, h('span', {}, b.pinned ? 'Unpin' : 'Pin')),
      h('button', { class: 'btn btn-sm btn-ghost', dataset: key('name'), title: 'Name this backup', 'aria-label': `${b.label ? 'Rename' : 'Name'} ${of}`, onclick: () => labelBackup(b) }, h('span', {}, b.label ? 'Rename' : 'Name')),
      h('button', { class: 'btn btn-sm btn-ghost btn-icon', dataset: key('open'), title: 'Open its folder', 'aria-label': `Open the folder of ${of}`, onclick: () => run(api.openSaves(b.id)) }, icon('folder')),
      h('button', { class: 'btn btn-sm btn-ghost-danger btn-icon', dataset: key('del'), title: 'Delete this backup', 'aria-label': `Delete ${of}`, onclick: () => deleteBackup(b) }, icon('trash'))));
}

async function labelBackup(b) {
  const input = h('input', { type: 'text', value: b.label || '', maxlength: '80', placeholder: 'e.g. Before the heist', 'aria-label': 'Backup name' });
  const shown = modal({
    title: 'Name this backup', body: h('div', {}, h('p', {}, 'A name makes it easy to find later.'), input),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Save', value: true, kind: 'btn-primary' }],
  });
  // The name field first, and Enter saves.
  setTimeout(() => { input.focus(); input.select(); }, 30);
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); input.closest('.modal')?.querySelector('.btn-primary')?.click(); } });
  if (await shown) await run(api.updateSaveBackup(b.id, { label: input.value.trim() }));
}

async function deleteBackup(b) {
  const extra = [plural(b.saves.length, 'save'), b.pinned ? 'pinned' : '', b.label ? `named "${b.label}"` : ''].filter(Boolean).join(', ');
  const ok = await confirmBox('Delete this backup?', `The backup of ${when(b.at)} (${extra}) is removed for good. Your saves themselves are not touched.`, 'Delete', true);
  if (ok && await run(api.removeSaveBackup(b.id)) !== null) toast('Backup deleted', 'success');
}

/**
 * Restore. The default puts back every save in the backup and keeps saves made since; replacing the
 * whole set is a choice of its own. Asks first; the saves as they are now are always backed up first.
 */
async function restoreBackup(b) {
  if (state.gameRunning) { toast('Close Cyberpunk 2077 first: saves cannot be restored while the game is running', 'warn'); return; }
  if (sv.busy) return;
  const some = h('input', { type: 'radio', name: 'sv-r', value: 'some', checked: true });
  const all = h('input', { type: 'radio', name: 'sv-r', value: 'all' });
  const groups = new Map();
  for (const s of b.saves) { if (!groups.has(s.playthrough)) groups.set(s.playthrough, []); groups.get(s.playthrough).push(s); }
  const boxes = [];
  const toggleAll = h('button', { type: 'button', class: 'link-btn', onclick: () => { const on = !boxes.every(x => x.checked); boxes.forEach(x => { x.checked = on; }); } }, 'Select all / none');
  const pick = h('div', { class: 'sv-pick' }, toggleAll, ...[...groups.values()].map(list => {
    const first = list[0];
    return h('fieldset', { class: 'plain sv-pick-group' }, h('legend', {}, `${ptTitle(first)}${first.level ? ` · level ${Math.max(...list.map(s => s.level))}` : ''}`),
      ...list.map(s => { const box = h('input', { type: 'checkbox', value: s.folder, checked: true }); boxes.push(box); return h('label', { class: 'check' }, box, h('span', {}, [slotName(s), s.level ? `level ${s.level}` : '', s.time ? ago(s.time) : ''].filter(Boolean).join(' · '))); }));
  }));
  for (const r of [all, some]) r.addEventListener('change', () => { pick.hidden = !some.checked; });
  const ok = await modal({
    title: `Restore the backup of ${when(b.at)}?`,
    sub: b.label || own(REASON_LABEL, b.reason),
    body: h('div', { class: 'sv-restore' },
      h('label', { class: 'check' }, some, h('span', {}, h('span', {}, 'Put back the saves I choose'), h('span', { class: 'check-sub' }, 'All of them are ticked. Saves in other slots stay; a slot the game reused since (autosaves, quick saves) gets its save from the backup.'))),
      pick,
      h('label', { class: 'check' }, all, h('span', {}, h('span', {}, `Replace all my saves with this backup (${plural(b.saves.length, 'save')})`), h('span', { class: 'check-sub' }, 'Saves made after it leave the game\'s folder (they stay in the backup taken first).'))),
      h('p', { class: 'hint' }, `Your saves as they are now are backed up first, so this can be undone.${sv.view?.steamCloud ? ' Steam Cloud is on for this game: it uploads the restored saves the next time the game closes.' : ''}`)),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Restore', value: true, kind: 'btn-primary' }],
  });
  if (!ok) return;
  const folders = all.checked ? 'all' : boxes.filter(x => x.checked).map(x => x.value);
  if (folders !== 'all' && !folders.length) { toast('No saves were ticked: nothing was restored'); return; }
  sv.busy = 'restore';
  renderSaves();
  toast('Restoring… your saves are backed up first');
  try {
    const done = await run(api.restoreSaves(b.id, folders));
    const skipped = folders === 'all' ? 0 : folders.length - (done?.length || 0);
    if (done) toast(`Restored ${plural(done.length, 'save')}${skipped > 0 ? ` (${skipped} damaged in the backup, left out)` : ''}. Your saves from before are in a new backup.`, skipped > 0 ? 'warn' : 'success');
  } finally {
    sv.busy = '';
    renderSaves();
    (document.querySelector(`[data-key="bk:${b.id}:restore"]`) || $('#h-saves')).focus?.();
  }
}

async function backupNow() {
  if (sv.busy) return;
  sv.busy = 'backup';
  renderSaves();
  try {
    const r = await run(api.backupSaves(''));
    if (r) toast(`Backed up ${plural(r.saves.length, 'save')}`, 'success');
  } finally {
    sv.busy = '';
    renderSaves();
    $('#saves-backup').focus();
  }
}

/** Saves per profile, on or off: the same switch in Settings and on the Saves page's bar (each follows the other). */
async function changePerProfile(ev) {
  const on = ev.currentTarget.checked;
  const boxes = ['#s-save-perprofile', '#saves-perprofile'].map(sel => $(sel)).filter(Boolean);
  const box = { set checked(v) { for (const b of boxes) b.checked = v; } };
  const ok = await modal({
    title: on ? 'Give each profile its own saves?' : 'Share one set of saves again?',
    body: h('div', {}, ...(on ? [
      h('p', {}, 'Your saves as they are now belong to the profile you are using. Switching to another profile swaps them out for that profile\'s saves (none at first: you can start fresh or copy yours over).'),
      h('p', {}, 'Every switch makes a backup first, and only happens with the game closed.'),
      h('p', { class: 'hint' }, 'Cloud saves (Steam, GOG) can bring a swapped-out save back into the game\'s folder; it then also shows up in the profile in use (nothing is lost). It works best with cloud saves off for Cyberpunk.'),
    ] : [
      h('p', {}, 'Switching profiles stops swapping saves. The saves in the game now stay as they are.'),
      h('p', {}, 'Other profiles\' saves stay in their own folders, where the game does not see them. Saves → Other profiles shows them, to copy a playthrough or a single save into the game\'s saves.'),
    ])),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: on ? 'Turn on' : 'Turn off', value: true, kind: 'btn-primary' }],
  });
  if (!ok) { box.checked = !on; return; }
  // On again after switching profiles while it was off: whose are the saves in the game's folder?
  let owner = '';
  if (on) {
    const view = await run(api.savesView());
    const was = view?.perProfileWas && view.profiles.find(p => p.id === view.perProfileWas);
    const now = view?.profiles.find(p => p.id === state.snap?.profiles?.active);
    if (was && now) {
      owner = await modal({
        title: 'Whose saves are in the game now?',
        body: h('div', {},
          h('p', {}, `When each profile last had its own saves, the saves in the game's folder were "${was.name}"'s. Since then you switched to "${now.name}".`),
          h('p', {}, `If you kept playing those saves in "${now.name}", they are its saves now. If not, they go back to "${was.name}" and "${now.name}" gets its own saves (none, if it never had any).`)),
        buttons: [{ label: 'Cancel', value: null, safe: true }, { label: `"${was.name}"'s`, value: was.id }, { label: `"${now.name}"'s`, value: now.id, kind: 'btn-primary' }],
      });
      if (!owner) { box.checked = false; return; }
    }
  }
  const r = await run(api.setPerProfileSaves(on, owner));
  if (!r) { box.checked = !on; return; }
  box.checked = on;
  state.settings = { ...(state.settings || {}), perProfileSaves: on };
  toast(on ? 'Each profile now has its own saves' : 'Profiles share one set of saves again', 'success');
  // Off: say where saves the game no longer sees are, and lead there.
  if (!on) {
    const view = await run(api.savesView());
    const n = view ? waitingCount(view) : 0;
    if (n) {
      toast(`${plural(n, 'playthrough')} stay in profiles' own folders, where the game does not see them`, 'info', {
        label: 'Show them', fn: () => { sv.tab = 'others'; sv.view = view; renderSaves(); goTo('saves'); },
      });
    }
  }
}
$('#s-save-perprofile').addEventListener('change', changePerProfile);
$('#saves-perprofile').addEventListener('change', changePerProfile);

$('#saves-backup').addEventListener('click', backupNow);
$('#saves-open').addEventListener('click', () => run(api.openSaves('saves')));
$$('#saves-tabs .seg-btn').forEach(b => b.addEventListener('click', () => { sv.tab = b.dataset.t; renderSaves(); }));
pageHooks.saves = loadSaves;
api.onSavesChanged(() => { if ($('#page-saves').classList.contains('active')) loadSaves(); else sv.view = null; });
// "Today", "2 h ago": fresh again when the window comes back (after midnight too).
window.addEventListener('focus', () => { if (sv.view && $('#page-saves').classList.contains('active')) renderSaves(); });
