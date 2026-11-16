// test/fanout_lane_complete.test.mjs —— 通道「答完了没有」与「谁的问题」必须分得清
// 三个真事故（2026-11-17 01:13 同一次夜跑）：
//   ① 长简报派三路：三路全「Max turns (10) exceeded」→ ANSWER 为空 → 被记成产物问题（其实是我们回合预算给少了）
//   ② WorkBuddy 当父审：返回半截 JSON + 「生成回复中 / 已消耗 6.22」→ 0 条票（其实是读得太早）
//   ③ 探活说 WorkBuddy 可用 28.6s，真跑当父审 0 条票 —— 探活的绿灯不能替真跑背书
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksIncomplete } from '../lib/lanes.mjs';
import { recommendReviewers, summarizeLane } from '../lib/reviewer-ledger.mjs';
import { runFanout } from '../lib/fanout-run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// 1. 半截答案能认出来
{
  ok(looksIncomplete('读取 reviewer-ledger.mjs\n\n[\n\n生成回复中\n已消耗 6.22'), '1 「生成回复中 / 已消耗」判成没写完');
  ok(looksIncomplete('{"votes":[{"id":"child-1","verdict":"PASS"}'), '1b 括号不闭合判成没写完');
  ok(!looksIncomplete('{"votes":[{"id":"child-1","verdict":"PASS"}]}'), '1c 完整 JSON 不算没写完');
  ok(!looksIncomplete('正常答案，括号配对（像这样）'), '1d 中文括号与正文不误判');
  ok(!looksIncomplete(''), '1e 空串不归它管（空答案由 looksPlaceholder 判，两个函数各管一段）');
}

// 2. 子会话回合预算：无分片时也要给（不再落到 codebuddy 的默认 10）
{
  const s = src('lib/fanout-run.mjs');
  ok(/ATWO_CHILD_MAX_TURNS/.test(s), '2 无分片子会话有显式回合预算（ATWO_CHILD_MAX_TURNS）');
  ok(/Math\.min\(60, 24 \+ Math\.ceil\(taskChars \/ 150\)\)/.test(s), '2b 回合预算按任务长度算（24 + 每 150 字 1 回合，上限 60）');
  const cli = fs.readFileSync(path.join(root, 'lib/fanout-cli.mjs'), 'utf8');
  ok(/Math\.min\(300000, Math\.max\(180000, 60000 + String\(task || ''\)\.length * 50\)\)/.test(cli), '2c 子会话超时按任务长度放宽（180s~300s）');
}

// 3. 通道失败必须报通道失败
{
  const s = src('lib/fanout-run.mjs');
  ok(/通道报错（不是产物问题）/.test(s), '3 通道 ok:false 的理由带「通道报错」前缀，不伪装成 ANSWER 空');
}

// 4. 父审回散文没有票：理由指向 REVIEW-RAW
{
  const s = src('lib/fanout-run.mjs');
  ok(/没有可解析的票/.test(s) && /REVIEW-RAW\.md/.test(s), '4 「回了 N 字但没有可解析的票」并指向 REVIEW-RAW.md');
}

// 5. 真跑能走到「通道报错」这条路（注入 ask 返回 ok:false）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-lane-'));
  const ask = async () => ({ ok: false, err: 'Max turns (10) exceeded', addedText: '' });
  const res = await runFanout({ task: '看 a.mjs', parts: 2, cwd: tmp, ask, reviewChunk: 0, speculativeResend: false, noPreGate: true });
  ok(res.summary.state !== 'ACCEPT' && res.summary.value <= 0, '5 通道全失败时绝不放行（' + res.summary.state + '）');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 6. 台账分清「只探活」与「真跑验过」
{
  const probeOnly = summarizeLane(Array.from({ length: 3 }, () => ({ lane: 'x', ok: true, ms: 9000, source: 'probe' })));
  ok(probeOnly.verdict === 'usable' && probeOnly.fanoutOk === 0 && probeOnly.fanoutRuns === 0, '6 只探活 → usable 但 fanoutOk=0');
  const runFail = summarizeLane([
    ...Array.from({ length: 3 }, () => ({ lane: 'y', ok: true, ms: 9000, source: 'probe' })),
    { lane: 'y', ok: false, ms: 47000, reason: '回了 0 条票', source: 'fanout' },
  ]);
  ok(runFail.fanoutRuns === 1 && runFail.fanoutOk === 0, '6b 真跑失败被单独计数');
  const rec = recommendReviewers({ lanes: [runFail, probeOnly] }, 1);
  ok(rec.lanes[0] === probeOnly.lane, '6c 真跑失败过的通道排在只探活之后（探活绿灯不替真跑背书）');
  ok(/只探活过|真跑验过/.test(rec.why), '6d 推荐理由里标出来源');
}

console.log('fanout_lane_complete: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
