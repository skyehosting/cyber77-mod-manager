'use strict';
const nodeNet = require('net');

/*
 * This PC's internet address, for invites and for the group, when the router does not say it (UPnP off,
 * not supported, or the port was forwarded by hand). Without it, invites hold only home-network
 * addresses and friends elsewhere wait 10 seconds for nothing.
 *
 * Where it comes from, first that applies:
 *   1. the router, through UPnP (its own answer, unless it is behind another NAT);
 *   2. the address in Settings → Group Mods → Internet address: typed by the user, or found with
 *      "Find it", which asks LOOKUP_URL. Only after that click, and then again each time groups start
 *      (an internet address can change), never otherwise.
 */

const LOOKUP_URL = 'https://api.ipify.org';
const LOOKUP_TIMEOUT = 8e3;

// Not an internet address: private, shared (carrier-grade NAT), loopback, link-local, documentation,
// benchmarking, multicast and reserved ranges.
const NOT_PUBLIC = new nodeNet.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
  NOT_PUBLIC.addSubnet(a, bits, 'ipv4');
}

/** An IPv4 address on the internet (not a home network's, a VPN's shared range, or reserved). */
function isPublicV4(ip) {
  const s = String(ip || '').trim();
  return nodeNet.isIPv4(s) && !NOT_PUBLIC.check(s, 'ipv4');
}

/** The address to give out: the router's (UPnP) when it gave a usable one, else the saved one, else ''. */
function pick({ router = '', saved = '' } = {}) {
  if (isPublicV4(router)) return String(router).trim();
  if (isPublicV4(saved)) return String(saved).trim();
  return '';
}

/** The start of a response body, at most `max` characters; the rest is never read. */
async function firstBytes(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return String(await res.text()).slice(0, max);
  const dec = new TextDecoder();
  let out = '';
  try {
    while (out.length <= max) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  } finally { reader.cancel().catch(() => {}); }
  return out.slice(0, max + 1); // one over the limit: not an address
}

/** Ask LOOKUP_URL for this network's internet address. Resolves with it; throws in words a player can act on. */
async function lookup({ fetchImpl = (...a) => fetch(...a), url = LOOKUP_URL } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(LOOKUP_TIMEOUT), headers: { Accept: 'text/plain' } });
  } catch {
    throw new Error('Could not ask api.ipify.org for your internet address (no answer). Type it in instead.');
  }
  if (!res.ok) throw new Error(`api.ipify.org did not answer (HTTP ${res.status}). Type your internet address in instead.`);
  let text;
  try { text = await firstBytes(res, 64); } catch { throw new Error('Could not ask api.ipify.org for your internet address (the answer broke off). Type it in instead.'); }
  text = text.length > 64 ? '' : text.trim(); // longer than any address: not one
  if (!isPublicV4(text)) throw new Error('api.ipify.org did not give back an internet IPv4 address. Type it in instead.');
  return text;
}

/** An address list's host part ("1.2.3.4:47077" → "1.2.3.4"). */
const hostOf = addr => String(addr).replace(/^\[?([^\]]*?)\]?:\d+$/, '$1');

/** Does one of these "ip:port" addresses work from outside the home network? */
const reachableFromOutside = addrs => (addrs || []).some(a => isPublicV4(hostOf(a)) || (nodeNet.isIPv6(hostOf(a)) && /^[23]/.test(hostOf(a)))); // IPv6: global unicast

module.exports = { isPublicV4, pick, lookup, reachableFromOutside, LOOKUP_URL };
