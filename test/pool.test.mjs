// test/pool.test.mjs —— 多池调度：按 cap 装填、不超发、连败改派。ask 全用注入的假实现，不真派活。
import test from 'node:test';
import assert from 'node:assert/strict';

import { LANE_CAPS, POOL_CONTRACT, WRITER_LANES, planPool, runPool } from '../lib/pool.mjs';

const jobs = (n, prefix = 'j') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, kind: 'work', task: `t${i}` }));
const ids = (plan) => plan.flatMap((p) => p.jobs);
const perLane = (plan, lane) => (plan.find((p) => p.lane === lane) || { jobs: [] }).jobs.length;

test('contract 与上限表是对外的稳定承诺', () => {
  assert.equal(POOL_CONTRACT, 'atwo-pool/1');
  assert.deepEqual(WRITER_LANES, ['codebuddy', 'codex', 'ollama']);
  assert.equal(LANE_CAPS.codebuddy, 6);
  assert.equal(LANE_CAPS.ollama, 2);
});

test('按 cap 装填：14 个槽位，超出的留空而不是超发', () => {
  const out = planPool(jobs(20));
  assert.equal(out.ok, true);
  assert.equal(out.reason, 'ok');
  assert.equal(ids(out.plan).length, 14);
  assert.equal(out.unassigned.length, 6);
  for (const p of out.plan) assert.ok(p.jobs.length <= LANE_CAPS[p.lane], p.lane);
  assert.equal(new Set(ids(out.plan)).size, 14);
});

test('opts.caps 覆盖上限、opts.probes 剔除通道', () => {
  const out = planPool(jobs(10), { probes: { codex: false }, caps: { codebuddy: 2, ollama: 1 } });
  assert.equal(ids(out.plan).length, 3);
  assert.equal(perLane(out.plan, 'codebuddy'), 2);
  assert.equal(perLane(out.plan, 'ollama'), 1);
  assert.equal(perLane(out.plan, 'codex'), 0);
});

test('装不下的进 unassigned（宁可留空）', () => {
  const out = planPool(jobs(5), { lanes: ['codebuddy'], caps: { codebuddy: 2 } });
  assert.equal(out.plan.length, 1);
  assert.deepEqual(out.plan[0].jobs, ['j0', 'j1']);
  assert.deepEqual(out.unassigned, ['j2', 'j3', 'j4']);
});

test('GUI 通道 cap 恒为 1，caps.trae=8 也调不高', () => {
  const one = planPool(jobs(3), { lanes: ['trae'], caps: { trae: 8 } });
  assert.equal(one.plan[0].jobs.length, 1);
  assert.equal(one.unassigned.length, 2);
  const gui = planPool(jobs(4), { lanes: ['trae', 'workbuddy', 'doubao'], caps: { trae: 9, workbuddy: 9, doubao: 9 } });
  assert.equal(ids(gui.plan).length, 3);
  for (const p of gui.plan) assert.equal(p.jobs.length, 1, p.lane);
});

test('一个 writer 都不在 → ok:false / no-writer-lane', () => {
  const out = planPool(jobs(3), { probes: { codebuddy: false, codex: false, ollama: false } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-writer-lane');
  assert.deepEqual(out.plan, []);
  assert.deepEqual(out.unassigned, ['j0', 'j1', 'j2']);
});

test('按轮转铺开：两池均分且交替', () => {
  const out = planPool(jobs(4), { lanes: ['codebuddy', 'codex'], caps: { codebuddy: 6, codex: 6 } });
  assert.deepEqual(out.plan[0].jobs, ['j0', 'j2']);
  assert.deepEqual(out.plan[1].jobs, ['j1', 'j3']);
});

test('runPool 池内并发不超过 cap（峰值断言）', async () => {
  const active = { codebuddy: 0, codex: 0 };
  const peak = { codebuddy: 0, codex: 0 };
  const ask = async (lane) => {
    active[lane] += 1;
    peak[lane] = Math.max(peak[lane], active[lane]);
    await new Promise((r) => setTimeout(r, 10));
    active[lane] -= 1;
    return { ok: true, out: lane };
  };
  const out = await runPool(jobs(3), { lanes: ['codebuddy', 'codex'], caps: { codebuddy: 2, codex: 1 }, ask });
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 3);
  assert.equal(peak.codebuddy, 2);
  assert.equal(peak.codex, 1);
  for (const r of out.results) assert.equal(r.ok, true);
});

test('连续 2 条失败判 dead：池里还没跑的作业改派，results 记实际通道', async () => {
  const asked = [];
  const ask = async (lane, job) => {
    asked.push(`${lane}:${job.id}`);
    if (lane === 'codebuddy') return { ok: false, error: 'boom' };
    return { ok: true, out: `${lane}/${job.id}` };
  };
  const out = await runPool(jobs(5), { lanes: ['codebuddy', 'codex'], caps: { codebuddy: 1, codex: 4 }, ask });
  assert.ok(out.laneStats.codebuddy.fail >= 2, 'codebuddy 应当连败');
  assert.ok(out.reassigned.length >= 1, '应当有改派');
  const moved = out.results.find((r) => r.id === 'j4');
  assert.equal(moved.lane, 'codex');
  assert.equal(moved.ok, true);
  assert.equal(out.results.length, 5);
  assert.equal(asked.includes('codebuddy:j0'), true);
});

test('单条失败不中断其它作业，也不误判 dead', async () => {
  let calls = 0;
  const ask = async (lane, job) => {
    calls += 1;
    if (job.id === 'j2') return { ok: false, error: 'flaky' };
    return { ok: true, out: job.id };
  };
  const out = await runPool(jobs(3), { lanes: ['codebuddy', 'codex'], caps: { codebuddy: 1, codex: 2 }, ask });
  assert.equal(out.results.filter((r) => r.ok).length, 2);
  const bad = out.results.filter((r) => !r.ok);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].id, 'j2');
  assert.equal(bad[0].error, 'flaky');
  assert.deepEqual(out.reassigned, []);
  assert.equal(calls, 3);
  assert.equal(out.ok, false);
});

test('ask 抛异常按失败计，不把整池拖垮', async () => {
  const ask = async (lane, job) => {
    if (job.id === 'j1') throw new Error('timeout');
    return { ok: true, out: job.id };
  };
  const out = await runPool(jobs(3), { lanes: ['codebuddy', 'codex'], caps: { codebuddy: 1, codex: 2 }, ask });
  const bad = out.results.find((r) => r.id === 'j1');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /timeout/);
  assert.equal(out.results.filter((r) => r.ok).length, 2);
});

test('每条结果都带实际通道，顺序按输入', async () => {
  const ask = async (lane) => ({ ok: true, out: lane });
  const out = await runPool(jobs(4), { lanes: ['codebuddy', 'codex'], caps: { codebuddy: 2, codex: 2 }, ask });
  assert.deepEqual(out.results.map((r) => r.id), ['j0', 'j1', 'j2', 'j3']);
  for (const r of out.results) assert.ok(['codebuddy', 'codex'].includes(r.lane));
  assert.equal(out.laneStats.codebuddy.ok + out.laneStats.codex.ok, 4);
});

test('runPool 缺 ask 直接判死', async () => {
  const out = await runPool(jobs(2));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-ask');
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.laneStats, {});
});
