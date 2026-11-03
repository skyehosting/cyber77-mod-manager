'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/*
 * The window's scripts are classic scripts sharing one scope, run in the order index.html lists
 * them. A top-level statement that uses a `const`/`let` declared further down (in the same file or
 * a later one) throws when the window loads, and everything after it in that file never runs.
 */
test('no window script uses a top-level const/let before it is declared', () => {
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const files = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(files.includes('app.js') && files.length > 3);
  const lines = files.flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).map((text, i) => ({ f, n: i + 1, text })));
  const declaredAt = new Map();
  lines.forEach((l, i) => {
    const m = l.text.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i);
  });
  const early = [];
  lines.forEach((l, i) => {
    // Statements that run as the script loads start at column 0 (function bodies are indented).
    const m = l.text.match(/^([A-Za-z_$][\w$]*)\s*[.([]/) || l.text.match(/^(?:const|let)\s+[\w$]+\s*=\s*([A-Za-z_$][\w$]*)\s*[.([]/);
    if (m && declaredAt.has(m[1]) && declaredAt.get(m[1]) > i) early.push(`${l.f}:${l.n} uses ${m[1]} before ${lines[declaredAt.get(m[1])].f}:${lines[declaredAt.get(m[1])].n}`);
  });
  assert.deepStrictEqual(early, []);
});

test('no window script uses $(…) (one element) as a list: that is $$(…)', () => {
  // $ finds one element, $$ all of them. A $(...).forEach throws as the page opens.
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  const wrong = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/(^|[^$\w])\$\((['`])[^'`]*\2\)\.(forEach|map|filter|some|every|find|slice)\(/.test(line)) wrong.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(wrong, []);
});

test('no replaceChildren(…) / append(…) gets a child that can be null (it shows as the word "null")', () => {
  // h() skips null children; the DOM's own replaceChildren and append print them. Each argument
  // at the top level of such a call must not be a "cond ? x : null" (filter(Boolean) a list instead).
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  const wrong = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /\.(replaceChildren|append|prepend)\(/g;
    let m;
    while ((m = re.exec(src))) {
      // The call's arguments, split at its top-level commas (strings and nested brackets skipped).
      let depth = 0; let i = m.index + m[0].length; let quote = ''; let start = i; const args = [];
      for (; i < src.length; i++) {
        const c = src[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) { if (depth === 0) { args.push(src.slice(start, i)); break; } depth--; } else if (c === ',' && depth === 0) { args.push(src.slice(start, i)); start = i + 1; }
      }
      if (args.some(a => /\?[\s\S]*:\s*null\s*$/.test(a.trim()))) wrong.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepStrictEqual(wrong, []);
});
