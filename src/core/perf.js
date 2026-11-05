'use strict';
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { findGameProcess, isGameProcess } = require('./gameProcess');

/*
 * The Performance page's numbers, read only while the page is open (start / stop), once per interval:
 * the whole PC (CPU, memory, GPU, video memory, disk, network) and the game's own process.
 *
 * Windows: one PowerShell child compiles a small C# sampler (perfWin.cs, sent on its standard input)
 * that reads Windows' performance counters by their English names, so any display language works,
 * and DXGI for the graphics card's name and memory. It prints one JSON line per interval and ends by
 * itself when this app is gone. Memory comes from Node (os.totalmem / os.freemem).
 * If it cannot run (PowerShell blocked, Constrained Language Mode), the CPU and memory still show.
 *
 * Linux (Steam Deck, desktops): /proc and /sys, read here.
 *   CPU /proc/stat · memory /proc/meminfo (MemAvailable) · disk /proc/diskstats (whole disks, 512-byte
 *   sectors) · network /proc/net/dev (all but lo) · the game, a Wine process found as gameProcess.js
 *   does, through /proc/<pid>/stat (utime + stime), status (VmRSS) and io (read_bytes, write_bytes).
 *   GPU: AMD through /sys/class/drm/card*\/device (gpu_busy_percent, mem_info_vram_*); NVIDIA through
 *   nvidia-smi, left running (-lms); Intel has no file with its load, so none is shown. The game's own
 *   GPU share and video memory come from the fdinfo of its DRM files (the kernel's drm-usage-stats:
 *   drm-engine-* in ns, drm-memory-vram / drm-resident-vram), where the driver gives them (AMD, Intel).
 *
 * A sample: { at, ms, system: { cpu, memUsed, memTotal, gpuName, gpu, vramUsed, vramTotal, diskRead,
 * diskWrite, netDown, netUp }, game: null | { pid, startedAt, cpu, mem, gpu, vram, ioRead, ioWrite },
 * notes: [...] }. Percentages 0 to 100, sizes in bytes, rates in bytes per second; null: not known.
 * Research: notes/performance.md.
 */

const MIN_MS = 500;
const MAX_MS = 10000;
const clampMs = ms => Math.min(MAX_MS, Math.max(MIN_MS, Math.round(Number(ms) || 1000)));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = v => (num(v) === null ? null : Math.min(100, Math.max(0, v)));
const rate = v => (num(v) === null ? null : Math.max(0, v));

// ------------------------------------------------------------------ Windows

const SAMPLER_CS = path.join(__dirname, 'perfWin.cs');
// Windows' own PowerShell, by its full path (never one found first on PATH).
const POWERSHELL = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const NO_PS_NOTE = 'Windows did not let the app read the GPU, disk, network and game numbers (PowerShell is blocked or limited here). CPU and memory still show.';

/** One line from the C# sampler as a sample (memory from Node); null if it is not one. */
function fromWinLine(line, mem = { total: os.totalmem(), free: os.freemem() }) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object' || o.error) return null;
  const g = o.gpu && typeof o.gpu === 'object' ? o.gpu : {};
  const game = o.game && typeof o.game === 'object' && Number.isInteger(o.game.pid) ? {
    pid: o.game.pid,
    startedAt: num(o.game.start) || null,
    cpu: pct(o.game.cpu),
    mem: rate(o.game.mem),
    gpu: pct(o.game.gpu),
    vram: rate(o.game.vram),
    ioRead: rate(o.game.ioR),
    ioWrite: rate(o.game.ioW),
  } : null;
  return {
    system: {
      cpu: pct(o.cpu),
      memUsed: mem.total - mem.free,
      memTotal: mem.total,
      gpuName: typeof g.name === 'string' ? g.name.slice(0, 120) : '',
      gpu: pct(g.util),
      vramUsed: rate(g.vramUsed),
      vramTotal: rate(g.vramTotal),
      diskRead: rate(o.disk?.r),
      diskWrite: rate(o.disk?.w),
      netDown: rate(o.net?.rx),
      netUp: rate(o.net?.tx),
    },
    game,
  };
}

/** CPU % from two os.cpus() readings (the fallback when the sampler cannot run). */
function cpuFromTimes(prev, now) {
  if (!prev || !now || prev.length !== now.length) return null;
  let busy = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = prev[i].times;
    const t = c.times;
    const all = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + (t.idle - p.idle);
    total += all;
    busy += all - (t.idle - p.idle);
  });
  return total > 0 ? pct((busy / total) * 100) : null;
}

class WindowsSource {
  constructor({ log, spawnFn = spawn, restartMs = 3000 }) {
    this.log = log;
    this.spawn = spawnFn;
    this.restartMs = restartMs;
    this.child = null;
    this.timer = null;
    this.retry = null;
    this.failures = 0;
  }

  start(ms, emit) {
    this.stop();
    this.ms = ms;
    this.emit = emit;
    if (this.failures >= 2) { this.basic(); return; }
    let cs;
    try { cs = fs.readFileSync(SAMPLER_CS, 'utf8'); } catch (err) { this.log?.warn('Performance: the Windows sampler is missing', err.message); this.basic(); return; }
    // The C# comes on standard input (a command line holding it would be too long for Windows).
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $cs = [Console]::In.ReadToEnd(); Add-Type -TypeDefinition $cs; [CmmPerf.Sampler]::Run(${process.pid}, ${ms}, 'Cyberpunk2077')`;
    let child;
    try {
      child = this.spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) { this.failed(err.message); return; }
    this.child = child;
    const startedAt = Date.now();
    let buf = '';
    let got = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      if (buf.length > 1e6) buf = buf.slice(-1e5); // never a line that long: keep the tail only
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const s = line && fromWinLine(line);
        if (!s) continue;
        got = true;
        // Only a sampler that kept going a while counts as working again (one that dies after a
        // line or two must not restart for ever).
        if (Date.now() - startedAt > 15000) this.failures = 0;
        emit({ ...s, notes: [] });
      }
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { if (err.length < 4000) err += d; });
    child.on('error', e => { if (this.child === child) { this.child = null; this.failed(e.message); } });
    child.on('exit', code => {
      if (this.child !== child) return; // stopped on purpose
      this.child = null;
      this.failed(got ? `it stopped (${code})` : (err.replace(/#< CLIXML|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || `exit ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(cs);
  }

  /** The sampler ended or could not start: once more (after a moment), then CPU and memory only. */
  failed(why) {
    this.failures++;
    this.log?.warn('Performance: the Windows sampler stopped', why);
    const { ms, emit } = this;
    if (!emit) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.retry = null; if (this.emit === emit) this.start(ms, emit); }, this.failures >= 2 ? 0 : this.restartMs);
  }

  /** CPU and memory from Node only. */
  basic() {
    let prev = os.cpus();
    this.timer = setInterval(() => {
      const now = os.cpus();
      const total = os.totalmem();
      this.emit({
        system: { cpu: cpuFromTimes(prev, now), memUsed: total - os.freemem(), memTotal: total, gpuName: '', gpu: null, vramUsed: null, vramTotal: null, diskRead: null, diskWrite: null, netDown: null, netUp: null },
        game: null,
        notes: [NO_PS_NOTE],
      });
      prev = now;
    }, this.ms);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.retry);
    this.retry = null;
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill(); } catch { /* gone */ } }
    this.emit = null;
  }
}

// ------------------------------------------------------------------ Linux

/** /proc/stat's "cpu" line: [busy, total] in ticks (iowait counts as idle, as top does). */
function parseProcStat(text) {
  const line = String(text).split('\n').find(l => /^cpu\s/.test(l));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1, 9).map(Number); // user nice system idle iowait irq softirq steal
  if (f.length < 4 || f.some(n => !Number.isFinite(n))) return null;
  const total = f.reduce((a, b) => a + b, 0);
  return [total - f[3] - (f[4] || 0), total];
}

/** /proc/meminfo: { total, available } in bytes. */
function parseMeminfo(text) {
  const kb = name => { const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(String(text)); return m ? Number(m[1]) * 1024 : null; };
  const total = kb('MemTotal');
  const avail = kb('MemAvailable') ?? kb('MemFree');
  return total ? { total, available: avail ?? 0 } : null;
}

// Whole disks only (a partition's numbers are already in its disk's); no loop, RAM or device-mapper disks.
const WHOLE_DISK = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/** /proc/diskstats: bytes read and written so far by the whole disks (sectors are 512 bytes there). */
function parseDiskstats(text) {
  let r = 0;
  let w = 0;
  for (const line of String(text).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !WHOLE_DISK.test(f[2])) continue;
    r += Number(f[5]) * 512 || 0; // sectors read
    w += Number(f[9]) * 512 || 0; // sectors written
  }
  return { r, w };
}

/** /proc/net/dev: bytes received and sent so far, every interface but loopback. */
function parseNetDev(text) {
  let rx = 0;
  let tx = 0;
  for (const line of String(text).split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

/** /proc/<pid>/stat: utime + stime in ticks (the name, field 2, can hold spaces: read after its ')'). */
function parsePidStat(text) {
  const s = String(text);
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(f[11]) + Number(f[12]); // fields 14 and 15
  return Number.isFinite(ticks) ? ticks : null;
}

const kbField = (text, name) => { const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(String(text)); return m ? Number(m[1]) * 1024 : null; };
const ioField = (text, name) => { const m = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(String(text)); return m ? Number(m[1]) : null; };

/**
 * One DRM file's fdinfo: { client, engines: { name: ns }, vram } (vram in bytes), or null if it is
 * not a DRM client. Sizes are like "123456 KiB".
 */
function parseFdinfo(text) {
  const s = String(text);
  const client = /^drm-client-id:\s*(\d+)/m.exec(s);
  if (!client) return null;
  const engines = {};
  for (const m of s.matchAll(/^drm-engine-([\w-]+):\s*(\d+)\s*ns/gm)) engines[m[1]] = Number(m[2]);
  const size = m => (m ? Number(m[1]) * ({ KiB: 1024, MiB: 1048576, GiB: 1073741824 }[m[2]] || 1) : null);
  const vram = size(/^drm-(?:resident|memory)-vram\d*:\s*(\d+)\s*(KiB|MiB|GiB)?/m.exec(s)) ?? size(/^drm-total-vram\d*:\s*(\d+)\s*(KiB|MiB|GiB)?/m.exec(s));
  return { client: client[1], engines, vram };
}

/** nvidia-smi's CSV line (name, util %, used MiB, total MiB) as { name, util, used, total } (bytes). */
function parseNvidiaLine(line) {
  const f = String(line).split(',').map(x => x.trim());
  if (f.length < 4) return null;
  const n = i => (Number.isFinite(Number(f[i])) && f[i] !== '' ? Number(f[i]) : null);
  return { name: f[0].slice(0, 120), util: pct(n(1)), used: n(2) === null ? null : n(2) * 1048576, total: n(3) === null ? null : n(3) * 1048576 };
}

const readText = async p => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } };

class LinuxSource {
  constructor({ log, proc = '/proc', sys = '/sys', spawnFn = spawn, findGame = findGameProcess, stillGame = isGameProcess }) {
    this.log = log;
    this.proc = proc;
    this.sys = sys;
    this.spawn = spawnFn;
    this.findGame = findGame;
    this.stillGame = stillGame;
    this.timer = null;
    this.nvidia = null;
    this.nv = null;
    this.nvidiaMissing = false;
    // Each start and stop is a new generation: a reading still under way from an older one starts
    // nothing (no nvidia-smi nobody would stop) and shows nothing.
    this.gen = 0;
  }

  start(ms, emit) {
    this.stop();
    this.ms = ms;
    this.emit = emit;
    this.prev = null;
    this.game = null; // { pid, startedAt, ticks, io, drmFds, drmAt, engines }
    this.gameCheckAt = 0;
    this.cards = null;
    this.timer = setInterval(() => { this.sample().catch(err => this.log?.warn('Performance: could not read the numbers', err.message)); }, ms);
    this.sample().catch(() => {});
  }

  /** The graphics cards: [{ dir, vendor }] (AMD 0x1002, NVIDIA 0x10de, Intel 0x8086). */
  async findCards() {
    const base = path.join(this.sys, 'class', 'drm');
    let names = [];
    try { names = (await fsp.readdir(base)).filter(n => /^card\d+$/.test(n)); } catch { /* none */ }
    const cards = [];
    for (const n of names) {
      const dir = path.join(base, n, 'device');
      const vendor = (await readText(path.join(dir, 'vendor')))?.trim().toLowerCase() || '';
      cards.push({ dir, vendor });
    }
    return cards;
  }

  /** NVIDIA: nvidia-smi left running, one line per interval (none: no NVIDIA numbers). */
  startNvidia(gen) {
    if (this.nvidia !== null || gen !== this.gen) return;
    try {
      const c = this.spawn('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits', `--loop-ms=${this.ms}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      this.nvidia = c;
      let buf = '';
      c.stdout.setEncoding('utf8');
      c.stdout.on('data', d => {
        buf = (buf + d).slice(-4000);
        const lines = buf.split('\n');
        buf = lines.pop();
        const last = lines.filter(Boolean).pop();
        if (last) this.nv = parseNvidiaLine(last) || this.nv;
      });
      // Not installed (ENOENT), or it stopped: its last numbers are not shown as if they were live.
      c.on('error', err => { if (this.nvidia === c) { this.nvidia = false; this.nv = null; this.nvidiaMissing = err?.code === 'ENOENT'; } });
      c.on('exit', () => { if (this.nvidia === c) { this.nvidia = false; this.nv = null; } });
    } catch { this.nvidia = false; this.nvidiaMissing = true; }
  }

  async gpu(gen) {
    if (!this.cards) this.cards = await this.findCards();
    // AMD: the card with the most video memory. A small one beside an NVIDIA card is the processor's
    // own graphics (a laptop's), not the card games draw on.
    let best = null;
    for (const c of this.cards.filter(x => x.vendor === '0x1002')) {
      const total = Number(await readText(path.join(c.dir, 'mem_info_vram_total')));
      if (!best || total > best.total) best = { c, total };
    }
    const nvidia = this.cards.some(x => x.vendor === '0x10de');
    if (best && !(nvidia && !(best.total >= 2 * 1073741824))) {
      const busy = Number(await readText(path.join(best.c.dir, 'gpu_busy_percent')));
      const used = Number(await readText(path.join(best.c.dir, 'mem_info_vram_used')));
      const name = (await readText(path.join(best.c.dir, 'product_name')))?.trim();
      return { name: name || 'AMD graphics', util: pct(Number.isFinite(busy) ? busy : null), used: Number.isFinite(used) ? used : null, total: best.total || null, vendor: 'amd' };
    }
    if (nvidia) {
      this.startNvidia(gen);
      const n = this.nv;
      return { name: n?.name || 'NVIDIA graphics', util: n?.util ?? null, used: n?.used ?? null, total: n?.total ?? null, vendor: 'nvidia' };
    }
    if (this.cards.some(x => x.vendor === '0x8086')) return { name: 'Intel graphics', util: null, used: null, total: null, vendor: 'intel' };
    return null;
  }

  /** The game's process (checked every 5 s, or at once when the one known is gone). */
  async gameProcess(now, gen = this.gen) {
    if (this.game && now - this.gameCheckAt < 5000) return this.game;
    this.gameCheckAt = now;
    if (this.game && await this.stillGame(this.game.pid, { procDir: this.proc })) return this.game;
    const found = await this.findGame({ procDir: this.proc }).catch(() => null);
    if (gen !== this.gen) return null; // stopped meanwhile: the next start finds it itself
    if (!found) { this.game = null; return null; }
    if (this.game?.pid !== found.pid) {
      let startedAt = null;
      try { startedAt = (await fsp.stat(path.join(this.proc, String(found.pid)))).mtimeMs || null; } catch { /* unknown */ }
      this.game = { pid: found.pid, startedAt, ticks: null, io: null, drmFds: null, drmAt: 0, engines: null, vram: null };
    }
    return this.game;
  }

  /** The game's DRM files (refreshed every 10 s): their GPU busy time per engine (ns) and video memory. */
  async gameDrm(g, now) {
    const dir = path.join(this.proc, String(g.pid));
    if (!g.drmFds || now - g.drmAt > 10000) {
      g.drmAt = now;
      g.drmFds = [];
      let fds = [];
      try { fds = await fsp.readdir(path.join(dir, 'fd')); } catch { /* not readable */ }
      for (let i = 0; i < fds.length; i += 128) {
        const links = await Promise.all(fds.slice(i, i + 128).map(fd => fsp.readlink(path.join(dir, 'fd', fd)).catch(() => '')));
        links.forEach((l, j) => { if (/^\/dev\/dri\//.test(l)) g.drmFds.push(fds[i + j]); });
      }
      g.drmFds = g.drmFds.slice(0, 32); // a game holds a few; never hundreds read every interval
    }
    const clients = new Map();
    for (const fd of g.drmFds) {
      const info = parseFdinfo(await readText(path.join(dir, 'fdinfo', fd)));
      if (info && !clients.has(info.client)) clients.set(info.client, info);
    }
    if (!clients.size) return null;
    const engines = {};
    let vram = null;
    for (const c of clients.values()) {
      for (const [k, v] of Object.entries(c.engines)) engines[k] = (engines[k] || 0) + v;
      if (c.vram !== null) vram = (vram || 0) + c.vram;
    }
    return { engines, vram };
  }

  /** One reading at a time (a slow one is not stacked on by the next). */
  async sample() {
    if (this.sampling) return;
    this.sampling = true;
    try { await this.read(this.gen); } finally { this.sampling = false; }
  }

  async read(gen) {
    const now = Date.now();
    const [stat, meminfo, disk, net] = await Promise.all(['stat', 'meminfo', 'diskstats', 'net/dev'].map(f => readText(path.join(this.proc, f))));
    const cpu = parseProcStat(stat);
    const mem = parseMeminfo(meminfo);
    const io = parseDiskstats(disk);
    const nd = parseNetDev(net);
    const gpu = await this.gpu(gen);
    if (gen !== this.gen) return; // stopped meanwhile
    const prev = this.prev;
    const secs = prev ? (now - prev.at) / 1000 : 0;
    const per = (a, b) => (prev && secs > 0 ? rate((a - b) / secs) : null);
    const system = {
      cpu: prev && cpu && prev.cpu && cpu[1] > prev.cpu[1] ? pct(((cpu[0] - prev.cpu[0]) / (cpu[1] - prev.cpu[1])) * 100) : null,
      memUsed: mem ? mem.total - mem.available : null,
      memTotal: mem?.total ?? null,
      gpuName: gpu?.name || '',
      gpu: gpu?.util ?? null,
      vramUsed: gpu?.used ?? null,
      vramTotal: gpu?.total ?? null,
      diskRead: per(io.r, prev?.io.r),
      diskWrite: per(io.w, prev?.io.w),
      netDown: per(nd.rx, prev?.nd.rx),
      netUp: per(nd.tx, prev?.nd.tx),
    };
    const notes = [];
    if (gpu?.vendor === 'intel') notes.push('Intel graphics do not tell Linux programs how busy they are, so the GPU load is not shown.');
    if (gpu?.vendor === 'nvidia' && this.nvidia === false) {
      notes.push(this.nvidiaMissing ? 'NVIDIA\'s numbers come from nvidia-smi, which is not installed here.' : 'nvidia-smi stopped, so NVIDIA\'s numbers are not shown. Open this page again to retry.');
    }
    let game = null;
    const g = await this.gameProcess(now, gen);
    if (g) {
      const dir = path.join(this.proc, String(g.pid));
      const [pstat, status, pio] = await Promise.all(['stat', 'status', 'io'].map(f => readText(path.join(dir, f))));
      const ticks = parsePidStat(pstat);
      const ior = ioField(pio, 'read_bytes');
      const iow = ioField(pio, 'write_bytes');
      const gsecs = g.at ? (now - g.at) / 1000 : 0;
      const cores = os.cpus().length || 1;
      // Ticks are 1/100 s (USER_HZ is 100 on Linux's PC and ARM builds).
      const cpuPct = g.ticks !== null && ticks !== null && gsecs > 0 ? pct(((ticks - g.ticks) / 100 / gsecs / cores) * 100) : null;
      const drm = gpu && gpu.vendor !== 'nvidia' ? await this.gameDrm(g, now).catch(() => null) : null;
      let gameGpu = null;
      if (drm && g.engines && gsecs > 0) {
        for (const [k, v] of Object.entries(drm.engines)) {
          const was = g.engines[k];
          if (was !== undefined && v >= was) gameGpu = Math.max(gameGpu ?? 0, ((v - was) / (gsecs * 1e9)) * 100);
        }
      }
      game = {
        pid: g.pid,
        startedAt: g.startedAt,
        cpu: cpuPct,
        mem: kbField(status, 'VmRSS'),
        gpu: pct(gameGpu),
        vram: drm?.vram ?? null,
        ioRead: g.io && ior !== null && gsecs > 0 ? rate((ior - g.io.r) / gsecs) : null,
        ioWrite: g.io && iow !== null && gsecs > 0 ? rate((iow - g.io.w) / gsecs) : null,
      };
      g.ticks = ticks;
      g.io = ior !== null && iow !== null ? { r: ior, w: iow } : null;
      g.engines = drm?.engines || null;
      g.at = now;
    }
    if (gen !== this.gen) return;
    this.prev = { at: now, cpu, io, nd };
    if (this.emit) this.emit({ system, game, notes });
  }

  stop() {
    this.gen++;
    clearInterval(this.timer);
    this.timer = null;
    if (this.nvidia) { try { this.nvidia.kill(); } catch { /* gone */ } }
    this.nvidia = null;
    this.nv = null;
    this.nvidiaMissing = false;
    this.emit = null;
  }
}

// ------------------------------------------------------------------ the monitor

/** Emits 'sample' once per interval between start() and stop(). */
class PerfMonitor extends EventEmitter {
  constructor({ log, platform = process.platform, source = null } = {}) {
    super();
    this.source = source || (platform === 'win32' ? new WindowsSource({ log }) : new LinuxSource({ log }));
    this.running = false;
    this.ms = 1000;
  }

  /** Start (or change the interval of) the sampling. */
  start(ms) {
    const next = clampMs(ms);
    if (this.running && next === this.ms) return;
    this.ms = next;
    this.running = true;
    this.source.start(next, s => this.emit('sample', { at: Date.now(), ms: next, notes: [], ...s }));
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.source.stop();
  }
}

module.exports = {
  PerfMonitor, WindowsSource, LinuxSource, clampMs,
  fromWinLine, cpuFromTimes, parseProcStat, parseMeminfo, parseDiskstats, parseNetDev, parsePidStat, parseFdinfo, parseNvidiaLine,
};
