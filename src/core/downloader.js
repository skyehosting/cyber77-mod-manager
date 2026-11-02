'use strict';
const fs = require('fs');
const path = require('path');
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
  }

  list() { return [...this.jobs.values()].map(publicJob); }

  enqueue(spec) {
    for (const j of this.jobs.values()) {
      if (j.fileId === spec.fileId && ['queued', 'downloading'].includes(j.status)) return j;
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
    if (job.status === 'queued') {
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
    Object.assign(job, { status: 'queued', error: '', received: 0, attempts: 0, cancelled: false });
    this.queue.push(job);
    this.emit('update', publicJob(job));
    this.pump();
  }

  clearFinished() {
    for (const [id, j] of this.jobs) {
      if (['done', 'cancelled', 'skipped'].includes(j.status)) this.jobs.delete(id);
    }
  }

  pump() {
    while (this.active < this.getConcurrency() && this.queue.length) {
      const job = this.queue.shift();
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
        const fatal = err.status && [401, 403, 404].includes(err.status);
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

    const uri = await this.nexus.getDownloadLink(job.game, job.modId, job.fileId);
    job.abort = new AbortController();
    const res = await fetch(uri, { signal: job.abort.signal });
    if (!res.ok || !res.body) throw new Error(`CDN responded ${res.status} ${res.statusText}`);
    const len = Number(res.headers.get('content-length'));
    if (len) job.total = len;

    fs.mkdirSync(path.dirname(job.dest), { recursive: true });
    const part = `${job.dest}.part`;
    let lastTick = Date.now();
    let lastBytes = 0;
    let lastEmit = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', chunk => {
      job.received += chunk.length;
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
    fs.renameSync(part, job.dest);
    job.total = job.received;
  }
}

function publicJob(j) {
  const { abort, cancelled, ...rest } = j;
  return rest;
}

module.exports = { Downloader };
