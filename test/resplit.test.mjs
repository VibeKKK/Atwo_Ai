// SPLIT/MERGE 反驳：片子自己说「我不该被切开」时，只认一行机器可读的 SPLIT: 指令。
// 为什么这么严：散文里「我觉得可以合并」出现频率极高，把它当信号等于让重排变成随机事件。
import { runFanout } from '../lib/fanout-run.mjs';

const NL = String.fromCharCode(10);
let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('ok ' + name); }
  else { fail += 1; console.log('FAIL ' + name); }
};

const task = '改 lib/a.mjs 与 lib/b.mjs 两个文件里的导出名';
const makeSplit = (n) => ({
  chunks: Array.from({ length: n }, (_, i) => ({
    index: i,
    total: n,
    units: [{ unit: 'lib/' + String.fromCharCode(97 + i) + '.mjs', abs: 'lib/a.mjs', bytes: 10 }],
    label: 'chunk-' + (i + 1) + '/' + n,
  })),
  units: [{ unit: 'lib/a.mjs', abs: 'lib/a.mjs', bytes: 10 }],
  reason: '',
  strategy: 'clusters',
});

const mkAsk = (plans, log) => async (prompt) => {
  log.push(prompt);
  if (prompt.includes('施工计划')) {
    const n = log.filter((x) => x.includes('施工计划')).length;
    return { ok: true, addedText: plans[n - 1] || '先改 a，再改 b' };
  }
  return { ok: true, addedText: 'EVIDENCE: lib/a.mjs:1 const A = 1' + NL + 'VERDICT: ACCEPT' };
};

// ① 计划里带 SPLIT: MERGE → 并成单路
{
  const log = [];
  const phases = [];
  const res = await runFanout({
    task, parts: 2, ask: mkAsk(['SPLIT: MERGE 两片都要改同一个导出，切开必撞', 'SPLIT: MERGE 同上'], log),
    splitPlan: makeSplit(2), twoPhase: true, review: false,
    onProgress: (e) => phases.push(e.phase), cwd: process.cwd(),
  });
  ok(phases.includes('resplit'), '有 SPLIT: MERGE 时发出 resplit 进度');
  ok(phases.includes('resplit-done'), '重排后发出 resplit-done');
  ok(res.children.length === 1, 'MERGE 后只剩一路（实际 ' + res.children.length + '）');
  ok(String(res.children[0].chunkLabel || '') === 'merged', '合并片标签是 merged');
  ok(phases.filter((p) => p === 'resplit').length === 1, '只重排一次');
}

// ② 没有 SPLIT 指令 → 不重排，两路照跑
{
  const log = [];
  const phases = [];
  const res = await runFanout({
    task, parts: 2, ask: mkAsk(['先改 a 再改 b', '先改 b 再改 a'], log),
    splitPlan: makeSplit(2), twoPhase: true, review: false,
    onProgress: (e) => phases.push(e.phase), cwd: process.cwd(),
  });
  ok(!phases.includes('resplit'), '没有指令就不重排');
  ok(res.children.length === 2, '原计划两路都跑（实际 ' + res.children.length + '）');
}

// ③ 散文里的「可以合并」不算指令
{
  const log = [];
  const phases = [];
  const res = await runFanout({
    task, parts: 2, ask: mkAsk(['我觉得可以合并，但没写指令', '先改 a'], log),
    splitPlan: makeSplit(2), twoPhase: true, review: false,
    onProgress: (e) => phases.push(e.phase), cwd: process.cwd(),
  });
  ok(!phases.includes('resplit'), '散文里的「可以合并」不触发重排');
  ok(res.children.length === 2, '两路都跑（实际 ' + res.children.length + '）');
}

// ④ 两段式关掉时，计划轮都不该有，自然也没有重排
{
  const log = [];
  const phases = [];
  const res = await runFanout({
    task, parts: 2, ask: mkAsk(['SPLIT: MERGE 撞了'], log),
    splitPlan: makeSplit(2), twoPhase: false, review: false,
    onProgress: (e) => phases.push(e.phase), cwd: process.cwd(),
  });
  ok(!phases.includes('resplit'), '两段式关闭时不重排（没有计划轮就没有反驳）');
  ok(res.children.length === 2, '两路都跑（实际 ' + res.children.length + '）');
}

console.log('');
console.log((fail === 0 ? '全部通过' : '有失败') + '：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
