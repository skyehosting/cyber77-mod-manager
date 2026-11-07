'use strict';
const fs = require('fs');
const path = require('path');
const { JsonStore } = require('./jsonStore');
const { backupDirProblem } = require('./saves');
const { cleanApiPath } = require('./modio');
const { isPublicV4 } = require('./groups/publicIp');

const DEFAULT_SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';
/** The AI's reasoning effort: '' leaves it to the model. */
const AI_REASONING = ['', 'none', 'low', 'medium', 'high'];

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
      sevenZipPath: process.platform === 'win32' ? DEFAULT_SEVEN_ZIP : '', // Linux: found on PATH (manager.js sevenZip)
      concurrentDownloads: 4,
      categories: ['MAIN'], // the file categories ticked for you when you download a mod
      categoriesV2: false, // the old default (every category but old and archived) was moved to Main only
      autoInstall: 'all', // 'off' | 'main' | 'all': what installs by itself when its download finishes (then enabled, unless autoEnable is off)
      autoEnable: true,
      installDependencies: true,
      handleNxm: false, // take over Nexus "Mod Manager Download" (nxm://) links
      blockAds: true, // ads and trackers on the Nexus pages shown in Browse
      groupsEnabled: false, // Group Mods: listen for friends' apps (off until turned on, with the firewall step)
      groupsPort: 47077, // the TCP port friends connect to
      groupsUpnp: true, // try to open that port on the router (UPnP) while groups are on
      groupsPublicIp: '', // this PC's internet address for invites, when the router doesn't say it (a port forwarded by hand)
      groupsFindIp: false, // "Find it" was used: look it up again (api.ipify.org) while groups are on
      updateEvery: 1, // how often the app looks for a new version of itself (also each time it opens)…
      updateUnit: 'days', // …in 'minutes' | 'hours' | 'days'
      updateMode: 'auto', // 'auto' install with a restart | 'ask' before restarting | 'off' no checks by itself
      launchInstallTried: '', // the version last installed before opening (the same one again: it did not take)
      updateOnLaunch: true, // with 'auto': check before the window opens and install a newer version first (like Discord)
      launchMode: 'direct', // 'direct': the game's own program (no Steam prompt, no launcher) | 'steam': through Steam, with its overlay
      redmodDeployed: '', // fingerprint of the REDmods at the last successful REDmod deploy
      prereqsWaived: [], // Linux: Proton folders where Play goes on without asking for vcrun2022 / d3dcompiler_47
      tzHintOff: false, // Linux: never suggest TZ=UTC after the game closes right after starting
      redmodLast: null, // the last REDmod deploy this app ran: { ok, at, reason }
      vortexExe: '', // Vortex.exe chosen by hand ('' = found by itself: the registry, then the usual places)
      vortexAutoMove: 'ask', // Vortex's mods: 'on' move into this app automatically | 'ask' once | 'off' leave them
      // Save manager: automatic backups of the game's saves (before Play, or when the game starts).
      saveAutoBackup: true,
      saveCooldown: 60, // minutes between automatic backups when the mods did not change
      savePauseUnchanged: true, // no automatic backup while the saves are exactly as in the last one
      saveMaxPerProfile: 20, // backups kept per profile (pinned and recent safety backups are extra)
      perProfileSaves: false, // each profile has its own saves (moved in and out at a profile switch)
      saveBackupDir: '', // '' = Saved Games\Edgerunners Mod Manager\Save backups
      reqView: 'open', // the Mods page's requirements under each mod: 'open' always | 'collapsed' (click to open)
      mo2Folders: [], // Mod Organizer 2 folders the user added (instances in places this app does not look)
      deployMethod: 'hardlink', // 'hardlink' | 'copy'
      // The AI assistant: the user's own provider. Its key is stored like the Nexus key.
      aiProvider: 'openai', // 'openai' (any OpenAI-compatible endpoint) | 'anthropic'
      aiEndpoint: '',
      aiModel: '',
      aiReasoning: '', // how much a reasoning model thinks first: '' (the model's own default) | none | low | medium | high
      aiMaxSteps: 12, // model requests per question before it stops and asks to continue; 0: no limit
      aiPresets: [], // saved AI setups: { id, name, provider, endpoint, model, reasoning, timeout, context, maxSteps, keyEnc, keyPlain }
      aiTimeout: 5, // minutes one request to the AI provider may take (local models can be slow)
      aiContext: 0, // the model's context window in tokens; 0: ask the provider
      playsKeep: 25, // how many plays (each launch's logs) the Game log keeps
      perfInterval: 1000, // the Performance page: milliseconds between readings (500 to 10000)
      perfHistory: 60, // seconds of history its graphs show
      perfGraphs: true, // graphs under the numbers
      uiScale: 0, // the app's scale in percent, used instead of Windows' scale; 0: follow Windows
      windowBg: '', // the theme's page colour (#rrggbb), so the window opens in it instead of flashing dark
      aiKeyEnc: '',
      aiKeyPlain: '',
      // mod.io: the user's own read-only API key and API path (mod.io/me/access), stored like the Nexus key.
      modioKeyEnc: '',
      modioKeyPlain: '',
      modioApiPath: '', // '' = https://api.mod.io/v1
      showMature: false, // mod.io mods marked mature: blurred until shown
    });
    // The old default ticked nearly every file of a mod. Someone still on it moves to Main only.
    const d = this.store.data;
    if (!d.categoriesV2) {
      if (Array.isArray(d.categories) && [...d.categories].sort().join() === 'MAIN,MISCELLANEOUS,OPTIONAL,UPDATE') d.categories = ['MAIN'];
      d.categoriesV2 = true;
      this.store.save();
    }
    // The update check moved from every 2 minutes to once a day: copies still on the old default
    // follow (one set to anything else keeps it). Once only, so a later choice of 2 minutes stays.
    if (!d.updateDailyV1) {
      if (d.updateEvery === 2 && d.updateUnit === 'minutes') { d.updateEvery = 1; d.updateUnit = 'days'; }
      d.updateDailyV1 = true;
      this.store.save();
    }
    // Every finished download now installs (and enables) by itself, not only Main files: copies on the
    // old default follow, once (a later choice of Main files only stays).
    if (!d.autoInstallAllV1) {
      // Said once when the app opens (main.js), with where to change it back.
      if (d.autoInstall === 'main') { d.autoInstall = 'all'; this.movedAutoInstall = true; }
      d.autoInstallAllV1 = true;
      this.store.save();
    }
    // The data folder in use: one chosen in Settings takes over after a restart (the library and the
    // deployment record were read from this one, so files keep going here until then).
    this.activeDataDir = this.get('dataDir');
  }

  get(key) {
    const v = this.store.data[key];
    // 'store' was the old name of 'steam'; on Linux the game always starts through Steam (Proton).
    if (key === 'launchMode') return process.platform !== 'win32' ? 'steam' : v === 'store' ? 'steam' : v;
    return v;
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

  /** The mod.io API key, encrypted like the Nexus key. */
  get modioKey() {
    const d = this.store.data;
    if (d.modioKeyEnc && this.cipher?.available()) {
      try { return this.cipher.decrypt(d.modioKeyEnc); } catch { return ''; }
    }
    return d.modioKeyPlain || '';
  }

  set modioKey(value) {
    const d = this.store.data;
    value = String(value || '').trim();
    // mod.io keys are 32 letters and digits: anything else is a paste of something else.
    if (value && !/^[a-z0-9]{32}$/i.test(value)) throw new Error('That is not a mod.io API key: it is 32 letters and digits, from mod.io/me/access.');
    if (this.cipher?.available()) {
      d.modioKeyEnc = value ? this.cipher.encrypt(value) : '';
      d.modioKeyPlain = '';
    } else {
      d.modioKeyPlain = value;
      d.modioKeyEnc = '';
    }
  }

  /** Settings as shown to the UI: the keys themselves never leave the main process. */
  publicView() {
    const { apiKeyEnc, apiKeyPlain, aiKeyEnc, aiKeyPlain, aiPresets, modioKeyEnc, modioKeyPlain, ...rest } = this.store.data;
    const mio = this.modioKey;
    const key = this.apiKey;
    const ai = this.aiKey;
    const hint = k => (k ? `••••••••${k.slice(-4)}` : '');
    const presets = this.aiPresets().map(({ keyEnc, keyPlain, ...p }) => {
      const k = this.presetKey({ keyEnc, keyPlain });
      return { ...p, hasKey: !!k, keyHint: hint(k) };
    });
    return { ...rest, aiPresets: presets, launchMode: this.get('launchMode'), hasApiKey: !!key, apiKeyHint: hint(key), hasAiKey: !!ai, aiKeyHint: hint(ai), aiKeySaved: this.aiKeySaved(), hasModioKey: !!mio, modioKeyHint: hint(mio) };
  }

  // ---------------------------------------------------------------- saved AI setups

  /** A saved setup's key (encrypted like the AI key, or plain where nothing can encrypt). */
  presetKey(p) {
    if (p.keyEnc && this.cipher?.available()) { try { return this.cipher.decrypt(p.keyEnc); } catch { return ''; } }
    return p.keyPlain || '';
  }

  /**
   * Save the AI settings in use (format, endpoint, model, reasoning, time limit, context window, steps
   * and the key) as a setup under `name`; one of that name already there is replaced. At most 20.
   */
  saveAiPreset(name) {
    const n = String(name || '').replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 40);
    if (!n) throw new Error('Give the setup a name.');
    const d = this.store.data;
    const list = this.aiPresets().filter(p => p.name.toLowerCase() !== n.toLowerCase());
    if (list.length >= 20) throw new Error('There are 20 saved setups already: delete one first.');
    const key = this.aiKey;
    const enc = !!key && !!this.cipher?.available();
    const preset = {
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: n,
      provider: d.aiProvider, endpoint: d.aiEndpoint, model: d.aiModel, reasoning: d.aiReasoning,
      timeout: d.aiTimeout, context: d.aiContext, maxSteps: d.aiMaxSteps,
      // savedKey: it was saved with a key (so a key it can no longer read is an error, not "no key")
      savedKey: !!key, keyEnc: enc ? this.cipher.encrypt(key) : '', keyPlain: enc ? '' : key,
    };
    d.aiPresets = [...list, preset];
    this.store.save();
    return n;
  }

  /** The saved setups (entries a hand edit broke are left out). */
  aiPresets() {
    const list = this.store.data.aiPresets;
    return (Array.isArray(list) ? list : []).filter(p => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string');
  }

  /**
   * Use a saved setup: its settings and its key become the ones in use (a setup saved without a key,
   * for a local model, clears it: no other provider's key is sent to that endpoint). A key it can no
   * longer read (Windows' encryption changed) is an error, and nothing changes.
   */
  applyAiPreset(id) {
    const p = this.aiPresets().find(x => x.id === id);
    if (!p) throw new Error('That saved setup no longer exists.');
    const key = this.presetKey(p);
    if (p.savedKey && !key) throw new Error(`The key saved with "${p.name}" could not be read (Windows' encryption for this account changed). Switch to it, paste the key again, and save it again.`);
    this.update({ aiProvider: p.provider, aiEndpoint: p.endpoint, aiModel: p.model, aiReasoning: p.reasoning ?? '', aiTimeout: p.timeout, aiContext: p.context, aiMaxSteps: p.maxSteps ?? 12, aiKey: key });
    return p.name;
  }

  /** Whether the AI key in use is also in a saved setup (switching setups would otherwise lose it). */
  aiKeySaved() {
    const key = this.aiKey;
    return !key || this.aiPresets().some(p => this.presetKey(p) === key);
  }

  deleteAiPreset(id) {
    const d = this.store.data;
    d.aiPresets = this.aiPresets().filter(x => x.id !== id);
    this.store.save();
  }

  update(patch) {
    const d = this.store.data;
    if ('apiKey' in patch) this.apiKey = patch.apiKey;
    if ('aiKey' in patch) this.aiKey = patch.aiKey;
    if ('modioKey' in patch) this.modioKey = patch.modioKey;
    if (typeof patch.modioApiPath === 'string') d.modioApiPath = cleanApiPath(patch.modioApiPath);
    if ('showMature' in patch) d.showMature = !!patch.showMature;
    if ('aiProvider' in patch && ['openai', 'anthropic'].includes(patch.aiProvider)) d.aiProvider = patch.aiProvider;
    if ('aiReasoning' in patch && AI_REASONING.includes(patch.aiReasoning)) d.aiReasoning = patch.aiReasoning;
    if ('aiMaxSteps' in patch && patch.aiMaxSteps !== '' && Number.isFinite(Number(patch.aiMaxSteps))) d.aiMaxSteps = Math.min(500, Math.max(0, Math.round(Number(patch.aiMaxSteps))));
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
      // Windows: 7z.exe. Linux: 7-Zip's 7zz, or p7zip's 7z / 7za (no .exe).
      if (v && !(process.platform === 'win32' ? /(^|[\\/])7z[az]?\.exe$/i : /(^|\/)(7zz|7z|7za)$/).test(v)) {
        throw new Error(process.platform === 'win32' ? 'Choose 7-Zip\'s program: 7z.exe.' : 'Choose 7-Zip\'s program: 7zz (or 7z).');
      }
      d.sevenZipPath = v;
    }
    if ('autoEnable' in patch) d.autoEnable = !!patch.autoEnable;
    if ('installDependencies' in patch) d.installDependencies = !!patch.installDependencies;
    if ('handleNxm' in patch) d.handleNxm = !!patch.handleNxm;
    if ('blockAds' in patch) d.blockAds = !!patch.blockAds;
    if ('updateEvery' in patch) d.updateEvery = Math.min(999, Math.max(1, parseInt(patch.updateEvery, 10) || 1));
    if ('updateUnit' in patch && ['minutes', 'hours', 'days'].includes(patch.updateUnit)) d.updateUnit = patch.updateUnit;
    if (['auto', 'ask', 'off'].includes(patch.updateMode)) d.updateMode = patch.updateMode;
    if ('updateOnLaunch' in patch) d.updateOnLaunch = !!patch.updateOnLaunch;
    if (typeof patch.launchInstallTried === 'string') d.launchInstallTried = patch.launchInstallTried.slice(0, 40);
    if ('launchMode' in patch && ['direct', 'steam', 'store'].includes(patch.launchMode)) d.launchMode = patch.launchMode === 'store' ? 'steam' : patch.launchMode;
    if (typeof patch.redmodDeployed === 'string') d.redmodDeployed = patch.redmodDeployed;
    // Linux: Proton folders whose missing mod-loader components the player chose to start without.
    if (Array.isArray(patch.prereqsWaived)) d.prereqsWaived = patch.prereqsWaived.filter(p => typeof p === 'string' && path.isAbsolute(p)).slice(-20);
    if ('tzHintOff' in patch) d.tzHintOff = !!patch.tzHintOff;
    if (['on', 'ask', 'off'].includes(patch.vortexAutoMove)) d.vortexAutoMove = patch.vortexAutoMove;
    // Vortex.exe is run (to switch its mods), so a newly chosen one must be a path on a drive to a
    // file named Vortex.exe that is there (as vortex.js isVortexExe, which checks it again on every
    // use). The one saved before comes back with every Save: a Vortex moved since must not block
    // saving the rest.
    if (typeof patch.vortexExe === 'string') {
      const v = patch.vortexExe.trim();
      if (v && v !== d.vortexExe) {
        if (!(/^[a-z]:[\\/]/i.test(v) && /[\\/]vortex\.exe$/i.test(v))) throw new Error('Choose Vortex\'s program: Vortex.exe (usually in C:\\Program Files\\Black Tree Gaming Ltd\\Vortex).');
        let ok = false;
        try { ok = fs.statSync(v).isFile(); } catch { /* not there */ }
        if (!ok) throw new Error(`There is no Vortex.exe at ${v}.`);
      }
      d.vortexExe = v;
    }
    if (['open', 'collapsed'].includes(patch.reqView)) d.reqView = patch.reqView;
    if ('saveAutoBackup' in patch) d.saveAutoBackup = !!patch.saveAutoBackup;
    if ('perProfileSaves' in patch) d.perProfileSaves = !!patch.perProfileSaves;
    if ('savePauseUnchanged' in patch) d.savePauseUnchanged = !!patch.savePauseUnchanged;
    if ('saveCooldown' in patch) { const c = parseInt(patch.saveCooldown, 10); if (Number.isFinite(c)) d.saveCooldown = Math.min(1440, Math.max(0, c)); }
    if ('saveMaxPerProfile' in patch) d.saveMaxPerProfile = Math.min(500, Math.max(3, parseInt(patch.saveMaxPerProfile, 10) || 20));
    // '' is the default folder; anything else must be a safe place (not in the synced save folder, not a drive root…).
    if ('saveBackupDir' in patch && (patch.saveBackupDir === '' || !backupDirProblem(patch.saveBackupDir))) d.saveBackupDir = patch.saveBackupDir;
    if (Array.isArray(patch.mo2Folders)) d.mo2Folders = [...new Set(patch.mo2Folders.filter(f => typeof f === 'string' && path.isAbsolute(f)).map(f => f.slice(0, 500)))].slice(0, 20);
    if (patch.redmodLast && typeof patch.redmodLast === 'object') d.redmodLast = { ok: !!patch.redmodLast.ok, at: Number(patch.redmodLast.at) || 0, reason: String(patch.redmodLast.reason || '').slice(0, 2000) };
    if ('windowBg' in patch) d.windowBg = /^#[0-9a-f]{6}$/i.test(String(patch.windowBg)) ? String(patch.windowBg) : '';
    if ('uiScale' in patch) { const v = Math.round(Number(patch.uiScale) || 0); d.uiScale = v ? Math.min(300, Math.max(50, v)) : 0; }
    if ('perfInterval' in patch) d.perfInterval = Math.min(10000, Math.max(500, parseInt(patch.perfInterval, 10) || 1000));
    if ('perfHistory' in patch) d.perfHistory = Math.min(600, Math.max(10, parseInt(patch.perfHistory, 10) || 60));
    if ('perfGraphs' in patch) d.perfGraphs = !!patch.perfGraphs;
    if ('groupsEnabled' in patch) d.groupsEnabled = !!patch.groupsEnabled;
    if ('groupsUpnp' in patch) d.groupsUpnp = !!patch.groupsUpnp;
    if ('groupsPublicIp' in patch) d.groupsPublicIp = isPublicV4(patch.groupsPublicIp) ? String(patch.groupsPublicIp).trim() : '';
    if ('groupsFindIp' in patch) d.groupsFindIp = !!patch.groupsFindIp;
    if ('groupsPort' in patch) { const p = parseInt(patch.groupsPort, 10); if (p >= 1024 && p <= 65535) d.groupsPort = p; }
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
