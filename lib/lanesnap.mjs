// lib/lanesnap.mjs —— 一条命令回答「现在哪条通道能用、哪条被拉黑、每条该用哪个模型」。
//
// 为什么不并进 lib/lanes.mjs：那里是多路调度器（LANE_DEFS/planLanes/dispatchLanes），
// 是「怎么把活分给几路」；这里是「现在各路健康度如何」，是给人/AI 看一眼的只读快照。
//
// 为什么需要：memory/log.jsonl 几百行、字段混杂，AI 要判断「这条通道现在可不可派」
// 不该靠读日志 —— 这里把它聚合成一次可解析的结果（--json 直接给 data.snapshot）。

import fs from 'node:fs';
import path from 'node:path';
import { listBlocks, isBlocked, multOf, withinBudget, usablePool } from './models.mjs';

/** 已知通道（顺序即展示顺序）。 */
const ALL_LANES = ['codebuddy', 'trae', 'workbuddy', 'doubao', 'ollama'];

/** 读配额账本尾部若干条；坏行跳过，绝不抛。 */
export function readQuotaRecords(file, { window = 200 } = {}) {
  if (!fs.existsSync(file)) return [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const out = [];
  for (const l of lines.slice(-window)) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o.agent === 'string') out.push(o);
    } catch { /* 坏行不算错 */ }
  }
  return out;
}

/**
 * 聚合成快照。
 * @returns {{window:number, records:number, blocks:number, lanes:Array<object>}}
 */
export function lanesSnapshot({ cwd, window = 200, now = Date.now() } = {}) {
  const dir = cwd || process.cwd();
  const recs = readQuotaRecords(path.join(dir, 'memory', 'log.jsonl'), { window });
  const blocks = listBlocks(now);

  const lanes = ALL_LANES.map((lane) => {
    const mine = recs.filter((r) => r.agent === lane);
    // 只把「真发了请求」的记录算进成功率：0 秒失败是压根没发出去（hy3 误配那天 192 条），
    // 混进分母会把一条好好的通道印成 2% 成功率，然后没人敢用。
    const judged = mine.filter((r) => r.ok === true || Number(r.elapsedMs) > 0);
    const zeroSecFail = mine.filter((r) => r.ok !== true && !(Number(r.elapsedMs) > 0)).length;
    const okN = judged.filter((r) => r.ok === true).length;
    const failN = judged.length - okN;
    const timed = mine.filter((r) => Number(r.elapsedMs) > 0);
    const avgMs = timed.length
      ? Math.round(timed.reduce((s, r) => s + Number(r.elapsedMs), 0) / timed.length)
      : 0;
    const blk = blocks.filter((b) => b.agent === lane);
    const pool = typeof usablePool === 'function' ? usablePool(lane) : [];
    const cheap = pool
      .filter((m) => withinBudget(m) && !isBlocked(lane, m, now))
      .sort((a, b) => (multOf(a) ?? 9) - (multOf(b) ?? 9));
    return {
      lane,
      samples: mine.length,
      ok: okN,
      fail: failN,
      rate: judged.length ? Math.round((okN / judged.length) * 100) / 100 : null,
      judged: judged.length,
      zeroSecFail,
      avgMs,
      blocked: blk.length > 0,
      blockReasons: blk.map((b) => b.reason),
      bestModel: cheap[0] ?? null,
      bestMult: cheap[0] ? multOf(cheap[0]) : null,
    };
  });

  return { window, records: recs.length, blocks: blocks.length, lanes };
}

/** 给人看：一行一条，符号在前。 */
export function renderLanes(snap) {
  const head = `▶ 通道快照（最近 ${snap.records} 条配额记录 · 不可用名单 ${snap.blocks} 条）`;
  const rows = snap.lanes.map((l) => {
    const rate = l.rate === null ? '无样本' : `${l.ok}/${l.samples} 成功（${Math.round(l.rate * 100)}%）`;
    const ms = l.avgMs ? ` · 均 ${l.avgMs}ms` : '';
    const pick = l.bestModel ? ` · 首选 ${l.bestModel}（${l.bestMult}x）` : ' · 无预算内模型';
    const mark = l.blocked ? '⛔' : (l.ok === 0 && l.fail > 0 ? '⚠' : '·');
    const block = l.blocked ? ` · 已拉黑：${l.blockReasons[0] ?? '原因未记'}` : '';
    return `  ${mark} ${String(l.lane).padEnd(10)} ${rate}${ms}${pick}${block}`;
  });
  return [head, ...rows].join('\n');
}
