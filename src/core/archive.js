'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

/** Extract any archive 7-Zip understands (zip, 7z, rar, ...) into `outDir`. */
function extract(sevenZipPath, archivePath, outDir) {
  return new Promise((resolve, reject) => {
    if (!sevenZipPath || !fs.existsSync(sevenZipPath)) {
      reject(new Error(`7-Zip not found at "${sevenZipPath}". Install 7-Zip or set its path in Settings.`));
      return;
    }
    fs.mkdirSync(outDir, { recursive: true });
    // -y: yes to all, -bb0: quiet listing, -bso0: no stdout, -bsp0: no progress
    const child = spawn(sevenZipPath, ['x', '-y', '-bb0', '-bso0', '-bsp0', `-o${outDir}`, '--', archivePath], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      // 7-Zip exit code 1 = warnings (e.g. some files skipped); treat 2+ as failure.
      if (code === 0 || code === 1) resolve({ warnings: code === 1 ? stderr.trim() : '' });
      else reject(new Error(`7-Zip failed (exit ${code}) extracting ${archivePath}: ${stderr.trim() || 'no details'}`));
    });
  });
}

/** Recursively list files under `dir` as forward-slash paths relative to it. */
function listFiles(dir) {
  const out = [];
  const walk = rel => {
    for (const ent of fs.readdirSync(rel ? `${dir}/${rel}` : dir, { withFileTypes: true })) {
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) out.push(p);
    }
  };
  walk('');
  return out;
}

module.exports = { extract, listFiles };
