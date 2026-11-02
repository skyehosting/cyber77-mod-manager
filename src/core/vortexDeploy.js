'use strict';
const fs = require('fs');
const path = require('path');

/*
 * Deploying Vortex mods without Vortex. For Cyberpunk 2077 Vortex hardlinks each mod's staging
 * folder 1:1 into the game folder and records every file in <game>/vortex.deployment.json
 * ({ relPath, source, target: '', time }). Doing the same here keeps that record exact, so Vortex
 * finds everything as it expects the next time it starts.
 *
 * Only the unambiguous part is done here. When two Vortex mods ship the same file, Vortex's own
 * rules decide which one wins; those files are left for Vortex (`deferred`), and the caller marks
 * a deployment as needed so Vortex settles them on its next start.
 */

/** Every file under a mod's staging folder, as Windows-style relative paths. */
function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}\\${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

const sameFile = (a, b) => {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.ino === y.ino && x.dev === y.dev && x.ino !== 0;
  } catch {
    return false;
  }
};

// Folders the game and its frameworks need even when empty.
const KEEP_DIRS = new Set([
  'archive', 'archive\\pc', 'archive\\pc\\mod', 'bin', 'bin\\x64', 'bin\\x64\\plugins',
  'bin\\x64\\plugins\\cyber_engine_tweaks', 'bin\\x64\\plugins\\cyber_engine_tweaks\\mods',
  'r6', 'r6\\scripts', 'r6\\tweaks', 'r6\\config', 'r6\\input', 'red4ext', 'red4ext\\plugins',
  'engine', 'engine\\config', 'engine\\config\\platform', 'engine\\config\\platform\\pc', 'mods',
]);

/**
 * Work out what turning these Vortex mods on or off does to the game folder. Reads only.
 * changes: [{ vortexId, enabled }]. Returns null when the deployment is not a plain hardlink one
 * (then only Vortex can deploy).
 */
function planDeploy({ manifest, gameDir, changes }) {
  if (!manifest || manifest.deploymentMethod !== 'hardlink_activator' || !manifest.stagingPath) return null;
  const staging = manifest.stagingPath;
  const owner = new Map(); // relPath (lower case) -> manifest entry
  for (const f of manifest.files || []) owner.set(f.relPath.toLowerCase(), f);
  const disable = new Set(changes.filter(c => !c.enabled).map(c => c.vortexId));
  const enable = changes.filter(c => c.enabled).map(c => c.vortexId).filter(id => !disable.has(id));
  const live = new Set((manifest.files || []).map(f => f.source));
  // Mods that stay deployed and might also ship a freed file.
  const stays = [...live].filter(s => !disable.has(s) && !enable.includes(s));

  const plan = { remove: [], link: [], deferred: [], keep: [], staging, gameDir };
  const freed = new Map(); // relPath lower -> relPath

  for (const f of manifest.files || []) {
    if (!disable.has(f.source)) continue;
    const target = path.join(gameDir, f.relPath);
    const src = path.join(staging, f.source, f.relPath);
    // A file another tool replaced is left alone (it is no longer Vortex's).
    owner.delete(f.relPath.toLowerCase());
    if (fs.existsSync(target) && !sameFile(target, src)) { plan.keep.push(f); continue; }
    plan.remove.push(f);
    freed.set(f.relPath.toLowerCase(), f.relPath);
  }

  // Which staying mods also ship each freed file (Vortex chose another mod for it before).
  const others = new Map();
  if (freed.size) {
    for (const s of stays) {
      for (const rel of listFiles(path.join(staging, s))) {
        const k = rel.toLowerCase();
        if (freed.has(k)) others.set(k, [...(others.get(k) || []), s]);
      }
    }
  }

  const claimed = new Map(); // relPath lower -> source enabling it in this batch
  for (const id of enable) {
    if (live.has(id)) continue; // already deployed
    for (const rel of listFiles(path.join(staging, id))) {
      const k = rel.toLowerCase();
      const target = path.join(gameDir, rel);
      if (owner.has(k) || claimed.has(k) || others.has(k)) { plan.deferred.push({ relPath: rel, source: id }); continue; }
      // A file that is in the game but not Vortex's (vanilla, this app, a manual install).
      if (fs.existsSync(target) && !freed.has(k)) { plan.deferred.push({ relPath: rel, source: id }); continue; }
      claimed.set(k, id);
      plan.link.push({ relPath: rel, source: id });
    }
  }
  // A freed file exactly one staying mod ships goes to that mod, as Vortex would deploy it.
  for (const [k, rel] of freed) {
    if (claimed.has(k)) continue;
    const by = others.get(k) || [];
    if (by.length === 1) plan.link.push({ relPath: rel, source: by[0] });
    else if (by.length > 1) plan.deferred.push({ relPath: rel, source: by.join(', ') });
  }
  return plan;
}

/** Carry out a plan and rewrite the deployment record. */
function runDeploy(plan, manifest, manifestFile) {
  const removed = new Set([...plan.remove, ...plan.keep].map(f => `${f.source}|${f.relPath}`.toLowerCase()));
  const dirs = new Set();
  for (const f of plan.remove) {
    const target = path.join(plan.gameDir, f.relPath);
    try { fs.unlinkSync(target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    dirs.add(path.dirname(f.relPath));
  }
  const added = [];
  for (const f of plan.link) {
    const src = path.join(plan.staging, f.source, f.relPath);
    const target = path.join(plan.gameDir, f.relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.linkSync(src, target);
    added.push({ relPath: f.relPath, source: f.source, target: '', time: fs.statSync(src).mtimeMs });
  }
  // Empty folders the removed files leave behind go too, as Vortex does.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    let rel = d;
    while (rel && rel !== '.' && !KEEP_DIRS.has(rel.toLowerCase())) {
      try { fs.rmdirSync(path.join(plan.gameDir, rel)); } catch { break; }
      rel = path.dirname(rel);
    }
  }
  const next = {
    ...manifest,
    deploymentTime: Date.now(),
    files: [...(manifest.files || []).filter(f => !removed.has(`${f.source}|${f.relPath}`.toLowerCase())), ...added],
  };
  // Keep the record Vortex wrote last, once, before the first change made here.
  const backup = `${manifestFile}.cmm-backup`;
  if (!fs.existsSync(backup)) fs.copyFileSync(manifestFile, backup);
  const tmp = `${manifestFile}.cmm-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, manifestFile);
  return { linked: added.length, removed: plan.remove.length, deferred: plan.deferred.length, kept: plan.keep.length };
}

module.exports = { planDeploy, runDeploy, listFiles };
