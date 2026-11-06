'use strict';
const dgram = require('dgram');
const os = require('os');

/*
 * Opening the Group Mods port on the home router (UPnP IGD), with the user's consent, and reading the
 * router's internet address (to tell carrier-grade NAT apart). Only what that needs: SSDP search, the
 * router's description, AddPortMapping / DeletePortMapping / GetExternalIPAddress /
 * GetSpecificPortMappingEntry. A finite lease (an hour), renewed while groups are on, removed when they
 * are turned off or the app quits; a router that only takes permanent leases gets one, removed the same
 * way. Specs and sources: notes/group-mods.md.
 *
 * Anything on the LAN can answer a search, so answers are held to: an http URL on a private IPv4
 * address, small, quick. Nothing from the router is run or trusted beyond a port mapping.
 */

const SSDP = { host: '239.255.255.250', port: 1900 };
const TARGETS = ['urn:schemas-upnp-org:device:InternetGatewayDevice:2', 'urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];
const SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];
const MAX_BODY = 256 * 1024;
const LEASE = 3600;

/** Is this a private (LAN) IPv4 address? */
function privateV4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}
/** Carrier-grade NAT (RFC 6598) or another NAT in front of the router (RFC 1918). */
const behindAnotherNat = ip => privateV4(ip) || (() => { const p = String(ip).split('.').map(Number); return p[0] === 100 && p[1] >= 64 && p[1] <= 127; })();

/** A LOCATION we are willing to fetch: http, private IPv4, a port, a path. */
function safeLocation(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && privateV4(u.hostname) && !u.username && !u.password ? u : null;
  } catch { return null; }
}

/** The LOCATION header of an SSDP answer. */
function parseSsdp(text) {
  const m = String(text).match(/^location:\s*(\S+)\s*$/im);
  return m ? m[1] : '';
}

const xmlEscape = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const tag = (xml, name) => { const m = String(xml).match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`, 'i')); return m ? m[1].trim() : ''; };

/** The router's WAN service from its description: { type, control } (absolute URL) or null. */
function findService(xml, base) {
  const services = (String(xml).match(/<(?:\w+:)?service>[\s\S]{0,4000}?<\/(?:\w+:)?service>/gi) || []).slice(0, 32);
  let host = '';
  try { host = new URL(base).hostname; } catch { return null; }
  for (const want of SERVICES) {
    for (const s of services) {
      if (tag(s, 'serviceType') !== want) continue;
      const ctl = tag(s, 'controlURL');
      if (!ctl) continue;
      try {
        // Only the device that answered: its own address, whatever its description says (no hopping to
        // another machine on the network).
        const u = new URL(ctl, base);
        if (safeLocation(u.href) && u.hostname === host) return { type: want, control: u.href };
      } catch { /* bad URL */ }
    }
  }
  return null;
}

async function fetchText(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
  const reader = res.body?.getReader();
  let size = 0;
  const parts = [];
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) { reader.cancel().catch(() => {}); throw new Error('The router sent too much.'); }
      parts.push(value);
    }
  }
  return { status: res.status, text: Buffer.concat(parts.map(p => Buffer.from(p))).toString('utf8') };
}

/** Send M-SEARCH from every LAN interface; resolve with the LOCATION URLs heard (deduplicated). */
function search(timeout = 2500) {
  const ifaces = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && privateV4(a.address)) ifaces.push(a.address);
  return new Promise(resolve => {
    const found = new Map(); // location → local address that heard it
    const sockets = [];
    const finish = () => { for (const s of sockets) { try { s.close(); } catch { /* closed */ } } resolve([...found].map(([location, local]) => ({ location, local }))); };
    for (const local of ifaces) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(sock);
      sock.on('error', () => {});
      sock.on('message', (msg, rinfo) => {
        const loc = parseSsdp(msg.toString('utf8').slice(0, 4096));
        const u = safeLocation(loc);
        if (u && u.hostname === rinfo.address && !found.has(u.href)) found.set(u.href, local);
      });
      sock.bind(0, local, () => {
        try { sock.setMulticastTTL(2); } catch { /* fine */ }
        const send = () => {
          for (const st of TARGETS) {
            const m = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.host}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
            sock.send(m, SSDP.port, SSDP.host, () => {});
          }
        };
        send();
        setTimeout(send, 700).unref?.();
      });
    }
    if (!ifaces.length) { resolve([]); return; }
    setTimeout(finish, timeout).unref?.();
  });
}

/** One SOAP call; resolves the response body, rejects with { upnpCode } on a UPnP error. */
async function soap(svc, action, args = {}) {
  const body = `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">${Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const r = await fetchText(svc.control, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.type}#${action}"` }, body });
  if (r.status >= 200 && r.status < 300) return r.text;
  const code = Number(tag(r.text, 'errorCode')) || r.status;
  throw Object.assign(new Error(`The router said no (${code}${tag(r.text, 'errorDescription') ? `: ${tag(r.text, 'errorDescription')}` : ''}).`), { upnpCode: code });
}

/** Find the router's WAN service: { svc, local } (local: this PC's address on that network) or null. */
async function findGateway({ locations } = {}) {
  const heard = locations || await search();
  for (const { location, local } of heard) {
    const u = safeLocation(location);
    if (!u) continue;
    try {
      const d = await fetchText(u.href);
      const svc = d.status === 200 ? findService(d.text, u.href) : null;
      if (svc) return { svc, local };
    } catch { /* next one */ }
  }
  return null;
}

/**
 * Open `port` (TCP) to this PC. Resolves { ok, external, cgnat, gw } or { ok: false, reason }.
 * A mapping already there for this PC counts as done; one for another PC is a conflict.
 */
async function openPort(port, { description = 'Edgerunners Mod Manager (Group Mods)', locations } = {}) {
  const gw = await findGateway({ locations });
  if (!gw) return { ok: false, reason: 'none' };
  const args = lease => ({ NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP', NewInternalPort: port, NewInternalClient: gw.local, NewEnabled: 1, NewPortMappingDescription: description, NewLeaseDuration: lease });
  try {
    try {
      await soap(gw.svc, 'AddPortMapping', args(LEASE));
    } catch (err) {
      if (err.upnpCode === 725) await soap(gw.svc, 'AddPortMapping', args(0)); // only permanent leases
      else if (err.upnpCode === 718) {
        const entry = await soap(gw.svc, 'GetSpecificPortMappingEntry', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' });
        if (tag(entry, 'NewInternalClient') !== gw.local || Number(tag(entry, 'NewInternalPort')) !== port) return { ok: false, reason: 'conflict' };
      } else throw err;
    }
  } catch (err) {
    return { ok: false, reason: 'refused', detail: err.message };
  }
  let external = '';
  try { external = tag(await soap(gw.svc, 'GetExternalIPAddress'), 'NewExternalIPAddress'); } catch { /* unknown */ }
  if (!require('net').isIPv4(external)) external = '';
  return { ok: true, external, cgnat: !!external && behindAnotherNat(external), gw };
}

async function closePort(port, gw) {
  if (!gw) return;
  try { await soap(gw.svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' }); } catch { /* already gone */ }
}

module.exports = { openPort, closePort, findGateway, findService, parseSsdp, safeLocation, privateV4, behindAnotherNat, soap, LEASE };
