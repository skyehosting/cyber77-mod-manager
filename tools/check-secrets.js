#!/usr/bin/env node
'use strict';
/*
 * Stops a build that would publish a key. Scans every file git tracks (and, when given, a built
 * folder such as dist/win-unpacked/resources) for things shaped like API keys and tokens: a Nexus
 * Mods API key, GitHub tokens, private keys, and settings files with a stored key.
 *   node tools/check-secrets.js [extra folder…]
 * Exit code 1 lists every hit.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PATTERNS = [
  // Nexus personal API keys: long base64 with "--" separators.
  ['Nexus API key', /[A-Za-z0-9+/]{40,}={0,2}--[A-Za-z0-9+/]{8,}={0,2}--[A-Za-z0-9+/]{8,}={0,2}/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['stored API key setting', /"(apiKey|aiKey)(Enc|Plain)"\s*:\s*"[^"]{8,}"/],
  ['AI provider key', /\b(sk-(proj-|ant-)?[A-Za-z0-9_-]{24,})\b/],
  ['Groq key', /\bgsk_[A-Za-z0-9]{40,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['xAI key', /\bxai-[A-Za-z0-9]{40,}\b/],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}\b/],
  ['apikey header value', /apikey['"]?\s*[:=]\s*['"][A-Za-z0-9+/=-]{30,}['"]/i],
];
const SKIP = /\.(png|jpe?g|gif|webp|ico|exe|dll|node|asar|pak|bin|dat|wasm|7z|zip|rar)$/i;

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean).map(f => path.join(ROOT, f));
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const files = [...tracked(), ...process.argv.slice(2).flatMap(d => (fs.existsSync(d) ? walk(path.resolve(d)) : []))];
const hits = [];
for (const f of files) {
  if (SKIP.test(f) || f.endsWith(path.join('tools', 'check-secrets.js'))) continue;
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(`${path.relative(ROOT, f)}: looks like a ${name}`);
}
if (hits.length) {
  console.error(`Secret check FAILED: ${hits.length} hit(s)\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`Secret check passed: ${files.length} files, nothing key-shaped.`);
