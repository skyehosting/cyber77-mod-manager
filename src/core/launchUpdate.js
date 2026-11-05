'use strict';

/*
 * Update before the app opens (Settings → App updates → "Update when the app opens", like Discord):
 * a small window checks the GitHub releases first. A newer version downloads there, with its
 * progress, and installs with a restart, so the new version is the one that opens. Nothing newer,
 * no connection, or too slow: the app opens as usual. A download still running then goes on in the
 * background and installs the way App updates says (the window shows it).
 *
 * updateBeforeOpening resolves { outcome, version, error }, outcome being:
 *   'install'     downloaded: the caller restarts into it
 *   'none'        this is the newest version
 *   'error'       the check or the download failed (offline, GitHub unreachable…)
 *   'timeout'     no answer to the check in time
 *   'background'  found, but the download stalled, took too long or the user chose to open now
 *   'skip'        the user chose to open now before anything was found
 */

const CHECK_MS = 10e3; // the check itself
const STALL_MS = 30e3; // a download that makes no progress for this long is left to the background
const MAX_MS = 180e3; // nor does the window ever wait longer than this for a download

const firstLine = err => String(err?.message || err || 'unknown error').split('\n')[0].slice(0, 300);

/**
 * autoUpdater: electron-updater's. say(text, percent): what the window shows (percent -1: no bar).
 * skip: a promise that resolves when the user chooses to open the app now.
 */
function updateBeforeOpening({ autoUpdater, say = () => {}, skip = new Promise(() => {}), check = CHECK_MS, stall = STALL_MS, max = MAX_MS }) {
  return new Promise(resolve => {
    let done = false;
    let version = '';
    const timers = { check: 0, stall: 0, max: 0 };
    const listeners = [];
    const on = (ev, fn) => { autoUpdater.on(ev, fn); listeners.push([ev, fn]); };
    const finish = (outcome, extra = {}) => {
      if (done) return;
      done = true;
      for (const t of Object.values(timers)) clearTimeout(t);
      // electron-updater's events are the app updater's from here on (it is made after this).
      for (const [ev, fn] of listeners) autoUpdater.removeListener(ev, fn);
      resolve({ outcome, version, ...extra });
    };
    const progressed = () => {
      clearTimeout(timers.stall);
      timers.stall = setTimeout(() => finish('background'), stall);
    };
    const label = () => (version ? `version ${version}` : 'the update');

    on('update-available', info => {
      version = typeof info?.version === 'string' ? info.version.slice(0, 40) : '';
      clearTimeout(timers.check);
      say(`Downloading ${label()}…`, 0);
      progressed();
      timers.max = setTimeout(() => finish('background'), max);
    });
    on('update-not-available', () => finish('none'));
    on('download-progress', p => {
      const pct = Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0)));
      say(`Downloading ${label()}… ${pct}%`, pct);
      progressed();
    });
    on('update-downloaded', info => {
      if (typeof info?.version === 'string' && info.version) version = info.version.slice(0, 40);
      finish('install');
    });
    on('error', err => finish('error', { error: firstLine(err) }));
    Promise.resolve(skip).then(() => finish(version ? 'background' : 'skip'), () => {});

    say('Checking for updates…', -1);
    timers.check = setTimeout(() => finish('timeout'), check);
    autoUpdater.autoDownload = true;
    Promise.resolve().then(() => autoUpdater.checkForUpdates()).catch(err => finish('error', { error: firstLine(err) }));
  });
}

module.exports = { updateBeforeOpening, CHECK_MS, STALL_MS, MAX_MS };
