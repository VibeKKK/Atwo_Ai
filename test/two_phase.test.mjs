// 两段式的验收：计划轮必须先跑、每片必须看到别人的计划、关掉时一轮都不能多花。
// 只测行为，不测文案——文案会改，行为不该改。
import { runFanout } from '../lib/fanout-run.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('ok ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

const mkAsk = (log) => async (prompt) => {
  log.push(prompt);
  if (prompt.includes('施工计划')) return { ok: true, addedText: '计划：改 lib/a.mjs，先改导出，风险是测试没覆盖' };
  return { ok: true, addedText: 'EVIDENCE: lib/a.mjs:1 x=1\nVERDICT: ACCEPT' };
};

const task = '改 lib/a.mjs 与 lib/b.mjs 两个文件里的导出名';
const splitPlan = {
  chunks: [
    { index: 0, total: 2, units: [{ unit: 'lib/a.mjs', abs: 'lib/a.mjs', bytes: 10 }], label: 'chunk-1/2' },
    { index: 1, total: 2, units: [{ unit: 'lib/b.mjs', abs: 'lib/b.mjs', bytes: 10 }], label: 'chunk-2/2' },
  ],
  units: [{ unit: 'lib/a.mjs', abs: 'lib/a.mjs', bytes: 10 }, { unit: 'lib/b.mjs', abs: 'lib/b.mjs', bytes: 10 }],
  reason: '',
  strategy: 'clusters',
};

// ① 开着两段式：计划轮 2 次（每片一次），随后才是干活轮
{
  const log = [];
  await runFanout({ task, ask: mkAsk(log), splitPlan, twoPhase: true, parts: 2, review: false, cwd: process.cwd() });
  const planCalls = log.filter((p) => p.includes('施工计划')).length;
  ok(planCalls === 2, '两段式：每片各问一次计划（实际 ' + planCalls + '）');
  const workerCalls = log.filter((p) => p.includes('## 各片计划（只读，用来避免撞车）'));
  ok(workerCalls.length >= 2, '两段式：干活轮每片都带上了「各片计划」段（实际 ' + workerCalls.length + '）');
  ok(workerCalls.every((p) => p.includes('先改导出')), '两段式：段里真有别人那份计划的内容');
  ok(workerCalls.every((p) => p.includes('## 队友在改什么')), '两段式：原来的队友清单还在（没被覆盖）');
}

// ② 关着：一次计划轮都不许有
{
  const log = [];
  await runFanout({ task, ask: mkAsk(log), splitPlan, twoPhase: false, parts: 2, review: false, cwd: process.cwd() });
  const planCalls = log.filter((p) => p.includes('施工计划')).length;
  ok(planCalls === 0, '关闭时：一次计划轮都没有（实际 ' + planCalls + '）');
  ok(log.every((p) => !p.includes('## 各片计划')), '关闭时：任务里不出现「各片计划」段');
}

// ③ 单片任务不该问计划（切都没切，问计划纯浪费）
{
  const log = [];
  const single = { chunks: [], units: [{ unit: 'lib/a.mjs', abs: 'lib/a.mjs', bytes: 10 }], reason: 'single-cluster', strategy: 'none' };
  await runFanout({ task, ask: mkAsk(log), splitPlan: single, twoPhase: true, parts: 1, review: false, cwd: process.cwd() });
  ok(log.filter((p) => p.includes('施工计划')).length === 0, '单片任务：不问计划');
}

console.log('');
console.log((fail === 0 ? '全部通过' : '有失败') + '：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
