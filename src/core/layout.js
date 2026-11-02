'use strict';
/**
 * Cyberpunk 2077 install-layout rules. Given the file list of an extracted mod archive, work out
 * where each file belongs relative to the game folder. Mirrors the layouts the community Vortex
 * extension (E1337Kat/cyberpunk2077_ext_redux, src/installers.layouts.ts) recognises:
 *
 *   archive/pc/mod/*.archive|*.xl            Archive / ArchiveXL mods
 *   bin/x64/plugins/cyber_engine_tweaks/mods/<name>/init.lua   CET mods
 *   r6/scripts/<name>/*.reds                 Redscript
 *   r6/tweaks/<name>/*.yaml                  TweakXL
 *   red4ext/plugins/<name>/*.dll             RED4ext plugins
 *   bin/x64/plugins/*.asi                    ASI plugins
 *   mods/<name>/info.json                    REDmod
 *   engine/config/platform/pc/*.ini, r6/input/*.xml   config
 *
 * Archives already laid out from the game root (possibly inside wrapper folders) are kept as-is.
 */

const CET_DIR = 'bin/x64/plugins/cyber_engine_tweaks/mods';
const DOC_EXT = new Set(['.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.url', '.html', '.htm', '.rtf', '.doc', '.docx', '.psd', '.mp4', '.webm']);
const AUDIO_EXT = new Set(['.wav', '.ogg', '.mp3', '.flac']);
const REDMOD_SUBDIRS = new Set(['archives', 'scripts', 'tweaks', 'customsounds']);
// DLLs straight in bin/x64 are proxy loaders (CET's version.dll, RED4ext's winmm.dll, ...).
const LOADER_DLLS = new Set(['version.dll', 'winmm.dll', 'dxgi.dll', 'd3d11.dll', 'dinput8.dll']);

const ext = p => { const b = base(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; };
const base = p => p.slice(p.lastIndexOf('/') + 1);
const dir = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isUnder = (p, d) => d === '' || p.startsWith(`${d}/`);
const relTo = (p, d) => (d === '' ? p : p.slice(d.length + 1));

function sanitizeName(name) {
  return String(name || 'Mod').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Mod';
}

/** Longest common directory of a set of paths. */
function commonDir(paths) {
  if (!paths.length) return '';
  let parts = dir(paths[0]).split('/').filter(Boolean);
  for (const p of paths.slice(1)) {
    const q = dir(p).split('/').filter(Boolean);
    let i = 0;
    while (i < parts.length && i < q.length && parts[i].toLowerCase() === q[i].toLowerCase()) i++;
    parts = parts.slice(0, i);
  }
  return parts.join('/');
}

/**
 * Find where the game-root layout starts in this path, or -1. `lowerSet` is the archive's
 * lower-cased file set (REDmod `mods/` only counts with an info.json beside it).
 */
function rootIndex(segs, lowerSet) {
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i].toLowerCase();
    const next = (segs[i + 1] || '').toLowerCase();
    const isLast = i + 1 === segs.length - 1;
    switch (s) {
      case 'archive': if (next === 'pc' && !isLast) return i; break;
      case 'bin': if (next === 'x64') return i; break;
      case 'engine': if (next === 'config' || next === 'tools') return i; break;
      case 'r6': return i;
      case 'red4ext': return i;
      case 'mods': {
        if (isLast) break;
        const infoJson = [...segs.slice(0, i + 2), 'info.json'].join('/').toLowerCase();
        if (lowerSet.has(infoJson)) return i;
        break;
      }
      default:
    }
  }
  return -1;
}

/**
 * @param {string[]} files  forward-slash paths relative to the extracted archive root
 * @param {string} modName  used to name folders when the archive gives no better name
 * @returns {{ type: string, mappings: {src:string,dest:string}[], skipped: string[], warnings: string[] }}
 */
function planLayout(files, modName) {
  const name = sanitizeName(modName);
  const lowerSet = new Set(files.map(f => f.toLowerCase()));
  const mappings = [];
  const skipped = [];
  const warnings = [];
  let rest = [];

  const take = (src, dest) => mappings.push({ src, dest });

  // 1. Files already laid out from the game root (maybe inside wrapper folders).
  for (const f of files) {
    if (/(^|\/)fomod\//i.test(f)) { skipped.push(f); continue; }
    const segs = f.split('/');
    const idx = rootIndex(segs, lowerSet);
    if (idx >= 0) take(f, segs.slice(idx).join('/'));
    else rest.push(f);
  }

  // 2. REDmod folders: info.json next to archives/ scripts/ tweaks/ customSounds/.
  const redmodDirs = rest
    .filter(f => base(f).toLowerCase() === 'info.json')
    .map(dir)
    .filter(d => rest.some(f => isUnder(f, d) && REDMOD_SUBDIRS.has(relTo(f, d).split('/')[0].toLowerCase()) && relTo(f, d).includes('/')));
  for (const d of shallowest(redmodDirs)) {
    const folder = d ? base(d) : name;
    rest = rest.filter(f => {
      if (!isUnder(f, d)) return true;
      take(f, `mods/${folder}/${relTo(f, d)}`);
      return false;
    });
  }

  // 3. CET mods: a folder holding init.lua (the shallowest one wins; nested init.lua are modules).
  const cetDirs = shallowest(rest.filter(f => base(f).toLowerCase() === 'init.lua').map(dir));
  for (const d of cetDirs) {
    const folder = d ? base(d) : name;
    rest = rest.filter(f => {
      if (!isUnder(f, d)) return true;
      take(f, `${CET_DIR}/${folder}/${relTo(f, d)}`);
      return false;
    });
  }

  // 4. Loose plugins: .asi -> bin/x64/plugins, .dll -> red4ext/plugins/<name>. Non-doc siblings go along.
  const asi = rest.filter(f => ext(f) === '.asi');
  if (asi.length) {
    const dirs = new Set(asi.map(dir));
    rest = rest.filter(f => {
      if (!dirs.has(dir(f)) || DOC_EXT.has(ext(f))) return true;
      take(f, `bin/x64/plugins/${base(f)}`);
      return false;
    });
  }
  const dlls = rest.filter(f => ext(f) === '.dll');
  if (dlls.length) {
    const cd = commonDir(dlls);
    const folder = cd ? base(cd) : name;
    const dllDirs = new Set(dlls.map(dir));
    rest = rest.filter(f => {
      const owned = ext(f) === '.dll' || (dllDirs.has(dir(f)) && !DOC_EXT.has(ext(f)));
      if (!owned) return true;
      take(f, `red4ext/plugins/${folder}/${relTo(f, cd)}`);
      return false;
    });
  }

  // 5. Redscript, TweakXL and audio files, grouped under one folder named after their common dir.
  const groupInto = (pred, targetDir) => {
    const group = rest.filter(pred);
    if (!group.length) return;
    const cd = commonDir(group);
    const folder = cd ? base(cd) : name;
    const set = new Set(group);
    rest = rest.filter(f => !set.has(f));
    for (const f of group) take(f, `${targetDir}/${folder}/${relTo(f, cd)}`);
  };
  groupInto(f => ext(f) === '.reds' || (ext(f) === '.toml' && rest.some(r => ext(r) === '.reds')), 'r6/scripts');
  const hasAudio = rest.some(f => AUDIO_EXT.has(ext(f)));
  if (hasAudio) groupInto(f => AUDIO_EXT.has(ext(f)) || ['.yaml', '.yml'].includes(ext(f)), 'r6/audioware');
  groupInto(f => ['.yaml', '.yml', '.tweak'].includes(ext(f)), 'r6/tweaks');

  // 6. Archives and single config files: flat into their folders.
  rest = rest.filter(f => {
    const e = ext(f);
    if (e === '.archive' || e === '.xl') { take(f, `archive/pc/mod/${base(f)}`); return false; }
    if (e === '.xml') { take(f, `r6/input/${base(f)}`); return false; }
    if (e === '.ini') { take(f, `engine/config/platform/pc/${base(f)}`); return false; }
    return true;
  });

  // 7. Whatever is left is not deployed.
  for (const f of rest) {
    skipped.push(f);
    if (!DOC_EXT.has(ext(f))) warnings.push(`No known place for "${f}"; it was not installed.`);
  }

  // Duplicate destinations (e.g. the same .archive in two variant folders): keep the first, warn.
  const seen = new Map();
  const unique = [];
  for (const m of mappings) {
    const key = m.dest.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`"${m.src}" and "${seen.get(key)}" both install to ${m.dest}; kept the first. This archive may hold variants — use a FOMOD or install the files you want separately.`);
      continue;
    }
    seen.set(key, m.src);
    unique.push(m);
  }

  for (const m of unique) {
    const d = m.dest.toLowerCase();
    if (d.startsWith('bin/x64/') && !d.slice(8).includes('/') && LOADER_DLLS.has(d.slice(8))) {
      warnings.push(`${m.dest} is a loader DLL slot (CET uses version.dll, RED4ext uses winmm.dll). The game's existing file will be backed up and restored on disable.`);
    }
  }

  return { type: describeType(unique.map(m => m.dest)), mappings: unique, skipped, warnings };
}

/** Keep only directories that are not inside another listed directory. */
function shallowest(dirs) {
  const uniq = [...new Set(dirs)].sort((a, b) => a.length - b.length);
  const out = [];
  for (const d of uniq) if (!out.some(o => isUnder(d, o) && d !== o)) out.push(d);
  return out;
}

function describeType(dests) {
  const types = new Set();
  for (const raw of dests) {
    const d = raw.toLowerCase();
    if (d.startsWith(`${CET_DIR}/`)) types.add('CET');
    else if (d.startsWith('mods/')) types.add('REDmod');
    else if (d.startsWith('r6/scripts/')) types.add('Redscript');
    else if (d.startsWith('r6/tweaks/')) types.add('TweakXL');
    else if (d.startsWith('r6/audioware/')) types.add('Audioware');
    else if (d.startsWith('red4ext/')) types.add('RED4ext');
    else if (d.startsWith('archive/')) types.add(d.endsWith('.xl') ? 'ArchiveXL' : 'Archive');
    else if (d.startsWith('bin/x64/plugins/') && !d.slice(16).includes('/')) types.add('ASI');
    else if (d.startsWith('engine/') || d.startsWith('r6/config') || d.startsWith('r6/input')) types.add('Config');
    else types.add('Other');
  }
  if (types.has('ArchiveXL')) types.delete('Archive');
  if (!types.size) return 'Empty';
  const list = [...types];
  return list.length > 3 ? 'Mixed' : list.join(' + ');
}

module.exports = { planLayout, describeType, sanitizeName, commonDir };
