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

const NO_EXE = 'Vortex.exe was not found. Choose it in Settings > Vortex.';

// Windows takes at most 32,767 characters for one program's command line; Vortex is given its --set
// changes in batches well under that (hundreds of mods at once would not fit in one).
const CLI_BUDGET = 24000;
const CLI_TRIES = 3; // each batch: tried up to three times before it counts as failed

/**
 * Split `--set <path>=<value>` pairs into batches whose command line stays under the budget (the exe
 * path and quoting included). Each item: the value after --set. Returns [[args…], …].
 */
function cliBatches(exe, sets, budget = CLI_BUDGET) {
  const cost = a => a.length + 3; // a space and two quotes, at worst
  const base = cost(String(exe));
  const out = [];
  let cur = [];
  let len = base;
  for (const v of sets) {
    const n = cost('--set') + cost(v);
    if (cur.length && len + n > budget) { out.push(cur); cur = []; len = base; }
    cur.push('--set', v);
    len += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Vortex's uninstall entry (its installer's fixed id); its DisplayIcon is "<folder>\Vortex.exe,0". */
const VORTEX_UNINSTALL = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\57979c68-f490-55b8-8fed-8b017a5af2fe';

/**
 * A path on a drive (C:\…, not a network share) to a file named Vortex.exe: the only program this
 * app starts as Vortex. Shared with Settings, which checks the one chosen by hand the same way.
 */
const isVortexExe = p => typeof p === 'string' && /^[a-z]:[\\/]/i.test(p) && /[\\/]vortex\.exe$/i.test(p);

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** %NAME% replaced by that environment variable (a REG_EXPAND_SZ value); an unknown one stays as it is. */
const expandEnv = s => String(s).replace(/%([^%\s]+)%/g, (all, k) => {
  const hit = Object.keys(process.env).find(e => e.toLowerCase() === k.toLowerCase());
  return hit ? process.env[hit] : all;
});

/** One registry value (name '' = the key's default value); '' when there is none. Windows only. */
function regValue(key, name) {
  return new Promise(resolve => {
    execFile('reg', ['query', key, ...(name ? ['/v', name] : ['/ve'])], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return resolve('');
      const line = String(stdout).split(/\r?\n/).find(l => /\sREG_(?:EXPAND_)?SZ\s/.test(l));
      if (!line) return resolve('');
      const v = line.replace(/^.*?\sREG_(?:EXPAND_)?SZ\s+/, '').trim();
      resolve(/\sREG_EXPAND_SZ\s/.test(line) ? expandEnv(v) : v);
    });
  });
}

/** The program a registry value names: a quoted or bare path, without an icon index (",0") or arguments. */
function exeFromRegValue(v) {
  const s = String(v || '').trim();
  const m = s.match(/^"([^"]+)"/) || s.match(/^(.*?\.exe)(?=$|[\s,])/i);
  return m ? m[1].replace(/,\s*-?\d+$/, '').trim() : '';
}

class VortexBridge extends EventEmitter {
  /**
   * getExe: the Vortex.exe chosen in Settings ('' = find it). reg and platform are for tests.
   */
  constructor({ getGameDir, log, appData = process.env.APPDATA || '', getExe = () => '', reg = regValue, platform = process.platform }) {
    super();
    this.getGameDir = getGameDir;
    this.log = log;
    this.retryDelay = 1500; // ms before a failed Vortex command is tried again (times the try number)
    this.getExe = getExe;
    this.reg = reg;
    this.platform = platform;
    this.foundExe = ''; // found in the registry (findExe)
    this.root = path.join(appData, 'Vortex');
    this.cache = null;
    this.sig = '';
    this.busy = false;
  }

  get installed() { return fs.existsSync(path.join(this.root, 'state.v2')); }

  /** Vortex.exe ('' if not found). */
  exePath() {
    return this.exeInfo().exe;
  }

  /**
   * { exe, source, chosenMissing }: the Vortex.exe chosen in Settings (source 'manual'); else the
   * one found in the registry or in a usual place ('found'); else none (''). chosenMissing: one was
   * chosen but is no longer there (moved, uninstalled), so it is not used. Vortex is a Windows
   * program: none elsewhere.
   */
  exeInfo() {
    if (this.platform !== 'win32') return { exe: '', source: '', chosenMissing: false };
    const chosen = String(this.getExe() || '').trim();
    if (chosen && isVortexExe(chosen) && isFile(chosen)) return { exe: chosen, source: 'manual', chosenMissing: false };
    const exe = [
      this.foundExe,
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Black Tree Gaming Ltd', 'Vortex', 'Vortex.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'vortex', 'Vortex.exe'),
    ].find(p => p && isVortexExe(p) && isFile(p)) || '';
    return { exe, source: exe ? 'found' : '', chosenMissing: !!chosen };
  }

  /**
   * Look for Vortex.exe in the registry, which knows where it was installed (any drive or folder):
   * Vortex's own uninstall entry (for all users, or just this one), then the nxm:// link handler
   * when Vortex has it. Kept in foundExe; returns it ('' if not found). Windows only.
   */
  async findExe() {
    if (this.platform !== 'win32') return '';
    const wow = VORTEX_UNINSTALL.replace('Software\\', 'Software\\WOW6432Node\\');
    const tries = [
      [`HKLM\\${VORTEX_UNINSTALL}`, 'DisplayIcon'], [`HKCU\\${VORTEX_UNINSTALL}`, 'DisplayIcon'], [`HKLM\\${wow}`, 'DisplayIcon'],
      [`HKLM\\${VORTEX_UNINSTALL}`, 'InstallLocation'], [`HKCU\\${VORTEX_UNINSTALL}`, 'InstallLocation'],
      ['HKCU\\Software\\Classes\\nxm\\shell\\open\\command', ''], ['HKCR\\nxm\\shell\\open\\command', ''],
    ];
    // Asked all at once (each can take a moment); the first in this order that is there wins.
    const values = await Promise.all(tries.map(([key, name]) => Promise.resolve().then(() => this.reg(key, name)).then(v => String(v || ''), () => '')));
    for (const [i, [, name]] of tries.entries()) {
      const v = values[i];
      if (!v) continue;
      const exe = name === 'InstallLocation' ? path.win32.join(v.replace(/^"|"$/g, ''), 'Vortex.exe') : exeFromRegValue(v);
      if (isVortexExe(exe) && isFile(exe)) { this.foundExe = exe; return exe; }
    }
    this.foundExe = '';
    return '';
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

  /** Vortex's staging folder: the one its deployment record names (moved by the user), or its default. */
  stagingDir() {
    try {
      const p = JSON.parse(fs.readFileSync(this.deploymentFile(), 'utf8')).stagingPath;
      if (p && path.isAbsolute(p) && fs.existsSync(p)) return p;
    } catch { /* not deployed */ }
    return path.join(this.root, GAME, 'mods');
  }

  /** Read everything; cached until one of the source files changes. */
  read() {
    if (!this.installed) return { installed: false, mods: [], profiles: [] };
    const backup = this.latestBackup();
    const depFile = this.deploymentFile();
    let depMtime = 0;
    try { depMtime = fs.statSync(depFile).mtimeMs; } catch { /* not deployed */ }
    const staging = this.stagingDir();
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
   * changes: [{ vortexId, enabled }]. partial: a batch Vortex refuses (after three tries) leaves its
   * mods as they were and the rest go ahead; their ids come back in `failed` (moving mods over).
   * Without it, all or nothing: what went through is put back and an error says why.
   */
  async apply(changes, { partial = false } = {}) {
    if (this.busy) throw new Error('A change to Vortex is already being applied.');
    const exe = this.exePath();
    if (!exe) throw new Error(NO_EXE);
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

      // 1. Vortex records the new on/off states, in batches that fit a command line, each tried up to
      //    three times (Vortex can be slow to let go of its database).
      const pid = escapeKey(data.activeProfile);
      const stateSet = (id, on) => `persistent.profiles.${pid}.modState.${escapeKey(id)}.enabled=${on ? 'true' : 'false'}`;
      const groups = [];
      {
        let at = 0;
        for (const args of cliBatches(exe, changes.map(c => stateSet(c.vortexId, c.enabled)))) {
          const n = args.length / 2;
          groups.push({ args, changes: changes.slice(at, at + n) });
          at += n;
        }
      }
      const tryCli = async args => {
        let last;
        for (let i = 0; i < CLI_TRIES; i++) {
          try { return await this.runCli(exe, args); } catch (err) { last = err; }
          if (i < CLI_TRIES - 1) await new Promise(r => setTimeout(r, this.retryDelay * (i + 1)));
        }
        throw last;
      };
      const applied = [];
      const failed = [];
      let firstErr = null;
      const was = new Map(data.mods.map(m => [m.vortexId, !!m.enabled]));
      const backOf = list => list.map(c => stateSet(c.vortexId, was.get(c.vortexId) ?? !c.enabled));
      let unsettled = false; // a failed batch that may have been written in part and could not be put back
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        try {
          await tryCli(g.args);
          applied.push(...g.changes);
        } catch (err) {
          firstErr ||= err;
          if (partial) {
            // A run that failed may still have written some of it: those mods are put back as they were,
            // so a mod reported as left with Vortex really is as it was.
            for (const args of cliBatches(exe, backOf(g.changes))) { try { await this.runCli(exe, args); } catch { unsettled = true; } }
            failed.push(...g.changes);
            continue; // the others still go ahead
          }
          // All or nothing: what went through (and whatever of the failed batch got written) is put back.
          let undone = true;
          for (const args of cliBatches(exe, backOf([...applied, ...g.changes]))) { try { await tryCli(args); } catch { undone = false; } }
          if (wasRunning) this.startVortex(exe);
          const why = err.code === 'ENAMETOOLONG' ? 'too many mods at once' : err.message;
          if (!undone) this.log.warn('Vortex: some changes could not be undone; Vortex may show some mods switched.');
          throw new Error(`Vortex could not record the change${groups.length > 1 ? ` (part ${gi + 1} of ${groups.length})` : ''} after ${CLI_TRIES} tries: ${why}. ${undone ? 'Nothing was changed.' : 'Some of it could not be undone: check Vortex.'}`);
        }
      }
      if (!applied.length) {
        if (wasRunning) this.startVortex(exe);
        throw new Error(`Vortex could not record the change after ${CLI_TRIES} tries: ${firstErr?.code === 'ENAMETOOLONG' ? 'too many mods at once' : firstErr?.message || 'unknown'}. Nothing was changed.`);
      }
      // 2. Only what Vortex took in moves on: files are placed for those changes alone.
      const plan = manifest && gameDir ? planDeploy({ manifest, gameDir, changes: applied }) : null;
      const needVortex = !plan || plan.deferred.length > 0 || unsettled;
      if (unsettled) this.log.warn('Vortex: a batch that failed could not be put back; Vortex is asked to deploy again.');
      if (needVortex) {
        await tryCli(['--set', `persistent.deployment.needToDeploy.${GAME}=true`])
          .catch(err => this.log.warn(`Vortex: could not ask Vortex to deploy again (${err.message}). Deploy in Vortex once it is open.`));
      }
      changes = applied;

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
      return { reopened: reopen, ...(result || {}), failed: failed.map(c => c.vortexId) };
    } finally {
      this.busy = false;
    }
  }

  /** Ask Vortex to install a file (an update). Works whether or not Vortex is open. */
  installUrl(url) {
    const exe = this.exePath();
    if (!exe) throw new Error(NO_EXE);
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

module.exports = { VortexBridge, cliBatches, CLI_BUDGET, escapeKey, parseFolderName, isVortexExe, exeFromRegValue, expandEnv, NO_EXE };
