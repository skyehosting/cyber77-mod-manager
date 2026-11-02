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

// ---- a small, safe markdown: paragraphs, lists, **bold**, `code`, code blocks, links (built as DOM, never HTML)

function inline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)));
    else if (t.startsWith('`')) out.push(h('code', {}, t.slice(1, -1)));
    else {
      const label = t.startsWith('[') ? t.slice(1, t.indexOf('](')) : t;
      const url = t.startsWith('[') ? m[2] : t;
      out.push(h('a', { href: '#', title: url, onclick: ev => { ev.preventDefault(); api.openLink(url); } }, label));
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function markdown(text) {
  const blocks = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      blocks.push(h('pre', { class: 'ai-code' }, h('code', {}, code.join('\n'))));
    } else if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i]); i++) items.push(h('li', {}, inline(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ''))));
      blocks.push(h(ordered ? 'ol' : 'ul', {}, items));
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]); i++) para.push(lines[i].replace(/^#+\s*/, ''));
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
