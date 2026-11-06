'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { selfSignedCert, certInfo } = require('../src/core/groups/identity');
const { makeEvent, makeCreate, fold, newListId, newPasscode, samePasscode, eventId, wellFormed } = require('../src/core/groups/log');
const { sign } = require('../src/core/groups/identity');

function person(name) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cert = selfSignedCert(privateKey, publicKey);
  return { name, fp: certInfo(cert).fp, cert, privateKey };
}
const member = p => ({ fp: p.fp, cert: p.cert, name: p.name });

/** A group whose events each follow the one before (a straight history), plus a helper to add more. */
function group() {
  const raven = person('Raven');
  const jackie = person('Jackie');
  const panam = person('Panam');
  const list = newListId();
  const create = makeCreate(raven, { name: 'Night City Crew', member: member(raven), passcode: 'AAAA-BBBB-CCCC-DDDD', list: { id: list, name: 'Co-op night' } });
  const g = create.g;
  const log = [create];
  const ev = (who, t, d, parents = [log[log.length - 1]]) => { const e = makeEvent(who, g, t, d, parents); log.push(e); return e; };
  ev(raven, 'join', { member: member(jackie) });
  ev(jackie, 'join', { member: member(panam) });
  ev(jackie, 'mod-add', { list, mod: { modId: 4198, fileId: 91001, name: 'ArchiveXL', version: '1.21.1', size: 3100000, reqs: [{ modId: 107, name: 'Cyber Engine Tweaks' }] } });
  return { raven, jackie, panam, g, list, log, ev };
}

test('the certificate we build is a real one: Node parses it and it verifies with its own key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = selfSignedCert(privateKey, publicKey);
  const x = new crypto.X509Certificate(pem);
  assert.ok(x.verify(publicKey));
  assert.strictEqual(x.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.ok(new Date(x.validTo) > new Date('2049-01-01'));
  assert.ok(!x.verify(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey));
});

test('folding the log: members, host, lists and mods, the same in any order', () => {
  const { raven, jackie, panam, list, log } = group();
  const st = fold(log);
  assert.strictEqual(st.name, 'Night City Crew');
  assert.deepStrictEqual([...st.members.keys()].sort(), [raven.fp, jackie.fp, panam.fp].sort());
  assert.strictEqual(st.host, raven.fp);
  assert.strictEqual(st.lists.get(list).mods.get(4198).version, '1.21.1');
  assert.deepStrictEqual(fold([...log].reverse()).applied, st.applied, 'order on arrival does not matter');
  assert.deepStrictEqual(st.heads.map(h => h.id), [log[log.length - 1].id]);
});

test('forged, tampered or non-member events are ignored', () => {
  const { g, list, log, jackie } = group();
  const stranger = person('Stranger');
  const tip = log[log.length - 1];
  const forged = makeEvent(stranger, g, 'mod-add', { list, mod: { modId: 1, fileId: 2, name: 'Malware' } }, [tip]);
  const spoofed = { ...makeEvent(stranger, g, 'mod-remove', { list, modId: 4198 }, [tip]), by: jackie.fp };
  spoofed.id = eventId(spoofed); // the id fits, the signature is the stranger's
  const tampered = { ...log[3], d: { ...log[3].d, mod: { ...log[3].d.mod, name: 'Something else' } } };
  assert.strictEqual(fold([...log.slice(0, 3), tampered]).lists.get(list).mods.size, 0, 'the tampered add does not count');
  assert.deepStrictEqual([...fold([...log, forged, spoofed]).lists.get(list).mods.keys()], [4198]);
});

test('a second "create" for the group (a takeover) is ignored: the id belongs to its creator', () => {
  const { jackie, g, log } = group();
  const thief = person('Thief');
  // Same group id, a create signed by someone else: it cannot match the id (sha256 of the creator's key).
  const fake = { g, by: thief.fp, n: 1, at: 1, t: 'create', d: { name: 'Mine now', member: member(thief), passcode: 'XXXX-XXXX', nonce: 'aa' }, p: [] };
  fake.id = eventId(fake);
  fake.sig = sign(thief.privateKey, fake.id);
  const st = fold([fake, ...log]);
  assert.strictEqual(st.name, 'Night City Crew');
  assert.ok(st.members.has(jackie.fp));
  assert.ok(!st.members.has(thief.fp));
});

test('a counter that lies is ignored (nobody can push the group\'s counter out of reach)', () => {
  const { jackie, g, log } = group();
  const tip = log[log.length - 1];
  const huge = { g, by: jackie.fp, n: Number.MAX_SAFE_INTEGER, at: 1, t: 'name', d: { name: 'Big' }, p: [tip.id] };
  huge.id = eventId(huge);
  huge.sig = sign(jackie.privateKey, huge.id);
  assert.ok(!wellFormed(huge), 'out of range');
  const skip = { ...huge, n: tip.n + 50 };
  skip.id = eventId(skip);
  skip.sig = sign(jackie.privateKey, skip.id);
  const st = fold([...log, skip]);
  assert.ok(!st.appliedSet.has(skip.id), 'n must be one more than its parents');
  assert.strictEqual(st.n, tip.n);
});

test('only the host removes members; when the host leaves, the earliest member left takes over', () => {
  const { raven, jackie, panam, log, ev } = group();
  const notHost = ev(jackie, 'remove', { fp: panam.fp });
  assert.ok(fold(log).members.has(panam.fp), 'a member who is not the host cannot remove');
  log.pop();
  ev(raven, 'remove', { fp: panam.fp });
  ev(raven, 'leave', {});
  const st = fold(log);
  assert.deepStrictEqual([...st.members.keys()], [jackie.fp]);
  assert.strictEqual(st.host, jackie.fp);
  assert.strictEqual(st.gone.get(panam.fp).how, 'remove');
  assert.ok(notHost);
});

test('removal sticks: no backdated events, no puppets on the side, no re-admission by a member', () => {
  const { raven, jackie, panam, list, log, ev } = group();
  const before = log[log.length - 1]; // the history the host's removal builds on
  const puppet = person('Puppet');
  // Panam prepares, on a branch the host never sees, a puppet and a removal of ArchiveXL.
  const sideJoin = makeEvent(panam, log[0].g, 'join', { member: member(puppet) }, [before]);
  const sideRemove = makeEvent(puppet, log[0].g, 'mod-remove', { list, modId: 4198 }, [sideJoin]);
  ev(raven, 'remove', { fp: panam.fp }, [before]);
  const st = fold([...log, sideJoin, sideRemove]);
  assert.ok(!st.members.has(panam.fp));
  assert.ok(!st.members.has(puppet.fp), 'the puppet admitted on the side does not count');
  assert.ok(st.lists.get(list).mods.has(4198), 'nor does what it did');
  // Jackie (not the host) cannot let Panam back in; the host can.
  const back = ev(jackie, 'join', { member: member(panam) });
  assert.ok(!fold(log).members.has(panam.fp));
  log.pop();
  ev(raven, 'join', { member: member(panam) });
  const later = ev(panam, 'name', { name: 'Panam again' });
  const st2 = fold(log);
  assert.ok(st2.members.has(panam.fp), 'the host can let them back in');
  assert.ok(st2.appliedSet.has(later.id), 'and what they do after that counts');
  assert.ok(back);
});

test('a removed member\'s later events no longer count, and a new passcode replaces the old', () => {
  const { raven, panam, list, log, ev } = group();
  ev(raven, 'remove', { fp: panam.fp });
  ev(raven, 'passcode', { code: 'WXYZ-2345-6789-ABCD' });
  ev(panam, 'mod-remove', { list, modId: 4198 });
  const st = fold(log);
  assert.ok(st.lists.get(list).mods.has(4198));
  assert.strictEqual(st.passcode, 'WXYZ-2345-6789-ABCD');
});

test('an event whose parents have not arrived waits (not lost)', () => {
  const { jackie, list, log, ev } = group();
  const a = ev(jackie, 'name', { name: 'J' });
  const b = ev(jackie, 'mod-remove', { list, modId: 4198 });
  const st = fold(log.filter(x => x !== a));
  assert.ok(st.waiting.has(b.id) && !st.appliedSet.has(b.id));
  assert.ok(fold(log).appliedSet.has(b.id));
});

test('passcodes: readable, compared without case, spaces or dashes; deep nesting is refused', () => {
  const p = newPasscode();
  assert.match(p, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.ok(samePasscode(p, p.toLowerCase().replace(/-/g, ' ')));
  assert.ok(!samePasscode(p, 'AAAA-AAAA-AAAA-AAAA'));
  assert.ok(!samePasscode(p, ''));
  assert.ok(!samePasscode(p, ['x']));
  let deep = {};
  for (let i = 0; i < 5000; i++) deep = { a: deep };
  assert.strictEqual(wellFormed({ g: '0'.repeat(32), by: '0'.repeat(64), n: 2, at: 1, t: 'name', d: deep, p: ['0'.repeat(64)], id: '0'.repeat(64), sig: 'x' }), false);
});

test('padded events (unknown fields, oversized data) are malformed; who let a member in is recorded', () => {
  const { raven, jackie, panam, g, log } = group();
  const tip = log[log.length - 1];
  const padded = makeEvent(jackie, g, 'name', { name: 'J', junk: 'x'.repeat(100) }, [tip]);
  assert.strictEqual(wellFormed(padded), false, 'unknown keys in d');
  const big = makeEvent(jackie, g, 'name', { name: 'x'.repeat(20000) }, [tip]);
  assert.strictEqual(wellFormed(big), false, 'too large');
  const st = fold(log);
  assert.strictEqual(st.members.get(jackie.fp).by, raven.fp);
  assert.strictEqual(st.members.get(panam.fp).by, jackie.fp);
});

test('a member (not the host) lets in at most 4 people; an old passcode can\'t come back after a departure', () => {
  const { raven, jackie, panam, log, ev } = group();
  const extra = [1, 2, 3, 4, 5].map(i => person(`P${i}`));
  for (const p of extra) ev(jackie, 'join', { member: member(p) });
  const st = fold(log);
  assert.strictEqual(extra.filter(p => st.members.has(p.fp)).length, 3, 'Jackie had let Panam in already: 3 more, not 5');
  ev(raven, 'remove', { fp: panam.fp });
  assert.ok(fold(log).renewing, 'a departure: the passcode must change');
  ev(jackie, 'passcode', { code: 'AAAA-BBBB-CCCC-DDDD' });
  assert.ok(fold(log).renewing, 'the old passcode does not count as new');
  ev(jackie, 'passcode', { code: 'SHORT1' });
  assert.ok(fold(log).renewing, 'too short');
  ev(jackie, 'passcode', { code: 'QRST-UVWX-2345-6789' });
  const st2 = fold(log);
  assert.ok(!st2.renewing);
  assert.strictEqual(st2.passcode, 'QRST-UVWX-2345-6789');
});

test('the limit counts chains: people let in by someone a member let in count against that member', () => {
  const { jackie, panam, log, ev } = group(); // Jackie (let in by the host) let Panam in: 1 of 4
  const a = person('A');
  const b = person('B');
  const c = person('C');
  const d = person('D');
  ev(panam, 'join', { member: member(a) }); // counts under Jackie: 2
  ev(a, 'join', { member: member(b) }); // 3
  ev(jackie, 'join', { member: member(c) }); // 4
  ev(b, 'join', { member: member(d) }); // 5: refused
  const st = fold(log);
  assert.ok(st.members.has(a.fp) && st.members.has(b.fp) && st.members.has(c.fp));
  assert.ok(!st.members.has(d.fp), 'a chain of admissions does not get round the limit');
});
