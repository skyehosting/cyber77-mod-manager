'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { JsonStore } = require('./jsonStore');
const { NexusClient, parseModUrl } = require('./nexus');
const { Downloader } = require('./downloader');
const { Installer } = require('./installer');
const { Deployer } = require('./deployer');
const { isGameDir } = require('./gameFinder');
const { sanitizeName } = require('./layout');

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
    this.installer = new Installer({ getSevenZip: () => settings.get('sevenZipPath'), tempDir: () => settings.tempDir, log });
    this.deployer = new Deployer({ manifestFile: path.join(dataDir, 'deployment.json'), backupDir: settings.backupDir, log });
    this.pendingFomod = new Map();
    this.chain = Promise.resolve();

    this.downloader.on('update', job => this.emit('job', job));
    this.downloader.on('done', job => this.onDownloaded(job));
    fs.rmSync(settings.tempDir, { recursive: true, force: true });
  }

  get data() { return this.library.data; }

  /** Run state-changing work one at a time. */
  op(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run.finally(() => this.emit('changed'));
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
      mods: mods.map(m => ({ ...m, fileCount: m.files.length, files: undefined })),
      downloads,
      jobs: this.downloader.list(),
      conflicts,
      game: { path: game, valid: isGameDir(game) },
      rate: this.nexus.rate,
      pendingFomod: [...this.pendingFomod.keys()],
    };
  }

  modFiles(id) {
    const mod = this.data.mods[id];
    if (!mod) return null;
    const owners = this.deployer.owners();
    return mod.files.map(f => ({ dest: f, deployed: owners[f.toLowerCase()] === id, owner: owners[f.toLowerCase()] || null }));
  }

  // ---------------------------------------------------------------- downloading

  async validateKey() {
    const user = await this.nexus.validate();
    this.log.success(`API key valid: ${user.name}${user.is_premium ? ' (Premium)' : ' (not Premium)'}`);
    if (!user.is_premium) this.log.warn('Direct downloads through the API need Nexus Premium; without it Nexus refuses download links (403).');
    return { name: user.name, isPremium: !!user.is_premium, isSupporter: !!user.is_supporter, avatar: user.profile_url || '' };
  }

  /** Queue every file (of the chosen categories) from each mod link. */
  async addLinks(text) {
    const urls = String(text).split(/[\s,]+/).filter(Boolean);
    const summary = { mods: 0, queued: 0, skipped: 0, errors: [] };
    if (!urls.length) throw new Error('Paste at least one Nexus Mods link.');
    const wanted = new Set(this.settings.get('categories'));
    for (const url of urls) {
      const parsed = parseModUrl(url);
      if (!parsed) {
        summary.errors.push(`Not a Nexus mod link: ${url}`);
        this.log.error(`Not a Nexus mod link: ${url}`, 'Expected https://www.nexusmods.com/<game>/mods/<id>');
        continue;
      }
      try {
        const [mod, files] = await Promise.all([
          this.nexus.getMod(parsed.game, parsed.modId),
          this.nexus.getFiles(parsed.game, parsed.modId),
        ]);
        const modName = mod.name || `Mod ${parsed.modId}`;
        if (parsed.game !== 'cyberpunk2077') this.log.warn(`${modName} is a ${parsed.game} mod; it will download, but the installer only knows Cyberpunk 2077 layouts.`);
        const list = (files.files || []).filter(f => wanted.has(String(f.category_name || 'MISCELLANEOUS').toUpperCase()));
        this.log.info(`${modName}: ${list.length} of ${(files.files || []).length} files match the chosen categories`);
        summary.mods++;
        for (const f of list) {
          const key = String(f.file_id);
          const category = String(f.category_name || 'MISCELLANEOUS').toUpperCase();
          const dest = path.join(
            this.settings.downloadsDir, parsed.game, `${sanitizeName(modName)} (${parsed.modId})`,
            CATEGORY_FOLDERS[category] || sanitizeName(category), sanitizeName(f.file_name || `${key}.zip`),
          );
          const known = this.data.downloads[key];
          if (known && fs.existsSync(known.path)) {
            summary.skipped++;
            continue;
          }
          this.downloader.enqueue({
            key, game: parsed.game, modId: parsed.modId, modName, fileId: f.file_id,
            name: f.name || f.file_name, fileName: f.file_name, version: f.version || f.mod_version || '',
            category, size: (f.size_in_bytes || (f.size_kb || 0) * 1024) || 0, uploaded: f.uploaded_timestamp || 0,
            author: mod.author || '', picture: mod.picture_url || '', dest,
          });
          summary.queued++;
        }
      } catch (err) {
        summary.errors.push(err.message);
        this.log.error(`Could not read files for ${url}`, err.message);
      }
    }
    if (summary.skipped) this.log.info(`${summary.skipped} file(s) were already downloaded and were skipped`);
    this.emit('changed');
    return summary;
  }

  onDownloaded(job) {
    this.op(async () => {
      this.data.downloads[job.key] = {
        key: job.key, game: job.game, modId: job.modId, modName: job.modName, fileId: job.fileId,
        name: job.name, fileName: job.fileName, version: job.version, category: job.category,
        size: job.total, uploaded: job.uploaded, author: job.author, picture: job.picture,
        path: job.dest, downloadedAt: Date.now(),
      };
      this.library.save();
    }).then(() => {
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
        this.data.downloads[key] = {
          key, game: 'cyberpunk2077', modId: 0, modName: base, fileId: 0, name: base, fileName: path.basename(p),
          version: '', category: 'LOCAL', size: fs.statSync(dest).size, uploaded: 0, author: '', picture: '',
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
  install(keys, { auto = false } = {}) {
    return this.op(async () => {
      const results = [];
      for (const key of keys) {
        const rec = this.data.downloads[key];
        if (!rec) continue;
        try {
          results.push(await this.installOne(rec, auto));
        } catch (err) {
          this.log.error(`Install failed: ${rec.name}`, err);
          results.push({ key, error: err.message });
        }
      }
      return results;
    });
  }

  async installOne(rec, auto) {
    if (!fs.existsSync(rec.path)) throw new Error(`Archive is missing: ${rec.path}`);
    this.log.info(`Installing ${rec.name}…`);
    const session = await this.installer.prepare(rec.path);
    if (session.fomod) {
      const states = this.installer.fileStates(session, this.settings.get('gamePath'));
      const imageBase = pathToFileURL(path.join(session.extractDir, session.fomod.basePath || '.') + path.sep).href;
      this.pendingFomod.set(session.token, { session, rec, auto, states });
      this.log.info(`${rec.name} has a FOMOD installer; choose its options in the wizard.`);
      this.emit('fomod', { token: session.token, name: rec.name, modName: rec.modName, config: session.fomod.config, fileStates: states, imageBase });
      return { key: rec.key, fomod: session.token };
    }
    try {
      return this.finishInstall(rec, session, null, null, auto);
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
        return this.finishInstall(pending.rec, pending.session, selections, pending.states, pending.auto);
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

  finishInstall(rec, session, selections, states, auto) {
    const plan = this.installer.plan(session, rec.modName, selections, states);
    if (!plan.mappings.length) {
      throw new Error(`Nothing in ${rec.fileName} looks like a Cyberpunk 2077 mod (${session.files.length} files, none in a known place).`);
    }
    const id = rec.key;
    const old = this.data.mods[id];
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
      enabled: false, priority: old?.priority ?? this.data.nextPriority++, installedAt: Date.now(),
      fomod: !!selections,
    };
    this.data.mods[id] = mod;
    this.library.save();
    this.log.success(`Installed ${rec.name} as ${plan.type} (${files.length} files${plan.skipped.length ? `, ${plan.skipped.length} skipped` : ''})`);
    if ((auto && this.settings.get('autoEnable')) || old?.enabled) {
      mod.enabled = true;
      this.deploy();
    }
    return { key: rec.key, id, type: plan.type };
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
    this.library.save();
    if (res.added || res.removed) this.log.info(`Deployment: ${res.added} file(s) placed, ${res.removed} removed${res.restored ? `, ${res.restored} original(s) restored` : ''}`);
    if (res.errors.length) this.log.error(`${res.errors.length} file(s) could not be deployed (is the game running?)`);
    return res;
  }

  setEnabled(ids, enabled) {
    return this.op(async () => {
      const changed = ids.map(id => this.data.mods[id]).filter(m => m && m.enabled !== enabled);
      for (const m of changed) m.enabled = enabled;
      try {
        this.deploy();
      } catch (err) {
        for (const m of changed) m.enabled = !enabled;
        this.library.save();
        throw err;
      }
      this.log.success(`${enabled ? 'Enabled' : 'Disabled'} ${changed.length} mod(s)`);
    });
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

module.exports = { ModManager };
