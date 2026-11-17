// test/split_calibration.test.mjs —— 切分标定：依赖聚类该切的切、该合的合
// 起因（2026-11-17 标定）：改前 10 个真实任务只判对 4 个 ——
//   ① 强耦合被切开：lib/fanout-run.mjs + lib/reviewer-ledger.mjs（一方 import 另一方）被切成 2 片；
//   ② 真的独立却不切：3 个互不相干的 test/*.test.mjs 因「少于 4 个单元」被拒绝切分；
//   ③ 通配失控：任务里写 lib/*.mjs 被展开成 83 个单元、切 4 片，纯度 0.02；
//   ④ 文档互引被并簇：README 提到 docs/research/*.md 就把 5 份独立文档并成 3 簇。
// 这个文件把四条判据钉死，防止以后改回「只看单元数量就切」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSplit, buildClusters, detectUnits, checkSplit } from '../lib/split.mjs';

const root = path.resolve(import.meta.dirname, '..');
let pass = 0; let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}

// 1) 强耦合（一方 import 另一方）→ 聚成一簇，拒绝切分
const coupled = '改 lib/fanout-run.mjs 的默认父审，从 lib/reviewer-ledger.mjs 读台账。';
const plan1 = planSplit(coupled, { cwd: root });
ok(plan1.chunks.length === 0, '强耦合的两个模块不切（一方 import 另一方）', JSON.stringify(plan1.reason));
ok(plan1.reason === 'single-cluster', '拒绝理由写明是 single-cluster，而不是含糊的「不该切」', plan1.reason);

// 2) 三个互不依赖的测试文件 → 切 3 片（旧实现因 MIN_UNITS_TO_SPLIT=4 拒绝）
const indep = '给 test/pitfall.test.mjs、test/score.test.mjs、test/outcome.test.mjs 各补三条反向断言。';
const plan2 = planSplit(indep, { cwd: root, maxChunks: 4 });
ok(plan2.chunks.length === 3, '三个零耦合测试文件切成 3 片（门槛看簇数不看文件数）', String(plan2.chunks.length));
ok(plan2.strategy === 'clusters', '切分策略标成 clusters（可复算）', plan2.strategy);
const score2 = checkSplit(plan2, { cwd: root });
ok(score2.verdict === 'ok', '切出来的三片通过 checkSplit（互斥/完整/均衡）', JSON.stringify(score2.items.filter((i) => !i.ok)));

// 3) 通配失控：lib/*.mjs 不该被展开成上百个单元
// 通配要真展开（早期版本为压住 atwo-verbs 的误切，加过「超过 12 个就返回空」的上限，
// 后来认定那是改错了地方：一个目录就是一真堆单元，切不切由依赖聚类决定，于是回滚。）
const globbed = '把 lib/*.mjs 全部过一遍 node --check。';
const units3 = detectUnits(globbed, { cwd: root });
ok(units3.length > 12, 'lib/*.mjs 这种通配真的展开成一堆单元（不是被静默丢掉）', String(units3.length));
const plan3 = planSplit(globbed, { cwd: root, maxChunks: 4 });
ok(plan3.chunks.length >= 2 && plan3.chunks.every((ch) => ch.units.length > 0), '展开后按簇切成 ≥2 片且无空片', String(plan3.chunks.length));

// 4) 文档之间不因「互相提到」并簇：5 份独立文档应得到 5 簇（受 maxChunks 限成 4 片）
const docs = '复核 docs/research/atwo-value-paper.md、docs/research/views.md、docs/research/views.trae.md、docs/research/views.codebuddy.md、README.md 的口径。';
const units4 = detectUnits(docs, { cwd: root });
const clusters4 = buildClusters(units4, { cwd: root });
ok(clusters4.length >= 4, '5 份文档聚成 ≥4 簇（文档互引不算依赖）', String(clusters4.length));
const plan4 = planSplit(docs, { cwd: root, maxChunks: 4 });
ok(plan4.chunks.length === Math.min(4, clusters4.length), '片数 = min(上限, 簇数)，不再用 floor(单元/2)', String(plan4.chunks.length));

// 5) 每一片都必须非空且不重复（切分坏了会让两路子会话改同一个文件）
const covered = new Set();
let dup = false;
let empty = 0;
for (const c of plan4.chunks) {
  if (!c.units.length) empty++;
  for (const u of c.units) { if (covered.has(u.unit)) dup = true; covered.add(u.unit); }
}
ok(empty === 0, '没有空片', String(empty));
ok(!dup, '同一文件不会同时落到两片');

// 6) 单元太少（<2 簇）时不切：把 1 个文件切两半只会更慢
const single = '只改 lib/lanes.mjs 里的 withHardTimeout。';
const plan6 = planSplit(single, { cwd: root });
ok(plan6.chunks.length === 0, '单个文件的活不切（切了只是写两遍开头）', plan6.reason);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
