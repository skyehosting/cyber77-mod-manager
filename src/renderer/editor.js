'use strict';
/* global api, $, h, icon, toast, modal, state */

// ---------------------------------------------------------------- the built-in editor

/*
 * Edits a mod's text file in place. A textarea (what you type in) lies over a coloured copy of the
 * same text: both use the same font and scroll together, so the colours line up with the caret.
 * Colours come from simple per-language rules (JSON, YAML/ArchiveXL, INI/TOML, Lua, redscript,
 * TweakXL .tweak, XML, logs…). Saving writes in place (main process) after a conflict check, and
 * the first save keeps the original so it can be put back.
 */

const Q = '"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'';
const NUM = '-?\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b';
const LANGS = {
  json: { label: 'JSON', rules: [['com', '//[^\\n]*'], ['key', `"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)`], ['str', Q], ['num', NUM], ['bool', '\\b(?:true|false|null)\\b']] },
  yaml: { label: 'YAML', rules: [['com', '#[^\\n]*'], ['str', Q], ['key', '^[ \\t]*(?:-[ \\t]+)?[^\\s:#"\'\\-][^:#\\n]*?(?=:(?:[ \\t]|$))'], ['punc', '^[ \\t]*-(?=[ \\t])'], ['num', NUM], ['bool', '\\b(?:true|false|null|yes|no|on|off)\\b|~']] },
  ini: { label: 'INI', rules: [['com', '^[ \\t]*[;#][^\\n]*|(?<=[ \\t]);[^\\n]*'], ['sec', '^[ \\t]*\\[[^\\]\\n]*\\]+'], ['key', '^[ \\t]*[^=:\\n\\[;#][^=\\n]*?(?=[ \\t]*[=:])'], ['str', Q], ['num', NUM], ['bool', '\\b(?:true|false|on|off|yes|no)\\b']] },
  lua: {
    label: 'Lua',
    rules: [['com', '--\\[\\[[\\s\\S]*?\\]\\]|--[^\\n]*'], ['str', `${Q}|\\[\\[[\\s\\S]*?\\]\\]`],
      ['kw', '\\b(?:and|break|do|else|elseif|end|for|function|goto|if|in|local|not|or|repeat|return|then|until|while)\\b'], ['bool', '\\b(?:true|false|nil)\\b'],
      ['num', NUM], ['fn', '\\b[A-Za-z_]\\w*(?=\\s*[({"])'], ['key', '\\b[A-Za-z_]\\w*(?=\\s*=(?!=))']],
  },
  reds: {
    label: 'redscript',
    rules: [['com', '//[^\\n]*|/\\*[\\s\\S]*?\\*/'], ['ann', '@\\w+'], ['str', `[ntrs]?(?:${Q})`],
      ['kw', '\\b(?:func|let|var|if|else|return|class|struct|enum|public|private|protected|native|static|final|import|module|extends|const|while|for|in|switch|case|default|break|continue|new|this|super|ref|wref|script_ref|out|opt|cb|persistent|exec|abstract|importonly|function|async|await|export|from|typeof|instanceof)\\b'],
      ['bool', '\\b(?:true|false|null|nil|None)\\b'], ['num', NUM], ['fn', '\\b[A-Za-z_]\\w*(?=\\s*\\()'], ['type', '\\b[A-Z]\\w*\\b']],
  },
  tweak: {
    label: 'TweakXL',
    rules: [['com', '//[^\\n]*|/\\*[\\s\\S]*?\\*/'], ['str', `[nrt]?(?:${Q})`], ['type', '\\b[A-Z]\\w*(?:\\.\\w+)+'], ['key', '\\b\\w+(?=[ \\t]*[+-]?=)'],
      ['kw', '\\b(?:package|using)\\b'], ['bool', '\\b(?:true|false|None)\\b'], ['num', NUM]],
  },
  xml: { label: 'XML', rules: [['com', '<!--[\\s\\S]*?-->'], ['str', Q], ['tag', '</?[\\w:.-]+|/?>|<\\?[\\w-]+|\\?>'], ['key', '\\b[\\w:.-]+(?=\\s*=)']] },
  py: {
    label: 'Python',
    rules: [['com', '#[^\\n]*'], ['str', `"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|${Q}`], ['kw', '\\b(?:def|class|return|if|elif|else|for|while|in|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|not|and|or|is|global|async|await)\\b'],
      ['bool', '\\b(?:True|False|None)\\b'], ['num', NUM], ['fn', '\\b[A-Za-z_]\\w*(?=\\s*\\()']],
  },
  log: { label: 'Log', flags: 'i', rules: [['err', '\\[\\s*(?:error|err|fatal|critical)\\s*\\]|\\b(?:error|err|fatal|critical|exception|failed|failure|crash(?:ed)?|access violation)\\b'], ['warn', '\\[\\s*(?:warning|warn)\\s*\\]'], ['warn', '\\b(?:warning|warn|deprecated|missing)\\b'], ['num', '\\b\\d{1,2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\b'], ['key', '\\[[^\\]\\n]{1,40}\\]'], ['str', '"[^"\\n]*"']] },
  text: { label: 'Text', rules: [] },
};
const BY_EXT = {
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.xl': 'yaml', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.env': 'ini', '.properties': 'ini', '.toml': 'ini', '.settings': 'ini',
  '.lua': 'lua', '.reds': 'reds', '.ws': 'reds', '.script': 'reds', '.js': 'reds', '.mjs': 'reds', '.ts': 'reds', '.tweak': 'tweak', '.xml': 'xml', '.html': 'xml', '.config': 'xml',
  '.py': 'py', '.log': 'log', '.txt': 'text', '.csv': 'text', '.md': 'text', '.bat': 'text', '.cmd': 'text', '.ps1': 'text', '.css': 'text',
};
for (const l of Object.values(LANGS)) l.re = l.rules.length ? new RegExp(l.rules.map(([, src]) => `(${src})`).join('|'), `gm${l.flags || ''}`) : null;
const langOf = rel => {
  const ext = (String(rel).match(/\.[^./]+$/)?.[0] || '').toLowerCase();
  if (ext === '.txt' && /log/i.test(rel)) return 'log';
  return BY_EXT[ext] || (/(^|\/)\.env$/i.test(rel) ? 'ini' : 'text');
};

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HIGHLIGHT_MAX = 400 * 1024;

/** The text as HTML with coloured spans (every piece of text escaped). */
function highlight(text, lang) {
  const l = LANGS[lang] || LANGS.text;
  if (!l.re || text.length > HIGHLIGHT_MAX) return `${esc(text)}\n`;
  const re = new RegExp(l.re.source, l.re.flags);
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const i = m.findIndex((g, k) => k > 0 && g !== undefined);
    out += esc(text.slice(last, m.index)) + `<span class="tk-${l.rules[i - 1][0]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return `${out}${esc(text.slice(last))}\n`;
}

const ed = { file: null, saved: '', opener: null, raf: 0 };

/** Keep the app behind the editor out of reach (a confirm box above it gives it back when it closes). */
function lockShell(on = true) {
  $('#shell').inert = on;
  $('#drawer').inert = on;
}

async function edConfirm(opts) {
  const v = await modal(opts);
  lockShell(true);
  $('#ed .ed-text')?.focus();
  return v;
}

/** Open a file: { loc, mod, note, vortex }. */
/**
 * Open a file: { loc, mod, note, vortex, copy, twins }. `copy` names which copy of the mod this
 * is; `twins` are the same file in the mod's other copies ({ loc, label }), offered on save.
 */
async function openEditor({ loc, mod = '', note = '', vortex = false, copy = '', twins = [] }) {
  if (ed.file && !(await closeEditor())) return;
  const r = await api.cfgRead(loc);
  if (r.error) { toast(r.error, 'error'); return; }
  const f = r.ok;
  // Which other copies are this very file (hardlinked: saving one saves both) and which are separate.
  let others = [];
  if (twins.length) {
    const st = (await api.cfgTwins(loc, twins.map(t => t.loc))).ok || [];
    others = twins.map((t, i) => ({ ...t, ...st[i] })).filter(t => t.exists);
  }
  ed.file = { loc, mod, note, vortex, copy, twins: others, lang: langOf(loc.rel), ...f };
  ed.saved = f.text;
  ed.opener = document.activeElement;
  buildEditor();
  lockShell(true);
  $('#ed-back').hidden = false;
  const ta = $('#ed .ed-text');
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}

function buildEditor() {
  const f = ed.file;
  const name = f.loc.rel.split('/').pop();
  const lang = LANGS[f.lang];
  const ta = h('textarea', {
    class: 'ed-text', spellcheck: 'false', wrap: 'off', autocomplete: 'off', 'aria-label': `Contents of ${name}`,
    readOnly: !!f.readOnly, oninput: onEdit, onscroll: syncScroll, onkeydown: onKey, onclick: showPos, onkeyup: showPos, onselect: showPos,
  });
  ta.value = f.text;
  const linked = f.twins.filter(t => t.linked).map(t => t.label);
  const separate = f.twins.filter(t => !t.linked).map(t => t.label);
  const notes = [
    f.note,
    linked.length ? `${linked.join(' and ')}: the same file on disk (linked), so saving changes it too.` : '',
    separate.length ? `${separate.join(' and ')} ${separate.length === 1 ? 'has its own copy' : 'have their own copies'} of this file: when you save, you can change ${separate.length === 1 ? 'it' : 'them'} too.` : '',
    f.loc.base !== 'game' ? 'This is the stored copy, not the file in the game folder: changes apply when the mod is enabled.' : '',
    f.vortex && f.loc.base === 'game' ? 'A Vortex mod: this file is shared with Vortex\'s copy, and Vortex may ask about the change when it next deploys.' : '',
    state.gameRunning ? 'The game is running: most mods read their settings when the game starts.' : '',
    f.readOnly ? 'This file is large: it opens read-only.' : '',
    f.text.length > HIGHLIGHT_MAX ? 'Colours are off for a file this large.' : '',
  ].filter(Boolean);
  // Find is always there, top right: typing in it marks every match.
  ed.find = { open: true, q: '', hits: [], i: -1 };
  const findInput = h('input', {
    type: 'search', class: 'ed-find-input', placeholder: 'Find in file  (Ctrl+F)', 'aria-label': 'Find in file', spellcheck: 'false',
    oninput: ev => { ed.find.q = ev.target.value; runFind(true); },
    onkeydown: ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeFind(); }
      if (ev.key === 'F3') { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); }
    },
  });
  const findBox = h('div', { class: 'ed-find', id: 'ed-find', role: 'search' },
    h('label', { class: 'search ed-find-field' }, icon('search'), findInput),
    h('span', { class: 'ed-find-count', id: 'ed-find-count', role: 'status' }),
    h('button', { class: 'btn btn-icon btn-sm btn-ghost', title: 'Previous match (Shift+Enter)', 'aria-label': 'Previous match', onclick: () => stepFind(-1) }, icon('arrow-up')),
    h('button', { class: 'btn btn-icon btn-sm btn-ghost', title: 'Next match (Enter)', 'aria-label': 'Next match', onclick: () => stepFind(1) }, icon('arrow-down')));
  // (replaceChildren would print a null child as the text "null", so absent parts are left out.)
  $('#ed').replaceChildren(...[
    h('div', { class: 'ed-head' },
      h('span', { class: 'ed-icon' }, icon('file-code')),
      h('div', { class: 'ed-titles' },
        h('h3', { id: 'ed-title' }, name),
        h('div', { class: 'ed-path', title: f.loc.rel }, [f.loc.rel, f.mod, f.copy].filter(Boolean).join('  ·  '))),
      findBox,
      h('div', { class: 'ed-actions' },
        h('button', { class: 'btn btn-sm btn-ghost', id: 'ed-restore', hidden: !f.hasBackup, title: 'Put back the file as it was before you first saved it here', onclick: restoreOriginal }, icon('rotate'), h('span', {}, 'Restore original')),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => api.cfgShow(f.loc) }, icon('folder'), h('span', {}, 'Show in folder')),
        h('button', { class: 'btn btn-icon btn-ghost', title: 'Close (Esc)', 'aria-label': 'Close the editor', onclick: () => closeEditor() }, icon('x')))),
    notes.length ? h('div', { class: 'ed-notes' }, notes.map(n => h('p', {}, icon('info'), h('span', {}, n)))) : null,
    h('div', { class: `ed-body${f.text.length > HIGHLIGHT_MAX ? ' plain' : ''}` },
      h('pre', { class: 'ed-gutter', 'aria-hidden': 'true' }),
      h('div', { class: 'ed-area' }, h('pre', { class: 'ed-marks', 'aria-hidden': 'true' }), h('pre', { class: 'ed-hl', 'aria-hidden': 'true' }), ta)),
    h('div', { class: 'ed-foot' },
      h('span', { class: 'ed-pos', id: 'ed-pos' }, 'Ln 1, Col 1'),
      h('span', { class: 'ed-meta' }, [lang.label, f.bom === 'utf16le' ? 'UTF-16' : f.bom ? 'UTF-8 BOM' : 'UTF-8', f.eol === '\r\n' ? 'CRLF' : 'LF'].join('  ·  ')),
      h('span', { class: 'ed-state', id: 'ed-state', role: 'status' }, f.readOnly ? 'Read only' : ''),
      h('button', { class: 'btn', onclick: () => closeEditor() }, 'Close'),
      f.readOnly ? null : h('button', { class: 'btn btn-primary', id: 'ed-save', disabled: true, onclick: saveEditor, title: 'Save (Ctrl+S)' }, icon('save'), h('span', {}, 'Save'))),
  ].filter(Boolean));
  render(true);
}

// ---- find in the file: matches are marked on a layer under the coloured text

/** Ctrl+F: to the search box, with the selected text (one line) as the search. */
function openFind() {
  const ta = $('#ed .ed-text');
  const input = $('#ed-find input');
  const picked = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  if (picked && !picked.includes('\n')) { input.value = picked; ed.find.q = picked; }
  input.focus();
  input.select();
  runFind(true);
}

/** Esc in the search box: clear it and go back to the text, at the match it was on. */
function closeFind() {
  const ta = $('#ed .ed-text');
  const hit = ed.find.hits[ed.find.i];
  const len = ed.find.q.length;
  ed.find.q = '';
  $('#ed-find input').value = '';
  runFind(false, false);
  ta.focus();
  if (hit !== undefined) ta.setSelectionRange(hit, hit + len);
}

/** Find every match (case-insensitive); `fromCaret` starts at the first one after the caret; `move` goes to it. */
function runFind(fromCaret = false, move = true) {
  if (!ed.find?.open) return;
  const ta = $('#ed .ed-text');
  const q = ed.find.q.toLowerCase();
  const hay = ta.value.toLowerCase();
  const hits = [];
  if (q) for (let i = hay.indexOf(q); i >= 0 && hits.length < 5000; i = hay.indexOf(q, i + q.length)) hits.push(i);
  ed.find.hits = hits;
  if (fromCaret || ed.find.i >= hits.length) {
    const at = ta.selectionStart;
    const next = hits.findIndex(i => i >= at);
    ed.find.i = hits.length ? (next < 0 ? 0 : next) : -1;
  }
  showFind(move);
}

function stepFind(dir) {
  const n = ed.find.hits.length;
  if (!n) return;
  ed.find.i = (ed.find.i + dir + n) % n;
  showFind();
}

function showFind(move = true) {
  const { q, hits, i } = ed.find;
  const ta = $('#ed .ed-text');
  $('#ed-find-count').textContent = !q ? '' : hits.length ? `${i + 1} of ${hits.length}${hits.length >= 5000 ? '+' : ''}` : 'No matches';
  $('#ed-find').classList.toggle('none', !!q && !hits.length);
  // The marks layer: the same text, invisible, with each match on a coloured background.
  let html = '';
  let last = 0;
  hits.forEach((at, k) => {
    html += `${esc(ta.value.slice(last, at))}<mark${k === i ? ' class="cur"' : ''}>${esc(ta.value.slice(at, at + q.length))}</mark>`;
    last = at + q.length;
  });
  $('#ed .ed-marks').innerHTML = hits.length ? `${html}${esc(ta.value.slice(last))}\n` : '';
  if (i < 0 || !move) return;
  // Bring the current match into view (a third of the way down) and put the caret on it.
  const at = hits[i];
  const before = ta.value.slice(0, at);
  const line = before.split('\n').length - 1;
  const col = at - before.lastIndexOf('\n') - 1;
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 20;
  const cw = charWidth(cs);
  ta.setSelectionRange(at, at + q.length);
  ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 3);
  const x = col * cw;
  if (x < ta.scrollLeft || x > ta.scrollLeft + ta.clientWidth - 80) ta.scrollLeft = Math.max(0, x - ta.clientWidth / 2);
  syncScroll();
  showPos();
}

let measured = { font: '', w: 8 };
function charWidth(cs) {
  const font = `${cs.fontSize} ${cs.fontFamily}`;
  if (measured.font !== font) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = font;
    measured = { font, w: ctx.measureText('0123456789').width / 10 || 8 };
  }
  return measured.w;
}

function render(full = false) {
  const ta = $('#ed .ed-text');
  if (!ta) return;
  const text = ta.value;
  $('#ed .ed-hl').innerHTML = highlight(text, ed.file.lang);
  const lines = text.split('\n').length;
  const gutter = $('#ed .ed-gutter');
  if (full || gutter.dataset.n !== String(lines)) {
    gutter.dataset.n = String(lines);
    gutter.textContent = `${Array.from({ length: lines }, (_, i) => i + 1).join('\n')}\n`;
  }
  if (ed.find?.open) runFind(false, false); // matches follow the edit; the caret stays where you type
  syncScroll();
  const dirty = text !== ed.saved;
  const save = $('#ed-save');
  if (save) save.disabled = !dirty;
  if (!ed.file.readOnly) $('#ed-state').textContent = dirty ? 'Unsaved changes' : '';
  $('#ed-state').classList.toggle('dirty', dirty);
}

function onEdit() {
  cancelAnimationFrame(ed.raf);
  ed.raf = requestAnimationFrame(() => { render(); showPos(); });
}

function syncScroll() {
  const ta = $('#ed .ed-text');
  if (!ta) return;
  for (const layer of [$('#ed .ed-hl'), $('#ed .ed-marks')]) {
    layer.scrollTop = ta.scrollTop;
    layer.scrollLeft = ta.scrollLeft;
  }
  $('#ed .ed-gutter').scrollTop = ta.scrollTop;
}

function showPos() {
  const ta = $('#ed .ed-text');
  if (!ta) return;
  const before = ta.value.slice(0, ta.selectionStart);
  const line = before.split('\n').length;
  $('#ed-pos').textContent = `Ln ${line}, Col ${before.length - before.lastIndexOf('\n')}`;
}

/** The file's own indent: a tab, or the smallest run of leading spaces it uses (2 by default). */
function indentUnit(text) {
  if (/^\t/m.test(text)) return '\t';
  const sizes = (text.match(/^ +(?=\S)/gm) || []).map(s => s.length);
  return ' '.repeat(Math.min(8, sizes.length ? Math.min(...sizes) : 2));
}

function insert(ta, text) {
  // insertText keeps the textarea's own undo (Ctrl+Z) working.
  if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  onEdit();
}

function onKey(ev) {
  const ta = ev.currentTarget;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveEditor(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') { ev.preventDefault(); openFind(); return; }
  if (ev.key === 'F3' && ed.find?.q) { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); return; }
  if (ev.key === 'Escape') { ev.preventDefault(); if (ed.find?.q) closeFind(); else closeEditor(); return; }
  if (ta.readOnly) return;
  const unit = indentUnit(ta.value);
  if (ev.key === 'Tab') {
    ev.preventDefault();
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    if (!ev.shiftKey && s === e) { insert(ta, unit); return; }
    // A selection (or Shift+Tab): indent or outdent each selected line.
    const block = value.slice(lineStart, e);
    const width = unit === '\t' ? 4 : unit.length;
    const changed = ev.shiftKey ? block.replace(new RegExp(`^(\\t| {1,${width}})`, 'gm'), '') : block.replace(/^/gm, unit);
    ta.setSelectionRange(lineStart, e);
    insert(ta, changed);
    ta.setSelectionRange(lineStart, lineStart + changed.length);
    return;
  }
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
    ev.preventDefault();
    const { selectionStart: s, value } = ta;
    const line = value.slice(value.lastIndexOf('\n', s - 1) + 1, s);
    let lead = line.match(/^[ \t]*/)[0];
    if (/[{[(]\s*$|:\s*$|\b(do|then|function\b.*\))\s*$/.test(line)) lead += unit;
    insert(ta, `\n${lead}`);
  }
}

async function saveEditor() {
  const f = ed.file;
  const ta = $('#ed .ed-text');
  if (!f || !ta || f.readOnly || ta.value === ed.saved) return;
  if (f.lang === 'json') {
    try { JSON.parse(ta.value.replace(/^\s*\/\/[^\n]*$/gm, '')); } catch (err) {
      const go = await edConfirm({ title: 'This JSON has an error', body: h('p', {}, `${err.message}. A mod may not be able to read it. Save anyway?`), buttons: [{ label: 'Keep editing', value: false, safe: true }, { label: 'Save anyway', value: true, kind: 'btn-danger' }] });
      if (!go) return;
    }
  }
  const text = ta.value;
  let r = await api.cfgWrite(f.loc, text, { mtime: f.mtime, eol: f.eol, bom: f.bom });
  if (r.ok?.conflict) {
    const v = await edConfirm({
      title: 'The file changed on disk', body: h('p', {}, 'Something else (the mod, the game or another program) wrote this file since you opened it. Keep your version, or load theirs and lose your changes?'),
      buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Load theirs', value: 'reload' }, { label: 'Save mine', value: 'force', kind: 'btn-primary' }],
    });
    if (v === 'reload') { await reloadEditor(); return; }
    if (v !== 'force') return;
    r = await api.cfgWrite(f.loc, text, { mtime: f.mtime, eol: f.eol, bom: f.bom, force: true });
  }
  if (r.error) { toast(r.error, 'error'); return; }
  f.mtime = r.ok.mtime;
  ed.saved = text;
  $('#ed-restore').hidden = false;
  render();
  $('#ed-state').textContent = 'Saved';
  const name = f.loc.rel.split('/').pop();
  // The mod's other copies of this file that are separate files: change them too?
  const separate = (f.twins || []).filter(t => !t.linked);
  if (separate.length) {
    const labels = separate.map(t => t.label).join(' and ');
    const both = await edConfirm({
      title: `Save to ${labels} too?`,
      body: h('p', {}, `${name} is also in ${labels}, as a separate file. Save the same text there, so both copies match? (Otherwise only ${f.copy || 'this copy'} changes.)`),
      buttons: [{ label: 'Only this copy', value: false, safe: true }, { label: 'Save both', value: true, kind: 'btn-primary' }],
    });
    if (both) {
      const failed = [];
      for (const t of separate) { const w = await api.cfgWriteLike(t.loc, text); if (w.error) failed.push(`${t.label}: ${w.error}`); }
      if (failed.length) toast(`Saved ${name} here, but not in ${failed.join('; ')}`, 'error');
      else toast(`Saved ${name} in ${separate.length + 1} copies`, 'success');
      return;
    }
  }
  toast(`Saved ${name}`, 'success');
}

async function reloadEditor() {
  const r = await api.cfgRead(ed.file.loc);
  if (r.error) { toast(r.error, 'error'); return; }
  Object.assign(ed.file, r.ok);
  ed.saved = r.ok.text;
  $('#ed .ed-text').value = r.ok.text;
  $('#ed-restore').hidden = !r.ok.hasBackup;
  render(true);
}

async function restoreOriginal() {
  const go = await edConfirm({ title: 'Restore the original?', body: h('p', {}, 'The file goes back to how it was before you first saved it here. Your changes since are lost.'), buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Restore', value: true, kind: 'btn-danger' }] });
  if (!go) return;
  const r = await api.cfgRestore(ed.file.loc);
  if (r.error) { toast(r.error, 'error'); return; }
  Object.assign(ed.file, r.ok);
  ed.saved = r.ok.text;
  $('#ed .ed-text').value = r.ok.text;
  render(true);
  toast('The original is back', 'success');
}

/** Close; unsaved changes are saved or dropped first. Resolves false if the user stays. */
async function closeEditor() {
  const ta = $('#ed .ed-text');
  if (ed.file && ta && ta.value !== ed.saved) {
    const v = await edConfirm({
      title: 'Save your changes?', body: h('p', {}, `${ed.file.loc.rel.split('/').pop()} has changes that are not saved.`),
      buttons: [{ label: 'Cancel', value: false, safe: true }, { label: 'Don\'t save', value: 'drop' }, { label: 'Save', value: 'save', kind: 'btn-primary' }],
    });
    if (!v) return false;
    if (v === 'save') { await saveEditor(); if ($('#ed .ed-text').value !== ed.saved) return false; }
  }
  ed.file = null;
  $('#ed-back').hidden = true;
  $('#ed').replaceChildren();
  lockShell(false);
  if (ed.opener && document.contains(ed.opener)) ed.opener.focus();
  return true;
}
