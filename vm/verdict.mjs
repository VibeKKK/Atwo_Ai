// file: vm/verdict.mjs
// 三进制裁决：把 verdictRule 编成真字节码，再用 vm/machine.mjs 真执行。
// 判定逻辑（三档 + 脱钩保护）全在 VM 里；宿主只算含 tanh 的 confidence 并注入数值槽。
import { OP, run } from './machine.mjs';

// 注入哨兵：真实 confidence∈[0,1]、meanZ∈[-3,3]，永不与哨兵相撞。
const CONF = 987654321.1;
const MEANZ = 987654321.2;
const NMEANZ = 987654321.3;

const n = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 编出判定程序。阈值只从 cut（来自契约）读，代码里没有写死 0.45/0.22。
 *
 * 全在 VM 内完成：
 *   guard = (conf>=high) AND (meanZ===0)
 *   value = NOT(guard) AND thresh(conf, high, mid)
 * guard 命中 → NOT 得 -1，与任意 band 取 min 都是 -1（脱钩保护）；
 * guard 不中 → NOT 得 +1，min(+1, band) = band（正常三档）。
 */
export function compileVerdict(cut) {
  const c = (cut && typeof cut === 'object' && cut.cut) ? cut.cut : cut;
  const high = Number(c && c.high);
  const mid = Number(c && c.mid);
  if (!Number.isFinite(high) || !Number.isFinite(mid)) {
    throw new Error('compileVerdict: cut.high / cut.mid 必须是数字（应从契约读）');
  }
  if (!(high > mid)) throw new Error('compileVerdict: 要求 high > mid');

  const program = [];
  const emit = (...xs) => { for (const x of xs) program.push(x); };
  // (conf>=high) → ±1
  emit(OP.PUSHNUM, CONF, OP.THRESH, high, high);
  // meanZ===0 → +1，否则 -1（两个 >=0 单边判据取 AND，-0 也算 0）
  emit(OP.PUSHNUM, MEANZ, OP.THRESH, 0, 0);
  emit(OP.PUSHNUM, NMEANZ, OP.THRESH, 0, 0);
  emit(OP.AND);
  emit(OP.AND);   // guard
  emit(OP.NOT);   // NOT(guard)
  // 三档：>=high → +1 ; >=mid → 0 ; 否则 -1
  emit(OP.PUSHNUM, CONF, OP.THRESH, high, mid);
  emit(OP.AND);
  emit(OP.HALT);
  return { program, cut: { high, mid } };
}

/**
 * 真执行。program 可为 compileVerdict 的 number[]，也兼容 {program}。
 * inputs.confidence 可选（脱钩保护的测试缝）；缺省 = tanh(|meanZ|)*agreement*nValid。
 * @returns {{value:-1|0|1, confidence:number, steps:number}}
 */
export function runVerdict(program, inputs = {}) {
  const template = Array.isArray(program) ? program : (program && program.program);
  if (!Array.isArray(template)) throw new Error('runVerdict: 需要 program number[]');
  const meanZ = n(inputs.meanZ);
  const agreement = n(inputs.agreement);
  const nValid = n(inputs.nValid);
  const confidence = (inputs.confidence !== undefined && Number.isFinite(Number(inputs.confidence)))
    ? Number(inputs.confidence)
    : Math.tanh(Math.abs(meanZ)) * agreement * nValid;

  const bound = template.slice().map((v) => (
    v === CONF ? confidence : (v === MEANZ ? meanZ : (v === NMEANZ ? -meanZ : v))
  ));
  const out = run(bound, { maxSteps: 100000 });
  if (out.error) throw new Error('runVerdict: ' + out.error);
  const value = (out.result === 1 || out.result === 0 || out.result === -1) ? out.result : -1;
  return { value, confidence, steps: out.steps };
}

// —— 票面程序：与判定程序通用同一台 machine、同一套指令，只是槽不同 ——
// 为什么要它：vm/votes.mjs 原来只有 if-else 直算，改坏一个比较符只有「同源写的测试」
// 能发现。把「置信度分档 × 到票门」的合成也编成字节码真执行，与代码不一致就按证据不足处理，
// 和 judge 的 compiler-mismatch 同一个口径。
//
// 合成规则（必须与 judgeVotes 逐条对应）：
//   confTri = THRESH(conf, high, mid)      → ±1/0
//   gateTri = THRESH(rate, arity, arity)   → 到票够 +1 / 不够 -1
//   gateTri0 = OR(gateTri, 0) = max(gateTri, 0)   → 够 +1 / 不够 0
//   value = AND(confTri, gateTri0) = min(...)
// 为什么不是「门不过就 -1」：门不过的语义是「+1 降级成 0」，不是「改判别判」——
// 零票时 judge 自己给的 -1 要保留。第一版写成 -1，实测 2:1 分歧那条立刻炸出
// votes-mismatch（vm +1 / code -1），是这道闸门自己抓到的。
const VOTE_CONF = 987654321.6;
const VOTE_RATE = 987654321.5;

/**
 * 编出票面决议程序。
 * @param {{high:number, mid:number, arity:number}} cut 必须整份来自契约（cut + votes.arity）
 */
export function compileVotes(cut) {
  const high = Number(cut && cut.high);
  const mid = Number(cut && cut.mid);
  const a = Number(cut && cut.arity);
  if (!Number.isFinite(high) || !Number.isFinite(mid)) throw new Error('compileVotes: 需要契约 cut.high / cut.mid');
  if (!Number.isFinite(a) || !(a > 0 && a <= 1)) throw new Error('compileVotes: 需要契约 votes.arity ∈ (0,1]');
  const program = [];
  const emit = (...xs) => { for (const x of xs) program.push(x); };
  emit(OP.PUSHNUM, VOTE_CONF, OP.THRESH, high, mid);
  emit(OP.PUSHNUM, VOTE_RATE, OP.THRESH, a, a);
  // 注意：PUSHNUM 只写 num 寄存器、不压栈（THRESH 读它），所以这里的 0 必须用 PUSH。
  emit(OP.PUSH, 0, OP.OR);
  emit(OP.AND);
  emit(OP.HALT);
  return { program, cut: { high, mid, arity: a } };
}

/** 真执行票面程序。返回 {value, steps}。 */
export function runVotesVerdict(bundle, inputs = {}) {
  const template = Array.isArray(bundle) ? bundle : (bundle && bundle.program);
  if (!Array.isArray(template)) throw new Error('runVotesVerdict: 需要程序 number[]');
  const conf = Number(inputs.confidence);
  const rate = Number(inputs.rate);
  if (!Number.isFinite(conf)) throw new Error('runVotesVerdict: confidence 必须是数字');
  const bound = template.slice().map((v) => (v === VOTE_CONF ? conf : (v === VOTE_RATE ? rate : v)));
  const out = run(bound, { maxSteps: 100000 });
  if (out.error) throw new Error('runVotesVerdict: ' + out.error);
  const value = (out.result === 1 || out.result === 0 || out.result === -1) ? out.result : 0;
  return { value, steps: out.steps };
}
