'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/*
 * This PC's identity for Group Mods: an ECDSA P-256 key pair and a self-signed certificate for it.
 * Friends' apps pin the certificate's SHA-256 fingerprint (the invite code carries the host's), and a
 * member is known by it. P-256, not Ed25519: Electron's TLS (BoringSSL) refuses Ed25519 certificates
 * (tested on Electron 45; notes/group-mods.md).
 *
 * The certificate is built here (Node can parse and verify certificates but not make them). Only the
 * DER encoding is ours: the key, the signature and every check are node:crypto, and the tests verify
 * the result with crypto.X509Certificate. Nothing in it is trusted for anything but its own key: the
 * pin is the trust.
 *
 * Stored in <userData>/groups/identity.json. The private key is encrypted with Electron safeStorage
 * when available (like the Nexus API key).
 */

// ---- DER, just what one certificate needs

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
function oid(text) {
  const n = text.split('.').map(Number);
  const out = [n[0] * 40 + n[1]];
  for (const v of n.slice(2)) {
    const b = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
const utf8 = s => tlv(0x0c, Buffer.from(s, 'utf8'));
/** UTCTime (YYMMDDHHMMSSZ) for 1950–2049. */
function utcTime(d) {
  const p = n => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'));
}

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';

/** A self-signed certificate (PEM) for a P-256 key pair. */
function selfSignedCert(privateKey, publicKey, name = 'Edgerunners Mod Manager') {
  const algo = seq(oid(ECDSA_SHA256));
  const dn = seq(set(seq(oid(COMMON_NAME), utf8(name.slice(0, 64)))));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // positive
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 3600e3); // a day back: clocks differ
  const until = new Date(Date.UTC(2049, 11, 31, 23, 59, 59));
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), // v3
    int(serial),
    algo,
    dn,
    seq(utcTime(from), utcTime(until)),
    dn,
    spki,
  );
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, algo, tlv(0x03, Buffer.from([0]), sig));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** "AB:CD:…" (Node's fingerprint256) → lowercase hex without colons: how fingerprints are kept. */
const normFp = fp => String(fp || '').replace(/:/g, '').toLowerCase();
const FP = /^[0-9a-f]{64}$/;

/** A certificate's identity: its fingerprint, and its public key, checked to be what we expect. */
function certInfo(pem) {
  const x = new crypto.X509Certificate(pem);
  const key = x.publicKey;
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Not a group member certificate.');
  if (!x.verify(key)) throw new Error('The certificate is not signed by its own key.');
  return { fp: normFp(x.fingerprint256), publicKey: key };
}

/** Sign / verify a message with an identity (ECDSA P-256, SHA-256), signatures as base64. */
const sign = (privateKey, data) => crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
function verify(publicKey, data, sig) {
  try { return crypto.verify('sha256', Buffer.from(data), { key: publicKey, dsaEncoding: 'der' }, Buffer.from(String(sig), 'base64')); } catch { return false; }
}

/**
 * This PC's identity, made on first use. cipher: { available(), encrypt(s), decrypt(s) } (safeStorage)
 * or null. Returns { fp, cert, privateKey, publicKey, keyPem }.
 */
function loadIdentity(dir, cipher) {
  const file = path.join(dir, 'identity.json');
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw new Error(`This PC's group identity could not be read (${err.code || err.message}).`); }
  if (raw !== null) {
    // There is one: use it or stop. Never make a new one over it (that would drop you from every group).
    const fail = why => new Error(`This PC's group identity could not be read: ${why}. Your groups are safe; try again (on Linux, unlock your keyring first).`);
    let d;
    try { d = JSON.parse(raw); } catch { throw fail('the file is damaged'); }
    let keyPem = d.key;
    if (d.keyEnc) {
      if (!cipher?.available()) throw fail("the system's protected storage is not available right now");
      try { keyPem = cipher.decrypt(d.keyEnc); } catch { throw fail("the system's protected storage could not open it"); }
    }
    if (!keyPem || !d.cert) throw fail('it is incomplete');
    const privateKey = crypto.createPrivateKey(keyPem);
    const info = certInfo(d.cert);
    if (!verify(info.publicKey, 'probe', sign(privateKey, 'probe'))) throw fail('its key does not match its certificate');
    if (!d.keyEnc && cipher?.available()) {
      // Stored plainly before (protected storage was not ready): protect it now.
      try {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ cert: d.cert, keyEnc: cipher.encrypt(keyPem) }, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch { /* next time */ }
    }
    return { fp: info.fp, cert: d.cert, privateKey, publicKey: info.publicKey, keyPem };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cert = selfSignedCert(privateKey, publicKey);
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(dir, { recursive: true });
  const enc = cipher?.available() ? cipher.encrypt(keyPem) : '';
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(enc ? { cert, keyEnc: enc } : { cert, key: keyPem }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { fp: certInfo(cert).fp, cert, privateKey, publicKey, keyPem };
}

module.exports = { selfSignedCert, certInfo, normFp, FP, sign, verify, loadIdentity };
