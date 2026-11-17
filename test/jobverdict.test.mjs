import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jobVerdict, JOB_STATUS_CONTRACT } from '../lib/jobverdict.mjs';

test('jobVerdict：六种退出码只有 0 与 4 算跑成', () => {
  assert.deepEqual(jobVerdict(0), { ok: true, red: false, why: 'ok' });
  assert.deepEqual(jobVerdict(4), { ok: true, red: true, why: 'accept-red' });
  for (const c of [2, 3, 5, 6]) assert.equal(jobVerdict(c).ok, false, 'exit ' + c + ' 是失败');
  assert.equal(jobVerdict(null).why, 'no-exit-code');
  assert.equal(JOB_STATUS_CONTRACT, 'atwo-job-status/1');
});

test('jobVerdict 是唯一入口：池子与队列都调它，不许再内联 code === 4', () => {
  const pool = fs.readFileSync(new URL('../lib/pool-cli.mjs', import.meta.url), 'utf8');
  const queue = fs.readFileSync(new URL('../lib/queue-cli.mjs', import.meta.url), 'utf8');
  assert.match(pool, /import { jobVerdict } from '\.\/jobverdict\.mjs';/);
  assert.match(pool, /const v = jobVerdict\(code\)/);
  assert.ok(!/= code === 4/.test(pool), '池子里不许再出现「red = code === 4」这种内联判断');
  assert.match(queue, /export { jobVerdict };/);
  assert.ok(!/if \(code === 4\)/.test(queue), '队列里不许自己留一份实现');
});