// test/reviewer_run_verdict.test.mjs —— 「通道当父审」的成败判据 + 默认父审必须避开刚失败过的通道
// 起因（2026-11-17 实测两次）：
//   1. ollama 探活全绿（child-1 PASS / child-2 REVISE / child-3 REVISE，7.4s），
//      但拿真产物去审时编造引文（把 lib/syntax.mjs:26 原文抄错），机械闸门抓住了它 —— 台账却记了 ok:true。
//   2. 纠正后又跑一次，它直接「通道返回 ok:false 且没给 err」；可它均耗时最快，
//      只按「历史成功次数 + 均耗时」排序就仍然是第一名 → 默认父审会稳定选中一条干不了活的通道。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeReviewerRun, pickReviewLane } from '../lib/fanout-run.mjs';
import { appendEntry } from '../lib/reviewer-ledger.mjs';

let pass = 0; let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}

// —— 判据本身 ——
ok(judgeReviewerRun({ laneErr: null, reviews: [{ reason: '看着没问题，可以过' }] }).ok === true,
  '正常评审算成功');
ok(judgeReviewerRun({ laneErr: 'timeout' }).ok === false, '通道报错算失败');
const citeBad = judgeReviewerRun({ laneErr: null, reviews: [{ reason: '机械闸门：引文与原文的数字对不上 —— 你写的是「export function」，该行实际是…' }] });
ok(citeBad.ok === false, '编造引文必须算失败（这是最贵的错：它看着像审过了）', JSON.stringify(citeBad));
ok(/编造引文/.test(String(citeBad.reason)), '失败理由写明「编造引文」，别让人以为是超时', String(citeBad.reason));
ok(judgeReviewerRun({ laneErr: null, reviews: [{ reason: '父审判了 REVISE 但理由里没有可核对的「文件:行」' }] }).ok === true,
  '「没给引文」只降级不算通道失败（那是产物/提示问题，不是通道坏了）');

// —— 默认父审：刚失败过的通道必须沉底 ——
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-runv-'));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const H = 3600 * 1000;
const put = (dir, lane, { ok: okFlag = true, ms = 20000, n = 4, ago = H, source = 'fanout' } = {}) => {
  for (let i = 0; i < n; i++) appendEntry(dir, { lane, ok: okFlag, ms, reason: okFlag ? null : 'stub', chunks: 3, source, ts: iso(ago) });
};

const d = mk();
// fast 通道：历史成功 4 次、飞快，但最近一次失败
put(d, 'fast', { ms: 3000, n: 4, ago: 3 * H });
appendEntry(d, { lane: 'fast', ok: false, ms: 0, reason: '编造引文（机械闸门抓）', chunks: 0, source: 'fanout', ts: iso(H) });
// slow 通道：每次都成功，但慢
put(d, 'slow', { ms: 60000, n: 4, ago: 2 * H });
const got = pickReviewLane(d);
ok(got === 'slow', '最近一次失败的快通道不会被选为默认父审（宁可慢，不能编）', got);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
