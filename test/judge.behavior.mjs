/**
 * @file test/judge.behavior.mjs
 * @description judge / compiler 的行为用例。零依赖，导出 cases 数组，供行为执行器跑。
 * 判定格式：call(m) 拿被测模块的全部导出，expect 支持“值 / 正则 / 函数”三种写法。
 */

import { compile, runWithCompiler, NODE } from '../vm/compiler.mjs';

/** 九个 z 全接近 0（完全脱钩）与九个 z 全 3（完全耦合）的样例。 */
const DECOUPLED = [0, 0, 0, 1e-12, -1e-12, 0, 0, 0, 0];
const COUPLED = [3, 3, 3, 3, 3, 3, 3, 3, 3];

export const cases = [
  {
    name: '完全脱钩：九个 z 全接近 0，判 -1，绝不 +1',
    call: (m) => m.judge({ zValues: DECOUPLED }),
    expect: (v) => v.value === -1 && v.reason !== 'compiler-mismatch',
  },
  {
    name: '完全耦合：九个 z 全 3，判 +1',
    call: (m) => m.judge({ zValues: COUPLED }),
    expect: (v) => v.value === 1,
  },
  {
    name: '截断生效：z=-180 与 z=-3 得到同一份统计',
    call: (m) => {
      const a = m.computeConfidence([-180, 0, 0, 1, 1, 1, 1, 1, 1]);
      const b = m.computeConfidence([-3, 0, 0, 1, 1, 1, 1, 1, 1]);
      return { a, b };
    },
    expect: (v) => v.a.confidence === v.b.confidence && v.a.meanZ === v.b.meanZ,
  },
  {
    name: '截断边界：单个 -180 的 meanZ 等于单个 -3 的 meanZ',
    call: (m) => ({ big: m.computeConfidence([-180]), small: m.computeConfidence([-3]) }),
    expect: (v) => v.big.meanZ === v.small.meanZ && v.big.meanZ === -3,
  },
  {
    name: '等价性：judge 的 value 等于 verdictOf(computeConfidence)（数组抽样）',
    call: (m) => {
      const sets = [
        DECOUPLED, COUPLED,
        [3, 3, 3, 0, 0, 0, 0, 0, 0],
        [1, 1, 1, 1, 1, 1, 1, 1, 1],
        [0.5, 0.6, 0.4, 0.5, 0.4, 0.6, 0.5, 0.5, 0.4],
      ];
      const rows = sets.map((z) => m.judge({ zValues: z }));
      const direct = sets.map((z) => m.verdictOf(m.computeConfidence(z).confidence));
      return rows.map((r, i) => r.value === direct[i]);
    },
    expect: (v) => v.every(Boolean),
  },
  {
    name: '除零保护：z 全等（spread=0）时 agreement 有限，confidence 不 NaN',
    call: (m) => {
      const st = m.computeConfidence([2, 2, 2, 2]);
      return { confidence: st.confidence, spread: st.spread, agreement: st.agreement };
    },
    expect: (v) => Number.isFinite(v.confidence) && Number.isFinite(v.spread) && v.spread > 0,
  },
  {
    name: '无效输入：全非数值时 nValid=0、confidence=0、判 -1',
    call: (m) => m.judge({ zValues: ['x', null, undefined, NaN, Infinity] }),
    expect: (v) => v.value === -1 && v.confidence === 0 && v.details.stats.nValid === 0,
  },
  {
    // 2026-11-16 改：这条原本期望 nValid=0.5（3 有效 / 6 总数），把「分母 = 传入长度」
    // 这个错误契约钉死了。新实现在 expected 缺省时取 max(总数, 9)，3/9 = 1/3。
    // 保留原意需要显式传 expected —— 分母由调用方声明，不由「这次传了几个」推出来。
    name: '混合有效性：显式 expected=6 时一半无效 → nValid=0.5，confidence 按比例缩',
    call: (m) => {
      const half = m.computeConfidence([3, 3, 3, 'x', null, NaN], { expected: 6 });
      const full = m.computeConfidence([3, 3, 3], { expected: 3 });
      return { half, full };
    },
    expect: (v) => v.half.nValid === 0.5 && Math.abs(v.half.confidence - v.full.confidence * 0.5) < 1e-12,
  },
  {
    name: '默认分母是 9：只传 3 个值时 nValid=1/3（不是 1）',
    call: (m) => m.computeConfidence([3, 3, 3]).nValid,
    expect: (v) => Math.abs(v - 1 / 3) < 1e-12,
  },
  {
    name: '分档下界：confidence 恰为 0.22 判 0',
    call: (m) => ({ v: m.verdictOf(0.22), judgeLike: m.verdictOf(0.22) === 0 }),
    expect: (v) => v.v === 0,
  },
  {
    name: '分档上界：confidence 恰为 0.45 判 +1',
    call: (m) => m.verdictOf(0.45),
    expect: 1,
  },
  {
    name: '编译：thresh 的半开区间（0.22 归中档，不归低档）',
    call: () => {
      const ast = { t: NODE.THRESH, v: 0.22, hi: 0.45, lo: 0.22 };
      return runWithCompiler(compile(ast)).value;
    },
    expect: 0,
  },
  {
    name: '编译：ifz 的 0 才走 then（cond 非 0 走 else）',
    call: () => {
      const ast = {
        t: NODE.IFZ,
        cond: { t: NODE.CONST, v: 0 },
        then: { t: NODE.CONST, v: 1 },
        else: { t: NODE.CONST, v: -1 },
      };
      return runWithCompiler(compile(ast)).value;
    },
    expect: 1,
  },
  {
    name: '编译：seq 取 b 的值，且不在栈上留下 a 的残值',
    call: () => {
      const ast = {
        t: NODE.AND,
        a: { t: NODE.SEQ, a: { t: NODE.CONST, v: 1 }, b: { t: NODE.CONST, v: 1 } },
        b: { t: NODE.CONST, v: 1 },
      };
      const r = runWithCompiler(compile(ast));
      return { value: r.value, stackDepth: r.stack.length };
    },
    expect: (v) => v.value === 1 && v.stackDepth === 1,
  },
  {
    name: '编译：Kleene AND/OR 的三种组合',
    call: () => {
      const mk = (op, a, b) => ({ t: op, a: { t: NODE.CONST, v: a }, b: { t: NODE.CONST, v: b } });
      const run = (ast) => runWithCompiler(compile(ast)).value;
      return [
        run(mk(NODE.AND, 0, 1), NODE.AND),
        run(mk(NODE.AND, -1, 1), NODE.AND),
        run(mk(NODE.OR, 0, -1), NODE.OR),
        run(mk(NODE.OR, 0, 1), NODE.OR),
      ].join(',');
    },
    expect: '0,-1,0,1',
  },
  {
    name: '自检真的在跑：details 里带上编译结果与步数',
    call: (m) => m.judge({ zValues: COUPLED }).details,
    expect: (d) => d.halted === true && d.steps > 0 && d.compiled === d.direct,
  },
];
