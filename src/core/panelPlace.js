'use strict';

/*
 * Where the floating AI settings window goes. Pure: the displays' work areas and the app window's
 * bounds come in (Electron's screen and BrowserWindow), so this can be tested without either.
 */

const SIZE = { width: 360, height: 680 };

/** Beside the app window's right edge, inside the work area of the display the app is on. */
function homeBounds(appBounds, area, size = SIZE) {
  const width = Math.min(size.width, area.width - 16);
  const height = Math.min(size.height, area.height - 16);
  const x = Math.max(area.x + 8, Math.min(appBounds.x + appBounds.width - width - 24, area.x + area.width - width - 8));
  const y = Math.max(area.y + 8, Math.min(appBounds.y + 72, area.y + area.height - height - 8));
  return { x, y, width, height };
}

/**
 * Whether a display still shows enough of the window to grab it: 100 pixels of its width, and its
 * whole title bar (32 pixels) inside one display's work area.
 */
function onScreen(b, areas) {
  if (!b || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k]))) return false;
  return areas.some(a => {
    const overlap = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    return overlap >= 100 && b.y >= a.y - 4 && b.y + 32 <= a.y + a.height;
  });
}

/**
 * Kept bounds made to fit the display they are on: no larger than it (and not below the window's
 * minimum), moved so all of it is inside. A file edited by hand, or a display that shrank, cannot
 * give a window larger than the screen with its buttons out of reach.
 */
function fitBounds(b, area, min = { width: 300, height: 360 }) {
  const width = Math.round(Math.max(Math.min(b.width, area.width), Math.min(min.width, area.width)));
  const height = Math.round(Math.max(Math.min(b.height, area.height), Math.min(min.height, area.height)));
  const x = Math.round(Math.min(Math.max(b.x, area.x), area.x + area.width - width));
  const y = Math.round(Math.min(Math.max(b.y, area.y), area.y + area.height - height));
  return { x, y, width, height };
}

module.exports = { homeBounds, onScreen, fitBounds, SIZE };
