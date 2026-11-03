'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scaleFor, stepScale } = require('../src/core/scale');

const fhd = { width: 1920, height: 1032 }; // 1080p work area at 100%, in DIPs

test('Automatic follows Windows: no zoom of its own', () => {
  const r = scaleFor({ want: 0, system: 1.5, area: { width: 1280, height: 688 } });
  assert.strictEqual(r.zoom, 1);
  assert.deepStrictEqual(r.state, { chosen: 0, system: 150, effective: 150, capped: false, max: 178 });
  assert.deepStrictEqual(r.min, { width: 900, height: 580 });
});

test('a chosen scale is used instead of Windows\' own (150% display, 125% chosen = 125%)', () => {
  const r = scaleFor({ want: 125, system: 1.5, area: { width: 1706, height: 917 } });
  assert.ok(Math.abs(r.zoom - 125 / 150) < 1e-9);
  assert.strictEqual(r.state.effective, 125);
  assert.deepStrictEqual(r.min, { width: 750, height: 483 }, 'the minimum window follows, so the layout keeps its 900x580 CSS px');
});

test('a scale too big for the display is capped so the smallest layout still fits', () => {
  const r = scaleFor({ want: 250, system: 1, area: fhd });
  assert.ok(r.state.capped);
  assert.strictEqual(r.state.effective, 178); // 1032 / 580
  assert.ok(r.min.width <= fhd.width && r.min.height <= fhd.height);
  assert.ok(!scaleFor({ want: 175, system: 1, area: fhd }).state.capped);
});

test('Ctrl + / Ctrl - step through the offered scales and stop at the ends', () => {
  assert.strictEqual(stepScale(100, 1), 110);
  assert.strictEqual(stepScale(150, -1), 125);
  assert.strictEqual(stepScale(133, 1), 150, 'from a scale between steps, the next one up');
  assert.strictEqual(stepScale(250, 1), 250);
  assert.strictEqual(stepScale(75, -1), 75);
});
