import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const QUEUE_CONTRACT = 'atwo-queue/1';

const STATES = ['pending', 'running', 'done', 'failed'];
const DEFAULT_TTL_MS = 900000;
const DEFAULT_MAX_ATTEMPTS = 3;
const CLAIM_TRIES = 20;

function root(cwd) {
  return path.join(cwd, '.atw', 'queue');
}

function stateDir(cwd, state) {
  return path.join(root(cwd), state);
}

function fileFor(cwd, state, id) {
  return path.join(stateDir(cwd, state), `${id}.json`);
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Only a read-only tree fails here, and the write that follows reports it.
  }
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// Local clock on purpose: toISOString() would stamp the id in UTC and land on a
// different calendar day for part of the world.
function localStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function newId(cwd) {
  const stamp = localStamp();
  let id = '';
  for (let i = 0; i < 5; i += 1) {
    id = `${stamp}-${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
    if (!STATES.some((state) => fs.existsSync(fileFor(cwd, state, id)))) return id;
  }
  return id;
}

function writeJsonAtomic(dir, id, value) {
  const target = path.join(dir, `${id}.json`);
  const tmp = `${target}.tmp`;
  // Write beside the target then rename: a reader sees the whole old record or
  // the whole new one, never half of either.
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, target);
  return target;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function jsonIds(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function reasonOf(err) {
  return err && err.message ? String(err.message) : String(err);
}

function normalizeResult(result) {
  return isRecord(result) ? result : { value: result === undefined ? null : result };
}

function newRecord(id, job) {
  const record = {
    id,
    kind: job.kind,
    args: job.args === undefined ? {} : job.args,
    attempts: Number.isInteger(job.attempts) && job.attempts > 0 ? job.attempts : 1,
    enqueuedAt: new Date().toISOString(),
  };
  if (job.note !== undefined) record.note = job.note;
  return record;
}

export function enqueue(cwd, job, opts = {}) {
  try {
    if (!isRecord(job) || typeof job.kind !== 'string' || job.kind === '') {
      return { ok: false, id: null, path: null, reason: 'invalid-job' };
    }
    const id = newId(cwd);
    const dir = stateDir(cwd, 'pending');
    ensureDir(dir);
    const file = writeJsonAtomic(dir, id, newRecord(id, job));
    return { ok: true, id, path: file, reason: 'ok' };
  } catch (err) {
    return { ok: false, id: null, path: null, reason: reasonOf(err) };
  }
}

// enqueuedAt is the contract order; mtime breaks ties so two jobs written in
// the same millisecond still come back in the order they were queued.
export function claim(cwd, opts = {}) {
  try {
    const pending = stateDir(cwd, 'pending');
    const running = stateDir(cwd, 'running');
    const owner = opts.owner || os.hostname();
    const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;

    const candidates = [];
    for (const id of jsonIds(pending)) {
      const file = path.join(pending, `${id}.json`);
      let record;
      let writtenAt;
      try {
        record = readJson(file);
        writtenAt = fs.statSync(file).mtimeMs;
      } catch {
        continue; // unreadable records must not block the ones behind them
      }
      if (!isRecord(record)) continue;
      candidates.push({ id, file, record, writtenAt });
    }
    if (candidates.length === 0) return { ok: false, id: null, job: null, reason: 'empty' };

    candidates.sort((a, b) => {
      const left = String(a.record.enqueuedAt || '');
      const right = String(b.record.enqueuedAt || '');
      if (left !== right) return left < right ? -1 : 1;
      if (a.writtenAt !== b.writtenAt) return a.writtenAt - b.writtenAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    ensureDir(running);
    const tries = Math.min(candidates.length, CLAIM_TRIES);
    for (let i = 0; i < tries; i += 1) {
      const candidate = candidates[i];
      const target = path.join(running, `${candidate.id}.json`);
      try {
        // The rename is the lock: only one process can move a given record.
        fs.renameSync(candidate.file, target);
      } catch {
        continue; // lost the race, take the next oldest
      }
      const claimed = { ...candidate.record, claimedBy: owner, claimedAt: Date.now(), ttlMs };
      try {
        writeJsonAtomic(running, candidate.id, claimed);
      } catch (err) {
        return { ok: false, id: candidate.id, job: null, reason: reasonOf(err) };
      }
      return { ok: true, id: candidate.id, job: claimed, reason: 'ok' };
    }
    return { ok: false, id: null, job: null, reason: 'empty' };
  } catch (err) {
    return { ok: false, id: null, job: null, reason: reasonOf(err) };
  }
}

function finalize(cwd, id, state, result) {
  try {
    if (typeof id !== 'string' || id === '') return { ok: false, reason: 'not-running' };
    const source = fileFor(cwd, 'running', id);
    if (!fs.existsSync(source)) return { ok: false, reason: 'not-running' };
    let record;
    try {
      record = readJson(source);
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
    if (!isRecord(record)) return { ok: false, reason: 'corrupt-record' };
    const settled = { ...record, result: normalizeResult(result), finishedAt: new Date().toISOString() };
    writeJsonAtomic(stateDir(cwd, 'running'), id, settled);
    ensureDir(stateDir(cwd, state));
    fs.renameSync(source, fileFor(cwd, state, id));
    return { ok: true, reason: 'ok' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'not-running' };
    return { ok: false, reason: reasonOf(err) };
  }
}

export function complete(cwd, id, result = {}) {
  return finalize(cwd, id, 'done', result);
}

export function fail(cwd, id, result = {}) {
  return finalize(cwd, id, 'failed', result);
}

export function listQueue(cwd) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0 };
  const items = [];
  try {
    for (const state of STATES) {
      for (const id of jsonIds(stateDir(cwd, state))) {
        let record;
        try {
          record = readJson(path.join(stateDir(cwd, state), `${id}.json`));
        } catch {
          record = null;
        }
        if (!isRecord(record)) {
          // One unreadable file is reported, not thrown: the rest of the queue stays usable.
          items.push({ id, state: 'corrupt' });
          continue;
        }
        counts[state] += 1;
        items.push({
          id,
          state,
          kind: record.kind,
          enqueuedAt: record.enqueuedAt,
          attempts: record.attempts,
          claimedBy: record.claimedBy,
        });
      }
    }
    items.sort((a, b) => {
      const left = String(a.enqueuedAt || '');
      const right = String(b.enqueuedAt || '');
      if (left === right) return 0;
      return left < right ? -1 : 1;
    });
    return { ok: true, counts, items };
  } catch (err) {
    return { ok: false, counts, items, reason: reasonOf(err) };
  }
}

export function requeueStale(cwd, opts = {}) {
  const requeued = [];
  const failed = [];
  try {
    const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS;
    const fallbackTtl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    const now = Date.now();
    for (const id of jsonIds(stateDir(cwd, 'running'))) {
      const source = fileFor(cwd, 'running', id);
      let record;
      try {
        record = readJson(source);
      } catch {
        continue;
      }
      if (!isRecord(record)) continue;
      const claimedAt = toMs(record.claimedAt);
      if (claimedAt === null) continue; // no claim stamp: not provably stale
      const ttl = toMs(record.ttlMs);
      if (now - claimedAt < (ttl === null ? fallbackTtl : ttl)) continue;
      const attempts = (Number.isInteger(record.attempts) ? record.attempts : 1) + 1;
      const next = { ...record, attempts };
      delete next.claimedBy;
      delete next.claimedAt;
      delete next.ttlMs;
      const exhausted = attempts >= maxAttempts;
      if (exhausted) {
        next.result = { reason: 'attempts-exhausted' };
        next.finishedAt = new Date().toISOString();
      }
      try {
        writeJsonAtomic(stateDir(cwd, 'running'), id, next);
        const target = exhausted ? 'failed' : 'pending';
        ensureDir(stateDir(cwd, target));
        fs.renameSync(source, fileFor(cwd, target, id));
        if (exhausted) failed.push(id);
        else requeued.push(id);
      } catch {
        // Whatever stopped the move leaves the record in running/ for the next sweep.
      }
    }
    return { ok: true, requeued, failed };
  } catch (err) {
    return { ok: false, requeued, failed, reason: reasonOf(err) };
  }
}
