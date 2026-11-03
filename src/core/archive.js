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

/** Run 7-Zip; resolves on exit code 0 or 1 (warnings). */
function run7z(sevenZipPath, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!sevenZipPath || !fs.existsSync(sevenZipPath)) {
      reject(new Error(`7-Zip not found at "${sevenZipPath}". Install 7-Zip or set its path in Settings.`));
      return;
    }
    const child = spawn(sevenZipPath, args, { windowsHide: true, ...opts });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 || code === 1 ? resolve() : reject(new Error(`7-Zip failed (exit ${code}): ${stderr.trim() || 'no details'}`))));
  });
}

/** Zip everything in `srcDir` into `outFile` (stored, not recompressed: mod archives are already compressed). */
async function pack(sevenZipPath, srcDir, outFile) {
  fs.rmSync(outFile, { force: true });
  await run7z(sevenZipPath, ['a', '-tzip', '-mx=0', '-y', '-bso0', '-bsp0', outFile, '*'], { cwd: srcDir });
}

/** The file paths inside an archive (7-Zip's technical listing: one "Path = …" per entry). */
function list(sevenZipPath, archivePath) {
  return new Promise((resolve, reject) => {
    if (!sevenZipPath || !fs.existsSync(sevenZipPath)) { reject(new Error(`7-Zip not found at "${sevenZipPath}".`)); return; }
    const child = spawn(sevenZipPath, ['l', '-ba', '-slt', '--', archivePath], { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0 && code !== 1) { reject(new Error(`7-Zip could not list ${archivePath} (exit ${code})`)); return; }
      const paths = [];
      let folder = false;
      let p = '';
      for (const line of `${out}\n`.split(/\r?\n/)) {
        if (line.startsWith('Path = ')) { if (p && !folder) paths.push(p); p = line.slice(7); folder = false; }
        else if (/^Folder = \+/.test(line) || /^Attributes = D/.test(line)) folder = true;
      }
      if (p && !folder) paths.push(p);
      resolve(paths.map(x => x.replace(/\\/g, '/')));
    });
  });
}

/** Extract only these files (by their path inside the archive) into `outDir`; missing ones are skipped. */
async function extractSome(sevenZipPath, archivePath, outDir, names) {
  fs.mkdirSync(outDir, { recursive: true });
  await run7z(sevenZipPath, ['x', '-y', '-bso0', '-bsp0', `-o${outDir}`, '--', archivePath, ...names]);
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

module.exports = { extract, listFiles, pack, extractSome, list };
