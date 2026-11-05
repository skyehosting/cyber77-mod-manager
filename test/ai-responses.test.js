'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { responsesRequest, responsesReply, usesResponses, openaiRequest } = require('../src/core/ai');
const { Settings } = require('../src/core/settings');

/*
 * OpenAI's own endpoint through its Responses API (its reasoning models take tools only there), and
 * the reasoning effort setting. Shapes from openai-node's responses.ts and OpenAI's function-calling
 * and reasoning guides.
 */

const tool = { name: 'get_mod', description: 'One mod', params: { mod: { type: 'string' } }, required: ['mod'] };

test('OpenAI itself goes through the Responses API; other servers and written-out paths keep chat completions', () => {
  assert.strictEqual(usesResponses('openai', 'https://api.openai.com/v1'), true);
  assert.strictEqual(usesResponses('openai', 'https://API.OpenAI.com/v1/'), true);
  assert.strictEqual(usesResponses('openai', 'https://api.openai.com/v1/chat/completions'), false);
  assert.strictEqual(usesResponses('openai', 'http://localhost:11434/v1'), false);
  assert.strictEqual(usesResponses('openai', 'https://api.openai.com.evil.example/v1'), false);
  assert.strictEqual(usesResponses('anthropic', 'https://api.openai.com/v1'), false);
  assert.strictEqual(usesResponses('openai', 'not a url'), false);
});

test('the Responses request: instructions, the chat as input items, flat tools, stateless, effort only when chosen', () => {
  const history = [
    { role: 'user', text: 'Why does it crash?' },
    { role: 'assistant', text: 'Looking.', calls: [{ id: 'call_1', name: 'get_mod', args: { mod: 'RED4ext' } }] },
    { role: 'tool', results: [{ id: 'call_1', name: 'get_mod', content: 'RED4ext 1.31' }] },
  ];
  const body = responsesRequest({ model: 'gpt-6.1-terra', system: 'You help.', history, tools: [tool] });
  assert.strictEqual(body.instructions, 'You help.');
  assert.strictEqual(body.store, false, 'nothing kept at OpenAI');
  assert.deepStrictEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepStrictEqual(body.input, [
    { role: 'user', content: 'Why does it crash?' },
    { role: 'assistant', content: 'Looking.' },
    { type: 'function_call', call_id: 'call_1', name: 'get_mod', arguments: '{"mod":"RED4ext"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'RED4ext 1.31' },
  ]);
  assert.deepStrictEqual(body.tools, [{ type: 'function', name: 'get_mod', description: 'One mod', parameters: { type: 'object', properties: { mod: { type: 'string' } }, required: ['mod'] }, strict: false }]);
  assert.ok(!('reasoning' in body), 'the model\'s own default');
  assert.deepStrictEqual(responsesRequest({ model: 'm', system: '', history: [], tools: [], effort: 'high' }).reasoning, { effort: 'high' });
  assert.ok(!('reasoning' in responsesRequest({ model: 'm', system: '', history: [], tools: [], effort: 'loud' })), 'unknown: left out');
  assert.ok(!('tools' in responsesRequest({ model: 'm', system: '', history: [], tools: [] })), 'no empty tool list');
});

test('a reply\'s own output goes back word for word to the same model (reasoning included); to another model, rebuilt', () => {
  const raw = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA…' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_mod', arguments: '{"mod":"A"}', status: 'completed' },
  ];
  const history = [
    { role: 'user', text: 'Check A' },
    { role: 'assistant', text: '', calls: [{ id: 'call_1', name: 'get_mod', args: { mod: 'A' } }], raw, rawModel: 'gpt-6.1-terra' },
    { role: 'tool', results: [{ id: 'call_1', name: 'get_mod', content: 'A is fine' }] },
  ];
  const same = responsesRequest({ model: 'gpt-6.1-terra', system: '', history, tools: [] }).input;
  assert.deepStrictEqual(same.slice(1, 3), raw);
  assert.deepStrictEqual(same[3], { type: 'function_call_output', call_id: 'call_1', output: 'A is fine' });
  const other = responsesRequest({ model: 'gpt-5.5', system: '', history, tools: [] }).input;
  assert.deepStrictEqual(other[1], { type: 'function_call', call_id: 'call_1', name: 'get_mod', arguments: '{"mod":"A"}' }, 'another model\'s reasoning is not sent');
  // Chat completions never sees it.
  const chat = openaiRequest({ model: 'x', system: '', history, tools: [] });
  assert.ok(!JSON.stringify(chat).includes('encrypted_content'));
});

test('the Responses reply: text from message items, calls from function_call items, the raw output, tokens', () => {
  const output = [
    { type: 'reasoning', id: 'rs_9', summary: [], encrypted_content: 'x' },
    { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'It is ' }, { type: 'output_text', text: 'RED4ext.' }] },
    { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_mod', arguments: '{"mod":"B"}' },
    { type: 'function_call', id: 'fc_3', call_id: 'call_3', name: 'get_mod', arguments: 'not json' },
  ];
  const r = responsesReply({ status: 'completed', output, usage: { input_tokens: 1200, output_tokens: 300, input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 250 } } });
  assert.strictEqual(r.text, 'It is RED4ext.');
  assert.deepStrictEqual(r.calls, [{ id: 'call_2', name: 'get_mod', args: { mod: 'B' } }, { id: 'call_3', name: 'get_mod', args: {} }]);
  assert.strictEqual(r.raw, output);
  assert.deepStrictEqual(r.usage, { input: 1200, output: 300 });
  assert.ok(!('cached' in r), 'input_tokens already includes the cached ones: not counted twice');
  // Stopped while thinking: nothing to show or send back, and the user is told why.
  assert.throws(() => responsesReply({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', id: 'rs', summary: [] }] }), /stopped before it answered \(max_output_tokens\).*Reasoning effort/);
  assert.throws(() => responsesReply({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Let me look' }] }, { type: 'function_call', call_id: 'c', name: 'get_mod', arguments: '{"mod":"Red' }] }), /stopped before it answered/, 'cut off inside a call: not run with its arguments missing');
  const part = responsesReply({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Half an' }] }] });
  assert.strictEqual(part.text, 'Half an');
  assert.strictEqual(part.incomplete, 'max_output_tokens');
  // A call without its id: one is made up, and the output is not kept (it would not match).
  assert.ok(!('raw' in responsesReply({ output: [{ type: 'function_call', name: 'get_mod', arguments: '{}' }] })));
  assert.throws(() => responsesReply({}), /no reply/);
});

test('sent back: only the current question\'s steps, never a reasoning item with nothing after it; plain leaves it all out', () => {
  const rawOld = [{ type: 'reasoning', id: 'rs_old', summary: [] }, { type: 'message', id: 'm_old', content: [{ type: 'output_text', text: 'Earlier answer' }] }];
  const rawNow = [{ type: 'reasoning', id: 'rs_a', summary: [] }, { type: 'reasoning', id: 'rs_b', summary: [] }, { type: 'function_call', id: 'fc', call_id: 'c9', name: 'get_mod', arguments: '{}' }, { type: 'reasoning', id: 'rs_tail', summary: [] }];
  const history = [
    { role: 'user', text: 'First question' },
    { role: 'assistant', text: 'Earlier answer', calls: [], raw: rawOld, rawModel: 'm' },
    { role: 'user', text: 'Second question' },
    { role: 'assistant', text: '', calls: [{ id: 'c9', name: 'get_mod', args: {} }], raw: rawNow, rawModel: 'm' },
    { role: 'tool', results: [{ id: 'c9', name: 'get_mod', content: 'ok' }] },
  ];
  const input = responsesRequest({ model: 'm', system: '', history, tools: [] }).input;
  assert.deepStrictEqual(input[1], { role: 'assistant', content: 'Earlier answer' }, 'an earlier question: its text only');
  assert.deepStrictEqual(input.slice(3, 5).map(i => i.id), ['rs_b', 'fc'], 'reasoning only right before what it led to; none at the end');
  const plain = responsesRequest({ model: 'm', system: '', history, tools: [], plain: true }).input;
  assert.ok(!plain.some(i => i.type === 'reasoning'));
  assert.deepStrictEqual(plain[3], { type: 'function_call', call_id: 'c9', name: 'get_mod', arguments: '{}' });
});

test('a model that does not take the reasoning effort is asked again without it, and the chat carries on', async () => {
  const http = require('http');
  const { callModel } = require('../src/core/ai');
  const bodies = [];
  const server = http.createServer((req, res) => {
    let s = '';
    req.on('data', c => { s += c; });
    req.on('end', () => {
      const b = JSON.parse(s);
      bodies.push(b);
      res.setHeader('Content-Type', 'application/json');
      if ('reasoning_effort' in b) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: 'invalid_request_error' } })); return; }
      res.end(JSON.stringify({ choices: [{ message: { content: 'Hello' } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await callModel({ provider: 'openai', endpoint: `http://127.0.0.1:${server.address().port}/v1`, key: 'k', model: 'gpt-4.1', history: [{ role: 'user', text: 'hi' }], tools: [], timeoutMs: 5000, effort: 'high' });
    assert.strictEqual(r.text, 'Hello');
    assert.deepStrictEqual(bodies.map(b => b.reasoning_effort), ['high', undefined]);
    // Remembered: the next step does not ask with it (no refused round trip each time).
    await callModel({ provider: 'openai', endpoint: `http://127.0.0.1:${server.address().port}/v1`, key: 'k', model: 'gpt-4.1', history: [{ role: 'user', text: 'again' }], tools: [], timeoutMs: 5000, effort: 'high' });
    assert.deepStrictEqual(bodies.map(b => b.reasoning_effort), ['high', undefined, undefined]);
  } finally {
    server.close();
  }
});

test('chat completions: reasoning_effort only when one is chosen; the setting keeps known values only', () => {
  assert.ok(!('reasoning_effort' in openaiRequest({ model: 'm', system: '', history: [], tools: [] })));
  assert.strictEqual(openaiRequest({ model: 'm', system: '', history: [], tools: [], effort: 'low' }).reasoning_effort, 'low');
  const s = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-air-')), null);
  assert.strictEqual(s.get('aiReasoning'), '');
  s.update({ aiReasoning: 'high' });
  assert.strictEqual(s.get('aiReasoning'), 'high');
  s.update({ aiReasoning: 'turbo' });
  assert.strictEqual(s.get('aiReasoning'), 'high', 'unknown: ignored');
  s.update({ aiReasoning: '' });
  assert.strictEqual(s.get('aiReasoning'), '');
});

test('the assistant keeps a reply\'s raw output with the model that wrote it, sends the chosen effort, and the next step carries it', async () => {
  const { Assistant } = require('../src/core/ai');
  const { TOOLS } = require('../src/core/aiTools');
  const data = { aiProvider: 'openai', aiEndpoint: 'https://api.openai.com/v1', aiModel: 'gpt-6.1-terra', aiReasoning: 'medium' };
  const settings = { get: k => data[k], aiKey: 'k' };
  const tools = { defs: TOOLS, kind: n => TOOLS.find(t => t.name === n)?.kind || null, read: async n => `read ${n}`, prepare: () => ({ ok: false, error: 'no' }), act: async () => '' };
  const raw = [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' }, { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'get_overview', arguments: '{}' }];
  const seen = [];
  const replies = [{ text: '', calls: [{ id: 'c1', name: 'get_overview', args: {} }], raw }, { text: 'All good.', calls: [], raw: [] }];
  const call = async opts => { seen.push({ effort: opts.effort, history: JSON.parse(JSON.stringify(opts.history)) }); return replies.shift(); };
  const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings, tools, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-air-')), 'chat.json'), call });
  await a.send('Is my setup OK?');
  assert.deepStrictEqual(seen.map(s => s.effort), ['medium', 'medium']);
  const turn = seen[1].history.find(t => t.role === 'assistant');
  assert.deepStrictEqual(turn.raw, raw, 'the second step has the first one\'s output, reasoning included');
  assert.strictEqual(turn.rawModel, 'gpt-6.1-terra');
  // It is sent back word for word in the request itself.
  assert.deepStrictEqual(responsesRequest({ model: 'gpt-6.1-terra', system: '', history: seen[1].history, tools: [] }).input.slice(1, 3), raw);
});

test('a new question drops the earlier replies\' raw output (never sent again), keeping their text and calls', async () => {
  const { Assistant } = require('../src/core/ai');
  const { TOOLS } = require('../src/core/aiTools');
  const data = { aiProvider: 'openai', aiEndpoint: 'https://api.openai.com/v1', aiModel: 'm', aiReasoning: '' };
  const tools = { defs: TOOLS, kind: () => null, read: async () => '', prepare: () => ({ ok: false }), act: async () => '' };
  const replies = [{ text: 'First answer', calls: [], raw: [{ type: 'message', content: [{ type: 'output_text', text: 'First answer' }] }] }, { text: 'Second', calls: [] }];
  const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings: { get: k => data[k], aiKey: 'k' }, tools, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-air-')), 'chat.json'), call: async () => replies.shift() });
  await a.send('one');
  assert.ok(a.state.history.find(t => t.role === 'assistant').raw, 'kept while it is the current question');
  await a.send('two');
  const first = a.state.history.find(t => t.role === 'assistant');
  assert.ok(!('raw' in first) && !('rawModel' in first));
  assert.strictEqual(first.text, 'First answer');
});
