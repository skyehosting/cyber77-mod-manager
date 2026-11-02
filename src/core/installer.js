'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extract, listFiles } = require('./archive');
const { planLayout, describeType } = require('./layout');
const { loadFomod } = require('./fomodParse');
const Fomod = require('../shared/fomod');

const isSafeRel = p => !!p && !path.isAbsolute(p) && !/^[a-z]:/i.test(p) && !p.split('/').includes('..');

/**
 * Turns a downloaded archive into a staged mod folder laid out relative to the game root.
 * Two phases so the UI can show a FOMOD wizard in between: prepare() extracts and inspects,
 * plan()/stage() build the final file set.
 */
class Installer {
  constructor({ getSevenZip, tempDir, log }) {
    this.getSevenZip = getSevenZip;
    this.tempDir = tempDir;
    this.log = log;
    this.sessions = new Map();
  }

  async prepare(archivePath) {
    const token = crypto.randomBytes(8).toString('hex');
    const extractDir = path.join(this.tempDir(), token);
    const { warnings } = await extract(this.getSevenZip(), archivePath, extractDir);
    if (warnings) this.log.warn(`7-Zip reported warnings for ${path.basename(archivePath)}`, warnings);
    const files = listFiles(extractDir);
    if (!files.length) throw new Error(`${path.basename(archivePath)} is empty or could not be read.`);
    let fomod = null;
    try {
      fomod = loadFomod(extractDir, files);
    } catch (err) {
      this.log.warn(`FOMOD installer in ${path.basename(archivePath)} could not be read; using automatic layout instead`, err.message);
    }
    if (fomod && !fomod.config.steps.length && !fomod.config.requiredFiles.length && !fomod.config.conditional.length) fomod = null;
    const session = { token, extractDir, files, fomod };
    this.sessions.set(token, session);
    return session;
  }

  /** FOMOD file states: whether files a dependency names exist in the game folder. */
  fileStates(session, gameDir) {
    const states = {};
    const walk = c => {
      if (!c) return;
      for (const it of c.items) {
        if (it.items) walk(it);
        else if ('file' in it && gameDir) {
          states[it.file.toLowerCase()] = fs.existsSync(path.join(gameDir, it.file)) ? 'Active' : 'Missing';
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
