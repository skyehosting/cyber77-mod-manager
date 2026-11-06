'use strict';
const fs = require('fs');
const path = require('path');
const { GroupService, DEFAULT_PORT, localAddresses } = require('./service');
const { GROUP_ID, LIST_ID } = require('./log');
const firewall = require('./firewall');
const upnp = require('./upnp');
const { scanSaves } = require('../saves');

/*
 * Group Mods inside the app: the GroupService (network, log) on one side, this PC's mods on the other.
 *   - what this PC tells its group: its game version (from the newest save) and which of the lists'
 *     mods it has enabled (never anything else);
 *   - Download selected: each picked list entry goes through the app's normal Nexus download (Premium:
 *     direct; free: waits for its one click, like everywhere else) and installs into the profile in use;
 *   - a mod removed from a list is disabled here only if it came in through the group (downloaded from
 *     its list), "Keep it for me" was not chosen, and the game is closed (else when it closes).
 * Everything is off until the user turns groups on.
 */

const GAME = 'cyberpunk2077';
const RENEW_UPNP = 30 * 60e3;
const posInt = v => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);
// A list entry's id: a Nexus mod's (positive) or a mod.io mod's (negative), as the group log keeps them.
const modKey = v => (Number.isSafeInteger(Number(v)) && Number(v) !== 0 ? Number(v) : 0);
/** A mod of this app as a list entry's ids: [modId, fileId], Nexus positive, mod.io negative; null if neither. */
const idsOf = m => (m.modio?.id && m.modio?.fileId ? [-Number(m.modio.id), -Number(m.modio.fileId)]
  : posInt(m.modId) && posInt(m.fileId) ? [Number(m.modId), Number(m.fileId)] : null);
const gid = g => { if (!GROUP_ID.test(String(g))) throw new Error('Unknown group.'); return String(g); };
const lid = l => { if (!LIST_ID.test(String(l))) throw new Error('Unknown list.'); return String(l); };

function setupGroups({ manager, settings, userData, cipher, log, send, handle, gameRunning, exe = process.execPath }) {
  const dir = path.join(userData, 'groups');
  let versionCache = { at: 0, v: '' };
  const gameVersion = () => {
    if (Date.now() - versionCache.at > 5 * 60e3) {
      let v = '';
      try { v = scanSaves(manager.saves.savesDir())[0]?.gameVersion || ''; } catch { /* no saves */ }
      versionCache = { at: Date.now(), v };
    }
    return versionCache.v;
  };
  // What this PC has (enabled), as list ids; a list entry matched to a mod of the other site counts as had
  // (the friend sees the entry's own file: the two are the same mod, confirmed by this PC's user).
  // Reported only for the list's current file of that mod, and only while the match was made for that file
  // (the list moved to another version: the friend's PC shows "different", as for anyone else).
  const enabledMods = () => {
    const on = Object.values(manager.data.mods).filter(m => m.enabled).map(idsOf).filter(Boolean);
    const onIds = new Set(on.map(([id]) => id));
    const links = manager.data.crossLinks || {};
    for (const rec of service?.groups?.values?.() || []) {
      for (const l of rec.st?.lists?.values?.() || []) {
        for (const e of l.mods.values()) {
          const link = links[String(e.modId)];
          if (link && onIds.has(link.target) && Number(link.file) === e.fileId) on.push([e.modId, e.fileId]);
        }
      }
    }
    return on;
  };
  // Demos and tests: CMM_GROUPS_HOST=127.0.0.1 listens on this PC only (no firewall prompt, no router).
  const loopback = process.env.CMM_GROUPS_HOST === '127.0.0.1';
  const service = new GroupService({ dir, cipher, log, status: () => ({ game: gameVersion(), mods: enabledMods() }), addresses: loopback ? () => ['127.0.0.1'] : localAddresses, loopback });
  // The router mapping: which port it is for (a port change removes the old one), and a generation so a
  // late answer from the router after groups were turned off (or restarted) is thrown away.
  const router = { state: 'off', external: '', cgnat: false, detail: '', gw: null, timer: null, port: 0, gen: 0 };
  let starting = null;
  let lastError = ''; // why the last start failed (a busy port), for the page

  let viewTimer = null;
  const pushView = () => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { try { send('groups', view()); } catch { /* window gone */ } }, 120);
  };

  function view() {
    let v = { on: false, port: settings.get('groupsPort'), fp: '', addrs: [], groups: [] };
    // Groups never used: nothing is read or made (no identity, no keyring) until they are.
    if (settings.get('groupsEnabled') || service.used()) {
      try { service.load(); v = service.view(); } catch (err) { v.error = err.message; }
    }
    if (!v.on && lastError && !v.error) v.error = lastError;
    return {
      ...v,
      enabled: !!settings.get('groupsEnabled'), port: settings.get('groupsPort'), upnp: !!settings.get('groupsUpnp'),
      router: { state: router.state, external: router.external, cgnat: router.cgnat, detail: router.detail },
      platform: process.platform,
      game: v.groups.length ? gameVersion() : '', // this PC's (its newest save's): members on another one are pointed out
    };
  }

  // ---- the router (UPnP), while groups are on

  async function openRouter() {
    clearInterval(router.timer);
    const gen = ++router.gen;
    if (!settings.get('groupsUpnp') || loopback || !service.server) { router.state = 'off'; pushView(); return; }
    if (router.gw && router.port) await upnp.closePort(router.port, router.gw); // asked again: the old one first
    router.gw = null;
    router.state = 'trying';
    pushView();
    const port = settings.get('groupsPort');
    const r = await upnp.openPort(port).catch(err => ({ ok: false, reason: 'refused', detail: err.message }));
    // Turned off, restarted or asked again meanwhile: this answer is stale. Undo a mapping it made.
    if (gen !== router.gen || !service.server || !settings.get('groupsEnabled')) {
      // Undo it only when nothing wants that port any more (a newer request maps the same one itself).
      const wanted = service.server && settings.get('groupsEnabled') && settings.get('groupsUpnp') && settings.get('groupsPort') === port;
      if (r.ok && r.gw && !wanted) await upnp.closePort(port, r.gw);
      return;
    }
    if (r.ok) {
      Object.assign(router, { state: r.cgnat ? 'cgnat' : 'open', external: r.external, cgnat: r.cgnat, detail: '', gw: r.gw, port });
      if (!r.cgnat && r.external) service.setExternal(r.external);
      router.timer = setInterval(() => { if (gen === router.gen) upnp.openPort(port).catch(() => {}); }, RENEW_UPNP);
      router.timer.unref?.();
    } else {
      Object.assign(router, { state: r.reason, external: '', cgnat: false, detail: r.detail || '', gw: null, port: 0 });
    }
    pushView();
  }
  async function closeRouter() {
    router.gen++;
    clearInterval(router.timer);
    const { gw, port } = router;
    Object.assign(router, { state: 'off', external: '', cgnat: false, gw: null, port: 0 });
    service.setExternal('');
    if (gw && port) await upnp.closePort(port, gw);
  }

  // ---- on and off

  async function start() {
    if (!settings.get('groupsEnabled')) return;
    if (starting) return starting;
    starting = (async () => {
      try {
        await service.start({ port: settings.get('groupsPort') || DEFAULT_PORT, host: loopback ? '127.0.0.1' : '0.0.0.0' });
        lastError = '';
        log.info(`Group Mods: listening on port ${settings.get('groupsPort')}`);
        openRouter();
        applyRemovals();
      } catch (err) {
        lastError = err.code === 'EADDRINUSE' ? `port ${settings.get('groupsPort')} is in use by another program` : err.message;
        log.warn(`Group Mods could not start: ${lastError}`);
        throw err.code === 'EADDRINUSE' ? new Error(`Port ${settings.get('groupsPort')} is in use by another program. Choose another one in Settings → Groups.`) : err;
      } finally {
        starting = null;
        pushView();
      }
    })();
    return starting;
  }
  async function stop() {
    await closeRouter().catch(() => {});
    await service.stop();
    pushView();
  }

  // ---- news, and mods removed from a list

  service.on('changed', ({ g, events }) => {
    pushView();
    const removed = (events || []).filter(ev => ev.t === 'mod-remove' && ev.by !== service.me?.fp);
    if (removed.length) {
      const loc = service.localOf(g);
      loc.toDisable ||= {};
      for (const ev of removed) loc.toDisable[String(Number(ev.d.modId))] = true;
      service.saveLocal();
      applyRemovals();
    }
    const news = (events || []).filter(ev => ev.by !== service.me?.fp && ['mod-add', 'mod-remove', 'mod-version'].includes(ev.t));
    if (news.length) send('groups-news', { g, count: news.length });
  });
  service.on('gone', info => { pushView(); send('groups-gone', info); });

  /** Disable mods that left a list, where they came in through it, once the game is closed. */
  async function applyRemovals() {
    if (await gameRunning()) return; // again when the game closes
    // A mod still on any list of any group stays (another group may still want it).
    const stillListed = new Set([...service.groups.values()].flatMap(r => [...r.st.lists.values()].flatMap(l => [...l.mods.keys()])));
    for (const [g, rec] of service.groups) {
      const loc = service.localOf(g);
      const ids = Object.keys(loc.toDisable || {});
      if (!ids.length) continue;
      const off = [];
      const names = [];
      for (const modId of ids) {
        if (stillListed.has(Number(modId)) || loc.keep[modId]) continue;
        for (const m of Object.values(manager.data.mods)) {
          const ids = idsOf(m); // (Nexus or mod.io: the ids the list knows it by)
          if (ids && ids[0] === Number(modId) && m.enabled && loc.mine[String(ids[1])]) { off.push(m.id); names.push(m.modName || m.name); }
        }
      }
      loc.toDisable = {};
      service.saveLocal();
      if (!off.length) continue;
      try {
        await manager.setEnabled(off, false);
        log.info(`Group "${rec.st.name}": disabled ${names.join(', ')} (removed from the list)`);
        // The page says so, with a button to turn them back on.
        send('groups-disabled', { g, group: rec.st.name, ids: off, names });
      } catch (err) {
        log.warn(`Could not disable mods removed from a group list: ${err.message}`);
        for (const modId of ids) loc.toDisable[modId] = true; // again next time
        service.saveLocal();
      }
    }
  }

  let statusTimer = null;
  manager.on('changed', () => { clearTimeout(statusTimer); statusTimer = setTimeout(() => { service.sendStatusAll(); pushView(); }, 1500); });

  // ---- what the page asks for

  /** A list entry made from one of this PC's installed mods (from Nexus Mods or mod.io). */
  function entryOf(id) {
    const m = manager.data.mods[String(id)];
    const ids = m && idsOf(m);
    if (!ids) return null;
    const dl = manager.data.downloads?.[m.key];
    if (ids[0] < 0) {
      return { modId: ids[0], fileId: ids[1], name: m.modName || m.name, author: String(m.author || ''), version: String(m.version || ''), file: dl?.fileName || '', category: '', size: Number(dl?.size) || 0, reqs: [] };
    }
    return {
      author: String(m.author || ''),
      modId: Number(m.modId), fileId: Number(m.fileId), name: m.modName || m.name, version: String(m.version || ''),
      file: dl?.fileName || '', category: manager.data.modCategories?.[m.modId]?.name || '', size: Number(dl?.size) || 0,
      reqs: (manager.data.requirements?.[m.modId]?.list || []).filter(r => !r.external && posInt(r.modId)).slice(0, 50).map(r => ({ modId: Number(r.modId), name: String(r.name || '') })),
    };
  }

  /** What Nexus calls each picked mod (so a list entry's name can be checked against it). */
  async function verify(picks) {
    const out = {};
    if (!settings.apiKey) return out;
    for (const p of (Array.isArray(picks) ? picks : []).slice(0, 100)) {
      const modId = posInt(p?.modId);
      if (!modId || out[modId]) continue;
      try { const m = await manager.nexus.getMod(GAME, modId); out[modId] = { name: String(m.name || '').slice(0, 120), author: String(m.author || '').slice(0, 80), adult: !!m.contains_adult_content }; } catch { /* unknown */ }
    }
    return out;
  }

  /**
   * Get the picked list entries: each through the app's normal Nexus download, installed into the profile
   * in use. Another version of the same mod here is replaced (not installed beside it); a file already
   * downloaded is installed from what is there. One that fails does not stop the others.
   */
  async function download(g, picks, reqs) {
    service.need(gid(g));
    const active = manager.data.profiles.active;
    const summary = { queued: 0, skipped: 0 };
    const gone = [];
    const failed = [];
    const asked = [];
    let installed = 0;
    try {
      for (const p of (Array.isArray(picks) ? picks : []).slice(0, 200)) {
        const modId = modKey(p?.modId);
        const fileId = modKey(p?.fileId);
        if (!modId || !fileId || Math.sign(modId) !== Math.sign(fileId)) continue;
        // From mod.io: that file, through the mod.io download (with the requirements the user ticked).
        if (modId < 0) {
          if (!manager.modio.hasKey) { failed.push(`mod.io mod ${-modId}: add your mod.io key in Settings to get it from mod.io`); continue; }
          try {
            const olds = Object.values(manager.data.mods).filter(m => m.modio?.id === -modId && m.modio?.fileId !== -fileId);
            const r = await manager.queueModio(-modId, { fileId: -fileId, deps: Array.isArray(p?.deps) ? p.deps.map(Number).filter(n => Number.isSafeInteger(n) && n > 0).slice(0, 50) : [], replaces: olds.length === 1 ? olds[0].id : '' });
            summary.queued += r.queued;
            summary.skipped += r.skipped;
            asked.push(fileId);
          } catch (err) { failed.push(`mod.io mod ${-modId}: ${err.message}`); }
          continue;
        }
        // The version it replaces: another installed file of this mod in the same file category (Main for
        // Main), and only when exactly one fits (an optional patch is never taken for the main file).
        // Main, update and old version are one line (a pinned main file becomes an "old version" on Nexus
        // when the author releases a newer one); optional and other files only match their own kind.
        const line = c => (['MAIN', 'UPDATE', 'OLD_VERSION'].includes(c) ? 'MAIN' : c);
        const oldOf = cat => {
          const fits = Object.values(manager.data.mods).filter(m => Number(m.modId) === modId && Number(m.fileId) !== fileId && line(String(m.category || '').toUpperCase()) === line(cat));
          return fits.length === 1 ? fits[0].id : '';
        };
        try {
          const have = manager.data.downloads?.[String(fileId)];
          if (have && fs.existsSync(have.path) && !manager.data.mods[String(fileId)]) {
            asked.push(fileId);
            const res = await manager.install([have.key], { forProfiles: [active], replaces: oldOf(String(have.category || '').toUpperCase()) });
            const bad = (res || []).find(x => x?.error);
            if (bad) failed.push(`mod ${modId}: ${bad.error}`); else installed++;
            continue;
          }
          const info = await manager.fetchModInfo(GAME, modId);
          const f = info.files.find(x => Number(x.file_id) === fileId);
          if (!f || ['DELETED', 'ARCHIVED'].includes(String(f.category_name || '').toUpperCase())) { gone.push(info.name); continue; }
          asked.push(fileId);
          const replaces = oldOf(String(f.category_name || '').toUpperCase());
          await manager.queueFiles(info, [f], '', summary, replaces ? { replaces, forProfiles: [active] } : { forProfiles: [active] });
        } catch (err) {
          failed.push(`mod ${modId}: ${err.message}`);
        }
      }
    } finally {
      if (asked.length) service.markRequested(g, asked);
    }
    for (const id of (Array.isArray(reqs) ? reqs : []).map(posInt).filter(Boolean).slice(0, 100)) {
      try { await manager.addLinks(`https://www.nexusmods.com/${GAME}/mods/${id}`); } catch (err) { failed.push(`requirement ${id}: ${err.message}`); }
    }
    if (failed.length) log.warn(`Group Mods: some mods could not be fetched: ${failed.join('; ')}`);
    pushView();
    return { queued: summary.queued, installed, skipped: summary.skipped, gone, failed: failed.length, problems: failed.slice(0, 5) };
  }

  handle('groups:view', () => view());
  handle('groups:firewall', () => firewall.check(settings.get('groupsPort'), exe));
  handle('groups:firewallAllow', () => firewall.allow({ port: settings.get('groupsPort'), exe }));
  handle('groups:firewallRemove', () => firewall.disallow({ port: settings.get('groupsPort'), exe }));
  handle('groups:enable', async on => {
    settings.update({ groupsEnabled: on === true });
    if (on === true) await start(); else await stop();
    return view();
  });
  handle('groups:router', () => openRouter().then(view));
  handle('groups:create', o => service.create({ name: String(o?.name || '').trim(), myName: String(o?.myName || '').trim(), listName: String(o?.listName || '').trim() }));
  handle('groups:invite', g => service.invite(gid(g)));
  handle('groups:revoke', g => service.revokeInvites(gid(g)));
  handle('groups:join', (code, passcode, myName) => {
    if (!service.server) throw new Error('Turn on groups first: friends\' apps connect to yours.');
    return service.join(String(code || ''), String(passcode || ''), String(myName || '').trim());
  });
  handle('groups:leave', (g, force) => service.leave(gid(g), { force: force === true }));
  handle('groups:removeMember', (g, fp) => service.removeMember(gid(g), String(fp)));
  handle('groups:rename', (g, name) => service.rename(gid(g), String(name || '')));
  handle('groups:listAdd', (g, name) => service.addList(gid(g), String(name || '')));
  handle('groups:listRename', (g, l, name) => service.renameList(gid(g), lid(l), String(name || '')));
  handle('groups:listRemove', (g, l) => service.removeList(gid(g), lid(l)));
  handle('groups:modsAdd', (g, l, ids) => {
    const entries = (Array.isArray(ids) ? ids : []).slice(0, 200).map(entryOf).filter(Boolean);
    if (!entries.length) throw new Error('Only mods from Nexus Mods or mod.io can go on a group list.');
    return service.addMods(gid(g), lid(l), entries);
  });
  handle('groups:modRemove', (g, l, modId) => service.removeMod(gid(g), lid(l), modKey(modId)));
  handle('groups:seen', g => service.markSeen(gid(g)));
  handle('groups:keep', (g, modId, on) => service.setKeep(gid(g), modKey(modId), on === true));
  handle('groups:download', (g, picks, reqs) => download(g, picks, reqs));
  handle('groups:verify', picks => verify(picks));

  // The game has just closed: the app counts it as running for 20 s more (cloud saves), so wait past that.
  const onGameExit = () => { setTimeout(() => applyRemovals().then(pushView).catch(() => {}), 22e3).unref?.(); };
  return { start, stop, view, service, onGameExit, hasMapping: () => !!router.gw };
}

module.exports = { setupGroups };
