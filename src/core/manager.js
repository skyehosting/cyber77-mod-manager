'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { JsonStore } = require('./jsonStore');
const { NexusClient, parseModUrl, parseNxm, requirementOnNexus } = require('./nexus');
const { redmodToolsInstalled } = require('./launcher');
const { Downloader } = require('./downloader');
const { Installer, isSafeRel } = require('./installer');
const { Deployer } = require('./deployer');
const { isGameDir, gameWindowsFolders } = require('./gameFinder');
const { caseResolver } = require('./fileCase');
const { sanitizeName } = require('./layout');
const { ownerRoot } = require('./gameLogs');
const { findUpdate } = require('./updates');
const { VortexBridge, parseFolderName } = require('./vortex');
const { listFiles, removeEmptyDirs } = require('./vortexDeploy');
const { Mo2Bridge } = require('./mo2');
const { ProfileSaves, defaultStoreDir, defaultHomeDir, ID: PROFILE_ID } = require('./profileSaves');

const GAME_RUNNING_SAVES = 'Close Cyberpunk 2077 first: each profile has its own saves, and they change with the profile. (Just closed it? Give it a few seconds to finish syncing its saves.)';
const { SaveBackups, scanSaves, groupPlaythroughs, savesFingerprint, defaultSavesDir, defaultBackupDir, REASONS, SLOT: SAVE_SLOT } = require('./saves');
const loadOrder = require('./loadOrder');

const PROFILE_FORMAT = 'cyber-mod-manager-profile';
const profileCode = require('./profileCode');
const archiveTools = require('./archive');
const MAX_PROFILE_MODS = 1000;
const MAX_PROFILE_ARCHIVES = 5000;
const MAX_PROFILE_PICKS = 20000;

/** Each file (lower-case path) → the mods that have it, in the order given (lowest priority first). */
function providersOf(mods) {
  const providers = new Map();
  for (const m of mods) for (const f of m.files) {
    const k = f.toLowerCase();
    if (!providers.has(k)) providers.set(k, []);
    providers.get(k).push(m.id);
  }
  return providers;
}

/** A shared profile's archive load order: plain .archive file names only (no folders), each once. */
function validOrder(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.slice(0, MAX_PROFILE_ARCHIVES).map(String)
    .filter(n => n.length <= 250 && n === n.trim() && /^[^\\/:*?"<>|\x00-\x1f]+\.archive$/i.test(n) && !/^\.+$/.test(n.slice(0, -8)) && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

/**
 * A shared profile's file picks: [{ file, mod, among }] with mod and among as places in its mod
 * list (count: how many mods it lists). file: a relative game path, lower case, forward slashes.
 */
function validPicks(list, count) {
  if (!Array.isArray(list)) return [];
  const place = x => (Number.isInteger(x) && x >= 0 && x < count ? x : -1);
  const out = new Map();
  for (const raw of list.slice(0, MAX_PROFILE_PICKS)) {
    if (!raw || typeof raw !== 'object' || typeof raw.file !== 'string' || raw.file.length > 400) continue;
    const file = raw.file.replace(/\\/g, '/').toLowerCase();
    if (!isSafeRel(file) || file === '__proto__') continue;
    const mod = place(raw.mod);
    const among = [...new Set([mod, ...(Array.isArray(raw.among) ? raw.among.slice(0, 100).map(place) : [])])].filter(x => x >= 0);
    if (mod >= 0 && among.length > 1) out.set(file, { file, mod, among });
  }
  return [...out.values()];
}

/** FOMOD choices from a shared file: { step: { group: [optionIndex] } } with small integers only. */
function validChoices(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const out = {};
  for (const [s, groups] of Object.entries(c).slice(0, 50)) {
    if (!/^\d{1,3}$/.test(s) || !groups || typeof groups !== 'object' || Array.isArray(groups)) return null;
    out[s] = {};
    for (const [g, picks] of Object.entries(groups).slice(0, 50)) {
      if (!/^\d{1,3}$/.test(g) || !Array.isArray(picks)) return null;
      out[s][g] = picks.filter(n => Number.isInteger(n) && n >= 0 && n < 500).slice(0, 100);
    }
  }
  return out;
}
const catOf = f => String(f.category_name || f.category || 'MISCELLANEOUS').toUpperCase();
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
// Files a mod may rewrite while the game runs (its settings, databases, logs).
const WRITABLE = /\.(json|ini|cfg|conf|toml|ya?ml|xml|txt|log|sqlite3?|db)$/i;
const samePath = (a, b) => path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
/** The parts of a Nexus file record the UI shows. */
/** Nexus descriptions are BBCode/HTML: keep the words only. */
const plainText = t => String(t || '').replace(/<br\s*\/?>/gi, '\n').replace(/\[\/?[a-z0-9=#*"' -]+\]/gi, '').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
function sevenZip(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  if (process.platform !== 'win32') {
    // Linux: a bundled 7zz, else 7-Zip's own 7zz or p7zip's 7z/7za from PATH.
    const bundled = process.resourcesPath ? path.join(process.resourcesPath, '7zip', '7zz') : '';
    if (bundled && fs.existsSync(bundled)) return bundled;
    const runnable = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
    for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(d => path.isAbsolute(d))) {
      for (const name of ['7zz', '7z', '7za']) if (runnable(path.join(dir, name))) return path.join(dir, name);
    }
    return configured;
  }
  const bundled = process.resourcesPath ? path.join(process.resourcesPath, '7zip', '7z.exe') : '';
  return bundled && fs.existsSync(bundled) ? bundled : configured;
}

/**
 * The Nexus file an installed mod came from, when only its Nexus mod is known (mods moved over from
 * Vortex, or installed from a file named like a Nexus download): the file with the installed version,
 * narrowed by name, then by Main. Null when none, or more than one, fits.
 */
function matchNexusFile(files, mod) {
  const norm = v => String(v || '').toLowerCase().replace(/^v(?=\d)/, '').trim();
  const words = s => String(s || '').toLowerCase().replace(/\.(zip|7z|rar)$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(mod.version);
  if (!want) return null;
  let hits = (files || []).filter(f => norm(f.version || f.mod_version) === want && catOf(f) !== 'DELETED');
  if (hits.length > 1) {
    const name = words(mod.name);
    const exact = hits.filter(f => words(f.name || f.file_name) === name);
    const named = hits.filter(f => { const n = words(f.name || f.file_name); return n && (name.includes(n) || n.includes(name)); });
    if (exact.length) hits = exact; else if (named.length) hits = named;
  }
  if (hits.length > 1) {
    const main = hits.filter(f => catOf(f) === 'MAIN');
    if (main.length) hits = main;
  }
  return hits.length === 1 ? hits[0] : null;
}

/** "A, B and C" or "A, B, C and 9 more": who an action was about. */
const nameList = (mods, max = 6) => {
  const names = mods.map(m => (m.version ? `${m.name} v${m.version}` : m.name));
  if (names.length <= 1) return names[0] || 'nothing';
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return rest ? `${shown.join(', ')} and ${rest} more` : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
};

const publicFile = f => ({ fileId: f.file_id, name: f.name || f.file_name, fileName: f.file_name, category: catOf(f), version: f.version || f.mod_version || '', size: (f.size_in_bytes || (f.size_kb || 0) * 1024) || 0 });

const CATEGORY_FOLDERS = {
  MAIN: 'Main', UPDATE: 'Update', OPTIONAL: 'Optional', OLD_VERSION: 'Old versions',
  MISCELLANEOUS: 'Miscellaneous', ARCHIVED: 'Archived', DELETED: 'Deleted', LOCAL: 'Local',
};

/**
 * The application core: download library, installed mods and their deployment.
 * Emits 'changed' (library snapshot needed), 'job' (download progress), 'fomod' (wizard request).
 */
class ModManager extends EventEmitter {
  constructor({ settings, log }) {
    super();
    this.settings = settings;
    this.log = log;
    const dataDir = settings.get('dataDir');
    this.library = new JsonStore(path.join(dataDir, 'library.json'), { downloads: {}, mods: {}, nextPriority: 1 });
    // Requirements read 50 mods a request were cut to 20 by Nexus, and the rest kept as "none": the
    // empty ones are asked again (once, after the fix).
    if (!this.library.data.reqPage20) {
      for (const [k, v] of Object.entries(this.library.data.requirements || {})) if (!v?.list?.length) delete this.library.data.requirements[k];
      this.library.data.reqPage20 = true;
      this.library.save();
    }
    this.nexus = new NexusClient(() => settings.apiKey, log);
    this.downloader = new Downloader(this.nexus, log, () => settings.get('concurrentDownloads'));
    // The 7-Zip set in Settings, else the copy that ships with the installed app.
    this.installer = new Installer({ getSevenZip: () => sevenZip(settings.get('sevenZipPath')), tempDir: () => settings.tempDir, log });
    this.deployer = new Deployer({ manifestFile: path.join(dataDir, 'deployment.json'), backupDir: settings.backupDir, log });
    this.deployer.staleOriginal = (dest, file) => this.vortexStaleCopy(dest, file);
    this.pendingFomod = new Map();
    this.plans = new Map();
    this.profileImports = new Map();
    this.ensureProfiles();
    // CMM_VORTEX_APPDATA points tests (and the screenshot harness) away from the real Vortex.
    this.vortex = new VortexBridge({ getGameDir: () => this.gameDir(), log, appData: process.env.CMM_VORTEX_APPDATA ?? process.env.APPDATA });
    this.vortex.on('changed', () => this.emit('changed'));
    // CMM_MO2_LOCALAPPDATA / CMM_MO2_SCAN=off keep tests away from the real Mod Organizer 2.
    this.mo2 = new Mo2Bridge({
      log, localAppData: process.env.CMM_MO2_LOCALAPPDATA ?? process.env.LOCALAPPDATA,
      scan: process.env.CMM_MO2_SCAN !== 'off', extraFolders: () => settings.get('mo2Folders'),
    });
    // Save backups: outside the app and the game's save folder (Settings, Save manager can move them).
    this.saves = new SaveBackups({ savesDir: () => this.gameSavesDir(), root: () => settings.get('saveBackupDir') || defaultBackupDir(), log });
    // Per-profile saves (Settings, Save manager): other profiles' saves wait in folders of their own.
    this.profileSaves = new ProfileSaves({ savesDir: () => this.saves.savesDir(), root: defaultStoreDir, log });
    this.gameRunning = () => false; // main.js puts the real check here
    // README.txt beside the backups and profile saves (what the uninstaller points to), kept current.
    this.savesHome = defaultHomeDir;
    this.on('saves', () => {
      clearTimeout(this.readmeTimer);
      this.readmeTimer = setTimeout(() => { try { this.writeSavesReadme(); } catch (err) { this.log.warn('Could not write README.txt beside your save backups', err.message); } }, 2000);
      this.readmeTimer.unref?.();
    });
    this.chain = Promise.resolve();

    this.downloader.on('update', job => this.emit('job', job));
    this.downloader.on('done', job => this.onDownloaded(job));
    fs.rmSync(settings.tempDir, { recursive: true, force: true });
  }

  get data() { return this.library.data; }

  /** True while work is in progress that a restart (an app update) must not cut off. */
  get busy() {
    const dl = this.downloader;
    return (this.pendingOps || 0) > 0 || dl.active > 0 || dl.queue.length > 0 || this.pendingFomod.size > 0 || !!this.vortex.busy;
  }

  /** Run state-changing work one at a time. */
  op(fn, { quiet = false } = {}) {
    this.pendingOps = (this.pendingOps || 0) + 1;
    const run = this.chain.then(fn).finally(() => { this.pendingOps--; });
    this.chain = run.catch(() => {});
    // Quiet work (the background health check) announces its own changes, if any.
    return quiet ? run : run.finally(() => this.emit('changed'));
  }

  gameDir() {
    const deployedTo = this.deployer.store.data.gameDir;
    if (deployedTo && Object.keys(this.deployer.deployed).length) return deployedTo;
    return this.settings.get('gamePath');
  }

  /**
   * Linux: where the game keeps its Windows folders (its Wine/Proton prefix; see gameFinder), worked
   * out again when the game folder changes or after a few seconds (the prefix appears at the first
   * launch). null on Windows or while unknown.
   */
  gameFolders() {
    const dir = this.gameDir();
    const c = this.foldersCache;
    if (c && c.dir === dir && Date.now() - c.at < 5000) return c.folders;
    let folders = null;
    try { folders = gameWindowsFolders(dir); } catch (err) { this.log.warn('Could not look for the game\'s Proton folder', err.message); }
    this.foldersCache = { dir, at: Date.now(), folders };
    return folders;
  }

  /** The game's save folder: Windows' own, or inside the game's prefix on Linux ('' while unknown). */
  gameSavesDir() {
    if (process.env.CMM_SAVES_DIR !== undefined || process.platform === 'win32') return defaultSavesDir();
    return this.gameFolders()?.saves || '';
  }

  /** The game's crash reporter's folder (ReportQueue), '' while unknown. */
  crashDir() {
    if (process.platform === 'win32') return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'REDEngine', 'ReportQueue') : '';
    return this.gameFolders()?.crashDir || '';
  }

  // ---------------------------------------------------------------- snapshot for the UI

  snapshot() {
    const mods = Object.values(this.data.mods).sort((a, b) => b.priority - a.priority);
    const enabled = mods.filter(m => m.enabled).sort((a, b) => a.priority - b.priority);
    const providers = providersOf(enabled);
    const conflicts = {};
    for (const [key, list] of providers) {
      if (list.length < 2) continue;
      const winner = this.fileWinner(key, list);
      for (const id of list) {
        conflicts[id] ||= { wins: 0, loses: 0, with: new Set() };
        if (id === winner) conflicts[id].wins++; else conflicts[id].loses++;
        list.filter(x => x !== id).forEach(x => conflicts[id].with.add(x));
      }
    }
    for (const c of Object.values(conflicts)) c.with = [...c.with];

    const installedKeys = new Set(Object.values(this.data.mods).map(m => m.key));
    const downloads = Object.values(this.data.downloads)
      .map(d => ({ ...d, installed: installedKeys.has(d.key), exists: fs.existsSync(d.path) }))
      .sort((a, b) => (a.modName.localeCompare(b.modName)) || (a.category.localeCompare(b.category)) || a.name.localeCompare(b.name));
    const game = this.gameDir();
    const vortex = this.vortexView();
    return {
      mods: mods.map(m => ({
        ...m, fileCount: m.files.length, files: undefined,
        // Folders this mod owns (red4ext/plugins/X, CET mods/X, mods/X): links game-log problems to it.
        roots: [...new Set(m.files.map(ownerRoot).filter(Boolean))],
      })),
      downloads,
      jobs: this.downloader.list(),
      conflicts,
      game: { path: game, valid: isGameDir(game) },
      rate: this.nexus.rate,
      pendingFomod: [...this.pendingFomod.keys()],
      updates: this.data.updates || {},
      lastUpdateCheck: this.data.lastUpdateCheck || 0,
      profiles: this.profilesView(),
      vortex,
      mo2: this.mo2View(),
      reqs: this.requirementsView(vortex),
    };
  }

  /**
   * Which enabled mod's copy of a shared file goes into the game: the one picked in the conflict
   * window (data.fileChoices: lower-case path → { id, among }) while that mod provides it, else the highest
   * priority's. providers: the ids that have the file, lowest priority first.
   */
  fileWinner(key, providers) {
    const pick = this.pickOf(key);
    // A pick holds among the mods it was made among: one enabled since that also has the file (by a
    // profile switch, say, without the window) is not outvoted by it; priority decides until asked.
    const holds = pick && providers.includes(pick.id) && providers.every(x => pick.among.includes(x));
    return holds ? pick.id : providers[providers.length - 1];
  }

  /** The pick for a file (lower-case path): { id, among } (the mods it was chosen among), or null. */
  pickOf(key) {
    const list = this.data.fileChoices;
    const pick = list && Object.hasOwn(list, key) ? list[key] : null;
    return pick && typeof pick.id === 'string' && Array.isArray(pick.among) ? pick : null;
  }

  /**
   * File conflicts between this mod and every other enabled mod: for each other mod, the shared
   * files, whose copy of each is in the game (`items`: { file, winner, chosen, same, providers }),
   * and whether this mod wins all of them (weWin) or some (mixed).
   */
  conflictDetails(id) {
    const mod = this.data.mods[id];
    if (!mod) return [];
    const mine = new Set(mod.files.map(f => f.toLowerCase()));
    const enabled = Object.values(this.data.mods).filter(m => m.enabled || m.id === id).sort((a, b) => a.priority - b.priority);
    const providers = providersOf(enabled);
    const named = ids => ids.map(x => ({ id: x, name: this.data.mods[x]?.name || x }));
    const out = [];
    for (const other of Object.values(this.data.mods)) {
      if (other.id === id || !other.enabled) continue;
      const shared = other.files.filter(f => mine.has(f.toLowerCase())).sort();
      if (!shared.length) continue;
      const items = shared.map(f => {
        const key = f.toLowerCase();
        const list = providers.get(key);
        const winner = this.fileWinner(key, list);
        return { file: f, winner, chosen: this.pickOf(key)?.id === winner, same: this.sameCopies(list, key), providers: named(list) };
      });
      const ours = items.filter(x => x.winner === id).length;
      out.push({ id: other.id, name: other.name, priority: other.priority, weWin: ours === items.length, mixed: ours > 0 && ours < items.length, files: shared, items });
    }
    return out.sort((a, b) => b.files.length - a.files.length);
  }

  /**
   * Files that mods about to be enabled (ids) share with the mods enabled now (or each other), for the
   * window that asks whose copy loads: one group per such mod, [{ mod, others, files: [{ file,
   * providers, winner, same }] }] (mod and each provider: { id, name }). A group is there only when
   * one of its files has copies that differ and no pick made among all the mods that have it now.
   * Each file is in one group only.
   */
  conflictPlan(ids) {
    const want = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(id => Object.hasOwn(this.data.mods, id)).map(id => this.data.mods[id]).filter(m => !m.enabled);
    if (!want.length) return [];
    const after = [...Object.values(this.data.mods).filter(m => m.enabled), ...want].sort((a, b) => a.priority - b.priority);
    const providers = providersOf(after);
    const named = list => list.map(x => ({ id: x, name: this.data.mods[x].name }));
    const out = [];
    const seen = new Set();
    for (const a of want) {
      const files = [];
      for (const f of a.files) {
        const key = f.toLowerCase();
        const list = providers.get(key);
        if (list.length < 2 || seen.has(key)) continue;
        seen.add(key);
        const pick = this.pickOf(key);
        const decided = pick && list.includes(pick.id) && list.every(x => pick.among.includes(x));
        // Identical copies need no choice; files already decided among these same mods are not asked again.
        files.push({ file: f, key, providers: named(list), winner: this.fileWinner(key, list), decided });
      }
      for (const f of files) f.same = f.decided ? false : this.sameCopies(f.providers.map(p => p.id), f.key);
      if (!files.some(f => !f.same && !f.decided)) continue;
      const others = [...new Set(files.flatMap(f => f.providers.map(p => p.id)))].filter(x => x !== a.id);
      out.push({ mod: { id: a.id, name: a.name }, others: named(others), files: files.map(({ key, ...f }) => f).sort((x, y) => x.file.localeCompare(y.file)) });
    }
    return out;
  }

  /**
   * Whose copy of shared files loads: choices is { path: { id, among } } (among: the mods the choice
   * was made among, the picked one included), or { path: null } to forget it (the highest priority
   * wins again). Only mods that have that file count. Redeploys; nothing is kept if that fails.
   */
  setFileChoices(choices) {
    return this.op(async () => {
      const before = JSON.parse(JSON.stringify(this.data.fileChoices || {}));
      const list = (this.data.fileChoices ||= {});
      const hasFile = (id, key) => Object.hasOwn(this.data.mods, id) && this.data.mods[id].files.some(f => f.toLowerCase() === key);
      let n = 0;
      for (const [file, pick] of Object.entries(choices && typeof choices === 'object' ? choices : {}).slice(0, 20000)) {
        const key = String(file).toLowerCase();
        if (key === '__proto__') continue; // never a game file; would reach the object's prototype
        if (pick === null) { if (Object.hasOwn(list, key)) { delete list[key]; n++; } continue; }
        const id = String(pick?.id ?? '');
        if (!hasFile(id, key)) continue;
        const among = [...new Set([id, ...(Array.isArray(pick.among) ? pick.among.map(String) : [])])].filter(x => hasFile(x, key)).slice(0, 100);
        list[key] = { id, among };
        n++;
      }
      if (n) {
        try {
          this.deploy();
        } catch (err) {
          this.data.fileChoices = before;
          throw err;
        }
        this.log.success(`Saved whose copy loads for ${plural(n, 'shared file')}`);
      }
      return { saved: n };
    });
  }

  /**
   * Are all these mods' staged copies of a file the same bytes (so nothing needs choosing)? Size
   * first, then a hash. Files over 16 MB (archives: reading them would hold up the app) or unreadable
   * count as different. Hashes are remembered per copy.
   */
  sameCopies(ids, key) {
    const files = ids.map(id => {
      const m = this.data.mods[id];
      const rel = m?.files.find(f => f.toLowerCase() === key);
      return rel ? path.join(this.settings.stagingDir, m.id, rel) : '';
    });
    if (files.length < 2 || files.some(f => !f)) return false;
    try {
      const stats = files.map(f => fs.statSync(f));
      if (stats.some(s => s.size !== stats[0].size) || stats[0].size > 16 * 1024 * 1024) return false;
      const first = this.stagedHash(files[0], stats[0]);
      return files.every((f, i) => this.stagedHash(f, stats[i]) === first);
    } catch {
      return false;
    }
  }

  stagedHash(file, st) {
    this.hashCache ||= new Map();
    const tag = `${file}|${st.size}|${st.mtimeMs}`;
    if (this.hashCache.has(tag)) {
      const v = this.hashCache.get(tag);
      this.hashCache.delete(tag); // most recently used last
      this.hashCache.set(tag, v);
      return v;
    }
    const v = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    this.hashCache.set(tag, v);
    if (this.hashCache.size > 5000) this.hashCache.delete(this.hashCache.keys().next().value);
    return v;
  }

  modFiles(id) {
    const mod = this.data.mods[id];
    if (!mod) return null;
    const owners = this.deployer.owners();
    return mod.files.map(f => ({ dest: f, deployed: owners[f.toLowerCase()] === id, owner: owners[f.toLowerCase()] || null }));
  }

  /**
   * Who put each file in the game folder: files (lower-case path → { mod, by }) for the copies this
   * app and Vortex placed, and roots (a mod's own folder → { mod, by }) for files a mod writes there.
   */
  fileOwners() {
    const files = new Map();
    const roots = new Map();
    const add = (f, mod, by) => {
      if (!files.has(f.toLowerCase())) files.set(f.toLowerCase(), { mod, by });
      const r = ownerRoot(f).toLowerCase();
      if (r && !roots.has(r)) roots.set(r, { mod, by });
    };
    for (const [k, id] of Object.entries(this.deployer.owners())) if (this.data.mods[id]) add(k, this.data.mods[id].name, 'Cyber Mod Manager');
    for (const m of Object.values(this.data.mods)) for (const f of m.files) { const r = ownerRoot(f).toLowerCase(); if (r && !roots.has(r)) roots.set(r, { mod: m.name, by: 'Cyber Mod Manager' }); }
    try {
      const vx = this.vortex.read();
      const names = new Map((vx.mods || []).map(v => [v.vortexId, v.name]));
      for (const [f, src] of vx.deployedPaths || []) add(f, names.get(src) || src, 'Vortex');
    } catch { /* no Vortex */ }
    return { files, roots };
  }

  // ---------------------------------------------------------------- downloading

  async validateKey() {
    const user = await this.nexus.validate();
    this.log.success(`API key valid: ${user.name}${user.is_premium ? ' (Premium)' : ' (not Premium)'}`);
    this.downloader.freeAccount = !user.is_premium;
    if (!user.is_premium) this.log.info('Free Nexus account: each file is downloaded after one click on "Slow download" on Nexus (the Browse page opens each one).');
    return { name: user.name, isPremium: !!user.is_premium, isSupporter: !!user.is_supporter, avatar: user.profile_url || '' };
  }

  /**
   * Read each mod link and walk its Nexus requirements (and theirs), without downloading anything.
   * Returns a plan the UI shows as a checklist:
   *   mods: the linked mods and the files that will be downloaded
   *   deps: every requirement with its status — missing | downloaded | disabled | installed |
   *         in-game (installed by another tool) | queued | external (not on Nexus)
   */
  async planLinks(text) {
    const urls = String(text).split(/[\s,]+/).filter(Boolean);
    if (!urls.length) throw new Error('Paste at least one Nexus Mods link.');
    const plan = { token: crypto.randomBytes(6).toString('hex'), mods: [], deps: [], errors: [] };
    const wanted = new Set(this.settings.get('categories'));
    const seen = new Set();
    for (const url of urls) {
      const parsed = parseModUrl(url);
      if (!parsed) {
        plan.errors.push(`Not a Nexus mod link: ${url}`);
        this.log.error(`Not a Nexus mod link: ${url}`, 'Expected https://www.nexusmods.com/<game>/mods/<id>');
        continue;
      }
      if (seen.has(parsed.modId)) continue;
      seen.add(parsed.modId);
      try {
        const info = await this.fetchModInfo(parsed.game, parsed.modId);
        const linked = parsed.fileId && info.files.some(f => Number(f.file_id) === parsed.fileId) ? parsed.fileId : 0;
        const files = info.files.filter(f => (linked ? Number(f.file_id) === linked : wanted.has(catOf(f))));
        this.log.info(`${info.name}: ${info.files.length} files, ${files.length} preselected`);
        plan.mods.push({ ...info, files, allFiles: info.files });
      } catch (err) {
        plan.errors.push(err.message);
        this.log.error(`Could not read files for ${url}`, err.message);
      }
    }
    if (this.settings.get('installDependencies')) {
      for (const m of plan.mods) await this.collectRequirements(m, plan, seen);
    }
    this.plans.set(plan.token, plan);
    return {
      token: plan.token,
      errors: plan.errors,
      mods: plan.mods.map(m => {
        const picked = new Set(m.files.map(f => Number(f.file_id)));
        return {
          modId: m.modId, game: m.game, name: m.name, author: m.author, summary: m.summary || '', picture: m.picture,
          files: m.files.map(publicFile),
          // Every file, newest first within its category, for the picker.
          allFiles: [...m.allFiles].sort((a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0)).map(f => ({
            ...publicFile(f), uploaded: f.uploaded_timestamp || 0, description: plainText(f.description).slice(0, 600),
            selected: picked.has(Number(f.file_id)), downloaded: !!this.data.downloads[String(f.file_id)],
          })),
        };
      }),
      deps: plan.deps.map(d => ({ ...d, info: undefined, files: (d.files || []).map(publicFile) })),
    };
  }

  async fetchModInfo(game, modId) {
    const [mod, files] = await Promise.all([this.nexus.getMod(game, modId), this.nexus.getFiles(game, modId)]);
    if (game !== 'cyberpunk2077') this.log.warn(`${mod.name} is a ${game} mod; it will download, but the installer only knows Cyberpunk 2077 layouts.`);
    return { game, modId: Number(modId), name: mod.name || `Mod ${modId}`, author: mod.author || '', picture: mod.picture_url || '', summary: plainText(mod.summary).slice(0, 300), files: files.files || [] };
  }

  /** Breadth-first walk of requirements, recording each one once with its status. */
  async collectRequirements(root, plan, seen) {
    const queue = [{ modId: root.modId, name: root.name, game: root.game }];
    while (queue.length) {
      const cur = queue.shift();
      let info;
      try {
        info = await this.nexus.getRequirements(cur.game, cur.modId);
      } catch (err) {
        this.log.warn(`Could not check what ${cur.name} requires`, err.message);
        continue;
      }
      for (const req of info.requirements) {
        const existing = plan.deps.find(d => (req.external ? d.name === req.modName : d.modId === req.modId));
        if (existing) {
          if (!existing.requiredBy.includes(cur.name)) existing.requiredBy.push(cur.name);
          // Who needs it, by mod id: the requirements dialog draws these as a tree.
          if (!existing.parents.includes(cur.modId)) existing.parents.push(cur.modId);
          continue;
        }
        if (req.external) {
          plan.deps.push({ modId: 0, game: cur.game, name: req.modName, requiredBy: [cur.name], parents: [cur.modId], status: 'external', detail: req.url || 'Not hosted on Nexus', url: req.url });
          continue;
        }
        if (!req.modId || seen.has(req.modId)) continue;
        if (info.gameId && req.gameId && req.gameId !== info.gameId) {
          this.log.warn(`${cur.name} requires ${req.modName} from another game; skipped.`);
          continue;
        }
        seen.add(req.modId);
        const st = this.dependencyStatus(req);
        const dep = { modId: req.modId, game: cur.game, name: req.modName, requiredBy: [cur.name], parents: [cur.modId], status: st.status, detail: st.reason || '', notes: req.notes || '' };
        if (st.status === 'missing') {
          try {
            const mi = await this.fetchModInfo(cur.game, req.modId);
            dep.files = pickMainFiles(mi.files, catOf);
            dep.info = mi;
            dep.author = mi.author;
          } catch (err) {
            dep.status = 'error';
            dep.detail = err.message;
          }
        }
        plan.deps.push(dep);
        // Only requirements we would add can bring in further requirements.
        if (['missing', 'downloaded', 'disabled'].includes(dep.status)) queue.push({ modId: req.modId, name: req.modName, game: cur.game });
      }
    }
  }

  /**
   * Download the planned mods plus the requirements the user ticked (by mod id). Requirements that
   * are downloaded or installed-but-disabled are installed/enabled instead of downloaded again.
   */
  async queuePlan(token, chosenDepIds, chosenFiles = null) {
    const plan = this.plans.get(token);
    if (!plan) throw new Error('That download plan has expired. Paste the links again.');
    this.plans.delete(token);
    const chosen = new Set((chosenDepIds || []).map(Number));
    const summary = { mods: 0, queued: 0, skipped: 0, dependencies: 0, external: plan.deps.filter(d => d.status === 'external').map(d => ({ name: d.name, url: d.url })), errors: [...plan.errors] };
    for (const m of plan.mods) {
      // The picker's choice (mod id → file ids) wins over the preselection.
      const pick = chosenFiles && chosenFiles[m.modId];
      const files = Array.isArray(pick) ? m.allFiles.filter(f => pick.includes(Number(f.file_id))) : m.files;
      this.queueFiles(m, files, '', summary);
      summary.mods++;
    }
    for (const d of plan.deps) {
      if (!chosen.has(d.modId)) continue;
      const by = d.requiredBy[0];
      try {
        const st = this.dependencyStatus(d);
        if (st.status === 'disabled') { await this.setEnabled(st.enable, true); summary.dependencies++; continue; }
        if (st.status === 'downloaded') { await this.install(st.install, { auto: true, forceEnable: true }); summary.dependencies++; continue; }
        if (st.status === 'missing' && d.info) {
          this.log.info(`Requirement ${d.name} (needed by ${d.requiredBy.join(', ')}): queuing ${d.files.map(f => f.file_name).join(', ') || 'nothing — it has no current files'}`);
          this.queueFiles(d.info, d.files, by, summary);
          summary.dependencies++;
        }
      } catch (err) {
        summary.errors.push(err.message);
        this.log.error(`Could not add requirement ${d.name}`, err.message);
      }
    }
    for (const d of plan.deps) if (d.status === 'external') this.log.warn(`${d.requiredBy[0]} requires ${d.name}, which is not on Nexus (${d.url || 'see the mod page'}). Install it yourself.`);
    if (summary.skipped) this.log.info(`${summary.skipped} file(s) were already downloaded and were skipped`);
    this.emit('changed');
    return summary;
  }

  /**
   * A Nexus "Mod Manager Download" link (nxm://…). That one file starts downloading at once and is
   * installed as the settings say, like any other download.
   */
  async handleNxm(url) {
    const link = parseNxm(url);
    if (!link) throw new Error(`Not a Nexus download link: ${url}`);
    // A file this app is already waiting for (a free account's click): it starts now.
    const waiting = this.downloader.provideKey(link.fileId, { key: link.key, expires: link.expires });
    if (waiting) return { name: waiting.modName, file: waiting.name || waiting.fileName, queued: 1, resumed: true };
    const info = await this.fetchModInfo(link.game, link.modId);
    const f = info.files.find(x => Number(x.file_id) === link.fileId);
    if (!f) throw new Error(`${info.name}: that file is no longer on Nexus.`);
    const summary = { mods: 1, queued: 0, skipped: 0, errors: [] };
    this.queueFiles(info, [f], '', summary, { nxm: { key: link.key, expires: link.expires } });
    this.log.info(summary.queued ? `Downloading ${f.name || f.file_name} (${info.name}) from a Nexus link` : `${f.file_name} is already downloaded`);
    this.emit('changed');
    return { name: info.name, file: f.name || f.file_name, queued: summary.queued };
  }

  /** Plan and queue in one go, taking every requirement that is not already covered. */
  async addLinks(text) {
    const plan = await this.planLinks(text);
    return this.queuePlan(plan.token, plan.deps.filter(d => ['missing', 'downloaded', 'disabled'].includes(d.status)).map(d => d.modId));
  }

  /** Queue files of one mod. `dependencyOf` names the mod that needs it ('' for a linked mod). */
  queueFiles(mod, files, dependencyOf, summary, extra = {}) {
    for (const f of files) {
      const key = String(f.file_id);
      const category = catOf(f);
      const known = this.data.downloads[key];
      if (known && fs.existsSync(known.path) && !extra.replaces) {
        summary.skipped++;
        continue;
      }
      const dest = path.join(
        this.settings.downloadsDir, mod.game, `${sanitizeName(mod.name)} (${mod.modId})`,
        CATEGORY_FOLDERS[category] || sanitizeName(category), sanitizeName(f.file_name || `${key}.zip`),
      );
      this.downloader.enqueue({
        key, game: mod.game, modId: mod.modId, modName: mod.name, fileId: f.file_id,
        name: f.name || f.file_name, fileName: f.file_name, version: f.version || f.mod_version || '',
        category, size: (f.size_in_bytes || (f.size_kb || 0) * 1024) || 0, uploaded: f.uploaded_timestamp || 0,
        author: mod.author || '', picture: mod.picture || '', dest, dependencyOf: dependencyOf || '',
        requestedBy: this.data.profiles?.active || '', ...extra,
      });
      summary.queued++;
    }
  }

  /** Is a required mod already taken care of? */
  dependencyStatus(req) {
    const modId = Number(req.modId);
    const mods = Object.values(this.data.mods).filter(m => Number(m.modId) === modId);
    if (mods.some(m => m.enabled)) return { status: 'installed', done: true, reason: 'Installed and enabled' };
    if (mods.length) return { status: 'disabled', enable: mods.map(m => m.id), reason: 'Installed but disabled — will be enabled' };
    if (this.downloader.list().some(j => Number(j.modId) === modId && ['queued', 'downloading'].includes(j.status))) {
      return { status: 'queued', done: true, reason: 'Already downloading' };
    }
    const outside = foundInGame(this.settings.get('gamePath'), { modId, modName: req.modName || req.name });
    if (outside) return { status: 'in-game', done: true, reason: `Already in the game folder (${outside}), installed by another tool` };
    const downloaded = Object.values(this.data.downloads).filter(d => Number(d.modId) === modId && fs.existsSync(d.path));
    if (downloaded.length) return { status: 'downloaded', install: pickMainFiles(downloaded, d => d.category).map(d => d.key), reason: 'Downloaded — will be installed' };
    return { status: 'missing', reason: 'Not installed' };
  }

  onDownloaded(job) {
    this.op(async () => {
      this.data.downloads[job.key] = {
        key: job.key, game: job.game, modId: job.modId, modName: job.modName, fileId: job.fileId,
        name: job.name, fileName: job.fileName, version: job.version, category: job.category,
        size: job.total, uploaded: job.uploaded, author: job.author, picture: job.picture,
        path: job.dest, downloadedAt: Date.now(), dependencyOf: job.dependencyOf || '',
      };
      this.library.save();
    }).then(() => {
      // An update always installs, taking the old version's place.
      if (job.replaces) return this.install([job.key], { auto: true, replaces: job.replaces, forProfiles: job.forProfiles || [] });
      // Part of one or more imported profiles: always install, into each of them.
      if (job.forProfiles?.length) {
        // If it was first queued as a requirement for another profile, that profile gets it too.
        const targets = job.requestedBy && job.dependencyOf ? [...job.forProfiles, job.requestedBy] : job.forProfiles;
        return this.install([job.key], { forProfiles: targets, fomodChoices: job.fomodChoices ? { [job.key]: job.fomodChoices } : null });
      }
      if (job.dependencyOf && this.settings.get('installDependencies')) {
        return this.install([job.key], { auto: true, forceEnable: true });
      }
      const mode = this.settings.get('autoInstall');
      if (mode === 'all' || (mode === 'main' && job.category === 'MAIN')) {
        return this.install([job.key], { auto: true });
      }
      return null;
    }).catch(err => this.log.error(`After-download step failed for ${job.fileName}`, err));
  }

  async importArchives(paths) {
    return this.op(async () => {
      const keys = [];
      for (const p of paths) {
        const hash = crypto.createHash('sha1').update(p).digest('hex').slice(0, 10);
        const key = `local-${hash}`;
        // Another archive with the same name is already there: this one gets its own name, never its place.
        let dest = path.join(this.settings.downloadsDir, 'local', path.basename(p));
        if (path.resolve(p) !== path.resolve(dest) && fs.existsSync(dest)) {
          const ext = path.extname(dest);
          dest = path.join(path.dirname(dest), `${path.basename(dest, ext)}-${hash}${ext}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (path.resolve(p) !== path.resolve(dest)) fs.copyFileSync(p, dest);
        const base = path.basename(p).replace(/\.(zip|7z|rar)$/i, '');
        // A file downloaded by hand from Nexus keeps its name ("ArchiveXL-4198-1-28-6-1730000000"):
        // its Nexus id and version make updates and version grouping work for it too.
        const nx = parseFolderName(base);
        this.data.downloads[key] = {
          key, game: 'cyberpunk2077', modId: nx.modId || 0, modName: nx.name || base, fileId: 0, name: nx.name || base, fileName: path.basename(p),
          version: nx.version || '', category: 'LOCAL', size: fs.statSync(dest).size, uploaded: 0, author: '', picture: '',
          path: dest, downloadedAt: Date.now(),
        };
        keys.push(key);
        this.log.info(`Imported ${path.basename(p)}`);
      }
      this.library.save();
      return keys;
    });
  }

  // ---------------------------------------------------------------- installing

  /** Install downloaded archives. FOMOD archives pause for the wizard (a 'fomod' event). */
  install(keys, { auto = false, forceEnable = false, replaces = '', forProfiles = [], fomodChoices = null } = {}) {
    return this.op(async () => {
      const results = [];
      for (const key of keys) {
        const rec = this.data.downloads[key];
        if (!rec) continue;
        try {
          const choices = fomodChoices && typeof fomodChoices === 'object' && !Array.isArray(fomodChoices) ? (fomodChoices[key] || null) : null;
          results.push(await this.installOne(rec, { auto: auto || forceEnable, forceEnable, replaces, forProfiles, fomodChoices: choices }));
        } catch (err) {
          this.log.error(`Install failed: ${rec.name}`, err);
          results.push({ key, error: err.message });
        }
      }
      this.resolveSoon(); // a file named like a Nexus download: its exact Nexus file
      return results;
    });
  }

  async installOne(rec, opts) {
    if (!fs.existsSync(rec.path)) throw new Error(`Archive is missing: ${rec.path}`);
    this.log.info(`Installing ${rec.name}…`);
    const session = await this.installer.prepare(rec.path);
    if (session.fomod) {
      const states = this.installer.fileStates(session, this.settings.get('gamePath'));
      const imageBase = pathToFileURL(path.join(session.extractDir, session.fomod.basePath || '.') + path.sep).href;
      this.pendingFomod.set(session.token, { session, rec, opts, states });
      this.log.info(`${rec.name} has a FOMOD installer; choose its options in the wizard.`);
      // A shared profile carries the sender's choices: the wizard opens with them filled in.
      this.emit('fomod', { token: session.token, name: rec.name, modName: rec.modName, config: session.fomod.config, fileStates: states, imageBase, preset: opts.fomodChoices || null });
      return { key: rec.key, fomod: session.token };
    }
    try {
      return this.finishInstall(rec, session, null, null, opts);
    } finally {
      this.installer.release(session.token);
    }
  }

  fomodSubmit(token, selections) {
    return this.op(async () => {
      const pending = this.pendingFomod.get(token);
      if (!pending) throw new Error('That installer session has expired.');
      this.pendingFomod.delete(token);
      try {
        return this.finishInstall(pending.rec, pending.session, selections, pending.states, pending.opts);
      } catch (err) {
        this.log.error(`Install failed: ${pending.rec.name}`, err);
        throw err;
      } finally {
        this.installer.release(token);
      }
    });
  }

  fomodCancel(token) {
    const pending = this.pendingFomod.get(token);
    if (!pending) return;
    this.pendingFomod.delete(token);
    this.installer.release(token);
    this.log.warn(`Install of ${pending.rec.name} cancelled`);
    this.emit('changed');
  }

  finishInstall(rec, session, selections, states, { auto = false, forceEnable = false, replaces = '', forProfiles = [] } = {}) {
    const plan = this.installer.plan(session, rec.modName, selections, states);
    if (!plan.mappings.length) {
      throw new Error(`Nothing in ${rec.fileName} looks like a Cyberpunk 2077 mod (${session.files.length} files, none in a known place).`);
    }
    const id = rec.key;
    // An update takes over the previous version's place: its priority, on/off state and profiles.
    const prev = replaces && replaces !== id ? this.data.mods[replaces] : null;
    const old = this.data.mods[id] || (prev ? { priority: prev.priority, enabled: false, dependencyOf: prev.dependencyOf } : null);
    const stagingDir = path.join(this.settings.stagingDir, id);
    if (old?.enabled) {
      old.enabled = false;
      this.deploy();
    }
    const files = this.installer.stage(session, plan, stagingDir);
    for (const w of plan.warnings) this.log.warn(`${rec.name}: ${w}`);
    const mod = {
      id, key: rec.key, name: rec.name, modName: rec.modName, modId: rec.modId, fileId: rec.fileId,
      game: rec.game, version: rec.version, category: rec.category, author: rec.author,
      type: plan.type, files, skipped: plan.skipped.length, warnings: plan.warnings,
      enabled: false, priority: old?.priority ?? this.data.nextPriority++, installedAt: Date.now(), enabledAt: Date.now(),
      fomod: !!selections, fomodChoices: selections || undefined, dependencyOf: rec.dependencyOf || old?.dependencyOf || '',
    };
    this.data.mods[id] = mod;
    this.library.save();
    if (prev) {
      // Swap old for new in one deployment, so the game never sees both or neither.
      mod.enabled = prev.enabled;
      delete this.data.mods[prev.id];
      for (const [vid, own] of Object.entries(this.data.vortexAdopted || {})) if (own === prev.id) this.data.vortexAdopted[vid] = id;
      // Its picks in the conflict window carry over to the new version (for the files it still has).
      const has = new Set(files.map(f => f.toLowerCase()));
      for (const [file, pick] of Object.entries(this.data.fileChoices || {})) {
        if (pick.among?.includes(prev.id)) pick.among = pick.among.map(x => (x === prev.id ? id : x));
        if (pick.id === prev.id) { if (has.has(file)) pick.id = id; else delete this.data.fileChoices[file]; }
      }
      delete this.data.updates?.[prev.id];
      for (const p of Object.values(this.data.profiles?.list || {})) {
        p.enabled = p.enabled.map(x => (x === prev.id ? id : x));
        if (p.priorities && prev.id in p.priorities) { p.priorities[id] = p.priorities[prev.id]; delete p.priorities[prev.id]; }
      }
      // An update an import was also waiting for joins that import's profiles too.
      const act = this.joinProfiles(mod, forProfiles);
      if (act) { mod.enabled = true; this.applyProfilePriorities(act); }
      this.deploy();
      fs.rmSync(path.join(this.settings.stagingDir, prev.id), { recursive: true, force: true });
      this.log.success(`Updated ${rec.modName}: ${prev.version || prev.name} → ${rec.version || rec.name}`);
      return { key: rec.key, id, type: plan.type, updated: prev.id };
    }
    this.log.success(`Installed ${rec.name} as ${plan.type} (${files.length} files${plan.skipped.length ? `, ${plan.skipped.length} skipped` : ''})`);
    if (forProfiles.length) {
      // An imported profile's mod: it belongs to each profile waiting for it, in that sender's order.
      const act = this.joinProfiles(mod, forProfiles);
      if (act) {
        mod.enabled = true;
        this.applyProfilePriorities(act);
        this.deploy();
      } else if (old?.enabled) {
        // Reinstalled while the active profile uses it: keep it on there.
        mod.enabled = true;
        this.deploy();
      } else {
        // None of them is active: only their own remembered order changes; the game folder is untouched.
        this.library.save();
      }
      return { key: rec.key, id, type: plan.type };
    }
    if (forceEnable || (auto && this.settings.get('autoEnable')) || old?.enabled) {
      mod.enabled = true;
      this.deploy();
    }
    return { key: rec.key, id, type: plan.type };
  }

  // ---------------------------------------------------------------- health: mods changed outside the app

  /**
   * Check every enabled mod's files in the game folder. A mod whose files were all deleted by hand
   * is marked disabled (its originals restored, if we had backed any up); a mod with some files
   * missing or replaced gets a `health` note so the UI can offer a repair.
   * Returns the names of mods that were switched off.
   */
  verifyDeployment() {
    const game = this.gameDir();
    if (!isGameDir(game)) return [];
    const removed = [];
    let changed = false;
    for (const m of Object.values(this.data.mods)) {
      if (!m.enabled) { if (m.health) { delete m.health; changed = true; } continue; }
      let owned = 0;
      let missing = 0;
      let replaced = 0;
      const gone = [];
      for (const f of m.files) {
        const key = f.toLowerCase();
        const entry = this.deployer.deployed[key];
        if (!entry || entry.owner !== m.id) continue;
        owned++;
        const st = this.deployer.fileState(game, entry);
        if (st === 'missing') { missing++; gone.push(key); } else if (st === 'changed') replaced++;
      }
      if (owned && missing === owned) {
        this.deployer.forget(game, gone);
        m.enabled = false;
        delete m.health;
        removed.push(m.name);
        changed = true;
        this.log.warn(`${m.name} was removed from the game folder outside this app; it is now shown as disabled. Enable it to put it back.`);
        continue;
      }
      const health = missing || replaced ? { missing, replaced } : null;
      if (JSON.stringify(health) !== JSON.stringify(m.health || null)) {
        if (health) m.health = health; else delete m.health;
        changed = true;
        if (health) this.log.warn(`${m.name}: ${missing ? `${plural(missing, 'file')} missing` : ''}${missing && replaced ? ', ' : ''}${replaced ? `${plural(replaced, 'file')} replaced by another tool` : ''}. Use Repair to put them back.`);
      }
    }
    if (changed) {
      this.syncActiveProfile();
      this.library.save();
      this.emit('changed');
    }
    return removed;
  }

  /** Check now, and then every 15 seconds. */
  startHealthChecks() {
    const tick = () => this.op(async () => this.verifyDeployment(), { quiet: true }).catch(err => this.log.error('Checking the game folder failed', err));
    tick();
    this.healthTimer = setInterval(tick, 15000);
  }

  /** Put back missing or replaced files of the given mods. */
  repair(ids) {
    return this.op(async () => {
      const game = this.gameDir();
      for (const id of ids) {
        const m = this.data.mods[id];
        if (!m) continue;
        // The deploy below puts back every missing or replaced file of an enabled mod (keeping the
        // backup of the original it replaced), so nothing is forgotten here.
        delete m.health;
      }
      this.deploy();
      this.log.success(`Repaired ${plural(ids.length, 'mod')}`);
    });
  }

  // ---------------------------------------------------------------- updates

  /**
   * Ask Nexus for each installed mod's file list and find newer versions of the installed files.
   * Results are kept in `updates` (mod id → newer file) until the mod is updated.
   */
  async checkUpdates() {
    await this.resolveNexusFiles(Object.values(this.data.mods)).catch(() => 0); // mods that lack their exact file
    const vortexMods = (this.vortex.read().mods || []).filter(v => !this.data.vortexAdopted?.[v.vortexId]);
    const mods = [...Object.values(this.data.mods), ...vortexMods].filter(m => Number(m.modId) > 0 && Number(m.fileId) > 0);
    const groups = new Map();
    for (const m of mods) {
      const k = `${m.game}/${m.modId}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const found = {};
    const errors = [];
    const work = [...groups.values()];
    // A few requests at a time, to stay friendly with the API rate limit.
    const worker = async () => {
      while (work.length) {
        const list = work.shift();
        const { game, modId, modName } = list[0];
        try {
          const res = await this.nexus.getFiles(game, modId);
          for (const m of list) {
            const f = findUpdate(res.files || [], res.file_updates || [], m.fileId);
            const haveIt = this.data.mods[String(f?.file_id)] || vortexMods.some(v => v.fileId === Number(f?.file_id));
            if (f && !haveIt) {
              found[m.id] = {
                fileId: Number(f.file_id), name: f.name || f.file_name, fileName: f.file_name, category: catOf(f),
                version: f.version || f.mod_version || '', size: (f.size_in_bytes || (f.size_kb || 0) * 1024) || 0,
                uploaded: f.uploaded_timestamp || 0, from: m.version,
              };
            }
          }
        } catch (err) {
          errors.push(`${modName}: ${err.message}`);
          this.log.warn(`Could not check ${modName} for updates`, err.message);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    // Only mods still here: one updated, removed or moved from Vortex during the check is not listed.
    const vxNow = (this.vortex.read().mods || []).map(v => v.id);
    this.data.updates = Object.fromEntries(Object.entries(found).filter(([id]) => this.data.mods[id] || vxNow.includes(id)));
    this.data.lastUpdateCheck = Date.now();
    this.library.save();
    const n = Object.keys(found).length;
    this.log[n ? 'success' : 'info'](n ? `${plural(n, 'update')} available` : `All ${plural(mods.length, 'mod')} are up to date`);
    this.emit('changed');
    return { checked: groups.size, available: n, errors };
  }

  /** Download the newer files; each one replaces its old version once it is installed. */
  async updateMods(ids) {
    const summary = { mods: 0, queued: 0, skipped: 0, errors: [] };
    for (const id of ids) {
      const u = this.data.updates?.[id];
      let ownId = id;
      if (id.startsWith('vx:') && u) {
        try {
          const r = await this.adoptFromVortex([id]);
          ownId = r.adopted[0]?.id;
          if (!ownId) continue;
          this.log.info(`${this.data.mods[ownId]?.name || id} now updates here (taken over from Vortex)`);
        } catch (err) {
          summary.errors.push(err.message);
          this.log.error('Could not take that mod over from Vortex to update it', err.message);
          continue;
        }
      }
      const m = this.data.mods[ownId];
      const upd = this.data.updates?.[ownId] || u;
      if (!m || !upd) continue;
      const file = { file_id: upd.fileId, name: upd.name, file_name: upd.fileName, category_name: upd.category, version: upd.version, size_in_bytes: upd.size, uploaded_timestamp: upd.uploaded };
      this.queueFiles({ game: m.game, modId: m.modId, name: m.modName, author: m.author }, [file], m.dependencyOf || '', summary, { replaces: m.id });
      summary.mods++;
    }
    this.log.info(`Updating ${plural(summary.mods, 'mod')}`);
    this.emit('changed');
    return summary;
  }

  // ---------------------------------------------------------------- Vortex, side by side

  // ---------------------------------------------------------------- taking mods over from Vortex

  /**
   * What taking these Vortex mods over would do (Settings shows it before anything changes).
   * ids: 'vx:…' mod ids, or 'all'.
   */
  vortexAdoptPreview(ids = 'all') {
    const data = this.vortex.read();
    const adopted = this.data.vortexAdopted || {};
    const mods = (data.mods || []).filter(m => !adopted[m.vortexId] && (ids === 'all' || ids.includes(m.id)));
    const own = new Set(Object.values(this.data.mods).map(m => String(m.fileId)).filter(x => x !== '0'));
    return {
      mods: mods.length,
      enabled: mods.filter(m => m.enabled).length,
      files: mods.reduce((n, m) => n + m.fileCount, 0),
      already: mods.filter(m => m.fileId && own.has(String(m.fileId))).length,
      vortexRunning: !!this.vortexRunning,
    };
  }

  /**
   * Take Vortex mods over: this app manages them from now on, as if installed here.
   *   - Their files are hardlinked from Vortex's staging folder into this app's (no copying, no
   *     extra space), and their archives into this app's downloads when Vortex still has them.
   *   - Each keeps its name, version, Nexus ids and on/off state. Mods that won a file in Vortex
   *     get the higher priority here, so the game ends up with the same files.
   *   - Vortex switches them off (it keeps them, disabled; nothing is deleted there) and this
   *     app places their files. Vortex is not opened for this (if it is open, it closes for a
   *     moment, as for any change to its mods).
   * Taken-over mods are no longer listed as Vortex mods. Returns { adopted: [{ vortexId, id }] }.
   */
  async adoptFromVortex(ids = 'all') {
    const data = this.vortex.read();
    if (!data.installed) throw new Error('Vortex is not installed.');
    const game = this.gameDir();
    if (!isGameDir(game)) throw new Error('Set the Cyberpunk 2077 folder in Settings first.');
    this.data.vortexAdopted ||= {};
    const adopted = this.data.vortexAdopted;
    let mods = (data.mods || []).filter(m => !adopted[m.vortexId] && (ids === 'all' || ids.includes(m.id)));
    if (!mods.length) return { adopted: [] };
    const manifestFile = this.vortex.deploymentFile();
    let manifest = { files: [] };
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* nothing deployed */ }
    const vxStaging = manifest.stagingPath || path.join(this.vortex.root, 'cyberpunk2077', 'mods');
    const vxDownloads = path.join(this.vortex.root, 'downloads', 'cyberpunk2077');

    // 1. Vortex lets go of them: its record says disabled, its files leave the game folder.
    const live = mods.filter(m => m.enabled);
    if (live.length) await this.vortex.apply(live.map(m => ({ vortexId: m.vortexId, enabled: false })));

    return this.op(async () => {
      // Another move (a double click, the automatic one) may have taken some of them meanwhile.
      mods = mods.filter(m => !adopted[m.vortexId]);
      if (!mods.length) return { adopted: [] };
      // 2. Their order: a mod that won a shared file in Vortex goes above the ones it beat.
      const wins = new Map(mods.map(m => [m.vortexId, 0]));
      const shippers = new Map();
      for (const m of mods) for (const f of m.deployedFiles || []) {
        const k = f.toLowerCase();
        shippers.set(k, (shippers.get(k) || 0) + 1);
      }
      for (const f of manifest.files || []) {
        if (wins.has(f.source) && (shippers.get(f.relPath.replace(/\\/g, '/').toLowerCase()) || 0) > 1) wins.set(f.source, wins.get(f.source) + 1);
      }
      const ordered = [...mods].sort((a, b) => wins.get(a.vortexId) - wins.get(b.vortexId));

      const out = [];
      const failed = [];
      for (const v of ordered) {
        try {
        // A file this app already has installed: point at it instead of adding a second copy.
        const same = v.fileId && Object.values(this.data.mods).find(m => Number(m.fileId) === v.fileId);
        if (same) {
          adopted[v.vortexId] = same.id;
          if (v.enabled) same.enabled = true;
          out.push({ vortexId: v.vortexId, id: same.id });
          continue;
        }
        const id = v.fileId && !this.data.mods[String(v.fileId)] ? String(v.fileId)
          : `vortex-${crypto.createHash('sha1').update(v.vortexId).digest('hex').slice(0, 10)}`;
        const src = path.join(vxStaging, v.vortexId);
        const dest = path.join(this.settings.stagingDir, id);
        fs.rmSync(dest, { recursive: true, force: true });
        if (!fs.existsSync(src)) throw new Error(`its files are not in Vortex's staging folder (${src})`);
        // What Vortex deployed, exactly; for a disabled mod, its whole staging folder.
        const rels = (v.deployedFiles?.length ? v.deployedFiles : listFiles(src).map(p => p.replace(/\\/g, '/'))).filter(isSafeRel);
        for (const rel of rels) {
          const from = path.join(src, rel);
          const to = path.join(dest, rel);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
        }
        // The archive too, so Reinstall works here.
        let rec = null;
        const archive = v.archiveName ? path.join(vxDownloads, v.archiveName) : '';
        if (archive && fs.existsSync(archive)) {
          const dl = path.join(this.settings.downloadsDir, 'vortex', v.archiveName);
          fs.mkdirSync(path.dirname(dl), { recursive: true });
          if (!fs.existsSync(dl)) { try { fs.linkSync(archive, dl); } catch { fs.copyFileSync(archive, dl); } }
          rec = {
            key: id, game: 'cyberpunk2077', modId: v.modId, modName: v.modName, fileId: v.fileId, name: v.name, fileName: v.archiveName,
            version: v.version, category: 'MAIN', size: fs.statSync(dl).size, uploaded: 0, author: v.author, picture: '', path: dl, downloadedAt: Date.now(),
          };
          this.data.downloads[id] = rec;
        }
        this.data.mods[id] = {
          id, key: id, name: v.name, modName: v.modName, modId: v.modId, fileId: v.fileId,
          game: 'cyberpunk2077', version: v.version, category: 'MAIN', author: v.author,
          type: v.type, files: rels, skipped: 0, warnings: [],
          enabled: !!v.enabled, priority: this.data.nextPriority++, installedAt: v.installedAt || Date.now(),
          fomod: false, dependencyOf: '', fromVortex: v.vortexId,
        };
        // Its Vortex update, if one was found, now belongs to this mod.
        if (this.data.updates?.[v.id]) { this.data.updates[id] = this.data.updates[v.id]; delete this.data.updates[v.id]; }
        adopted[v.vortexId] = id;
        out.push({ vortexId: v.vortexId, id });
        } catch (err) {
          failed.push(v);
          this.log.error(`Could not move ${v.name} from Vortex`, err.message);
        }
      }
      this.adoptFailed = failed;
      this.library.save();
      // 3. This app places their files (the enabled ones) where Vortex's were.
      this.deploy();
      this.log.success(`Took over ${plural(out.length, 'mod')} from Vortex (${out.filter(o => this.data.mods[o.id]?.enabled).length} enabled). Vortex keeps them, switched off.`);
      this.emit('changed');
      this.resolveSoon(); // their Nexus files, now (Vortex kept only the mod)
      return { adopted: out };
    }).then(async r => {
      const back = (this.adoptFailed || []).filter(v => v.enabled);
      this.adoptFailed = [];
      if (back.length) {
        await this.vortex.apply(back.map(v => ({ vortexId: v.vortexId, enabled: true }))).catch(err => this.log.warn('Could not switch them back on in Vortex', err.message));
        this.log.warn(`${plural(back.length, 'mod')} stayed in Vortex (switched back on there): ${nameList(back)}`);
      }
      return r;
    });
  }


  /**
   * Mods installed in both apps: Vortex mods that are the same Nexus file as one of this app's
   * (or the same mod and file name). vortexId → this app's mod id.
   */
  vortexTwins(data = this.vortex.read()) {
    const adopted = this.data.vortexAdopted || {};
    const own = Object.values(this.data.mods);
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const out = {};
    for (const v of data.mods || []) {
      if (adopted[v.vortexId]) continue;
      const twin = own.find(m => (v.fileId && Number(m.fileId) === v.fileId)) ||
        own.find(m => v.modId && Number(m.modId) === v.modId && norm(m.name) === norm(v.name));
      if (twin) out[v.vortexId] = twin.id;
    }
    return out;
  }

  /**
   * A mod enabled here and also in Vortex would be placed twice: Vortex's copy is switched off
   * (without opening Vortex). ids: only these mods of ours (all when omitted). If Vortex is open
   * and closing it is not allowed (a background check), nothing changes and the count is returned.
   */
  async switchOffVortexTwins(ids = null, { allowClose = true } = {}) {
    if (!this.vortex.installed || this.vortex.busy) return { switched: 0 };
    const data = this.vortex.read();
    const twins = this.vortexTwins(data);
    const clash = (data.mods || []).filter(v => v.enabled && twins[v.vortexId] && this.data.mods[twins[v.vortexId]]?.enabled && (!ids || ids.includes(twins[v.vortexId])));
    if (!clash.length) return { switched: 0 };
    if (!allowClose && await this.vortex.isRunning()) return { switched: 0, waiting: clash.length };
    const changes = clash.map(v => ({ vortexId: v.vortexId, enabled: false }));
    await this.vortex.apply(changes);
    this.noteVortexToggles(changes);
    this.log.info(`Switched off Vortex's copy of ${nameList(clash)}: ${clash.length === 1 ? 'it is' : 'they are'} enabled in this app`);
    this.emit('changed');
    return { switched: clash.length };
  }

  /** The Vortex mod whose staged file for this game path is this very file (a hardlink of it), or null. */
  vortexStagedOwner(file, rel, vx = this.vortex.read()) {
    let st;
    try { st = fs.statSync(file, { bigint: true }); } catch { return null; }
    if (st.nlink < 2n || st.ino === 0n) return null;
    const staging = this.vortex.stagingDir();
    return (vx.mods || []).find(m => {
      try {
        const s = fs.statSync(path.join(staging, m.vortexId, rel), { bigint: true });
        return s.ino === st.ino && s.dev === st.dev;
      } catch { return false; }
    }) || null;
  }

  /**
   * Off in Vortex's active profile: taken over by this app (Vortex keeps those off), else what this
   * app last switched (when newer than Vortex's snapshot, which is only written while Vortex runs),
   * else the snapshot. Not knowing counts as on.
   */
  vortexModOff(vx, vortexId) {
    if (this.data.vortexAdopted?.[vortexId]) return true;
    const t = this.data.vortexToggled?.[vortexId];
    const at = Math.max(t?.enabledAt || 0, t?.disabledAt || 0);
    if (at && at > (vx.snapshotTime || 0)) return (t.disabledAt || 0) > (t.enabledAt || 0);
    // The snapshot only for a mod it knows, and only when no deployment came after it (Vortex may
    // have switched the mod on since).
    if (!(vx.mods || []).find(m => m.vortexId === vortexId)?.known) return false;
    if (vx.deployedAt && (vx.snapshotTime || 0) < vx.deployedAt) return false;
    const active = (vx.profiles || []).find(p => p.active);
    return !!active && !active.enabledIds.includes(vortexId);
  }

  /**
   * A file the deployer set aside is Vortex's own copy of a path Vortex no longer places (its mod was
   * switched off meanwhile, as a twin of ours): put back, no record would list it and nothing would
   * ever remove it (a mod off in both places, still loaded by the game). Vortex keeps it in staging.
   */
  // (Told by the file's identity: a backup folder on another drive holds a copy, and that is put back.)
  vortexStaleCopy(dest, file) {
    try {
      if (!this.vortex.installed) return false;
      const vx = this.vortex.read();
      const recorded = this.vortexRecordedPaths();
      if (!recorded || recorded.has(String(dest).replace(/\\/g, '/').toLowerCase())) return false;
      const owner = this.vortexStagedOwner(file, dest, vx);
      return !!owner && this.vortexModOff(vx, owner.vortexId);
    } catch {
      return false;
    }
  }

  /**
   * Every path a Vortex deployment record in the game folder lists (lower case, '/'): its main one
   * and any per mod type. null when one cannot be read (then nothing of Vortex's is touched).
   */
  vortexRecordedPaths() {
    const out = new Set();
    let names;
    try { names = fs.readdirSync(this.gameDir()).filter(n => /^vortex\.deployment(\.[^.]+)?\.json$/i.test(n)); } catch { return null; }
    for (const n of names) {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(this.gameDir(), n), 'utf8')); } catch { return null; }
      for (const f of rec?.files || []) out.add(String(f.relPath).replace(/\\/g, '/').toLowerCase());
    }
    return out;
  }

  /**
   * Files of Vortex mods that are in the game folder although Vortex has the mod off and no record
   * lists them (hardlinks into its staging folder): what older versions of this app put back after a
   * twin was switched off in Vortex. They are removed, with the folders Vortex made for them once
   * empty; Vortex keeps every one in its staging folder. Not while Vortex runs or is being changed
   * (it writes its record after the files), never a path a mod enabled here ships, and nothing at
   * all when a record is unreadable or this app's own record does not fit the game folder.
   */
  clearVortexLeftovers() {
    return this.op(() => this.clearVortexLeftoversNow());
  }

  async clearVortexLeftoversNow() {
    if (!this.vortex.installed || this.vortex.busy) return { removed: 0 };
    const game = this.gameDir();
    if (!isGameDir(game) || await this.vortex.isRunning()) return { removed: 0 };
    const vx = this.vortex.read();
    const recorded = this.vortexRecordedPaths();
    if (!recorded) return { removed: 0 };
    // This app's record must be the game folder's, and whole: it is what keeps our own files safe.
    const ours = this.deployer.store.data;
    const enabled = Object.values(this.data.mods).filter(m => m.enabled);
    if (ours.gameDir && path.resolve(ours.gameDir).toLowerCase() !== path.resolve(game).toLowerCase()) return { removed: 0 };
    if (!Object.keys(ours.deployed).length && enabled.some(m => m.files?.length)) return { removed: 0 };
    const shipped = new Set(enabled.flatMap(m => (m.files || []).map(f => f.replace(/\\/g, '/').toLowerCase())));
    const staging = this.vortex.stagingDir();
    const removed = [];
    const dirs = [];
    for (const m of vx.mods || []) {
      // Vortex places this mod, or may have it on: its own files.
      if (m.deployedFiles?.length || !this.vortexModOff(vx, m.vortexId)) continue;
      const root = path.join(staging, m.vortexId);
      for (const rel of listFiles(root)) {
        const key = rel.replace(/\\/g, '/').toLowerCase();
        if (ours.deployed[key] || shipped.has(key) || recorded.has(key)) continue;
        const full = path.join(game, rel);
        try {
          const a = fs.lstatSync(full, { bigint: true });
          const b = fs.statSync(path.join(root, rel), { bigint: true });
          // The very same file as Vortex's staged one (a hardlink: two names, a real file id).
          if (!a.isFile() || !b.isFile() || a.nlink < 2n || a.ino === 0n || a.ino !== b.ino || a.dev !== b.dev) continue;
          fs.rmSync(full, { force: true });
          removed.push({ rel, mod: m.name });
          dirs.push(path.dirname(rel));
        } catch { /* not there, or in use: left */ }
      }
    }
    if (!removed.length) return { removed: 0 };
    removeEmptyDirs(game, dirs);
    const mods = [...new Set(removed.map(r => r.mod))];
    this.log.warn(`Removed ${plural(removed.length, 'file')} of ${nameList(mods.map(name => ({ name })))} from the game folder: Vortex has ${mods.length === 1 ? 'that mod' : 'those mods'} off and no longer places them, but they had been left behind (Vortex still has them in its own folder)`);
    this.emit('changed');
    return { removed: removed.length, mods };
  }

  // ---------------------------------------------------------------- archive load order

  /** Which mod each archive in archive/pc/mod belongs to: this app's, Vortex's, or neither. */
  archiveOwners() {
    const owners = new Map();
    for (const m of Object.values(this.data.mods)) {
      if (!m.enabled) continue;
      for (const f of m.files) {
        const mt = f.match(/^archive\/pc\/mod\/([^/]+\.archive)$/i);
        if (mt) owners.set(mt[1].toLowerCase(), { mod: m.name, modId: Number(m.modId) || 0, source: 'app' });
      }
    }
    try {
      const vx = this.vortex.read();
      for (const [file, src] of vx.deployedPaths || []) {
        const mt = file.match(/^archive\/pc\/mod\/([^/]+\.archive)$/i);
        if (!mt || owners.has(mt[1].toLowerCase())) continue;
        const v = (vx.mods || []).find(x => x.vortexId === src);
        owners.set(mt[1].toLowerCase(), { mod: v?.name || src, modId: v?.modId || 0, source: 'vortex' });
      }
    } catch { /* no Vortex */ }
    return owners;
  }

  /** The archives in the order the game loads them, each with its mod. */
  loadOrderView() {
    const game = this.gameDir();
    if (!isGameDir(game)) return { custom: false, archives: [], needs: {} };
    const { custom, order } = loadOrder.currentOrder(game);
    const owners = this.archiveOwners();
    return {
      custom,
      archives: order.map(name => ({ name, ...(owners.get(name.toLowerCase()) || { mod: '', modId: 0, source: 'other' }) })),
      // What each mod needs, from the last auto-sort (shown next to the archives).
      needs: this.data.loadOrderNeeds || {},
    };
  }

  /** Save an order (from dragging): modlist.txt names every archive, in this order. */
  saveLoadOrder(order) {
    const game = this.gameDir();
    if (!isGameDir(game)) throw new Error('Set the Cyberpunk 2077 folder in Settings first.');
    this.data.loadOrder = loadOrder.keepAbsent(this.data.loadOrder || [], loadOrder.writeOrder(game, Array.isArray(order) ? order.map(String) : []));
    this.library.save();
    this.log.info(`Saved the archive load order (${this.data.loadOrder.length} archives)`);
    return this.loadOrderView();
  }

  /**
   * Auto-sort: every mod that needs another goes above it (so it wins what it changes), the rest
   * keeps its place. Requirements come from Nexus. Returns the view and how many archives moved.
   */
  async autoSortLoadOrder() {
    const game = this.gameDir();
    if (!isGameDir(game)) throw new Error('Set the Cyberpunk 2077 folder in Settings first.');
    const { order } = loadOrder.currentOrder(game);
    const owners = this.archiveOwners();
    const ownerOf = new Map(order.map(n => [n, owners.get(n.toLowerCase())?.modId || 0]).filter(([, id]) => id));
    const needs = await this.nexus.getRequirementsMany('cyberpunk2077', [...new Set(ownerOf.values())]);
    const sorted = loadOrder.autoSort(order, ownerOf, needs);
    const moved = sorted.filter((n, i) => order[i] !== n).length;
    // Remembered for the page: "needs …" next to each mod that has requirements here.
    const names = new Map([...owners.values()].map(o => [o.modId, o.mod]));
    this.data.loadOrderNeeds = {};
    for (const [id, reqs] of needs) {
      const here = reqs.filter(r => names.has(r)).map(r => names.get(r));
      if (here.length) this.data.loadOrderNeeds[id] = here;
    }
    this.data.loadOrder = loadOrder.keepAbsent(this.data.loadOrder || [], loadOrder.writeOrder(game, sorted));
    this.library.save();
    this.log.success(`Auto-sorted the archive load order: ${moved ? `${plural(moved, 'archive')} moved` : 'it was already in order'}`);
    return { ...this.loadOrderView(), moved };
  }

  /** Back to the game's own order (alphabetical by file name). */
  resetLoadOrder() {
    const game = this.gameDir();
    if (isGameDir(game)) loadOrder.resetOrder(game);
    delete this.data.loadOrder;
    this.library.save();
    this.log.info('Archive load order reset to the game\'s default (alphabetical)');
    return this.loadOrderView();
  }

  /** Vortex's mods for the UI, plus every place where our enabled files and Vortex's files meet. */
  vortexView() {
    let data;
    try { data = this.vortex.read(); } catch (err) { return { installed: true, error: err.message, mods: [] }; }
    if (!data.installed) return { installed: false, mods: [] };
    const adopted = this.data.vortexAdopted || {};
    // A mod in both apps shows once: as this app's, marked as also being in Vortex.
    const twins = this.vortexTwins(data);
    const vxMods = data.mods.filter(m => !adopted[m.vortexId] && !twins[m.vortexId]);
    const twinOf = {};
    for (const [vid, id] of Object.entries(twins)) twinOf[id] = { name: data.mods.find(v => v.vortexId === vid)?.name || vid, enabled: !!data.mods.find(v => v.vortexId === vid)?.enabled };
    const overlaps = {};
    for (const m of Object.values(this.data.mods)) {
      if (!m.enabled) continue;
      const hit = new Set();
      for (const f of m.files) { const src = data.deployedPaths.get(f.toLowerCase()); if (src && !adopted[src] && twins[src] !== m.id) hit.add(`vx:${src}`); }
      if (hit.size) overlaps[m.id] = [...hit];
    }
    return {
      installed: true,
      running: this.vortexRunning,
      pending: this.vortexPending(data).length,
      busy: this.vortex.busy,
      activeProfileName: data.activeProfileName,
      snapshotTime: data.snapshotTime,
      deployedAt: data.deployedAt,
      profiles: data.profiles.map(p => ({ id: p.id, name: p.name, active: p.active, count: p.enabledIds.length })),
      mods: vxMods.map(({ deployedFiles, ...m }) => ({ ...m, ...(this.data.vortexToggled?.[m.vortexId] || {}) })),
      adopted: Object.keys(adopted).length,
      twins: twinOf,
      overlaps,
    };
  }

  /** Watch Vortex: its files change when it installs, deploys or switches profiles. */
  startVortexWatch() {
    if (!this.vortex.installed) return;
    let sig = '';
    const tick = async () => {
      this.vortexRunning = await this.vortex.isRunning();
      const d = this.vortex.read();
      const now = `${this.vortexRunning}|${d.snapshotTime}|${d.deployedAt}|${d.mods.length}`;
      if (now !== sig) {
        sig = now;
        this.emit('changed');
        if (!this.vortexRunning) await this.switchOffVortexTwins(null, { allowClose: false }).catch(err => this.log.warn("Could not switch off Vortex's copy of a mod enabled here", err.message));
      }
      if (!this.vortexRunning) await this.autoMoveVortex(d).catch(err => this.log.warn('Could not move the Vortex mods into this app', err.message));
    };
    tick();
    this.vortexTimer = setInterval(() => tick().catch(() => {}), 5000);
  }

  /** Vortex mods this app has not taken over yet. */
  vortexPending(d = this.vortex.read()) {
    const adopted = this.data.vortexAdopted || {};
    return (d.mods || []).filter(m => !adopted[m.vortexId]);
  }

  /**
   * With "Vortex mods: move them here automatically", every Vortex mod becomes this app's (so
   * profiles and share codes cover it): Vortex switches it off and keeps it, its files are
   * linked from disk. Only while Vortex is closed, so it is never closed for this.
   */
  async autoMoveVortex(d) {
    if (this.settings.get('vortexAutoMove') !== 'on' || this.autoMoving || this.vortexRunning || this.busy) return;
    const pending = this.vortexPending(d);
    if (!pending.length) return;
    this.autoMoving = true;
    try {
      this.log.info(`Moving ${plural(pending.length, 'Vortex mod')} into this app (Vortex keeps them, switched off)…`);
      await this.adoptFromVortex(pending.map(m => m.id));
    } finally {
      this.autoMoving = false;
    }
  }

  // ---------------------------------------------------------------- profiles

  /** Profiles are named sets of enabled mods. The active one follows every enable/disable. */
  ensureProfiles() {
    if (this.data.profiles?.list && Object.keys(this.data.profiles.list).length) return;
    const id = 'default';
    this.data.profiles = {
      active: id,
      list: { [id]: { id, name: 'Default', enabled: Object.values(this.data.mods).filter(m => m.enabled).map(m => m.id), created: Date.now() } },
    };
    this.library.save();
  }

  /** The active profile follows the live state: which mods are on, and their priority order. */
  syncActiveProfile() {
    const p = this.data.profiles?.list?.[this.data.profiles.active];
    if (!p) return;
    p.enabled = Object.values(this.data.mods).filter(m => m.enabled).map(m => m.id);
    p.priorities = Object.fromEntries(Object.values(this.data.mods).map(m => [m.id, m.priority]));
  }

  /** Make a profile's remembered priority order live (before deploying it). */
  applyProfilePriorities(p) {
    for (const m of Object.values(this.data.mods)) {
      const want = p.priorities?.[m.id];
      if (Number.isFinite(want)) m.priority = want;
    }
  }

  profilesView() {
    const { active, list } = this.data.profiles;
    return {
      active,
      list: Object.values(list).sort((a, b) => a.created - b.created).map(p => {
        let tag = '';
        try { tag = profileCode.fingerprint(profileCode.encode(this.exportProfile(p.id))); } catch { /* none */ }
        const mods = p.enabled.filter(id => this.data.mods[id]);
        return { id: p.id, name: p.name, created: p.created || 0, count: mods.length, mods, codeTag: tag, fromVortex: p.fromVortex || '', fromMo2: p.fromMo2 ? 'yes' : '' };
      }),
    };
  }

  /** The profile as a share code, made from its mods as they are now. */
  /**
   * Give mods that know their Nexus mod but not the exact file (moved from Vortex, installed from a
   * file) that file, looked up on Nexus by their version. Kept on the mod: asked once. Returns how
   * many were found.
   */
  async resolveNexusFiles(mods) {
    const todo = mods.filter(m => Number(m.modId) > 0 && !(Number(m.fileId) > 0) && m.version && !m.nexusFileChecked);
    if (!todo.length || !this.settings.apiKey) return 0;
    const groups = new Map();
    for (const m of todo) groups.set(`${m.game || 'cyberpunk2077'}/${m.modId}`, [...(groups.get(`${m.game || 'cyberpunk2077'}/${m.modId}`) || []), m]);
    const work = [...groups.values()];
    let found = 0;
    const worker = async () => {
      while (work.length) {
        const list = work.shift();
        try {
          const res = await this.nexus.getFiles(list[0].game || 'cyberpunk2077', list[0].modId);
          for (const m of list) {
            const f = matchNexusFile(res.files || [], m);
            m.nexusFileChecked = Date.now(); // matched or not: not asked again
            if (f) { m.fileId = Number(f.file_id); found++; }
          }
        } catch (err) {
          this.log.warn(`Could not look up the Nexus file of ${list[0].name}`, err.message);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    this.library.save();
    if (found) this.log.info(`Found the exact Nexus file of ${plural(found, 'mod')} (moved from Vortex or installed from a file)`);
    return found;
  }

  /** Look up missing Nexus files a moment from now (after a batch of installs or a move from Vortex). */
  resolveSoon() {
    clearTimeout(this.resolveTimer);
    this.resolveTimer = setTimeout(() => {
      this.resolveNexusFiles(Object.values(this.data.mods)).then(n => { if (n) this.emit('changed'); }).catch(() => {});
    }, 2000);
    this.resolveTimer.unref?.();
  }

  /** Before sharing a profile: find the Nexus files of its mods that lack one, so the code can hold them. */
  async resolveProfileFiles(id) {
    const p = this.data.profiles.list[id];
    if (!p) throw new Error('That profile no longer exists.');
    return this.resolveNexusFiles(p.enabled.map(mid => this.data.mods[mid]).filter(Boolean));
  }

  async profileCode(id) {
    await this.resolveProfileFiles(id);
    const doc = this.exportProfile(id);
    const code = profileCode.encode(doc);
    const local = doc.mods.filter(m => !(m.modId > 0 && m.fileId > 0)).length;
    return { code, name: doc.name, mods: doc.mods.length - local, local, tag: profileCode.fingerprint(code) };
  }

  /** A pasted share code, or pasted profile JSON, read like an imported file. */
  async planProfileCode(text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('Paste a profile code first.');
    if (t.startsWith('{')) {
      let doc;
      try { doc = JSON.parse(t); } catch { throw new Error('That text is not a valid profile.'); }
      return this.planProfileImport(doc);
    }
    return this.planProfileImport(profileCode.decode(t));
  }

  switchProfile(id) {
    return this.op(async () => {
      if (!this.isProfile(id)) throw new Error('That profile no longer exists.');
      const p = this.data.profiles.list[id];
      const savesFrom = this.settings.get('perProfileSaves') ? this.savesOwner() : '';
      if (savesFrom && savesFrom !== id && await this.gameRunning()) throw new Error(GAME_RUNNING_SAVES);
      const swapped = savesFrom && savesFrom !== id ? await this.swapSavesTo(id) : null;
      const want = new Set(p.enabled);
      const before = Object.values(this.data.mods).map(m => [m, m.enabled, m.priority]);
      for (const m of Object.values(this.data.mods)) m.enabled = want.has(m.id);
      this.applyProfilePriorities(p);
      const prevActive = this.data.profiles.active;
      this.data.profiles.active = id;
      await this.switchOffVortexTwins([...want]).catch(err => this.log.warn("Could not switch off Vortex's copy", err.message));
      try {
        this.deploy();
      } catch (err) {
        for (const [m, en, prio] of before) { m.enabled = en; m.priority = prio; }
        this.data.profiles.active = prevActive;
        this.library.save();
        if (swapped) await this.swapSavesTo(savesFrom).catch(e => this.log.error('Could not put the saves back after the failed switch (they are in the backup made before it)', e.message));
        throw err;
      }
      this.log.success(`Switched to profile "${p.name}" (${plural(want.size, 'mod')} enabled)${swapped ? `, with its saves (${plural(swapped.count, 'save')})` : ''}`);
    });
  }

  createProfile(name, { copyCurrent = true } = {}) {
    return this.op(async () => {
      const clean = String(name || '').trim().slice(0, 60);
      if (!clean) throw new Error('Give the profile a name.');
      if (Object.values(this.data.profiles.list).some(p => p.name.toLowerCase() === clean.toLowerCase())) throw new Error(`A profile called "${clean}" already exists.`);
      const id = crypto.randomBytes(5).toString('hex');
      const enabled = copyCurrent ? Object.values(this.data.mods).filter(m => m.enabled).map(m => m.id) : [];
      this.data.profiles.list[id] = { id, name: clean, enabled, created: Date.now() };
      this.library.save();
      this.log.success(`Created profile "${clean}"`);
      return id;
    });
  }

  renameProfile(id, name) {
    return this.op(async () => {
      const p = this.isProfile(id) ? this.data.profiles.list[id] : null;
      const clean = String(name || '').trim().slice(0, 60);
      if (!p || !clean) throw new Error('Give the profile a name.');
      if (Object.values(this.data.profiles.list).some(o => o.id !== id && o.name.toLowerCase() === clean.toLowerCase())) throw new Error(`A profile called "${clean}" already exists.`);
      p.name = clean;
      this.library.save();
    });
  }

  deleteProfile(id) {
    return this.op(async () => {
      const list = this.data.profiles.list;
      if (!this.isProfile(id)) return;
      if (Object.keys(list).length === 1) throw new Error('You need at least one profile.');
      if (this.data.profiles.active === id) throw new Error('Switch to another profile before deleting this one.');
      const name = list[id].name;
      const ownsGameSaves = this.data.profileSaves?.owner === id;
      if (ownsGameSaves && this.settings.get('perProfileSaves')) throw new Error(`The saves in the game's folder are "${name}"'s: switch to it and back first.`);
      // Its saves (per-profile saves) are kept, in a folder of deleted profiles.
      let savesKeptIn = '';
      try {
        savesKeptIn = await this.saves.exclusive(() => this.profileSaves.retire(id, name));
      } catch (err) {
        throw new Error(`Could not set the profile's saves aside, so it was not deleted: ${err.message}`);
      }
      if (ownsGameSaves) delete this.data.profileSaves.owner;
      delete list[id];
      this.library.save();
      this.log.success(`Deleted profile "${name}"${savesKeptIn ? ` (its saves are kept in ${savesKeptIn})` : ''}`);
      return { savesKeptIn };
    });
  }

  /**
   * A Vortex profile, seen from here: the mods it enables, which this app has already (moved over,
   * or the same Nexus file), which would move over, and which other Vortex mods are on now.
   */
  vortexProfileParts(vxId, data = this.vortex.read()) {
    const p = (data.profiles || []).find(x => x.id === vxId);
    if (!p) throw new Error('That Vortex profile no longer exists.');
    const adopted = this.data.vortexAdopted || {};
    const twins = this.vortexTwins(data);
    const known = new Set((data.mods || []).map(m => m.vortexId));
    const wanted = p.enabledIds.filter(id => known.has(id));
    const ours = id => (this.data.mods[adopted[id]] ? adopted[id] : this.data.mods[twins[id]] ? twins[id] : '');
    const move = wanted.filter(id => !ours(id));
    const want = new Set(wanted);
    // Vortex keeps placing its enabled mods: the ones this profile does not have, and the ones this app has its own copy of.
    const others = (data.mods || []).filter(m => m.enabled && !adopted[m.vortexId] && (!want.has(m.vortexId) || twins[m.vortexId]));
    const existing = Object.values(this.data.profiles.list).find(x => x.fromVortex === vxId);
    return { p, wanted, move, ours, others, existing };
  }

  /** What "Use here" would do with a Vortex profile (shown before anything changes). */
  vortexProfilePlan(vxId) {
    const { p, wanted, move, others, existing } = this.vortexProfileParts(vxId);
    return {
      name: p.name, mods: wanted.length, here: wanted.length - move.length, move: move.length, others: others.length,
      profile: existing?.name || '', vortexRunning: !!this.vortexRunning,
    };
  }

  /**
   * Use a Vortex profile in this app: its mods this app lacks move over (as "Move to this app"
   * does: linked from Vortex's folders, Vortex keeps them switched off), a profile here gets its
   * name and exactly its enabled mods, and this app switches to it. With switchOffOthers, Vortex
   * stops placing the mods it has on that this profile does not have, so the game gets that setup.
   * Using the same Vortex profile again updates the profile made the first time.
   */
  async useVortexProfile(vxId, { switchOffOthers = true } = {}) {
    if (!this.vortex.installed) throw new Error('Vortex is not installed.');
    if (this.settings.get('perProfileSaves') && await this.gameRunning()) throw new Error(GAME_RUNNING_SAVES); // before anything changes
    const first = this.vortexProfileParts(vxId);
    if (first.move.length) await this.adoptFromVortex(first.move.map(id => `vx:${id}`));
    const now = this.vortexProfileParts(vxId);
    if (switchOffOthers && now.others.length) {
      const changes = now.others.map(m => ({ vortexId: m.vortexId, enabled: false }));
      await this.vortex.apply(changes);
      this.noteVortexToggles(changes);
    }
    const enabled = [...new Set(now.wanted.map(now.ours).filter(Boolean))];
    const id = await this.op(async () => {
      const list = this.data.profiles.list;
      let pid = Object.values(list).find(x => x.fromVortex === vxId)?.id;
      if (!pid) {
        const taken = new Set(Object.values(list).map(x => x.name.toLowerCase()));
        let name = `${now.p.name} (Vortex)`.slice(0, 60);
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${now.p.name} (Vortex ${n})`.slice(0, 60);
        pid = crypto.randomBytes(5).toString('hex');
        list[pid] = { id: pid, name, enabled: [], created: Date.now(), fromVortex: vxId };
        this.log.success(`Created profile "${name}" from the Vortex profile "${now.p.name}"`);
      }
      list[pid].enabled = enabled;
      this.library.save();
      return pid;
    });
    await this.switchProfile(id);
    return { id, name: this.data.profiles.list[id].name, enabled: enabled.length, moved: first.move.length };
  }

  // ---------------------------------------------------------------- save backups

  /** The mod setup right now, as one string: which mods are on, their versions and order. */
  modsFingerprint() {
    const parts = Object.values(this.data.mods).filter(m => m.enabled).map(m => `${m.id}@${m.version || ''}#${m.priority}`).sort();
    try { for (const v of this.vortex.read().mods || []) if (v.enabled) parts.push(`vx:${v.vortexId}`); } catch { /* no Vortex */ }
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  }

  /** Who a backup is made for: the active profile, and how many mods are on. */
  backupInfo() {
    const p = this.data.profiles?.list?.[this.data.profiles.active];
    return { profile: p?.id || '', profileName: p?.name || '', mods: Object.values(this.data.mods).filter(m => m.enabled).length };
  }

  /**
   * The automatic backup (Play, or the game starting from elsewhere), by the Save manager settings:
   *   - off: nothing
   *   - mods changed since the last backup: back up (whatever the cooldown)
   *   - otherwise: back up when the cooldown has passed
   *   - "pause when not played": no backup while the saves are exactly as in the last one
   * Returns { made, skipped: why }.
   */
  async autoBackupSaves(trigger = 'play') {
    if (!this.settings.get('saveAutoBackup')) return { skipped: 'off' };
    const saves = scanSaves(this.saves.savesDir());
    if (!saves.length) return { skipped: 'no saves' };
    // The last automatic backup's record counts only while that backup still exists (deleted, or a new
    // backup folder: start over).
    const newest = this.saves.list().find(b => !['restore', 'switch', 'delete'].includes(b.reason));
    const last = newest && this.data.saveBackup?.at === newest.at ? this.data.saveBackup : {};
    const savesFp = savesFingerprint(saves);
    const modsFp = this.modsFingerprint();
    const modsChanged = !!last.modsFp && last.modsFp !== modsFp;
    if (this.settings.get('savePauseUnchanged') !== false && last.savesFp === savesFp) {
      // Nothing played since the last backup: that backup already holds these exact saves (made
      // with whatever mods were on then; from now on the current setup is the one to compare with).
      if (this.data.saveBackup && last.modsFp !== modsFp) { this.data.saveBackup.modsFp = modsFp; this.library.save(); }
      return { skipped: 'not played since the last backup' };
    }
    const cooldown = Math.max(0, Number(this.settings.get('saveCooldown')) || 0) * 60000;
    if (!modsChanged && last.at && Date.now() - last.at < cooldown) return { skipped: 'cooldown' };
    const reason = trigger === 'game-start' ? 'game-start' : modsChanged ? 'play-mods' : 'play';
    return { made: await this.backupSavesNow({ reason }) };
  }

  /** Back up the saves now (manual, or for a reason), then keep the backups within the limit. */
  async backupSavesNow({ reason = 'manual', label = '' } = {}) {
    const record = await this.saves.create({ ...this.backupInfo(), reason, label });
    if (!record) throw new Error('There are no Cyberpunk 2077 saves to back up yet.');
    // What this backup holds (not a second look at the folder: the game may have saved since).
    this.data.saveBackup = { at: record.at, savesFp: savesFingerprint(record.saves), modsFp: this.modsFingerprint() };
    this.library.save();
    const removed = this.saves.prune(this.settings.get('saveMaxPerProfile'));
    this.log.success(`Backed up ${plural(record.saves.length, 'save')} (${REASONS[record.reason]})${removed.length ? `; removed ${plural(removed.length, 'older backup')}` : ''}`);
    this.emit('saves');
    return record;
  }

  /** Everything the Saves page shows: playthroughs and their saves, backups, where they are. */
  savesView() {
    const dir = this.saves.savesDir();
    const saves = scanSaves(dir);
    const backups = this.saves.list();
    return {
      savesDir: dir, found: fs.existsSync(dir), backupDir: this.saves.root(),
      steamCloud: !!dir && fs.existsSync(path.join(dir, 'steam_autocloud.vdf')),
      playthroughs: groupPlaythroughs(saves),
      saves: saves.map(({ files, screenshot, ...s }) => s),
      backups,
      diskSize: this.saves.diskSize(),
      last: this.data.saveBackup?.at || 0,
      profiles: Object.values(this.data.profiles.list).map(p => ({ id: p.id, name: p.name })),
      // Off, after switching profiles: whose the saves in the game's folder were (turning it on again asks).
      perProfileWas: !this.settings.get('perProfileSaves') && this.isProfile(this.data.profileSaves?.owner) && this.data.profileSaves.owner !== this.data.profiles.active ? this.data.profileSaves.owner : '',
      perProfile: this.settings.get('perProfileSaves') ? {
        owner: this.savesOwner(), active: this.data.profiles.active, store: this.profileSaves.root(),
        playthroughs: this.profileSaves.overview(Object.keys(this.data.profiles.list), this.savesOwner()),
      } : null,
      stored: this.settings.get('perProfileSaves') ? null : this.storedSaves(),
    };
  }

  /**
   * Off: saves that profiles' own folders still hold from when each profile had its own (switching to a
   * profile swapped the others' out). The game cannot see them; the Saves page copies them in.
   * { owner, playthroughs }, or null when there are none. Off, the game's folder is no profile's: every
   * profile's own folder is listed, the last owner's too (it can be stale, or gone and replaced by the
   * profile in use). owner: the profile copies are addressed to (copySavesBetween puts them in the game).
   */
  storedSaves() {
    try {
      const playthroughs = this.profileSaves.overview(Object.keys(this.data.profiles.list), '');
      return Object.values(playthroughs).some(list => list.length) ? { owner: this.savesOwner(), playthroughs } : null;
    } catch {
      return null; // where profiles keep saves is not known (no home folder): nothing to show
    }
  }

  /**
   * A save's screenshot as a data URL (the page cannot read the save folder itself). With a profile:
   * from that profile's own folder, unless its saves are the game's now (per-profile saves on; off,
   * the game's folder is no profile's).
   */
  saveScreenshot(folder, profileId = '') {
    const s = String(folder);
    if (!SAVE_SLOT.test(s)) throw new Error('No such save.');
    let dir = this.saves.savesDir();
    if (profileId && (!this.settings.get('perProfileSaves') || profileId !== this.savesOwner())) {
      if (!this.isProfile(profileId)) throw new Error('Unknown profile.');
      dir = this.profileSaves.dirOf(profileId);
    }
    if (!dir || !path.isAbsolute(dir)) return ''; // the save folder is not known yet (Linux)
    const file = path.join(dir, s, 'screenshot.png');
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > 4 << 20) return '';
      const data = fs.readFileSync(file);
      if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return '';
      return `data:image/png;base64,${data.toString('base64')}`;
    } catch {
      return ''; // no screenshot
    }
  }

  /**
   * README.txt in Saved Games\Edgerunners Mod Manager: where every kept save is, whose, and how to use
   * them without the app (it outlives an uninstall). Only once there is something kept. Returns its path.
   */
  writeSavesReadme() {
    const home = this.savesHome();
    if (!home) return '';
    const backups = this.saves.root();
    const store = this.profileSaves.root();
    const entries = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')); } catch { return []; } };
    const profileDirs = entries(store).filter(e => PROFILE_ID.test(e.name)).map(e => {
      const dir = path.join(store, e.name);
      let label = '';
      try { label = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8')).profile; } catch { /* unnamed */ }
      const name = (this.isProfile(e.name) && this.data.profiles.list[e.name].name) || (typeof label === 'string' && label) || e.name;
      return { dir, name: String(name).slice(0, 60), count: scanSaves(dir).length };
    }).filter(p => p.count);
    const deleted = entries(path.join(store, 'Deleted profiles')).filter(e => scanSaves(path.join(store, 'Deleted profiles', e.name)).length);
    if (!entries(backups).length && !profileDirs.length && !deleted.length) return '';
    const on = this.settings.get('perProfileSaves');
    const oneLine = t => String(t || '').replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim(); // \s: line and paragraph separators too
    const owner = oneLine(this.data.profiles.list[this.savesOwner()]?.name);
    const lines = [
      'Edgerunners Mod Manager: your Cyberpunk 2077 saves',
      `Written by the app (last updated ${new Date().toLocaleString()}). Uninstalling the app never removes this folder.`,
      '',
      'THE GAME\'S SAVE FOLDER (the saves the game loads now)',
      `  ${this.saves.savesDir()}`,
      ...(on && owner ? [`  Each profile has its own saves: these are the saves of the profile "${owner}".`] : []),
      '',
      'SAVE BACKUPS',
      `  ${backups}`,
      '  One folder per day, and in it one per backup, by time ("14-05-12 Before play": made at 14:05:12, before playing).',
      '  Each save folder in a backup (ManualSave-3, AutoSave-0, ...) is a complete save.',
      ...(profileDirs.length ? ['', 'SAVES OF YOUR OTHER PROFILES (each profile had its own saves)', ...profileDirs.map(p => `  "${oneLine(p.name)}" (${p.count} save${p.count === 1 ? '' : 's'}): ${p.dir}`)] : []),
      ...(deleted.length ? ['', 'SAVES OF DELETED PROFILES', ...deleted.map(e => `  ${oneLine(path.join(store, 'Deleted profiles', e.name))}`)] : []),
      '',
      'TO USE A SAVE WITHOUT THE APP',
      '  1. Close the game.',
      '  2. Copy the save folder (for example ManualSave-3, with everything in it) into the game\'s save folder above.',
      '     A folder of that name already there? Give the copy an unused number (ManualSave-90): the game loads it all the same.',
      '  3. Files copied out of a backup are read-only: right-click the copied folder, Properties, untick Read-only, OK (apply to all).',
      '  4. Start the game and load it.',
      '  Never copy user.gls or the other files beside the save folders: they are the game\'s own settings and your sign-in.',
      '',
    ];
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'README.txt');
    fs.writeFileSync(`${file}.tmp`, lines.join('\r\n'));
    fs.renameSync(`${file}.tmp`, file);
    return file;
  }

  // ---------------------------------------------------------------- per-profile saves

  /** Whose saves are in the game's folder now (with per-profile saves): the profile that last had them. */
  savesOwner() {
    const owner = this.data.profileSaves?.owner;
    return owner && Object.hasOwn(this.data.profiles.list, owner) ? owner : this.data.profiles.active;
  }

  /** The folder a profile's saves are in right now: the game's for the owner, its own for the others. */
  savesDirOf(profileId) {
    return profileId === this.savesOwner() ? this.saves.savesDir() : this.profileSaves.dirOf(profileId);
  }

  /** Is this one of the profiles (not an Object built-in like "constructor")? */
  isProfile(id) { return typeof id === 'string' && Object.hasOwn(this.data.profiles.list, id); }

  /** Name every profile's saves folder, for people browsing it without the app. */
  labelProfileSaves() {
    for (const [pid, p] of Object.entries(this.data.profiles.list)) { try { this.profileSaves.label(pid, p.name); } catch { /* named next time */ } }
  }

  /**
   * Turn per-profile saves on or off. On: the saves in the game's folder belong to `owner` when given
   * (the profile that had them before it was turned off), else to the profile in use; when that is
   * another profile, they are swapped for the profile in use's. Off: everything stays where it is;
   * switching profiles no longer moves saves (other profiles' saves wait in their folders).
   */
  setPerProfileSaves(on, { owner } = {}) {
    return this.op(async () => {
      const active = this.data.profiles.active;
      if (on) {
        const was = this.isProfile(owner) ? owner : active;
        if (was !== active && await this.gameRunning()) throw new Error(GAME_RUNNING_SAVES);
        await this.saves.exclusive(() => this.recoverSwap()); // a switch cut off earlier is sorted out against the old owner first
        this.data.profileSaves = { owner: was };
        this.labelProfileSaves();
        this.settings.update({ perProfileSaves: true });
        this.library.save();
        if (was !== active) {
          try {
            await this.swapSavesTo(active);
          } catch (err) {
            this.settings.update({ perProfileSaves: false });
            throw err;
          }
        }
      } else {
        this.settings.update({ perProfileSaves: false });
        this.library.save();
      }
      this.log.success(on ? 'Each profile now has its own saves' : 'Profiles share one set of saves again (other profiles\' saves stay in their folders)');
      this.emit('saves');
      return { on: !!on, owner: this.savesOwner() };
    });
  }

  /**
   * A switch of saves left behind (the app was stopped in the middle of one): kept when its new owner
   * is the recorded one, undone otherwise. Also clears half-made copies. Inside saves.exclusive.
   * Returns 'kept', 'undone' or ''.
   */
  async recoverSwap() {
    const ps = this.profileSaves;
    const dirs = [this.saves.savesDir(), ...Object.keys(this.data.profiles.list).filter(id => PROFILE_ID.test(id)).map(id => ps.dirOf(id))];
    const j = ps.readJournal();
    if (!j) { ps.sweep(dirs); return ''; }
    const owner = this.data.profileSaves?.owner;
    const to = j.head.to;
    if (to && owner === to) { ps.clear(); return 'kept'; } // it went through: only the clean-up was cut off
    if (await this.gameRunning()) throw new Error(GAME_RUNNING_SAVES);
    const r = await ps.undo();
    ps.sweep(dirs);
    const name = this.data.profiles.list[this.savesOwner()]?.name || 'the profile that had them';
    if (r.left.length) this.log.error(`A switch of saves was cut off last time; most saves are back with "${name}", these could not be moved back (the backup made before the switch has them): ${r.left.join('; ')}`);
    else this.log.warn(`A switch of saves was cut off last time and has been undone: the saves are back with "${name}"`);
    this.emit('saves');
    return 'undone';
  }

  /** At start: sort out a switch of saves the app was stopped in the middle of. */
  recoverProfileSaves() {
    return this.saves.exclusive(() => this.recoverSwap());
  }

  /** Move the saves: the game's go to their owner's folder, `id`'s come in. A safety backup first. */
  async swapSavesTo(id) {
    if (this.savesOwner() === id) return null;
    return this.saves.exclusive(async () => {
      await this.recoverSwap();
      const from = this.savesOwner();
      if (from === id) return null;
      const ownerName = this.data.profiles.list[from]?.name || '';
      await this.saves.createNow({ profile: from, profileName: ownerName, mods: Object.values(this.data.mods).filter(m => m.enabled).length, reason: 'switch' });
      // Again, right before anything moves: the game may have started during the backup.
      if (await this.gameRunning()) throw new Error(GAME_RUNNING_SAVES);
      const r = await this.profileSaves.swap(from, id);
      this.data.profileSaves = { owner: id };
      this.library.save({ durable: true });
      this.profileSaves.clear(); // only once the new owner is surely on disk (recoverSwap reads the journal against it)
      this.labelProfileSaves();
      this.emit('saves');
      return { count: r.count };
    });
  }

  /** How many saves a profile has (for "this profile has no saves yet"). */
  profileSaveCount(id, { stored = false } = {}) {
    if (!this.isProfile(id)) throw new Error('That profile no longer exists.');
    // stored: only the saves in its own folder (what deleting the profile sets aside), not the game's.
    return scanSaves(stored ? this.profileSaves.dirOf(id) : this.savesDirOf(id)).length;
  }

  /**
   * Copy a playthrough from one profile to others (a save already there is skipped; a slot name taken
   * there gets the next free ManualSave number). Never into the game's folder while the game runs.
   */
  copyPlaythrough(playthroughId, sourceId, targetIds) {
    const pt = String(playthroughId).slice(0, 80);
    return this.copySavesBetween(sourceId, targetIds, s => s.playthrough === pt);
  }

  /** Copy single saves (slot folders, e.g. ManualSave-83) from one profile to others, like a playthrough. */
  async copySaves(sourceId, folders, targetIds) {
    const want = new Set((Array.isArray(folders) ? folders : []).map(String).filter(f => SAVE_SLOT.test(f)).slice(0, 500));
    if (!want.size) throw new Error('No such save.');
    return this.copySavesBetween(sourceId, targetIds, s => want.has(s.folder));
  }

  async copySavesBetween(sourceId, targetIds, pick) {
    const list = this.data.profiles.list;
    if (!this.isProfile(sourceId)) throw new Error('That profile no longer exists.');
    // Per-profile saves off: the saves a profile's own folder still holds go into the game's saves, asked
    // for as savesView().stored.owner (no profile-to-profile copies while off).
    if (!this.settings.get('perProfileSaves')) {
      const asked = (Array.isArray(targetIds) ? targetIds : []).map(String).includes(this.savesOwner());
      if (!asked) return { copied: 0, renamed: 0, present: 0, profiles: 0 };
      return this.saves.exclusive(async () => {
        if (await this.gameRunning()) throw new Error('Close Cyberpunk 2077 first: saves cannot be added to the game while it runs.');
        const r = await this.profileSaves.copySaves(this.profileSaves.dirOf(sourceId), pick, this.saves.savesDir());
        if (r.copied) this.log.success(`Copied ${plural(r.copied, 'save')} from "${list[sourceId].name}"'s folder into the game's saves${r.renamed ? ` (${r.renamed} under a new slot name)` : ''}`);
        this.emit('saves');
        return { copied: r.copied, renamed: r.renamed, present: r.present, profiles: 1 };
      });
    }
    const targets = [...new Set((Array.isArray(targetIds) ? targetIds : []).map(String))].filter(t => this.isProfile(t) && t !== sourceId);
    if (!targets.length) return { copied: 0, renamed: 0, present: 0, profiles: 0 };
    return this.saves.exclusive(async () => {
      await this.recoverSwap();
      if (targets.includes(this.savesOwner()) && await this.gameRunning()) throw new Error('Close Cyberpunk 2077 first: saves cannot be added to the game while it runs.');
      let copied = 0;
      let renamed = 0;
      let present = 0;
      for (const t of targets) {
        const r = await this.profileSaves.copySaves(this.savesDirOf(sourceId), pick, this.savesDirOf(t));
        copied += r.copied;
        renamed += r.renamed;
        present += r.present;
        try { this.profileSaves.label(t, list[t].name); } catch { /* named next time */ }
      }
      if (copied) this.log.success(`Copied ${plural(copied, 'save')} to ${plural(targets.length, 'profile')}${renamed ? ` (${renamed} under a new slot name)` : ''}`);
      this.emit('saves');
      return { copied, renamed, present, profiles: targets.length };
    });
  }

  /** Every save of one profile into another (the first switch to a profile with no saves). */
  async copyAllSaves(sourceId, targetId) {
    if (!this.isProfile(sourceId)) throw new Error('That profile no longer exists.');
    const pts = new Set(scanSaves(this.savesDirOf(sourceId)).map(s => s.playthrough));
    let copied = 0;
    for (const pt of pts) copied += (await this.copyPlaythrough(pt, sourceId, [targetId])).copied;
    return { copied };
  }

  // ---------------------------------------------------------------- requirements (the Mods page)

  /**
   * Every mod's requirements, resolved against what is installed, for the Mods page:
   * { [row id]: [{ id, modId, name, state, version, url, notes, inferred }] } where state is
   *   on / off      a mod here (this app's or Vortex's) that is on or off; id is its row
   *   missing       not installed (Download)
   *   outside       in the game folder from something else (no switch)
   *   external      hosted off Nexus (a link)
   * From Nexus (cached, fetched in the background) and from the mod's own files.
   */
  requirementsView(vortex = this.vortexView()) {
    const cache = this.data.requirements || {};
    const game = this.gameDir();
    let vxFiles = new Map();
    try { vxFiles = new Map((this.vortex.read().mods || []).map(v => [v.id, v.deployedFiles || []])); } catch { /* no Vortex */ }
    const rows = [
      ...Object.values(this.data.mods).map(m => ({ id: m.id, modId: Number(m.modId) || 0, enabled: !!m.enabled, name: m.name, version: m.version || '', files: m.files || [], priority: m.priority || 0 })),
      ...(vortex.mods || []).map(v => ({ id: v.id, modId: Number(v.modId) || 0, enabled: !!v.enabled, name: v.name, version: v.version || '', files: vxFiles.get(v.id) || [], priority: 0 })),
    ];
    // The row that stands for a Nexus mod: the enabled one, else the highest priority.
    const byModId = new Map();
    for (const r of rows) {
      if (!r.modId) continue;
      const cur = byModId.get(r.modId);
      if (!cur || (r.enabled && !cur.enabled) || (r.enabled === cur.enabled && r.priority > cur.priority)) byModId.set(r.modId, r);
    }
    const outside = new Map();
    const isOutside = (modId, name) => {
      if (!outside.has(modId)) outside.set(modId, !!foundInGame(game, { modId, modName: name }));
      return outside.get(modId);
    };
    const out = {};
    const unknown = [];
    let lookup = false;
    for (const r of rows) {
      const list = [];
      const seen = new Set(r.modId ? [r.modId] : []);
      const entry = r.modId ? cache[r.modId] : null;
      if (r.modId && !entry) unknown.push(r.modId);
      for (const raw of entry?.list || []) {
        const q = this.reqOnNexus(raw);
        if (q.external && !q.official && !this.reqNameLooked(q.name)) lookup = true;
        if (q.modId && seen.has(q.modId)) continue;
        if (q.modId) seen.add(q.modId);
        list.push(q);
      }
      for (const modId of inferRequirements(r.files)) {
        if (seen.has(modId)) continue;
        seen.add(modId);
        list.push({ modId, name: FRAMEWORK_NAMES[modId], inferred: true });
      }
      if (!list.length) continue;
      out[r.id] = list.map(q => {
        const base = { modId: q.modId || 0, notes: q.notes || '', inferred: !!q.inferred, byName: !!q.byName };
        // REDmod: CD PROJEKT RED's own (a free DLC), there or not.
        if (q.official) return { ...base, name: q.name || 'REDmod', state: game && redmodToolsInstalled(game) ? 'builtin' : 'official', url: q.url || '' };
        if (q.external || !q.modId) return { ...base, name: q.name || 'A mod not on Nexus', state: 'external', url: q.url || '' };
        const hit = byModId.get(q.modId);
        if (hit) return { ...base, id: hit.id, name: hit.name, state: hit.enabled ? 'on' : 'off', version: hit.version };
        return { ...base, name: q.name || FRAMEWORK_NAMES[q.modId] || `Nexus mod ${q.modId}`, state: isOutside(q.modId, q.name) ? 'outside' : 'missing' };
      });
    }
    // Mods never looked up (new here, or moved in), and requirements named but not linked: ask Nexus in the background.
    if (unknown.length || lookup) this.requirementsSoon();
    return out;
  }

  /**
   * A requirement listed as off-site that is a Nexus mod after all: linked to its Nexus page, a
   * framework by name ("CET (No REDMOD version)"), or found by name on Nexus before. REDmod (CD
   * PROJEKT RED's own) is marked official.
   */
  reqOnNexus(q) {
    if (!q?.external) return q;
    const linked = requirementOnNexus(q, 'cyberpunk2077');
    if (!linked.external) return linked;
    const key = reqNameKey(q.name);
    // REDmod by name only; its "Open page" only ever goes to CD PROJEKT RED's own site.
    if (key === 'redmod') return { ...q, official: true, url: /^https:\/\/(www\.)?cyberpunk\.net\//i.test(q.url || '') ? q.url : '' };
    if (FRAMEWORK_ALIASES.has(key)) return { ...q, modId: FRAMEWORK_ALIASES.get(key), external: false };
    const names = this.data.reqNames || {};
    const modId = Object.hasOwn(names, key) ? Number(names[key].modId) || 0 : 0;
    return modId ? { ...q, modId, external: false, byName: true } : q;
  }

  /** Was this requirement name looked up on Nexus in the last 30 days (found or not)? */
  reqNameLooked(name) {
    const key = reqNameKey(name);
    const names = this.data.reqNames || {};
    return key.length < 4 || (Object.hasOwn(names, key) && Date.now() - names[key].at < 30 * 86400000);
  }

  /**
   * Off-site requirements that name a mod without linking it: looked up by name on Nexus. A match
   * only when exactly one mod there has the same name (brackets and versions aside); two mods of
   * that name is no match. Kept 30 days, misses too; at most 25 names a time, a moment apart. A name
   * Nexus refuses counts as a miss; no network (or a limit reached) stops the round. Returns how many
   * names were settled.
   */
  async matchRequirementNames() {
    const names = this.data.reqNames ||= {};
    const todo = new Map();
    for (const e of Object.values(this.data.requirements || {})) {
      for (const raw of e.list || []) {
        const q = this.reqOnNexus(raw);
        if (q.external && !q.official && !this.reqNameLooked(q.name)) todo.set(reqNameKey(q.name), q.name);
      }
    }
    let n = 0;
    for (const [key, name] of todo) {
      if (n >= 25) break;
      if (n) await new Promise(r => setTimeout(r, this.reqLookupGap ?? 300));
      let hits;
      try {
        hits = await this.nexus.findModsByName('cyberpunk2077', String(name).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim());
      } catch (err) {
        const s = Number(err.status) || 0;
        if (!s || s === 401 || s === 403 || s === 429 || s >= 500) {
          this.reqFailedAt = Date.now(); // not again for 5 minutes (requirementsSoon)
          this.log.warn('Could not look up requirements by name on Nexus', err.message);
          break;
        }
        // This name: Nexus will not search it. A 4xx is about the name (a month); any other answer may be Nexus's own trouble (a day).
        names[key] = { modId: 0, at: s >= 400 && s < 500 ? Date.now() : Date.now() - 29 * 86400000 };
        n++;
        continue;
      }
      const same = hits.filter(x => reqNameKey(x.name) === key);
      names[key] = { modId: same.length === 1 ? same[0].modId : 0, at: Date.now() };
      if (same.length === 1) this.log.info(`Requirement "${name}" is on Nexus: ${same[0].name} (mod ${same[0].modId})`);
      n++;
    }
    return n;
  }

  /** Read requirements from Nexus a moment from now (one request per 20 mods: as many as Nexus answers). */
  requirementsSoon(delay = 3000) {
    if (this.reqTimer || this.reqFetching || Date.now() - (this.reqFailedAt || 0) < 300000) return;
    this.reqTimer = setTimeout(() => {
      this.reqTimer = null;
      this.refreshRequirements().catch(err => {
        this.reqFailedAt = Date.now();
        this.log.warn('Could not read mod requirements from Nexus', err.message);
      });
    }, delay);
    this.reqTimer.unref?.();
  }

  /** Fetch requirements for mods never looked up, or looked up over 3 days ago (all with force). */
  async refreshRequirements({ force = false } = {}) {
    if (this.reqFetching) return 0;
    this.reqFetching = true;
    try {
      this.data.requirements ||= {};
      const cache = this.data.requirements;
      let vx = [];
      try { vx = this.vortex.read().mods || []; } catch { /* no Vortex */ }
      const ids = [...new Set([...Object.values(this.data.mods), ...vx].map(m => Number(m.modId)).filter(n => n > 0))];
      const stale = ids.filter(id => force || !cache[id] || Date.now() - cache[id].at > 3 * 86400000);
      if (stale.length) {
        const got = await this.nexus.requirementsMany('cyberpunk2077', stale);
        const at = Date.now();
        // A mod Nexus no longer has gets an empty list, so it is not asked again for 3 days.
        for (const id of stale) cache[id] = { at, list: got.get(id) || [] };
      }
      const named = await this.matchRequirementNames(); // never throws: a failed round backs off by itself
      if (!stale.length && !named) return 0;
      this.library.save();
      this.emit('changed');
      return stale.length;
    } finally {
      this.reqFetching = false;
    }
  }

  // ---------------------------------------------------------------- Mod Organizer 2 (read only)

  /** This app's mod for an MO2 mod: moved before, or the same Nexus file installed here. */
  mo2Ours(inst, mod, byFile = null) {
    const moved = this.data.mo2Adopted?.[`${inst.id}|${mod.folder}`];
    if (moved && this.data.mods[moved]) return moved;
    if (!mod.fileId) return '';
    if (byFile) return byFile.get(mod.fileId) || '';
    return Object.values(this.data.mods).find(m => Number(m.fileId) === mod.fileId)?.id || '';
  }

  /** MO2's instances, profiles and mods for the UI. */
  mo2View() {
    let data;
    try { data = this.mo2.read(); } catch (err) { return { found: false, error: err.message, instances: [], folders: this.settings.get('mo2Folders') || [] }; }
    const game = this.gameDir();
    const byFile = new Map(Object.values(this.data.mods).filter(m => Number(m.fileId) > 0).map(m => [Number(m.fileId), m.id]));
    const made = new Map(Object.values(this.data.profiles.list).filter(p => p.fromMo2).map(p => [p.fromMo2, p.name]));
    return {
      found: data.found,
      folders: this.settings.get('mo2Folders') || [],
      programs: this.mo2.programFolders, // where MO2 is installed (shown when it has no Cyberpunk setup)
      instances: data.instances.map(i => {
        const mods = [...i.mods.values()];
        return {
          id: i.id, name: i.name, portable: i.portable, path: i.dir, gamePath: i.gamePath,
          sameGame: !i.gamePath || !game || samePath(game, i.gamePath),
          mods: mods.length,
          here: mods.filter(m => this.mo2Ours(i, m, byFile)).length,
          // Mods tried before and left in MO2 (empty, or MO2's own workaround): nothing to bring.
          left: mods.filter(m => !this.mo2Ours(i, m, byFile) && !this.data.mo2Skipped?.[`${i.id}|${m.folder}`]).length,
          profiles: i.profiles.map(p => ({ id: p.id, name: p.name, selected: p.selected, count: p.enabled.length, profile: made.get(p.id) || '' })),
        };
      }),
    };
  }

  mo2Profile(profileId) {
    const inst = this.mo2.instance(String(profileId).split('/')[0]);
    const p = inst?.profiles.find(x => x.id === profileId);
    if (!p) throw new Error('That Mod Organizer 2 profile no longer exists.');
    return { inst, p };
  }

  /** A profile's enabled mods, top to bottom as MO2's window lists them (the last one wins). */
  mo2ProfileMods(profileId) {
    const { inst, p } = this.mo2Profile(profileId);
    return [...p.enabled].reverse().map(f => {
      const m = inst.mods.get(f);
      return { name: m.name, version: m.version, modId: m.modId, here: !!this.mo2Ours(inst, m) };
    });
  }

  /** What "Use here" would do with an MO2 profile (shown before anything changes). */
  mo2ProfilePlan(profileId) {
    const { inst, p } = this.mo2Profile(profileId);
    const move = p.enabled.filter(f => !this.mo2Ours(inst, inst.mods.get(f)));
    const existing = Object.values(this.data.profiles.list).find(x => x.fromMo2 === p.id);
    return {
      name: p.name, instance: inst.name, mods: p.enabled.length, here: p.enabled.length - move.length, move: move.length,
      empty: move.filter(f => this.mo2.skipReason(inst.mods.get(f))).length, profile: existing?.name || '',
    };
  }

  /**
   * Bring MO2 mods into this app. MO2 is left exactly as it was: its files are hardlinked (copied
   * across drives) into this app's staging folder, root/ (RootBuilder) going to the game root, and
   * its archive into this app's downloads when MO2 still has it. A mod this app already has (moved
   * before, or the same Nexus file) is matched instead. Moved mods start switched off here (using a
   * profile turns them on). folders: highest priority first, as in modlist.txt.
   */
  adoptFromMo2(instId, folders = 'all') {
    return this.op(async () => {
      const inst = this.mo2.instance(instId);
      if (!inst) throw new Error('That Mod Organizer 2 instance is no longer there.');
      const order = inst.profiles.find(p => p.selected)?.order || [...inst.mods.keys()];
      const want = folders === 'all' ? order : folders.filter(f => inst.mods.has(f));
      this.data.mo2Adopted ||= {};
      const adopted = this.data.mo2Adopted;
      const out = [];
      const failed = [];
      const skipped = [];
      // Lowest priority first, so the mod that won a file in MO2 wins it here too.
      for (const folder of [...want].reverse()) {
        const m = inst.mods.get(folder);
        if (!m) continue;
        const key = `${inst.id}|${folder}`;
        const ours = this.mo2Ours(inst, m);
        if (ours) { adopted[key] = ours; out.push({ folder, id: ours, matched: true }); continue; }
        const skip = this.mo2.skipReason(m);
        if (skip) {
          skipped.push(folder);
          (this.data.mo2Skipped ||= {})[key] = skip; // so Settings does not keep offering it
          this.log.info(`Left ${m.name} in Mod Organizer 2: ${skip}`);
          continue;
        }
        try {
          const id = m.fileId && !this.data.mods[String(m.fileId)] ? String(m.fileId)
            : `mo2-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
          const src = path.join(inst.modsDir, folder);
          const dest = path.join(this.settings.stagingDir, id);
          fs.rmSync(dest, { recursive: true, force: true });
          const files = [];
          const seen = new Set();
          for (const f of this.mo2.modFiles(m)) {
            const rel = f.dest.replace(/\\/g, '/');
            // root/x and x both mean the game's x: the first one found is kept.
            if (!isSafeRel(rel) || seen.has(rel.toLowerCase())) continue;
            seen.add(rel.toLowerCase());
            const to = path.join(dest, rel);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            // Settings files a mod rewrites while the game runs are copied: a link would change MO2's copy too.
            if (WRITABLE.test(rel)) fs.copyFileSync(path.join(src, f.src), to);
            else { try { fs.linkSync(path.join(src, f.src), to); } catch { fs.copyFileSync(path.join(src, f.src), to); } }
            files.push(rel);
          }
          // The archive too, so Reinstall works here.
          if (m.archive) {
            const dl = path.join(this.settings.downloadsDir, 'mo2', path.basename(m.archive));
            fs.mkdirSync(path.dirname(dl), { recursive: true });
            if (!fs.existsSync(dl)) { try { fs.linkSync(m.archive, dl); } catch { fs.copyFileSync(m.archive, dl); } }
            this.data.downloads[id] = {
              key: id, game: 'cyberpunk2077', modId: m.modId, modName: m.modName, fileId: m.fileId, name: m.name, fileName: path.basename(m.archive),
              version: m.version, category: m.category, size: fs.statSync(dl).size, uploaded: 0, author: m.author, picture: '', path: dl, downloadedAt: Date.now(),
            };
          }
          this.data.mods[id] = {
            id, key: id, name: m.name, modName: m.modName, modId: m.modId, fileId: m.fileId,
            game: 'cyberpunk2077', version: m.version, category: m.category, author: m.author,
            type: this.mo2.modType(m), files, skipped: 0, warnings: [],
            enabled: false, priority: this.data.nextPriority++, installedAt: Date.now(),
            fomod: false, dependencyOf: '', fromMo2: key,
          };
          adopted[key] = id;
          out.push({ folder, id });
        } catch (err) {
          failed.push(folder);
          this.log.error(`Could not move ${m.name} from Mod Organizer 2`, err.message);
        }
      }
      this.library.save();
      const fresh = out.filter(o => !o.matched).length;
      if (out.length) this.log.success(`Brought ${plural(fresh, 'mod')} over from Mod Organizer 2 (${inst.name})${out.length > fresh ? `; ${out.length - fresh} were here already` : ''}. MO2 is unchanged.`);
      this.emit('changed');
      if (fresh) this.resolveSoon(); // the exact Nexus file of any that only know their mod
      return { adopted: out, failed: failed.length, skipped: skipped.length };
    });
  }

  /**
   * Use an MO2 profile in this app: its mods this app lacks are brought over, then a profile here
   * gets exactly its enabled mods in MO2's order and becomes the active one. Using the same MO2
   * profile again updates the profile made the first time. MO2 itself is not changed.
   */
  async useMo2Profile(profileId) {
    const first = this.mo2Profile(profileId);
    if (!isGameDir(this.gameDir())) throw new Error('Set the Cyberpunk 2077 folder in Settings first.');
    if (!first.p.enabled.length) throw new Error(`"${first.p.name}" has no mods enabled in Mod Organizer 2.`);
    if (this.settings.get('perProfileSaves') && await this.gameRunning()) throw new Error(GAME_RUNNING_SAVES); // before anything changes
    const r = await this.adoptFromMo2(first.inst.id, first.p.enabled);
    const { inst, p } = this.mo2Profile(profileId);
    // Lowest priority first: the order the profile's mods get here.
    const order = [...new Set([...p.enabled].reverse().map(f => this.mo2Ours(inst, inst.mods.get(f))).filter(Boolean))];
    const id = await this.op(async () => {
      const list = this.data.profiles.list;
      let pid = Object.values(list).find(x => x.fromMo2 === p.id)?.id;
      if (!pid) {
        const taken = new Set(Object.values(list).map(x => x.name.toLowerCase()));
        let name = `${p.name} (MO2)`.slice(0, 60);
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${p.name} (MO2 ${n})`.slice(0, 60);
        pid = crypto.randomBytes(5).toString('hex');
        list[pid] = { id: pid, name, enabled: [], created: Date.now(), fromMo2: p.id };
        this.log.success(`Created profile "${name}" from the Mod Organizer 2 profile "${p.name}"`);
      }
      list[pid].enabled = order;
      list[pid].priorities = Object.fromEntries(Object.values(this.data.mods).map(m => [m.id, m.priority]));
      list[pid].importOrder = order;
      this.applyImportOrder(pid);
      this.library.save();
      return pid;
    });
    await this.switchProfile(id);
    return { id, name: this.data.profiles.list[id].name, enabled: order.length, moved: r.adopted.filter(o => !o.matched).length, failed: r.failed, skipped: r.skipped };
  }

  /** Notice MO2 changes (a profile edited, a mod added) while this app is open. */
  startMo2Watch() {
    this.mo2.discover().catch(() => {}).finally(() => this.emit('changed'));
    let last = '';
    const tick = () => {
      const d = this.mo2.read();
      const now = `${this.mo2.sig}|${d.instances.length}`;
      if (now !== last) { last = now; this.emit('changed'); }
    };
    try { tick(); } catch { /* unreadable: tried again */ }
    this.mo2Timer = setInterval(() => { try { tick(); } catch { /* unreadable: tried again */ } }, 10000);
  }

  // ---------------------------------------------------------------- sharing profiles

  /**
   * A profile as a portable JSON document: the mods it enables (installed ones only), lowest
   * priority first, so an import reproduces who wins each file conflict. Local archives (not from
   * Nexus) are listed so the receiver knows they exist, but cannot be fetched for them.
   */
  exportProfile(id) {
    const p = this.data.profiles.list[id];
    if (!p) throw new Error('That profile no longer exists.');
    const mods = p.enabled.map(mid => this.data.mods[mid]).filter(Boolean).sort((a, b) => a.priority - b.priority);
    const at = new Map(mods.map((m, i) => [m.id, i]));
    // The archive load order set here (if any), for this profile's archives only.
    const own = new Set(mods.flatMap(m => m.files.map(f => /^archive\/pc\/mod\/([^/]+\.archive)$/i.exec(f)?.[1]?.toLowerCase()).filter(Boolean)));
    const order = (this.data.loadOrder || []).filter(n => own.has(n.toLowerCase())).slice(0, MAX_PROFILE_ARCHIVES);
    // Whose copy of a shared file loads (the conflict window's picks) among this profile's mods: by
    // their place in `mods`.
    const picks = [];
    for (const file of Object.keys(this.data.fileChoices || {})) {
      const pick = this.pickOf(file);
      if (!pick || !at.has(pick.id)) continue;
      const among = [...new Set([pick.id, ...pick.among])].filter(x => at.has(x)).map(x => at.get(x)).slice(0, 100);
      if (among.length > 1) picks.push({ file, mod: at.get(pick.id), among });
    }
    return {
      format: PROFILE_FORMAT,
      version: 1,
      name: p.name,
      game: 'cyberpunk2077',
      exportedAt: new Date().toISOString(),
      mods: mods.map(m => ({
        name: m.name,
        modName: m.modName,
        game: m.game,
        modId: Number(m.modId) || 0,
        fileId: Number(m.fileId) || 0,
        version: m.version || '',
        category: m.category,
        fomod: !!m.fomod,
        fomodChoices: m.fomodChoices || undefined,
        source: Number(m.modId) > 0 ? 'nexus' : 'local',
      })),
      loadOrder: order.length > 1 ? order : undefined,
      fileChoices: picks.length ? picks.slice(0, MAX_PROFILE_PICKS) : undefined,
    };
  }

  /**
   * Read a shared profile and work out, per mod, what importing it takes:
   *   installed  — the same file is installed here (it will be enabled)
   *   downloaded — the archive is here but not installed (it will be installed)
   *   download   — the exact file is on Nexus (it will be downloaded)
   *   newer      — that file is gone from Nexus; its newest replacement will be downloaded
   *   local      — a local archive on the sender's PC; it can't be fetched
   *   unavailable — not on Nexus any more, with no replacement
   */
  async planProfileImport(doc, { bundleDir = '' } = {}) {
    if (!doc || doc.format !== PROFILE_FORMAT || !Array.isArray(doc.mods)) {
      throw new Error('This file is not a profile from this app (Edgerunners Mod Manager, formerly Cyber Mod Manager).');
    }
    if (doc.version > 1) throw new Error('This profile was made by a newer version of the app: update it to read this one.');
    if (doc.mods.length > MAX_PROFILE_MODS) throw new Error(`This profile lists ${doc.mods.length} mods; the most a profile can hold is ${MAX_PROFILE_MODS}.`);
    const rows = [];
    const byMod = new Map();
    const seenFiles = new Set();
    const id = x => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0);
    for (const [order, raw] of doc.mods.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const m = {
        order, name: String(raw.name || raw.modName || '').slice(0, 200), modName: String(raw.modName || raw.name || '').slice(0, 200),
        game: 'cyberpunk2077', modId: id(raw.modId), fileId: id(raw.fileId),
        version: String(raw.version || '').slice(0, 40), fomod: !!raw.fomod,
        fomodChoices: validChoices(raw.fomodChoices),
      };
      if (m.fileId) { if (seenFiles.has(m.fileId)) continue; seenFiles.add(m.fileId); }
      if (raw.game && String(raw.game) !== 'cyberpunk2077') {
        rows.push({ ...m, status: 'unavailable', detail: `A ${String(raw.game).slice(0, 40)} mod, not Cyberpunk 2077` });
        continue;
      }
      // Installed here: under its file id, or a mod moved from Vortex whose file was looked up.
      const same = m.fileId && (this.data.mods[String(m.fileId)] || Object.values(this.data.mods).find(x => Number(x.fileId) === m.fileId));
      const key = same ? same.id : String(m.fileId);
      if (same) {
        rows.push({ ...m, status: 'installed', key, detail: 'Already installed' });
      } else if (m.fileId && this.data.downloads[key] && fs.existsSync(this.data.downloads[key].path)) {
        rows.push({ ...m, status: 'downloaded', key, detail: 'Downloaded — will be installed' });
      } else if (!m.modId || !m.fileId) {
        // In the zip it came in (only inside that folder), or already installed here under that name.
        const inZip = bundleDir && typeof raw.archive === 'string' ? path.resolve(bundleDir, raw.archive) : '';
        const here = Object.values(this.data.mods).find(x => !(Number(x.fileId) > 0) && x.name.toLowerCase() === m.name.toLowerCase());
        if (here) rows.push({ ...m, status: 'installed', key: here.id, detail: 'Already installed (from a local file)' });
        else if (inZip && inZip.startsWith(path.resolve(bundleDir) + path.sep) && fs.existsSync(inZip)) {
          const key = `local-${crypto.createHash('sha1').update(inZip).digest('hex').slice(0, 10)}`; // what importArchives names it
          rows.push({ ...m, status: 'bundled', archive: inZip, key, detail: 'In the zip: will be installed', size: fs.statSync(inZip).size });
        } else rows.push({ ...m, status: 'local', detail: 'A local file on the sender\'s PC: ask them for the profile as a zip' });
      } else {
        const row = { ...m, status: 'pending' };
        rows.push(row);
        if (!byMod.has(m.modId)) byMod.set(m.modId, []);
        byMod.get(m.modId).push(row);
      }
    }
    // One files.json request per Nexus mod, a few at a time.
    const work = [...byMod.values()];
    const worker = async () => {
      while (work.length) {
        const group = work.shift();
        try {
          const res = await this.nexus.getFiles(group[0].game, group[0].modId);
          const files = res.files || [];
          for (const row of group) {
            const exact = files.find(f => Number(f.file_id) === row.fileId);
            if (exact && !['DELETED', 'ARCHIVED'].includes(catOf(exact))) {
              Object.assign(row, { status: 'download', file: exact, size: exact.size_in_bytes || (exact.size_kb || 0) * 1024, detail: exact.file_name });
            } else {
              const newer = findUpdate(files, res.file_updates || [], row.fileId);
              if (newer) Object.assign(row, { status: 'newer', file: newer, size: newer.size_in_bytes || (newer.size_kb || 0) * 1024, detail: `That version is gone; will get ${newer.version ? `v${newer.version}` : newer.file_name}` });
              else Object.assign(row, { status: 'unavailable', detail: 'No longer on Nexus Mods' });
            }
          }
        } catch (err) {
          for (const row of group) Object.assign(row, { status: 'unavailable', detail: err.message });
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    for (const r of rows) {
      if (r.name) continue;
      const here = r.key && (this.data.mods[r.key] || this.data.downloads[r.key]);
      r.name = here?.name || r.file?.name || r.file?.file_name || (r.modId ? `Nexus mod ${r.modId}` : 'Mod');
      if (!r.version) r.version = here?.version || r.file?.version || '';
    }
    // Mods from the zip that carry program files (.dll, .asi, .exe): the review names them before anything installs.
    for (const r of rows.filter(x => x.status === 'bundled')) {
      try { r.programs = (await archiveTools.list(sevenZip(this.settings.get('sevenZipPath')), r.archive)).filter(f => /\.(dll|asi|exe)$/i.test(f)).slice(0, 20); } catch { r.programs = []; }
    }
    // The sender's archive load order and file picks, taken in with the profile.
    const loadOrderIn = validOrder(doc.loadOrder);
    const picks = validPicks(doc.fileChoices, doc.mods.length);
    const token = crypto.randomBytes(6).toString('hex');
    this.profileImports.set(token, { name: String(doc.name || 'Imported profile').slice(0, 60), rows, bundleDir, loadOrder: loadOrderIn, picks });
    // Older pending imports are dropped, with the folder their zip was unpacked into.
    while (this.profileImports.size > 3) this.cancelProfileImport(this.profileImports.keys().next().value);
    return {
      token,
      name: String(doc.name || 'Imported profile').slice(0, 60),
      // Mods the sender installed from local files: a code cannot carry them.
      localCount: Number(doc.localCount) > 0 ? Math.min(9999, Number(doc.localCount)) : 0,
      archives: loadOrderIn.length,
      picks: picks.length,
      mods: rows.map(r => ({ name: r.name, modName: r.modName, version: r.version, status: r.status, detail: r.detail || '', size: r.size || 0, fomod: r.fomod, choices: !!r.fomodChoices && r.status !== 'newer', programs: r.programs || undefined })),
    };
  }

  /**
   * Create the profile, switch to it, enable what is here, and download the rest. Downloads that
   * finish later install into that profile and take their place in its priority order.
   */
  applyProfileImport(token, name) {
    return this.op(async () => {
      const plan = this.profileImports.get(token);
      if (!plan) throw new Error('That import has expired. Open the file again.');
      const base = String(name || '').trim().slice(0, 54) || plan.name.slice(0, 54) || 'Imported profile';
      let clean = base;
      const taken = new Set(Object.values(this.data.profiles.list).map(p => p.name.toLowerCase()));
      for (let i = 2; taken.has(clean.toLowerCase()); i++) clean = `${base} (${i})`;

      const id = crypto.randomBytes(5).toString('hex');
      const order = plan.rows.map(r => r.key || (r.file ? String(r.file.file_id) : null)).filter(Boolean);
      const summary = { profile: id, name: clean, enabled: 0, installing: 0, downloading: 0, skipped: 0 };

      // Switch to the new profile (only its mods on), all or nothing.
      const savesFrom = this.settings.get('perProfileSaves') ? this.savesOwner() : '';
      if (savesFrom && await this.gameRunning()) throw new Error(GAME_RUNNING_SAVES);
      const before = Object.values(this.data.mods).map(m => [m, m.enabled, m.priority]);
      const orderBefore = this.data.loadOrder ? [...this.data.loadOrder] : null;
      // modlist.txt itself too: a deploy that wrote the new order and then failed leaves it behind.
      const listFile = isGameDir(this.gameDir()) ? loadOrder.modlistFile(this.gameDir()) : '';
      let listBefore = null;
      try { listBefore = listFile ? fs.readFileSync(listFile) : null; } catch { /* none */ }
      const picksBefore = JSON.parse(JSON.stringify(this.data.fileChoices || {}));
      const prevActive = this.data.profiles.active;
      this.syncActiveProfile(); // the profile being left keeps its exact state
      this.data.profiles.list[id] = { id, name: clean, enabled: [], priorities: {}, created: Date.now(), importOrder: order };
      let swapped = false;
      try {
        // Per-profile saves: the new profile starts with no saves (the page offers a copy).
        if (savesFrom) swapped = !!(await this.swapSavesTo(id));
        for (const m of Object.values(this.data.mods)) m.enabled = false;
        this.data.profiles.active = id;
        for (const r of plan.rows) {
          const mod = r.status === 'installed' && this.data.mods[r.key];
          if (mod) { mod.enabled = true; summary.enabled++; }
        }
        this.data.profiles.list[id].priorities = Object.fromEntries(Object.values(this.data.mods).map(m => [m.id, m.priority]));
        this.applyImportOrder(id);
        this.applyProfilePriorities(this.data.profiles.list[id]);
        this.takeImportExtras(plan);
        this.deploy();
      } catch (err) {
        for (const [m, en, prio] of before) { m.enabled = en; m.priority = prio; }
        if (orderBefore) this.data.loadOrder = orderBefore; else delete this.data.loadOrder;
        try { if (listFile) { if (listBefore) fs.writeFileSync(listFile, listBefore); else loadOrder.resetOrder(this.gameDir()); } } catch { /* the folder is unusable: the deploy below says so */ }
        this.data.fileChoices = picksBefore;
        this.data.profiles.active = prevActive;
        const savesBack = !swapped || await this.swapSavesTo(savesFrom).then(() => true, e => { this.log.error('Could not put the saves back after the failed import (they are in the backup made before it)', e.message); return false; });
        // The new profile stays while the game's saves are recorded as its own (switching to the old profile brings them back).
        if (savesBack) delete this.data.profiles.list[id];
        try { this.deploy(); } catch { /* the folder itself is unusable; data is restored either way */ }
        this.library.save();
        throw err;
      }
      this.profileImports.delete(token);

      const installRows = plan.rows.filter(r => r.status === 'downloaded');
      const toInstall = installRows.map(r => r.key);
      const presets = Object.fromEntries(installRows.filter(r => r.fomodChoices).map(r => [r.key, r.fomodChoices]));
      const q = { mods: 0, queued: 0, skipped: 0, errors: [] };
      for (const r of plan.rows.filter(x => x.status === 'download' || x.status === 'newer')) {
        // The sender's installer choices only fit the exact same file.
        const choices = r.status === 'download' ? r.fomodChoices : null;
        this.queueFiles({ game: r.game, modId: r.modId, name: r.modName || r.name, author: '' }, [r.file], '', q, { forProfiles: [id], ...(choices ? { fomodChoices: choices } : {}) });
      }
      summary.downloading = q.queued;
      summary.skipped = plan.rows.filter(r => r.status === 'local' || r.status === 'unavailable').length;
      const bundled = plan.rows.filter(r => r.status === 'bundled');
      this.library.save();
      this.log.success(`Imported profile "${clean}": ${summary.enabled} enabled, ${toInstall.length} to install, ${summary.downloading} downloading${summary.skipped ? `, ${summary.skipped} unavailable` : ''}`);
      // Installing goes through the normal queue (FOMOD wizards included) after this operation.
      if (toInstall.length) setImmediate(() => this.install(toInstall, { forProfiles: [id], fomodChoices: presets }).catch(() => {}));
      // Mods from local files that came in the zip: into the downloads, then installed into this profile.
      if (bundled.length || plan.bundleDir) {
        setImmediate(async () => {
          try {
            if (bundled.length) {
              const keys = await this.importArchives(bundled.map(r => r.archive));
              // The sender's names and versions, not the packed file names ("002-Name.zip").
              keys.forEach((k, i) => { const rec = this.data.downloads[k]; if (rec) Object.assign(rec, { name: bundled[i].name, modName: bundled[i].modName || bundled[i].name, version: bundled[i].version || rec.version }); });
              // The sender's installer choices, for archives with an installer (FOMOD).
              const choices = Object.fromEntries(keys.map((k, i) => [k, bundled[i].fomodChoices]).filter(([, c]) => c));
              await this.install(keys, { forProfiles: [id], fomodChoices: choices });
            }
          } catch (err) {
            this.log.error('Could not install the mods from the profile zip', err.message);
          } finally {
            if (plan.bundleDir) fs.rmSync(plan.bundleDir, { recursive: true, force: true });
          }
        });
      }
      summary.installing = toInstall.length + bundled.length;
      return summary;
    });
  }

  /**
   * A shared profile's archive load order and file picks, made this app's own: the sender's
   * archives go in their order (in the one load order every profile here shares), and their picks
   * name the mods by the key each has or will have here. Mods still downloading count: their
   * archives and picks take effect when they arrive. Picks are shared by every profile too, so a
   * file the user already chose for keeps their choice.
   */
  takeImportExtras(plan) {
    const keyOf = r => r?.key || (r?.file ? String(r.file.file_id) : null);
    const byOrder = new Map(plan.rows.map(r => [r.order, r]));
    if (plan.loadOrder?.length) {
      const game = this.gameDir();
      const base = this.data.loadOrder?.length ? this.data.loadOrder : (isGameDir(game) ? loadOrder.currentOrder(game).order : []);
      this.data.loadOrder = loadOrder.adoptOrder(base, plan.loadOrder);
    }
    for (const p of plan.picks || []) {
      const id = keyOf(byOrder.get(p.mod));
      const among = [...new Set(p.among.map(i => keyOf(byOrder.get(i))).filter(Boolean))];
      if (!id || among.length < 2 || Object.hasOwn(this.data.mods, this.pickOf(p.file)?.id ?? '')) continue; // the user's own pick (of a mod still here) stays
      (this.data.fileChoices ||= {})[p.file] = { id, among };
    }
  }

  cancelProfileImport(token) {
    const plan = this.profileImports.get(token);
    if (plan?.bundleDir) fs.rmSync(plan.bundleDir, { recursive: true, force: true });
    this.profileImports.delete(token);
  }

  /**
   * A profile as one .zip anyone can drop into the app: profile.json (the profile, with where each
   * local mod is in the zip), share-code.txt (the code, for pasting), and local/… — every mod of the
   * profile that is not on Nexus: its original archive, or (if that is gone) the files it installed.
   */
  async exportProfileZip(id, outFile) {
    // Counted while it runs: an update restart waits for it (see the updater's isBusy).
    this.exporting = (this.exporting || 0) + 1;
    try { return await this.writeProfileZip(id, outFile); } finally { this.exporting--; }
  }

  async writeProfileZip(id, outFile) {
    await this.resolveProfileFiles(id);
    const doc = this.exportProfile(id);
    const p = this.data.profiles.list[id];
    const mods = p.enabled.map(mid => this.data.mods[mid]).filter(Boolean).sort((a, b) => a.priority - b.priority);
    const tmp = path.join(this.settings.tempDir, `export-${crypto.randomBytes(4).toString('hex')}`);
    const seven = sevenZip(this.settings.get('sevenZipPath'));
    let local = 0;
    const risky = []; // packed mods with program files: { mod, files }
    try {
      fs.mkdirSync(path.join(tmp, 'local'), { recursive: true });
      for (const [i, m] of mods.entries()) {
        const entry = doc.mods[i];
        if (entry.source !== 'local' && entry.fileId) continue;
        const safe = `${String(i + 1).padStart(3, '0')}-${String(m.name).replace(/\.(zip|7z|rar)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').slice(0, 60) || 'mod'}`;
        const rec = this.data.downloads[m.id];
        let rel;
        if (rec?.path && fs.existsSync(rec.path)) {
          rel = `local/${safe}${path.extname(rec.path).toLowerCase() || '.zip'}`;
          try { fs.linkSync(rec.path, path.join(tmp, rel)); } catch { fs.copyFileSync(rec.path, path.join(tmp, rel)); }
        } else {
          // The archive is gone: pack what the mod installed, laid out as in the game folder.
          const staged = path.join(this.settings.stagingDir, m.id);
          if (!fs.existsSync(staged)) continue;
          rel = `local/${safe}.zip`;
          await archiveTools.pack(seven, staged, path.join(tmp, rel));
          // The files the installer already chose: there is nothing to choose again.
          entry.fomodChoices = undefined;
          entry.fomod = false;
        }
        // An original archive keeps the sender's installer choices: the receiver's installer starts with them.
        entry.archive = rel;
        local++;
        // Program files (.dll, .asi, .exe) are what browsers and virus scanners flag: say which.
        try {
          const programs = (await archiveTools.list(seven, path.join(tmp, rel))).filter(f => /\.(dll|asi|exe)$/i.test(f));
          if (programs.length) risky.push({ mod: m.name, files: programs.slice(0, 20) });
        } catch { /* not listable: no warning to give */ }
      }
      fs.writeFileSync(path.join(tmp, 'profile.json'), JSON.stringify(doc, null, 2));
      fs.writeFileSync(path.join(tmp, 'share-code.txt'), [
        `Edgerunners Mod Manager profile "${doc.name}"`,
        '',
        'Drag this .zip onto Edgerunners Mod Manager (or Profiles → Import) to set the profile up, with the mods',
        'from local files that are inside it. The code below sets up only its Nexus mods:',
        '',
        profileCode.encode(doc),
        '',
      ].join('\r\n'));
      await archiveTools.pack(seven, tmp, outFile);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    this.log.success(`Exported profile "${doc.name}" (${doc.mods.length} mods, ${local} from local files packed) to ${outFile}`);
    return { file: outFile, count: doc.mods.length, local, risky };
  }

  /**
   * A dropped or opened .zip: if it is a profile made by Export as zip, plan its import (the local
   * mods inside it install from the zip). Returns null for any other zip (a mod archive).
   */
  async planProfileZip(file) {
    const seven = sevenZip(this.settings.get('sevenZipPath'));
    const dir = path.join(this.settings.tempDir, `profile-${crypto.randomBytes(4).toString('hex')}`);
    this.exporting = (this.exporting || 0) + 1;
    try {
      await archiveTools.extractSome(seven, file, dir, ['profile.json']);
      let doc = null;
      try { doc = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { /* not a profile zip */ }
      if (!doc || doc.format !== PROFILE_FORMAT) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
      await archiveTools.extract(seven, file, dir);
      return await this.planProfileImport(doc, { bundleDir: dir });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true }); // nothing unpacked is left behind
      throw err;
    } finally {
      this.exporting--;
    }
  }

  /**
   * Add an installed mod to the imported profiles waiting for it. Returns the active profile if it is
   * one of them (the caller enables the mod and deploys), else null.
   */
  joinProfiles(mod, profileIds) {
    let active = null;
    for (const pid of new Set(profileIds || [])) {
      const p = this.data.profiles.list[pid];
      if (!p) continue;
      if (!p.enabled.includes(mod.id)) p.enabled.push(mod.id);
      p.priorities = { ...(p.priorities || {}), [mod.id]: p.priorities?.[mod.id] ?? mod.priority };
      this.applyImportOrder(pid);
      if (this.data.profiles.active === pid) active = p;
    }
    return active;
  }

  /** Give an imported profile's mods the sender's relative priority order (in that profile). */
  applyImportOrder(profileId) {
    const p = this.data.profiles.list[profileId];
    if (!p?.importOrder) return;
    p.priorities ||= {};
    const ids = p.importOrder.filter(k => this.data.mods[k]);
    const prio = id => p.priorities[id] ?? this.data.mods[id].priority;
    const slots = ids.map(prio).sort((a, b) => a - b);
    ids.forEach((id, i) => { p.priorities[id] = slots[i]; });
    // Every mod of the import is here: the order is final, and later changes are the user's own.
    if (ids.length === p.importOrder.length) delete p.importOrder;
  }

  // ---------------------------------------------------------------- enabling / removing

  /**
   * Settings name another game folder than the one this app placed mods in: take this app's files
   * out of the old folder first (its originals put back), or, when the old folder is gone (moved,
   * renamed, a drive not connected), forget that record, so mods can go into the new one.
   */
  followGameFolder() {
    const was = this.deployer.store.data.gameDir;
    const now = this.settings.get('gamePath');
    if (!was || !Object.keys(this.deployer.deployed).length || !isGameDir(now) || path.resolve(was) === path.resolve(now)) return;
    if (isGameDir(was)) {
      const res = this.deployer.sync(was, [], this.settings.get('deployMethod'));
      if (res.errors.length) throw new Error(`Could not take this app's mods out of the previous game folder, ${was} (is the game running?). Close the game and try again.`);
      this.log.info(`The game folder changed: this app's mods were taken out of ${was} (${res.removed} files${res.restored ? `, ${res.restored} originals put back` : ''})`);
    } else {
      this.deployer.store.data.deployed = {};
      this.deployer.store.data.createdDirs = [];
      this.deployer.store.data.gameDir = '';
      this.deployer.store.save();
      this.log.warn(`The game folder this app placed mods in (${was}) is no longer there. Its record is cleared and mods go into ${now} now. Originals it had backed up stay in ${this.deployer.backupDir}.`);
    }
  }

  deploy() {
    this.followGameFolder();
    const game = this.gameDir();
    const enabled = Object.values(this.data.mods).filter(m => m.enabled).sort((a, b) => a.priority - b.priority);
    if (!isGameDir(game)) {
      if (enabled.length || Object.keys(this.deployer.deployed).length) {
        throw new Error('Cyberpunk 2077 folder not set or not found. Set it on the Settings page.');
      }
      return null;
    }
    // A shared file goes in from one mod only: the one picked for it, else the highest priority.
    const providers = providersOf(enabled);
    const placed = m => m.files.filter(f => { const k = f.toLowerCase(); const list = providers.get(k); return list.length < 2 || this.fileWinner(k, list) === m.id; });
    const res = this.deployer.sync(game, enabled.map(m => ({
      id: m.id, stagingDir: path.join(this.settings.stagingDir, m.id), files: placed(m),
    })), this.settings.get('deployMethod'));
    if (this.data.loadOrder?.length) {
      try { this.data.loadOrder = loadOrder.keepAbsent(this.data.loadOrder, loadOrder.writeOrder(game, this.data.loadOrder)); } catch (err) { this.log.warn('Could not update the archive load order', err.message); }
    }
    this.syncActiveProfile();
    this.library.save();
    if (res.added || res.removed) this.log.info(`Deployment: ${res.added} file(s) placed, ${res.removed} removed${res.restored ? `, ${res.restored} original(s) restored` : ''}`);
    if (res.errors.length) this.log.error(`${res.errors.length} file(s) could not be deployed (is the game running?)`);
    return res;
  }

  setEnabled(ids, enabled) {
    const vx = ids.filter(id => String(id).startsWith('vx:'));
    const ours = ids.filter(id => !String(id).startsWith('vx:'));
    const vortexDone = vx.length ? this.setVortexEnabled(vx, enabled) : Promise.resolve();
    if (!ours.length) return vortexDone;
    return Promise.all([vortexDone, this.setOwnEnabled(ours, enabled)]);
  }

  /**
   * Use another installed version of a mod: `onId` is enabled and `offIds` (the other versions)
   * disabled, in one step (for Vortex mods, one change to Vortex).
   */
  async switchVersion(offIds, onId) {
    if (String(onId).startsWith('vx:')) {
      const all = this.vortex.read().mods || [];
      const changes = [
        ...offIds.map(id => all.find(m => m.id === id)).filter(m => m?.enabled).map(m => ({ vortexId: m.vortexId, enabled: false })),
        ...[all.find(m => m.id === onId)].filter(m => m && !m.enabled).map(m => ({ vortexId: m.vortexId, enabled: true })),
      ];
      if (!changes.length) return;
      await this.vortex.apply(changes);
      this.emit('changed');
      return;
    }
    // Off first, so the new version's files are not left behind the old one's.
    await this.setOwnEnabled(offIds, false);
    await this.setOwnEnabled([onId], true);
  }

  /** Vortex mods: their state is set through Vortex, their files are placed here (see vortex.js). */
  async setVortexEnabled(ids, enabled) {
    const all = this.vortex.read().mods || [];
    const changes = ids.map(id => all.find(m => m.id === id)).filter(m => m && m.enabled !== enabled).map(m => ({ vortexId: m.vortexId, enabled }));
    if (!changes.length) return;
    await this.vortex.apply(changes);
    this.noteVortexToggles(changes);
    this.emit('changed');
  }

  /** Vortex keeps no such times: switches made from here are remembered here. */
  noteVortexToggles(changes) {
    this.data.vortexToggled ||= {};
    const now = Date.now();
    for (const c of changes) {
      const t = (this.data.vortexToggled[c.vortexId] ||= {});
      t[c.enabled ? 'enabledAt' : 'disabledAt'] = now;
    }
    this.library.save();
  }

  setOwnEnabled(ids, enabled) {
    return this.op(async () => {
      const changed = ids.map(id => this.data.mods[id]).filter(m => m && m.enabled !== enabled);
      const now = Date.now();
      for (const m of changed) { m.enabled = enabled; m[enabled ? 'enabledAt' : 'disabledAt'] = now; }
      if (enabled && changed.length) await this.switchOffVortexTwins(changed.map(m => m.id)).catch(err => this.log.warn("Could not switch off Vortex's copy", err.message));
      try {
        this.deploy();
      } catch (err) {
        for (const m of changed) m.enabled = !enabled;
        this.library.save();
        throw err;
      }
      if (changed.length) this.log.success(`${enabled ? 'Enabled' : 'Disabled'} ${nameList(changed)}`, changed.length > 6 ? changed.map(m => m.name).join('\n') : undefined);
    }).then(() => (enabled ? this.switchOffVortexTwins(ids).catch(err => this.log.warn("Could not switch off Vortex's copy", err.message)) : null));
  }

  prioritize(ids) {
    return this.op(async () => {
      for (const id of ids) if (this.data.mods[id]) this.data.mods[id].priority = this.data.nextPriority++;
      // "Make this mod win": all of its files, so picks of another mod's copy for them go.
      for (const id of ids) for (const f of this.data.mods[id]?.files || []) {
        const k = f.toLowerCase();
        if (this.pickOf(k) && this.pickOf(k).id !== id) delete this.data.fileChoices[k];
      }
      this.deploy();
      this.log.info(`${ids.length} mod(s) now win their file conflicts`);
    });
  }

  /** Disable, take out of the game and delete the staged files. Keeps the downloaded archive. */
  uninstall(ids) {
    return this.op(async () => this.uninstallNow(ids));
  }

  uninstallNow(ids) {
    const mods = ids.map(id => this.data.mods[id]).filter(Boolean);
    for (const m of mods) m.enabled = false;
    const res = this.deploy();
    const stuck = res?.errors?.length ? ` (${plural(res.errors.length, 'file')} could not be taken out of the game: is it running? They go on the next change.)` : '';
    for (const m of mods) {
      fs.rmSync(path.join(this.settings.stagingDir, m.id), { recursive: true, force: true });
      delete this.data.mods[m.id];
      // A mod moved from Vortex: Vortex lists its own copy again.
      for (const [vid, own] of Object.entries(this.data.vortexAdopted || {})) if (own === m.id) delete this.data.vortexAdopted[vid];
      // Its picks in the conflict window go with it.
      for (const [file, pick] of Object.entries(this.data.fileChoices || {})) if (pick?.id === m.id) delete this.data.fileChoices[file];
      this.log.success(`Uninstalled ${m.name}${stuck}`);
    }
    this.library.save();
  }

  /** Uninstall (if installed) and delete the downloaded archives. */
  deleteDownloads(keys) {
    return this.op(async () => {
      const installed = Object.values(this.data.mods).filter(m => keys.includes(m.key)).map(m => m.id);
      if (installed.length) this.uninstallNow(installed);
      for (const key of keys) {
        const rec = this.data.downloads[key];
        if (!rec) continue;
        fs.rmSync(rec.path, { force: true });
        removeEmptyParents(path.dirname(rec.path), this.settings.downloadsDir);
        delete this.data.downloads[key];
        this.log.success(`Deleted ${rec.fileName}`);
      }
      this.library.save();
    });
  }

  reinstall(ids) {
    const keys = ids.map(id => this.data.mods[id]?.key).filter(Boolean);
    return this.install(keys);
  }

  redeploy() {
    return this.op(async () => this.deploy());
  }

  purge() {
    return this.op(async () => {
      for (const m of Object.values(this.data.mods)) m.enabled = false;
      this.deploy();
      this.log.success('All mods removed from the game folder');
    });
  }
}

/** Files that make up a mod's current release: the primary main file, else all main files, else the newest file. */
function pickMainFiles(files, catOf) {
  const current = files.filter(f => !['OLD_VERSION', 'ARCHIVED', 'DELETED'].includes(catOf(f)));
  const main = current.filter(f => catOf(f) === 'MAIN');
  if (main.length) {
    const primary = main.filter(f => f.is_primary);
    return primary.length ? primary : main;
  }
  const newest = [...current].sort((a, b) => (b.uploaded_timestamp ?? b.uploaded ?? 0) - (a.uploaded_timestamp ?? a.uploaded ?? 0))[0];
  return newest ? [newest] : [];
}

/** The frameworks a mod's files show it needs, by Nexus mod id. */
const FRAMEWORK_NAMES = { 107: 'Cyber Engine Tweaks', 1511: 'redscript', 2380: 'RED4ext', 4197: 'TweakXL', 4198: 'ArchiveXL' };
/** Names authors give frameworks in off-site requirements ("CET (No REDMOD version)"), by name key. */
const FRAMEWORK_ALIASES = new Map([['cet', 107], ['cyber engine tweaks', 107], ['redscript', 1511], ['red4ext', 2380], ['tweakxl', 4197], ['archivexl', 4198], ['codeware', 7780]]);
/** A requirement's name for matching: no notes in brackets, no versions, lower-case letters and digits. */
const reqKeys = new Map(); // names repeat on every snapshot: each worked out once
function reqNameKey(s) {
  const name = String(s || '');
  let key = reqKeys.get(name);
  if (key === undefined) {
    key = name.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\bv?\d+(\.\d+)+\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
    if (reqKeys.size > 5000) reqKeys.clear();
    reqKeys.set(name, key);
  }
  return key;
}

/**
 * What a mod's files show it needs: redscript scripts (.reds) need redscript, ArchiveXL files (.xl)
 * ArchiveXL, TweakXL tweaks (r6/tweaks) TweakXL, CET mods (cyber_engine_tweaks/mods) CET, and
 * RED4ext plugins RED4ext. A framework never needs itself (its own marker file is among its files).
 */
function inferRequirements(files) {
  const need = new Set();
  const own = new Set();
  for (const raw of files || []) {
    const f = String(raw).replace(/\\/g, '/').toLowerCase();
    if (f.endsWith('.reds')) need.add(1511);
    else if (f.startsWith('archive/pc/mod/') && f.endsWith('.xl')) need.add(4198);
    else if (f.startsWith('r6/tweaks/') && /\.(ya?ml|tweak)$/.test(f)) need.add(4197);
    if (f.startsWith('bin/x64/plugins/cyber_engine_tweaks/mods/')) need.add(107);
    if (f.startsWith('red4ext/plugins/')) need.add(2380);
    for (const [id, marker] of Object.entries(FRAMEWORK_MARKERS)) if (f === marker.toLowerCase()) own.add(Number(id));
  }
  // RED4ext's plugins of the frameworks themselves still need RED4ext; a framework does not need itself.
  for (const id of own) need.delete(id);
  return [...need];
}

/** Marker files of the common frameworks, by Nexus mod id. */
const FRAMEWORK_MARKERS = {
  107: 'bin/x64/plugins/cyber_engine_tweaks.asi', // Cyber Engine Tweaks
  1511: 'engine/tools/scc.exe', // redscript
  2380: 'red4ext/RED4ext.dll', // RED4ext
  4197: 'red4ext/plugins/TweakXL/TweakXL.dll', // TweakXL
  4198: 'red4ext/plugins/ArchiveXL/ArchiveXL.dll', // ArchiveXL
  4575: 'red4ext/plugins/input_loader/input_loader.dll', // Input Loader
  7780: 'red4ext/plugins/Codeware/Codeware.dll', // Codeware
  12001: 'red4ext/plugins/audioware/audioware.dll', // Audioware
};
const MOD_FOLDERS = ['red4ext/plugins', 'bin/x64/plugins/cyber_engine_tweaks/mods', 'r6/scripts', 'r6/tweaks', 'mods'];
const squash = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Is a required mod already in the game folder, put there by something else (Vortex, by hand)?
 * Checks known framework files first, then a mod folder whose name matches the mod's name.
 * Returns the matching relative path, or ''.
 */
function foundInGame(gameDir, req) {
  if (!gameDir || !isGameDir(gameDir)) return '';
  const where = caseResolver(gameDir); // Linux: the game finds files whatever their case; so does this
  const marker = FRAMEWORK_MARKERS[req.modId];
  if (marker) return where.exists(marker) ? marker : '';
  const want = squash(req.modName);
  if (want.length < 4) return '';
  for (const rel of MOD_FOLDERS) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(gameDir, where.resolve(rel, false))); } catch { continue; }
    const hit = entries.find(e => squash(e) === want);
    if (hit) return `${rel}/${hit}`;
  }
  return '';
}

function removeEmptyParents(dir, stopAt) {
  const stop = path.resolve(stopAt);
  let cur = path.resolve(dir);
  while (cur.startsWith(stop) && cur !== stop) {
    try {
      if (fs.readdirSync(cur).length) return;
      fs.rmdirSync(cur);
    } catch { return; }
    cur = path.dirname(cur);
  }
}

module.exports = { ModManager, pickMainFiles, foundInGame, matchNexusFile, sevenZip };
