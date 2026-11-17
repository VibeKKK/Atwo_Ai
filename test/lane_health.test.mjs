/**
 * 通道健康度：只从账本里数，不探活、不发请求、不进模型。
 *
 * 这组断言的目的是守住三条口径，不是测数学：
 * 样本不足不下结论、quota 不算干活、坏通道沉底但不删。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORK_KINDS, laneHealth, looksBroken, rankByHealth, renderHealth } from '../lib/lane-health.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name); }
};

const now = Date.parse('2026-11-18T00:00:00Z');
const t = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();

const entries = [
  // codebuddy：6 单 5 成（当天）
  { kind: 'swarm', agent: 'codebuddy', ok: true, elapsedMs: 78000, time: t(0) },
  { kind: 'swarm', agent: 'codebuddy', ok: true, elapsedMs: 82000, time: t(0) },
  { kind: 'ask', agent: 'codebuddy', ok: true, elapsedMs: 6000, time: t(1) },
  { kind: 'ask', agent: 'codebuddy', ok: true, elapsedMs: 8000, time: t(1) },
  { kind: 'ask', agent: 'codebuddy', ok: true, elapsedMs: 9000, time: t(2) },
  { kind: 'ask', agent: 'codebuddy', ok: false, elapsedMs: 0, time: t(2) },
  // doubao：6 单全败
  ...Array.from({ length: 6 }, (_, i) => ({ kind: 'review', agent: 'doubao', ok: false, elapsedMs: 123000, time: t(i % 3) })),
  // workbuddy：2 单（样本不足）
  { kind: 'swarm', agent: 'workbuddy', ok: false, elapsedMs: 155000, time: t(0) },
  { kind: 'swarm', agent: 'workbuddy', ok: true, elapsedMs: 160000, time: t(1) },
  // 时间窗外：三个月前的 50 连败不该拖累 trae
  ...Array.from({ length: 50 }, () => ({ kind: 'ask', agent: 'trae', ok: false, elapsedMs: 15000, time: t(90) })),
  { kind: 'ask', agent: 'trae', ok: true, elapsedMs: 15000, time: t(0) },
  // quota 不算干活
  ...Array.from({ length: 20 }, () => ({ kind: 'quota', agent: 'codebuddy', model: '', multiplier: 1, points: 100, ok: false, elapsedMs: 0, time: t(0) })),
  // 没有 agent 字段的条目直接被跳过
  { kind: 'ask', ok: true, elapsedMs: 1000, time: t(0) },
];

const rows = laneHealth(entries, { now, windowMs: 7 * 86400000 });
const byLane = new Map(rows.map((r) => [r.lane, r]));

ok(rows.length === 4, '只统计出现过的四个通道（实际 ' + rows.length + '）');
ok(byLane.get('codebuddy').calls === 6, 'quota 条目不计入 codebuddy 的派活数（实际 ' + byLane.get('codebuddy').calls + '）');
ok(Math.abs(byLane.get('codebuddy').rate - 5 / 6) < 1e-9, 'codebuddy 成功率 5/6');
ok(byLane.get('doubao').rate === 0, 'doubao 0%');
ok(byLane.get('workbuddy').calls === 2, 'workbuddy 样本只有 2 单');
ok(byLane.get('trae').calls === 1, '时间窗外的 50 条不算（trae 只剩 1 单，实际 ' + byLane.get('trae').calls + '）');
ok(rows[0].lane === 'codebuddy', '按 Wilson 下界排序，样本厚的排第一（1 单 100% 不该压过 254 单 81%，实际 ' + rows[0].lane + '）');
ok(byLane.get('codebuddy').p50 === 9000, 'p50 取第 ceil(0.5n) 小的那个，不插值（5 个样本 → 第 3 小 = 9000，实际 ' + byLane.get('codebuddy').p50 + '）');

// looksBroken：样本够 + 低于底线 才算坏
ok(looksBroken(byLane.get('doubao')) === true, 'doubao 6 单 0% 判为坏');
ok(looksBroken(byLane.get('workbuddy')) === false, 'workbuddy 只 2 单不判坏（样本不足）');
ok(looksBroken(byLane.get('codebuddy')) === false, 'codebuddy 83% 不判坏');
ok(looksBroken(null) === false, 'null 不判坏');

// rankByHealth：坏通道沉底但不消失；未知通道夹在中间
const ranked = rankByHealth(['doubao', 'codebuddy', 'ollama', 'trae', 'workbuddy'], rows);
ok(ranked[0] === 'codebuddy', '健康度最高排第一（实际 ' + ranked[0] + '）');
ok(ranked[ranked.length - 1] === 'doubao', '坏通道沉到最末（实际 ' + ranked[ranked.length - 1] + '）');
ok(ranked.includes('doubao'), '坏通道不被删掉（删了就没法解释为何没被用）');
ok(ranked.indexOf('ollama') < ranked.indexOf('doubao'), '没有样本的通道排在坏通道之前');
ok(ranked.length === 5, '排序前后数量不变（实际 ' + ranked.length + '）');

// 确定性：同样输入两次结果一致
const again = rankByHealth(['doubao', 'codebuddy', 'ollama', 'trae', 'workbuddy'], rows);
ok(JSON.stringify(again) === JSON.stringify(ranked), '同样输入排序结果稳定');

// 空账本
ok(laneHealth([]).length === 0, '空账本返回空数组');
ok(renderHealth([]).includes('没有可用'), '空账本渲染成一句人话');

// 渲染
const line = renderHealth(rows);
ok(line.includes('codebuddy 83% (5/6)'), '渲染带百分比与样本量（' + line + '）');

// WORK_KINDS 口径
ok(WORK_KINDS.has('swarm') && WORK_KINDS.has('review') && !WORK_KINDS.has('quota'), 'quota 不在干活口径里');

fs.rmSync(path.join(os.tmpdir(), 'noop-atwo-health'), { force: true, recursive: true });
console.log('');
console.log('lane_health: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
