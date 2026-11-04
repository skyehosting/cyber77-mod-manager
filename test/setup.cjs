// Loaded before every test file: tests never read the real Vortex or Mod Organizer 2.
process.env.CMM_VORTEX_APPDATA = '';
process.env.CMM_MO2_LOCALAPPDATA = '';
process.env.CMM_MO2_SCAN = 'off';
// …nor the real Cyberpunk saves, nor the real save backups.
process.env.CMM_SAVES_DIR = require('path').join(require('os').tmpdir(), 'cmm-test-no-saves');
process.env.CMM_SAVE_BACKUPS_DIR = require('path').join(require('os').tmpdir(), 'cmm-test-no-save-backups');
process.env.CMM_PROFILE_SAVES_DIR = require('path').join(require('os').tmpdir(), 'cmm-test-no-profile-saves');

// Every temporary folder a test makes goes when its test file is done (they used to pile up in %TEMP%).
const fs = require('fs');
const made = [];
const mkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = (...args) => { const dir = mkdtempSync(...args); made.push(dir); return dir; };
process.on('exit', () => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } } });
