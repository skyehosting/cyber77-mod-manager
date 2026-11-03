'use strict';
const { EventEmitter } = require('events');

/*
 * Updates of the app itself, from the GitHub releases of the public repository (electron-updater
 * reads latest.yml there). While the app is open it checks on a schedule (every 2 minutes by
 * default, set in Settings) and downloads a new version by itself. The window shows it from the
 * moment it is found. How it installs follows Settings → App updates:
 *   'auto'   restart to install once nothing is in progress and the window is in view, after a
 *            notice the user can put off (it then installs when the app is next closed);
 *   'ask'    wait for the user's Restart now (or the app's next close);
 *   'off'    no checks by itself (Check now still works).
 * While the game runs nothing is checked or restarted: a check that came due runs when it closes.
 */

const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 86400e3 };
const MIN_MS = 60e3;
const RESTART_DELAY_MS = 30e3;
const MODES = ['auto', 'ask', 'off'];

/** How long between checks, from the settings ({ value, unit }); never under a minute. */
function intervalMs(every, unit) {
  const n = Number(every);
  const ms = (Number.isFinite(n) && n > 0 ? n : 2) * (UNIT_MS[unit] || UNIT_MS.minutes);
  return Math.min(Math.max(ms, MIN_MS), 30 * UNIT_MS.days);
}

class AppUpdater extends EventEmitter {
  /**
   * getSchedule(): { every, unit, mode }. isBusy(): true while something must not be cut off by a
   * restart. gameRunning(): the game is open. inView(): the window can be seen (not minimized), so
   * a restart is never a surprise. autoUpdater: electron-updater's (passed in so this stays testable).
   */
  constructor({ autoUpdater, getSchedule, isBusy, gameRunning = () => false, inView = () => true, log, enabled }) {
    super();
    this.up = autoUpdater;
    this.getSchedule = getSchedule;
    this.isBusy = isBusy;
    this.gameRunning = gameRunning;
    this.inView = inView;
    this.log = log;
    this.enabled = enabled;
    this.timer = null;
    this.restartTimer = null;
    this.dueWhileGame = false;
    this.state = { status: enabled ? 'idle' : 'dev', version: '', available: '', progress: 0, lastCheck: 0, error: '', restartAt: 0, mode: this.mode() };
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

  mode() {
    const m = this.getSchedule?.().mode;
    return MODES.includes(m) ? m : 'auto';
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** (Re)start the schedule; called at start and when the settings change. */
  start() {
    if (!this.enabled) return;
    clearInterval(this.timer);
    const mode = this.mode();
    this.set({ mode });
    if (this.state.status === 'ready') this.scheduleRestart(); // the mode may have changed
    if (mode === 'off') return;
    const { every, unit } = this.getSchedule();
    this.timer = setInterval(() => this.scheduledCheck(), intervalMs(every, unit));
    this.scheduledCheck();
  }

  /** A check on the schedule: not while the game runs (it then runs when the game closes). */
  scheduledCheck() {
    if (this.gameRunning()) {
      this.dueWhileGame = true;
      this.set({ heldForGame: true });
      return Promise.resolve(this.state);
    }
    return this.check();
  }

  /** The game opened or closed: a check that came due meanwhile runs now; a ready update may restart. */
  gameChanged(running) {
    if (running || !this.enabled) return;
    this.set({ heldForGame: false });
    if (this.dueWhileGame && this.mode() !== 'off') { this.dueWhileGame = false; this.check(); }
    if (this.state.status === 'ready') this.scheduleRestart();
  }

  /** Check now (also what the "Check now" button does, whatever the mode). */
  check() {
    if (!this.enabled) return Promise.resolve(this.state);
    // A downloaded update waits for its restart; checking again would download it again.
    if (['downloading', 'ready', 'checking'].includes(this.state.status)) return Promise.resolve(this.state);
    return this.up.checkForUpdates().then(() => this.state).catch(() => this.state);
  }

  /**
   * Restart to install, in "auto" mode, once it is safe and the user can see it coming: nothing in
   * progress, the game closed, the window in view. Then a notice the user can put off.
   */
  scheduleRestart() {
    clearTimeout(this.restartTimer);
    if (this.state.postponed || this.state.status !== 'ready') return;
    if (this.mode() !== 'auto') { this.set({ restartAt: 0, waiting: false, waitingFor: '' }); return; }
    const waitingFor = this.gameRunning() ? 'game' : this.isBusy() ? 'busy' : !this.inView() ? 'view' : '';
    if (waitingFor) {
      if (this.state.waitingFor !== waitingFor || this.state.restartAt) this.set({ restartAt: 0, waiting: true, waitingFor });
      this.restartTimer = setTimeout(() => this.scheduleRestart(), 5000);
      return;
    }
    const at = Date.now() + RESTART_DELAY_MS;
    this.set({ restartAt: at, waiting: false, waitingFor: '' });
    this.restartTimer = setTimeout(() => {
      if (this.state.postponed) return;
      if (this.gameRunning() || this.isBusy() || !this.inView()) { this.scheduleRestart(); return; }
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

module.exports = { AppUpdater, intervalMs, UNIT_MS, RESTART_DELAY_MS };
