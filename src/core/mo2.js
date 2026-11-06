'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { parseIni, iniGet, iniArray } = require('./qtIni');
const { listFiles } = require('./vortexDeploy');
const { describeType } = require('./layout');

/*
 * Mod Organizer 2, read only. MO2 never puts its mods in the game folder (it overlays them for
 * programs it starts), and it rewrites its own files from memory while it runs, so this app never
 * writes into an MO2 instance: it reads its profiles and mods, and copies (hardlinks) mods out.
 * Formats and sources: notes/mo2.md.
 *
 *   %LOCALAPPDATA%\ModOrganizer\<instance>\ModOrganizer.ini   a global instance
 *   <MO2 folder>\ModOrganizer.ini (beside ModOrganizer.exe)    a portable instance
 *   <base>\profiles\<profile>\modlist.txt                      +on / -off, highest priority first
 *   <base>\mods\<mod>\meta.ini                                  Nexus ids, version, its archive
 */

const GAME_NAME = 'cyberpunk 2077';
// meta.ini nexusFileStatus → the Nexus file category (nexusinterface.h FileStatus).
const FILE_STATUS = { 1: 'MAIN', 2: 'UPDATE', 3: 'OPTIONAL', 4: 'OLD_VERSION', 5: 'MISCELLANEOUS', 7: 'ARCHIVED' };

const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readIni = f => { const t = readText(f); return t === null ? null : parseIni(t); };
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const isSeparator = name => /_separator$/.test(name);
const isBackup = name => /backup[0-9]*$/.test(name);

/** The lines of a modlist.txt: [{ name, enabled }], highest priority first, as MO2 reads them. */
function parseModlist(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let enabled = true;
    let name = line;
    if (line[0] === '-') { enabled = false; name = line.slice(1).trim(); }
    else if (line[0] === '+') name = line.slice(1).trim();
    else if (line[0] === '*') continue; // a foreign entry (DLC): not a mod folder
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, enabled });
  }
  return out;
}

/** Where a file in an MO2 mod folder goes in the game: root/… (RootBuilder) is the game root. */
function gamePathOf(rel) {
  const r = rel.replace(/\//g, '\\');
  return /^root\\/i.test(r) ? r.slice(5) : r;
}

class Mo2Bridge extends EventEmitter {
  /**
   * localAppData: where global instances live (tests point it elsewhere).
   * extraFolders(): folders the user added (an MO2 folder or an instance folder).
   * scan: also look in MO2's default folder and where its download handler is registered.
   */
  constructor({ log, localAppData = process.env.LOCALAPPDATA || '', extraFolders = () => [], scan = true }) {
    super();
    this.log = log;
    this.globalRoot = localAppData ? path.join(localAppData, 'ModOrganizer') : '';
    this.extraFolders = extraFolders;
    this.scan = scan;
    this.programFolders = []; // MO2 program folders found by discover()
    this.cache = null;
    this.sig = '';
    this.readAt = 0;
  }

  /**
   * Find MO2 program folders, once, in the background. MO2's installer writes no uninstall entry,
   * and a portable MO2 (unpacked by hand, or by Wabbajack) none at all, so the traces are:
   *   - the nxm link handler, when MO2 holds it
   *   - the installer's Start Menu shortcut ("Mod Organizer", all users)
   *   - Windows' records of programs that ran (MuiCache, Compatibility Assistant Store)
   *   - common folders on each local drive: \Modding\MO2 (the installer's default), \MO2,
   *     \Mod Organizer 2, \Games\…, and the lists in \Modlists or \Wabbajack (Wabbajack's MO2s)
   * Records can outlive the program, so only folders that still hold ModOrganizer.exe are kept.
   */
  async discover() {
    if (!this.scan) return;
    const run = (file, args) => new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 30000, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? '' : String(out))));
    const found = [];
    for (const key of ['HKCU\\Software\\Classes\\nxm\\shell\\open\\command', 'HKCR\\nxm\\shell\\open\\command']) {
      const m = (await run('reg', ['query', key, '/ve'])).match(/"([^"]*nxmhandler\.exe)"/i);
      if (m) found.push(path.dirname(m[1]));
    }
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '$out = New-Object System.Collections.Generic.List[string]',
      '$sh = New-Object -ComObject WScript.Shell',
      'foreach ($root in @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")) {',
      "  Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -Depth 2 | ForEach-Object { $t = $sh.CreateShortcut($_.FullName).TargetPath; if ($t -like '*\\ModOrganizer.exe') { $out.Add((Split-Path $t)) } }",
      '}',
      "foreach ($key in @('HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache', 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Compatibility Assistant\\Store')) {",
      "  (Get-Item -LiteralPath $key).GetValueNames() | Where-Object { $_ -match '\\\\ModOrganizer\\.exe(\\.FriendlyAppName)?$' } | ForEach-Object { $out.Add((Split-Path ($_ -replace '\\.FriendlyAppName$', ''))) }",
      '}',
      "foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID) {",
      "  foreach ($rel in 'Modding\\MO2', 'Modding\\Mod Organizer 2', 'MO2', 'Mod Organizer 2', 'ModOrganizer2', 'Games\\MO2', 'Games\\Mod Organizer 2') { $out.Add(\"$d\\$rel\") }",
      "  foreach ($p in 'Modlists', 'Wabbajack', 'Modding') { Get-ChildItem -LiteralPath \"$d\\$p\" -Directory | ForEach-Object { $out.Add($_.FullName) } }",
      '}',
      '$out | Sort-Object -Unique',
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const listed = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
    found.push(...listed.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    const seen = new Set();
    this.programFolders = found.filter(f => {
      const k = f.toLowerCase().replace(/[\\/]+$/, '');
      if (seen.has(k) || !path.isAbsolute(f)) return false;
      seen.add(k);
      return fs.existsSync(path.join(f, 'ModOrganizer.exe'));
    });
    this.cache = null;
  }

  /** Every ModOrganizer.ini worth reading: global instances, portable ones, the user's folders. */
  iniFiles() {
    const out = new Map();
    const add = (f, portable) => { if (fs.existsSync(f) && !out.has(norm(f))) out.set(norm(f), { file: f, portable }); };
    if (this.globalRoot) {
      let dirs = [];
      try { dirs = fs.readdirSync(this.globalRoot, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { /* no global instances */ }
      for (const d of dirs) add(path.join(this.globalRoot, d.name, 'ModOrganizer.ini'), false);
    }
    const folders = [...(this.extraFolders() || [])];
    if (this.scan) {
      folders.push(path.join(process.env.SystemDrive || 'C:', '\\Modding', 'MO2'), ...this.programFolders);
      // MO2's download handler lists every MO2 it was registered for.
      for (const name of ['nxmhandler.ini', 'downloadhandler.ini']) {
        const ini = this.globalRoot && readIni(path.join(this.globalRoot, name));
        if (ini) for (const h of iniArray(ini, 'handlers')) if (h.executable) folders.push(path.dirname(h.executable));
      }
    }
    for (const f of folders) if (f && typeof f === 'string') add(path.join(f, 'ModOrganizer.ini'), fs.existsSync(path.join(f, 'ModOrganizer.exe')));
    return [...out.values()];
  }

  /** One instance's settings, or null when it is not a Cyberpunk 2077 instance. */
  readInstance({ file, portable }) {
    const ini = readIni(file);
    if (!ini || iniGet(ini, 'General', 'gameName').trim().toLowerCase() !== GAME_NAME) return null;
    const dir = path.dirname(file);
    const baseRaw = iniGet(ini, 'Settings', 'base_directory', dir).replace(/\//g, '\\');
    const base = path.resolve(dir, baseRaw);
    const sub = (key, name) => path.resolve(dir, iniGet(ini, 'Settings', key, `%BASE_DIR%/${name}`).replace(/%BASE_DIR%/gi, base).replace(/\//g, '\\'));
    const name = portable ? `Portable (${path.basename(dir)})` : path.basename(dir);
    return {
      id: crypto.createHash('sha1').update(norm(file)).digest('hex').slice(0, 10),
      name, portable, iniFile: file, dir, base,
      gamePath: iniGet(ini, 'General', 'gamePath'),
      selectedProfile: iniGet(ini, 'General', 'selected_profile', 'Default'),
      modsDir: sub('mod_directory', 'mods'),
      downloadsDir: sub('download_directory', 'downloads'),
      profilesDir: sub('profiles_directory', 'profiles'),
    };
  }

  /** A mod folder: its Nexus details, files (as game paths) and archive. */
  readMod(inst, folder) {
    const dir = path.join(inst.modsDir, folder);
    const meta = readIni(path.join(dir, 'meta.ini'));
    const g = k => (meta ? iniGet(meta, 'General', k) : '');
    // MO2 records where a mod came from ("repository"): ids from anywhere but Nexus are not Nexus ids.
    const elsewhere = !!g('repository') && !/^nexus$/i.test(g('repository'));
    let modId = !elsewhere && Number(g('modid')) > 0 ? Number(g('modid')) : 0;
    // The installed Nexus file: the newest (last) pair recorded for this mod.
    const pairs = meta && !elsewhere ? iniArray(meta, 'installedFiles').filter(p => Number(p.fileid) > 0) : [];
    const pair = [...pairs].reverse().find(p => !modId || Number(p.modid) === modId) || null;
    let fileId = pair ? Number(pair.fileid) : 0;
    if (!modId && pair) modId = Number(pair.modid) || 0;
    // Its archive, when MO2 still has it: a name in the downloads folder, or a full path.
    const inst_ = g('installationFile');
    let archive = '';
    if (inst_) {
      const p = /^([a-z]:[\\/]|[\\/]{2})/i.test(inst_) ? inst_ : path.join(inst.downloadsDir, inst_);
      if (fs.existsSync(p)) archive = p;
    }
    const dl = archive && !elsewhere ? readIni(`${archive}.meta`) : null;
    const d = k => (dl ? iniGet(dl, 'General', k) : '');
    if (!fileId && Number(d('fileID')) > 0 && (!modId || Number(d('modID')) === modId)) fileId = Number(d('fileID'));
    if (!modId && Number(d('modID')) > 0) modId = Number(d('modID'));
    return {
      id: `mo2:${inst.id}:${folder}`,
      folder,
      dir,
      name: folder,
      modName: d('modName') || folder,
      modId, fileId,
      version: g('version') || d('version') || '',
      author: g('author') || d('author') || '',
      category: FILE_STATUS[Number(g('nexusFileStatus'))] || 'MAIN',
      archive,
    };
  }

  /**
   * A mod's files ({ src, dest }: its own path, its game path), read only when needed: listing
   * every file of every mod on each refresh would be slow for big setups.
   */
  modFiles(mod) {
    if (!mod.filesCache) {
      mod.filesCache = listFiles(mod.dir).filter(f => f.toLowerCase() !== 'meta.ini').map(f => ({ src: f, dest: gamePathOf(f) }));
    }
    return mod.filesCache;
  }

  /**
   * Why a mod is not brought over, or '' to bring it. MO2's Cyberpunk plugin (3.x) makes a mod of
   * an empty bin/x64/CrashReporter/CrashReporter.exe so CET works through its virtual files; outside
   * MO2 it would only break the game's crash reporter.
   */
  skipReason(mod) {
    const files = this.modFiles(mod);
    if (!files.length) return 'its folder in MO2 has no files';
    const size = f => { try { return fs.statSync(path.join(mod.dir, f.src)).size; } catch { return -1; } };
    if (files.every(f => /^bin\\x64\\CrashReporter\\/i.test(f.dest) && size(f) === 0)) return "it is MO2's own CrashReporter workaround, not needed outside MO2";
    return '';
  }

  /** What kind of mod it is (Archive, CET, RED4ext…), from its files. */
  modType(mod) {
    return describeType(this.modFiles(mod).map(f => f.dest.replace(/\\/g, '/')));
  }

  /** What changing would change: instance settings, profile lists and the mods folders. */
  signature(found) {
    return found.map(f => {
      const i = this.readInstance(f);
      if (!i) return `${f.file}|${mtime(f.file)}`;
      let profiles = [];
      try { profiles = fs.readdirSync(i.profilesDir); } catch { /* none */ }
      return [f.file, mtime(f.file), mtime(i.modsDir), mtime(i.profilesDir), ...profiles.map(p => mtime(path.join(i.profilesDir, p, 'modlist.txt')))].join('|');
    }).join('\n');
  }

  /** Every Cyberpunk 2077 instance with its profiles and mods; cached until something changes. */
  read() {
    const found = this.iniFiles();
    const sig = this.signature(found);
    // A mod updated in place leaves its folder's date alone: read again at least once a minute.
    if (this.cache && sig === this.sig && Date.now() - this.readAt < 60000) return this.cache;
    const instances = [];
    for (const f of found) {
      const inst = this.readInstance(f);
      if (!inst) continue;
      let folders = [];
      try { folders = fs.readdirSync(inst.modsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* no mods */ }
      folders = folders.filter(n => !isSeparator(n) && !isBackup(n));
      const byKey = new Map(folders.map(n => [n.toLowerCase(), n]));
      const mods = new Map();
      for (const n of folders) {
        try { mods.set(n, this.readMod(inst, n)); } catch (err) { this.log?.warn?.(`MO2: could not read the mod "${n}"`, err.message); }
      }
      let profileDirs = [];
      try { profileDirs = fs.readdirSync(inst.profilesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* none */ }
      const profiles = profileDirs.map(name => {
        const lines = parseModlist(readText(path.join(inst.profilesDir, name, 'modlist.txt')))
          .map(l => ({ ...l, folder: byKey.get(l.name.toLowerCase()) }))
          .filter(l => l.folder && mods.has(l.folder));
        // Mod folders the list does not name yet: off, above everything (as MO2 reads them).
        const listed = new Set(lines.map(l => l.folder));
        const order = [...folders.filter(n => !listed.has(n)).map(folder => ({ folder, enabled: false })), ...lines];
        return {
          id: `${inst.id}/${name}`,
          name,
          selected: name.toLowerCase() === inst.selectedProfile.toLowerCase(),
          order: order.map(l => l.folder), // highest priority first
          enabled: order.filter(l => l.enabled).map(l => l.folder),
        };
      });
      profiles.sort((a, b) => (b.selected - a.selected) || a.name.localeCompare(b.name));
      instances.push({ ...inst, mods, profiles });
    }
    this.cache = { found: instances.length > 0, instances };
    this.sig = sig;
    this.readAt = Date.now();
    return this.cache;
  }

  instance(id) {
    return this.read().instances.find(i => i.id === id) || null;
  }
}

module.exports = { Mo2Bridge, parseModlist, gamePathOf };
