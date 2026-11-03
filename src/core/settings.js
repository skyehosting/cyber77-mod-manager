'use strict';
const path = require('path');
const { JsonStore } = require('./jsonStore');

const DEFAULT_SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';

/**
 * User settings. The API key is stored encrypted when a cipher (Electron safeStorage) is available.
 */
class Settings {
  constructor(userDataDir, cipher) {
    this.cipher = cipher;
    this.store = new JsonStore(path.join(userDataDir, 'settings.json'), {
      apiKeyEnc: '',
      apiKeyPlain: '',
      gamePath: '',
      dataDir: path.join(userDataDir, 'data'),
      sevenZipPath: DEFAULT_SEVEN_ZIP,
      concurrentDownloads: 4,
      categories: ['MAIN'], // the file categories ticked for you when you download a mod
      categoriesV2: false, // the old default (every category but old and archived) was moved to Main only
      autoInstall: 'main', // 'off' | 'main' | 'all'
      autoEnable: true,
      installDependencies: true,
      handleNxm: false, // take over Nexus "Mod Manager Download" (nxm://) links
      blockAds: true, // ads and trackers on the Nexus pages shown in Browse
      updateEvery: 2, // how often the app looks for a new version of itself…
      updateUnit: 'minutes', // …in 'minutes' | 'hours' | 'days'
      updateMode: 'auto', // 'auto' install with a restart | 'ask' before restarting | 'off' no checks by itself
      launchMode: 'direct', // 'direct': the game's own program (no Steam prompt, no launcher) | 'steam': through Steam, with its overlay
      redmodDeployed: '', // fingerprint of the REDmods at the last successful REDmod deploy
      redmodLast: null, // the last REDmod deploy this app ran: { ok, at, reason }
      vortexAutoMove: 'ask', // Vortex's mods: 'on' move into this app automatically | 'ask' once | 'off' leave them
      deployMethod: 'hardlink', // 'hardlink' | 'copy'
      // The AI assistant: the user's own provider. Its key is stored like the Nexus key.
      aiProvider: 'openai', // 'openai' (any OpenAI-compatible endpoint) | 'anthropic'
      aiEndpoint: '',
      aiModel: '',
      aiTimeout: 5, // minutes one request to the AI provider may take (local models can be slow)
      aiContext: 0, // the model's context window in tokens; 0: ask the provider
      playsKeep: 25, // how many plays (each launch's logs) the Game log keeps
      uiScale: 0, // the app's scale in percent, used instead of Windows' scale; 0: follow Windows
      aiKeyEnc: '',
      aiKeyPlain: '',
    });
    // The old default ticked nearly every file of a mod. Someone still on it moves to Main only.
    const d = this.store.data;
    if (!d.categoriesV2) {
      if (Array.isArray(d.categories) && [...d.categories].sort().join() === 'MAIN,MISCELLANEOUS,OPTIONAL,UPDATE') d.categories = ['MAIN'];
      d.categoriesV2 = true;
      this.store.save();
    }
    // The data folder in use: one chosen in Settings takes over after a restart (the library and the
    // deployment record were read from this one, so files keep going here until then).
    this.activeDataDir = this.get('dataDir');
  }

  get(key) {
    const v = this.store.data[key];
    return key === 'launchMode' && v === 'store' ? 'steam' : v; // 'store' was the old name of 'steam'
  }

  get apiKey() {
    const d = this.store.data;
    if (d.apiKeyEnc && this.cipher?.available()) {
      try { return this.cipher.decrypt(d.apiKeyEnc); } catch { return ''; }
    }
    return d.apiKeyPlain || '';
  }

  set apiKey(value) {
    const d = this.store.data;
    value = (value || '').trim();
    if (this.cipher?.available()) {
      d.apiKeyEnc = value ? this.cipher.encrypt(value) : '';
      d.apiKeyPlain = '';
    } else {
      d.apiKeyPlain = value;
      d.apiKeyEnc = '';
    }
  }

  /** The AI provider's key, encrypted like the Nexus key. */
  get aiKey() {
    const d = this.store.data;
    if (d.aiKeyEnc && this.cipher?.available()) {
      try { return this.cipher.decrypt(d.aiKeyEnc); } catch { return ''; }
    }
    return d.aiKeyPlain || '';
  }

  set aiKey(value) {
    const d = this.store.data;
    value = (value || '').trim();
    if (this.cipher?.available()) {
      d.aiKeyEnc = value ? this.cipher.encrypt(value) : '';
      d.aiKeyPlain = '';
    } else {
      d.aiKeyPlain = value;
      d.aiKeyEnc = '';
    }
  }

  /** Settings as shown to the UI: the keys themselves never leave the main process. */
  publicView() {
    const { apiKeyEnc, apiKeyPlain, aiKeyEnc, aiKeyPlain, ...rest } = this.store.data;
    const key = this.apiKey;
    const ai = this.aiKey;
    return { ...rest, launchMode: this.get('launchMode'), hasApiKey: !!key, apiKeyHint: key ? `••••••••${key.slice(-4)}` : '', hasAiKey: !!ai, aiKeyHint: ai ? `••••••••${ai.slice(-4)}` : '' };
  }

  update(patch) {
    const d = this.store.data;
    if ('apiKey' in patch) this.apiKey = patch.apiKey;
    if ('aiKey' in patch) this.aiKey = patch.aiKey;
    if ('aiProvider' in patch && ['openai', 'anthropic'].includes(patch.aiProvider)) d.aiProvider = patch.aiProvider;
    for (const k of ['aiEndpoint', 'aiModel']) if (typeof patch[k] === 'string') d[k] = patch[k].trim().slice(0, 300);
    if ('aiContext' in patch) d.aiContext = Math.min(10e6, Math.max(0, Math.round(Number(patch.aiContext) || 0)));
    if ('aiTimeout' in patch && Number.isFinite(Number(patch.aiTimeout)) && patch.aiTimeout !== '') d.aiTimeout = Math.min(60, Math.max(1, Math.round(Number(patch.aiTimeout))));
    for (const k of ['gamePath', 'autoInstall', 'deployMethod']) {
      if (typeof patch[k] === 'string') d[k] = patch[k].trim();
    }
    // The data folder must be a full path (an empty or relative one would point at wherever the app
    // runs from); 7-Zip must be 7-Zip's program, since it is run.
    if (typeof patch.dataDir === 'string') {
      const v = patch.dataDir.trim();
      if (!v || !path.isAbsolute(v)) throw new Error('The data folder must be a full path, like D:\\Mods\\Cyber Mod Manager.');
      d.dataDir = v;
    }
    if (typeof patch.sevenZipPath === 'string') {
      const v = patch.sevenZipPath.trim();
      if (v && !/(^|[\\/])7z[az]?\.exe$/i.test(v)) throw new Error('Choose 7-Zip\'s program: 7z.exe.');
      d.sevenZipPath = v;
    }
    if ('autoEnable' in patch) d.autoEnable = !!patch.autoEnable;
    if ('installDependencies' in patch) d.installDependencies = !!patch.installDependencies;
    if ('handleNxm' in patch) d.handleNxm = !!patch.handleNxm;
    if ('blockAds' in patch) d.blockAds = !!patch.blockAds;
    if ('updateEvery' in patch) d.updateEvery = Math.min(999, Math.max(1, parseInt(patch.updateEvery, 10) || 2));
    if ('updateUnit' in patch && ['minutes', 'hours', 'days'].includes(patch.updateUnit)) d.updateUnit = patch.updateUnit;
    if (['auto', 'ask', 'off'].includes(patch.updateMode)) d.updateMode = patch.updateMode;
    if ('launchMode' in patch && ['direct', 'steam', 'store'].includes(patch.launchMode)) d.launchMode = patch.launchMode === 'store' ? 'steam' : patch.launchMode;
    if (typeof patch.redmodDeployed === 'string') d.redmodDeployed = patch.redmodDeployed;
    if (['on', 'ask', 'off'].includes(patch.vortexAutoMove)) d.vortexAutoMove = patch.vortexAutoMove;
    if (patch.redmodLast && typeof patch.redmodLast === 'object') d.redmodLast = { ok: !!patch.redmodLast.ok, at: Number(patch.redmodLast.at) || 0, reason: String(patch.redmodLast.reason || '').slice(0, 2000) };
    if ('uiScale' in patch) { const v = Math.round(Number(patch.uiScale) || 0); d.uiScale = v ? Math.min(300, Math.max(50, v)) : 0; }
    if ('playsKeep' in patch) d.playsKeep = Math.min(500, Math.max(1, parseInt(patch.playsKeep, 10) || 25));
    if ('concurrentDownloads' in patch) {
      d.concurrentDownloads = Math.min(10, Math.max(1, parseInt(patch.concurrentDownloads, 10) || 4));
    }
    if (Array.isArray(patch.categories)) { d.categories = patch.categories.map(String); d.categoriesV2 = true; }
    this.store.save();
  }

  get downloadsDir() { return path.join(this.activeDataDir, 'downloads'); }
  get stagingDir() { return path.join(this.activeDataDir, 'staging'); }
  get backupDir() { return path.join(this.activeDataDir, 'backups'); }
  get tempDir() { return path.join(this.activeDataDir, 'temp'); }
}

module.exports = { Settings };
