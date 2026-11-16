// lib/reviewer-probe.mjs —— 父审探活：通道「能连上」不等于「能当父审」。
//
// 为什么必须有这一层（2026-11-17 实测三条通道当父审的结果）：
//   codebuddy  25.2s  两票 PASS，理由引原文   → 可用
//   trae      187.4s  没收工（先回「思考中」占位，然后一直不答） → 不可用（太慢 + 占位）
//   workbuddy  19.6s  「抱歉，发生未知错误暂无响应…/ Kimi-K3.1-Pro」 → 不可用（服务端错）
//   ollama     29.0s  出票了，但理由是同一句话循环重复，且自己写着「内容完全一致」却判 REVISE → 不可用（误杀）
//
// 于是「异源评审」这个结论在今天是拿不出手的：接线通了，可用性 0/3（codebuddy 是同源）。
// 这一层就是把这个事实变成一条命令能测出来的东西 —— 探活不过的通道，不许在报告里写成「异源评审通过」。
import { recordProbes } from './reviewer-ledger.mjs';
import { buildReviewPrompt } from './fanout.mjs';
import { parseReview } from './fanout.mjs';
import { resolveAsk } from './lanes.mjs';

export const PROBE_CONTRACT = 'atwo-reviewer-probe/1';

/**
 * 探活用例设计（两条产物，一条真一条假，真假都可被机器判定）：
 *   p1：引用真实存在的行（由调用方给 line text）→ 应 PASS
 *   p2：同一行，但编一个不存在的行号 + 错误内容 → 应 REVISE
 * 判据四条：① 能解出两条票 ② verdict 全对 ③ reason 不是退化重复（最长重复片段占比）④ 长度合理
 */
export function buildProbeChildren(cite) {
  return [
    { id: 'child-1', lane: 'probe', answer: 'EXIT 一共六码：0 成功 / 2 用法错 / 3 前置不满足 / 4 验收不过 / 5 通道错 / 6 预算超。', evidence: cite.trueRef + ' ' + cite.trueText },
    { id: 'child-2', lane: 'probe', answer: 'EXIT 一共四码：0 / 1 / 2 / 3。', evidence: cite.falseRef + ' ' + cite.falseText },
    // 第三条是「必须真去读文件」的那一条：行号是真的、内容是我编的。
    // 为什么非加不可（2026-11-17 实测）：只有前两条时 ollama 探活 9.9s 判「可当父审」，
    // 而它在真实产物（要读文件核对）上退化重复 + 误杀。探活若只测「能不能吐结构化票」，
    // 就会像没有这一层一样骗自己 —— 用一套过得了的题去证明能力，是最典型的假绿。
    { id: 'child-3', lane: 'probe', answer: '按 ' + cite.trueRef + ' 的原文，EXIT 只有两个码：0 与 1。', evidence: cite.trueRef + ' ' + cite.falseText },
  ];
}

/** 退化判定：同一子串反复出现，说明模型在原地打转（ollama 8B 实测长这样）。 */
export function degeneracy(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (s.length < 60) return 0;
  let worst = 0;
  for (let len = 12; len <= 40; len += 4) {
    for (let i = 0; i + len <= Math.min(s.length, 400); i += len) {
      const piece = s.slice(i, i + len);
      const n = s.split(piece).length - 1;
      if (n >= 3) worst = Math.max(worst, (n * len) / s.length);
    }
  }
  return worst;
}

export function judgeProbe(text, ids = ['child-1', 'child-2', 'child-3']) {
  const reasons = [];
  if (!text || !String(text).trim()) return { usable: false, reasons: ['返回空内容'], verdicts: [] };
  const votes = parseReview(String(text), ids);
  const byId = new Map(votes.map((v) => [v.id, v]));
  const v1 = byId.get('child-1');
  const v2 = byId.get('child-2');
  const v3 = byId.get('child-3');
  if (!v1 || !v2 || !v3) reasons.push('没有解出三条票（返回不是 JSON 契约形状）');
  if (v1 && v1.verdict !== 'PASS') reasons.push('对正确产物没给 PASS（判成 ' + v1.verdict + '）：会误杀');
  if (v2 && v2.verdict !== 'REVISE') reasons.push('对编造产物没给 REVISE（判成 ' + v2.verdict + '）：抓不住错');
  if (v3 && v3.verdict !== 'REVISE') reasons.push('对「行号真、内容假」没给 REVISE（判成 ' + v3.verdict + '）：它没真去读那一行（没核对能力，只会看文字顺不顺）');
  const deg = degeneracy(text);
  if (deg > 0.45) reasons.push('理由是退化重复（最长重复片段占 ' + Math.round(deg * 100) + '%）：像原地打转，不能当判定');
  return { usable: reasons.length === 0, reasons, verdicts: votes.map((v) => ({ id: v.id, verdict: v.verdict })), degeneracy: deg, chars: String(text).length };
}

/** 真探活：派一次，拿文本，判四条。通道取不到 / 抛错 / 超时都算不可用，并留下原因。 */
export async function probeReviewer(lane, cite, opts = {}) {
  const t0 = Date.now();
  let ask;
  try { ask = opts.ask || resolveAsk(lane); }
  catch (e) { return { contract: PROBE_CONTRACT, lane, usable: false, ms: 0, reasons: [String(e && e.message || e)], text: '' }; }
  const kids = buildProbeChildren(cite);
  try {
    const r = await ask(buildReviewPrompt('父审探活：核对 EXIT 退出码', kids, ''), { cwd: opts.cwd, timeoutMs: opts.timeoutMs || 180000, tools: 'Read' });
    const text = (r && (r.addedText || r.text)) || '';
    const laneErr = r && r.ok === false ? (r.err || '通道 ok:false') : null;
    const j = judgeProbe(text);
    const reasons = laneErr ? [laneErr].concat(j.reasons) : j.reasons;
    return { contract: PROBE_CONTRACT, lane, usable: !laneErr && j.usable, ms: Date.now() - t0, reasons, verdicts: j.verdicts || [], degeneracy: j.degeneracy || 0, chars: text.length, text: text.slice(0, 400) };
  } catch (e) {
    return { contract: PROBE_CONTRACT, lane, usable: false, ms: Date.now() - t0, reasons: [String(e && e.message || e)], text: '' };
  }
}

export async function probeReviewers(lanes, cite, opts = {}) {
  const out = [];
  for (const lane of lanes) out.push(await probeReviewer(lane, cite, opts));
  // 台账（2026-11-17）：探活结论落 memory/reviewer-ledger.jsonl。
  // 原先「哪个通道能当父审」只活在一次会话的正文里，换会话就丢；
  // 记账之后 recommendReviewers() 才能直接给出名单。opts.record === false 可关（测试用）。
  if (opts.record !== false) {
    try {
      recordProbes(opts.cwd || process.cwd(), out.map((r) => ({ lane: r.lane, ok: r.usable, ms: r.ms, reason: r.usable ? null : (r.reasons || []).join('；'), caught: r.verdicts })), 'probe');
    } catch { /* 台账写不进去不影响探活结论 */ }
  }
  return out;
}

export function formatProbes(results) {
  const lines = [];
  for (const r of results) {
    lines.push((r.usable ? '✓ ' : '✗ ') + r.lane + '  ' + (r.ms / 1000).toFixed(1) + 's  ' + (r.usable ? '可当父审' : r.reasons.join('；')));
  }
  const ok = results.filter((r) => r.usable).map((r) => r.lane);
  lines.push('', '可用父审通道：' + (ok.length ? ok.join(' / ') : '无') + (ok.length === 1 && ok[0] === 'codebuddy' ? '（只有同源通道能用 —— 「异源评审」这件事今天拿不出手）' : ''));
  return lines.join('\n');
}
