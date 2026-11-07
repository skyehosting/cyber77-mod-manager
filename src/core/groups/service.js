'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const nodeNet = require('net');
const { EventEmitter } = require('events');
const { loadIdentity, verify, FP } = require('./identity');
const { makeEvent, makeCreate, fold, wellFormed, newPasscode, newListId, samePasscode, cleanMod, cleanName, GROUP_ID, LIST_ID, MAX_EVENTS } = require('./log');
const net = require('./net');
const { reachableFromOutside } = require('./publicIp');

/*
 * Group Mods: groups of friends who keep a shared mod list. This is the network and bookkeeping side;
 * what a list means for this PC's mods (installed or not, download, disable) is the manager's.
 *
 * Files in <userData>/groups:
 *   identity.json        this PC's key and certificate (identity.js)
 *   <group id>.json      the group's log: { events: [...] } (log.js)
 *   local.json           what is this PC's alone: which changes were reviewed, mods that came in
 *                        through a group, "keep it for me", invites made here, members' last status
 *
 * Nothing here downloads or changes a mod. Changes from others wait to be reviewed.
 */

const DEFAULT_PORT = 47077;
const INVITE_TTL = 24 * 3600e3;
const RECONNECT_EVERY = 60e3;
const JOIN_TRIES = 5; // failed joins per address per 10 minutes
const CHUNK = 400; // events per message
const HAVE_EVERY = 30e3; // a peer's "what do you have" is answered at most this often
const EXTRA_FOR_EXITS = 1000; // room beyond the log limit for leaving, removing, a new passcode
const CODE_PREFIX = 'CMMG1-';
const tokenKey = t => crypto.createHash('sha256').update(`cmm-invite:${t}`).digest('hex');
const NEWS = new Set(['mod-add', 'mod-remove', 'mod-version', 'join', 'leave', 'remove']);
const WAITING_MAX = 200; // events kept while their parents are on their way (in all)
const WAITING_PER_AUTHOR = 50;
const BYTES_PER_MESSAGE = 1024 * 1024;
// Addresses never dialled: unspecified, link-local, multicast, IPv4 inside IPv6, and (unless testing) loopback.
const NOT_DIALLED = new nodeNet.BlockList();
NOT_DIALLED.addSubnet('0.0.0.0', 8, 'ipv4');
NOT_DIALLED.addSubnet('169.254.0.0', 16, 'ipv4');
NOT_DIALLED.addSubnet('224.0.0.0', 3, 'ipv4');
NOT_DIALLED.addSubnet('::', 128, 'ipv6');
NOT_DIALLED.addSubnet('fe80::', 10, 'ipv6');
NOT_DIALLED.addSubnet('ff00::', 8, 'ipv6');
// IPv4 written inside IPv6 (::ffff:127.0.0.1, 64:ff9b::…): checked for IPv6 addresses only (a BlockList
// also matches plain IPv4 against such rules).
const V4_IN_V6 = new nodeNet.BlockList();
V4_IN_V6.addSubnet('::ffff:0:0', 96, 'ipv6');
V4_IN_V6.addSubnet('64:ff9b::', 96, 'ipv6');
V4_IN_V6.addSubnet('::', 96, 'ipv6'); // IPv4-compatible (::a.b.c.d)
V4_IN_V6.addSubnet('::ffff:0:0:0', 96, 'ipv6'); // SIIT
const LOOPBACK = new nodeNet.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addSubnet('::1', 128, 'ipv6');

/** An address worth dialling: an IP literal (no names), a normal port, not multicast or link-local. */
function dialable(addr, { loopback = false } = {}) {
  const m = String(addr).match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
  if (!m) return false;
  const ip = m[1];
  const port = Number(m[2]);
  const family = nodeNet.isIP(ip);
  if (port < 1024 || port > 65535 || !family) return false;
  const fam = family === 4 ? 'ipv4' : 'ipv6';
  try {
    if (NOT_DIALLED.check(ip, fam) || (fam === 'ipv6' && V4_IN_V6.check(ip, fam))) return false;
    if (LOOPBACK.check(ip, fam)) return loopback;
  } catch { return false; }
  return true;
}

function encodeInvite(inv) {
  return CODE_PREFIX + Buffer.from(JSON.stringify({ g: inv.g, n: inv.name, a: inv.addrs, f: inv.fp, t: inv.token, x: inv.exp })).toString('base64url');
}
/** An invite code → { g, name, addrs, fp, token, exp }; throws on anything else. */
function decodeInvite(code, opts = {}) {
  const s = String(code || '').trim().replace(/\s+/g, '');
  if (!s.startsWith(CODE_PREFIX) || s.length > 4000) throw new Error('That is not a group invite code.');
  let d;
  try { d = JSON.parse(Buffer.from(s.slice(CODE_PREFIX.length), 'base64url').toString('utf8')); } catch { throw new Error('That invite code is damaged. Copy it again.'); }
  if (!GROUP_ID.test(String(d?.g)) || !FP.test(String(d?.f)) || !/^[0-9a-f]{32}$/.test(String(d?.t))) throw new Error('That invite code is damaged. Copy it again.');
  const addrs = Array.isArray(d.a) ? d.a.filter(a => typeof a === 'string' && dialable(a, opts)).slice(0, 8) : [];
  if (!addrs.length) throw new Error('That invite code has no address this PC can reach.');
  return { g: d.g, name: typeof d.n === 'string' ? d.n.slice(0, 60) : '', addrs, fp: d.f, token: d.t, exp: Number(d.x) || 0 };
}

/** This PC's addresses others may reach it on: LAN IPv4s (and a VPN's). */
function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out;
}

/**
 * Why a join did not go through, in words a player can act on (the invite maker's PC is "your friend's").
 * reached: some address answered (so the PC is there); err: the last error, if any; addrs: the invite's.
 */
function joinFailure(reached, err, addrs = []) {
  const msg = String(err?.message || '');
  if (reached) {
    return `Your friend's PC answered, but joining did not finish${msg ? ` (${msg.replace(/\.$/, '')})` : ''}. Try again; if it keeps happening, ask them for a new invite.`;
  }
  if (/different/.test(msg)) return msg; // the key check: not the PC the invite was made on
  const code = err?.code || '';
  const why = code === 'ECONNREFUSED' ? 'Their PC is there, but nothing is listening on the group port: the app may be closed, or Group Mods off.'
    : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'There is no route to their PC from this network.'
      : 'Their PC did not answer within 10 seconds.';
  // Only home-network (or VPN) addresses in the invite: from another network nothing can answer, whatever
  // their router and firewall allow. Their app has to know its internet address.
  if (addrs.length && !reachableFromOutside(addrs)) {
    return `Could not reach your friend's PC. ${why} The invite only has home-network addresses of their PC (${addrs.map(a => String(a).replace(/:\d+$/, '')).join(', ')}), which work only on their network or over a VPN you share. If you are somewhere else, they set their internet address in Settings → Group Mods → Internet address ("Find it"), then send you a new invite.`;
  }
  return `Could not reach your friend's PC. ${why} Check that they have the app open with Group Mods on. If you are not on the same home network, their router has to let friends in on the group port (Settings → Group Mods on their PC shows it), and their firewall has to allow the app.`;
}

class GroupService extends EventEmitter {
  /**
   * dir: <userData>/groups. cipher: safeStorage wrapper or null. log: the app log.
   * status(): what this PC tells its group about itself: { game, mods: [[modId, fileId], …] }.
   * addresses(): this PC's IPs to give out. loopback: allow 127.0.0.1 addresses (tests, demos).
   */
  constructor({ dir, cipher = null, log, status = () => ({ game: '', mods: [] }), addresses = localAddresses, loopback = false }) {
    super();
    this.dir = dir;
    this.cipher = cipher;
    this.log = log;
    this.status = status;
    this.addresses = addresses;
    this.loopback = loopback;
    this.me = null;
    this.groups = new Map(); // id → { events: Map, st, verified, certs }
    this.peers = new Map(); // `${g}:${fp}` → Peer
    this.local = { groups: {}, invites: {} };
    this.server = null;
    this.port = DEFAULT_PORT;
    this.external = ''; // the router's internet address, when a port mapping told us
    this.failures = new Map(); // address → [times]
    this.dialing = new Set();
    this.timers = new Map();
    this.stopped = true;
  }

  // ---------------------------------------------------------------- storage

  fileOf(g) {
    if (!GROUP_ID.test(String(g))) throw new Error('Unknown group.');
    return path.join(this.dir, `${g}.json`);
  }

  writeJson(file, data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  /** Has this PC ever used groups (an identity exists)? Reading nothing otherwise. */
  used() { return fs.existsSync(path.join(this.dir, 'identity.json')); }

  /** Read this PC's identity and every group it is in (cheap; no network). */
  load() {
    if (this.me) return;
    this.me = loadIdentity(this.dir, this.cipher);
    try { this.local = { groups: {}, invites: {}, ...JSON.parse(fs.readFileSync(path.join(this.dir, 'local.json'), 'utf8')) }; } catch { /* first time */ }
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => /^[0-9a-f]{32}\.json$/.test(n)); } catch { /* none */ }
    for (const n of names) {
      try {
        const g = n.slice(0, 32);
        const events = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8')).events || [];
        const rec = this.record(g, events);
        if (rec.st.id === g && rec.st.members.has(this.me.fp)) this.groups.set(g, rec);
      } catch (err) { this.log?.warn?.(`A group file could not be read (${n}): ${err.message}`); }
    }
  }

  /** A group record from events: what counts, plus what waits for its parents (by people we know). */
  record(g, events) {
    const rec = { events: new Map(), verified: new Set(), certs: new Map(), checked: new Set(), st: null };
    for (const ev of events) if (ev && ev.g === g && wellFormed(ev)) rec.events.set(ev.id, ev);
    this.refold(rec);
    return rec;
  }

  /** Fold again, and drop events that neither count nor wait for parents (strangers', forged ones). */
  refold(rec) {
    rec.st = fold(rec.events.values(), rec.verified, rec.certs, rec.checked);
    // Waiting for parents: kept only for current members (and people a waiting join lets in), at most
    // 50 each and 200 in all, so nobody can fill the log with events that never come to count.
    const known = new Set(rec.st.members.keys());
    for (const ev of rec.events.values()) if (ev.t === 'join' && rec.st.waiting.has(ev.id) && ev.d?.member?.fp && !rec.st.gone.has(ev.d.member.fp)) known.add(ev.d.member.fp);
    const per = new Map();
    let total = 0;
    for (const [id, ev] of rec.events) {
      if (rec.st.appliedSet.has(id)) continue;
      const k = (per.get(ev.by) || 0) + 1;
      if (ev.t !== 'create' && rec.st.waiting.has(id) && known.has(ev.by) && k <= WAITING_PER_AUTHOR && total < WAITING_MAX) { per.set(ev.by, k); total++; continue; }
      rec.events.delete(id);
    }
  }

  saveLocalNow() { this.writeJson(path.join(this.dir, 'local.json'), this.local); }
  /** Saved a moment later (status messages come often). */
  saveLocal() {
    clearTimeout(this.timers.get('save'));
    const t = setTimeout(() => { this.timers.delete('save'); try { this.saveLocalNow(); } catch { /* quitting */ } }, 500);
    t.unref?.();
    this.timers.set('save', t);
  }
  localOf(g) {
    if (!this.local.groups[g]) this.local.groups[g] = { seen: [], mine: {}, keep: {}, lastSeen: {}, status: {}, toDisable: {} };
    const loc = this.local.groups[g];
    if (!Array.isArray(loc.seen)) loc.seen = [];
    return loc;
  }
  saveGroup(g) {
    const rec = this.groups.get(g);
    if (rec) this.writeJson(this.fileOf(g), { events: [...rec.events.values()] });
  }

  /** Is this PC in the group? (Every action checks.) */
  has(g) { return this.groups.has(String(g)); }
  need(g) {
    const rec = this.groups.get(String(g));
    if (!rec) throw new Error('You are not in that group.');
    return rec;
  }

  // ---------------------------------------------------------------- the log

  /** Add events (ours or a peer's); the group is folded again and saved. Returns the events that count now. */
  ingest(g, events, from = null) {
    const rec = this.groups.get(g);
    if (!rec || !Array.isArray(events)) return [];
    const fresh = [];
    for (const ev of events.slice(0, CHUNK * 2)) {
      if (!ev || typeof ev !== 'object' || ev.g !== g) continue;
      const had = rec.events.get(ev.id);
      // Already here: skip, unless that copy is still waiting and this one is signed differently (a
      // forged copy must not keep the real one out).
      if (had && (had.sig === ev.sig || rec.st.appliedSet.has(ev.id))) continue;
      // A member's event is checked against their key before it is kept (or replaces a waiting copy).
      const key = rec.st.keys.get(ev.by);
      if (key && (typeof ev.sig !== 'string' || !verify(key, String(ev.id), ev.sig))) continue;
      // The room kept beyond the limit is for the host's removals and new passcode, and for leaving.
      const exit = ev.t === 'leave' || (ev.by === rec.st.host && (ev.t === 'remove' || ev.t === 'passcode'));
      if (rec.events.size >= MAX_EVENTS + (exit ? EXTRA_FOR_EXITS : 0)) continue;
      if (!wellFormed(ev)) continue;
      rec.events.set(ev.id, ev);
      fresh.push(ev);
    }
    if (!fresh.length) return [];
    const before = rec.st;
    this.refold(rec);
    // News: events that count now and did not before (a fresh one, or one whose parents just came).
    const now = rec.st.applied.filter(id => !before.appliedSet.has(id)).map(id => rec.events.get(id));
    const pass = fresh.filter(ev => rec.events.has(ev.id));
    if (!pass.length) return [];
    this.saveGroup(g);
    for (const p of this.peersOf(g)) if (p !== from) this.sendEvents(p, g, pass);
    // Someone just removed: they get the removal itself (so their app knows), and nothing else.
    for (const [k, p] of this.peers) {
      if (!k.startsWith(`${g}:`) || rec.st.members.has(p.fp) || !before.members.has(p.fp)) continue;
      const theirs = pass.filter(ev => ev.t === 'remove' && ev.d?.fp === p.fp);
      if (theirs.length) this.sendEvents(p, g, theirs);
    }
    this.afterChange(g, before);
    if (now.length) this.emit('changed', { g, events: now, mine: now.every(ev => ev.by === this.me.fp) });
    return now;
  }

  append(g, t, d) {
    const rec = this.need(g);
    const ev = makeEvent(this.me, g, t, d, rec.st.heads);
    const counted = this.ingest(g, [ev]);
    if (!counted.some(x => x.id === ev.id)) throw new Error('That change was not accepted.');
    return ev;
  }

  /** Events in pieces of at most CHUNK events and about 1 MB. `last` marks the final piece (for a joiner). */
  sendEvents(peer, g, events, { last = false } = {}) {
    let part = [];
    let bytes = 0;
    const flush = end => { peer.send({ t: 'events', g, events: part, ...(last && end ? { last: true } : {}) }); part = []; bytes = 0; };
    for (const ev of events) {
      const n = Buffer.byteLength(JSON.stringify(ev));
      if (part.length && (part.length >= CHUNK || bytes + n > BYTES_PER_MESSAGE)) flush(false);
      part.push(ev);
      bytes += n;
    }
    if (part.length || last) flush(true);
  }

  /** After the group changed: was I removed? Does the passcode need renewing? */
  afterChange(g, before) {
    const rec = this.groups.get(g);
    if (!rec) return; // already gone (left, and the news came back meanwhile)
    const st = rec.st;
    if (!st.members.has(this.me.fp)) {
      const how = st.gone.get(this.me.fp);
      for (const p of this.peersOf(g)) p.end('left');
      this.forget(g);
      this.emit('gone', { g, name: st.name, how: how?.how || 'leave', by: st.members.get(how?.by)?.name || before?.members?.get(how?.by)?.name || '' });
      return;
    }
    // Connections to anyone no longer a member end here (on every member's PC, not only the host's).
    for (const [k, p] of this.peers) if (k.startsWith(`${g}:`) && !st.members.has(p.fp)) { this.peers.delete(k); p.end('removed'); }
    // Someone left or was removed since the passcode last changed: a new one (any member may make it;
    // if two do at once, the later one wins everywhere). A short random wait avoids most doubles.
    const key = `pass:${g}`;
    if (st.renewing && !this.timers.has(key)) {
      const t = setTimeout(() => {
        this.timers.delete(key);
        const now = this.groups.get(g)?.st;
        if (now?.renewing) { try { this.append(g, 'passcode', { code: newPasscode() }); } catch { /* next time */ } }
      }, 500 + crypto.randomInt(4000));
      t.unref?.();
      this.timers.set(key, t);
    }
    if (before && before.host !== st.host && st.host === this.me.fp) this.log?.info?.(`You are now the host of "${st.name}"`);
  }

  forget(g) {
    this.groups.delete(g);
    try { fs.rmSync(this.fileOf(g)); } catch { /* gone */ }
    delete this.local.groups[g];
    for (const [k, v] of Object.entries(this.local.invites)) if (v.g === g) delete this.local.invites[k];
    this.saveLocalNow();
  }

  // ---------------------------------------------------------------- actions (each one is an event)

  create({ name, myName, listName }) {
    this.load();
    const list = { id: newListId(), name: String(listName || 'Co-op night').slice(0, 60) };
    const ev = makeCreate(this.me, { name: String(name || '').slice(0, 60), member: { fp: this.me.fp, cert: this.me.cert, name: String(myName || 'Me').slice(0, 40) }, passcode: newPasscode(), list });
    const rec = this.record(ev.g, [ev]);
    if (rec.st.id !== ev.g) throw new Error('Give the group and your name in it.');
    this.groups.set(ev.g, rec);
    this.localOf(ev.g);
    this.saveGroup(ev.g);
    this.saveLocalNow();
    this.announce(ev.g);
    this.emit('changed', { g: ev.g, events: [ev], mine: true });
    return { g: ev.g, list: list.id };
  }

  /** An invite: a code (where to connect, whom to trust, a one-time token) and the group's passcode. */
  invite(g) {
    const rec = this.need(g);
    if (!this.server) throw new Error('Turn on groups in Settings first: friends connect to this PC to join.');
    if (rec.st.renewing) throw new Error('The group is making a new passcode. Try again in a few seconds.');
    const addrs = this.myAddrs();
    if (!addrs.length) throw new Error('This PC has no network address friends could reach.');
    const token = crypto.randomBytes(16).toString('hex');
    const exp = Date.now() + INVITE_TTL;
    for (const [k, v] of Object.entries(this.local.invites)) if (v.exp < Date.now() || v.used) delete this.local.invites[k];
    this.local.invites[tokenKey(token)] = { g, exp, used: false }; // only its hash is kept
    this.saveLocalNow();
    // outside: false when friends on another network could reach none of these (no internet address known).
    return { code: encodeInvite({ g, name: rec.st.name, addrs, fp: this.me.fp, token, exp }), passcode: rec.st.passcode, expires: exp, addrs, outside: reachableFromOutside(addrs) };
  }

  revokeInvites(g) {
    this.need(g);
    for (const [k, v] of Object.entries(this.local.invites)) if (v.g === g) delete this.local.invites[k];
    this.saveLocalNow();
  }

  /** Join with a friend's invite code and the passcode they told you. Resolves with the group id. */
  async join(code, passcode, myName) {
    this.load();
    const inv = decodeInvite(code, { loopback: this.loopback });
    if (this.groups.has(inv.g)) throw new Error(`You are already in "${this.groups.get(inv.g).st.name}".`);
    if (inv.exp && inv.exp < Date.now()) throw new Error('That invite has expired. Ask for a new one.');
    let lastErr = null;
    let reached = false; // some address answered: the PC is there, the join itself went wrong
    for (const addr of inv.addrs) {
      let peer;
      try { peer = await net.connect(this.me, addr, inv.fp); } catch (err) { if (!reached) lastErr = err; continue; }
      reached = true;
      try {
        // The log comes after the welcome, in pieces: gathered until the last one.
        const rec = this.record(inv.g, []);
        const got = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { off(); reject(new Error('The group\'s history did not arrive.')); }, 60e3);
          const onMsg = msg => {
            if (msg.t !== 'events' || msg.g !== inv.g || !Array.isArray(msg.events)) return;
            for (const ev of msg.events.slice(0, CHUNK * 2)) if (ev && ev.g === inv.g && rec.events.size < MAX_EVENTS + EXTRA_FOR_EXITS && wellFormed(ev)) rec.events.set(ev.id, ev);
            if (msg.last) { this.refold(rec); off(); resolve(); }
          };
          const onClose = () => { off(); reject(new Error('The connection closed.')); };
          const off = () => { clearTimeout(timer); peer.removeListener('message', onMsg); peer.removeListener('close', onClose); };
          peer.on('message', onMsg);
          peer.on('close', onClose);
        });
        got.catch(() => {}); // handled below (the welcome can fail first)
        peer.send({ t: 'join', g: inv.g, token: inv.token, passcode: String(passcode || '').slice(0, 64), name: String(myName || 'Member').slice(0, 40) });
        await net.expect(peer, 'welcome', 20e3);
        peer.resume();
        await got;
        if (rec.st.id !== inv.g || !rec.st.members.has(this.me.fp)) throw new Error('The group did not take you in. Ask for a new invite.');
        this.groups.set(inv.g, rec);
        try {
          // Everything that was there before you joined is history, not news.
          this.localOf(inv.g).seen = rec.st.applied.filter(id => NEWS.has(rec.events.get(id)?.t));
          this.saveGroup(inv.g);
          this.saveLocalNow();
        } catch (err) { this.groups.delete(inv.g); throw err; }
        this.attach(peer, inv.g);
        this.announce(inv.g);
        this.emit('changed', { g: inv.g, events: [], mine: true });
        return inv.g;
      } catch (err) {
        peer.close('join failed');
        if (err.refused) throw err;
        lastErr = err;
      }
    }
    throw new Error(joinFailure(reached, lastErr, inv.addrs));
  }

  /**
   * Leave a group. Someone in it must hear it, or they would keep listing you (and, if you are the
   * host, nobody could remove anyone): with nobody connected this refuses, unless `force`.
   */
  leave(g, { force = false } = {}) {
    const rec = this.need(g);
    const peers = this.peersOf(g);
    const others = [...rec.st.members.keys()].filter(fp => fp !== this.me.fp);
    if (others.length && !peers.length && !force) throw Object.assign(new Error('Nobody else in the group is connected, so they would not hear that you left.'), { offline: true });
    const ev = makeEvent(this.me, g, 'leave', {}, rec.st.heads);
    rec.events.set(ev.id, ev);
    this.saveGroup(g);
    for (const p of peers) this.sendEvents(p, g, [ev]);
    const before = rec.st;
    this.refold(rec);
    // Give it a moment to go out, then the group is forgotten here.
    setTimeout(() => this.afterChange(g, before), 800).unref?.();
  }

  removeMember(g, fp) {
    const { st } = this.need(g);
    if (st.host !== this.me.fp) throw new Error('Only the host can remove members.');
    if (!st.members.has(String(fp))) throw new Error('Not a member.');
    this.append(g, 'remove', { fp: String(fp) });
    // They are told (the event went to every peer), then their connection ends.
    for (const [k, p] of this.peers) if (k === `${g}:${fp}`) p.end('removed');
  }

  rename(g, myName) { this.append(g, 'name', { name: String(myName || '').slice(0, 40) }); }
  addList(g, name) { const id = newListId(); this.append(g, 'list-add', { id, name: String(name || '').slice(0, 60) }); return id; }
  renameList(g, id, name) { this.append(g, 'list-rename', { id, name: String(name || '').slice(0, 60) }); }
  removeList(g, id) { this.append(g, 'list-remove', { id }); }

  /** Add mods to a list (entries as log.cleanMod takes them). Returns how many were added. */
  addMods(g, list, mods) {
    if (!LIST_ID.test(String(list))) throw new Error('Unknown list.');
    let n = 0;
    for (const m of (Array.isArray(mods) ? mods : []).slice(0, 200)) {
      const mod = cleanMod(m);
      if (!mod) continue;
      this.append(g, 'mod-add', { list, mod });
      n++;
    }
    return n;
  }
  removeMod(g, list, modId) { this.append(g, 'mod-remove', { list, modId: Number(modId) }); }
  setVersion(g, list, modId, file) { this.append(g, 'mod-version', { list, modId: Number(modId), fileId: Number(file.fileId), version: String(file.version || ''), file: String(file.file || ''), size: Number(file.size) || 0 }); }

  /** Reviewed: everything up to now in this group is no longer news. */
  markSeen(g) {
    const rec = this.need(g);
    this.localOf(g).seen = rec.st.applied.filter(id => NEWS.has(rec.events.get(id)?.t)).slice(-MAX_EVENTS);
    this.saveLocalNow();
    this.emit('changed', { g, events: [], mine: true });
  }
  /** These Nexus files are being downloaded because of this group (a later removal may disable them). */
  markRequested(g, fileIds) {
    this.need(g);
    const loc = this.localOf(g);
    for (const f of fileIds) loc.mine[String(f)] = Date.now();
    this.saveLocalNow();
  }
  setKeep(g, modId, on) {
    this.need(g);
    const loc = this.localOf(g);
    if (on) loc.keep[String(modId)] = true; else delete loc.keep[String(modId)];
    this.saveLocalNow();
  }

  // ---------------------------------------------------------------- the network

  myAddrs() {
    const out = this.addresses().map(a => `${a}:${this.port}`);
    if (this.external && !out.some(a => a.startsWith(`${this.external}:`))) out.unshift(`${this.external}:${this.port}`);
    return out.filter(a => dialable(a, { loopback: this.loopback })).slice(0, 8);
  }

  /** Tell the group where this PC can be reached, when that changed. */
  announce(g) {
    const st = this.groups.get(g)?.st;
    if (!st || !this.server) return;
    const addrs = this.myAddrs();
    const now = st.members.get(this.me.fp)?.addrs || [];
    if (addrs.join() !== now.join()) { try { this.append(g, 'addr', { addrs }); } catch { /* next time */ } }
  }
  announceAll() { for (const g of this.groups.keys()) this.announce(g); }

  /** Open connections to this group's current members (nobody else is sent anything). */
  peersOf(g) {
    const st = this.groups.get(g)?.st;
    return [...this.peers].filter(([k, p]) => k.startsWith(`${g}:`) && st?.members.has(p.fp)).map(([, p]) => p);
  }

  /** Start listening and connecting (groups on). */
  async start({ port = DEFAULT_PORT, host = '0.0.0.0' } = {}) {
    this.load();
    if (this.server) return;
    this.port = port;
    this.stopped = false;
    this.server = await net.listen(this.me, port, host, peer => this.onInbound(peer));
    this.announceAll();
    this.connectAll();
    // Friends' apps that start at the same moment miss each other once: try again soon, then every minute.
    for (const [i, ms] of [3e3, 10e3, 25e3].entries()) { const s = setTimeout(() => this.connectAll(), ms); s.unref?.(); this.timers.set(`soon:${i}`, s); }
    let tick = 0;
    const t = setInterval(() => {
      this.connectAll();
      this.announceAll();
      this.pruneFailures();
      // Every 10 minutes: what each member has, so anything missed (a dropped message) comes back.
      if (++tick % 10 === 0) for (const g of this.groups.keys()) for (const p of this.peersOf(g)) p.send({ t: 'have', g, ids: [...this.groups.get(g).events.keys()] });
    }, RECONNECT_EVERY);
    t.unref?.();
    this.timers.set('reconnect', t);
    this.emit('changed', { g: '', events: [], mine: true });
  }

  pruneFailures() {
    for (const [ip, list] of this.failures) {
      const recent = list.filter(t => t > Date.now() - 600e3);
      if (recent.length) this.failures.set(ip, recent); else this.failures.delete(ip);
    }
  }

  async stop() {
    this.stopped = true;
    for (const [k, t] of this.timers) { if (k === 'save') continue; clearTimeout(t); clearInterval(t); this.timers.delete(k); }
    for (const p of this.peers.values()) p.close('stopped');
    this.peers.clear();
    if (this.server) {
      const s = this.server;
      this.server = null;
      await Promise.race([new Promise(r => s.close(() => r())), new Promise(r => setTimeout(r, 3000))]);
    }
  }

  setExternal(ip) {
    const v = nodeNet.isIPv4(String(ip || '')) ? String(ip) : '';
    if (this.external === v) return;
    this.external = v;
    this.announceAll();
  }

  /** A friend's app connected: a member saying hello, or someone joining with an invite. */
  onInbound(peer) {
    peer.once('message', msg => {
      const g = typeof msg.g === 'string' ? msg.g : '';
      const rec = this.groups.get(g);
      if (msg.t === 'hello') {
        if (!rec || !rec.st.members.has(peer.fp) || peer.fp === this.me.fp) { peer.send({ t: 'refused', why: 'Not a member of this group.' }); peer.end('not a member'); return; }
        net.admit(peer);
        peer.send({ t: 'welcome', g });
        this.attach(peer, g);
        return;
      }
      if (msg.t === 'join') { this.onJoin(peer, msg, g, rec); return; }
      peer.close('unexpected');
    });
  }

  onJoin(peer, msg, g, rec) {
    const refuse = why => { peer.send({ t: 'refused', why }); peer.end('refused'); };
    const ip = peer.remote;
    const recent = (this.failures.get(ip) || []).filter(t => t > Date.now() - 600e3);
    if (recent.length >= JOIN_TRIES) { refuse('Too many tries. Wait ten minutes.'); return; }
    const fail = why => { recent.push(Date.now()); this.failures.set(ip, recent); refuse(why); };
    const token = typeof msg.token === 'string' ? msg.token : '';
    const inv = /^[0-9a-f]{32}$/.test(token) && Object.hasOwn(this.local.invites, tokenKey(token)) ? this.local.invites[tokenKey(token)] : null;
    if (!rec || !inv || inv.g !== g || inv.used || inv.exp < Date.now()) { fail('That invite is not valid any more. Ask for a new one.'); return; }
    if (rec.st.renewing) { refuse('The group is making a new passcode. Try again in a minute.'); return; }
    if (!samePasscode(typeof msg.passcode === 'string' ? msg.passcode : '', rec.st.passcode)) { fail('Wrong passcode.'); return; }
    if (rec.st.members.has(peer.fp)) { refuse('This PC is already in the group.'); return; }
    if (rec.st.gone.get(peer.fp)?.how === 'remove' && rec.st.host !== this.me.fp) { refuse('You were removed from this group. Only its host can let you back in.'); return; }
    const name = typeof msg.name === 'string' ? msg.name.slice(0, 40) : 'Member';
    try {
      this.append(g, 'join', { member: { fp: peer.fp, cert: peer.cert, name } });
    } catch (err) { refuse(err.message); return; }
    inv.used = true;
    this.saveLocalNow();
    net.admit(peer);
    peer.send({ t: 'welcome', g });
    // The whole history, in pieces; the joiner counts itself in once the last one arrives.
    this.sendEvents(peer, g, [...this.groups.get(g).events.values()], { last: true });
    this.attach(peer, g, { sentAll: true });
    this.log?.success?.(`${name || 'Someone'} joined "${rec.st.name}"`);
  }

  /** An admitted connection: swap what each side is missing, then pass on news both ways. */
  attach(peer, g, { sentAll = false } = {}) {
    const key = `${g}:${peer.fp}`;
    const old = this.peers.get(key);
    if (old && old !== peer && !old.closed) {
      // Both apps dialled each other at once: keep the connection the lower fingerprint started, on
      // both sides alike (replacing blindly closes both).
      const starter = p => (p.inbound ? p.fp : this.me.fp);
      const lower = this.me.fp < peer.fp ? this.me.fp : peer.fp;
      if (starter(old) === lower && starter(peer) !== lower) { peer.close('duplicate'); return; }
      old.removeAllListeners('close');
      old.close('replaced');
    }
    this.peers.set(key, peer);
    let lastHave = 0;
    peer.on('message', msg => {
      if (msg.g !== g || !this.groups.get(g)?.st.members.has(peer.fp)) return;
      if (msg.t === 'have' && Array.isArray(msg.ids)) {
        // Answered at most every 30 s per connection (a peer asking over and over gets nothing more).
        if (Date.now() - lastHave < HAVE_EVERY) return;
        lastHave = Date.now();
        const theirs = new Set(msg.ids.slice(0, MAX_EVENTS + EXTRA_FOR_EXITS).filter(x => typeof x === 'string'));
        const missing = [...this.groups.get(g).events.values()].filter(ev => !theirs.has(ev.id));
        this.sendEvents(peer, g, missing);
      } else if (msg.t === 'events') {
        this.ingest(g, msg.events, peer);
      } else if (msg.t === 'status') {
        const loc = this.localOf(g);
        const mods = Array.isArray(msg.mods) ? msg.mods.slice(0, 5000).filter(x => Array.isArray(x) && Number.isSafeInteger(x[0]) && Number.isSafeInteger(x[1])) : [];
        loc.status[peer.fp] = { game: typeof msg.game === 'string' ? msg.game.slice(0, 20) : '', mods, at: Date.now() };
        loc.lastSeen[peer.fp] = Date.now();
        this.saveLocal();
        this.emit('changed', { g, events: [], mine: true });
      }
    });
    peer.on('close', () => {
      if (this.peers.get(key) === peer) this.peers.delete(key);
      if (this.groups.has(g)) { this.localOf(g).lastSeen[peer.fp] = Date.now(); this.saveLocal(); }
      this.emit('changed', { g, events: [], mine: true });
    });
    if (!sentAll) peer.send({ t: 'have', g, ids: [...this.groups.get(g).events.keys()] });
    this.sendStatus(g, peer);
    this.emit('changed', { g, events: [], mine: true });
  }

  /** Tell members what this PC has of the group's mods (only those: never the rest of its mods). */
  sendStatus(g, only = null) {
    const st = this.groups.get(g)?.st;
    if (!st) return;
    const listed = new Set([...st.lists.values()].flatMap(l => [...l.mods.keys()]));
    const s = this.status() || {};
    const mods = (s.mods || []).filter(([modId]) => listed.has(modId));
    for (const p of only ? [only] : this.peersOf(g)) p.send({ t: 'status', g, game: s.game || '', mods });
  }
  sendStatusAll() { for (const g of this.groups.keys()) this.sendStatus(g); }

  /** Connect to every member not connected yet (each at the addresses they gave). */
  connectAll() {
    if (!this.server || this.stopped) return;
    for (const [g, rec] of this.groups) {
      for (const m of rec.st.members.values()) {
        if (m.fp === this.me.fp || this.peers.has(`${g}:${m.fp}`) || this.dialing.has(`${g}:${m.fp}`)) continue;
        this.dial(g, m);
      }
    }
  }

  async dial(g, m) {
    const key = `${g}:${m.fp}`;
    this.dialing.add(key);
    try {
      for (const addr of (m.addrs || []).filter(a => dialable(a, { loopback: this.loopback }))) {
        if (this.peers.has(key) || this.stopped) return;
        let peer;
        try { peer = await net.connect(this.me, addr, m.fp, { timeout: 6e3 }); } catch { continue; }
        if (this.stopped) { peer.close('stopped'); return; }
        try {
          peer.send({ t: 'hello', g });
          await net.expect(peer, 'welcome', 10e3);
          this.attach(peer, g);
          peer.resume();
          return;
        } catch { peer.close('no welcome'); }
      }
    } finally {
      this.dialing.delete(key);
    }
  }

  // ---------------------------------------------------------------- what the page shows

  view() {
    const groups = [];
    for (const [g, rec] of this.groups) {
      const st = rec.st;
      const loc = this.localOf(g);
      const seen = new Set(loc.seen);
      const online = new Set(this.peersOf(g).map(p => p.fp));
      const members = [...st.members.values()].sort((a, b) => a.joined - b.joined).map(m => ({
        fp: m.fp, name: m.name, host: m.fp === st.host, me: m.fp === this.me.fp,
        online: m.fp === this.me.fp || online.has(m.fp), lastSeen: loc.lastSeen[m.fp] || 0,
        game: loc.status[m.fp]?.game || '', mods: loc.status[m.fp]?.mods || null,
        invitedBy: m.by ? (st.members.get(m.by)?.name || st.gone.get(m.by)?.name || '') : '', invitedByFp: m.by || '',
      }));
      const nameOf = fp => st.members.get(fp)?.name || st.gone.get(fp)?.name || 'Someone';
      const lists = [...st.lists.values()].map(l => ({ id: l.id, name: l.name, mods: [...l.mods.values()].map(m => ({ ...m, addedByName: nameOf(m.addedBy), changedByName: m.changedBy ? nameOf(m.changedBy) : '', keep: !!loc.keep[String(m.modId)] })) }));
      // News: what others did that this PC has not reviewed yet (by event, not by order: nothing can be
      // slipped in as old). A removed mod is named from when it was added.
      const modNames = new Map();
      for (const id of st.applied) { const ev = rec.events.get(id); const m = ev?.t === 'mod-add' ? cleanMod(ev.d.mod) : null; if (m) modNames.set(m.modId, m.name); }
      const changes = [];
      for (const id of st.applied) {
        const ev = rec.events.get(id);
        if (!ev || seen.has(id) || ev.by === this.me.fp || !NEWS.has(ev.t)) continue;
        const list = st.lists.get(ev.d.list)?.name || '';
        const mod = ev.t === 'mod-add' ? cleanMod(ev.d.mod) : null;
        if (ev.t === 'mod-add') changes.push({ id, kind: 'add', by: nameOf(ev.by), at: ev.at, list, listId: ev.d.list, modId: mod?.modId, name: mod?.name || '', version: mod?.version || '' });
        else if (ev.t === 'mod-remove') changes.push({ id, kind: 'remove', by: nameOf(ev.by), at: ev.at, list, listId: ev.d.list, modId: Number(ev.d.modId), name: modNames.get(Number(ev.d.modId)) || '' });
        else if (ev.t === 'mod-version') changes.push({ id, kind: 'version', by: nameOf(ev.by), at: ev.at, list, listId: ev.d.list, modId: Number(ev.d.modId), version: cleanName(ev.d.version) || '', name: modNames.get(Number(ev.d.modId)) || '' });
        else if (ev.t === 'join') changes.push({ id, kind: 'join', by: nameOf(ev.by), at: ev.at, name: cleanName(ev.d.member?.name) || 'Someone' });
        else changes.push({ id, kind: ev.t, by: nameOf(ev.by), at: ev.at, name: nameOf(ev.t === 'leave' ? ev.by : ev.d.fp) });
      }
      groups.push({
        id: g, name: st.name, host: st.host, iAmHost: st.host === this.me.fp, passcode: st.passcode, renewing: !!st.renewing,
        members, lists, changes, gone: [...st.gone.values()].map(x => ({ name: x.name, how: x.how, at: x.at })),
      });
    }
    return { on: !!this.server, port: this.port, fp: this.me?.fp || '', addrs: this.server ? this.myAddrs() : [], groups };
  }
}

module.exports = { GroupService, encodeInvite, decodeInvite, joinFailure, localAddresses, dialable, DEFAULT_PORT };
