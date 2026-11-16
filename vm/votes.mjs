// file: vm/votes.mjs
/**
 * @file vm/votes.mjs
 * @description 把「多个评审者的票」喂给同一个三值判定，得到 ACCEPT / REVISE / unreviewed。
 *
 * 2026-11-16 第二步改造：到票率硬闸门（契约 votes.arity = 0.8）。
 * 改前的真实缺陷：3 张 ACCEPT、应评 5 人 → 置信度 0.457 ≥ 0.45 → 判 ACCEPT 放行。
 * 也就是说「缺席的两个评审」被当成了「同意」—— 到票率 60% 却能放行，
 * 这是放行侧的漏洞，比误拒危险得多（误拒会有人来吵，误放没人知道）。
 * 现在：到票率 < arity → 不管 confidence 多高，一律 unreviewed / insufficient。
 *
 * 另两条同源纪律：
 *   - 每张票是一个独立来源（sources = ballot:i 或评审人 id），所以三张 ACCEPT 是三个证据，
 *     不会被 computeConfidence 的「按值去重」压成一票。
 *   - reason 一律机器码，人话放 reasonText（今早漂移事故的修法，别再合回去）。
 *
 * 映射：ACCEPT → +1，REVISE → -1，没评成（null/unreviewed）→ 不计入有效数但占应评名额。
 */

import { judge, CUT, VOTE_ARITY } from './judge.mjs';
import { compileVotes, runVotesVerdict } from './verdict.mjs';

/** 认可的三种票面写法（大小写不敏感）。 */
export const VOTE = { accept: 'ACCEPT', revise: 'REVISE', none: 'unreviewed' };

/** 到票率下限，来自契约（votes.arity）。这里只是转出口，不许写死 0.8。 */
export const ARITY = VOTE_ARITY;

// 票面决议程序：模块级编译一次，阈值只从契约来（与 judge 的 VERDICT_PROGRAM 同构）。
const VOTES_PROGRAM = compileVotes({ high: CUT.high, mid: CUT.mid, arity: ARITY });

/** 票面程序长度（给测试与 --json 用，证明 value 真的走过 VM）。 */
export const VOTES_PROGRAM_LENGTH = VOTES_PROGRAM.program.length;
/** 票面决议的 VM 重算入口（测试可直接拿它与 judgeVotes 对拍）。 */
export function votesTriFromVm(confidence, rate) {
  return runVotesVerdict(VOTES_PROGRAM, { confidence, rate });
}

/**
 * 归一化一张票。
 * @param {unknown} v
 * @returns {'ACCEPT'|'REVISE'|null|undefined} null=明确没评成；undefined=不认识（调用方要报错，别静默吞）
 */
export function parseVote(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toUpperCase();
  if (s === 'ACCEPT' || s === 'A' || s === '+1') return 'ACCEPT';
  if (s === 'REVISE' || s === 'R' || s === '-1') return 'REVISE';
  if (s === 'UNREVIEWED' || s === 'NONE' || s === 'NULL' || s === '0' || s === '') return null;
  return undefined;
}

function voteLabel(raw, i) {
  if (raw && typeof raw === 'object') {
    const v = raw.reviewer !== undefined ? raw.reviewer : (raw.source !== undefined ? raw.source : raw.by);
    if (v !== undefined && v !== null) return String(v);
  }
  return 'ballot:' + i;
}

function voteValue(raw) {
  if (raw && typeof raw === 'object') {
    const v = raw.value !== undefined ? raw.value : (raw.vote !== undefined ? raw.vote : raw.verdict);
    return v;
  }
  return raw;
}

/**
 * 票 → 指标 + 来源标签。没评成的票不进指标，但仍占「应评」名额。
 * @param {unknown[]} votes
 * @param {number} [expected]
 */
export function votesToZ(votes, expected) {
  const arr = Array.isArray(votes) ? votes : [];
  const zValues = [];
  const sources = [];
  const counts = { ACCEPT: 0, REVISE: 0, unreviewed: 0, invalid: 0 };
  for (let i = 0; i < arr.length; i += 1) {
    const raw = arr[i];
    const v = parseVote(voteValue(raw));
    const label = voteLabel(raw, i);
    if (v === 'ACCEPT') { zValues.push(1); sources.push(label); counts.ACCEPT += 1; }
    else if (v === 'REVISE') { zValues.push(-1); sources.push(label); counts.REVISE += 1; }
    else if (v === null) counts.unreviewed += 1;
    else counts.invalid += 1;
  }
  const exp = Number.isFinite(expected) && expected > 0 ? expected : arr.length;
  return { zValues, sources, expected: exp, counts };
}

/**
 * 票 → 三态决议。
 * @param {{votes:unknown[], expected?:number}} input
 * @returns {{value:number, state:'ACCEPT'|'REVISE'|'unreviewed', direction:number, confidence:number,
 *            reason:string, reasonText:string|null, turnout:number, arity:number,
 *            cut:object, stats:object, counts:object, expected:number}}
 */
export function judgeVotes(input = {}) {
  const votes = Array.isArray(input.votes) ? input.votes : [];
  // 声明名额（应评几人）。**不传 ≠ 到票数就是全部名额** —— 那样「来了三张都认」
  // 自动等于「到票率 100%」，闸门等于没有。这是今天堵的第二个放行侧漏洞。
  const declared = Number.isFinite(input.expected) && input.expected > 0 ? Math.floor(input.expected) : 0;
  const rosterMissing = declared === 0;
  const { zValues, sources, expected, counts } = votesToZ(votes, declared || undefined);
  const r = judge({ zValues, sources, expected });
  const st = r.details && r.details.stats ? r.details.stats : {};
  const direction = st.meanZ > 0 ? 1 : (st.meanZ < 0 ? -1 : 0);
  const cast = counts.ACCEPT + counts.REVISE;
  const turnout = expected ? cast / expected : 0;
  const belowArity = turnout + 1e-12 < ARITY;

  let value = r.value;
  let state = value === 1 ? (direction > 0 ? 'ACCEPT' : (direction < 0 ? 'REVISE' : 'unreviewed')) : 'unreviewed';
  let reason;
  let reasonText;

  if (rosterMissing) {
    // 没有声明名单：到票率算不出来。此时绝不允许落成 ACCEPT —— 「谁来了都认」
    // 凭什么是通过？降级成 unreviewed，把补名单的路指出来；硬要结走 --yes 并留审计。
    value = r.value === 1 ? 0 : r.value;
    state = 'unreviewed';
    reason = 'no-roster';
    reasonText = '没有声明应评名单：到票率无从计算（补 --expect 名单 或 --expect-n N）';
  } else if (belowArity) {
    // 到票不足：结论作废。原来判 +1 的降级成 0（存疑）—— 缺席不能算成同意；
    // 本来就 ≤0 的保留原值（零票时 judge 给的是 -1「别判」，不该被抹成 0）。
    value = r.value === 1 ? 0 : r.value;
    state = 'unreviewed';
    reason = 'insufficient';
    reasonText = '到票 ' + cast + '/' + expected + '（' + turnout.toFixed(2) + '）低于应评下限 ' + ARITY;
  } else {
    reason = r.value === 1
      ? (state === 'ACCEPT' ? 'consensus-accept' : (state === 'REVISE' ? 'consensus-revise' : 'no-direction'))
      : (r.value === 0 ? 'undecided' : 'insufficient');
    reasonText = r.value === 1 ? null : (r.reason || null);
  }

  // 第二重对照：把「置信度分档 × 到票门」的合成编成字节码，由 machine 真执行一遍。
  // 比的是最终 value（合成结果），不是某个中间量：门不过时 +1 要降级成 0，
  // 零票时的 -1 要保留 —— 这两条一旦写反，结论会静默变成「放行」。
  const vmRate = rosterMissing ? 0 : turnout;
  const vm = votesTriFromVm(r.confidence, vmRate);
  const vmAgrees = vm.value === value;
  if (!vmAgrees) {
    reasonText = '票面程序与代码算出的决议不一致（vm ' + vm.value + ' / code ' + value + '）：按证据不足处理';
    value = 0;
    state = 'unreviewed';
    reason = 'votes-mismatch';
  }

  return {
    value,
    state,
    direction,
    confidence: Number(r.confidence),
    reason,
    reasonText,
    votesProgram: { value: vm.value, steps: vm.steps, length: VOTES_PROGRAM_LENGTH, agrees: vmAgrees },
    turnout,
    arity: ARITY,
    cut: { high: CUT.high, mid: CUT.mid },
    stats: {
      strength: st.strength ?? null,
      agreement: st.agreement ?? null,
      nValid: st.nValid ?? null,
      meanZ: st.meanZ ?? null,
      spread: st.spread ?? null,
      nSources: st.nSources ?? null,
    },
    counts,
    expected,
    rosterMissing,
  };
}
