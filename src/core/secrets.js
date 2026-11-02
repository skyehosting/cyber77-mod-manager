'use strict';

/*
 * Mod config files can hold the user's API keys, tokens and passwords. Before any of a file's text
 * reaches the AI assistant, this hides them: a value whose name sounds secret, or that looks like
 * a key, becomes "[hidden: set, 51 characters, starts "sk-…"]" or "[hidden: empty]". The AI can
 * tell whether something is filled in, never what it is.
 *
 * It also writes values the user typed into a fill-in form back into a config file (JSON, INI,
 * TOML, YAML, Lua, XML), keeping the rest of the file as it was.
 */

const SECRET_NAME = /(api[_ -]?key|apikey|access[_ -]?key|secret|token|passw(?:or)?d|\bpwd\b|\bpass\b|auth(?:orization)?|bearer|private[_ -]?key|session[_ -]?id|cookie|webhook|credential|license[_ -]?key|signature)/i;
// A long run of key-like characters with letters and digits mixed: API keys, tokens, JWTs.
const KEY_SHAPED = /(?<![\w\\/.:-])(?=[A-Za-z0-9_\-+/=.]*\d)(?=[A-Za-z0-9_\-+/=.]*[A-Za-z])[A-Za-z0-9_\-+/=.]{24,}(?![\w\\/:])/g;

/** A setting name that sounds secret: api key, token, password…, or any "…Key"/"…_key" except hotkeys and bindings. */
function secretName(name) {
  const n = String(name || '').trim();
  return SECRET_NAME.test(n) || (/key$/i.test(n) && n.length > 3 && !/(hot|short|bind|toggle|menu|input|board|press|mod|nav|action|button|^)[_ -]?key$/i.test(n));
}

/** "[hidden: …]" for a secret value: whether it is set, its length, and at most its first 3 characters. */
function describe(value) {
  const v = String(value ?? '').trim();
  if (!v || /^(""|''|null|nil|none|undefined|<[^>]*>|your[_ -]?.*here|changeme|xxx+)$/i.test(v)) return v ? `[hidden: placeholder "${v.slice(0, 24)}", not a real value]` : '[hidden: empty]';
  return `[hidden: set, ${v.length} characters${v.length >= 16 ? `, starts "${v.slice(0, 3)}…"` : ''}]`;
}

const QUOTED = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
const unquote = s => (/^(["']).*\1$/s.test(s) ? s.slice(1, -1) : s);

/** One line with any secret value hidden. Returns [line, hiddenCount]. */
function redactLine(line) {
  let hidden = 0;
  let out = line;
  // A setting whose name sounds secret: hide its value (what follows = or :, or the XML text/attribute).
  // XML: <ApiKey>…</ApiKey> and token="…" attributes.
  out = out.replace(/(<([\w:.-]+)(?:\s[^>]*)?>)([^<]*)(<\/\2>)/g, (all, open, name, val, close) => {
    if (!secretName(name)) return all;
    hidden++;
    return `${open}${describe(val)}${close}`;
  });
  if (out.includes('<')) {
    out = out.replace(/(\s([\w:.-]+)\s*=\s*)("[^"]*"|'[^']*')/g, (all, lead, name, val) => {
      if (!secretName(name) || val.includes('[hidden')) return all;
      hidden++;
      return `${lead}"${describe(unquote(val))}"`;
    });
  }
  {
    // "name": "value" anywhere on the line (one-line JSON objects).
    out = out.replace(/("([\w .-]+)"\s*:\s*)("(?:[^"\\]|\\.)*")/g, (all, lead, name, val) => {
      if (!secretName(name) || val.includes('[hidden')) return all;
      hidden++;
      return `${lead}"${describe(unquote(val))}"`;
    });
    out = out.replace(/([\w.-]*)(\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, (all, name, eq, val) => {
      if (!secretName(name) || val.includes('[hidden')) return all;
      hidden++;
      return `${name}${eq}"${describe(unquote(val))}"`;
    });
    const kv = out.match(/^(\s*(?:-\s*)?["']?([^"'=:#;\s][^"'=:]*?)["']?\s*[:=]\s*)(.*?)(\s*[,;]?\s*(?:(?:#|\/\/|--).*)?)$/);
    if (kv && secretName(kv[2]) && !kv[3].includes('[hidden') && !/^[{[]\s*$/.test(kv[3])) {
      const raw = kv[3].trim();
      const quoted = /^(["']).*\1$/.test(raw);
      out = `${kv[1]}${quoted ? '"' : ''}${describe(unquote(raw))}${quoted ? '"' : ''}${kv[4]}`;
      hidden++;
    }
  }
  // Anything else that looks like a key, whatever its name.
  out = out.replace(QUOTED, q => {
    const inner = q.slice(1, -1);
    if (inner.startsWith('[hidden') || !new RegExp(KEY_SHAPED.source).test(inner) || /[\\/]{2}|^[A-Za-z]:|\.(\w{2,4})$/.test(inner)) return q;
    hidden++;
    return `${q[0]}${inner.replace(KEY_SHAPED, m => describe(m))}${q[0]}`;
  });
  // Keys in web addresses: ?api_key=…&token=…
  out = out.replace(/([?&][\w-]*(?:key|token|secret|sig|auth|password)[\w-]*=)([^&#\s"'<]+)/gi, (all, lead, val) => {
    if (val.startsWith('[hidden')) return all;
    hidden++;
    return `${lead}${describe(val)}`;
  });
  if (!/[\\/]/.test(out)) {
    out = out.replace(KEY_SHAPED, m => {
      if (m.startsWith('[hidden') || /^[\d.]+$/.test(m)) return m;
      hidden++;
      return describe(m);
    });
  }
  return [out, hidden];
}

/** A file's text with secrets hidden, and how many values were hidden. */
function redact(text) {
  let hidden = 0;
  const lines = String(text).split(/\r?\n/).map(l => {
    const [o, n] = redactLine(l);
    hidden += n;
    return o;
  });
  return { text: lines.join('\n'), hidden };
}

// Settings files (may hold keys): the AI reads them only with the user's approval. ArchiveXL /
// TweakXL patches and REDmods' files are mod content, not settings.
const CONFIG_EXT = new Set(['.json', '.ini', '.toml', '.cfg', '.conf', '.env', '.yaml', '.yml', '.xml', '.properties', '.settings', '.config']);
function isConfigFile(rel) {
  const p = String(rel).replace(/\\/g, '/').toLowerCase();
  const ext = p.match(/\.[^./]+$/)?.[0] || '';
  if (!CONFIG_EXT.has(ext)) return /(^|\/)\.env$/.test(p);
  if (/^(archive\/pc\/mod|r6\/tweaks|mods)\//.test(p) && ['.yaml', '.yml', '.xl'].includes(ext)) return false;
  return true;
}

// ---------------------------------------------------------------- writing form values back

const FORMAT = { '.json': 'json', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.env': 'ini', '.properties': 'ini', '.toml': 'toml', '.yaml': 'yaml', '.yml': 'yaml', '.lua': 'lua', '.xml': 'xml' };
function formatOf(rel) {
  const p = String(rel).toLowerCase();
  if (/(^|[\\/])\.env$/.test(p)) return 'ini';
  return FORMAT[p.match(/\.[^./\\]+$/)?.[0] || ''] || '';
}

const RAW = /^(-?\d+(\.\d+)?|true|false)$/;
const dq = v => JSON.stringify(String(v));

/** The new value as it should be written where `old` was: quoted like it, or bare for numbers/booleans. */
function asLike(old, value, { quoteStrings = false } = {}) {
  const o = String(old || '').trim();
  if (/^".*"$/s.test(o)) return dq(value);
  if (/^'.*'$/s.test(o)) return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (RAW.test(String(value)) && (o === '' || RAW.test(o))) return String(value);
  return quoteStrings ? dq(value) : String(value);
}

function setJson(text, path, value) {
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (err) { throw new Error(`The file is not valid JSON (${err.message}); open it in the editor instead.`); }
  const keys = path.split('.');
  let obj = data;
  for (const k of keys.slice(0, -1)) {
    if (obj[k] === undefined) obj[k] = {};
    if (typeof obj[k] !== 'object' || obj[k] === null) throw new Error(`"${path}" does not lead to a setting in this file.`);
    obj = obj[k];
  }
  const last = keys[keys.length - 1];
  const before = obj[last];
  obj[last] = typeof before === 'number' && RAW.test(value) && !/^(true|false)$/.test(value) ? Number(value)
    : typeof before === 'boolean' && /^(true|false)$/.test(value) ? value === 'true' : String(value);
  const indent = text.match(/^[ \t]+(?=")/m)?.[0] || '  ';
  return JSON.stringify(data, null, indent) + (/\n\s*$/.test(text) ? '\n' : '');
}

function setLines(text, path, value, format) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const parts = path.split('.');
  const key = parts.pop();
  const section = parts.join('.');
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let current = '';
  for (let i = 0; i < lines.length; i++) {
    const sec = lines[i].match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*$/);
    if (sec) { current = sec[1].replace(/^["']|["']$/g, ''); continue; }
    if (section && current.toLowerCase() !== section.toLowerCase()) continue;
    const m = lines[i].match(new RegExp(`^(\\s*(?:export\\s+)?["']?${esc}["']?\\s*[=:]\\s*)(.*?)(\\s*(?:[#;].*)?)$`, 'i'));
    if (!m) continue;
    lines[i] = `${m[1]}${asLike(m[2], value, { quoteStrings: format === 'toml' })}${m[3]}`;
    return lines.join(eol);
  }
  throw new Error(`"${path}" was not found in the file; open it in the editor to add it.`);
}

function setYaml(text, path, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const keys = path.split('.');
  let from = 0;
  let to = lines.length;
  let minIndent = -1;
  for (let k = 0; k < keys.length; k++) {
    const esc = keys[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let found = -1;
    for (let i = from; i < to; i++) {
      const ind = lines[i].match(/^\s*/)[0].length;
      if (lines[i].trim() && ind <= minIndent) { to = i; break; }
      if (new RegExp(`^\\s*["']?${esc}["']?\\s*:(\\s|$)`).test(lines[i])) { found = i; break; }
    }
    if (found < 0) throw new Error(`"${path}" was not found in the file; open it in the editor to add it.`);
    if (k === keys.length - 1) {
      const m = lines[found].match(/^(\s*["']?[^:]+["']?\s*:\s*)(.*?)(\s+#.*)?$/);
      lines[found] = `${m[1]}${asLike(m[2], value, { quoteStrings: true })}${m[3] || ''}`;
      return lines.join(eol);
    }
    minIndent = lines[found].match(/^\s*/)[0].length;
    from = found + 1;
  }
  return text;
}

function setLua(text, path, value) {
  const key = path.split('.').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`((?:^|[\\s{,])\\[?["']?${key}["']?\\]?\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^,}\\r\\n]*?(?=\\s*(?:[,}\\r\\n]|--|$)))`, 'm');
  if (!re.test(text)) throw new Error(`"${path}" was not found in the file; open it in the editor to add it.`);
  return text.replace(re, (all, lead, old) => `${lead}${asLike(old, value, { quoteStrings: true })}`);
}

function setXml(text, path, value) {
  const key = path.split('.').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const xmlEsc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const el = new RegExp(`(<${key}(?:\\s[^>]*)?>)([^<]*)(</${key}>)`);
  if (el.test(text)) return text.replace(el, (all, a, _old, b) => `${a}${xmlEsc(value)}${b}`);
  const attr = new RegExp(`(\\s${key}\\s*=\\s*)("[^"]*"|'[^']*')`);
  if (attr.test(text)) return text.replace(attr, (all, a) => `${a}"${xmlEsc(value)}"`);
  throw new Error(`"${path}" was not found in the file; open it in the editor to add it.`);
}

/** Write each { key, value } into the config file's text. Keys are dotted paths ("section.key"). */
function setValues(text, rel, values) {
  const format = formatOf(rel);
  if (!format) throw new Error('This kind of file cannot be filled in from a form; open it in the editor instead.');
  let out = text;
  for (const { key, value } of values) {
    const k = String(key || '').trim();
    if (!k) continue;
    if (format === 'json') out = setJson(out, k, value);
    else if (format === 'ini' || format === 'toml') out = setLines(out, k, value, format);
    else if (format === 'yaml') out = setYaml(out, k, value);
    else if (format === 'lua') out = setLua(out, k, value);
    else out = setXml(out, k, value);
  }
  return out;
}

module.exports = { redact, redactLine, describe, secretName, isConfigFile, formatOf, setValues };
