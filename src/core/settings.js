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
      categories: ['MAIN', 'UPDATE', 'OPTIONAL', 'MISCELLANEOUS'],
      autoInstall: 'main', // 'off' | 'main' | 'all'
      autoEnable: true,
      deployMethod: 'hardlink', // 'hardlink' | 'copy'
    });
  }

  get(key) { return this.store.data[key]; }

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

  /** Settings as shown to the UI: the key itself never leaves the main process. */
  publicView() {
    const { apiKeyEnc, apiKeyPlain, ...rest } = this.store.data;
    const key = this.apiKey;
    return { ...rest, hasApiKey: !!key, apiKeyHint: key ? `••••••••${key.slice(-4)}` : '' };
  }

  update(patch) {
    const d = this.store.data;
    if ('apiKey' in patch) this.apiKey = patch.apiKey;
    for (const k of ['gamePath', 'dataDir', 'sevenZipPath', 'autoInstall', 'deployMethod']) {
      if (typeof patch[k] === 'string') d[k] = patch[k].trim();
    }
    if ('autoEnable' in patch) d.autoEnable = !!patch.autoEnable;
    if ('concurrentDownloads' in patch) {
      d.concurrentDownloads = Math.min(10, Math.max(1, parseInt(patch.concurrentDownloads, 10) || 4));
    }
    if (Array.isArray(patch.categories)) d.categories = patch.categories.map(String);
    this.store.save();
  }

  get downloadsDir() { return path.join(this.get('dataDir'), 'downloads'); }
  get stagingDir() { return path.join(this.get('dataDir'), 'staging'); }
  get backupDir() { return path.join(this.get('dataDir'), 'backups'); }
  get tempDir() { return path.join(this.get('dataDir'), 'temp'); }
}

module.exports = { Settings };
