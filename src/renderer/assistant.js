'use strict';
/* global api, $, h, icon, run, toast, goTo, pageHooks, quickDownload, openMod, fmtCount */

// ---------------------------------------------------------------- AI assistant

/*
 * The chat. The engine runs in the main process (it holds the key and the tools); this page draws
 * what it sends: messages, what the assistant looked at, mod cards, and approval cards.
 */
const ai = { view: null, items: [], busy: false, cards: new Map() };

const SUGGESTIONS = [
  'What changed recently, and could it break my game?',
  'Explain my latest errors and how to fix them',
  'Check my mods for updates',
  'Is my load order OK?',
];

// ---- a small, safe markdown, built as DOM (never HTML): headings, paragraphs, nested lists, tables,
// callouts (> [!WARNING]), code blocks, rules, **bold**, *italic*, ~~struck~~, `code`, links, and
// colour tags {error|…} {warn|…} {ok|…} {info|…} {mod|…} {muted|…} mapped to the theme's colours.

const COLOR = { error: 'error', red: 'error', warn: 'warn', warning: 'warn', yellow: 'warn', orange: 'warn', ok: 'ok', green: 'ok', info: 'info', blue: 'info', mod: 'mod', muted: 'muted', gray: 'muted', grey: 'muted' };
const CALLOUT = {
  note: ['info', 'info', 'Note'], info: ['info', 'info', 'Info'],
  tip: ['ok', 'check', 'Tip'], ok: ['ok', 'check', 'OK'], success: ['ok', 'check', 'Fixed'], fixed: ['ok', 'check', 'Fixed'],
  warning: ['warn', 'alert', 'Warning'], warn: ['warn', 'alert', 'Warning'], caution: ['warn', 'alert', 'Caution'],
  error: ['error', 'alert', 'Error'], danger: ['error', 'alert', 'Danger'],
  important: ['mod', 'sparkle', 'Important'],
};

const INLINE = new RegExp([
  '(`[^`\\n]+`)', // 1 code
  '\\{([a-zA-Z]+)\\|([^{}\\n]+)\\}', // 2, 3 colour tag
  '\\*\\*(.+?)\\*\\*', // 4 bold
  '~~(.+?)~~', // 5 struck
  '(?<![\\w*])\\*(?![\\s*])([^*\\n]+?)\\*(?![\\w*])', // 6 italic
  '(?<![\\w])_(?![\\s_])([^_\\n]+?)_(?![\\w])', // 7 italic
  '\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)', // 8, 9 link
  '(https?:\\/\\/[^\\s)<>]+[^\\s)<>.,;:!?])', // 10 bare link
].join('|'), 'g');

function link(label, url) {
  return h('a', { href: '#', title: url, onclick: ev => { ev.preventDefault(); api.openLink(url); } }, label);
}

function inline(text) {
  const out = [];
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('code', {}, m[1].slice(1, -1)));
    else if (m[2]) {
      const c = COLOR[m[2].toLowerCase()];
      out.push(c ? h('span', { class: 'ai-c ai-c-' + c }, inline(m[3])) : m[0]);
    } else if (m[4]) out.push(h('strong', {}, inline(m[4])));
    else if (m[5]) out.push(h('s', {}, inline(m[5])));
    else if (m[6] || m[7]) out.push(h('em', {}, inline(m[6] || m[7])));
    else if (m[8]) out.push(link(m[8], m[9]));
    else out.push(link(m[10], m[10]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const RE = {
  fence: /^\s*```/,
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  rule: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s{0,3}>/,
  item: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};
const indentOf = s => s.replace(/\t/g, '  ').match(/^ */)[0].length;
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-');
const startsBlock = (lines, i) => RE.fence.test(lines[i]) || RE.heading.test(lines[i]) || RE.rule.test(lines[i]) || RE.quote.test(lines[i]) || RE.item.test(lines[i]) || isTableStart(lines, i);
/** A table row's cells. A "|" inside a colour tag {warn|…} or `code` does not split. */
function cells(line) {
  const out = [''];
  let depth = 0;
  let code = false;
  for (const ch of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (ch === '`') code = !code;
    else if (!code && ch === '{') depth++;
    else if (!code && ch === '}' && depth) depth--;
    if (ch === '|' && !depth && !code) out.push('');
    else out[out.length - 1] += ch;
  }
  return out.map(c => c.trim());
}

/** A list starting at lines[i]; deeper-indented items become nested lists. Returns [element, next i]. */
function list(lines, i) {
  const base = indentOf(lines[i]);
  const ordered = /\d/.test(RE.item.exec(lines[i])[2]);
  const items = [];
  while (i < lines.length) {
    const m = RE.item.exec(lines[i]);
    if (!m || indentOf(lines[i]) < base) break;
    if (indentOf(lines[i]) > base) { // a nested list under the previous item
      const [sub, next] = list(lines, i);
      if (items.length) items[items.length - 1].append(sub); else items.push(h('li', {}, sub));
      i = next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    const text = [m[3]];
    // Continuation lines: indented text that is not a new item.
    for (i++; i < lines.length && lines[i].trim() && !RE.item.test(lines[i]) && indentOf(lines[i]) > base && !startsBlock(lines, i); i++) text.push(lines[i].trim());
    const task = /^\[([ xX])\]\s+/.exec(text[0]);
    if (task) text[0] = text[0].slice(task[0].length);
    const li = h('li', { class: task ? 'ai-task-item' : null },
      task ? h('span', { class: 'ai-task ' + (task[1] === ' ' ? 'open' : 'done') }, icon(task[1] === ' ' ? 'minus-circle' : 'check')) : null, inline(text.join('\n')));
    items.push(li);
  }
  return [h(ordered ? 'ol' : 'ul', {}, items), i];
}

function markdown(text) {
  const blocks = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (RE.fence.test(line)) {
      const code = [];
      for (i++; i < lines.length && !RE.fence.test(lines[i]); i++) code.push(lines[i]);
      i++;
      blocks.push(h('pre', { class: 'ai-code' }, h('code', {}, code.join('\n'))));
    } else if (RE.heading.test(line)) {
      const [, hashes, title] = RE.heading.exec(line);
      const level = Math.min(hashes.length, 3);
      blocks.push(h('h' + (level + 2), { class: 'ai-h ai-h' + level }, inline(title)));
      i++;
    } else if (RE.rule.test(line)) {
      blocks.push(h('hr', { class: 'ai-rule' }));
      i++;
    } else if (RE.quote.test(line)) {
      const body = [];
      for (; i < lines.length && RE.quote.test(lines[i]); i++) body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
      const tag = /^\[!(\w+)\]\s*(.*)$/.exec(body[0] || '');
      const kind = tag && CALLOUT[tag[1].toLowerCase()];
      if (kind) {
        const [tone, glyph, label] = kind;
        blocks.push(h('div', { class: 'ai-callout ai-callout-' + tone, role: 'note' },
          h('div', { class: 'ai-callout-head' }, icon(glyph), h('span', {}, tag[2] ? inline(tag[2]) : label)),
          markdown(body.slice(1).join('\n'))));
      } else blocks.push(h('blockquote', { class: 'ai-quote' }, markdown(body.join('\n'))));
    } else if (isTableStart(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map(c => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      const cell = (tag, c, k) => h(tag, align[k] ? { class: 'ai-al-' + align[k] } : {}, inline(c));
      blocks.push(h('div', { class: 'ai-table-wrap' }, h('table', { class: 'ai-table' },
        h('thead', {}, h('tr', {}, head.map((c, k) => cell('th', c, k)))),
        h('tbody', {}, rows.map(r => h('tr', {}, head.map((_, k) => cell('td', r[k] || '', k))))))));
    } else if (RE.item.test(line)) {
      const [el, next] = list(lines, i);
      blocks.push(el);
      i = next;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines, i)); i++) para.push(lines[i].trim());
      blocks.push(h('p', {}, inline(para.join('\n'))));
    }
  }
  return blocks;
}

// ---- items

const STATUS = { pending: '', running: 'Applying…', approved: 'Approved', declined: 'Declined', expired: 'Expired: not answered' };

function proposalEl(p) {
  const pending = p.status === 'pending';
  return h('div', { class: `ai-card ai-proposal ${p.status}`, dataset: { id: p.id } },
    h('div', { class: 'ai-card-head' }, icon('shield'), h('span', { class: 'ai-card-title' }, `The assistant asks to: ${p.title}`),
      !pending ? h('span', { class: `tag ${p.status === 'approved' ? 'tag-ok' : p.status === 'running' ? 'tag-info' : ''}` }, STATUS[p.status]) : null),
    h('ul', { class: 'ai-actions' }, p.actions.map((a, i) => {
      const r = p.results?.[i];
      return h('li', {},
        h('div', { class: 'ai-action-title' }, a.title),
        a.reason ? h('div', { class: 'ai-action-why' }, a.reason) : null,
        a.items?.length ? h('div', { class: 'ai-action-items' }, a.items.slice(0, 12).join(' · ') + (a.items.length > 12 ? ` · and ${a.items.length - 12} more` : '')) : null,
        r ? h('div', { class: `ai-action-result ${r.ok ? 'ok' : 'bad'}` }, r.text) : null);
    })),
    pending ? h('div', { class: 'ai-card-foot' },
      h('span', { class: 'hint' }, 'Nothing changes unless you approve.'),
      h('button', { class: 'btn', onclick: () => decide(p, false) }, 'Decline'),
      h('button', { class: 'btn btn-primary', onclick: () => decide(p, true) }, icon('check'), h('span', {}, 'Approve'))) : null);
}

async function decide(p, approve) {
  const r = await api.aiDecide(p.id, approve);
  if (r.error) toast(r.error, 'error');
}

/** A Nexus mod as in Browse, with Download (the file picker follows) and its page. */
function modCardEl(item) {
  const el = h('div', { class: 'ai-card ai-modcard' }, h('span', { class: 'hint' }, `Loading mod ${item.modId}…`));
  const fill = m => {
    if (!m) { el.replaceChildren(h('span', { class: 'hint' }, `Nexus mod ${item.modId} was not found.`)); return; }
    el.replaceChildren(
      h('div', { class: 'ai-mod-thumb' }, m.thumbnail ? h('img', { src: m.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : icon('package')),
      h('div', { class: 'ai-mod-body' },
        h('div', { class: 'mod-name' }, m.name),
        h('div', { class: 'mod-by' }, [m.author ? `by ${m.author}` : '', m.category, m.version ? `v${m.version}` : ''].filter(Boolean).join(' · ')),
        item.note ? h('p', { class: 'ai-mod-note' }, item.note) : h('p', { class: 'mod-summary' }, m.summary),
        h('div', { class: 'mod-foot' },
          h('span', { class: 'mod-stat', title: 'Endorsements' }, icon('heart'), fmtCount(m.endorsements)),
          h('span', { class: 'mod-stat', title: 'Downloads' }, icon('download'), fmtCount(m.downloads)),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { goTo('browse'); openMod(m); } }, h('span', {}, 'Open page')),
          h('button', { class: 'btn btn-sm btn-primary', title: 'Choose the files to download', onclick: () => quickDownload(m.modId) }, icon('download'), h('span', {}, 'Download')))));
  };
  if (ai.cards.has(item.modId)) fill(ai.cards.get(item.modId));
  else {
    api.searchMods({ query: String(item.modId), perPage: 1, adult: true }).then(r => {
      const m = r.ok?.mods.find(x => x.modId === item.modId) || null;
      ai.cards.set(item.modId, m);
      fill(m);
    });
  }
  return el;
}

function itemEl(it) {
  switch (it.type) {
    case 'user': return h('div', { class: 'ai-msg ai-user' }, h('div', { class: 'ai-bubble' }, it.text));
    case 'assistant': return h('div', { class: 'ai-msg ai-bot' }, h('div', { class: 'ai-bubble' }, markdown(it.text)));
    case 'activity': return h('div', { class: `ai-activity ${it.status || ''}` }, icon(it.status === 'failed' ? 'alert' : it.status === 'running' ? 'activity' : 'check'), h('span', {}, it.text));
    case 'modcard': return modCardEl(it);
    case 'proposal': return proposalEl(it);
    case 'error': return h('div', { class: 'ai-note bad' }, icon('alert'), h('span', {}, it.text));
    default: return h('div', { class: 'ai-note' }, h('span', {}, it.text));
  }
}

function renderChat() {
  const box = $('#ai-chat');
  const v = ai.view;
  $('#ai-setup').hidden = !!v?.configured;
  $('#ai-main').hidden = !v?.configured;
  $('#ai-clear').hidden = !v?.configured;
  $('#ai-model').textContent = v?.model ? `Model: ${v.model}` : '';
  if (!v?.configured) return;
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren(...(ai.items.length ? ai.items.map(itemEl) : [h('div', { class: 'ai-empty' },
    h('div', { class: 'ai-empty-title' }, 'Ask about your mods, errors or setup'),
    h('p', { class: 'hint' }, 'The assistant reads your mods, logs and load order, searches the web, and proposes changes for you to approve.'),
    h('div', { class: 'ai-suggest' }, SUGGESTIONS.map(s => h('button', { class: 'chip', onclick: () => sendText(s) }, s))))]));
  if (ai.busy) box.append(h('div', { class: 'ai-thinking' }, h('span', {}), h('span', {}), h('span', {})));
  if (nearEnd || ai.busy) box.scrollTop = box.scrollHeight;
  $('#ai-send').hidden = ai.busy;
  $('#ai-stop').hidden = !ai.busy;
  $('#ai-input').disabled = false;
}

async function sendText(text) {
  const t = String(text || '').trim();
  if (!t || ai.busy) return;
  $('#ai-input').value = '';
  growInput();
  const r = await api.aiSend(t);
  if (r.error) toast(r.error, 'error');
}

const growInput = () => { const i = $('#ai-input'); i.style.height = 'auto'; i.style.height = `${Math.min(i.scrollHeight + 2, 200)}px`; };

api.onAi(e => {
  if (e.type === 'reset') { ai.items = []; ai.cards.clear(); }
  if (e.type === 'item') ai.items.push(e.item);
  if (e.type === 'update') { const i = ai.items.findIndex(x => x.id === e.item.id); if (i >= 0) ai.items[i] = e.item; }
  if (e.type === 'status') ai.busy = e.busy;
  if ($('#page-ai').classList.contains('active')) renderChat();
  // A request waiting for approval: say so wherever the user is.
  if (e.type === 'item' && e.item.type === 'proposal' && !$('#page-ai').classList.contains('active')) toast('The AI assistant asks for your approval', 'info', { label: 'Show', fn: () => goTo('ai') });
});

async function loadAi() {
  const r = await run(api.aiView());
  if (!r) return;
  ai.view = r;
  ai.items = r.transcript;
  ai.busy = r.busy;
  renderChat();
}

$('#ai-input').addEventListener('input', growInput);
$('#ai-input').addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendText(ev.target.value); }
});
$('#ai-send').addEventListener('click', () => sendText($('#ai-input').value));
$('#ai-stop').addEventListener('click', () => api.aiStop());
$('#ai-clear').addEventListener('click', async () => { if (await run(api.aiClear()) !== null) toast('Chat cleared'); });

/** "Ask AI" from elsewhere in the app: open the chat with the question ready to send. */
function askAi(question) {
  goTo('ai');
  const i = $('#ai-input');
  i.value = question;
  growInput();
  i.focus();
}

pageHooks.ai = () => loadAi().then(() => setTimeout(() => $('#ai-input')?.focus()));
