'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');
const { NexusClient } = require('../src/core/nexus');

const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-cat-'));
  const settings = new Settings(path.join(root, 'ud'), null);
  const mgr = new ModManager({ settings, log: quiet });
  const mod = (id, name, modId) => {
    mgr.data.mods[id] = { id, key: id, name, modName: name, modId, fileId: 0, game: 'cyberpunk2077', version: '1.0', files: [], enabled: true, priority: mgr.data.nextPriority++ };
  };
  mod('hair', 'Hair Pack', 500);
  mod('cet', 'Cyber Engine Tweaks', 107);
  mod('local', 'My Own Mod', 0);
  mgr.nexus.findModsByName = async () => [];
  mgr.reqLookupGap = 0;
  return mgr;
}

test('each mod\'s Nexus category is read with its requirements, kept, and sent to the Mods page', async () => {
  const mgr = setup();
  const asked = [];
  mgr.nexus.requirementsMany = async (game, ids, cats) => {
    asked.push([...ids].sort());
    cats.set(500, 'Appearance');
    cats.set(107, 'Modders Resources');
    return new Map();
  };
  assert.strictEqual(await mgr.refreshRequirements(), 2);
  assert.deepStrictEqual(asked, [[107, 500]], 'one request for both; the local mod is never asked');
  assert.deepStrictEqual(mgr.snapshot().modCats, { 107: 'Modders Resources', 500: 'Appearance' });
  // Fresh: not asked again.
  assert.strictEqual(await mgr.refreshRequirements(), 0);
  // Requirements still fresh (3 days) but a category over 7 days old: asked again.
  mgr.data.modCategories[500].at -= 8 * 86400000;
  mgr.nexus.requirementsMany = async (game, ids) => { asked.push(ids); return new Map(); };
  assert.strictEqual(await mgr.refreshRequirements(), 1);
  assert.deepStrictEqual(asked.at(-1), [500]);
  assert.strictEqual(mgr.data.modCategories[500].name, 'Appearance', 'left out of a short answer: the known category stays');
  // Nexus answered for it, with no category: none known (Unassigned).
  mgr.data.modCategories[500].at -= 8 * 86400000;
  mgr.nexus.requirementsMany = async (game, ids, cats) => { cats.set(500, ''); return new Map(); };
  assert.strictEqual(await mgr.refreshRequirements(), 1);
  assert.deepStrictEqual(mgr.snapshot().modCats, { 107: 'Modders Resources' });
});

test('a mod cached before categories were read is asked again once, so its category arrives', async () => {
  const mgr = setup();
  const at = Date.now();
  mgr.data.requirements = { 500: { at, list: [] }, 107: { at, list: [] } };
  const asked = [];
  mgr.nexus.requirementsMany = async (game, ids, cats) => { asked.push(ids); for (const id of ids) cats.set(id, 'Gameplay'); return new Map(); };
  assert.strictEqual(await mgr.refreshRequirements(), 2);
  assert.strictEqual(await mgr.refreshRequirements(), 0);
  assert.strictEqual(asked.length, 1);
});

test('the snapshot sends only well-formed categories (a damaged library sends nothing odd)', () => {
  const mgr = setup();
  mgr.data.modCategories = JSON.parse('{"500":{"at":1,"name":"Appearance"},"__proto__":{"at":1,"name":"Bad"},"x1":{"at":1,"name":"Bad"},"07":{"at":1,"name":"Bad"},"108":{"at":1,"name":5},"109":null}');
  const cats = mgr.snapshot().modCats;
  assert.deepStrictEqual(Object.keys(cats), ['500']);
  assert.strictEqual(Object.getPrototypeOf(cats), Object.prototype);
});

test('the category name is read from Nexus\'s answer and cleaned (one line, at most 80 characters)', async () => {
  const n = new NexusClient(() => '', quiet);
  n.graphql = async (q, vars) => {
    assert.match(q, /modCategory \{ name \}/);
    return { legacyModsByDomain: { totalCount: 3, nodes: [
      { modId: 1, modCategory: { name: 'Visuals and Graphics' } },
      { modId: 2, modCategory: { name: 'Bad\u0000\nName' + 'x'.repeat(100) } },
      { modId: 3, modCategory: null },
    ].filter(x => vars.ids.some(i => i.modId === x.modId)) } };
  };
  const cats = new Map();
  await n.requirementsMany('cyberpunk2077', [1, 2, 3], cats);
  assert.strictEqual(cats.get(1), 'Visuals and Graphics');
  assert.ok(!/[\u0000-\u001f]/.test(cats.get(2)) && cats.get(2).startsWith('Bad Name') && cats.get(2).length === 80);
  assert.strictEqual(cats.get(3), '');
  // Without a map it still works (callers that only want requirements).
  assert.strictEqual((await n.requirementsMany('cyberpunk2077', [1])).size, 1);
});
