'use strict';

/*
 * The app's scale. Windows gives each display a scale (100%, 125%, 150%…) and Chromium already draws
 * at it. Settings → Display can name another scale to use instead; the window's zoom is then the
 * chosen scale divided by the display's own. The zoom never makes the smallest layout (MIN_CSS) too
 * big for the display, and the window's minimum size grows with it, so the layout is never squeezed.
 */

/** The scales (percent) offered in Settings and stepped through by Ctrl + / Ctrl -. */
const SCALE_STEPS = [75, 90, 100, 110, 125, 150, 175, 200, 225, 250];
/** The smallest layout the window is designed for, in CSS pixels. */
const MIN_CSS = { width: 900, height: 580 };

/**
 * want: the chosen scale in percent (0 = follow Windows). system: the display's scale factor (1.5 at
 * 150%). area: the display's work area in DIPs. Returns the zoom to set, the window's minimum size in
 * DIPs, and what the Display section shows.
 */
function scaleFor({ want, system, area }) {
  const sys = Number(system) > 0 ? Number(system) : 1;
  const fit = Math.min(area.width / MIN_CSS.width, area.height / MIN_CSS.height);
  const asked = want ? want / 100 / sys : 1;
  const zoom = Math.max(0.5, Math.min(asked, fit, 3));
  return {
    zoom,
    min: { width: Math.min(Math.round(MIN_CSS.width * zoom), area.width), height: Math.min(Math.round(MIN_CSS.height * zoom), area.height) },
    state: { chosen: want || 0, system: Math.round(sys * 100), effective: Math.round(zoom * sys * 100), capped: zoom < asked - 0.001, max: Math.round(Math.min(fit, 3) * sys * 100) },
  };
}

/** Ctrl + / Ctrl -: the next scale up or down from the one shown now (percent). */
function stepScale(current, dir) {
  if (dir > 0) return SCALE_STEPS.find(s => s > current + 1) || SCALE_STEPS[SCALE_STEPS.length - 1];
  return [...SCALE_STEPS].reverse().find(s => s < current - 1) || SCALE_STEPS[0];
}

module.exports = { scaleFor, stepScale, SCALE_STEPS, MIN_CSS };
