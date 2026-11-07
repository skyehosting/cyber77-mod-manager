'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extract, listFiles, unpackedSize } = require('./archive');
const { planLayout, describeType } = require('./layout');
const { loadFomod } = require('./fomodParse');
const { caseResolver } = require('./fileCase');
const Fomod = require('../shared/fomod');

// Archives inside a download that are unpacked when nothing else in it is a mod (Installer.unpackInner).
const INNER_ARCHIVE = /\.(7z|zip|rar)$/i;
const MAX_INNER = 200;
const MAX_INNER_BYTES = 16 * 2 ** 30; // what they may unpack to, together

const isSafeRel = p => !!p && !path.isAbsolute(p) && !/^[a-z]:/i.test(p) && !p.split('/').includes('..');

/**
 * Turns a downloaded archive into a staged mod folder laid out relative to the game root.
 * Two phases so the UI can show a FOMOD wizard in between: prepare() extracts and inspects,
 * plan()/stage() build the final file set.
 */
class Installer {
  constructor({ getSevenZip, tempDir, log, maxInnerBytes = MAX_INNER_BYTES }) {
    this.getSevenZip = getSevenZip;
    this.maxInnerBytes = maxInnerBytes;
    this.tempDir = tempDir;
    this.log = log;
    this.sessions = new Map();
  }

  async prepare(archivePath) {
    const token = crypto.randomBytes(8).toString('hex');
    const extractDir = path.join(this.tempDir(), token);
    const { warnings } = await extract(this.getSevenZip(), archivePath, extractDir);
    if (warnings) this.log.warn(`7-Zip reported warnings for ${path.basename(archivePath)}`, warnings);
    let files = listFiles(extractDir);
    if (!files.length) throw new Error(`${path.basename(archivePath)} is empty or could not be read.`);
    let unpacked = 0;
    try { unpacked = await this.unpackInner(archivePath, extractDir, files); } catch (err) { fs.rmSync(extractDir, { recursive: true, force: true }); throw err; }
    if (unpacked) files = listFiles(extractDir);
    let fomod = null;
    try {
      fomod = loadFomod(extractDir, files);
    } catch (err) {
      this.log.warn(`FOMOD installer in ${path.basename(archivePath)} could not be read; using automatic layout instead`, err.message);
    }
    if (fomod && !fomod.config.steps.length && !fomod.config.requiredFiles.length && !fomod.config.conditional.length) fomod = null;
    const session = { token, extractDir, files, fomod, unpacked };
    this.sessions.set(token, session);
    return session;
  }

  /**
   * An archive of archives ("All-in-One" downloads: one .7z per item, each with its .archive files):
   * when nothing else in it is a mod's file, the archives inside are unpacked, each into a folder of its
   * name beside it, and the files looked at again. One level only, at most MAX_INNER of them. An
   * archive that is a mod already (optional extras zipped inside) is left as it is. Returns how many.
   * All or nothing: inner archives that would take more than MAX_INNER_BYTES, or one that can't be
   * unpacked, stop it with an error (never a mod installed with some of its parts missing).
   */
  async unpackInner(archivePath, extractDir, files) {
    const name = path.basename(archivePath);
    const inner = files.filter(f => INNER_ARCHIVE.test(f));
    if (!inner.length) return 0;
    if (planLayout(files.filter(f => !INNER_ARCHIVE.test(f)), '').mappings.length) return 0;
    if (files.some(f => /(^|\/)fomod\/moduleconfig\.xml$/i.test(f))) return 0; // a FOMOD installer says what goes where
    if (inner.length > MAX_INNER) { this.log.warn(`${name} holds ${inner.length} archives: more than ${MAX_INNER}, so they are not unpacked`); return 0; }
    const sevenZip = this.getSevenZip();
    // The size they unpack to, before anything is unpacked (an archive bomb fills no drive).
    let bytes = 0;
    for (const rel of inner) {
      try { bytes += await unpackedSize(sevenZip, path.join(extractDir, rel)); } catch (err) { throw new Error(`${rel} inside ${name} could not be read (${err.message}).`); }
      if (bytes > this.maxInnerBytes) throw new Error(`The ${inner.length} archives inside ${name} would take more than ${+(this.maxInnerBytes / 2 ** 30).toFixed(2)} GB unpacked; not installed.`);
    }
    const made = [];
    try {
      for (const rel of inner) {
        const src = path.join(extractDir, rel);
        // A folder named after the inner archive, beside it, never outside extractDir ("..7z" and the like).
        const stem = path.basename(src).replace(INNER_ARCHIVE, '').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
        const base = path.join(path.dirname(src), stem && !/^[. ]*$/.test(stem) ? stem : 'unpacked');
        let dest = base;
        for (let i = 2; fs.existsSync(dest); i++) dest = `${base} (${i})`;
        const inside = path.relative(extractDir, dest);
        if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`${rel} has a name that can't be unpacked safely.`);
        made.push(dest);
        const { warnings } = await extract(sevenZip, src, dest);
        if (warnings) this.log.warn(`7-Zip reported warnings for ${rel} inside ${name}`, warnings);
        try { fs.rmSync(src, { force: true }); } catch { /* left: an archive is never installed */ }
      }
    } catch (err) {
      for (const d of made) fs.rmSync(d, { recursive: true, force: true });
      throw new Error(`${name} holds ${inner.length} archives, and one of them could not be unpacked: ${err.message}`);
    }
    this.log.info(`${name} holds ${inner.length} archives: unpacked them to find the mod's files`);
    return inner.length;
  }

  /** FOMOD file states: whether files a dependency names exist in the game folder. */
  fileStates(session, gameDir) {
    const states = {};
    const where = gameDir ? caseResolver(gameDir) : null; // whatever case the installer spells it in
    const walk = c => {
      if (!c) return;
      for (const it of c.items) {
        if (it.items) walk(it);
        else if ('file' in it && gameDir) {
          // Only paths inside the game folder are looked at (an installer's XML names them).
          const rel = String(it.file).replace(/\\/g, '/');
          states[it.file.toLowerCase()] = isSafeRel(rel) && where.exists(rel) ? 'Active' : 'Missing';
        }
      }
    };
    const cfg = session.fomod?.config;
    if (cfg) {
      cfg.steps.forEach(s => { walk(s.visible); s.groups.forEach(g => g.plugins.forEach(p => p.typeDesc.patterns.forEach(pt => walk(pt.cond)))); });
      cfg.conditional.forEach(c => walk(c.cond));
    }
    return states;
  }

  /** Work out source → destination mappings, via the FOMOD selections when given. */
  plan(session, modName, fomodSelections, fileStates) {
    if (session.fomod && fomodSelections) return this.planFomod(session, fomodSelections, fileStates);
    return planLayout(session.files, modName);
  }

  planFomod(session, selections, fileStates) {
    const { basePath, config } = session.fomod;
    const warnings = [];
    const under = basePath ? session.files.filter(f => f.startsWith(`${basePath}/`)).map(f => f.slice(basePath.length + 1)) : session.files;
    const lower = new Map(under.map(f => [f.toLowerCase(), f]));
    const out = new Map();
    const full = rel => (basePath ? `${basePath}/${rel}` : rel);

    for (const e of Fomod.resolveEntries(config, selections, fileStates)) {
      if (e.kind === 'file') {
        const hit = lower.get(e.source.toLowerCase());
        if (!hit) { warnings.push(`FOMOD names a file the archive does not have: ${e.source}`); continue; }
        let dest = e.destination;
        if (!dest) dest = path.posix.basename(hit);
        out.set(dest.toLowerCase(), { src: full(hit), dest });
      } else {
        const prefix = e.source ? `${e.source.toLowerCase()}/` : '';
        let n = 0;
        for (const [lf, f] of lower) {
          if (!lf.startsWith(prefix) || /^fomod\//.test(lf)) continue;
          const rel = f.slice(prefix.length);
          const dest = e.destination ? `${e.destination}/${rel}` : rel;
          out.set(dest.toLowerCase(), { src: full(f), dest });
          n++;
        }
        if (!n) warnings.push(`FOMOD names a folder the archive does not have: ${e.source || '(root)'}`);
      }
    }
    const mappings = [...out.values()];
    return { type: `${describeType(mappings.map(m => m.dest))} (FOMOD)`, mappings, skipped: [], warnings };
  }

  /** Copy the planned files into `stagingDir`. Returns the destination list. */
  stage(session, plan, stagingDir) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    const files = [];
    for (const m of plan.mappings) {
      const dest = m.dest.replace(/\\/g, '/');
      if (!isSafeRel(dest)) {
        plan.warnings.push(`Refused unsafe path in archive: ${dest}`);
        continue;
      }
      const target = path.join(stagingDir, dest);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(session.extractDir, m.src), target);
      files.push(dest);
    }
    return files;
  }

  release(token) {
    const s = this.sessions.get(token);
    if (!s) return;
    this.sessions.delete(token);
    fs.rm(s.extractDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { isSafeRel, Installer };
