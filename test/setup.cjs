// Loaded before every test file: tests never read the real Vortex install.
process.env.CMM_VORTEX_APPDATA = '';

// Every temporary folder a test makes goes when its test file is done (they used to pile up in %TEMP%).
const fs = require('fs');
const made = [];
const mkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = (...args) => { const dir = mkdtempSync(...args); made.push(dir); return dir; };
process.on('exit', () => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } } });
