// _probe/split_calib.mjs —— 切分质量标定：把 atwo 的切法与人工理想切法对比
// 为什么要有这个：定位是「效率优先 = 把大任务切成能完美契合的小任务」，
// 但 planSplit 的公式（每片 ≥2 单元、最多 4 片）是拍脑袋的，一条度量都没有。
import fs from 'node:fs';
import path from 'node:path';
import { planSplit, checkSplit, detectUnits, describeSplit } from '../lib/split.mjs';

const root = path.resolve(import.meta.dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'split-tasks.json'), 'utf8'));

const jaccard = (a, b) => {
  const A = new Set(a); const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
};

// 把 atwo 的片与人工理想组做最优一一配对，返回每片的最佳匹配纯度
function purity(actual, ideal) {
  const used = new Set();
  const scores = [];
  for (const chunk of actual) {
    let best = 0; let bi = -1;
    ideal.forEach((g, i) => {
      if (used.has(i)) return;
      const s = jaccard(chunk, g);
      if (s > best) { best = s; bi = i; }
    });
    if (bi >= 0) used.add(bi);
    scores.push(best);
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

const rows = [];
for (const t of spec.tasks) {
  const units = detectUnits(t.task, { cwd: root });
  const plan = planSplit(t.task, { cwd: root, maxChunks: 4 });
  const score = checkSplit(plan, { cwd: root });
  const chunks = plan && plan.chunks ? plan.chunks.map((c) => (c.units || c).map((u) => (typeof u === 'string' ? u : u.unit))) : [];
  const decidedSplit = chunks.length > 1;
  const ideal = t.idealGroups;
  const p = decidedSplit ? purity(chunks, ideal) : (t.shouldSplit ? 0 : 1);
  // 片数上限（默认 4）是调用方的约束，不是切分质量问题：5 份独立文档切 4 片算对，
  // 想切 5 片得显式 --split 5。
  const cap = 4;
  const countOk = decidedSplit ? (chunks.length === Math.min(cap, t.idealChunks)) : (t.idealChunks === 1);
  const detectAll = ideal.flat().every((f) => units.some((u) => u.unit === f));
  rows.push({
    id: t.id,
    shouldSplit: t.shouldSplit,
    decidedSplit,
    verdict: score.verdict,
    units: units.length,
    idealUnits: ideal.flat().length,
    detectAll,
    actualChunks: chunks.length,
    idealChunks: t.idealChunks,
    countOk,
    purity: Number(p.toFixed(2)),
    judge: t.shouldSplit
      ? (decidedSplit && countOk && p >= 0.8 ? '对' : '偏')
      : (decidedSplit ? '错切（本该整片做）' : '对'),
    why: t.why,
  });
}

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(pad('任务', 20) + pad('该切', 5) + pad('实切', 5) + pad('片数', 8) + pad('单元', 8) + pad('认出全部', 9) + pad('纯度', 6) + '判定');
for (const r of rows) {
  console.log(pad(r.id, 20) + pad(r.shouldSplit ? '是' : '否', 5) + pad(r.decidedSplit ? '是' : '否', 5)
    + pad(r.actualChunks + '/' + r.idealChunks, 8) + pad(r.units + '/' + r.idealUnits, 8)
    + pad(r.detectAll ? '✓' : '✗', 9) + pad(r.purity, 6) + r.judge);
}

const should = rows.filter((r) => r.shouldSplit);
const shouldNot = rows.filter((r) => !r.shouldSplit);
const acc = (list) => list.filter((r) => r.judge === '对').length;
console.log('');
console.log('该切的 ' + should.length + ' 个：判对 ' + acc(should) + ' 个');
console.log('不该切的 ' + shouldNot.length + ' 个：判对 ' + acc(shouldNot) + ' 个');
console.log('认出全部单元：' + rows.filter((r) => r.detectAll).length + '/' + rows.length);
console.log('总判定正确率：' + acc(rows) + '/' + rows.length);
fs.writeFileSync(path.join(root, '_probe', 'split_calib_result.json'), JSON.stringify({ contract: 'atwo-split-calibration-result/1', rows }, null, 2));
