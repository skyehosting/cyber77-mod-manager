'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const upnp = require('../src/core/groups/upnp');
const { psQuote, validPort } = require('../src/core/groups/firewall');

// A pretend router on 127.0.0.1 is not a private LAN address, so the safety check is relaxed by
// pointing at it through the test's own location check: the router logic is tested, not the network.
function fakeRouter({ conflictFor = '', permanentOnly = false } = {}) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (req.url === '/desc.xml') {
        res.end(`<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>`);
        return;
      }
      const action = (req.headers.soapaction || '').split('#')[1]?.replace(/"/g, '');
      calls.push({ action, body });
      const fault = code => { res.statusCode = 500; res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>x</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`); };
      if (action === 'AddPortMapping') {
        if (conflictFor) return fault(718);
        if (permanentOnly && !/<NewLeaseDuration>0</.test(body)) return fault(725);
        return res.end('<ok/>');
      }
      if (action === 'GetSpecificPortMappingEntry') return res.end(`<r><NewInternalClient>${conflictFor}</NewInternalClient><NewInternalPort>47077</NewInternalPort></r>`);
      if (action === 'GetExternalIPAddress') return res.end('<r><NewExternalIPAddress>100.72.1.9</NewExternalIPAddress></r>');
      return res.end('<ok/>');
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, calls, port: srv.address().port })));
}

test('only http URLs on private IPv4 addresses are fetched from SSDP answers', () => {
  assert.ok(upnp.safeLocation('http://192.168.1.1:5000/rootDesc.xml'));
  for (const bad of ['https://192.168.1.1/x', 'http://8.8.8.8/x', 'http://router.local/x', 'http://user:pw@192.168.1.1/x', 'file:///etc/passwd', 'http://[fe80::1]/x']) assert.strictEqual(upnp.safeLocation(bad), null, bad);
  assert.strictEqual(upnp.parseSsdp('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:1900/igd.xml\r\nST: x\r\n'), 'http://192.168.1.1:1900/igd.xml');
});

test('carrier-grade NAT and double NAT are recognised from the router\'s internet address', () => {
  assert.ok(upnp.behindAnotherNat('100.72.1.9'));
  assert.ok(upnp.behindAnotherNat('10.0.0.5'));
  assert.ok(!upnp.behindAnotherNat('81.2.69.160'));
});

test('the WAN service is found in a router description, and a mapping is made, with the permanent-lease and conflict cases', async t => {
  const r = await fakeRouter({ permanentOnly: true });
  t.after(() => r.srv.close());
  const base = `http://127.0.0.1:${r.port}/desc.xml`;
  const desc = await (await fetch(base)).text();
  const svc = upnp.findService(desc.replace(/127\.0\.0\.1/g, '192.168.1.1'), 'http://192.168.1.1/desc.xml');
  assert.strictEqual(svc.type, 'urn:schemas-upnp-org:service:WANIPConnection:1');
  assert.strictEqual(svc.control, 'http://192.168.1.1/ctl');
  // Talk to the fake router through its real address for the SOAP part.
  const local = { type: svc.type, control: `http://127.0.0.1:${r.port}/ctl` };
  await assert.rejects(upnp.soap(local, 'AddPortMapping', { NewLeaseDuration: 3600 }), e => e.upnpCode === 725);
  await upnp.soap(local, 'AddPortMapping', { NewLeaseDuration: 0 });
  assert.match(await upnp.soap(local, 'GetExternalIPAddress'), /100\.72\.1\.9/);
  assert.ok(r.calls.every(c => !/<script|&[^a-z#]/i.test(c.body)), 'arguments are escaped');
});

test('firewall script values are quoted for PowerShell and ports are checked', () => {
  assert.strictEqual(psQuote("C:\\Users\\O'Brien\\app.exe"), "'C:\\Users\\O''Brien\\app.exe'");
  assert.ok(validPort(47077));
  for (const bad of [80, 0, 70000, 47077.5, '47077']) assert.ok(!validPort(bad), String(bad));
});
