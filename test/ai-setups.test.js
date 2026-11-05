'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { Assistant } = require('../src/core/ai');
const { TOOLS } = require('../src/core/aiTools');

/* The AI chat's settings column: saved setups (each with its own key), and Steps per question. */

// Stands in for Electron's safeStorage: "encrypted" means reversed and tagged here.
const cipher = { available: () => true, encrypt: s => `enc:${[...s].reverse().join('')}`, decrypt: s => [...s.slice(4)].reverse().join('') };
const fresh = () => new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-setup-')), cipher);

test('a saved setup keeps format, endpoint, model, reasoning, limits and the key (encrypted), and switches them all back', () => {
  const s = fresh();
  s.update({ aiProvider: 'openai', aiEndpoint: 'http://127.0.0.1:8080/v1', aiModel: 'qwen3-local', aiReasoning: '', aiMaxSteps: 0, aiTimeout: 20, aiContext: 262144 });
  s.saveAiPreset('Local');
  s.update({ aiEndpoint: 'https://api.openai.com/v1', aiModel: 'gpt-6.1-terra', aiReasoning: 'high', aiMaxSteps: 30, aiTimeout: 5, aiContext: 0, aiKey: 'sk-test-1234' });
  s.saveAiPreset('OpenAI');
  const stored = s.store.data.aiPresets.find(p => p.name === 'OpenAI');
  assert.strictEqual(stored.keyEnc, 'enc:4321-tset-ks', 'encrypted like the key in use');
  assert.strictEqual(stored.keyPlain, '');
  s.applyAiPreset(s.store.data.aiPresets.find(p => p.name === 'Local').id);
  assert.deepStrictEqual(['aiEndpoint', 'aiModel', 'aiReasoning', 'aiMaxSteps', 'aiTimeout', 'aiContext'].map(k => s.get(k)), ['http://127.0.0.1:8080/v1', 'qwen3-local', '', 0, 20, 262144]);
  assert.strictEqual(s.aiKey, '', 'the local setup had no key');
  s.applyAiPreset(stored.id);
  assert.strictEqual(s.aiKey, 'sk-test-1234');
  assert.strictEqual(s.get('aiMaxSteps'), 30);
});

test('keys never reach the window: the public view says only whether a setup has one, and its last 4', () => {
  const s = fresh();
  s.update({ aiKey: 'sk-secret-9876', aiModel: 'm' });
  s.saveAiPreset('With key');
  const view = s.publicView();
  assert.ok(!JSON.stringify(view).includes('secret'));
  assert.ok(!JSON.stringify(view).includes('enc:'));
  assert.deepStrictEqual(view.aiPresets.map(p => [p.name, p.hasKey, p.keyHint]), [['With key', true, '••••••••9876']]);
  assert.ok(!('keyEnc' in view.aiPresets[0]) && !('keyPlain' in view.aiPresets[0]));
});

test('setup names: trimmed, same name replaces, at most 20, deleting leaves the settings in use', () => {
  const s = fresh();
  assert.throws(() => s.saveAiPreset('   '), /name/);
  s.update({ aiModel: 'a' });
  s.saveAiPreset('  Local\n  model ');
  s.update({ aiModel: 'b' });
  s.saveAiPreset('local model');
  assert.deepStrictEqual(s.store.data.aiPresets.map(p => [p.name, p.model]), [['local model', 'b']]);
  for (let i = 0; i < 19; i++) s.saveAiPreset(`n${i}`);
  assert.throws(() => s.saveAiPreset('one more'), /20/);
  s.deleteAiPreset(s.store.data.aiPresets[0].id);
  assert.strictEqual(s.store.data.aiPresets.length, 19);
  assert.strictEqual(s.get('aiModel'), 'b');
  assert.throws(() => s.applyAiPreset('nope'), /no longer exists/);
});

test('Steps per question: kept between 0 and 500; 0 means no limit', () => {
  const s = fresh();
  assert.strictEqual(s.get('aiMaxSteps'), 12);
  s.update({ aiMaxSteps: '0' });
  assert.strictEqual(s.get('aiMaxSteps'), 0);
  s.update({ aiMaxSteps: 9999 });
  assert.strictEqual(s.get('aiMaxSteps'), 500);
  s.update({ aiMaxSteps: '' });
  assert.strictEqual(s.get('aiMaxSteps'), 500, 'an empty field changes nothing');
});

function assistant(data, replies) {
  const settings = { get: k => data[k], aiKey: '' };
  const tools = { defs: TOOLS, kind: n => TOOLS.find(t => t.name === n)?.kind || null, read: async (n, a) => `read ${n} ${JSON.stringify(a)}`, prepare: () => ({ ok: false }), act: async () => '' };
  let n = 0;
  const call = async () => { n++; return replies(n); };
  const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings, tools, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-steps-')), 'chat.json'), call });
  return { a, calls: () => n };
}

test('the step limit comes from the setting; at the limit it says which setting that is', async () => {
  // A model that reads something new each step, forever.
  const { a, calls } = assistant({ aiProvider: 'openai', aiEndpoint: 'http://x/v1', aiModel: 'm', aiMaxSteps: 3 }, n => ({ text: '', calls: [{ id: `c${n}`, name: 'get_mod', args: { mod: `M${n}` } }] }));
  await a.send('go');
  assert.strictEqual(calls(), 3);
  assert.match(a.view().transcript.at(-1).text, /stopped after 3 steps.*Steps per question/);
});

test('no limit (0): it goes on past 12 steps, but going round in circles (only repeated reads, three steps in a row) stops it', async () => {
  const { a, calls } = assistant({ aiProvider: 'openai', aiEndpoint: 'http://x/v1', aiModel: 'm', aiMaxSteps: 0 }, n => (n <= 20
    ? { text: '', calls: [{ id: `c${n}`, name: 'get_mod', args: { mod: `M${n}` } }] }
    : { text: '', calls: [{ id: `c${n}`, name: 'get_mod', args: { mod: 'M1' } }] }));
  await a.send('go');
  assert.strictEqual(calls(), 23, '20 new reads, then 3 repeats');
  assert.match(a.view().transcript.at(-1).text, /kept repeating what it had already done/);
});

test('a setup without a key clears the key in use (no other provider\'s key goes to it); one whose key cannot be read changes nothing', () => {
  const s = fresh();
  s.update({ aiModel: 'local', aiEndpoint: 'http://127.0.0.1:8080/v1' });
  s.saveAiPreset('Local');
  s.update({ aiModel: 'cloud', aiEndpoint: 'https://api.openai.com/v1', aiKey: 'sk-cloud-1111' });
  assert.strictEqual(s.aiKeySaved(), false, 'the key in use is in no setup yet');
  s.saveAiPreset('Cloud');
  assert.strictEqual(s.aiKeySaved(), true);
  const [local, cloud] = s.store.data.aiPresets;
  s.applyAiPreset(local.id);
  assert.strictEqual(s.aiKey, '');
  // Windows' encryption changed: the saved key no longer decrypts.
  cloud.keyEnc = 'garbage';
  const broken = new Settings(s.store.file ? path.dirname(s.store.file) : '', { available: () => true, encrypt: cipher.encrypt, decrypt: () => { throw new Error('bad'); } });
  broken.store.data.aiPresets = s.store.data.aiPresets;
  assert.throws(() => broken.applyAiPreset(cloud.id), /could not be read/);
  assert.strictEqual(broken.get('aiModel'), s.get('aiModel'), 'nothing changed');
});

test('a hand-broken saved setup is left out, not a crash', () => {
  const s = fresh();
  s.store.data.aiPresets = [null, { id: 3, name: 'x' }, { id: 'ok', name: 'Fine', model: 'm' }, 'text'];
  assert.deepStrictEqual(s.publicView().aiPresets.map(p => p.name), ['Fine']);
  s.update({ aiModel: 'n' });
  assert.strictEqual(s.saveAiPreset('New'), 'New');
});

test('no limit: a model that keeps calling a tool that does not exist is stopped too', async () => {
  const { a, calls } = assistant({ aiProvider: 'openai', aiEndpoint: 'http://x/v1', aiModel: 'm', aiMaxSteps: 0 }, n => ({ text: '', calls: [{ id: `c${n}`, name: 'make_coffee', args: { n } }] }));
  await a.send('go');
  assert.strictEqual(calls(), 3);
  assert.match(a.view().transcript.at(-1).text, /kept repeating/);
});
