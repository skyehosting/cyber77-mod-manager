'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GroupService, decodeInvite, joinFailure } = require('../src/core/groups/service');
const { isPublicV4, pick, lookup, reachableFromOutside } = require('../src/core/groups/publicIp');

const quiet = { info() {}, warn() {}, error() {}, success() {} };

test('internet addresses: home-network, shared (CGNAT), loopback and reserved ranges are not', () => {
  for (const ok of ['73.174.112.175', '81.2.69.160', '8.8.8.8']) assert.ok(isPublicV4(ok), ok);
  for (const no of ['10.0.0.249', '172.29.144.1', '192.168.1.5', '100.72.1.9', '127.0.0.1', '169.254.3.4', '203.0.113.7', '224.0.0.1', '0.1.2.3', '1.2.3', 'example.com', '', null, '::1']) assert.ok(!isPublicV4(no), String(no));
  assert.strictEqual(pick({ router: '81.2.69.160', saved: '73.174.112.175' }), '81.2.69.160', 'the router\'s answer first');
  assert.strictEqual(pick({ router: '100.72.1.9', saved: '73.174.112.175' }), '73.174.112.175', 'a router behind another NAT: the saved one');
  assert.strictEqual(pick({ router: '', saved: '' }), '');
  assert.ok(reachableFromOutside(['73.174.112.175:47077', '10.0.0.249:47077']));
  assert.ok(!reachableFromOutside(['10.0.0.249:47077', '172.29.144.1:47077']));
});

test('looking it up: only an internet IPv4 is taken from the answer; failures say what to do', async () => {
  const answer = (status, body) => async () => ({ ok: status === 200, status, text: async () => body });
  assert.strictEqual(await lookup({ fetchImpl: answer(200, '73.174.112.175\n') }), '73.174.112.175');
  await assert.rejects(lookup({ fetchImpl: answer(200, '10.0.0.249') }), /Type it in instead/);
  await assert.rejects(lookup({ fetchImpl: answer(200, '<html>73.174.112.175</html>') }), /Type it in instead/);
  await assert.rejects(lookup({ fetchImpl: answer(503, '') }), /HTTP 503/);
  await assert.rejects(lookup({ fetchImpl: async () => { throw new Error('offline'); } }), /no answer/);
  // (audit) A real response body: read only as far as an address can go; a long one is refused.
  assert.strictEqual(await lookup({ fetchImpl: async () => new Response('81.2.69.160') }), '81.2.69.160');
  let pulled = 0;
  const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode('81.2.69.160'.padEnd(1000, ' '))); } });
  await assert.rejects(lookup({ fetchImpl: async () => new Response(endless) }), /Type it in instead/);
  assert.ok(pulled < 5, 'an endless answer is not read on');
  assert.ok(!isPublicV4('192.88.99.1'), '6to4 relay range');
});

test('a hand-forwarded port: the internet address goes into invites (first), and an invite without one says so', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-group-pub-'));
  const svc = new GroupService({ dir, log: quiet, addresses: () => ['10.0.0.249', '172.29.144.1'], status: () => ({ game: '', mods: [] }) });
  t.after(() => svc.stop());
  await svc.start({ port: 47950 + Math.floor(Math.random() * 40), host: '127.0.0.1' });
  const { g } = svc.create({ name: 'Crew', myName: 'Raven', listName: 'Co-op' });
  const home = svc.invite(g);
  assert.strictEqual(home.outside, false, 'only home-network addresses: the dialog warns');
  svc.setExternal('73.174.112.175');
  const inv = svc.invite(g);
  assert.strictEqual(inv.outside, true);
  assert.strictEqual(inv.addrs[0], `73.174.112.175:${svc.port}`, 'tried first by the friend');
  assert.strictEqual(decodeInvite(inv.code).addrs[0], `73.174.112.175:${svc.port}`);
  assert.strictEqual(svc.groups.get(g).st.members.get(svc.me.fp).addrs[0], `73.174.112.175:${svc.port}`, 'the group hears the new address');
});

test('a friend whose invite has only home-network addresses is told that, not to check their firewall', () => {
  const timeout = new Error('No answer.');
  const home = joinFailure(false, timeout, ['10.0.0.249:47077', '172.29.144.1:47077']);
  assert.match(home, /only has home-network/);
  assert.match(home, /Internet address/);
  const outside = joinFailure(false, timeout, ['73.174.112.175:47077']);
  assert.match(outside, /did not answer within 10 seconds/);
  assert.match(outside, /firewall/);
});
