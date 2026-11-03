'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

// Files no test loads (main.js, preload.js, the window's scripts) still have to parse: a syntax
// error there only shows when the app starts.
test('every source file parses', () => {
  const bad = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) {
        try { new vm.Script(Module.wrap(fs.readFileSync(full, 'utf8')), { filename: full }); } catch (err) { bad.push(`${path.relative(path.join(__dirname, '..'), full)}: ${err.message}`); }
      }
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  assert.deepStrictEqual(bad, []);
});
