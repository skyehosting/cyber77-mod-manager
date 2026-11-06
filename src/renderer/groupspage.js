'use strict';
/* global api, $, $$, h, icon, run, toast, newsToast, modal, confirmBox, plural, fmtSize, ago, state, store, goTo, pageHooks, snapshotHooks, keepFocus, showSettingsSection */

// ---------------------------------------------------------------- Group Mods (the Mods page's second view)
// Friends who play co-op keep a shared list of Nexus mods (src/core/groups). This page shows your
// groups and their lists (a rail), the chosen list with each mod's status for you, what changed, and
// the dialogs: turn on, create, invite, join, add mods, get the mods, members, leave. Nothing downloads
// or changes without a click here.

// One block: these names stay out of the other pages' (scripts share one global scope).
{
const gm = { view: null, mode: store.get('modsMode', 'mods') === 'groups' ? 'groups' : 'mods', g: store.get('gmGroup', ''), l: store.get('gmList', ''), q: '', toasted: {}, waiting: [], loaded: false };

const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const avatar = (m, cls = '') => h('span', { class: `gm-av ${cls}${m.online ? ' on' : ''}`, title: `${m.name}${m.me ? ' (you)' : ''}${m.online ? ' · online' : m.lastSeen ? ` · last seen ${ago(m.lastSeen)}` : ''}` }, initials(m.name));

async function loadGroups() {
  const v = await run(api.groupsView());
  if (!v) return;
  gm.view = v;
  if (!v.groups.some(g => g.id === gm.g)) gm.g = v.groups[0]?.id || '';
  const grp = v.groups.find(g => g.id === gm.g);
  if (grp && !grp.lists.some(l => l.id === gm.l)) gm.l = grp.lists[0]?.id || '';
  paintGroups();
  if (!gm.loaded) { gm.loaded = true; startupNews(); }
}

// ---- this PC's status for a list entry, and each member's

/** installed | disabled | different | downloading | missing, from this PC's mods and downloads. */
function myStatus(e) {
  const mods = state.snap?.mods || [];
  const exact = mods.find(m => Number(m.fileId) === e.fileId);
  if (exact) return exact.enabled ? 'installed' : 'disabled';
  const job = [...(state.jobs?.values?.() || state.snap?.jobs || [])].find(j => Number(j.fileId) === e.fileId && !['error', 'cancelled', 'done', 'skipped'].includes(j.status));
  if (job) return 'downloading';
  return mods.some(m => Number(m.modId) === e.modId) ? 'different' : 'missing';
}
const GM_STATUS = {
  installed: ['Installed', 'tag-ok'], disabled: ['Disabled', 'tag-off'], different: ['Different version', 'tag-warn'],
  downloading: ['Downloading', 'tag-info'], missing: ['Missing', 'tag-err'],
};
/** A member's sync state against a list: { missing, different } (null: not heard from yet). */
function memberSync(m, list) {
  if (m.me) {
    let missing = 0;
    let different = 0;
    // A disabled one counts as missing: friends only hear of enabled mods.
    for (const e of list.mods) { const s = myStatus(e); if (s === 'missing' || s === 'downloading' || s === 'disabled') missing++; else if (s === 'different') different++; }
    return { missing, different };
  }
  if (!m.mods) return null;
  const files = new Set(m.mods.map(x => x[1]));
  const ids = new Set(m.mods.map(x => x[0]));
  let missing = 0;
  let different = 0;
  for (const e of list.mods) { if (files.has(e.fileId)) continue; if (ids.has(e.modId)) different++; else missing++; }
  return { missing, different };
}
const syncChip = s => (!s ? h('span', { class: 'tag tag-off' }, 'Not heard from yet')
  : !s.missing && !s.different ? h('span', { class: 'tag tag-ok' }, 'In sync')
    : h('span', { class: `tag ${s.missing ? 'tag-err' : 'tag-warn'}` }, [s.missing ? `Missing ${s.missing}` : '', s.different ? `Different version of ${s.different}` : ''].filter(Boolean).join(' · ')));

// ---- the view

function setModsMode(mode) {
  gm.mode = mode === 'groups' ? 'groups' : 'mods';
  store.set('modsMode', gm.mode);
  paintMode();
  if (gm.mode === 'groups') loadGroups();
}

function paintMode() {
  const on = gm.mode === 'groups';
  $('#page-mods').classList.toggle('group-mode', on);
  $$('#mods-mode .seg-btn').forEach(b => { const me = b.dataset.mode === gm.mode; b.classList.toggle('active', me); b.setAttribute('aria-pressed', String(me)); });
  $('#groups-view').hidden = !on;
  $('#mods-sub').hidden = on;
  $('#groups-sub').hidden = !on;
  paintGroups();
}

function newsCount(v = gm.view) {
  return (v?.groups || []).reduce((n, g) => n + g.changes.filter(c => ['add', 'remove', 'version'].includes(c.kind)).length, 0);
}

function paintGroups() {
  const v = gm.view;
  const n = newsCount();
  $('#mods-mode-count').hidden = !n;
  $('#mods-mode-count').textContent = n || '';
  paintGroupSettings();
  if (gm.mode !== 'groups') return;
  const root = $('#groups-view');
  if (!v) { root.replaceChildren(h('div', { class: 'gm-loading' }, 'Loading your groups…')); return; }
  const lists = v.groups.reduce((k, g) => k + g.lists.length, 0);
  $('#groups-sub').textContent = v.groups.length ? [plural(v.groups.length, 'group'), plural(lists, 'list'), n ? `${plural(n, 'change')} to review` : ''].filter(Boolean).join(' · ') : 'Share a mod list with the friends you play co-op with';
  // The list's search box is drawn again with everything else: its caret stays where it was.
  const a = document.activeElement;
  const caret = a && root.contains(a) && a.dataset?.key === 'gm:q' ? [a.selectionStart, a.selectionEnd] : null;
  keepFocus(root, () => root.replaceChildren(...groupsBody(v).filter(Boolean)));
  if (caret) { const q = root.querySelector('[data-key="gm:q"]'); q?.setSelectionRange(caret[0], caret[1]); }
}

function groupsBody(v) {
  if (!v.enabled) {
    return [h('div', { class: 'gm-empty' }, h('div', { class: 'empty-icon' }, icon('users')),
      h('h2', {}, 'Group Mods is off'),
      h('p', {}, 'Play co-op with friends and see each other the way you mean to look: a group keeps one list of Nexus mods (clothing, bodies, the co-op mod itself) the same for everyone. Each of you downloads from Nexus; nothing installs without your OK.'),
      h('p', { class: 'muted' }, 'Turning it on lets your friends\' apps connect to this PC, on one port. You choose who joins: each needs an invite code and the group\'s passcode.'),
      h('button', { class: 'btn btn-primary', dataset: { key: 'gm:on' }, onclick: openTurnOn }, icon('users'), h('span', {}, 'Turn on groups…')))];
  }
  if (!v.groups.length) {
    return [notRunning(v), h('div', { class: 'gm-start' },
      h('div', { class: 'gm-start-card' }, h('div', { class: 'empty-icon' }, icon('plus')), h('h3', {}, 'Create a group'),
        h('p', {}, 'Start a list for your crew, then invite your friends with a code and a passcode.'),
        h('button', { class: 'btn btn-primary', dataset: { key: 'gm:create' }, onclick: openCreate }, 'Create group')),
      h('div', { class: 'gm-start-card' }, h('div', { class: 'empty-icon' }, icon('user-plus')), h('h3', {}, 'Join a group'),
        h('p', {}, 'A friend sends you an invite code and tells you the passcode.'),
        h('button', { class: 'btn', dataset: { key: 'gm:join' }, onclick: openJoin }, 'Join group')))];
  }
  const g = v.groups.find(x => x.id === gm.g) || v.groups[0];
  const list = g.lists.find(l => l.id === gm.l) || g.lists[0];
  return [notRunning(v), h('div', { class: 'gm-layout' }, rail(v), h('div', { class: 'gm-main' }, ...(list ? listMain(v, g, list) : noLists(g))))];
}

/** Groups are on but this PC is not listening (a busy port): say so above everything. */
function notRunning(v) {
  if (v.on) return null;
  return h('div', { class: 'banner banner-warn', role: 'status' }, icon('alert'),
    h('span', {}, `Groups are on, but this PC is not listening${v.error ? ` (${v.error})` : ''}. Friends can't reach you until it is. Check the port in Settings → Group Mods.`),
    h('button', { class: 'btn btn-sm', onclick: () => { goTo('settings'); setTimeout(() => showSettingsSection('groups'), 50); } }, 'Settings'));
}

function rail(v) {
  return h('nav', { class: 'gm-rail', 'aria-label': 'Your groups' },
    h('div', { class: 'gm-rail-head' }, 'My groups'),
    h('div', { class: 'gm-rail-list' }, ...v.groups.map(g => {
      const online = g.members.filter(m => m.online && !m.me).length;
      const others = g.members.length - 1;
      return h('div', { class: 'gm-g' },
        h('button', { class: `gm-g-head${g.id === gm.g ? ' sel' : ''}`, dataset: { key: `gm:g:${g.id}` }, onclick: () => pick(g.id, g.lists[0]?.id || '') },
          h('span', { class: 'gm-avs' }, ...g.members.filter(m => !m.me).slice(0, 3).map(m => avatar(m))),
          h('span', { class: 'gm-g-text' }, h('span', { class: 'gm-g-name' }, g.name),
            h('span', { class: 'gm-g-sub' }, others ? `${online} of ${others} online · ${plural(g.members.length, 'member')}` : 'Just you so far'))),
        ...g.lists.map(l => {
          const news = g.changes.filter(c => c.listId === l.id && ['add', 'remove', 'version'].includes(c.kind)).length;
          return h('button', { class: `gm-l${g.id === gm.g && l.id === gm.l ? ' sel' : ''}`, dataset: { key: `gm:l:${l.id}` }, 'aria-current': g.id === gm.g && l.id === gm.l ? 'true' : null, onclick: () => pick(g.id, l.id) },
            icon('layers'), h('span', { class: 'gm-l-name' }, l.name), news ? h('span', { class: 'seg-count' }, news) : null, h('span', { class: 'gm-l-n' }, l.mods.length));
        }));
    })),
    h('div', { class: 'gm-rail-foot' },
      h('button', { class: 'btn', onclick: openCreate }, icon('plus'), h('span', {}, 'Create group')),
      h('button', { class: 'btn', onclick: openJoin }, icon('user-plus'), h('span', {}, 'Join group'))));
}

function pick(g, l) {
  gm.g = g;
  gm.l = l;
  store.set('gmGroup', g);
  store.set('gmList', l);
  paintGroups();
}

function noLists(g) {
  return [h('div', { class: 'gm-head' }, h('div', { class: 'gm-title' }, h('h2', {}, g.name)),
    h('div', { class: 'gm-acts' }, h('button', { class: 'btn', onclick: () => openInvite(g) }, icon('user-plus'), h('span', {}, 'Invite')), groupMenu(g, null))),
  h('div', { class: 'gm-empty' }, h('h2', {}, `${g.name} has no lists`), h('p', {}, 'A list is a set of mods everyone in the group keeps the same.'),
    h('button', { class: 'btn btn-primary', onclick: () => newList(g) }, icon('plus'), h('span', {}, 'New list')))];
}

function listMain(v, g, list) {
  const me = g.members.find(m => m.me);
  const others = g.members.filter(m => !m.me);
  const online = others.filter(m => m.online);
  const away = others.filter(m => !m.online);
  const myGame = v.game || '';
  const odd = others.filter(m => m.game && myGame && m.game !== myGame);
  const head = h('div', { class: 'gm-head' },
    h('div', { class: 'gm-title' }, h('h2', {}, list.name), h('span', { class: 'gm-in' }, `in ${g.name}`)),
    h('div', { class: 'gm-acts' },
      h('button', { class: 'btn', dataset: { key: 'gm:invite' }, onclick: () => openInvite(g) }, icon('user-plus'), h('span', {}, 'Invite')),
      h('button', { class: 'btn', dataset: { key: 'gm:add' }, onclick: () => openAddMods(g, list) }, icon('plus'), h('span', {}, 'Add mod')),
      groupMenu(g, list)));
  const people = h('div', { class: 'gm-people' },
    h('span', { class: 'gm-avs big' }, ...g.members.map(m => avatar(m))),
    h('span', { class: 'gm-people-text' },
      !others.length ? 'Just you so far. Invite your friends.'
        : [online.length ? `${online.map(m => m.name).join(', ')} online` : 'Nobody else online', ...away.slice(0, 3).map(m => `${m.name} ${m.lastSeen ? ago(m.lastSeen) : 'not seen yet'}`)].join(' · ')),
    h('button', { class: 'link-btn', onclick: () => openMembers(g, list) }, 'Members'),
    ...odd.map(m => h('span', { class: 'tag tag-warn', title: `Your newest save is from game version ${myGame}` }, icon('alert'), `${m.name} is on game ${m.game}`)));
  const blocks = [head, people];
  if (others.length && !online.length && v.on) {
    blocks.push(h('p', { class: 'gm-note' }, icon('info'), h('span', {}, 'Nobody else in the group is connected right now. What you change reaches them the next time any of you are online together.')));
  }
  const news = g.changes.filter(c => ['add', 'remove', 'version', 'join', 'leave', 'remove-member'].includes(c.kind) || c.kind === 'remove');
  if (news.length) blocks.push(changesCard(g, list, news));
  blocks.push(listTable(g, list, me));
  return blocks;
}

function changeText(c) {
  if (c.kind === 'add') return [h('b', {}, c.by), ` added ${c.name}${c.version ? ` ${c.version}` : ''}`, c.list ? h('span', { class: 'muted' }, ` · ${c.list}`) : ''];
  if (c.kind === 'version') return [h('b', {}, c.by), ` changed ${c.name || 'a mod'} to version ${c.version || '?'}`, c.list ? h('span', { class: 'muted' }, ` · ${c.list}`) : ''];
  if (c.kind === 'remove') {
    if (c.modId) return [h('b', {}, c.by), ` removed ${c.name || 'a mod'} from ${c.list || 'a list'}`, h('span', { class: 'muted' }, ': disabled for you if it came in through the group')];
    return [h('b', {}, c.by), ` removed ${c.name} from the group`];
  }
  if (c.kind === 'join') return [h('b', {}, c.name), ' joined', h('span', { class: 'muted' }, ` (let in by ${c.by})`)];
  if (c.kind === 'leave') return [h('b', {}, c.name), ' left the group'];
  return [c.kind];
}

function changesCard(g, list, news) {
  const adds = news.filter(c => c.kind === 'add' || c.kind === 'version').length;
  return h('section', { class: 'gm-changes', 'aria-label': 'Changes to review' },
    h('div', { class: 'gm-changes-head' }, icon('inbox'), h('b', {}, `Changes to review (${news.length})`), h('span', { class: 'muted' }, ' · nothing downloads or changes until you say so'),
      h('span', { class: 'push' }),
      adds ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => openGet(g, list) }, `Review ${plural(adds, 'mod')}`) : null,
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => run(api.groupsSeen(g.id)) }, 'Mark as read')),
    h('div', { class: 'gm-changes-list' }, ...news.slice(0, 6).map(c => h('div', { class: 'gm-change' },
      h('span', { class: 'gm-change-text' }, ...changeText(c)),
      h('span', { class: 'gm-when' }, ago(c.at))))));
}

function listTable(g, list, me) {
  const q = gm.q.trim().toLowerCase();
  const mods = [...list.mods].sort((a, b) => a.name.localeCompare(b.name)).filter(e => !q || e.name.toLowerCase().includes(q));
  const counts = { missing: 0 };
  for (const e of list.mods) { const s = myStatus(e); if (s === 'missing' || s === 'different') counts.missing++; }
  const search = h('input', { type: 'search', placeholder: 'Search this list', value: gm.q, 'aria-label': 'Search this list', dataset: { key: 'gm:q' } });
  search.addEventListener('input', () => { gm.q = search.value; paintGroups(); });
  const bar = h('div', { class: 'gm-bar' },
    h('label', { class: 'search' }, icon('search'), search),
    counts.missing ? h('button', { class: 'btn btn-primary', onclick: () => openGet(g, list) }, icon('download'), h('span', {}, `Get the ${plural(counts.missing, 'mod')} you're missing`)) : null,
    h('span', { class: 'gm-count muted' }, `${plural(list.mods.length, 'mod')} in the list`));
  if (!list.mods.length) {
    return h('div', {}, bar, h('div', { class: 'gm-empty small' }, h('p', {}, 'This list is empty. Add mods you have installed: everyone in the group is asked before anything downloads.'),
      h('button', { class: 'btn btn-primary', onclick: () => openAddMods(g, list) }, icon('plus'), h('span', {}, 'Add mod'))));
  }
  return h('div', {}, bar, h('div', { class: 'table-card gm-table' },
    h('table', { class: 'grid', 'aria-label': `Mods in ${list.name}` },
      h('thead', {}, h('tr', {}, h('th', {}, 'Mod'), h('th', {}, 'Version'), h('th', {}, 'Added by'), h('th', {}, 'Status for you'), h('th', { 'aria-label': 'Actions' }))),
      h('tbody', {}, ...mods.map(e => {
        const s = myStatus(e);
        const [label, cls] = GM_STATUS[s];
        const sub = [e.category, e.reqs.length ? plural(e.reqs.length, 'requirement') : '', e.size ? fmtSize(e.size) : ''].filter(Boolean).join(' · ');
        return h('tr', { class: `gm-row st-${s}` },
          h('td', {}, h('div', { class: 'gm-mod' }, h('span', { class: 'gm-mod-name' }, e.name, e.adult ? h('span', { class: 'tag tag-off' }, 'Adult') : null), h('span', { class: 'gm-mod-sub' }, sub || 'Nexus Mods'))),
          h('td', { class: 'num' }, e.version || '–'),
          h('td', {}, h('span', { class: 'gm-by' }, e.addedByName, h('span', { class: 'muted' }, ` · ${ago(e.changedAt || e.addedAt)}`))),
          h('td', {}, h('span', { class: `tag ${cls}` }, label), e.keep ? h('span', { class: 'tag tag-off', title: 'Kept for you even if it leaves the list' }, 'Kept for you') : null),
          h('td', { class: 'gm-row-acts' },
            h('a', { class: 'btn btn-sm btn-ghost btn-icon', href: `https://www.nexusmods.com/cyberpunk2077/mods/${e.modId}`, target: '_blank', rel: 'noopener', title: 'Open on Nexus Mods', 'aria-label': `Open ${e.name} on Nexus Mods` }, icon('external')),
            h('button', { class: 'btn btn-sm btn-ghost btn-icon', title: e.keep ? 'Stop keeping it for you' : 'Keep it for me, even if someone removes it from the list', 'aria-label': `${e.keep ? 'Stop keeping' : 'Keep'} ${e.name} for me`, 'aria-pressed': String(!!e.keep), onclick: () => run(api.groupsKeep(g.id, e.modId, !e.keep)).then(loadGroups) }, icon('pin')),
            h('button', { class: 'btn btn-sm btn-ghost-danger btn-icon', title: 'Remove from the list (disabled for members who got it through the group)', 'aria-label': `Remove ${e.name} from the list`, onclick: () => removeFromList(g, list, e) }, icon('x'))));
      })))));
}

// ---- a small menu (more actions for the group)

function groupMenu(g, list) {
  const menu = h('div', { class: 'menu', role: 'menu', hidden: true },
    ...[
      ['users', 'Members…', () => openMembers(g, list)],
      ['plus', 'New list…', () => newList(g)],
      list ? ['edit', 'Rename this list…', () => renameList(g, list)] : undefined,
      ['edit', 'Change your name…', () => renameMe(g)],
      null,
      list ? ['trash', 'Remove this list…', () => removeList(g, list), true] : undefined,
      ['log-out', 'Leave the group…', () => leaveGroup(g), true],
    ].filter(x => x !== undefined).map(x => (x ? h('button', { class: `menu-item${x[3] ? ' danger' : ''}`, role: 'menuitem', onclick: () => { close(); x[2](); } }, icon(x[0]), h('span', {}, h('span', { class: 'menu-label' }, x[1]))) : h('div', { class: 'menu-sep', role: 'separator' }))));
  const btn = h('button', { class: 'btn btn-icon', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'More', 'aria-label': 'More group actions', onclick: () => (menu.hidden ? open() : close()) }, icon('more'));
  const wrap = h('div', { class: 'menu-wrap' }, btn, menu);
  const outside = ev => { if (!wrap.contains(ev.target)) close(); };
  function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); menu.querySelector('.menu-item')?.focus(); document.addEventListener('mousedown', outside); }
  function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside); }
  menu.addEventListener('keydown', ev => {
    const items = [...menu.querySelectorAll('.menu-item')];
    const i = items.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); btn.focus(); }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });
  return wrap;
}

// ---- dialogs

const field = (label, input, hint = '') => h('label', { class: 'gm-field' }, h('span', { class: 'gm-field-label' }, label), input, hint ? h('span', { class: 'gm-field-hint' }, hint) : null);
const textInput = (value = '', attrs = {}) => h('input', { type: 'text', value, maxlength: '60', spellcheck: 'false', ...attrs });
function copyBtn(text, label = 'Copy') {
  const b = h('button', { type: 'button', class: 'btn btn-sm' }, icon('copy'), h('span', {}, label));
  b.addEventListener('click', () => { navigator.clipboard.writeText(text).then(() => { b.lastChild.textContent = 'Copied'; setTimeout(() => { b.lastChild.textContent = label; }, 1500); }); });
  return b;
}
const myDefaultName = () => state.keyUser?.name || store.get('gmMyName', '');

async function openTurnOn() {
  const ok = await modal({
    title: 'Turn on groups?',
    body: h('div', { class: 'gm-dialog' },
      h('ul', { class: 'gm-bullets' },
        h('li', {}, 'You and your friends keep one list of Nexus mods the same, so in co-op you see each other as you mean to look.'),
        h('li', {}, 'Each of you downloads from Nexus Mods (so authors get the credit). Nothing downloads or changes until you say so.'),
        h('li', {}, 'Only the group\'s list and whether you have those mods are shared: never your other mods, files, saves or Nexus key.')),
      h('p', {}, `Your friends' apps connect to this PC on port ${gm.view?.port || 47077}. ${navigator.userAgent.includes('Windows') ? 'Windows asks once (an admin prompt) to let them through the firewall.' : 'If your PC has a firewall on, the next step shows the command that opens the port.'}`),
      h('p', { class: 'muted' }, 'Friends on another network also need your router to pass the port on: the app asks your router (UPnP) and tells you if it can\'t. A VPN such as Tailscale, ZeroTier or Radmin works without any router change.')),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Turn on', value: true, kind: 'btn-primary' }],
  });
  if (!ok) return;
  if (!await firewallStep()) return;
  const v = await run(api.groupsEnable(true));
  if (v) { gm.view = v; paintGroups(); paintFirewallSetting(); toast(v.on ? 'Groups are on' : 'Groups are on, but this PC could not start listening', v.on ? 'success' : 'warn'); }
}

/** Make sure friends get through the firewall. Resolves true to go on (done, or the user chose to go on). */
async function firewallStep() {
  const fw = await run(api.groupsFirewall());
  if (!fw || fw.ok) return true;
  if (fw.platform === 'win32') {
    const go = await modal({
      title: 'Let your friends through the firewall',
      body: h('div', { class: 'gm-dialog' },
        h('p', {}, `Windows will ask for permission once (an admin prompt). The app then adds one rule: this app, port ${gm.view?.port || 47077}, incoming only. It is removed when you turn groups off.`),
        fw.unknown ? h('p', { class: 'muted' }, 'The firewall could not be checked. If you use another firewall (Norton, Bitdefender…), allow the app there too.') : null),
      buttons: [{ label: 'Skip', value: 'skip', safe: true }, { label: 'Allow through the firewall', value: 'allow', kind: 'btn-primary' }],
    });
    if (!go) return false;
    if (go === 'skip') return true;
    const r = await run(api.groupsFirewallAllow());
    if (r?.ok) { toast('Your friends can get through the firewall', 'success'); return true; }
    toast(r?.cancelled ? 'The firewall was not changed (the admin prompt was declined). Friends may not be able to connect.' : (r?.error || 'The firewall was not changed'), 'warn');
    return true;
  }
  // ufw can't be checked without your password: once its command ran from here, it is not asked again.
  if (fw.kind && !(fw.kind === 'ufw' && store.get('gmUfwDone', 0) === (gm.view?.port || 47077))) {
    const go = await modal({
      title: `Open port ${gm.view?.port || 47077} in ${fw.kind}`,
      body: h('div', { class: 'gm-dialog' }, h('p', {}, `Your PC runs ${fw.kind}. This command lets your friends connect:`),
        h('div', { class: 'gm-code' }, h('code', {}, fw.command), copyBtn(fw.command)),
        h('p', { class: 'muted' }, '"Run it for me" asks for your password in your desktop\'s own prompt.')),
      buttons: [{ label: 'Skip', value: 'skip', safe: true }, { label: 'Run it for me', value: 'run', kind: 'btn-primary' }],
    });
    if (!go) return false;
    if (go === 'run') {
      const r = await run(api.groupsFirewallAllow());
      if (r?.ok && fw.kind === 'ufw') store.set('gmUfwDone', gm.view?.port || 47077); // for this port only
      toast(r?.ok ? 'The port is open in your firewall' : 'The firewall was not changed: run the command yourself', r?.ok ? 'success' : 'warn');
    }
  }
  return true;
}

async function turnOff() {
  const ok = await confirmBox('Turn off groups?', 'Your friends can\'t connect to this PC until you turn them on again. Your groups and lists stay; nothing is uninstalled.', 'Turn off');
  if (!ok) return;
  const v = await run(api.groupsEnable(false));
  if (v) { gm.view = v; paintGroups(); paintFirewallSetting(); }
  const fw = await run(api.groupsFirewall());
  if ((fw?.present || (fw?.kind === 'ufw' && store.get('gmUfwDone', 0) === gm.view?.port)) && await confirmBox('Remove the firewall rule too?', fw.platform === 'win32' ? 'Windows asks for permission once more (an admin prompt).' : 'Your desktop asks for your password.', 'Remove it')) {
    const r = await run(api.groupsFirewallRemove());
    if (r && !r.ok) toast('The firewall rule stays (the prompt was declined)', 'info');
    else if (r?.ok) store.set('gmUfwDone', 0);
  }
}

async function openCreate() {
  if (!gm.view?.enabled) { await openTurnOn(); if (!gm.view?.enabled) return; }
  const name = textInput('', { placeholder: 'e.g. Night City Crew' });
  const me = textInput(myDefaultName(), { maxlength: '40', placeholder: 'How friends see you' });
  const first = textInput('Co-op night', { placeholder: 'e.g. Co-op night' });
  const shown = modal({
    title: 'Create a group',
    body: h('div', { class: 'gm-dialog' }, field('Group name', name), field('Your name in the group', me), field('First list', first, 'A list is a set of mods the group keeps the same. You can add more lists later.')),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Create', value: true, kind: 'btn-primary' }],
  });
  setTimeout(() => name.focus(), 30);
  if (!await shown) return;
  if (!name.value.trim() || !me.value.trim()) { toast('Give the group a name, and yours', 'warn'); return; }
  store.set('gmMyName', me.value.trim());
  const r = await run(api.groupsCreate({ name: name.value.trim(), myName: me.value.trim(), listName: first.value.trim() || 'Co-op night' }));
  if (!r) return;
  pick(r.g, r.list);
  await loadGroups();
  const g = gm.view.groups.find(x => x.id === r.g);
  if (g) openInvite(g);
}

async function openInvite(g) {
  const inv = await run(api.groupsInvite(g.id));
  if (!inv) return;
  const until = new Date(inv.expires).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  await modal({
    title: `Invite a friend to ${g.name}`,
    sub: 'Send them the code, and tell them the passcode',
    body: h('div', { class: 'gm-dialog' },
      field('Invite code', h('div', { class: 'gm-code' }, h('code', { class: 'gm-invite' }, inv.code), copyBtn(inv.code))),
      field('Passcode', h('div', { class: 'gm-code' }, h('code', { class: 'gm-pass' }, inv.passcode), copyBtn(inv.passcode)), 'Everyone in the group has the same passcode. It changes by itself when someone leaves or is removed.'),
      h('p', { class: 'muted' }, `The code works once, until ${until}. It holds this PC's address (${inv.addrs.join(', ')}): send it only to the friend you mean. Your app must be open with groups on when they join.`)),
    buttons: [{ label: 'Revoke my open invites', value: 'revoke' }, { label: 'Done', value: true, kind: 'btn-primary' }],
  }).then(v => { if (v === 'revoke') run(api.groupsRevoke(g.id)).then(() => toast('Your open invites for this group no longer work')); });
}

async function openJoin() {
  if (!gm.view?.enabled) { await openTurnOn(); if (!gm.view?.enabled) return; }
  const code = h('textarea', { rows: '3', spellcheck: 'false', placeholder: 'CMMG1-…', class: 'gm-code-input' });
  const pass = textInput('', { maxlength: '64', placeholder: 'XXXX-XXXX-XXXX-XXXX', autocomplete: 'off' });
  const me = textInput(myDefaultName(), { maxlength: '40', placeholder: 'How friends see you' });
  const shown = modal({
    title: 'Join a group',
    body: h('div', { class: 'gm-dialog' }, field('Invite code', code), field('Passcode', pass, 'Your friend tells you this.'), field('Your name in the group', me)),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Join', value: true, kind: 'btn-primary' }],
  });
  setTimeout(() => code.focus(), 30);
  if (!await shown) return;
  if (!code.value.trim() || !pass.value.trim()) { toast('Paste the invite code and type the passcode', 'warn'); return; }
  store.set('gmMyName', me.value.trim());
  toast('Connecting to your friend\'s PC…');
  const g = await run(api.groupsJoin(code.value.trim(), pass.value.trim(), me.value.trim() || 'Member'));
  if (!g) return;
  await loadGroups();
  const grp = gm.view.groups.find(x => x.id === g);
  if (grp) { pick(g, grp.lists[0]?.id || ''); toast(`You joined ${grp.name}`, 'success'); }
}

/** Add mods to a list: this PC's installed Nexus mods, A to Z. */
async function openAddMods(g, list) {
  const inList = new Set(list.mods.map(e => e.modId));
  const seen = new Set();
  // One entry per mod: its Main file when it has one installed (not an optional patch), enabled first.
  const rank = m => (m.category === 'MAIN' ? 0 : 1) + (m.enabled ? 0 : 2);
  const mine = (state.snap?.mods || []).filter(m => Number(m.modId) > 0 && Number(m.fileId) > 0).sort((a, b) => rank(a) - rank(b))
    .filter(m => { const k = Number(m.modId); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.modName || a.name).localeCompare(b.modName || b.name));
  const local = (state.snap?.mods || []).filter(m => !(Number(m.modId) > 0 && Number(m.fileId) > 0)).length;
  const search = h('input', { type: 'search', placeholder: 'Search your mods', 'aria-label': 'Search your mods' });
  const rows = mine.map(m => {
    const there = inList.has(Number(m.modId));
    const box = h('input', { type: 'checkbox', value: m.id, disabled: there });
    const reqs = (state.snap?.reqs?.[m.id] || []).length;
    const row = h('label', { class: `check gm-pick-row${there ? ' off' : ''}` }, box,
      h('span', { class: 'gm-pick-name' }, m.modName || m.name, h('span', { class: 'muted' }, ` ${m.version || ''}`)),
      h('span', { class: 'gm-pick-note muted' }, there ? 'In the list' : reqs ? plural(reqs, 'requirement') : ''));
    return { m, box, row };
  });
  const count = () => rows.filter(r => r.box.checked).length;
  const listBox = h('div', { class: 'gm-pick' }, ...rows.map(r => r.row));
  search.addEventListener('input', () => { const q = search.value.trim().toLowerCase(); for (const r of rows) r.row.hidden = !!q && !(r.m.modName || r.m.name).toLowerCase().includes(q); });
  listBox.addEventListener('change', () => { const b = $('#modal .modal-foot .btn-primary'); if (b) b.textContent = count() ? `Add ${plural(count(), 'mod')}` : 'Add'; });
  const shown = modal({
    title: `Add mods to ${list.name}`,
    body: h('div', { class: 'gm-dialog' }, search, rows.length ? listBox : h('p', { class: 'muted' }, 'None of your mods come from Nexus Mods yet.'),
      h('p', { class: 'muted' }, `Members are asked before anything downloads.${local ? ` ${plural(local, 'mod')} installed from a file can't go on a list (not on Nexus Mods).` : ''}`)),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Add', value: true, kind: 'btn-primary' }],
  });
  setTimeout(() => search.focus(), 30);
  if (!await shown) return;
  const ids = rows.filter(r => r.box.checked).map(r => r.m.id);
  if (!ids.length) return;
  const n = await run(api.groupsModsAdd(g.id, list.id, ids));
  if (n) toast(`Added ${plural(n, 'mod')} to ${list.name}`, 'success');
  loadGroups();
}

/** Get the list's mods this PC is missing: each with its requirements, ticked; Download selected. */
async function openGet(g, list) {
  const mods = state.snap?.mods || [];
  const have = id => mods.some(m => Number(m.modId) === id);
  const need = [...list.mods].filter(e => ['missing', 'different'].includes(myStatus(e))).sort((a, b) => a.name.localeCompare(b.name));
  if (!need.length) {
    toast('You have everything on this list', 'success');
    run(api.groupsSeen(g.id));
    return;
  }
  const premium = !!state.keyUser?.isPremium;
  // First ask Nexus what each mod (and requirement) really is: a list entry's name is a member's word.
  // Only what Nexus confirms starts ticked; a name that differs is pointed out and left unticked.
  toast('Checking the mods with Nexus…');
  const ids = [...new Set(need.flatMap(e => [e.modId, ...e.reqs.map(r => r.modId)]))];
  const real = (await api.groupsVerify(ids.map(modId => ({ modId }))))?.ok || {};
  const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const rows = need.map(e => {
    const n = real[e.modId];
    const trusted = !!n && sameName(n.name, e.name);
    const box = h('input', { type: 'checkbox', checked: trusted });
    const reqs = e.reqs.filter(r => !list.mods.some(x => x.modId === r.modId)).map(r => {
      const rn = real[r.modId];
      return { r, rn, box: h('input', { type: 'checkbox', checked: !have(r.modId) && !!rn && trusted, disabled: have(r.modId) || !trusted }) };
    });
    const open = { on: false };
    const sub = h('div', { class: 'gm-reqs', hidden: true }, ...reqs.map(x => h('label', { class: `check gm-req${have(x.r.modId) ? ' off' : ''}` }, x.box,
      h('span', {}, x.rn ? x.rn.name : `${x.r.name || 'Mod'} (Nexus mod ${x.r.modId}, not checked)`),
      h('span', { class: 'muted' }, have(x.r.modId) ? 'Installed' : 'Needed'))));
    const chev = reqs.length ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-icon', 'aria-expanded': 'false', 'aria-label': `Show the requirements of ${e.name}`, onclick: () => { open.on = !open.on; sub.hidden = !open.on; chev.setAttribute('aria-expanded', String(open.on)); chev.classList.toggle('turn', open.on); } }, icon('chevron-right')) : h('span', { class: 'gm-chev-space' });
    box.addEventListener('change', () => { for (const x of reqs) if (!have(x.r.modId)) x.box.disabled = !box.checked; });
    const nexus = h('span', { class: `gm-nexus muted${n && !trusted ? ' bad' : ''}` },
      !n ? `Could not check with Nexus (mod ${e.modId}, added by ${e.addedByName}): tick it only if you trust it`
        : trusted ? `On Nexus: ${n.name}${n.author ? ` by ${n.author}` : ''} · added by ${e.addedByName}`
          : `Careful: on Nexus this is "${n.name}"${n.author ? ` by ${n.author}` : ''}, not "${e.name}" (added by ${e.addedByName})`);
    const row = h('div', { class: 'gm-get-row' }, h('div', { class: 'gm-get-main' }, chev, h('label', { class: 'check' }, box, h('span', {}, h('b', {}, e.name), h('span', { class: 'muted' }, ` ${e.version}${myStatus(e) === 'different' ? ' (you have another version)' : ''}`), nexus)),
      h('span', { class: 'muted gm-get-size' }, [e.size ? fmtSize(e.size) : '', reqs.length ? plural(reqs.length, 'requirement') : ''].filter(Boolean).join(' · '))), sub);
    return { e, box, reqs, row, nexus };
  });
  const label = () => {
    const files = rows.filter(r => r.box.checked);
    const reqN = rows.reduce((n, r) => n + (r.box.checked ? r.reqs.filter(x => x.box.checked && !x.box.disabled).length : 0), 0);
    const size = files.reduce((n, r) => n + (r.e.size || 0), 0);
    const n = files.length + reqN;
    return premium ? `Download selected (${plural(n, 'file')}${size ? `, ${fmtSize(size)}+` : ''})` : `Get selected (${plural(n, 'file')})`;
  };
  // The dialog's button follows the boxes (it is in the page once the dialog shows: looked up then).
  const getBox = h('div', { class: 'gm-get' }, ...rows.map(r => r.row));
  getBox.addEventListener('change', () => { const b = $('#modal .modal-foot .btn-primary'); if (b) b.textContent = label(); });
  const shown = modal({
    title: `Get ${list.name}'s mods`, sub: `${plural(need.length, 'mod')} you don't have yet, or have in another version`,
    body: h('div', { class: 'gm-dialog' }, getBox,
      h('p', { class: 'muted' }, premium ? 'They download from Nexus Mods and install into the profile you are using. Where you have another version, it is replaced.'
        : 'Free Nexus account: each file waits on the Downloads page for one click on "Slow download" on Nexus. They install into the profile you are using; another version you have is replaced.')),
    buttons: [{ label: 'Not now', value: false, safe: true }, { label: label(), value: true, kind: 'btn-primary' }],
  });
  if (!await shown) return;
  const picks = rows.filter(r => r.box.checked).map(r => ({ modId: r.e.modId, fileId: r.e.fileId }));
  const reqs = [...new Set(rows.filter(r => r.box.checked).flatMap(r => r.reqs.filter(x => x.box.checked && !x.box.disabled).map(x => x.r.modId)))];
  if (!picks.length && !reqs.length) return;
  toast('Asking Nexus for the files…');
  const r = await run(api.groupsDownload(g.id, picks, reqs));
  if (!r) return;
  if (r.gone.length) toast(`No longer on Nexus Mods: ${r.gone.join(', ')}. Ask the group to move the list to a newer version.`, 'warn');
  if (r.failed) toast(`${plural(r.failed, 'mod')} could not be fetched: ${r.problems.join('; ')}`, 'warn');
  if (r.installed) toast(`Installed ${plural(r.installed, 'mod')} that ${r.installed === 1 ? 'was' : 'were'} downloaded already`, 'success');
  if (r.queued) toast(`${plural(r.queued, 'file')} on the way${premium ? '' : ': each needs one click on the Downloads page'}`, 'success', { label: 'Downloads', fn: () => goTo('downloads') });
  else if (!r.installed && !r.failed && !r.gone.length) toast('Nothing new to download');
  run(api.groupsSeen(g.id));
}

async function removeFromList(g, list, e) {
  const ok = await confirmBox(`Remove ${e.name} from ${list.name}?`, 'It is disabled (not uninstalled) for members who got it through the group, when their game is closed. Members can choose to keep it. Your own copy stays as it is.', 'Remove', true);
  if (ok) { await run(api.groupsModRemove(g.id, list.id, e.modId)); loadGroups(); }
}

async function openMembers(g, list) {
  // Remove closes this window first (a dialog waits for the one already open), then asks.
  let pickedToRemove = null;
  const rows = g.members.map(m => h('div', { class: 'gm-member' }, avatar(m, 'big'),
    h('span', { class: 'gm-member-main' }, h('span', { class: 'gm-member-name' }, m.name, m.me ? h('span', { class: 'muted' }, ' (you)') : null, m.host ? h('span', { class: 'tag tag-info' }, 'Host') : null),
      h('span', { class: 'muted' }, [m.me || m.online ? 'Online' : m.lastSeen ? `Last seen ${ago(m.lastSeen)}` : 'Not seen yet', m.game ? `game ${m.game}` : '', m.invitedBy ? `let in by ${m.invitedBy}` : ''].filter(Boolean).join(' · '))),
    list ? syncChip(memberSync(m, list)) : null,
    g.iAmHost && !m.me ? h('button', { class: 'btn btn-sm btn-ghost-danger', onclick: () => { pickedToRemove = m; $('#modal .modal-foot .btn-primary')?.click(); } }, 'Remove') : null));
  await modal({
    title: `Members of ${g.name}`, sub: g.iAmHost ? 'You are the host: you can remove members.' : `${g.members.find(x => x.host)?.name || 'The host'} is the host.`,
    body: h('div', { class: 'gm-dialog gm-members' }, ...rows, g.gone.length ? h('p', { class: 'muted' }, `Left or removed: ${g.gone.map(x => x.name).join(', ')}`) : null),
    buttons: [{ label: 'Close', value: true, kind: 'btn-primary' }],
  });
  if (pickedToRemove) await removeMember(g, pickedToRemove);
}

/** The host removes a member, and (ticked) the people that member let in. */
async function removeMember(g, m) {
  const theirs = g.members.filter(x => !x.me && x.invitedByFp === m.fp).map(x => ({ x, box: h('input', { type: 'checkbox', checked: true }) }));
  const ok = await modal({
    title: `Remove ${m.name} from ${g.name}?`,
    body: h('div', { class: 'gm-dialog' }, h('p', {}, 'They lose the group and its lists (their mods stay installed). The passcode changes, so the one they knew stops working.'),
      theirs.length ? h('p', {}, `${m.name} let these people in. Remove them too?`) : null,
      ...theirs.map(t => h('label', { class: 'check' }, t.box, h('span', {}, t.x.name)))),
    buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Remove', value: true, kind: 'btn-danger' }],
  });
  if (!ok) return;
  await run(api.groupsRemoveMember(g.id, m.fp));
  for (const t of theirs) if (t.box.checked) await run(api.groupsRemoveMember(g.id, t.x.fp));
  loadGroups();
}

async function promptText(title, label, value, max = 60) {
  const input = textInput(value, { maxlength: String(max) });
  const shown = modal({ title, body: h('div', { class: 'gm-dialog' }, field(label, input)), buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Save', value: true, kind: 'btn-primary' }] });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); $('#modal .modal-foot .btn-primary')?.click(); } });
  return (await shown) ? input.value.trim() : null;
}
async function newList(g) { const n = await promptText('New list', 'List name', ''); if (n) { const id = await run(api.groupsListAdd(g.id, n)); if (id) pick(g.id, id); loadGroups(); } }
async function renameList(g, l) { const n = await promptText('Rename the list', 'List name', l.name); if (n) { await run(api.groupsListRename(g.id, l.id, n)); loadGroups(); } }
async function renameMe(g) { const me = g.members.find(m => m.me); const n = await promptText('Your name in the group', 'Name', me?.name || '', 40); if (n) { await run(api.groupsRename(g.id, n)); loadGroups(); } }
async function removeList(g, l) {
  if (await confirmBox(`Remove the list ${l.name}?`, 'The list goes for everyone in the group. Nobody\'s mods are disabled or uninstalled by this.', 'Remove list', true)) { await run(api.groupsListRemove(g.id, l.id)); loadGroups(); }
}
async function leaveGroup(g) {
  const last = g.members.length === 1;
  if (!await confirmBox(`Leave ${g.name}?`, `${last ? 'You are the last member: the group ends. ' : ''}Your mods stay installed and enabled; you stop getting the group's changes.${g.iAmHost && !last ? ' The member who joined first after you becomes host.' : ''}`, 'Leave', true)) return;
  const r = await api.groupsLeave(g.id, false);
  if (r?.error && /Nobody else in the group is connected/.test(r.error)) {
    if (!await confirmBox('Nobody else is online', `Nobody in ${g.name} is connected right now, so they won't hear that you left: they keep listing you${g.iAmHost ? ', and as host, so nobody could remove anyone' : ''}. Better: leave when someone is online.`, 'Leave anyway', true)) return;
    await run(api.groupsLeave(g.id, true));
  } else if (r?.error) { toast(r.error, 'error'); return; }
  setTimeout(loadGroups, 1200);
}

// ---- Settings → Group Mods

function paintGroupSettings() {
  const v = gm.view;
  if (!v || !$('#s-groups-toggle')) return;
  $('#s-groups-toggle').textContent = v.enabled ? 'Turn off' : 'Turn on…';
  $('#s-groups-desc').textContent = v.enabled
    ? (v.on ? `On: friends' apps can connect to this PC on port ${v.port} (${plural(v.groups.length, 'group')}).` : `On, but not listening${v.error ? ` (${v.error})` : ''}.`)
    : 'Share a mod list with the friends you play co-op with. Off: nothing on this PC listens for connections.';
  const r = v.router || {};
  const routerText = !v.enabled ? 'Checked when groups are on.'
    : !v.upnp ? 'Not asked (turned off above). Friends on another network need the port forwarded by hand, or a VPN.'
      : { trying: 'Asking your router…', open: `Port ${v.port} is open on your router (internet address ${r.external || 'unknown'}).`, cgnat: `Your router got the port, but your internet provider shares one address between customers (${r.external}): friends outside your network can't reach you directly. Use a VPN such as Tailscale, ZeroTier or Radmin.`,
        none: 'No router answered (UPnP is off or not supported). Forward the port by hand in your router\'s settings, or use a VPN such as Tailscale, ZeroTier or Radmin.', refused: `Your router said no${r.detail ? ` (${r.detail})` : ''}. Forward the port by hand, or use a VPN.`, conflict: `Another PC on your network already uses port ${v.port} on the router. Choose another port.`, off: 'Not asked yet.' }[r.state] || '';
  $('#s-groups-router').textContent = routerText;
  $('#s-groups-router-ctl').replaceChildren(...(v.enabled && v.upnp && r.state !== 'trying' ? [h('button', { type: 'button', class: 'btn btn-sm', onclick: () => run(api.groupsRouter()).then(x => { if (x) { gm.view = x; paintGroups(); } }) }, 'Ask again')] : []));
}

async function paintFirewallSetting() {
  if (!$('#s-groups-fw')) return;
  if (!gm.view?.enabled) { $('#s-groups-fw').textContent = 'Checked when groups are on.'; $('#s-groups-fw-ctl').replaceChildren(); return; }
  const fw = await run(api.groupsFirewall());
  if (!fw) return;
  const text = fw.platform === 'win32'
    ? (fw.ok ? 'Allowed: friends\' apps can get through the Windows firewall.' : fw.present ? 'The rule is there but does not match this app or port: allow again.' : 'Not allowed yet. Windows asks once (an admin prompt).')
    : !fw.kind ? 'No firewall found that needs a change.'
      : fw.ok ? `Port ${gm.view?.port || 47077} is open in ${fw.kind}.`
        : fw.unknown ? `${fw.kind} is on. Whether port ${gm.view?.port || 47077} is open can't be checked without your password: if friends can't connect, run ${fw.command}.`
          : `${fw.kind} is on: friends need port ${gm.view?.port || 47077} open in it (${fw.command}).`;
  $('#s-groups-fw').textContent = text;
  $('#s-groups-fw-ctl').replaceChildren(...(fw.ok ? (fw.present ? [h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: async () => { const r = await run(api.groupsFirewallRemove()); if (r?.ok) toast('The firewall rule is removed'); paintFirewallSetting(); } }, 'Remove the rule')] : [])
    : [h('button', { type: 'button', class: 'btn btn-sm', onclick: async () => { await firewallStep(); paintFirewallSetting(); } }, fw.platform === 'win32' ? 'Allow…' : 'Open the port…')]));
}

// ---- news: a toast when the app opens (and when the game closes, for what came in while playing)

function newsLines(g) {
  return g.changes.filter(c => ['add', 'remove', 'version', 'join', 'leave'].includes(c.kind)).map(c => {
    if (c.kind === 'add') return `${c.by} added ${c.name}${c.version ? ` ${c.version}` : ''}`;
    if (c.kind === 'version') return `${c.by} changed ${c.name || 'a mod'} to ${c.version || 'another version'}`;
    if (c.kind === 'remove') return c.modId ? `${c.by} removed ${c.name || 'a mod'}${c.name ? ' (disabled for you if it came in through the group)' : ''}` : `${c.by} removed ${c.name}`;
    if (c.kind === 'join') return `${c.name} joined`;
    return `${c.name} left`;
  });
}

function startupNews() {
  if (state.gameRunning) { gm.waiting = gm.view.groups.map(g => g.id); return; }
  for (const g of gm.view.groups) showNews(g, 'changed while you were away');
}
function showNews(g, what) {
  const lines = newsLines(g);
  const key = `${g.id}:${g.changes[g.changes.length - 1]?.id || ''}`;
  if (!lines.length || gm.toasted[key]) return;
  gm.toasted[key] = true;
  newsToast({ title: `${g.name} ${what}`, lines, action: { label: 'Review', fn: () => { goTo('mods'); setModsMode('groups'); pick(g.id, g.changes.find(c => c.listId)?.listId || g.lists[0]?.id || ''); } }, life: 14000 });
}

api.onGroups(v => {
  gm.view = v;
  if (!v.groups.some(g => g.id === gm.g)) gm.g = v.groups[0]?.id || '';
  paintGroups();
});
api.onGroupsNews(({ g }) => {
  if (state.gameRunning) { if (!gm.waiting.includes(g)) gm.waiting.push(g); return; }
  setTimeout(() => { const grp = gm.view?.groups.find(x => x.id === g); if (grp) showNews(grp, 'changed'); }, 400);
});
api.onGroupsDisabled(({ group, ids, names }) => {
  newsToast({ title: `Disabled: removed from ${group}'s list`, lines: names, kind: 'warn', life: 20000,
    action: { label: names.length === 1 ? 'Turn it back on' : 'Turn them back on', fn: () => run(api.enable(ids), 'Turned back on') } });
});
api.onGroupsGone(info => {
  loadGroups();
  if (info.how === 'remove') newsToast({ title: `You were removed from ${info.name}`, lines: [info.by ? `${info.by} (the host) removed you. Your mods stay as they are.` : 'Your mods stay as they are.'], kind: 'warn' });
});
// The game closed: what came in while playing, now (removals were applied by the app meanwhile).
api.onGameStatus(s => {
  if (s?.running || !gm.waiting.length) return;
  const ids = gm.waiting;
  gm.waiting = [];
  setTimeout(async () => {
    await loadGroups();
    for (const id of ids) { const g = gm.view?.groups.find(x => x.id === id); if (g) showNews(g, 'changed while you were playing'); }
  }, 1500);
});

$$('#mods-mode .seg-btn').forEach(b => b.addEventListener('click', () => setModsMode(b.dataset.mode)));
$('#s-groups-toggle').addEventListener('click', () => (gm.view?.enabled ? turnOff() : openTurnOn()));
snapshotHooks.push(() => { if (gm.mode === 'groups') paintGroups(); });
{
  const before = pageHooks.settings;
  pageHooks.settings = (...a) => { before?.(...a); loadGroups(); paintFirewallSetting(); };
}
paintMode();
loadGroups();
// For checking it by hand (DevTools): the state and a few entry points.
window.groupsPage = { gm, setModsMode, pick, loadGroups };
}
