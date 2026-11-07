'use strict';
const path = require('path');
const { Tray, Menu, nativeImage, Notification } = require('electron');

/*
 * Close to the tray (Settings → Interface, on by default): the window's close button hides it and the
 * app keeps running (downloads, Group Mods for friends, the game-log monitor). The tray icon brings it
 * back (click, or Open in its menu); Quit in its menu ends the app. Opening the app again also brings
 * the window back, for Linux desktops that show no tray icons (GNOME without an extension); the first
 * time it hides there, a notification says so.
 *
 * Quitting for real is never held up: app.quit() (Quit, an update installing) and Windows ending the
 * session set `quitting`, and then a close is a close. While the app sits in the tray, an update
 * installs without waiting for the window (main.js: the updater's inView) and the app comes back in
 * the tray (resumeInTray).
 */

function trayImage() {
  if (process.platform === 'win32') return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')); // with its @1.5x/@2x/@3x
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-linux.png')).resize({ width: 24, height: 24, quality: 'best' });
}

function setupTray({ app, settings, title, log, onHide = () => {} }) {
  let tray = null;
  let win = null;
  let quitting = false;
  let inTray = false; // hidden by the close button (not just minimized)
  app.on('before-quit', () => { quitting = true; });

  function show() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** The tray icon there while closing to the tray is on, gone when it is off. */
  function sync() {
    const want = !!settings.get('closeToTray');
    if (want && !tray) {
      try {
        const img = trayImage();
        if (img.isEmpty()) throw new Error('its picture is missing');
        tray = new Tray(img);
        tray.setToolTip(title);
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: `Open ${title}`, click: show },
          { type: 'separator' },
          { label: 'Quit', click: () => app.quit() },
        ]));
        tray.on('click', show);
        tray.on('double-click', show);
      } catch (err) {
        tray = null; // no icon: closing closes, as before
        log?.warn?.('Could not show the tray icon', err.message);
      }
    } else if (!want && tray) {
      tray.destroy();
      tray = null;
      show(); // nothing left to bring it back with
    }
  }

  /** The once-only "still running here" note. Kept as not shown when it could not be shown. */
  function hint() {
    if (settings.get('trayHintShown')) return;
    const text = process.platform === 'win32'
      ? 'Still running here, so downloads and Group Mods keep going. Right-click this icon → Quit to close it. (Settings → Interface turns this off.)'
      : 'Still running, so downloads and Group Mods keep going. Open it from its tray icon, or start it again. To close it: the tray icon → Quit. (Settings → Interface turns this off.)';
    try {
      if (process.platform === 'win32') tray.displayBalloon({ title, content: text, iconType: 'info' });
      else if (Notification.isSupported()) new Notification({ title, body: text }).show();
      else return;
      settings.update({ trayHintShown: true });
    } catch { /* only a hint */ }
  }

  /** Close hides instead (unless the app is quitting or the setting is off). */
  function attach(w, { inTray: startHidden = false } = {}) {
    win = w;
    sync();
    inTray = startHidden && !!tray;
    if (startHidden && !tray) w.show(); // no icon to come back with: show it after all
    w.on('session-end', () => { quitting = true; }); // Windows signing out or shutting down: let it close
    w.on('show', () => { inTray = false; });
    w.on('close', ev => {
      if (quitting || !settings.get('closeToTray') || !tray) return;
      ev.preventDefault();
      inTray = true;
      onHide();
      w.hide();
      hint();
    });
  }

  return { attach, show, sync, isQuitting: () => quitting, inTray: () => inTray && !!win && !win.isDestroyed() && !win.isVisible() };
}

module.exports = { setupTray };
