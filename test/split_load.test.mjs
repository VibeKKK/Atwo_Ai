// test/split_load.test.mjs —— 切分的「字节负载」与「跨片引用」两把尺子
// 口径：片数由 split.mjs 的规则定，本文件只管两件更细的事——
//   ① 谁去哪片（按字节 LPT，而不是按单元个数轮分）
//   ② 片与片之间有没有互相 import（有的话两路子会话会各自去读对方文件，合并出两份矛盾结论）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_LOAD_RATIO, checkLoad, crossChunkEdges, importEdges, loadOfChunk, rebalanceByLoad, renderLoadLine, unitBytes } from '../lib/split-load.mjs';
import { planSplit } from '../lib/split.mjs';
import { runFanout } from '../lib/fanout-run.mjs';

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };

// 造一个临时工作区：四个大小悬殊的文件，其中两个互相 import
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-splitload-'));
const mk = (name, bytes, body) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body != null ? body : 'x'.repeat(bytes));
  return p;
};
mk('big.mjs', 8000);
mk('tiny.mjs', 100, "import { a } from './mid.mjs';\nexport const t = 1;\n");
mk('mid.mjs', 2000, "import { b } from './tiny.mjs';\nexport const a = 1;\n");
mk('other.mjs', 4000);
const unit = (name) => ({ unit: name, abs: path.join(tmp, name), exists: true });
const units = ['big.mjs', 'tiny.mjs', 'mid.mjs', 'other.mjs'].map(unit);
const planOf = (groups) => ({
  chunks: groups.map((g, i) => ({ index: i, total: groups.length, label: 'chunk-' + (i + 1) + '/' + groups.length, units: g.map(unit) })),
  units, strategy: 'units', count: groups.length,
});

// 1. 字节读取
{
  ok(unitBytes(unit('big.mjs'), tmp) === 8000, '1 字节数读得到（8000）');
  ok(unitBytes({ unit: 'nope.mjs', abs: path.join(tmp, 'nope.mjs') }, tmp) === 0, '1b 不存在记 0，不抛');
}

// 2. LPT 把字节拉平：轮分 8000+100 / 2000+4000 = 8100/6000 仍不均，改造成 3 片看差异
{
  const plan = planOf([['big.mjs'], ['tiny.mjs'], ['mid.mjs', 'other.mjs']]);
  const before = Math.max(...plan.chunks.map((c) => loadOfChunk(c, tmp))) / Math.min(...plan.chunks.map((c) => loadOfChunk(c, tmp)));
  const bal = rebalanceByLoad(plan, { cwd: tmp });
  const after = Math.max(...bal.chunks.map((c) => loadOfChunk(c, tmp))) / Math.min(...bal.chunks.map((c) => loadOfChunk(c, tmp)));
  ok(after < before, '2 LPT 后字节比变小（' + before.toFixed(2) + '× → ' + after.toFixed(2) + '×）');
  ok(bal.chunks.length === plan.chunks.length, '2b 片数不变');
  ok(bal.chunks.every((c, i) => c.label === 'chunk-' + (i + 1) + '/' + plan.chunks.length), '2c label 规则不变（mergeParts 靠它对齐）');
  ok(bal.strategy === 'units-by-load', '2d 策略标成 units-by-load');
  ok(bal.units.length === 4, '2e 单元一个不丢');
  ok(bal.chunks.flatMap((c) => c.units.map((u) => u.unit)).sort().join(',') === 'big.mjs,mid.mjs,other.mjs,tiny.mjs', '2f 不重不漏');
}

// 3. import 边：只算两端都在单元里的
{
  const edges = importEdges(units, tmp);
  ok(edges.length === 2, '3 两条边（tiny→mid、mid→tiny），实得 ' + edges.length);
  const only = importEdges([unit('tiny.mjs')], tmp);
  ok(only.length === 0, '3b 对方不在单元里 → 不算边（只算本次要切的那些）');
}

// 4. 跨片引用能数出来；同片为 0
{
  const split = planOf([['big.mjs', 'other.mjs'], ['tiny.mjs', 'mid.mjs']]);
  ok(crossChunkEdges(split, tmp).cross.length === 0, '4 互相引用的两个放同一片 → 跨片 0');
  const bad = planOf([['tiny.mjs'], ['mid.mjs']]);
  const c = crossChunkEdges(bad, tmp);
  ok(c.cross.length === 2 && c.total === 2, '4b 拆开放两片 → 跨片 2 条被数出来');
}

// 5. checkLoad 三态
{
  const even = planOf([['big.mjs', 'other.mjs'], ['tiny.mjs', 'mid.mjs']]);
  const r1 = checkLoad(even, { cwd: tmp });
  ok(r1.verdict === 'weak' && r1.items.some((i) => i.code === 'load-balanced' && !i.ok), '5 8100/2100 判 weak（' + r1.verdict + '）');
  const skew = planOf([['big.mjs'], ['tiny.mjs']]);
  const r2 = checkLoad(skew, { cwd: tmp, maxLoadRatio: 999 });
  ok(r2.verdict === 'ok', '5b 放宽上限后 ok（说明阈值真的从参数来）');
  const none = checkLoad({ chunks: [], units: [] }, { cwd: tmp });
  ok(none.verdict === 'skip', '5c 没切分 → skip，不假装判过');
  const zero = planOf([['big.mjs'], ['nope1.mjs']]);
  const r3 = checkLoad(zero, { cwd: tmp });
  ok(r3.items.some((i) => i.code === 'load-covered' && !i.ok), '5d 有片 0 字节 → load-covered 报警（均衡数字没意义）');
  ok(MAX_LOAD_RATIO === 2.5, '5e 默认上限 2.5');
}

// 6. 渲染
{
  const r = checkLoad(planOf([['big.mjs', 'other.mjs'], ['tiny.mjs', 'mid.mjs']]), { cwd: tmp });
  const line = renderLoadLine(r);
  ok(/^▶ 负载：/.test(line) && /KB/.test(line) && /负载均衡/.test(line), '6 行内同时给字节与判据：' + line.slice(0, 60));
  ok(renderLoadLine({ verdict: 'skip', items: [] }) === '▶ 负载：不切，无需判', '6b skip 有专门文案');
}

// 7. runFanout 接受算好的 splitPlan（不重算）
{
  const calls = [];
  const ask = async (task) => { calls.push(task); return 'ANSWER: 就这些\nEVIDENCE: big.mjs:1'; };
  const split = planOf([['big.mjs', 'other.mjs'], ['tiny.mjs', 'mid.mjs']]);
  const res = await runFanout({ task: '看这四个文件', parts: 2, cwd: tmp, ask, splitPlan: split, reviewChunk: 0, speculativeResend: false, noPreGate: true });
  const childCalls = calls.filter((t) => /你这一片只负责/.test(t));
  const reviewCalls = calls.filter((t) => /你这一片只负责/.test(t) === false);
  ok(childCalls.length === 2, '7 片数=路数（splitPlan 说了算，不理会 parts），实派子会话 ' + childCalls.length + '（另有 ' + reviewCalls.length + ' 次父审）');
  ok(childCalls.every((t) => /不要越界/.test(t)) && childCalls.length === 2, '7b 每路拿到的是成片任务而不是原文');
  ok(res.split && res.split.chunks === 2, '7c 结果里带 split 描述');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('split_load: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
