'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');

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
      return {
        id: `vx:${id}`,
        vortexId: id,
        source: 'vortex',
        name: a.customFileName || a.logicalFileName || a.modName || a.name || id,
        modName: a.modName || a.logicalFileName || a.name || id,
        modId: Number(a.modId) || 0,
        fileId: Number(a.fileId) || 0,
        version: a.version || '',
        author: a.author || a.uploader || '',
        game: GAME,
        type: m.type ? `Vortex (${m.type})` : 'Vortex',
        // The deployment record is live; the snapshot can be up to an hour old.
        enabled: files.length > 0 || (stateEnabled && !depMtime),
        deployedFiles: files,
        fileCount: files.length,
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
   * Turn Vortex mods on or off in Vortex's active profile. Closes Vortex (gracefully), applies the
   * change with Vortex's own command line, and starts Vortex again so it deploys.
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
        this.log.info('Closing Vortex to apply the change…');
        await this.closeVortex();
      }
      const pid = escapeKey(data.activeProfile);
      const args = [];
      for (const c of changes) {
        args.push('--set', `persistent.profiles.${pid}.modState.${escapeKey(c.vortexId)}.enabled=${c.enabled ? 'true' : 'false'}`);
      }
      args.push('--set', `persistent.deployment.needToDeploy.${GAME}=true`);
      await this.runCli(exe, args);
      this.log.success(`Vortex: ${changes.filter(c => c.enabled).length} enabled, ${changes.filter(c => !c.enabled).length} disabled. Vortex is reopening to deploy.`);
      this.cache = null;
      this.startVortex(exe);
      this.watchForDeploy();
      return { reopened: true };
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

module.exports = { VortexBridge, escapeKey };
