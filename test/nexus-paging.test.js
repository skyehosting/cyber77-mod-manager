'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NexusClient } = require('../src/core/nexus');

/*
 * Nexus's GraphQL answers at most a few mods per request while saying it found them all. Requirements
 * were read 50 at a time, so 30 of every 50 mods were taken as "no requirements" (and kept 3 days).
 */

/** A stand-in for Nexus: answers at most `cap` mods per request, each requiring mod 1. */
function fakeNexus(cap, known = id => true) {
  const n = new NexusClient(() => '', { info() {}, warn() {}, error() {} });
  n.asked = [];
  n.graphql = async (_q, vars) => {
    const ids = vars.ids.map(x => x.modId);
    n.asked.push(ids.length);
    const found = ids.filter(known);
    return { legacyModsByDomain: { totalCount: found.length, nodes: found.slice(0, cap).map(modId => ({ modId, modRequirements: { nexusRequirements: { nodes: [{ modId: '1', modName: 'Base', url: '', notes: '', externalRequirement: false }] } } })) } };
  };
  return n;
}

test('every mod asked for is answered: 20 a request, as Nexus answers', async () => {
  const n = fakeNexus(20);
  const ids = Array.from({ length: 87 }, (_, i) => 1000 + i);
  const got = await n.requirementsMany('cyberpunk2077', ids);
  assert.strictEqual(got.size, 87);
  assert.ok([...got.values()].every(list => list.length === 1 && list[0].modId === 1));
  assert.deepStrictEqual(n.asked, [20, 20, 20, 20, 7]);
  const many = await n.getRequirementsMany('cyberpunk2077', ids);
  assert.strictEqual(many.size, 87);
});

test('if Nexus answers even fewer than it found, the ones left out are asked again; a mod it does not have is just missing', async () => {
  const n = fakeNexus(7, id => id !== 1005);
  const ids = Array.from({ length: 20 }, (_, i) => 1000 + i);
  const got = await n.requirementsMany('cyberpunk2077', ids);
  assert.strictEqual(got.size, 19, 'all but the one Nexus does not have');
  assert.ok(!got.has(1005));
});

test('requirement lists saved empty before the fix are asked again, once', () => {
  const { Settings } = require('../src/core/settings');
  const { ModManager } = require('../src/core/manager');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-req20-'));
  const settings = new Settings(path.join(root, 'ud'), null);
  const dataDir = settings.get('dataDir');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'library.json'), JSON.stringify({ downloads: {}, mods: {}, nextPriority: 1, requirements: { 33442: { at: 1, list: [] }, 7780: { at: 1, list: [{ modId: 2380, name: 'RED4ext' }] } } }));
  const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
  const mgr = new ModManager({ settings, log: quiet });
  assert.deepStrictEqual(Object.keys(mgr.data.requirements), ['7780'], 'the empty one goes, to be read again');
  // A later empty list (a mod that really has none) stays.
  mgr.data.requirements[33442] = { at: 2, list: [] };
  mgr.library.save();
  const again = new ModManager({ settings, log: quiet });
  assert.deepStrictEqual(Object.keys(again.data.requirements).sort(), ['33442', '7780']);
});
