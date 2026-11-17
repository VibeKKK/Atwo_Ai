import fs from 'node:fs';
import path from 'node:path';

import { claim, complete, fail } from './queue.mjs';

const DEFAULT_MAX = 2;

function logFile(cwd) {
  return path.join(cwd, '.atw', 'queue', 'supervisor.log');
}

function appendLog(cwd, entry) {
  try {
    const file = logFile(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // A dropped log line must not cost a finished job its result.
  }
}

function emit(onEvent, evt) {
  if (typeof onEvent !== 'function') return;
  try {
    onEvent(evt);
  } catch {
    // An observer that throws is not a job failure and must not stop the batch.
  }
}

function messageOf(err) {
  return err && err.message ? String(err.message) : String(err);
}

function isJob(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rejected(reason) {
  return { ok: false, claimed: 0, completed: 0, failed: 0, results: [], reason };
}

export async function runOnce(cwd, opts = {}) {
  if (typeof opts.runner !== 'function') return rejected('no-runner');

  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : DEFAULT_MAX;
  const claimOpts = opts.owner ? { owner: opts.owner } : {};
  const results = [];
  let claimed = 0;
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < max; i += 1) {
    const got = claim(cwd, claimOpts);
    if (!got || !got.ok) break; // empty, or every candidate was taken by someone else
    claimed += 1;
    const job = isJob(got.job) ? got.job : {};
    emit(opts.onEvent, { type: 'claim', id: got.id, ms: 0 });

    const startedAt = Date.now();
    let outcome;
    let error = null;
    try {
      outcome = await opts.runner(job, {
        id: got.id,
        cwd,
        claimedBy: job.claimedBy,
        attempts: job.attempts,
        enqueuedAt: job.enqueuedAt,
      });
    } catch (err) {
      error = messageOf(err);
      outcome = { ok: false, error };
    }
    const ms = Math.max(0, Date.now() - startedAt);
    const isFail = !!outcome && typeof outcome === 'object' && outcome.ok === false;
    const payload = outcome && typeof outcome === 'object'
      ? outcome
      : { value: outcome === undefined ? null : outcome };
    const settled = isFail ? fail(cwd, got.id, payload) : complete(cwd, got.id, payload);

    if (isFail) {
      failed += 1;
      if (error === null) error = String(payload.error || payload.reason || 'runner-failed');
      emit(opts.onEvent, { type: 'fail', id: got.id, ms });
    } else {
      completed += 1;
      emit(opts.onEvent, { type: 'done', id: got.id, ms });
    }
    if (!settled || !settled.ok) {
      // The record moved out from under us; report it and keep the batch going.
      error = error || `finalize:${(settled && settled.reason) || 'unknown'}`;
    }
    results.push({ id: got.id, ok: !isFail, ms, error });
    appendLog(cwd, {
      ts: new Date().toISOString(),
      id: got.id,
      kind: job.kind === undefined ? null : job.kind,
      ok: !isFail,
      ms,
      error,
    });
  }

  return {
    ok: true,
    claimed,
    completed,
    failed,
    results,
    reason: claimed === 0 ? 'empty' : 'ok',
  };
}
