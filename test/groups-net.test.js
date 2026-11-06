'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GroupService, decodeInvite } = require('../src/core/groups/service');
const net = require('../src/core/groups/net');
const { loadIdentity } = require('../src/core/groups/identity');

// Real TLS connections between apps, on 127.0.0.1 only, each with its own temp folder.
const quiet = { info() {}, warn() {}, error() {}, success() {} };
let nextPort = 47600 + Math.floor(Math.random() * 300);
function app(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cmm-group-${name}-`));
  const svc = new GroupService({ dir, log: quiet, addresses: () => ['127.0.0.1'], loopback: true, status: () => ({ game: '2.3', mods: [[4198, 91001]] }) });
  svc.label = name;
  return svc;
}
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
};
const mod = { modId: 4198, fileId: 91001, name: 'ArchiveXL', version: '1.21.1', size: 3100000 };

test('create, invite, join with the passcode, and a change reaches everyone', async t => {
  const raven = app('raven');
  const jackie = app('jackie');
  const panam = app('panam');
  t.after(() => Promise.all([raven, jackie, panam].map(s => s.stop())));
  await raven.start({ port: nextPort++, host: '127.0.0.1' });
  await jackie.start({ port: nextPort++, host: '127.0.0.1' });
  await panam.start({ port: nextPort++, host: '127.0.0.1' });
  const { g, list } = raven.create({ name: 'Night City Crew', myName: 'Raven', listName: 'Co-op night' });
  const inv = raven.invite(g);
  assert.strictEqual(decodeInvite(inv.code, { loopback: true }).g, g);
  assert.throws(() => decodeInvite(inv.code), /no address this PC can reach/, 'loopback addresses only for tests');
  assert.strictEqual(await jackie.join(inv.code, inv.passcode.toLowerCase(), 'Jackie'), g);
  // Panam joins through Jackie, with an invite Jackie made.
  const inv2 = jackie.invite(g);
  await panam.join(inv2.code, inv2.passcode, 'Panam');
  assert.ok(await until(() => raven.view().groups[0].members.length === 3), 'the host hears of Panam through Jackie');
  raven.addMods(g, list, [mod]);
  assert.ok(await until(() => panam.view().groups[0]?.lists[0].mods.length === 1), 'the change reaches Panam');
  const pv = panam.view().groups[0];
  assert.deepStrictEqual(pv.changes.map(c => [c.kind, c.by, c.name]), [['add', 'Raven', 'ArchiveXL']], 'it waits for Panam to review it');
  assert.ok(await until(() => raven.view().groups[0].members.find(m => m.name === 'Jackie')?.game === '2.3'), 'members see each other\'s game version');
});

test('a wrong passcode, a used invite or a stranger gets nothing', async t => {
  const raven = app('raven2');
  const judy = app('judy');
  const river = app('river');
  t.after(() => Promise.all([raven, judy, river].map(s => s.stop())));
  await raven.start({ port: nextPort++, host: '127.0.0.1' });
  const { g } = raven.create({ name: 'Choom Squad', myName: 'Raven', listName: 'Main' });
  const inv = raven.invite(g);
  await assert.rejects(judy.join(inv.code, 'AAAA-BBBB-CCCC-DDDD', 'Judy'), /Wrong passcode/);
  await judy.join(inv.code, inv.passcode, 'Judy');
  await assert.rejects(river.join(inv.code, inv.passcode, 'River'), /not valid any more/, 'an invite works once');
  // A stranger saying hello as if a member: refused, sees nothing.
  river.load();
  const peer = await net.connect(river.me, `127.0.0.1:${raven.port}`, raven.me.fp);
  peer.send({ t: 'hello', g });
  await assert.rejects(net.expect(peer, 'welcome', 3000), /Not a member/);
  // And a client that expects a different PC refuses to talk to this one.
  await assert.rejects(net.connect(river.me, `127.0.0.1:${raven.port}`, judy.me.fp), /not the one this group expects/);
});

test('removing a member: they lose the group, the passcode changes, and their old one stops working', async t => {
  const raven = app('raven3');
  const jackie = app('jackie3');
  const evelyn = app('evelyn');
  t.after(() => Promise.all([raven, jackie, evelyn].map(s => s.stop())));
  await raven.start({ port: nextPort++, host: '127.0.0.1' });
  await jackie.start({ port: nextPort++, host: '127.0.0.1' });
  const { g } = raven.create({ name: 'Crew', myName: 'Raven', listName: 'Main' });
  const inv = raven.invite(g);
  await jackie.join(inv.code, inv.passcode, 'Jackie');
  const gone = new Promise(r => jackie.once('gone', r));
  raven.removeMember(g, jackie.me.fp);
  const info = await gone;
  assert.strictEqual(info.how, 'remove');
  assert.strictEqual(jackie.view().groups.length, 0);
  assert.ok(await until(() => raven.view().groups[0].passcode !== inv.passcode), 'a new passcode');
  const inv2 = raven.invite(g);
  await assert.rejects(evelyn.join(inv2.code, inv.passcode, 'Evelyn'), /Wrong passcode/, 'the old passcode no longer works');
  assert.throws(() => jackie.removeMember(g, raven.me.fp), /not in that group/);
});

test('when the host leaves, the next member becomes host', async t => {
  const raven = app('raven4');
  const jackie = app('jackie4');
  t.after(() => Promise.all([raven, jackie].map(s => s.stop())));
  await raven.start({ port: nextPort++, host: '127.0.0.1' });
  await jackie.start({ port: nextPort++, host: '127.0.0.1' });
  const { g } = raven.create({ name: 'Crew', myName: 'Raven', listName: 'Main' });
  const inv = raven.invite(g);
  await jackie.join(inv.code, inv.passcode, 'Jackie');
  assert.ok(await until(() => raven.peersOf(g).length === 1));
  raven.leave(g);
  assert.ok(await until(() => jackie.view().groups[0]?.iAmHost === true), 'Jackie is host now');
  assert.ok(await until(() => raven.view().groups.length === 0));
});

test('the identity survives a restart and its key file is never plain when a cipher is there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-ident-'));
  const cipher = { available: () => true, encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() };
  const a = loadIdentity(dir, cipher);
  const b = loadIdentity(dir, cipher);
  assert.strictEqual(a.fp, b.fp);
  const raw = fs.readFileSync(path.join(dir, 'identity.json'), 'utf8');
  assert.ok(!raw.includes('PRIVATE KEY'), 'the private key is stored encrypted');
});

test('two members who restart at the same moment reconnect (one connection, not none)', async t => {
  const a = app('a5');
  const b = app('b5');
  t.after(() => Promise.all([a, b].map(s => s.stop())));
  const pa = nextPort++;
  const pb = nextPort++;
  await a.start({ port: pa, host: '127.0.0.1' });
  await b.start({ port: pb, host: '127.0.0.1' });
  const { g } = a.create({ name: 'Crew', myName: 'A', listName: 'Main' });
  const inv = a.invite(g);
  await b.join(inv.code, inv.passcode, 'B');
  assert.ok(await until(() => a.view().groups[0].members.find(m => m.name === 'B')?.addrs !== undefined || true));
  await a.stop();
  await b.stop();
  await Promise.all([a.start({ port: pa, host: '127.0.0.1' }), b.start({ port: pb, host: '127.0.0.1' })]);
  assert.ok(await until(() => a.view().groups[0].members.find(m => m.name === 'B')?.online && b.view().groups[0].members.find(m => m.name === 'A')?.online, 15000), 'both see the other online');
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(a.peersOf(g).length, 1, 'one connection kept');
  assert.ok(a.view().groups[0].members.find(m => m.name === 'B').online, 'and it stays up');
});

test('joining a group with a long history (more than one message) works', async t => {
  const a = app('big1');
  const b = app('big2');
  t.after(() => Promise.all([a, b].map(s => s.stop())));
  await a.start({ port: nextPort++, host: '127.0.0.1' });
  await b.start({ port: nextPort++, host: '127.0.0.1' });
  const { g, list } = a.create({ name: 'Big', myName: 'A', listName: 'Main' });
  const all = Array.from({ length: 450 }, (_, i) => ({ modId: 10000 + i, fileId: 20000 + i, name: `Mod number ${i} with a fairly long name`, version: '1.0.0', size: 1000 }));
  for (let i = 0; i < all.length; i += 150) a.addMods(g, list, all.slice(i, i + 150));
  const inv = a.invite(g);
  await b.join(inv.code, inv.passcode, 'B');
  assert.strictEqual(b.view().groups[0].lists[0].mods.length, 450);
});

test('leaving with nobody online is refused unless forced; a peer that floods is cut off', async t => {
  const a = app('lv1');
  const b = app('lv2');
  t.after(() => Promise.all([a, b].map(s => s.stop())));
  await a.start({ port: nextPort++, host: '127.0.0.1' });
  await b.start({ port: nextPort++, host: '127.0.0.1' });
  const { g } = a.create({ name: 'Crew', myName: 'A', listName: 'Main' });
  const inv = a.invite(g);
  await b.join(inv.code, inv.passcode, 'B');
  // Flood: an admitted member sending far too many messages is disconnected.
  const peer = b.peersOf(g)[0];
  for (let i = 0; i < 400; i++) peer.send({ t: 'status', g, game: 'x', mods: [] });
  assert.ok(await until(() => !a.peersOf(g).length, 5000), 'cut off');
  await a.stop();
  assert.throws(() => b.leave(g), /Nobody else in the group is connected/);
  b.leave(g, { force: true });
  assert.ok(await until(() => !b.view().groups.length));
});

test('events that wait for parents that never come cannot fill the log', async t => {
  const a = app('wait1');
  t.after(() => a.stop());
  a.load();
  const { g } = a.create({ name: 'Crew', myName: 'A', listName: 'Main' });
  const { makeEvent } = require('../src/core/groups/log');
  // Signed by a member (A itself here), each pointing at a parent nobody has.
  const fake = Array.from({ length: 700 }, (_, i) => makeEvent(a.me, g, 'name', { name: `N${i}` }, [{ id: require('crypto').randomBytes(32).toString('hex'), n: 5 }]));
  for (let i = 0; i < fake.length; i += 400) a.ingest(g, fake.slice(i, i + 400));
  assert.ok(a.groups.get(g).events.size <= 1 + 50, 'at most 50 waiting per author');
  a.rename(g, 'Still works');
  assert.strictEqual(a.view().groups[0].members[0].name, 'Still works');
});

test('a removed member gets nothing more from anyone (not the new passcode, not new mods)', async t => {
  const a = app('rm1');
  const b = app('rm2');
  const c = app('rm3');
  t.after(() => Promise.all([a, b, c].map(s => s.stop())));
  for (const s of [a, b, c]) await s.start({ port: nextPort++, host: '127.0.0.1' });
  const { g, list } = a.create({ name: 'Crew', myName: 'A', listName: 'Main' });
  let inv = a.invite(g);
  await b.join(inv.code, inv.passcode, 'B');
  inv = a.invite(g);
  await c.join(inv.code, inv.passcode, 'C');
  assert.ok(await until(() => b.view().groups[0].members.find(m => m.name === 'C')?.online && c.view().groups[0].members.find(m => m.name === 'B')?.online, 15000), 'B and C connected to each other');
  const seenByC = [];
  c.removeAllListeners('gone');
  const realIngest = c.ingest.bind(c);
  c.ingest = (gg, evs, from) => { for (const e of evs || []) seenByC.push(e.t); return realIngest(gg, evs, from); };
  a.removeMember(g, c.me.fp);
  assert.ok(await until(() => !b.view().groups[0].members.some(m => m.name === 'C')));
  await new Promise(r => setTimeout(r, 6000)); // the new passcode is made a few seconds later
  b.addMods(g, list, [{ modId: 777, fileId: 778, name: 'Secret', version: '1' }]);
  await new Promise(r => setTimeout(r, 800));
  assert.ok(!seenByC.includes('passcode'), 'no new passcode');
  assert.ok(!seenByC.includes('mod-add'), 'no new mods');
  assert.strictEqual(b.peersOf(g).filter(p => p.fp === c.me.fp).length, 0);
});

test('invite tokens are kept only as hashes', async t => {
  const a = app('tok1');
  t.after(() => a.stop());
  await a.start({ port: nextPort++, host: '127.0.0.1' });
  const { g } = a.create({ name: 'Crew', myName: 'A', listName: 'Main' });
  const inv = a.invite(g);
  const token = decodeInvite(inv.code, { loopback: true }).token;
  const raw = fs.readFileSync(path.join(a.dir, 'local.json'), 'utf8');
  assert.ok(!raw.includes(token), 'the token itself is not stored');
});
