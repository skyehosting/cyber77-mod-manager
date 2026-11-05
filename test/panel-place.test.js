'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { homeBounds, onScreen, fitBounds } = require('../src/core/panelPlace');

/* The floating AI settings window: its home beside the app, and when it counts as lost off-screen. */

const main = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 2560, height: 1400 };

test('home: inside the app\'s right edge, below its header, inside the display; small displays shrink it', () => {
  assert.deepStrictEqual(homeBounds({ x: 100, y: 50, width: 1600, height: 900 }, main), { x: 1316, y: 122, width: 360, height: 680 });
  // The app at the display's right edge: kept 8 px inside it.
  assert.deepStrictEqual(homeBounds({ x: 1000, y: 0, width: 920, height: 1040 }, main), { x: 1536, y: 72, width: 360, height: 680 });
  // A small display: the window fits in it.
  const small = homeBounds({ x: 0, y: 0, width: 800, height: 500 }, { x: 0, y: 0, width: 800, height: 560 });
  assert.ok(small.height <= 560 - 16 && small.y + small.height <= 560 - 8 && small.y >= 8);
  // On the second display (to the right): there, not on the first.
  const on2 = homeBounds({ x: 2200, y: 100, width: 1800, height: 1000 }, second);
  assert.ok(on2.x >= second.x + 8 && on2.x + on2.width <= second.x + second.width - 8);
});

test('on screen: anywhere a display shows its title bar and 100 px of it; lost when that display is gone', () => {
  const onSecond = { x: 3000, y: 200, width: 360, height: 680 };
  assert.strictEqual(onScreen(onSecond, [main, second]), true, 'dragged onto the other monitor');
  assert.strictEqual(onScreen(onSecond, [main]), false, 'that monitor unplugged: back home');
  assert.strictEqual(onScreen({ x: 1880, y: 100, width: 360, height: 680 }, [main]), false, 'only 40 px left on screen: cannot be grabbed');
  assert.strictEqual(onScreen({ x: 1800, y: 100, width: 360, height: 680 }, [main]), true, '120 px still there');
  assert.strictEqual(onScreen({ x: 100, y: -50, width: 360, height: 680 }, [main]), false, 'title bar above the top');
  assert.strictEqual(onScreen({ x: 100, y: 1020, width: 360, height: 680 }, [main]), false, 'title bar below the bottom');
  assert.strictEqual(onScreen({ x: 'a', y: 0, width: 1, height: 1 }, [main]), false);
  assert.strictEqual(onScreen(null, [main]), false);
});

test('kept bounds that are too big, too small or half off the display are made to fit it', () => {
  assert.deepStrictEqual(fitBounds({ x: -90000, y: 10, width: 99999, height: 99999 }, main), { x: 0, y: 0, width: 1920, height: 1040 }, 'a hand-edited file: the screen at most');
  assert.deepStrictEqual(fitBounds({ x: 1800, y: 900, width: 360, height: 680 }, main), { x: 1560, y: 360, width: 360, height: 680 }, 'moved fully onto it');
  assert.deepStrictEqual(fitBounds({ x: 100, y: 100, width: 50, height: 50 }, main), { x: 100, y: 100, width: 300, height: 360 }, 'not below its minimum');
  assert.deepStrictEqual(fitBounds({ x: 100, y: 100, width: 50, height: 50 }, main, { width: 600, height: 720 }), { x: 100, y: 100, width: 600, height: 720 }, 'the minimum grows with the app\'s zoom');
  assert.deepStrictEqual(fitBounds({ x: 3000, y: 200, width: 360, height: 680 }, second), { x: 3000, y: 200, width: 360, height: 680 }, 'already fine: unchanged');
});
