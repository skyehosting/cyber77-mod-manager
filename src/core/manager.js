'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { JsonStore } = require('./jsonStore');
const { NexusClient, parseModUrl, parseNxm } = require('./nexus');
const { Downloader } = require('./downloader');
const { Installer, isSafeRel } = require('./installer');
const { Deployer } = require('./deployer');
const { isGameDir } = require('./gameFinder');
const { sanitizeName } = require('./layout');
const { ownerRoot } = require('./gameLogs');
const { findUpdate } = require('./updates');
const { VortexBridge, parseFolderName } = require('./vortex');
const { listFiles } = require('./vortexDeploy');
const loadOrder = require('./loadOrder');

const PROFILE_FORMAT = 'cyber-mod-manager-profile';
const profileCode = require('./profileCode');
const MAX_PROFILE_MODS = 1000;

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
/** The parts of a Nexus file record the UI shows. */
/** Nexus descriptions are BBCode/HTML: keep the words only. */
const plainText = t => String(t || '').replace(/<br\s*\/?>/gi, '\n').replace(/\[\/?[a-z0-9=#*"' -]+\]/gi, '').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
function sevenZip(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const bundled = process.resourcesPath ? path.join(process.resourcesPath, '7zip', '7z.exe') : '';
  return bundled && fs.existsSync(bundled) ? bundled : configured;
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
    this.nexus = new NexusClient(() => settings.apiKey, log);
    this.downloader = new Downloader(this.nexus, log, () => settings.get('concurrentDownloads'));
    // The 7-Zip set in Settings, else the copy that ships with the installed app.
    this.installer = new Installer({ getSevenZip: () => sevenZip(settings.get('sevenZipPath')), tempDir: () => settings.tempDir, log });
    this.deployer = new Deployer({ manifestFile: path.join(dataDir, 'deployment.json'), backupDir: settings.backupDir, log });
    this.pendingFomod = new Map();
    this.plans = new Map();
    this.profileImports = new Map();
    this.ensureProfiles();
    // CMM_VORTEX_APPDATA points tests (and the screenshot harness) away from the real Vortex.
    this.vortex = new VortexBridge({ getGameDir: () => this.gameDir(), log, appData: process.env.CMM_VORTEX_APPDATA ?? process.env.APPDATA });
    this.vortex.on('changed', () => this.emit('changed'));
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

  // ---------------------------------------------------------------- snapshot for the UI

  snapshot() {
    const mods = Object.values(this.data.mods).sort((a, b) => b.priority - a.priority);
    const enabled = mods.filter(m => m.enabled).sort((a, b) => a.priority - b.priority);
    const providers = new Map();
    for (const m of enabled) for (const f of m.files) {
      const k = f.toLowerCase();
      if (!providers.has(k)) providers.set(k, []);
      providers.get(k).push(m.id);
    }
    const conflicts = {};
    for (const list of providers.values()) {
      if (list.length < 2) continue;
      const winner = list[list.length - 1];
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
      vortex: this.vortexView(),
    };
  }

  /**
   * File conflicts between this mod and every other enabled mod: for each other mod, the shared
   * files and which mod's copy is in the game. The higher priority wins.
   */
  conflictDetails(id) {
    const mod = this.data.mods[id];
    if (!mod) return [];
    const mine = new Set(mod.files.map(f => f.toLowerCase()));
    const out = [];
    for (const other of Object.values(this.data.mods)) {
      if (other.id === id || !other.enabled) continue;
      const shared = other.files.filter(f => mine.has(f.toLowerCase()));
      if (!shared.length) continue;
      const weWin = mod.priority > other.priority;
      out.push({ id: other.id, name: other.name, priority: other.priority, weWin, files: shared.sort() });
    }
    return out.sort((a, b) => b.files.length - a.files.length);
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
        const dest = path.join(this.settings.downloadsDir, 'local', path.basename(p));
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
        // Forget the broken entries so the next sync places the files again.
        const broken = m.files.map(f => f.toLowerCase()).filter(k => {
          const e = this.deployer.deployed[k];
          return e && e.owner === id && this.deployer.fileState(game, e) !== 'ok';
        });
        for (const k of broken) delete this.deployer.deployed[k];
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
    this.data.updates = found;
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
    const mods = (data.mods || []).filter(m => !adopted[m.vortexId] && (ids === 'all' || ids.includes(m.id)));
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
      for (const v of ordered) {
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
      }
      this.library.save();
      // 3. This app places their files (the enabled ones) where Vortex's were.
      this.deploy();
      this.log.success(`Took over ${plural(out.length, 'mod')} from Vortex (${out.filter(o => this.data.mods[o.id]?.enabled).length} enabled). Vortex keeps them, switched off.`);
      this.emit('changed');
      return { adopted: out };
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
    this.data.loadOrder = loadOrder.writeOrder(game, Array.isArray(order) ? order.map(String) : []);
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
    this.data.loadOrder = loadOrder.writeOrder(game, sorted);
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
    };
    tick();
    this.vortexTimer = setInterval(() => tick().catch(() => {}), 5000);
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
        return { id: p.id, name: p.name, created: p.created || 0, count: p.enabled.filter(id => this.data.mods[id]).length, codeTag: tag };
      }),
    };
  }

  /** The profile as a share code, made from its mods as they are now. */
  profileCode(id) {
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
      const p = this.data.profiles.list[id];
      if (!p) throw new Error('That profile no longer exists.');
      const want = new Set(p.enabled);
      const before = Object.values(this.data.mods).map(m => [m, m.enabled, m.priority]);
      for (const m of Object.values(this.data.mods)) m.enabled = want.has(m.id);
      this.applyProfilePriorities(p);
      const prevActive = this.data.profiles.active;
      this.data.profiles.active = id;
      try {
        this.deploy();
      } catch (err) {
        for (const [m, en, prio] of before) { m.enabled = en; m.priority = prio; }
        this.data.profiles.active = prevActive;
        this.library.save();
        throw err;
      }
      this.log.success(`Switched to profile "${p.name}" (${plural(want.size, 'mod')} enabled)`);
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
      const p = this.data.profiles.list[id];
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
      if (!list[id]) return;
      if (Object.keys(list).length === 1) throw new Error('You need at least one profile.');
      if (this.data.profiles.active === id) throw new Error('Switch to another profile before deleting this one.');
      const name = list[id].name;
      delete list[id];
      this.library.save();
      this.log.success(`Deleted profile "${name}"`);
    });
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
  async planProfileImport(doc) {
    if (!doc || doc.format !== PROFILE_FORMAT || !Array.isArray(doc.mods)) {
      throw new Error('This file is not a Cyber Mod Manager profile.');
    }
    if (doc.version > 1) throw new Error('This profile was made by a newer version of Cyber Mod Manager.');
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
      const key = String(m.fileId);
      if (m.fileId && this.data.mods[key]) {
        rows.push({ ...m, status: 'installed', key, detail: 'Already installed' });
      } else if (m.fileId && this.data.downloads[key] && fs.existsSync(this.data.downloads[key].path)) {
        rows.push({ ...m, status: 'downloaded', key, detail: 'Downloaded — will be installed' });
      } else if (!m.modId || !m.fileId) {
        rows.push({ ...m, status: 'local', detail: 'A local file on the sender\'s PC — ask them for it' });
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
    const token = crypto.randomBytes(6).toString('hex');
    this.profileImports.set(token, { name: String(doc.name || 'Imported profile').slice(0, 60), rows });
    while (this.profileImports.size > 3) this.profileImports.delete(this.profileImports.keys().next().value);
    return {
      token,
      name: String(doc.name || 'Imported profile').slice(0, 60),
      // Mods the sender installed from local files: a code cannot carry them.
      localCount: Number(doc.localCount) > 0 ? Math.min(9999, Number(doc.localCount)) : 0,
      mods: rows.map(r => ({ name: r.name, modName: r.modName, version: r.version, status: r.status, detail: r.detail || '', size: r.size || 0, fomod: r.fomod, choices: !!r.fomodChoices && r.status !== 'newer' })),
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
      const before = Object.values(this.data.mods).map(m => [m, m.enabled, m.priority]);
      const prevActive = this.data.profiles.active;
      this.syncActiveProfile(); // the profile being left keeps its exact state
      this.data.profiles.list[id] = { id, name: clean, enabled: [], priorities: {}, created: Date.now(), importOrder: order };
      try {
        for (const m of Object.values(this.data.mods)) m.enabled = false;
        this.data.profiles.active = id;
        for (const r of plan.rows) {
          const mod = r.status === 'installed' && this.data.mods[r.key];
          if (mod) { mod.enabled = true; summary.enabled++; }
        }
        this.data.profiles.list[id].priorities = Object.fromEntries(Object.values(this.data.mods).map(m => [m.id, m.priority]));
        this.applyImportOrder(id);
        this.applyProfilePriorities(this.data.profiles.list[id]);
        this.deploy();
      } catch (err) {
        for (const [m, en, prio] of before) { m.enabled = en; m.priority = prio; }
        this.data.profiles.active = prevActive;
        delete this.data.profiles.list[id];
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
      this.library.save();
      this.log.success(`Imported profile "${clean}": ${summary.enabled} enabled, ${toInstall.length} to install, ${summary.downloading} downloading${summary.skipped ? `, ${summary.skipped} unavailable` : ''}`);
      // Installing goes through the normal queue (FOMOD wizards included) after this operation.
      if (toInstall.length) setImmediate(() => this.install(toInstall, { forProfiles: [id], fomodChoices: presets }).catch(() => {}));
      summary.installing = toInstall.length;
      return summary;
    });
  }

  cancelProfileImport(token) { this.profileImports.delete(token); }

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

  deploy() {
    const game = this.gameDir();
    const enabled = Object.values(this.data.mods).filter(m => m.enabled).sort((a, b) => a.priority - b.priority);
    if (!isGameDir(game)) {
      if (enabled.length || Object.keys(this.deployer.deployed).length) {
        throw new Error('Cyberpunk 2077 folder not set or not found. Set it on the Settings page.');
      }
      return null;
    }
    const res = this.deployer.sync(game, enabled.map(m => ({
      id: m.id, stagingDir: path.join(this.settings.stagingDir, m.id), files: m.files,
    })), this.settings.get('deployMethod'));
    if (this.data.loadOrder?.length) {
      try { this.data.loadOrder = loadOrder.writeOrder(game, this.data.loadOrder); } catch (err) { this.log.warn('Could not update the archive load order', err.message); }
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
    this.deploy();
    for (const m of mods) {
      fs.rmSync(path.join(this.settings.stagingDir, m.id), { recursive: true, force: true });
      delete this.data.mods[m.id];
      this.log.success(`Uninstalled ${m.name}`);
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
  const marker = FRAMEWORK_MARKERS[req.modId];
  if (marker) return fs.existsSync(path.join(gameDir, marker)) ? marker : '';
  const want = squash(req.modName);
  if (want.length < 4) return '';
  for (const rel of MOD_FOLDERS) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(gameDir, rel)); } catch { continue; }
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

module.exports = { ModManager, pickMainFiles, foundInGame };
