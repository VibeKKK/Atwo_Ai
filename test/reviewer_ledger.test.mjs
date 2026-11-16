// test/reviewer_ledger.test.mjs —— 异源父审的可用性台账
// 口径：没有样本 ≠ 可用，也 ≠ 不可用。台账只回答「这段时间里它成过几次」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEDGER_CONTRACT, USABLE_MIN_OK, USABLE_WINDOW, appendEntry, ledgerPath, readLedger, recommendReviewers, recordProbes, renderLedger, summarizeLane, summarizeLedger } from '../lib/reviewer-ledger.mjs';
import { probeReviewers } from '../lib/reviewer-probe.mjs';
import { runFanout } from '../lib/fanout-run.mjs';

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-ledger-'));

// 1. 写入与读回
{
  const row = appendEntry(tmp, { lane: 'workbuddy', ok: true, ms: 1200, source: 'probe' });
  ok(row && row.contract === LEDGER_CONTRACT && !!row.ts, '1 写入带契约与时间戳');
  const back = readLedger(tmp);
  ok(back.length === 1 && back[0].lane === 'workbuddy', '1b 读得回（' + back.length + ' 行）');
  ok(ledgerPath(tmp).endsWith(path.join('memory', 'reviewer-ledger.jsonl')), '1c 落在 memory/ 下（运行时证据，不进 git）');
}

// 2. 坏行跳过不猜
{
  fs.appendFileSync(ledgerPath(tmp), '{"lane":"half\n');
  ok(readLedger(tmp).length === 1, '2 半行/坏行被跳过，不伪造记录');
}

// 3. 判读
{
  const mk = (okN, failN) => [...Array(okN)].map((_, i) => ({ lane: 'x', ok: true, ms: 1000 + i * 100 })).concat([...Array(failN)].map(() => ({ lane: 'x', ok: false, reason: '超时' })));
  const u = summarizeLane(mk(4, 1));
  ok(u.verdict === 'usable' && u.okRuns === USABLE_MIN_OK + 1, '3 4 成 1 败 → usable（' + u.verdict + '）');
  const d = summarizeLane(mk(0, 5));
  ok(d.verdict === 'dead' && d.failStreak >= 3, '3b 连败 → dead');
  const f = summarizeLane(mk(1, 2));
  ok(f.verdict === 'flaky' && f.okRuns === 1, '3c 成过一次但不够门槛 → flaky（不许说可用）');
  const n = summarizeLane([]);
  ok(n.verdict === 'unknown' && n.runs === 0, '3d 没样本 → unknown（不是可用也不是不可用）');
  ok(summarizeLane(mk(4, 1)).medianMs === 1150, '3e 中位耗时取成功那几次');
}

// 4. 只按最近窗口判（老战绩不续命）
{
  const rows = [...Array(3)].map(() => ({ lane: 'y', ok: true, ms: 500 })).concat([...Array(3)].map(() => ({ lane: 'y', ok: false, reason: '空内容' })));
  const s = summarizeLane(rows);
  ok(s.runs === USABLE_WINDOW && s.okRuns === USABLE_MIN_OK - 1, '4 窗口只取最近 ' + USABLE_WINDOW + ' 次（成 ' + s.okRuns + '）');
  ok(s.verdict === 'dead', '4b 最近三次全败 → dead，不靠老战绩说可用');
}

// 5. 排名与推荐
{
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-ledger2-'));
  for (let i = 0; i < 3; i += 1) appendEntry(t2, { lane: 'fast', ok: true, ms: 8000 });
  for (let i = 0; i < 3; i += 1) appendEntry(t2, { lane: 'slow', ok: true, ms: 40000 });
  appendEntry(t2, { lane: 'broken', ok: false, reason: '服务端错' });
  const s = summarizeLedger(t2);
  ok(s.lanes[0].lane === 'fast' && s.lanes[s.lanes.length - 1].lane === 'broken', '5 可用的排前面，坏的沉底：' + s.lanes.map((l) => l.lane + ':' + l.verdict).join(','));
  const rec = recommendReviewers(s, 2);
  ok(rec.lanes.join(',') === 'fast,slow', '5b 推荐只取 usable 且快的优先：' + rec.lanes.join(','));
  const empty = recommendReviewers(summarizeLedger(fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-ledger3-'))), 1);
  ok(empty.lanes.length === 0 && /doctor --reviewers/.test(empty.why), '5c 没样本时不硬推，指向探活命令');
  ok(/异源台账/.test(renderLedger(s)) && /fast/.test(renderLedger(s)), '5d 渲染含各通道判读');
  ok(/（空 —— 跑一次/.test(renderLedger({ lanes: [] })), '5e 空台账有明确提示');
  fs.rmSync(t2, { recursive: true, force: true });
}

// 6. recordProbes 字段映射
{
  const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-ledger4-'));
  const rows = recordProbes(t3, [
    { lane: 'a', ok: true, ms: 1234, verdicts: [{ id: 'child-1', verdict: 'PASS' }] },
    { lane: 'b', ok: false, ms: 99, reasons: ['超时', '占位'] },
  ], 'probe');
  ok(rows.length === 2 && rows[1].reason === '超时；占位' && rows[1].source === 'probe', '6 失败理由拼接、来源可辨');
  fs.rmSync(t3, { recursive: true, force: true });
}

// 7. probeReviewers{record:false} 不写；record 默认写
{
  const t4 = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-ledger5-'));
  const ask = async () => ({ ok: true, addedText: 'VERDICT: 随便' });
  await probeReviewers(['lane-x'], 'lib/x.mjs:1', { cwd: t4, ask, record: false });
  ok(readLedger(t4).length === 0, '7 record:false 不写台账（测试/离线场景）');
  const res = await probeReviewers(['lane-x'], 'lib/x.mjs:1', { cwd: t4, ask });
  ok(readLedger(t4).length === 1 && res.length === 1, '7b 默认写一行（探活即记账）');
  ok(readLedger(t4)[0].ok === false, '7c 探活判不过 → 记败（刚才那份回答没有真票）');
  fs.rmSync(t4, { recursive: true, force: true });
}

// 8. 真跑 fanout 会记账；注入 ask 的假通道不记（那不是真实通道的可用性）
{
  const t5 = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-ledger6-'));
  fs.writeFileSync(path.join(t5, 'a.mjs'), 'export const a = 1;\n');
  const ask = async () => ({ ok: true, addedText: 'ANSWER: 一\nEVIDENCE: a.mjs:1' });
  await runFanout({ task: '看 a.mjs', parts: 2, cwd: t5, ask, reviewChunk: 0, speculativeResend: false, noPreGate: true });
  ok(readLedger(t5).length === 0, '8 注入通道（injected）不记 —— 不把测试通道算成可用性');
  fs.rmSync(t5, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('reviewer_ledger: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
