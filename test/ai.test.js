'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Assistant, openaiRequest, openaiReply, anthropicRequest, anthropicReply, endpointFor } = require('../src/core/ai');
const { makeTools, TOOLS } = require('../src/core/aiTools');

const history = [
  { role: 'user', text: 'hi' },
  { role: 'assistant', text: 'Looking.', calls: [{ id: 'c1', name: 'get_overview', args: {} }] },
  { role: 'tool', results: [{ id: 'c1', name: 'get_overview', content: '{"mods":3}' }] },
  { role: 'assistant', text: 'You have 3 mods.', calls: [] },
];

test('OpenAI-compatible: messages, tool calls and results; no empty tool list', () => {
  const body = openaiRequest({ model: 'm', system: 'sys', history, tools: TOOLS.slice(0, 1) });
  assert.strictEqual(body.messages[0].role, 'system');
  assert.deepStrictEqual(body.messages[2].tool_calls[0], { id: 'c1', type: 'function', function: { name: 'get_overview', arguments: '{}' } });
  assert.deepStrictEqual(body.messages[3], { role: 'tool', tool_call_id: 'c1', content: '{"mods":3}' });
  assert.strictEqual(body.tools[0].function.name, 'get_overview');
  assert.ok(!('tools' in openaiRequest({ model: 'm', system: 's', history, tools: [] })));
  const r = openaiReply({ choices: [{ message: { content: null, tool_calls: [{ id: 'x', function: { name: 'list_mods', arguments: '{"filter":"enabled"}' } }] } }] });
  assert.deepStrictEqual(r, { text: '', calls: [{ id: 'x', name: 'list_mods', args: { filter: 'enabled' } }] });
});

test('Anthropic: tool_use and tool_result blocks, alternating roles', () => {
  const body = anthropicRequest({ model: 'claude', system: 'sys', history, tools: TOOLS.slice(0, 1) });
  assert.strictEqual(body.system, 'sys');
  assert.deepStrictEqual(body.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepStrictEqual(body.messages[1].content[1], { type: 'tool_use', id: 'c1', name: 'get_overview', input: {} });
  assert.deepStrictEqual(body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'c1', content: '{"mods":3}' });
  assert.strictEqual(body.tools[0].input_schema.type, 'object');
  const r = anthropicReply({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't', name: 'get_problems', input: { limit: 5 } }] });
  assert.deepStrictEqual(r, { text: 'ok', calls: [{ id: 't', name: 'get_problems', args: { limit: 5 } }] });
});

test('endpoints: a base URL gets the right path; a full one is kept', () => {
  assert.strictEqual(endpointFor('openai', 'https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(endpointFor('openai', 'http://localhost:11434/v1/chat/completions'), 'http://localhost:11434/v1/chat/completions');
  assert.strictEqual(endpointFor('anthropic', ''), 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(endpointFor('anthropic', 'https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages');
  assert.throws(() => endpointFor('openai', ''), /endpoint/);
});

function fakeSettings() {
  const data = { aiProvider: 'openai', aiEndpoint: 'http://x/v1', aiModel: 'test-model' };
  return { get: k => data[k], aiKey: 'k' };
}

/** A tools object that records what ran; prepare accepts known mods only. */
function fakeTools() {
  const ran = { read: [], act: [] };
  return {
    ran,
    defs: TOOLS,
    kind: n => TOOLS.find(t => t.name === n)?.kind || null,
    read: async (n, a) => { ran.read.push(n); return JSON.stringify({ tool: n, a }); },
    prepare: (n, a) => (a.mods?.includes('Nope') ? { ok: false, error: 'No installed mod matches "Nope".' }
      : { ok: true, action: { tool: n, args: { ids: a.mods }, reason: a.reason, title: `Enable ${a.mods.join(', ')}`, items: a.mods } }),
    act: async a => { ran.act.push(a); return 'Enabled 1 mod(s).'; },
  };
}

/** A model that plays a script: one reply per call. */
function scripted(replies) {
  const seen = [];
  return { seen, call: async ({ history }) => { seen.push(JSON.parse(JSON.stringify(history))); return replies.shift() || { text: 'done', calls: [] }; } };
}

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-ai-')), 'ai-chat.json');

test('the assistant reads freely, but a change is only proposed until the user approves', async () => {
  const tools = fakeTools();
  const model = scripted([
    { text: '', calls: [{ id: 'a', name: 'get_overview', args: {} }] },
    { text: 'Disabled mods may be the cause.', calls: [{ id: 'b', name: 'enable_mods', args: { mods: ['Codeware'], reason: 'AMM needs it' } }] },
    { text: 'I asked to enable Codeware; approve the card if that is OK.', calls: [] },
    { text: 'Thanks, it is enabled now.', calls: [] },
  ]);
  const a = new Assistant({ settings: fakeSettings(), tools, file: file(), call: model.call });
  await a.send('My game crashes');
  assert.deepStrictEqual(tools.ran.read, ['get_overview']);
  assert.deepStrictEqual(tools.ran.act, [], 'nothing changed without approval');
  const card = a.view().transcript.find(x => x.type === 'proposal');
  assert.strictEqual(card.status, 'pending');
  assert.deepStrictEqual(card.actions[0].items, ['Codeware']);
  assert.match(model.seen[2].at(-1).results[0].content, /Nothing has changed yet/, 'the model is told it is only proposed');

  await a.decide(card.id, true);
  assert.strictEqual(tools.ran.act.length, 1);
  assert.strictEqual(a.view().transcript.find(x => x.id === card.id).status, 'approved');
  await a.send('ok what next');
  const lastUser = model.seen.at(-1).filter(t => t.role === 'user').at(-1).text;
  assert.match(lastUser, /^\[request approved: the user approved "Enable Codeware"\. Results: .*Enabled 1 mod/);
  assert.match(lastUser, /ok what next$/);
  assert.ok(!a.view().transcript.some(x => x.type === 'user' && /request approved/.test(x.text)), 'the note is hidden from the chat');
  await assert.rejects(a.decide(card.id, true), /already answered/);
});

test('declined, expired and invalid proposals', async () => {
  const tools = fakeTools();
  const model = scripted([
    { text: '', calls: [{ id: 'a', name: 'enable_mods', args: { mods: ['Nope'], reason: 'x' } }] },
    { text: '', calls: [{ id: 'b', name: 'enable_mods', args: { mods: ['A'], reason: 'x' } }] },
    { text: 'Approve?', calls: [] },
    { text: '', calls: [{ id: 'c', name: 'enable_mods', args: { mods: ['B'], reason: 'y' } }] },
    { text: 'Approve this one?', calls: [] },
    { text: 'Understood.', calls: [] },
  ]);
  const a = new Assistant({ settings: fakeSettings(), tools, file: file(), call: model.call });
  await a.send('fix it');
  assert.match(model.seen[1].at(-1).results[0].content, /No installed mod matches/, 'a bad proposal goes back to the model');
  const first = a.view().transcript.find(x => x.type === 'proposal');
  await a.send('actually, something else'); // the first card is left unanswered
  assert.strictEqual(a.view().transcript.find(x => x.id === first.id).status, 'expired');
  assert.match(model.seen[3].filter(t => t.role === 'user').at(-1).text, /^\[request expired/);
  const second = a.view().transcript.filter(x => x.type === 'proposal').at(-1);
  await a.decide(second.id, false);
  await a.send('fine');
  assert.match(model.seen.at(-1).filter(t => t.role === 'user').at(-1).text, /^\[request declined/);
  assert.deepStrictEqual(tools.ran.act, []);
});

test('the chat is kept between sessions; Clear empties it', async () => {
  const f = file();
  const model = scripted([{ text: 'Hello.', calls: [] }]);
  const a = new Assistant({ settings: fakeSettings(), tools: fakeTools(), file: f, call: model.call });
  await a.send('hi');
  const b = new Assistant({ settings: fakeSettings(), tools: fakeTools(), file: f, call: model.call });
  assert.deepStrictEqual(b.view().transcript.map(x => x.type), ['user', 'assistant']);
  b.clear();
  assert.deepStrictEqual(new Assistant({ settings: fakeSettings(), tools: fakeTools(), file: f, call: model.call }).view().transcript, []);
});

test('a provider error shows in the chat and leaves a usable history', async () => {
  const a = new Assistant({ settings: fakeSettings(), tools: fakeTools(), file: file(), call: async () => { throw new Error('The AI provider answered 401: bad key'); } });
  await a.send('hi');
  assert.strictEqual(a.view().transcript.at(-1).type, 'error');
  assert.strictEqual(a.busy, false);
});

test('the tools: changes are checked against what is installed', () => {
  const mods = [
    { id: 'a1', name: 'ArchiveXL', version: '1.28.6', enabled: true },
    { id: 'vx:cw', name: 'Codeware', version: '1.21.2', enabled: false, vortex: true },
  ];
  const tools = makeTools({
    manager: { snapshot: () => ({ updates: { a1: { version: '1.29.0' } }, conflicts: {} }), loadOrderView: () => ({ archives: [{ name: 'a.archive' }, { name: 'b.archive' }] }) },
    gameLogs: { entries: [], status: () => ({}) }, logger: { history: [] }, web: {}, allMods: () => mods, deployRedmods: async () => null,
  });
  assert.strictEqual(tools.kind('enable_mods'), 'action');
  assert.strictEqual(tools.kind('get_problems'), 'read');
  const en = tools.prepare('enable_mods', { mods: ['codeware'], reason: 'needed' });
  assert.deepStrictEqual([en.ok, en.action.args.ids, en.action.items], [true, ['vx:cw'], ['Codeware v1.21.2 (Vortex)']]);
  assert.match(tools.prepare('enable_mods', { mods: ['Nothing Like It'] }).error, /No installed mod matches/);
  assert.match(tools.prepare('update_mods', { mods: ['Codeware'] }).error, /No update is known/);
  assert.deepStrictEqual(tools.prepare('update_mods', { mods: ['all'] }).action.args.ids, ['a1']);
  assert.deepStrictEqual(tools.prepare('move_archive', { archive: 'B.archive', position: 1 }).action.args, { archive: 'b.archive', to: 0 });
  assert.strictEqual(tools.prepare('format_disk', {}).ok, false, 'only the listed actions exist');
});

test('over HTTP: an OpenAI-style endpoint, a tool round trip, the key in the header, and error messages', async () => {
  const http = require('http');
  const { callModel } = require('../src/core/ai');
  const seen = [];
  let fail = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers['x-api-key'], body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      if (fail) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'Incorrect API key' } })); return; }
      const msgs = JSON.parse(body).messages;
      const hadTool = msgs.some(m => m.role === 'tool');
      res.end(JSON.stringify({ choices: [{ message: hadTool ? { content: 'You have 3 mods.' } : { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_overview', arguments: '{}' } }] } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const settings = { get: k => ({ aiProvider: 'openai', aiEndpoint: endpoint, aiModel: 'local-model' })[k], aiKey: 'sk-test' };
    const a = new Assistant({ settings, tools: fakeTools(), file: file(), call: callModel });
    await a.send('how many mods?');
    assert.strictEqual(seen[0].url, '/v1/chat/completions');
    assert.strictEqual(seen[0].auth, 'Bearer sk-test');
    assert.strictEqual(seen[0].body.model, 'local-model');
    assert.strictEqual(seen[1].body.messages.at(-1).role, 'tool');
    assert.strictEqual(a.view().transcript.at(-1).text, 'You have 3 mods.');
    fail = true;
    await a.send('again');
    assert.match(a.view().transcript.at(-1).text, /401: Incorrect API key/);
    // Anthropic's key header, against the same server (the reply format differs, so only the request is checked).
    await callModel({ provider: 'anthropic', endpoint, key: 'ant-key', model: 'claude-x', history: [{ role: 'user', text: 'hi' }], tools: [] }).catch(() => {});
    assert.strictEqual(seen.at(-1).url, '/v1/messages');
    assert.strictEqual(seen.at(-1).xkey, 'ant-key');
  } finally {
    server.close();
  }
});
