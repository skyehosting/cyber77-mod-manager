'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Assistant } = require('../src/core/ai');
const ctx = require('../src/core/aiContext');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-aictx-')), 'chat.json');
const tools = { defs: [], kind: () => null };
const settingsWith = extra => {
  const data = { aiProvider: 'openai', aiEndpoint: 'http://ai.test/v1', aiModel: 'qwen', ...extra };
  return { get: k => data[k], aiKey: 'k' };
};

test('the context window is asked of the server: llama-swap / llama.cpp props, then the model list', async () => {
  const asked = [];
  const swap = async url => { asked.push(url); return url.endsWith('/props?model=qwen') ? { default_generation_settings: { n_ctx: 262144 } } : null; };
  assert.deepStrictEqual(await ctx.detectContext({ provider: 'openai', endpoint: 'http://h:8080/v1', model: 'qwen' }, swap), { tokens: 262144, source: 'the server (llama.cpp)' });
  assert.strictEqual(asked[0], 'http://h:8080/props?model=qwen');

  const list = async url => (url.endsWith('/v1/models') ? { data: [{ id: 'other' }, { id: 'qwen', context_length: 32768 }] } : null);
  assert.strictEqual((await ctx.detectContext({ provider: 'openai', endpoint: 'http://h/v1', model: 'qwen' }, list)).tokens, 32768);
  const trained = async url => (url.endsWith('/v1/models') ? { data: [{ id: 'qwen', meta: { n_ctx_train: 131072 } }] } : null);
  assert.match((await ctx.detectContext({ provider: 'openai', endpoint: 'http://h/v1', model: 'qwen' }, trained)).source, /trained/);
  assert.strictEqual((await ctx.detectContext({ provider: 'openai', endpoint: 'http://h/v1', model: 'qwen' }, async () => null)).tokens, 0);
  assert.strictEqual((await ctx.detectContext({ provider: 'anthropic', model: 'claude-x' }, async () => null)).tokens, 200000);
});

test('a provider\'s "too long" error is recognised, with the limit it names', () => {
  assert.deepStrictEqual(ctx.contextError(new Error("This model's maximum context length is 128000 tokens. However, you requested 130000")), { over: true, limit: 128000 });
  assert.deepStrictEqual(ctx.contextError(new Error('prompt is too long: 210000 tokens > 200000 maximum')), { over: true, limit: 200000 });
  assert.deepStrictEqual(ctx.contextError(Object.assign(new Error('the request exceeds the available context size, try increasing it'), { contextLimit: 65536 })), { over: true, limit: 65536 });
  assert.strictEqual(ctx.contextError(new Error('401: Incorrect API key')).over, false);
});

test('near the window, the older chat is summarized by the model and the last turns are kept word for word', async () => {
  const calls = [];
  const a = new Assistant({
    settings: settingsWith({ aiContext: 3000 }), tools, file: file(), detect: async () => ({ tokens: 0 }),
    call: async req => {
      calls.push(req.history.map(t => ({ ...t }))); // what was sent then
      if (req.history[0].text.startsWith(ctx.SUMMARY_PROMPT)) return { text: '## Goal\nFix the crash in let_there_be_flight.dll', calls: [], usage: { input: 900, output: 30 } };
      return { text: 'ok', calls: [], usage: { input: 500, output: 5 } };
    },
  });
  const long = 'x'.repeat(2500);
  for (let i = 0; i < 4; i++) await a.send(`question ${i} ${long}`);
  const summaryCall = calls.find(h => h[0].text.startsWith(ctx.SUMMARY_PROMPT));
  assert.ok(summaryCall, 'the model was asked for a summary');
  assert.match(summaryCall[0].text, /USER: question 0/);
  const last = calls.at(-1);
  assert.ok(last[0].text.startsWith(ctx.SUMMARY_HEAD), 'the chat now starts with the summary');
  assert.match(last[0].text, /let_there_be_flight\.dll/);
  assert.match(last.at(-1).text, /^question 3 /, 'the newest message is word for word');
  assert.ok(a.view().transcript.some(x => x.type === 'activity' && /Summarized the earlier chat/.test(x.text)));
  assert.strictEqual(a.view().transcript.filter(x => x.type === 'user').length, 4, 'what the user sees is not shortened');
  assert.ok(a.view().context.compactions >= 1);
});

test('a "too long" answer: the limit is learned, the chat compacted, and the request tried once more', async () => {
  let n = 0;
  const a = new Assistant({
    settings: settingsWith({}), tools, file: file(), detect: async () => ({ tokens: 0 }),
    call: async req => {
      if (req.history[0].text.startsWith(ctx.SUMMARY_PROMPT)) return { text: 'summary', calls: [], usage: { input: 10, output: 2 } };
      n++;
      if (n === 3) throw Object.assign(new Error('The AI provider answered 400: the request exceeds the available context size'), { contextLimit: 6000 });
      return { text: 'fine', calls: [], usage: { input: Math.round(JSON.stringify(req.history).length * 0.3), output: 2 } };
    },
  });
  await a.send(`one ${'y'.repeat(12000)}`);
  await a.send(`two ${'y'.repeat(12000)}`);
  await a.send('three');
  assert.strictEqual(a.view().transcript.at(-1).text, 'fine', 'answered after compacting');
  assert.strictEqual(a.view().context.tokens, 6000);
  assert.match(a.view().context.source, /too long/);
});

test('an error sent with HTTP 200 (llama-swap) is an error, and a "too long" one names its limit', async () => {
  const http = require('http');
  const { callModel } = require('../src/core/ai');
  // The exact body llama.cpp sends through llama-swap for a prompt over the window, with status 200.
  const body = { error: { code: 400, message: 'request (280814 tokens) exceeds the available context size (262144 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 280814, n_ctx: 262144 } };
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const err = await callModel({ provider: 'openai', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'm', history: [{ role: 'user', text: 'hi' }], tools: [] }).catch(e => e);
    assert.match(err.message, /answered 400: request \(280814 tokens\) exceeds/);
    assert.deepStrictEqual(ctx.contextError(err), { over: true, limit: 262144 });
    // Without n_ctx, the number in the message is enough.
    assert.deepStrictEqual(ctx.contextError(new Error(body.error.message)), { over: true, limit: 262144 });
  } finally { server.close(); }
});

test('every server\'s own way of saying its context size is understood', async () => {
  const only = (path, body) => async url => (url.endsWith(path) ? body : null);
  const at = async (get, model = 'm', endpoint = 'http://h:1/v1') => (await ctx.detectContext({ provider: 'openai', endpoint, model }, get)).tokens;
  assert.strictEqual(await at(only('/api/ps', { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 32768 }] }), 'qwen3:8b'), 32768, 'Ollama');
  assert.strictEqual(await at(only('/api/v1/models', { models: [{ key: 'm', max_context_length: 131072, loaded_instances: [{ config: { context_length: 16384 } }] }] })), 16384, 'LM Studio: the loaded size');
  assert.strictEqual(await at(only('/api/extra/true_max_context_length', { value: 16384 })), 16384, 'KoboldCpp');
  assert.strictEqual(await at(only('/v1/models/capabilities', { data: [{ id: 'm', context_size: 8192 }] })), 8192, 'LocalAI');
  assert.strictEqual(await at(only('/v1/model', { id: 'm', parameters: { max_seq_len: 65536 } })), 65536, 'TabbyAPI');
  assert.strictEqual(await at(only('/v1/models', { data: [{ id: 'm', max_model_len: 40960 }] })), 40960, 'vLLM');
  assert.strictEqual(await at(only('/v1/models', [{ id: 'm', context_length: 131072 }])), 131072, 'Together (a bare list)');
  assert.strictEqual(await at(only('/v1/models', { data: [{ id: 'm', context_window: 131072 }] })), 131072, 'Groq');
  // llama-swap's props wins over its model list.
  const swap = async url => (url.endsWith('/props?model=m') ? { default_generation_settings: { n_ctx: 262144 } } : url.endsWith('/v1/models') ? { data: [{ id: 'm', context_length: 1000 }] } : null);
  assert.strictEqual(await at(swap), 262144);
  const anth = async url => (url.endsWith('/v1/models/claude-x') ? { id: 'claude-x', max_input_tokens: 1000000 } : null);
  assert.strictEqual((await ctx.detectContext({ provider: 'anthropic', model: 'claude-x' }, anth)).tokens, 1000000);
});

test('the "too long" wording of each provider, with the limit read from it', () => {
  const limit = t => ctx.contextError(new Error(t));
  assert.deepStrictEqual(limit('Input tokens exceed the configured limit of 272,000 tokens. Your messages resulted in 297,006 tokens.'), { over: true, limit: 272000 });
  assert.deepStrictEqual(limit('The input token count (135538) exceeds the maximum number of tokens allowed (131072).'), { over: true, limit: 131072 });
  assert.deepStrictEqual(limit('Prompt contains 321774 tokens and 0 draft tokens, too large for model with 262144 maximum context length'), { over: true, limit: 262144 });
  assert.deepStrictEqual(limit("This model's maximum context length is 65536 tokens. However, your prompt contains at least 70000 input tokens"), { over: true, limit: 65536 });
  assert.deepStrictEqual(limit('Prompt length 9000 exceeds the available context size of 8192 tokens (this model\'s maximum context length)'), { over: true, limit: 8192 });
  assert.deepStrictEqual(limit('Input validation error: `inputs` tokens + `max_new_tokens` must be <= 4097. Given: 4271 `inputs` tokens'), { over: true, limit: 4097 });
  assert.deepStrictEqual(ctx.contextError(Object.assign(new Error('400: bad'), { errorType: 'context_length_exceeded' })), { over: true, limit: 0 });
  assert.strictEqual(limit('Rate limit reached, try again in 20s').over, false);
  assert.strictEqual(limit('Incorrect API key provided').over, false);
});

test('a server that silently cuts a long chat (Ollama): noticed, its size learned, the chat compacted and asked again', async () => {
  const sent = [];
  const a = new Assistant({
    settings: settingsWith({}), tools, file: file(), detect: async () => ({ tokens: 0 }),
    call: async req => {
      if (req.history[0].text.startsWith(ctx.SUMMARY_PROMPT)) return { text: 'summary of it', calls: [], usage: { input: 900, output: 10 } };
      const chars = JSON.stringify(req.history).length;
      sent.push(chars);
      // Reads at most 4,000 tokens of what it is sent (about 0.3 a character), says nothing, answers anyway.
      return { text: 'answer', calls: [], usage: { input: Math.min(4000, Math.round((chars + 4900) * 0.3)), output: 3 } };
    },
  });
  await a.send('hello'); // a short chat first: the model's own rate is learned
  await a.send(`first ${'z'.repeat(12000)}`);
  await a.send(`second ${'z'.repeat(12000)}`);
  assert.match(a.view().context.source, /only part of the chat/);
  assert.ok(a.view().context.tokens >= 4000 && a.view().context.tokens <= 4400, String(a.view().context.tokens));
  assert.ok(sent.at(-1) < Math.max(...sent), 'asked again with the shorter chat');
  assert.ok(a.view().transcript.some(x => x.type === 'activity' && /Summarized/.test(x.text)));
});

test('the AI reads public web pages only: not this PC, the local network or link-local addresses', () => {
  const { isPublicUrl } = require('../src/core/web');
  for (const u of ['https://www.nexusmods.com/cyberpunk2077/mods/1', 'https://github.com/x', 'http://example.com/a?b=c']) assert.strictEqual(isPublicUrl(u), true, u);
  for (const u of ['http://localhost:8080', 'http://127.0.0.1:3000', 'http://10.0.0.249:8080/v1', 'http://192.168.1.1', 'http://172.20.0.1', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://router.lan', 'http://nas.local', 'http://intranet', 'file:///C:/x', 'ftp://example.com']) assert.strictEqual(isPublicUrl(u), false, u);
});
