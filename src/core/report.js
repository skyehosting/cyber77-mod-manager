'use strict';
const os = require('os');
const { ownerRoot } = require('./gameLogs');

/*
 * One JSON file with everything needed to look into a problem: every error and warning from the
 * game's and mods' logs, grouped and in full, plus every mod with its state. This app's own log
 * (the Game log's Manager tab) is left out: it is a record of what was done here, kept locally.
 */

// Numbers, hex and quoted values differ between repeats of the same message.
const problemKey = e => `${e.level}|${e.source}|${String(e.text).split('\n')[0].toLowerCase().replace(/0x[0-9a-f]+|\d+|"[^"]*"|'[^']*'/g, '#').slice(0, 200)}`;

function group(entries) {
  const map = new Map();
  for (const e of entries) {
    const k = problemKey(e);
    const p = map.get(k);
    if (p) { p.count++; p.lastSeen = Math.max(p.lastSeen, e.time || 0); p.firstSeen = Math.min(p.firstSeen, e.time || 0); } else {
      map.set(k, { level: e.level, source: e.source, file: e.file || '', mod: e.mod || '', text: String(e.text), count: 1, firstSeen: e.time || 0, lastSeen: e.time || 0 });
    }
  }
  return [...map.values()]
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1) || b.count - a.count)
    .map(p => ({ ...p, firstSeen: iso(p.firstSeen), lastSeen: iso(p.lastSeen) }));
}

const iso = t => (t ? new Date(t).toISOString() : null);

function buildReport({ snap, vortex, gameLog, gameStatus, sources, app }) {
  const own = snap.mods || [];
  // Which mod a log line comes from: the mod folders each mod owns, here and in Vortex.
  const byRoot = new Map();
  for (const m of own) for (const r of m.roots || []) byRoot.set(r.toLowerCase(), m.name);
  for (const [file, src] of vortex?.deployedPaths || []) {
    const r = ownerRoot(file);
    if (r && !byRoot.has(r.toLowerCase())) byRoot.set(r.toLowerCase(), `${(vortex.mods || []).find(v => v.vortexId === src)?.name || src} (Vortex)`);
  }
  const tag = e => ({ ...e, mod: e.root ? byRoot.get(e.root.toLowerCase()) || '' : '' });
  const logProblems = (gameLog || []).filter(e => e.level === 'error' || e.level === 'warn').map(tag);

  const logErrorsByMod = {};
  for (const e of logProblems) if (e.mod && e.level === 'error') logErrorsByMod[e.mod] = (logErrorsByMod[e.mod] || 0) + 1;

  const mods = [
    ...own.map(m => ({
      name: m.name, mod: m.modName, managedBy: 'Cyber Mod Manager', enabled: !!m.enabled,
      version: m.version || '', nexusModId: m.modId || null, nexusFileId: m.fileId || null,
      type: m.type, category: m.category, priority: m.priority, files: m.fileCount,
      requiredBy: m.dependencyOf || null, fomod: !!m.fomod,
      installWarnings: m.warnings || [],
      needsRepair: m.health || null,
      conflicts: snap.conflicts?.[m.id] ? { ...snap.conflicts[m.id], with: snap.conflicts[m.id].with.map(id => own.find(x => x.id === id)?.name || id) } : null,
      update: snap.updates?.[m.id] ? { version: snap.updates[m.id].version, file: snap.updates[m.id].fileName } : null,
      logErrors: logErrorsByMod[m.name] || 0,
    })),
    ...(vortex?.mods || []).map(m => ({
      name: m.name, mod: m.modName, managedBy: 'Vortex', enabled: !!m.enabled,
      version: m.version || '', nexusModId: m.modId || null, nexusFileId: m.fileId || null,
      type: m.type, files: m.fileCount,
      update: snap.updates?.[m.id] ? { version: snap.updates[m.id].version, file: snap.updates[m.id].fileName } : null,
      logErrors: logErrorsByMod[`${m.name} (Vortex)`] || 0,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const errors = logProblems.filter(e => e.level === 'error').length;
  const warnings = logProblems.length - errors;
  return {
    report: 'Cyber Mod Manager diagnostics',
    exportedAt: new Date().toISOString(),
    app: { name: 'Cyber Mod Manager', version: app?.version || '', electron: process.versions.electron || null },
    system: { os: `${os.type()} ${os.release()}`, arch: os.arch() },
    game: { folder: snap.game?.path || null, found: !!snap.game?.valid, running: !!gameStatus?.running, since: iso(gameStatus?.since) },
    summary: {
      mods: mods.length,
      enabled: mods.filter(m => m.enabled).length,
      managedByVortex: mods.filter(m => m.managedBy === 'Vortex').length,
      errors,
      warnings,
      modsNeedingRepair: own.filter(m => m.health).length,
      modsWithConflicts: Object.keys(snap.conflicts || {}).length,
      updatesAvailable: Object.keys(snap.updates || {}).length,
    },
    // The same message repeated is one line here, with how often and when.
    problems: group(logProblems),
    mods,
    profiles: {
      active: snap.profiles?.list.find(p => p.id === snap.profiles.active)?.name || null,
      list: (snap.profiles?.list || []).map(p => ({ name: p.name, enabledMods: p.count })),
      vortex: vortex?.installed ? { active: vortex.activeProfileName || null, list: (vortex.profiles || []).map(p => ({ name: p.name, enabledMods: p.enabledIds?.length ?? p.count })) } : null,
    },
    logSources: (sources || []).map(s => ({ name: s.source || s.name, file: s.rel || s.file, followed: !!s.followed })),
    // Every error and warning, in full and in order.
    allErrorsAndWarnings: logProblems.map(e => ({ time: iso(e.time), level: e.level, source: e.source, file: e.file, mod: e.mod || null, text: e.text }))
      .sort((a, b) => String(a.time).localeCompare(String(b.time))),
  };
}

module.exports = { buildReport, problemKey };
