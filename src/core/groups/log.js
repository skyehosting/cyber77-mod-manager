'use strict';
const crypto = require('crypto');
const { certInfo, sign, verify, FP } = require('./identity');

/*
 * A group is a log of signed events that every member keeps a copy of. Members exchange the events the
 * other is missing whenever two of them connect, so anyone who joins through anyone ends up with the
 * whole history. The group as it is now (members, host, passcode, lists and their mods) is the log
 * folded in order, the same way on every PC.
 *
 * An event: { id, g, by, n, at, t, d, p, sig }
 *   g    the group's id: sha256(creator fingerprint + nonce), so only its creator can have made it
 *   by   the author's certificate fingerprint          t / d   type / data
 *   p    the events it follows (the author's newest ones: up to 8 ids); none for 'create'
 *   n    1 + the largest n among p (checked: nobody can jump ahead or block the counter)
 *   at   wall clock, for people only; never trusted for order
 *   id   sha256 of the canonical JSON of everything above; sig: the author's signature of id
 *
 * Rules (checked while folding; an event that breaks one is ignored on every PC alike):
 *   create        the first event: its author is the first member and the host; the only one counted
 *   join          by a member: admits { fp, cert, name }. Someone removed comes back only if the host
 *                 lets them in.
 *   leave         by the member leaving              remove     by the host: { fp }
 *   passcode      by a member: { code } (made fresh after someone leaves or is removed)
 *   name / addr   by a member about themselves
 *   list-add / list-rename / list-remove, mod-add / mod-remove / mod-version   by a member
 * When someone leaves or is removed, everything they signed that the event removing them does not
 * build on is ignored (so nobody can slip events in "before" their removal, or keep a puppet they let
 * in on the side). The host is the creator; when the host leaves or is removed, the member who joined
 * earliest of those left takes over. Each member counts at most PER_AUTHOR events.
 */

const TYPES = new Set(['create', 'join', 'leave', 'remove', 'passcode', 'name', 'addr', 'list-add', 'list-rename', 'list-remove', 'mod-add', 'mod-remove', 'mod-version']);
const GROUP_ID = /^[0-9a-f]{32}$/;
const LIST_ID = /^[0-9a-f]{16}$/;
const EVENT_ID = /^[0-9a-f]{64}$/;
const MAX_EVENT = 12 * 1024; // a mod entry with 50 requirements, a member's certificate: well under
const MAX_EVENTS = 20000;
const PER_AUTHOR = 1000;
// People a member other than the host may let in, counted together with everyone those people let in in
// turn (no chains of puppets). The host: anyone, up to MAX_MEMBERS.
const JOINS_PER_MEMBER = 4;
const MAX_PARENTS = 8;
const MAX_MEMBERS = 64;
const MAX_LISTS = 32;
const MAX_MODS = 2000;

/** JSON with sorted keys: the same bytes on every PC. Depth is limited (deep nesting is refused). */
function canonical(v, depth = 0) {
  if (depth > 12) throw new Error('too deep');
  if (Array.isArray(v)) return `[${v.map(x => canonical(x, depth + 1)).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k], depth + 1)}`).join(',')}}`;
  return JSON.stringify(v);
}
const eventId = ev => crypto.createHash('sha256').update(canonical({ g: ev.g, by: ev.by, n: ev.n, at: ev.at, t: ev.t, d: ev.d, p: ev.p })).digest('hex');
/** The group id a creator's nonce gives: nobody else can make a create event for it. */
const groupIdFor = (fp, nonce) => crypto.createHash('sha256').update(`cmm-group:${fp}:${nonce}`).digest('hex').slice(0, 32);

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
// Control characters, invisible and right-to-left marks out (no names that hide or reverse text).
const cleanName = (v, max = 40) => { const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim().slice(0, max) : ''; return s || null; };
const posInt = v => (Number.isSafeInteger(v) && v > 0 ? v : null);

/** A mod entry as the list keeps it (anything else in it is dropped). */
function cleanMod(m) {
  if (!m || typeof m !== 'object') return null;
  const modId = posInt(m.modId);
  const fileId = posInt(m.fileId);
  const name = cleanName(m.name, 120);
  if (!modId || !fileId || !name) return null;
  return {
    modId, fileId, name,
    version: cleanName(m.version, 40) || '',
    file: cleanName(m.file, 160) || '',
    category: cleanName(m.category, 60) || '',
    size: Number.isSafeInteger(m.size) && m.size >= 0 ? m.size : 0,
    adult: m.adult === true,
    // Its requirements on Nexus (shown as the mod's dropdown; each member resolves them for themselves).
    reqs: Array.isArray(m.reqs) ? m.reqs.slice(0, 50).map(r => ({ modId: posInt(r?.modId), name: cleanName(r?.name, 120) || '' })).filter(r => r.modId) : [],
  };
}

// The data each type may carry (anything else makes the event malformed: no padding).
const D_KEYS = {
  create: ['name', 'member', 'passcode', 'list', 'nonce'], join: ['member'], leave: [], remove: ['fp'], passcode: ['code'],
  name: ['name'], addr: ['addrs'], 'list-add': ['id', 'name'], 'list-rename': ['id', 'name'], 'list-remove': ['id'],
  'mod-add': ['list', 'mod'], 'mod-remove': ['list', 'modId'], 'mod-version': ['list', 'modId', 'fileId', 'version', 'file', 'size'],
};
const EVENT_KEYS = ['id', 'g', 'by', 'n', 'at', 't', 'd', 'p', 'sig'];

/** Is this the shape of an event (before parents, signature or rules are checked)? */
function wellFormed(ev) {
  try {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
    if (!GROUP_ID.test(String(ev.g)) || !FP.test(String(ev.by)) || !TYPES.has(ev.t)) return false;
    if (!Number.isSafeInteger(ev.n) || ev.n < 1 || ev.n > 10e6 || !Number.isSafeInteger(ev.at) || ev.at < 0) return false;
    if (!ev.d || typeof ev.d !== 'object' || Array.isArray(ev.d)) return false;
    if (!Object.keys(ev.d).every(k => D_KEYS[ev.t].includes(k))) return false;
    if (Object.keys(ev).some(k => !EVENT_KEYS.includes(k))) return false;
    if (!Array.isArray(ev.p) || ev.p.length > MAX_PARENTS || !ev.p.every(x => EVENT_ID.test(String(x)))) return false;
    if (new Set(ev.p).size !== ev.p.length) return false;
    if ((ev.t === 'create') !== (ev.p.length === 0)) return false;
    if (typeof ev.sig !== 'string' || ev.sig.length > 200 || typeof ev.id !== 'string' || !EVENT_ID.test(ev.id)) return false;
    if (Buffer.byteLength(JSON.stringify(ev)) > MAX_EVENT) return false;
    return eventId(ev) === ev.id;
  } catch { return false; } // too deep, or not JSON-able
}

/** A new event, signed by `me` ({ fp, privateKey }), following `parents` (events: { id, n }). */
function makeEvent(me, g, t, d, parents = []) {
  const p = parents.map(x => x.id).slice(0, MAX_PARENTS).sort();
  const n = 1 + parents.reduce((m, x) => Math.max(m, x.n), 0);
  const ev = { g, by: me.fp, n, at: Date.now(), t, d, p };
  ev.id = eventId(ev);
  ev.sig = sign(me.privateKey, ev.id);
  return ev;
}
/** A new group's create event and its id. */
function makeCreate(me, d) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const g = groupIdFor(me.fp, nonce);
  return makeEvent(me, g, 'create', { ...d, nonce }, []);
}

const order = (a, b) => a.n - b.n || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Which events can be folded: well-formed, every parent present and itself foldable, n = 1 + max
 * parent n. Returns { ready: Map id → ev (in order), waiting: Set of ids whose parents are missing }.
 */
function readiness(events, checked = new Set()) {
  const all = new Map();
  for (const ev of events) {
    if (!ev || all.has(ev.id)) continue;
    const k = `${ev.id}:${ev.sig}`;
    if (!checked.has(k)) { if (!wellFormed(ev)) continue; checked.add(k); }
    all.set(ev.id, ev);
  }
  const ready = new Map();
  const waiting = new Set();
  // Parents have smaller n: walking by n, each event's parents were decided before it.
  for (const ev of [...all.values()].sort(order)) {
    const ps = ev.p.map(id => ready.get(id));
    if (ps.some(x => !x)) { if (ev.p.some(id => !all.has(id) || waiting.has(id))) waiting.add(ev.id); continue; }
    if (ev.n !== 1 + ps.reduce((m, x) => Math.max(m, x.n), 0)) continue; // a counter that lies
    ready.set(ev.id, ev);
  }
  return { ready, waiting };
}

/** Every event `id` builds on (its ancestors), and itself. */
function ancestry(id, ready) {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const ev = ready.get(stack.pop());
    for (const p of ev?.p || []) if (!seen.has(p)) { seen.add(p); stack.push(p); }
  }
  return seen;
}

/** One pass of the rules over `list` (in order), skipping `cut`. descends(a, b): does b build on a? */
function apply(list, cut, verified, certs, descends) {
  const st = { id: '', name: '', creator: '', members: new Map(), keys: new Map(), host: '', passcode: '', lists: new Map(), applied: [], appliedSet: new Set(), gone: new Map(), departures: [], n: 0, at: 0, passN: 0, goneN: 0 };
  const count = new Map();
  const joins = new Map();
  const usedCodes = new Set();
  let lastDeparture = '';
  const normCode = c => c.toUpperCase().replace(/[\s-]/g, '');
  const signedBy = ev => {
    const k = `${ev.id}:${ev.sig}`;
    if (verified.has(k)) return true;
    const key = st.keys.get(ev.by);
    if (!key || !verify(key, ev.id, ev.sig)) return false;
    verified.add(k);
    return true;
  };
  const admit = (m, n) => {
    if (!m || !FP.test(String(m.fp)) || typeof m.cert !== 'string' || m.cert.length > 4000) return false;
    let info = certs.get(m.cert);
    if (info === undefined) {
      try { info = certInfo(m.cert); } catch { info = null; }
      certs.set(m.cert, info);
    }
    if (!info || info.fp !== m.fp) return false;
    st.members.set(m.fp, { fp: m.fp, name: cleanName(m.name) || 'Member', cert: m.cert, joined: n, addrs: [], by: '', root: '' });
    st.keys.set(m.fp, info.publicKey);
    return true;
  };
  const nextHost = () => [...st.members.values()].sort((a, b) => a.joined - b.joined || (a.fp < b.fp ? -1 : 1))[0]?.fp || '';
  for (const ev of list) {
    if (cut.has(ev.id)) continue;
    const d = ev.d;
    if (!st.id) {
      // The first event must create the group: its id comes from its author's key, and it is signed by it.
      if (ev.t !== 'create' || d.member?.fp !== ev.by || groupIdFor(ev.by, String(d.nonce || '')) !== ev.g) continue;
      const name = cleanName(d.name, 60);
      const code = str(d.passcode, 64);
      if (!name || !code || !admit(d.member, ev.n)) { st.members.clear(); st.keys.clear(); continue; }
      if (!signedBy(ev)) { st.members.clear(); st.keys.clear(); continue; }
      Object.assign(st, { id: ev.g, name, creator: ev.by, host: ev.by, passcode: code, passN: ev.n, at: ev.at, n: ev.n, renewing: false });
      usedCodes.add(normCode(code));
      if (d.list && LIST_ID.test(String(d.list.id)) && cleanName(d.list.name, 60)) st.lists.set(d.list.id, { id: d.list.id, name: cleanName(d.list.name, 60), mods: new Map() });
      st.applied.push(ev.id);
      st.appliedSet.add(ev.id);
      continue;
    }
    if (ev.t === 'create' || ev.g !== st.id || !st.members.has(ev.by) || !signedBy(ev)) continue;
    const c = (count.get(ev.by) || 0) + 1;
    if (c > PER_AUTHOR && ev.t !== 'leave') continue;
    let ok = false;
    switch (ev.t) {
      case 'join': {
        const fp = d.member?.fp;
        // Someone removed comes back only through the host.
        const banned = st.gone.get(fp)?.how === 'remove' && ev.by !== st.host;
        // Counted at the root: the member the host let in, for everyone let in below them.
        const root = ev.by === st.host ? '' : (st.members.get(ev.by).root || ev.by);
        const many = !!root && (joins.get(root) || 0) >= JOINS_PER_MEMBER;
        ok = !banned && !many && st.members.size < MAX_MEMBERS && !st.members.has(fp) && admit(d.member, ev.n);
        if (ok) {
          st.gone.delete(fp);
          Object.assign(st.members.get(fp), { by: ev.by, root }); // who let them in (the host sees it)
          if (root) joins.set(root, (joins.get(root) || 0) + 1);
        }
        break;
      }
      case 'leave':
      case 'remove': {
        const who = ev.t === 'leave' ? ev.by : d.fp;
        if (ev.t === 'remove' && (ev.by !== st.host || who === ev.by)) break;
        if (!st.members.has(who)) break;
        const m = st.members.get(who);
        st.members.delete(who);
        st.keys.delete(who);
        st.gone.set(who, { fp: who, name: m.name, how: ev.t, at: ev.at, by: ev.by });
        st.departures.push({ fp: who, at: ev.id });
        if (st.host === who) st.host = nextHost();
        st.goneN = ev.n;
        st.renewing = true; // whoever left knew the passcode
        lastDeparture = ev.id;
        ok = true;
        break;
      }
      case 'passcode': {
        // A new passcode counts only if it is new (never used in this group), long enough, and made after
        // the latest departure (it builds on it): an old one can't be brought back on a side branch.
        const code = str(d.code, 64);
        const norm = code ? normCode(code) : '';
        if (norm.length >= 16 && !usedCodes.has(norm) && (!lastDeparture || descends(lastDeparture, ev.id))) {
          st.passcode = code; st.passN = ev.n; st.renewing = false; usedCodes.add(norm); ok = true;
        }
        break;
      }
      case 'name': {
        const name = cleanName(d.name);
        if (name) { st.members.get(ev.by).name = name; ok = true; }
        break;
      }
      case 'addr':
        if (Array.isArray(d.addrs)) {
          st.members.get(ev.by).addrs = d.addrs.slice(0, 8).filter(a => typeof a === 'string' && a.length <= 60 && /^[\d.:[\]a-fA-F]+:\d{1,5}$/.test(a));
          ok = true;
        }
        break;
      case 'list-add':
        if (LIST_ID.test(String(d.id)) && !st.lists.has(d.id) && st.lists.size < MAX_LISTS && cleanName(d.name, 60)) {
          st.lists.set(d.id, { id: d.id, name: cleanName(d.name, 60), mods: new Map() });
          ok = true;
        }
        break;
      case 'list-rename':
        if (st.lists.has(d.id) && cleanName(d.name, 60)) { st.lists.get(d.id).name = cleanName(d.name, 60); ok = true; }
        break;
      case 'list-remove':
        ok = st.lists.delete(d.id);
        break;
      case 'mod-add': {
        const l = st.lists.get(d.list);
        const mod = cleanMod(d.mod);
        if (l && mod && (l.mods.has(mod.modId) || l.mods.size < MAX_MODS)) { l.mods.set(mod.modId, { ...mod, addedBy: ev.by, addedAt: ev.at, changedAt: ev.at }); ok = true; }
        break;
      }
      case 'mod-remove': {
        const l = st.lists.get(d.list);
        ok = !!l && l.mods.delete(Number(d.modId));
        break;
      }
      case 'mod-version': {
        const m = st.lists.get(d.list)?.mods.get(Number(d.modId));
        const fileId = posInt(d.fileId);
        if (m && fileId) { Object.assign(m, { fileId, version: cleanName(d.version, 40) || '', file: cleanName(d.file, 160) || m.file, size: Number.isSafeInteger(d.size) && d.size >= 0 ? d.size : m.size, changedAt: ev.at, changedBy: ev.by }); ok = true; }
        break;
      }
      default:
    }
    if (ok) { st.applied.push(ev.id); st.appliedSet.add(ev.id); count.set(ev.by, c); st.n = Math.max(st.n, ev.n); }
  }
  return st;
}

/**
 * The group as the log says: { id, name, creator, members, host, passcode, lists, applied (ids in
 * order), appliedSet, gone, n, heads, waiting }. members: Map fp → { fp, name, cert, joined, addrs };
 * lists: Map id → { id, name, mods: Map modId → mod with { addedBy, addedAt } }. heads: the newest
 * counted events (what a new event follows). waiting: events whose parents have not arrived yet.
 * `verified` / `certs`: caches kept by the caller between folds.
 */
function fold(events, verified = new Set(), certs = new Map(), checked = new Set()) {
  const { ready, waiting } = readiness(events, checked);
  const list = [...ready.values()];
  const children = new Map();
  for (const ev of list) for (const p of ev.p) { if (!children.has(p)) children.set(p, []); children.get(p).push(ev.id); }
  const following = id => {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) for (const c of children.get(stack.pop()) || []) if (!seen.has(c)) { seen.add(c); stack.push(c); }
    return seen;
  };
  // What follows an event, worked out once per event asked about.
  const followCache = new Map();
  const descends = (a, b) => { if (!followCache.has(a)) followCache.set(a, following(a)); return followCache.get(a).has(b); };
  let cut = new Set();
  let st = apply(list, cut, verified, certs, descends);
  // Whoever left or was removed: only what the departure builds on of theirs counts (and, if they were
  // let back in, what follows that). Again until stable.
  for (let i = 0; i < 4; i++) {
    const next = new Set();
    for (const dep of st.departures) {
      const keep = ancestry(dep.at, ready);
      const from = st.applied.indexOf(dep.at);
      for (const id of st.applied.slice(from + 1)) {
        const ev = ready.get(id);
        if (ev.t === 'join' && ev.d.member?.fp === dep.fp) for (const x of following(id)) keep.add(x);
      }
      for (const ev of list) if (ev.by === dep.fp && !keep.has(ev.id)) next.add(ev.id);
    }
    if (next.size === cut.size && [...next].every(id => cut.has(id))) break;
    cut = next;
    st = apply(list, cut, verified, certs, descends);
  }
  // Heads: counted events nothing counted follows (what my next event builds on), newest first.
  const followed = new Set();
  for (const id of st.applied) for (const p of ready.get(id).p) followed.add(p);
  // More leaves than parents allowed: the oldest and the newest half each, so nobody's events can be
  // pushed out of what the next event builds on by a long chain of someone else's.
  const leaves = st.applied.filter(id => !followed.has(id)).map(id => ready.get(id)).sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1));
  const picked = leaves.length <= MAX_PARENTS ? leaves : [...leaves.slice(0, MAX_PARENTS / 2), ...leaves.slice(-MAX_PARENTS / 2)];
  st.heads = picked.map(ev => ({ id: ev.id, n: ev.n }));
  st.waiting = waiting;
  return st;
}

/** A fresh passcode people can read out: 4 groups of 4 letters and digits (no look-alikes). */
function newPasscode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return [...crypto.randomBytes(16)].map(b => abc[b % abc.length]).join('').match(/.{4}/g).join('-');
}
const newListId = () => crypto.randomBytes(8).toString('hex');

/** Compare passcodes without leaking how much matched (ignoring case, spaces and dashes). */
function samePasscode(a, b) {
  const norm = s => (typeof s === 'string' ? s : '').toUpperCase().replace(/[\s-]/g, '').slice(0, 64);
  const x = crypto.createHash('sha256').update(norm(a)).digest();
  const y = crypto.createHash('sha256').update(norm(b)).digest();
  return norm(a).length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = { cleanName, canonical, eventId, groupIdFor, wellFormed, makeEvent, makeCreate, fold, readiness, order, cleanMod, newPasscode, newListId, samePasscode, GROUP_ID, LIST_ID, EVENT_ID, MAX_EVENTS, MAX_EVENT, PER_AUTHOR };
