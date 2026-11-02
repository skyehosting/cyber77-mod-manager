'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const { planDeploy, runDeploy, listFiles } = require('./vortexDeploy');
const { describeType } = require('./layout');

/*
 * Vortex, side by side. Vortex stays the owner of its mods; this reads them and asks Vortex to
 * change them.
 *
 * Reading (Vortex can stay open):
 *   <game>/vortex.deployment.json             live: every file Vortex placed, and the mod it came from
 *   %APPDATA%/Vortex/temp/state_backups_full  Vortex's own JSON snapshots (hourly): mods with their
 *                                             Nexus ids, versions, profiles and enabled flags
 *   %APPDATA%/Vortex/cyberpunk2077/mods       the staging folder (a mod per folder)
 *
 * Changing: Vortex's database is locked while it runs, so a change closes Vortex gracefully, applies
 * it with Vortex's own command line (`Vortex.exe --set <path>=<value>`, the documented way to edit
 * its state), marks a deployment as needed, and starts Vortex again, which then deploys.
 */

const GAME = 'cyberpunk2077';

/** Vortex state paths split on dots; dots inside a key are escaped with a backslash. */
/**
 * Vortex names a mod's folder after its archive: "Name 4198 1.28.3 2026-10-28T19-16Z KRvfRxo6q"
 * (newer) or "Name-4198-1-28-3-1712345678" (older). Used only until Vortex's snapshot has the mod.
 */
function parseFolderName(id) {
  let m = String(id).match(/^(.*?) (\d{2,6}) (\S+) \d{4}-\d{2}-\d{2}T\S+ \S+$/);
  if (m) return { name: m[1].trim(), modId: Number(m[2]), version: m[3] };
  m = String(id).match(/^(.*?)-(\d{2,6})-((?:\d+-)*\d+)-(\d{9,})$/);
  if (m) return { name: m[1].trim(), modId: Number(m[2]), version: m[3].replace(/-/g, '.') };
  return {};
}

const escapeKey = k => String(k).replace(/\\/g, '\\\\').replace(/\./g, '\\.');

class VortexBridge extends EventEmitter {
  constructor({ getGameDir, log, appData = process.env.APPDATA || '' }) {
    super();
    this.getGameDir = getGameDir;
    this.log = log;
    this.root = path.join(appData, 'Vortex');
    this.cache = null;
    this.sig = '';
    this.busy = false;
  }

  get installed() { return fs.existsSync(path.join(this.root, 'state.v2')); }

  exePath() {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Black Tree Gaming Ltd', 'Vortex', 'Vortex.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'vortex', 'Vortex.exe'),
    ];
    return candidates.find(p => fs.existsSync(p)) || '';
  }

  isRunning() {
    return new Promise(resolve => {
      execFile('tasklist', ['/FI', 'IMAGENAME eq Vortex.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
        resolve(!err && /"Vortex\.exe"/i.test(out));
      });
    });
  }

  /** The newest of Vortex's own state snapshots. */
  latestBackup() {
    const dir = path.join(this.root, 'temp', 'state_backups_full');
    let best = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const st = fs.statSync(path.join(dir, f));
        if (!best || st.mtimeMs > best.mtime) best = { file: path.join(dir, f), mtime: st.mtimeMs };
      }
    } catch { /* no backups */ }
    return best;
  }

  deploymentFile() {
    const g = this.getGameDir();
    return g ? path.join(g, 'vortex.deployment.json') : '';
  }

  /** Read everything; cached until one of the source files changes. */
  read() {
    if (!this.installed) return { installed: false, mods: [], profiles: [] };
    const backup = this.latestBackup();
    const depFile = this.deploymentFile();
    let depMtime = 0;
    try { depMtime = fs.statSync(depFile).mtimeMs; } catch { /* not deployed */ }
    const staging = path.join(this.root, GAME, 'mods');
    let stagingMtime = 0;
    try { stagingMtime = fs.statSync(staging).mtimeMs; } catch { /* no staging */ }
    const sig = `${backup?.file}|${backup?.mtime}|${depMtime}|${stagingMtime}`;
    if (this.cache && sig === this.sig) return this.cache;

    let state = {};
    try { state = JSON.parse(fs.readFileSync(backup.file, 'utf8')); } catch { /* unreadable */ }
    let dep = { files: [] };
    try { dep = JSON.parse(fs.readFileSync(depFile, 'utf8')); } catch { /* none */ }

    const modsState = state.persistent?.mods?.[GAME] || {};
    const profilesAll = state.persistent?.profiles || {};
    const activeProfile = state.settings?.profiles?.lastActiveProfile?.[GAME] || '';
    const profiles = Object.values(profilesAll).filter(p => p.gameId === GAME).map(p => ({
      id: p.id, name: p.name, active: p.id === activeProfile,
      enabledIds: Object.entries(p.modState || {}).filter(([, s]) => s.enabled).map(([id]) => id),
    }));
    const active = profilesAll[activeProfile];

    // Live: what Vortex has actually placed, by source mod.
    const deployed = new Map();
    for (const f of dep.files || []) {
      if (!deployed.has(f.source)) deployed.set(f.source, []);
      deployed.get(f.source).push(f.relPath.replace(/\\/g, '/'));
    }

    const ids = new Set(Object.keys(modsState));
    let folders = [];
    try { folders = fs.readdirSync(staging, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* none */ }
    // Mods installed after the last snapshot exist only as staging folders: list them too.
    for (const f of folders) if (!ids.has(f) && !f.endsWith('.installing')) ids.add(f);

    const mods = [...ids].map(id => {
      const m = modsState[id] || { id, installationPath: id, attributes: {}, type: '' };
      const a = m.attributes || {};
      const files = deployed.get(id) || [];
      const stateEnabled = !!active?.modState?.[id]?.enabled;
      // A mod installed after the last snapshot: what its folder name says (name, Nexus id, version).
      const guess = modsState[id] ? {} : parseFolderName(id);
      // Every file the mod has, deployed or not, tells what kind of mod it is.
      const all = files.length ? files : listFiles(path.join(staging, id)).map(p => p.replace(/\\/g, '/'));
      return {
        id: `vx:${id}`,
        vortexId: id,
        source: 'vortex',
        name: a.customFileName || a.logicalFileName || a.modName || a.name || guess.name || id,
        modName: a.modName || a.logicalFileName || a.name || guess.name || id,
        // Versions of one Nexus file share this name (Vortex's own "logical file name").
        fileName: a.logicalFileName || a.customFileName || a.name || guess.name || id,
        modId: Number(a.modId) || guess.modId || 0,
        fileId: Number(a.fileId) || 0,
        // The archive Vortex installed it from (in its downloads folder), when known.
        archiveName: a.fileName || '',
        version: a.version || guess.version || '',
        author: a.author || a.uploader || '',
        game: GAME,
        type: m.type ? `${describeType(all)} (${m.type})` : describeType(all),
        // The deployment record is live; the snapshot can be up to an hour old.
        enabled: files.length > 0 || (stateEnabled && !depMtime),
        deployedFiles: files,
        fileCount: all.length,
        installedAt: a.installTime ? Date.parse(a.installTime) : 0,
        category: 'VORTEX',
        known: !!modsState[id],
      };
    });
    mods.sort((a, b) => a.name.localeCompare(b.name));

    this.cache = {
      installed: true,
      exe: this.exePath(),
      snapshotTime: backup?.mtime || 0,
      deployedAt: depMtime,
      activeProfile,
      activeProfileName: active?.name || '',
      profiles,
      mods,
      deployedPaths: new Map([...deployed].flatMap(([src, files]) => files.map(f => [f.toLowerCase(), src]))),
    };
    this.sig = sig;
    return this.cache;
  }

  /**
   * Turn Vortex mods on or off in Vortex's active profile, without opening Vortex:
   *   1. Vortex's own command line records the new state (`Vortex.exe --set …` changes its
   *      database and quits; no window). Vortex locks that database while it runs, so an open
   *      Vortex is closed first and reopened afterwards.
   *   2. The files are hardlinked into / removed from the game folder here, exactly as Vortex's
   *      hardlink deployment does, and vortex.deployment.json is updated to match.
   * Files two Vortex mods both ship are left to Vortex's own rules: a deployment is marked as
   * needed and Vortex settles them on its next start.
   * changes: [{ vortexId, enabled }]
   */
  async apply(changes) {
    if (this.busy) throw new Error('A change to Vortex is already being applied.');
    const exe = this.exePath();
    if (!exe) throw new Error('Vortex.exe was not found.');
    const data = this.read();
    if (!data.activeProfile) throw new Error('Vortex has no active Cyberpunk 2077 profile.');
    this.busy = true;
    try {
      const wasRunning = await this.isRunning();
      if (wasRunning) {
        this.log.info('Closing Vortex to apply the change (it locks its data while open)…');
        await this.closeVortex();
      }
      const gameDir = this.getGameDir();
      const manifestFile = this.deploymentFile();
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* none */ }
      const plan = manifest && gameDir ? planDeploy({ manifest, gameDir, changes }) : null;
      const needVortex = !plan || plan.deferred.length > 0;

      const pid = escapeKey(data.activeProfile);
      const args = [];
      for (const c of changes) {
        args.push('--set', `persistent.profiles.${pid}.modState.${escapeKey(c.vortexId)}.enabled=${c.enabled ? 'true' : 'false'}`);
      }
      if (needVortex) args.push('--set', `persistent.deployment.needToDeploy.${GAME}=true`);
      await this.runCli(exe, args);

      let result = null;
      if (plan) {
        try {
          result = runDeploy(plan, manifest, manifestFile);
        } catch (err) {
          // Half done: let Vortex redo the deployment properly.
          await this.runCli(exe, ['--set', `persistent.deployment.needToDeploy.${GAME}=true`]).catch(() => {});
          throw new Error(`Could not place the files (${err.message}). Vortex will redeploy the next time it starts.`);
        }
      }
      // Which mods, by name and version, so the Manager log says what happened.
      const label = c => {
        const m = data.mods.find(x => x.vortexId === c.vortexId);
        return m ? `${m.name}${m.version ? ` v${m.version}` : ''}` : c.vortexId;
      };
      const on = changes.filter(c => c.enabled).map(label);
      const off = changes.filter(c => !c.enabled).map(label);
      const what = [on.length ? `enabled ${on.join(', ')}` : '', off.length ? `disabled ${off.join(', ')}` : ''].filter(Boolean).join('; ');
      if (result) {
        this.log.success(`Vortex: ${what} (without opening Vortex: ${result.linked} files placed, ${result.removed} removed)`);
        if (result.deferred) this.log.warn(`${result.deferred} files are shipped by more than one Vortex mod, or are already in the game folder. Vortex decides those the next time it starts.`);
        if (result.kept) this.log.warn(`${result.kept} files had been replaced by another tool and were left in place.`);
      } else {
        this.log.success(`Vortex: ${what}. This deployment can only be done by Vortex, so Vortex is opening to deploy.`);
      }
      this.cache = null;
      // Vortex is opened again only if it was open, or if only Vortex can deploy this.
      const reopen = wasRunning || !plan;
      if (reopen) {
        this.startVortex(exe);
        this.watchForDeploy();
      } else {
        this.emit('changed', true);
      }
      return { reopened: reopen, ...(result || {}) };
    } finally {
      this.busy = false;
    }
  }

  /** Ask Vortex to install a file (an update). Works whether or not Vortex is open. */
  installUrl(url) {
    const exe = this.exePath();
    if (!exe) throw new Error('Vortex.exe was not found.');
    spawn(exe, ['-i', url], { detached: true, stdio: 'ignore' }).unref();
  }

  closeVortex() {
    return new Promise((resolve, reject) => {
      // No /F: Vortex gets a normal close request and saves its state first.
      execFile('taskkill', ['/IM', 'Vortex.exe'], { windowsHide: true }, async () => {
        for (let i = 0; i < 60; i++) {
          if (!(await this.isRunning())) return resolve();
          await new Promise(r => setTimeout(r, 500));
        }
        reject(new Error('Vortex did not close. Close it yourself, then try again.'));
      });
    });
  }

  runCli(exe, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout?.on('data', d => { out += d; });
      child.stderr?.on('data', d => { err += d; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Vortex did not finish applying the change.')); }, 60000);
      child.on('close', () => {
        clearTimeout(timer);
        if (/error|locked/i.test(err) && !/changed/.test(out)) reject(new Error(`Vortex could not apply the change: ${err.trim().split('\n')[0]}`));
        else resolve(out);
      });
      child.on('error', e => { clearTimeout(timer); reject(e); });
    });
  }

  startVortex(exe) {
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  }

  /** Tell the UI when Vortex has redeployed (its deployment record changes). */
  watchForDeploy() {
    const file = this.deploymentFile();
    let start = 0;
    try { start = fs.statSync(file).mtimeMs; } catch { /* none */ }
    let ticks = 0;
    const t = setInterval(() => {
      ticks++;
      let now = 0;
      try { now = fs.statSync(file).mtimeMs; } catch { /* none */ }
      if (now !== start || ticks > 120) {
        clearInterval(t);
        this.cache = null;
        this.emit('changed', now !== start);
      }
    }, 2000);
  }
}

module.exports = { VortexBridge, escapeKey, parseFolderName };
