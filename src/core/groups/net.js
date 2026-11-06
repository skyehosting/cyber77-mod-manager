'use strict';
const tls = require('tls');
const { EventEmitter } = require('events');
const { normFp } = require('./identity');

/*
 * Group connections: TLS 1.3 with this PC's own certificate on both sides. Neither side trusts a
 * certificate authority; each checks the other's certificate fingerprint itself:
 *   - the connecting side checks the server is the member (or invite host) it meant to reach, before
 *     sending anything;
 *   - the listening side admits a known member by fingerprint, or a joiner who brings a valid invite
 *     and the group's passcode. Nothing is sent before that check passes.
 * Messages are JSON, each framed by a 4-byte length. Before a peer is admitted a frame may be 16 KB;
 * after, 8 MB. Limits for everyone: a handshake within 10 s, a first message within 10 s, at most 8
 * unadmitted connections per address and 128 in all, at most 300 messages per 10 s, and a peer that
 * does not read what it is sent (32 MB waiting) is dropped. A ping every 40 s keeps a quiet
 * connection open.
 */

const PRE_AUTH_MAX = 16 * 1024;
const FRAME_MAX = 8 * 1024 * 1024;
const HELLO_TIMEOUT = 10e3;
const IDLE_TIMEOUT = 120e3;
const PING_EVERY = 40e3;
const BURST = { frames: 300, per: 10e3 };
const SEND_BACKLOG = 32 * 1024 * 1024;
const PER_IP_UNADMITTED = 8;
const MAX_CONNECTIONS = 512;
const PER_IP_OPEN = 16; // raw connections per address, before any handshake

/** The address a limit counts: IPv4 as is, IPv6 by its /64 (one home network), unknown as one bucket. */
function ipKey(ip) {
  const s = String(ip || '').replace(/^::ffff:(?=\d+\.)/i, '');
  if (!s) return '?';
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const full = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `${full.slice(0, 4).map(x => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** A framed, JSON message connection over a TLS socket. Emits 'message' (obj), 'close'. */
class Peer extends EventEmitter {
  constructor(socket, { fp, inbound }) {
    super();
    this.socket = socket;
    this.fp = fp; // the other side's certificate fingerprint
    this.inbound = inbound;
    // A server we dialled is checked (pinned) before this object exists: it is admitted from the start.
    this.admitted = !inbound;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.held = null; // a message type to stop after (see holdAfter)
    this.window = { at: Date.now(), n: 0 };
    this.remote = ipKey(socket.remoteAddress);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30e3);
    socket.setTimeout(IDLE_TIMEOUT, () => this.close('idle'));
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.close('closed'));
    socket.on('error', () => this.close('error'));
    this.ping = setInterval(() => { if (this.admitted) this.send({ t: 'ping' }); }, PING_EVERY);
    this.ping.unref?.();
  }

  onData(d) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    this.drain();
  }

  /** Read whole frames from the buffer (stopping after a held-for message until resume()). */
  drain() {
    while (!this.closed && !this.held?.done && this.buf.length >= 4) {
      const max = this.admitted ? FRAME_MAX : PRE_AUTH_MAX;
      const n = this.buf.readUInt32BE(0);
      if (n > max) { this.close('too big'); return; }
      if (this.buf.length < 4 + n) return;
      const body = this.buf.subarray(4, 4 + n);
      this.buf = this.buf.subarray(4 + n);
      const now = Date.now();
      if (now - this.window.at > BURST.per) this.window = { at: now, n: 0 };
      if (++this.window.n > BURST.frames) { this.close('too fast'); return; }
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { this.close('bad message'); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') { this.close('bad message'); return; }
      if (msg.t === 'ping') continue;
      if (this.held && msg.t === this.held.t) this.held.done = true;
      try { this.emit('message', msg); } catch { this.close('bad message'); return; }
    }
  }

  /** Stop reading after the next message of type `t` (so nothing behind it is lost before listeners are set). */
  holdAfter(t) { this.held = { t, done: false }; }
  resume() { this.held = null; setImmediate(() => this.drain()); }

  send(msg) {
    if (this.closed) return false;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    if (body.length > FRAME_MAX) return false;
    // A peer that does not read: drop it rather than hold its backlog in memory.
    if (this.socket.writableLength > SEND_BACKLOG) { this.close('too slow'); return false; }
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([head, body]));
    return true;
  }

  /** Close after what was sent has gone out (a last message must reach the other side). */
  end(why = '') {
    if (this.closed) return;
    try { this.socket.end(); } catch { /* gone */ }
    setTimeout(() => this.close(why), 1500).unref?.();
  }

  close(why = '') {
    if (this.closed) return;
    this.closed = true;
    this.why = why;
    clearInterval(this.ping);
    try { this.socket.destroy(); } catch { /* gone */ }
    this.emit('close', why);
  }
}

const tlsOpts = me => ({ key: me.keyPem, cert: me.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });

/**
 * Listen for group connections. onPeer(peer) decides: it must admit (peer.admitted = true) or close
 * the peer on its first message, within the hello timeout. Returns the tls.Server (started).
 */
function listen(me, port, host, onPeer) {
  const unadmitted = new Map(); // address → open connections not admitted yet
  const server = tls.createServer({ ...tlsOpts(me), requestCert: true, rejectUnauthorized: false, handshakeTimeout: 10e3 }, socket => {
    const cert = socket.getPeerCertificate();
    const fp = normFp(cert?.fingerprint256);
    if (!fp || !cert.raw) { socket.destroy(); return; } // no certificate (a resumed session or a stranger)
    const ip = ipKey(socket.remoteAddress);
    if ((unadmitted.get(ip) || 0) >= PER_IP_UNADMITTED) { socket.destroy(); return; }
    unadmitted.set(ip, (unadmitted.get(ip) || 0) + 1);
    let counted = true;
    const uncount = () => { if (!counted) return; counted = false; const n = (unadmitted.get(ip) || 1) - 1; if (n > 0) unadmitted.set(ip, n); else unadmitted.delete(ip); };
    const peer = new Peer(socket, { fp, inbound: true });
    peer.cert = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
    const timer = setTimeout(() => { if (!peer.admitted) peer.close('no hello'); }, HELLO_TIMEOUT);
    timer.unref?.();
    peer.on('close', () => { clearTimeout(timer); uncount(); });
    peer.once('admitted', uncount);
    try { onPeer(peer); } catch { peer.close('error'); }
  });
  server.maxConnections = MAX_CONNECTIONS;
  // Counted per address as soon as a connection opens (before TLS), so one address can't take every slot.
  const open = new Map();
  server.on('connection', socket => {
    const ip = ipKey(socket.remoteAddress);
    const n = (open.get(ip) || 0) + 1;
    if (n > PER_IP_OPEN) { socket.destroy(); return; }
    open.set(ip, n);
    socket.once('close', () => { const k = (open.get(ip) || 1) - 1; if (k > 0) open.set(ip, k); else open.delete(ip); });
  });
  server.on('tlsClientError', () => {}); // strangers, scanners: nothing to say
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); server.on('error', () => {}); resolve(server); });
  });
}

/** Mark an inbound peer as let in (bigger frames, no longer counted against its address). */
function admit(peer) {
  if (peer.admitted && !peer.inbound) return;
  peer.admitted = true;
  peer.emit('admitted');
}

/**
 * Connect to a member (or an invite's host) at host:port, and check it is the one with fingerprint
 * `pin` before anything is sent. Resolves with the Peer; rejects on a wrong certificate or no answer.
 */
function connect(me, address, pin, { timeout = 10e3 } = {}) {
  const m = String(address).match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
  if (!m) return Promise.reject(new Error('Not an address.'));
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tls.connect({ ...tlsOpts(me), host: m[1], port: Number(m[2]), rejectUnauthorized: false, checkServerIdentity: () => undefined }, () => {
      const fp = normFp(socket.getPeerCertificate()?.fingerprint256);
      if (fp !== pin) { done = true; socket.destroy(); reject(new Error('That PC is not the one this group expects (its key is different).')); return; }
      done = true;
      clearTimeout(timer);
      resolve(new Peer(socket, { fp, inbound: false }));
    });
    const timer = setTimeout(() => { if (!done) { done = true; socket.destroy(); reject(new Error('No answer.')); } }, timeout);
    socket.once('error', err => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
  });
}

/**
 * Wait for one message of type `t` (or a 'refused'); rejects on close or timeout. Reading stops after
 * it until peer.resume(), so messages right behind it wait for the caller's listeners.
 */
function expect(peer, t, timeout = 15e3) {
  peer.holdAfter(t);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('No answer.')); }, timeout);
    const onMsg = msg => {
      if (msg.t === t) { off(); resolve(msg); } else if (msg.t === 'refused') { off(); reject(Object.assign(new Error(String(msg.why || 'Refused.').slice(0, 300)), { refused: true })); }
    };
    const onClose = () => { off(); reject(new Error('The connection closed.')); };
    const off = () => { clearTimeout(timer); peer.removeListener('message', onMsg); peer.removeListener('close', onClose); };
    peer.on('message', onMsg);
    peer.on('close', onClose);
  });
}

module.exports = { Peer, listen, connect, expect, admit, ipKey, PRE_AUTH_MAX, FRAME_MAX };
