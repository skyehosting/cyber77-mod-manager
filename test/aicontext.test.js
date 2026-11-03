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
  assert.strictEqual((await ctx.detectContext({ provider: 'anthropic', model: 'claude-x' })).tokens, 200000);
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
      if (n === 3) throw Object.assign(new Error('The AI provider answered 400: the request exceeds the available context size'), { contextLimit: 2000 });
      return { text: 'fine', calls: [], usage: { input: 100, output: 2 } };
    },
  });
  await a.send(`one ${'y'.repeat(3000)}`);
  await a.send(`two ${'y'.repeat(3000)}`);
  await a.send('three');
  assert.strictEqual(a.view().transcript.at(-1).text, 'fine', 'answered after compacting');
  assert.strictEqual(a.view().context.tokens, 2000);
  assert.match(a.view().context.source, /too long/);
});
