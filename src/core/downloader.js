'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const MAX_ATTEMPTS = 3;

/**
 * Parallel download queue. Each job asks Nexus for a fresh CDN link, streams it to `<dest>.part`
 * and renames on success. Emits 'update' (job) and 'done' (job).
 */
class Downloader extends EventEmitter {
  constructor(nexus, log, getConcurrency) {
    super();
    this.nexus = nexus;
    this.log = log;
    this.getConcurrency = getConcurrency;
    this.jobs = new Map();
    this.queue = [];
    this.active = 0;
    this.nextId = 1;
    /*
     * Free (non-Premium) Nexus accounts get no direct download links. Their files wait ('waiting')
     * until the user clicks "Slow download" for them on the Nexus site: that gives an nxm:// link
     * with a one-time key, which provideKey() hands to the waiting file. The click is the user's;
     * the app never clicks for them (Nexus does not allow automating it).
     */
    this.freeAccount = false;
    // Other places to download from: source → async job => { url, md5 } (mod.io: a fresh address each time).
    this.resolvers = {};
  }

  /** A one-time key (from a clicked nxm:// link) for a file that waits for one. */
  provideKey(fileId, nxm) {
    const job = [...this.jobs.values()].find(j => !j.source && j.fileId === Number(fileId) && j.status === 'waiting');
    if (!job) return null;
    Object.assign(job, { nxm, status: 'queued', error: '', attempts: 0 });
    this.queue.push(job);
    this.emit('update', publicJob(job));
    this.log.info(`Got the download key for ${job.fileName}; downloading`);
    this.pump();
    return job;
  }

  /** Premium again: the files that waited for a click download directly now. */
  resumeWaiting() {
    for (const job of this.jobs.values()) {
      if (job.status !== 'waiting' || job.nxm?.key || job.source) continue;
      Object.assign(job, { status: 'queued', error: '', attempts: 0 });
      this.queue.push(job);
      this.emit('update', publicJob(job));
    }
    this.pump();
  }

  /** Put a file aside until the user clicks its download on Nexus. */
  wait(job) {
    Object.assign(job, { status: 'waiting', speed: 0, received: 0, error: '' });
    this.emit('update', publicJob(job));
  }

  list() { return [...this.jobs.values()].map(publicJob); }

  enqueue(spec) {
    for (const j of this.jobs.values()) {
      // The same file: Nexus files by their id, files from elsewhere (mod.io) by their key.
      const same = spec.source ? j.key === spec.key : !j.source && j.fileId === spec.fileId;
      if (same && ['queued', 'downloading', 'waiting'].includes(j.status)) {
        // Already coming: make sure it also lands where this request wants it.
        for (const k of ['fomodChoices', 'replaces', 'dependencyOf']) if (spec[k] && !j[k]) j[k] = spec[k];
        if (spec.forProfiles?.length) j.forProfiles = [...new Set([...(j.forProfiles || []), ...spec.forProfiles])];
        return j;
      }
    }
    const job = { ...spec, id: this.nextId++, status: 'queued', received: 0, total: spec.size || 0, speed: 0, error: '', attempts: 0 };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.emit('update', publicJob(job));
    this.pump();
    return job;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.status === 'queued' || job.status === 'waiting') {
      clearTimeout(job.waitTimer);
      job.waitTimer = null;
      this.queue = this.queue.filter(j => j !== job);
      job.status = 'cancelled';
      this.emit('update', publicJob(job));
    } else if (job.status === 'downloading') {
      job.cancelled = true;
      job.abort?.abort();
    }
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job || !['error', 'cancelled'].includes(job.status)) return;
    // Without Premium a retry needs a fresh click (a key works once and expires).
    if (this.freeAccount && !job.nxm?.key && !job.source) { this.wait(job); return; }
    Object.assign(job, { status: 'queued', error: '', received: 0, attempts: 0, waits: 0, cancelled: false });
    this.queue.push(job);
    this.emit('update', publicJob(job));
    this.pump();
  }

  clearFinished() {
    for (const [id, j] of this.jobs) {
      if (['done', 'cancelled', 'skipped', 'error'].includes(j.status)) this.jobs.delete(id); // as the Clear button says
    }
  }

  pump() {
    while (this.active < this.getConcurrency() && this.queue.length) {
      const job = this.queue.shift();
      if (this.freeAccount && !job.nxm?.key && !job.source) { this.wait(job); continue; } // Nexus files only
      this.active++;
      this.run(job).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  async run(job) {
    while (true) {
      job.attempts++;
      try {
        await this.transfer(job);
        job.status = 'done';
        job.speed = 0;
        this.emit('update', publicJob(job));
        this.log.success(`Downloaded ${job.fileName} (${job.modName})`);
        this.emit('done', job);
        return;
      } catch (err) {
        if (job.cancelled) {
          job.status = 'cancelled';
          job.speed = 0;
          this.emit('update', publicJob(job));
          this.log.warn(`Cancelled ${job.fileName}`);
          return;
        }
        // Nexus refused a direct link. Ask Nexus whether the account is (still) Premium: if not, this
        // and later files wait for a click; if it is, the refusal is about this one file.
        if (err.status === 403 && !job.nxm?.key && !job.source) {
          const premium = this.freeAccount ? false : await (async () => this.checkPremium?.() ?? null)().catch(() => null);
          if (job.cancelled) {
            Object.assign(job, { status: 'cancelled', speed: 0 });
            this.emit('update', publicJob(job));
            return;
          }
          if (premium !== true) {
            if (!this.freeAccount) this.log.warn('Nexus refused a direct download: the account is not Premium (or could not be checked). Each file needs one click on "Slow download" on Nexus; the Browse page opens each one for you.');
            this.freeAccount = true;
            this.wait(job);
            return;
          }
          err = Object.assign(new Error(`Nexus refused this file (403) although the account is Premium${err.detail ? `: ${err.detail}` : ''}`), { status: 403 });
        }
        // A used or expired one-time key: wait for a new click.
        if ((err.status === 403 || err.status === 410) && !job.source) {
          if (job.nxm?.key) { job.nxm = null; this.wait(job); return; }
        }
        // The source asked to wait (mod.io's 429): the file waits with it, a few times, without using up its tries.
        // It waits in the queue (its download slot goes to the next file) and comes back by itself.
        if (job.source && err.status === 429 && err.retryAt && (job.waits = (job.waits || 0) + 1) <= 3) {
          Object.assign(job, { status: 'queued', speed: 0, received: 0, error: err.message, attempts: job.attempts - 1 });
          this.emit('update', publicJob(job));
          this.log.warn(`${job.fileName}: ${err.message}`);
          job.waitTimer = setTimeout(() => {
            job.waitTimer = null;
            if (job.status !== 'queued' || job.cancelled) return;
            this.queue.push(job);
            this.pump();
          }, Math.min(Math.max(1000, err.retryAt - Date.now() + 500), 3600e3));
          job.waitTimer.unref?.();
          return;
        }
        const fatal = err.fatal || (err.status && [401, 403, 404].includes(err.status));
        if (fatal || job.attempts >= MAX_ATTEMPTS) {
          job.status = 'error';
          job.error = err.message;
          job.speed = 0;
          this.emit('update', publicJob(job));
          this.log.error(`Download failed: ${job.fileName} (${job.modName})`, err.message);
          return;
        }
        this.log.warn(`Download of ${job.fileName} failed (attempt ${job.attempts}/${MAX_ATTEMPTS}), retrying`, err.message);
        await new Promise(r => setTimeout(r, 1500 * job.attempts));
      }
    }
  }

  async transfer(job) {
    job.status = 'downloading';
    job.received = 0;
    this.emit('update', publicJob(job));

    // nxm links carry a one-time key: it works without Premium, but only until it expires.
    if (job.cancelled) throw new Error('Cancelled');
    let uri;
    let md5 = '';
    let size = 0;
    let checkUrl = null;
    if (job.source) {
      const resolve = this.resolvers[job.source];
      if (!resolve) throw Object.assign(new Error(`Cannot download from ${job.source}`), { status: 404 });
      ({ url: uri, md5 = '', size = 0, checkUrl = null } = await resolve(job));
    } else {
      uri = await this.nexus.getDownloadLink(job.game, job.modId, job.fileId, job.nxm || {});
    }
    if (job.cancelled) throw new Error('Cancelled');
    job.abort = new AbortController();
    const res = await fetch(uri, { signal: job.abort.signal });
    if (!res.ok || !res.body) throw new Error(`CDN responded ${res.status} ${res.statusText}`);
    // Redirected somewhere the source does not serve files from: not kept.
    if (checkUrl && res.url && !checkUrl(res.url)) { job.abort.abort(); throw Object.assign(new Error('The download was sent to an address outside its site; it was not kept.'), { fatal: true }); }
    const len = Number(res.headers.get('content-length'));
    if (len) job.total = len;

    fs.mkdirSync(path.dirname(job.dest), { recursive: true });
    const part = `${job.dest}.part`;
    let lastTick = Date.now();
    let lastBytes = 0;
    let lastEmit = 0;
    const body = Readable.fromWeb(res.body);
    const hash = md5 ? crypto.createHash('md5') : null;
    body.on('data', chunk => {
      job.received += chunk.length;
      hash?.update(chunk);
      const now = Date.now();
      if (now - lastTick >= 1000) {
        job.speed = ((job.received - lastBytes) * 1000) / (now - lastTick);
        lastTick = now;
        lastBytes = job.received;
      }
      if (now - lastEmit > 250) {
        lastEmit = now;
        this.emit('update', publicJob(job));
      }
    });
    try {
      await pipeline(body, fs.createWriteStream(part));
    } catch (err) {
      fs.rm(part, { force: true }, () => {});
      throw err;
    }
    if (job.total && job.received < job.total) {
      fs.rmSync(part, { force: true });
      throw new Error(`Incomplete download (${job.received} of ${job.total} bytes)`);
    }
    // The source said how big the file is: anything else is not the file.
    if (size && job.received !== size) {
      fs.rmSync(part, { force: true });
      throw new Error(`The downloaded file has the wrong size (${job.received} bytes, ${size} expected); it was not kept.`);
    }
    // The source said what the file's checksum is: a file that does not match is not kept.
    if (hash && hash.digest('hex') !== md5) {
      fs.rmSync(part, { force: true });
      throw new Error('The downloaded file does not match its checksum (damaged on the way); it was not kept.');
    }
    fs.renameSync(part, job.dest);
    job.total = job.received;
  }
}

function publicJob(j) {
  const { abort, cancelled, waitTimer, ...rest } = j;
  return rest;
}

module.exports = { Downloader };
