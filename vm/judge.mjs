/**
 * @file vm/judge.mjs
 * @description 判定门面：把置信度公式与三值裁决接起来，并让裁决**真的走一遍编译执行**。
 *
 * 2026-11-16 第二步改造（rank2 动手，三条判据见 docs/decisions/2026-11-16-vote-arity.md）：
 *   ① nValid 的分母与分子都换成**去重后的证据来源数**（同 source 只计一次；
 *      没有 source 标签时按值去重）—— 九项指标里同一项重复上报，不算九个证据。
 *   ② 只有一个来源（n=1）时 agreement 强制 0 —— 一个来源不能自证一致。
 *   ③ n>=2 且 sd < eps 时 agreement 保留 1 —— 九个独立来源给出同一个值是真·多重印证，
 *      不能因为「方差为零」就判死（我原来那版就是把这种情况杀掉了，lead 提的，我否了）。
 *
 * 第四条：所有阈值/截断/期望数**只从 vm/oracle-contract.json 读**，不再在代码里写 0.45 / 0.22 / 9。
 * 原因不是洁癖：今早 python 与 node 两份实现只差一个 reason 文案，对拍 7/7 全绿照样漂移；
 * 常量写两遍就是下一次漂移的入口。
 *
 * 为什么裁决要走编译执行：compile 与 machine 否则就是没人用的孤儿。这里把「两档阈值」
 * 写成 AST（三处 thresh 比较），编成字节码跑一遍，用执行结果当 value，现算的 verdictOf
 * 当标准答案；两者不一致 → value 归 0、reason 记 'compiler-mismatch'。
 *
 * 公式：z 截断到 ±zLimit → 按来源去重 → meanZ / spread →
 *       strength = tanh(|meanZ|)，agreement = n<2 ? 0 : tanh(|meanZ|/spread)，
 *       nValid = 去重来源数 / expected，confidence = strength * agreement * nValid。
 */

import fs from 'node:fs';
import { compileVerdict, runVerdict } from './verdict.mjs';
import { makeAttestation } from './attest.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE, compile, runWithCompiler } from './compiler.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.join(here, 'oracle-contract.json');

/**
 * 载入契约。**代码里不设任何兜底数字**：
 * 一旦这里写一份 0.45，它就变成第二个真值源，改契约不改代码、或改代码不改契约，
 * 都会静默地各按各的算 —— 这正是今早那次 reason 漂移的同型病。
 * 契约缺失/字段坏 → 直接抛，让调用方看见「常量没了」，而不是拿到一组猜的数继续跑。
 */
function loadContract() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  } catch (e) {
    throw new Error('契约文件缺失或损坏：' + CONTRACT_PATH + '（判定常量只认契约，代码内不设兜底）—— ' + e.message);
  }
  const need = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('契约字段缺失或非数字：' + name);
    return n;
  };
  return {
    // 契约版本也要带出来：跨主机核对时这是第一个要比的字段（Kali 那份落后一版就靠它发现）。
    contractVersion: raw?.contractVersion == null ? null : Number(raw.contractVersion),
    cut: { high: need(raw?.cut?.high, 'cut.high'), mid: need(raw?.cut?.mid, 'cut.mid') },
    zLimit: need(raw?.zLimit, 'zLimit'),
    spreadEps: need(raw?.spreadEps, 'spreadEps'),
    expectedDefault: need(raw?.expectedDefault, 'expectedDefault'),
    votesArity: need(raw?.votes?.arity, 'votes.arity'),
  };
}

/** 载入后的契约（只读快照）。 */
export const CONTRACT = loadContract();

/** 分档阈值 —— 从契约读。改这里等于改 AST 与 verdictOf 两处，因为它们都引用本对象。 */
export const CUT = { high: CONTRACT.cut.high, mid: CONTRACT.cut.mid };

/** 裁决真程序（模块级缓存）：判定规则两档阈值 + 脱钩保护编成字节码，只编译一次。 */
const VERDICT_PROGRAM = compileVerdict(CUT);

/** z 的截断上限。延迟倍率这类指标能算出 -180，不截断就不是同一个问题。 */
export const Z_LIMIT = CONTRACT.zLimit;

/** 到票率下限：应评 N 人里必须回来 0.8N 张，否则「缺席」会被当成「同意」。 */
export const VOTE_ARITY = CONTRACT.votesArity;

/** 标准差为 0 时的替身，避免除零。不参与返回值之外的任何展示。 */
const SPREAD_EPS = CONTRACT.spreadEps;

/** 期望指标数：少传几项不该让结论更容易成立。 */
const EXPECTED_DEFAULT = CONTRACT.expectedDefault;

function clampZ(n) {
  return Math.max(-Z_LIMIT, Math.min(Z_LIMIT, n));
}

/**
 * 把读数压成置信度统计。
 *
 * 入参两种写法都吃：
 *   computeConfidence([3.1, 2.9], { sources: ['a', 'b'] })   // 平行数组
 *   computeConfidence([{ z: 3.1, source: 'a' }, { value: 2.9, source: 'b' }])
 * source 是有意义的标签（指标名 / 评审人 / 机器 id）。它决定「两条读数算几个证据」。
 *
 * @param {Array<number|{z?:number,value?:number,source?:string}>} zValues
 * @param {{expected?:number, sources?:string[]}} [opts]
 * @returns {{strength:number, agreement:number, nValid:number, confidence:number,
 *            meanZ:number, spread:number, nSources:number, rawCount:number}}
 */
export function computeConfidence(zValues, opts = {}) {
  const arr = Array.isArray(zValues) ? zValues : [];
  const labels = Array.isArray(opts.sources) ? opts.sources : null;
  const readings = [];
  for (let i = 0; i < arr.length; i += 1) {
    const raw = arr[i];
    const boxed = raw !== null && typeof raw === 'object';
    const value = boxed ? (raw.z !== undefined ? raw.z : raw.value) : raw;
    const n = Number(value);
    if (value === undefined || value === null || !Number.isFinite(n)) continue;
    // 标签三级回落：对象自带 source/src → 平行数组 sources[i] → 无标签。
    // 少这一级回落，{z:1.2} × 9 + sources=[m1..m9] 会被当成「同一个无标签读数九次」，
    // 九个独立来源的印证被判成一条孤证（guards 测试抓到）。
    let label = boxed
      ? (raw.source !== undefined ? raw.source : (raw.src !== undefined ? raw.src : null))
      : null;
    if ((label === null || label === undefined) && labels) label = labels[i];
    readings.push({
      raw: n,
      z: clampZ(n),
      label: label === null || label === undefined ? null : String(label),
    });
  }
  const total = arr.length;

  // 去重：带标签按标签合并（同来源取均值），不带标签按**原始读数**合并。
  // 为什么键用 raw 而不是截断后的 z：3.1 / 3.2 / 3.4 截断后全变 3，用 z 当键会把三条
  // 独立指标压成一条（实测：atwo_judge 那条 9 项高证据被压成 4 源、置信度掉到 0.442、
  // 结论从「可判」翻成「存疑」）。截断是计分手段，不是身份。
  const groups = new Map();
  for (const r of readings) {
    const key = r.label !== null ? 'src:' + r.label : 'val:' + r.raw.toFixed(9);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.z);
  }
  const values = [];
  for (const g of groups.values()) values.push(g.reduce((a, b) => a + b, 0) / g.length);

  const expected = (Number.isFinite(opts.expected) && opts.expected > 0)
    ? opts.expected
    : Math.max(total, EXPECTED_DEFAULT);
  const nSources = values.length;
  const nValid = expected ? Math.min(1, nSources / expected) : 0;
  if (!nSources) {
    return { strength: 0, agreement: 0, nValid: 0, confidence: 0, meanZ: 0, spread: 0, nSources: 0, rawCount: total };
  }
  const meanZ = values.reduce((s, z) => s + z, 0) / nSources;
  const variance = values.reduce((s, z) => s + (z - meanZ) * (z - meanZ), 0) / nSources;
  const sd = Math.sqrt(variance);
  const spread = sd > 0 ? sd : SPREAD_EPS;
  const strength = Math.tanh(Math.abs(meanZ));
  // 一个来源不能自证：n=1 时「一致」是恒真的，必须归零，否则单值读数的 agreement 恒为 1。
  // n>=2 且 sd<eps 走 tanh(大数)→1，这是真·多重印证，不能被「方差为零」判死。
  const agreement = nSources >= 2 ? Math.tanh(Math.abs(meanZ) / spread) : 0;
  const confidence = strength * agreement * nValid;
  return { strength, agreement, nValid, confidence, meanZ, spread, nSources, rawCount: total };
}

/**
 * 置信度→三值裁决。与 AST 里的三处 thresh 必须一致，判据顺序即分档顺序。
 * @param {number} confidence
 * @returns {1|0|-1}
 */
export function verdictOf(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return -1;
  if (c >= CUT.high) return 1;
  if (c >= CUT.mid) return 0;
  return -1;
}

/**
 * 判决 AST：三处 thresh 比较，和 verdictOf 的分档一一对应。
 *
 *   ifz(cond = thresh(c, high, mid))          // +1 高 / 0 中 / -1 低
 *      then = const(0)                        // 中档：cond 为 0 才走这里
 *      else = and(thresh(c, high, high), thresh(c, mid, mid))
 *
 * 为什么 else 用 AND 而不是直接取 cond 的值：ifz 只判零、不返回 cond 本身。
 * high 时两个单边判据都是 +1（AND→+1）；low 时两个都是 -1（AND→-1）；中档进不来 else。
 * @param {number} confidence
 * @returns {object} AST 根节点（t 为 'ifz'）
 */
export function decisionAst(confidence) {
  const c = Number(confidence);
  return {
    t: NODE.IFZ,
    cond: { t: NODE.THRESH, v: c, hi: CUT.high, lo: CUT.mid },
    then: { t: NODE.CONST, v: 0 },
    else: {
      t: NODE.AND,
      a: { t: NODE.THRESH, v: c, hi: CUT.high, lo: CUT.high },
      b: { t: NODE.THRESH, v: c, hi: CUT.mid, lo: CUT.mid },
    },
  };
}

const REASON = { 1: '可判', 0: '存疑', '-1': '别判' };

/**
 * 判定入口：现算一份，编译执行一份，裁决真程序跑一份，三者必须一致。
 *
 * value 一律出自 runVerdict —— 判定规则（两档阈值 + 脱钩保护）本身是
 * vm/verdict.mjs 编出的字节码、由 machine 真执行，宿主不再用 if-else 算 value。
 * 旧 AST 路径降级为第二重对照（details.compiled / steps / halted 语义不变）。
 *
 * @param {{zValues?:number[], z?:number[], expected?:number, sources?:string[], withAttest?:boolean}} input
 * @param {{withAttest?:boolean}} [opts]  withAttest=true 时生成可复算凭证 attestation
 * @returns {{value:number, confidence:number, reason:string, details:object,
 *            programSteps:number, attestation?:object}}
 */
export function judge(input = {}, opts = {}) {
  const zValues = Array.isArray(input.zValues) ? input.zValues : (Array.isArray(input.z) ? input.z : []);
  const stats = computeConfidence(zValues, { expected: input.expected, sources: input.sources });
  const direct = verdictOf(stats.confidence);

  // 裁决真程序：value 一律出自 machine 的执行结果（含 VM 内脱钩保护）。
  const vr = runVerdict(VERDICT_PROGRAM.program, {
    meanZ: stats.meanZ,
    agreement: stats.agreement,
    nValid: stats.nValid,
  });

  const program = compile(decisionAst(stats.confidence));
  const run = runWithCompiler(program);
  const details = {
    stats,
    direct,
    compiled: run.value,
    steps: run.steps,
    halted: run.halted,
    programLength: program.length,
    zCount: zValues.length,
    verdictProgramLength: VERDICT_PROGRAM.program.length,
  };

  if (run.value !== direct || vr.value !== direct) {
    return { value: 0, confidence: stats.confidence, reason: 'compiler-mismatch', details, programSteps: vr.steps };
  }
  if (run.value === 1 && stats.meanZ === 0) {
    // 硬约束：完全脱钩（所有 z 都被截成 0）绝不许返回 +1。
    // 真实判定流里 meanZ=0 必然 confidence=0、到不了高档，这里是双保险的对照位。
    return { value: -1, confidence: stats.confidence, reason: 'decoupled-guard', details, programSteps: vr.steps };
  }
  const out = { value: vr.value, confidence: stats.confidence, reason: REASON[vr.value], details, programSteps: vr.steps };
  if (input.withAttest === true || (opts && opts.withAttest === true)) {
    out.attestation = makeAttestation({
      program: VERDICT_PROGRAM.program,
      inputs: { meanZ: stats.meanZ, agreement: stats.agreement, nValid: stats.nValid },
      output: { value: vr.value },
      contract: CONTRACT,
    });
  }
  return out;
}
