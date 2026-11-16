import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runFanout } from '../lib/fanout-run.mjs';

let pass = 0, fail = 0;
const cases = [];
function it(name, fn) { cases.push([name, fn]); }

it('整体有墙钟兜底：每路超时不会让 fanout 永远等下去', async () => {
  // 2026-11-16 实测事故：3 路 + 父审跑了 17 分钟没有任何输出。每路都有 timeoutMs，
  // 但子进程被 kill 后孙进程仍握着 stdout 管道，promise 等不到 close —— 所以整体必须自己到点。
  const t0 = Date.now();
  const r = await runFanout({ task: 't', parts: 2, ask: () => ({ then: () => {} }), deadlineMs: 700 });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, '必须在 deadline 附近返回，实际 ' + ms + 'ms');
  assert.equal(r.deadlineHit, true);
  assert.equal(r.summary.state, 'unreviewed');
  assert.equal(r.summary.value, 0, 'deadline 不许伪装成通过');
  assert.equal(r.summary.counts.PASS, 0);
  assert.match(r.error, /deadline/);
});

it('兜底返回值够上层直接落盘：children/reviews 是空数组不是 undefined', async () => {
  const r = await runFanout({ task: 't', parts: 1, ask: () => ({ then: () => {} }), deadlineMs: 400 });
  assert.ok(Array.isArray(r.children));
  assert.ok(Array.isArray(r.reviews));
  assert.ok(Array.isArray(r.rounds));
  assert.equal(typeof r.elapsed.totalMs, 'number');
});

it('定时器不 unref：否则进程在没有其他句柄时直接退出，连兜底值都拿不到', () => {
  const src = fs.readFileSync(new URL('../lib/fanout-run.mjs', import.meta.url), 'utf8');
  assert.ok(!/timer\.unref\(\)/.test(src), '不许对兜底定时器 unref（实测会让输出为空）');
});

it('默认 deadline 是 2×timeout+120s，且 deadlineHit 字段存在', () => {
  const src = fs.readFileSync(new URL('../lib/fanout-run.mjs', import.meta.url), 'utf8');
  assert.match(src, /timeoutMs \* 2 \+ 120000/);
  assert.match(src, /deadlineHit: true/);
});

for (const [name, fn] of cases) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
