'use strict';
const { EventEmitter } = require('events');

/*
 * Updates of the app itself, from the GitHub releases of the public repository (electron-updater
 * reads latest.yml there). While the app is open it checks on a schedule (every 2 minutes by
 * default, set in Settings), downloads a new version by itself, and installs it with a restart
 * once nothing is in progress (no downloads, installs or Vortex changes). The user can put the
 * restart off; it then happens when the app is next closed.
 */

const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 86400e3 };
const MIN_MS = 60e3;
const RESTART_DELAY_MS = 15e3;

/** How long between checks, from the settings ({ value, unit }); never under a minute. */
function intervalMs(every, unit) {
  const n = Number(every);
  const ms = (Number.isFinite(n) && n > 0 ? n : 2) * (UNIT_MS[unit] || UNIT_MS.minutes);
  return Math.min(Math.max(ms, MIN_MS), 30 * UNIT_MS.days);
}

class AppUpdater extends EventEmitter {
  /**
   * isBusy(): true while something must not be cut off by a restart.
   * autoUpdater: electron-updater's (passed in so this stays testable).
   */
  constructor({ autoUpdater, getSchedule, isBusy, log, enabled }) {
    super();
    this.up = autoUpdater;
    this.getSchedule = getSchedule;
    this.isBusy = isBusy;
    this.log = log;
    this.enabled = enabled;
    this.timer = null;
    this.restartTimer = null;
    this.state = { status: enabled ? 'idle' : 'dev', version: '', available: '', progress: 0, lastCheck: 0, error: '', restartAt: 0 };
    if (!enabled) return;
    this.up.autoDownload = true;
    this.up.autoInstallOnAppQuit = true;
    this.up.logger = null;
    this.up.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
    this.up.on('update-not-available', () => this.set({ status: 'current', lastCheck: Date.now() }));
    this.up.on('update-available', info => {
      this.set({ status: 'downloading', available: info.version, progress: 0, lastCheck: Date.now() });
      this.log.info(`Cyber Mod Manager ${info.version} is available; downloading it`);
    });
    this.up.on('download-progress', p => this.set({ progress: Math.round(p.percent || 0) }));
    this.up.on('update-downloaded', info => {
      this.set({ status: 'ready', available: info.version, progress: 100 });
      this.log.success(`Cyber Mod Manager ${info.version} is downloaded and installs with a restart`);
      this.scheduleRestart();
    });
    this.up.on('error', err => {
      this.set({ status: 'error', error: String(err?.message || err).split('\n')[0], lastCheck: Date.now() });
    });
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** (Re)start the schedule; called at start and when the setting changes. */
  start() {
    if (!this.enabled) return;
    clearInterval(this.timer);
    const { every, unit } = this.getSchedule();
    this.timer = setInterval(() => this.check(), intervalMs(every, unit));
    this.check();
  }

  check() {
    if (!this.enabled) return Promise.resolve(this.state);
    // A downloaded update waits for its restart; checking again would download it again.
    if (['downloading', 'ready', 'checking'].includes(this.state.status)) return Promise.resolve(this.state);
    return this.up.checkForUpdates().then(() => this.state).catch(() => this.state);
  }

  /** Restart to install once the app is idle, after a short notice the user can cancel. */
  scheduleRestart() {
    clearTimeout(this.restartTimer);
    if (this.state.postponed) return;
    if (this.isBusy()) {
      this.set({ restartAt: 0, waiting: true });
      this.restartTimer = setTimeout(() => this.scheduleRestart(), 5000);
      return;
    }
    const at = Date.now() + RESTART_DELAY_MS;
    this.set({ restartAt: at, waiting: false });
    this.restartTimer = setTimeout(() => {
      if (this.state.postponed) return;
      if (this.isBusy()) { this.scheduleRestart(); return; }
      this.installNow();
    }, RESTART_DELAY_MS);
  }

  /** "Later": the update installs when the app is closed instead. */
  postpone() {
    clearTimeout(this.restartTimer);
    this.set({ postponed: true, restartAt: 0 });
    this.log.info('The update installs when Cyber Mod Manager is closed');
  }

  installNow() {
    if (this.state.status !== 'ready') return;
    clearTimeout(this.restartTimer);
    this.log.info(`Restarting to install Cyber Mod Manager ${this.state.available}`);
    this.emit('before-install');
    // Silent install, then start the app again.
    setImmediate(() => this.up.quitAndInstall(true, true));
  }
}

module.exports = { AppUpdater, intervalMs, UNIT_MS };
