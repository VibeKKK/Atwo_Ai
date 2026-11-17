import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enqueue, claim, complete, fail, listQueue, requeueStale, QUEUE_CONTRACT } from '../lib/queue.mjs';
import { runOnce } from '../lib/supervisor.mjs';

const ROOT = ['.atw', 'queue'];

function makeCwd(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-queue-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function qpath(cwd, state, id) {
  return path.join(cwd, ...ROOT, state, `${id}.json`);
}

function readRec(cwd, state, id) {
  return JSON.parse(fs.readFileSync(qpath(cwd, state, id), 'utf8'));
}

test('contract tag is stable', () => {
  assert.equal(QUEUE_CONTRACT, 'atwo-queue/1');
});

test('enqueue writes a pending record that listQueue reports', (t) => {
  const cwd = makeCwd(t);
  const out = enqueue(cwd, { kind: 'echo', args: { n: 1 }, note: 'hello' });

  assert.equal(out.ok, true);
  assert.equal(out.reason, 'ok');
  assert.match(out.id, /^\d{14}-\d+-\w{4}$/);
  assert.equal(fs.existsSync(out.path), true);

  const raw = fs.readFileSync(out.path, 'utf8');
  assert.ok(raw.endsWith('\n'), 'record must end with a newline');
  assert.ok(raw.includes('\n  "kind": "echo"'), 'record must be 2-space indented');
  assert.equal(fs.existsSync(`${out.path}.tmp`), false);

  const q = listQueue(cwd);
  assert.equal(q.ok, true);
  assert.deepEqual(q.counts, { pending: 1, running: 0, done: 0, failed: 0 });
  const item = q.items.find((i) => i.id === out.id);
  assert.deepEqual(item, {
    id: out.id,
    state: 'pending',
    kind: 'echo',
    enqueuedAt: item.enqueuedAt,
    attempts: 1,
    claimedBy: undefined,
  });
});

test('claim takes the oldest job and moves it pending -> running', (t) => {
  const cwd = makeCwd(t);
  const first = enqueue(cwd, { kind: 'first', args: [] });
  const second = enqueue(cwd, { kind: 'second', args: 'x' });

  const got = claim(cwd, { owner: 'box-1' });
  assert.equal(got.ok, true);
  assert.equal(got.id, first.id);
  assert.equal(got.job.kind, 'first');
  assert.equal(got.job.claimedBy, 'box-1');
  assert.equal(typeof got.job.claimedAt, 'number');
  assert.equal(got.job.ttlMs, 900000);

  assert.equal(fs.existsSync(qpath(cwd, 'pending', first.id)), false);
  assert.equal(fs.existsSync(qpath(cwd, 'running', first.id)), true);
  assert.equal(readRec(cwd, 'running', first.id).claimedBy, 'box-1');
  assert.equal(fs.existsSync(qpath(cwd, 'pending', second.id)), true);
});

test('claim on an empty queue reports empty', (t) => {
  const cwd = makeCwd(t);
  const got = claim(cwd);
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'empty');
});

test('parallel claims never hand out the same job twice', async (t) => {
  const cwd = makeCwd(t);
  enqueue(cwd, { kind: 'only', args: {} });

  const races = await Promise.all(Array.from({ length: 5 }, () => claim(cwd)));
  const wins = races.filter((r) => r.ok);

  assert.equal(wins.length, 1);
  assert.equal(new Set(wins.map((r) => r.id)).size, wins.length);
  assert.equal(listQueue(cwd).counts.running, 1);
  assert.equal(listQueue(cwd).counts.pending, 0);
});

test('complete moves the job to done with result and finishedAt', (t) => {
  const cwd = makeCwd(t);
  const enq = enqueue(cwd, { kind: 'work', args: {} });
  const got = claim(cwd);

  const out = complete(cwd, got.id, { stdout: 'ok' });
  assert.equal(out.ok, true);
  assert.equal(out.reason, 'ok');
  assert.equal(fs.existsSync(qpath(cwd, 'running', enq.id)), false);

  const rec = readRec(cwd, 'done', enq.id);
  assert.deepEqual(rec.result, { stdout: 'ok' });
  assert.equal(typeof rec.finishedAt, 'string');
  assert.deepEqual(listQueue(cwd).counts, { pending: 0, running: 0, done: 1, failed: 0 });
});

test('complete and fail refuse ids that are not running', (t) => {
  const cwd = makeCwd(t);
  const enq = enqueue(cwd, { kind: 'work', args: {} });

  assert.deepEqual(complete(cwd, enq.id, {}), { ok: false, reason: 'not-running' });
  assert.deepEqual(fail(cwd, enq.id, {}), { ok: false, reason: 'not-running' });
  assert.deepEqual(complete(cwd, 'missing-id', {}), { ok: false, reason: 'not-running' });
});

test('requeueStale returns an expired claim to pending with attempts+1', (t) => {
  const cwd = makeCwd(t);
  const enq = enqueue(cwd, { kind: 'slow', args: {} });
  const got = claim(cwd, { ttlMs: 0 });
  assert.equal(got.ok, true);

  const out = requeueStale(cwd);
  assert.deepEqual(out, { ok: true, requeued: [enq.id], failed: [] });
  assert.equal(fs.existsSync(qpath(cwd, 'running', enq.id)), false);

  const rec = readRec(cwd, 'pending', enq.id);
  assert.equal(rec.attempts, 2);
  assert.equal(rec.claimedBy, undefined);
});

test('requeueStale buries a job once attempts reach maxAttempts', (t) => {
  const cwd = makeCwd(t);
  const enq = enqueue(cwd, { kind: 'doomed', args: {}, attempts: 2 });
  claim(cwd, { ttlMs: 0 });

  const out = requeueStale(cwd, { maxAttempts: 3 });
  assert.deepEqual(out.failed, [enq.id]);
  assert.deepEqual(out.requeued, []);

  const rec = readRec(cwd, 'failed', enq.id);
  assert.equal(rec.attempts, 3);
  assert.deepEqual(rec.result, { reason: 'attempts-exhausted' });
});

test('a fresh claim is not stale', (t) => {
  const cwd = makeCwd(t);
  enqueue(cwd, { kind: 'busy', args: {} });
  claim(cwd); // default ttl is 15 minutes

  assert.deepEqual(requeueStale(cwd), { ok: true, requeued: [], failed: [] });
});

test('one corrupt record does not poison listQueue or claim', (t) => {
  const cwd = makeCwd(t);
  const good = enqueue(cwd, { kind: 'good', args: {} });
  const pendingDir = path.join(cwd, ...ROOT, 'pending');
  fs.writeFileSync(path.join(pendingDir, '20000101000000-1-dead.json'), '{ not json');

  const q = listQueue(cwd);
  assert.equal(q.ok, true);
  assert.equal(q.counts.pending, 1);

  const corrupt = q.items.filter((i) => i.state === 'corrupt');
  assert.equal(corrupt.length, 1);
  assert.deepEqual(corrupt[0], { id: '20000101000000-1-dead', state: 'corrupt' });
  assert.equal(q.items.find((i) => i.id === good.id).state, 'pending');

  const got = claim(cwd);
  assert.equal(got.ok, true);
  assert.equal(got.id, good.id);
});

test('runOnce drains two jobs and logs one line each', async (t) => {
  const cwd = makeCwd(t);
  const a = enqueue(cwd, { kind: 'alpha', args: { n: 1 } });
  const b = enqueue(cwd, { kind: 'beta', args: { n: 2 } });
  const events = [];

  const out = await runOnce(cwd, {
    owner: 'tester',
    onEvent: (evt) => events.push(evt),
    runner: async (job) => ({ ok: true, sum: Number(job.args.n) + 1 }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.claimed, 2);
  assert.equal(out.completed, 2);
  assert.equal(out.failed, 0);
  assert.deepEqual(out.results.map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(events.map((e) => e.type), ['claim', 'done', 'claim', 'done']);

  const logPath = path.join(cwd, ...ROOT, 'supervisor.log');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['error', 'id', 'kind', 'ms', 'ok', 'ts']);
  assert.equal(lines.every((l) => l.ok === true), true);
  assert.equal(lines.every((l) => l.error === null), true);
  assert.deepEqual(lines.map((l) => l.kind).sort(), ['alpha', 'beta']);
  assert.deepEqual(listQueue(cwd).counts, { pending: 0, running: 0, done: 2, failed: 0 });
  assert.deepEqual(readRec(cwd, 'done', a.id).result, { ok: true, sum: 2 });
});

test('runOnce isolates a throwing runner from the rest of the batch', async (t) => {
  const cwd = makeCwd(t);
  const good = enqueue(cwd, { kind: 'fine', args: {} });
  const bad = enqueue(cwd, { kind: 'boom', args: {} });

  const out = await runOnce(cwd, {
    runner: async (job) => {
      if (job.kind === 'boom') throw new Error('kaboom');
      return { ok: true };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.claimed, 2);
  assert.equal(out.completed, 1);
  assert.equal(out.failed, 1);

  const badResult = out.results.find((r) => r.id === bad.id);
  assert.equal(badResult.ok, false);
  assert.match(badResult.error, /kaboom/);
  assert.equal(out.results.find((r) => r.id === good.id).ok, true);
  assert.deepEqual(listQueue(cwd).counts, { pending: 0, running: 0, done: 1, failed: 1 });

  const rec = readRec(cwd, 'failed', bad.id);
  assert.equal(rec.result.ok, false);
  assert.match(rec.result.error, /kaboom/);
});

test('a runner reply with ok:false is recorded as a failure', async (t) => {
  const cwd = makeCwd(t);
  const enq = enqueue(cwd, { kind: 'nope', args: {} });

  const out = await runOnce(cwd, { runner: async () => ({ ok: false, reason: 'bad-input' }) });
  assert.equal(out.failed, 1);
  assert.equal(out.completed, 0);

  const rec = readRec(cwd, 'failed', enq.id);
  assert.deepEqual(rec.result, { ok: false, reason: 'bad-input' });
});

test('runOnce refuses to run without a runner', async (t) => {
  const cwd = makeCwd(t);
  enqueue(cwd, { kind: 'waiting', args: {} });

  const out = await runOnce(cwd, {});
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-runner');
  assert.equal(listQueue(cwd).counts.pending, 1);
});
