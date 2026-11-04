'use strict';
const zlib = require('zlib');
const crypto = require('crypto');

/*
 * Profile share codes: a whole profile in one line of text, made from the profile itself, so it
 * changes whenever its mods do. Nothing is stored anywhere: the code is the data.
 *
 *   CMM1-<base64url of deflate(payload)>
 *
 * payload (all numbers are unsigned LEB128 varints):
 *   format version (1)
 *   name length, name (UTF-8)
 *   mod count, then per mod in priority order:
 *     Nexus mod id, Nexus file id, flags (1 = FOMOD installer, 2 = installer choices follow)
 *     [choices length, choices (UTF-8 JSON)]
 *   count of the sender's local-file mods (not in the code: they are not on Nexus)
 *
 * Mod names are not stored (they would make codes several times longer): the importer reads them
 * from Nexus and from what is already installed.
 */

const PREFIX = 'CMM1-';
const MAX_CODE_CHARS = 200000;
const MAX_PAYLOAD = 2 * 1024 * 1024;

function writeVarint(out, n) {
  let v = Math.max(0, Math.floor(Number(n) || 0));
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 128;
    out.push(b);
  } while (v > 0);
}
function writeText(out, s) {
  const b = Buffer.from(String(s), 'utf8');
  writeVarint(out, b.length);
  for (const x of b) out.push(x);
}

/** A profile export (manager.exportProfile) as a share code. */
function encode(doc) {
  const out = [];
  writeVarint(out, 1);
  writeText(out, String(doc.name || 'Shared profile').slice(0, 60));
  const nexus = (doc.mods || []).filter(m => Number(m.modId) > 0 && Number(m.fileId) > 0);
  writeVarint(out, nexus.length);
  for (const m of nexus) {
    writeVarint(out, m.modId);
    writeVarint(out, m.fileId);
    const choices = m.fomodChoices ? JSON.stringify(m.fomodChoices) : '';
    writeVarint(out, (m.fomod ? 1 : 0) | (choices ? 2 : 0));
    if (choices) writeText(out, choices);
  }
  writeVarint(out, (doc.mods || []).length - nexus.length);
  return PREFIX + zlib.deflateRawSync(Buffer.from(out), { level: 9 }).toString('base64url');
}

/** A share code back into the export format the importer reads. Throws on anything malformed. */
function decode(code) {
  const text = String(code || '').trim().replace(/\s+/g, '');
  if (!text.startsWith(PREFIX)) throw new Error('That is not a profile code from this app (they start with CMM1-).');
  if (text.length > MAX_CODE_CHARS) throw new Error('That code is too long to be a profile.');
  let buf;
  try {
    buf = zlib.inflateRawSync(Buffer.from(text.slice(PREFIX.length), 'base64url'), { maxOutputLength: MAX_PAYLOAD });
  } catch {
    throw new Error('That profile code is damaged or incomplete. Copy it again, all of it.');
  }
  let i = 0;
  const varint = () => {
    let n = 0;
    let mul = 1;
    for (let k = 0; k < 8; k++) {
      if (i >= buf.length) throw new Error('That profile code is damaged or incomplete. Copy it again, all of it.');
      const b = buf[i++];
      n += (b & 127) * mul;
      if (!(b & 128)) return n;
      mul *= 128;
    }
    throw new Error('That profile code is damaged.');
  };
  const textField = () => {
    const len = varint();
    if (i + len > buf.length) throw new Error('That profile code is damaged or incomplete. Copy it again, all of it.');
    const s = buf.subarray(i, i + len).toString('utf8');
    i += len;
    return s;
  };
  const version = varint();
  if (version !== 1) throw new Error('This profile code was made by a newer version of the app. Update it to read the code.');
  const name = textField();
  const count = varint();
  if (count > 5000) throw new Error('That code lists too many mods to be a profile.');
  const mods = [];
  for (let n = 0; n < count; n++) {
    const modId = varint();
    const fileId = varint();
    const flags = varint();
    let fomodChoices;
    if (flags & 2) {
      try { fomodChoices = JSON.parse(textField()); } catch { fomodChoices = undefined; }
    }
    mods.push({ modId, fileId, fomod: !!(flags & 1), fomodChoices, game: 'cyberpunk2077', source: 'nexus' });
  }
  const localCount = i < buf.length ? varint() : 0;
  return { format: 'cyber-mod-manager-profile', version: 1, name, game: 'cyberpunk2077', mods, localCount, fromCode: true };
}

/** A short tag that changes whenever the code does, for the profile card. */
const fingerprint = code => crypto.createHash('sha1').update(code).digest('hex').slice(0, 6).toUpperCase();

module.exports = { encode, decode, fingerprint, PREFIX };
