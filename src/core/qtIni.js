'use strict';

/*
 * Reading the INI files Qt's QSettings writes (Mod Organizer 2's ModOrganizer.ini, meta.ini and
 * download .meta files). Qt's rules (qsettings.cpp, iniEscapedString / iniUnescapedStringList /
 * stringToVariant):
 *   - section and key names are case-insensitive; top-level keys sit in [General]
 *   - a value may be "quoted"; \\ \" \n \t \r \0 and \xHH… escapes; hex escapes are greedy
 *   - @ByteArray(…) holds raw bytes (non-ASCII written as \xHH), which MO2 decodes as UTF-8
 *   - @@ stands for a literal @; @Variant(…) and @String(…) are other types, left as text
 * Arrays (beginWriteArray) are keys like `1\fileid` with a `size` key in the array's section.
 */

const SIMPLE = { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };

function unescape(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') continue; // quotes only group; the escapes inside work the same
    if (c !== '\\' || i + 1 >= raw.length) { out += c; continue; }
    const n = raw[++i];
    if (n === 'x' || n === 'X') {
      let hex = '';
      while (i + 1 < raw.length && /[0-9a-fA-F]/.test(raw[i + 1]) && hex.length < 8) hex += raw[++i];
      out += hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : n;
      continue;
    }
    out += SIMPLE[n] ?? n;
  }
  return out;
}

function decodeValue(raw) {
  const s = unescape(raw.trim());
  const bytes = s.match(/^@ByteArray\(([\s\S]*)\)$/);
  if (bytes) return Buffer.from(bytes[1], 'latin1').toString('utf8');
  if (s.startsWith('@@')) return s.slice(1);
  return s;
}

/** Parse INI text into Map<section (lower case), Map<key (lower case), value>>. */
function parseIni(text) {
  const sections = new Map();
  let current = new Map();
  sections.set('general', current);
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith(';') || t.startsWith('#')) continue;
    const sec = t.match(/^\[(.*)\]$/);
    if (sec) {
      // Qt writes a group literally called "General" as [%General].
      const name = sec[1].trim().toLowerCase().replace(/^%general$/, 'general');
      if (!sections.has(name)) sections.set(name, new Map());
      current = sections.get(name);
      continue;
    }
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    current.set(t.slice(0, eq).trim().toLowerCase(), decodeValue(t.slice(eq + 1)));
  }
  return sections;
}

/** One value, or `def` when the section or key is missing. */
function iniGet(ini, section, key, def = '') {
  const v = ini.get(String(section).toLowerCase())?.get(String(key).toLowerCase());
  return v === undefined ? def : v;
}

/** A Qt array (beginReadArray): [{ key: value }, …] in order. */
function iniArray(ini, section) {
  const sec = ini.get(String(section).toLowerCase());
  if (!sec) return [];
  const size = Math.min(Number(sec.get('size')) || 0, 10000);
  const out = [];
  for (let i = 1; i <= size; i++) {
    const item = {};
    for (const [k, v] of sec) {
      const m = k.match(/^(\d+)[\\/](.+)$/);
      if (m && Number(m[1]) === i) item[m[2]] = v;
    }
    out.push(item);
  }
  return out;
}

module.exports = { parseIni, iniGet, iniArray, decodeValue };
