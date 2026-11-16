// file: vm/export-contract.mjs
/**
 * @file vm/export-contract.mjs
 * @description 把判定契约导出成 JSON，给「另一种运行时」照着实现。
 *
 * 为什么需要它：目标要求判定服务跑在 Kali VM 里，而 Kali 上没有 node（实测 2026-11-16:
 * `node: command not found`，只有 python3）。要在那边起服务有两条路：
 *   ① 在 Kali 装 node —— 装的是第二份运行时，升级不同步就会静默变语义；
 *   ② 用 python 再写一遍服务 —— 但公式写两遍，就会重演「两份解释器」那次事故
 *      （测试全绿 + 真链路必失败）。
 *
 * 这里选第三条：**契约文件 + 对拍测试**。阈值、截断、公式参数、到票率都只在这里生成一次
 * （源头是 vm/oracle-contract.json，judge.mjs 只读它），python 侧只许照着读，不许自己写死；
 * 再用 test/vm_oracle_parity.test.mjs 拿几百组向量两边对拍 —— 一旦有人改了 node 侧而忘了
 * python，对拍立刻红，而不是等线上判定悄悄变了。
 *
 * 用法：node vm/export-contract.mjs [--out vm/oracle-contract.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { judge, CUT, Z_LIMIT, VOTE_ARITY } from './judge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 参考向量：覆盖分档边界、脱钩、单值、方向打架、重复读数五类。 */
export const VECTORS = [
  { name: '强证据·九项独立', zValues: [3.1, 2.9, 3.4, 2.8, 3.0, 3.2, 2.7, 3.3, 3.1] },
  { name: '全零·脱钩', zValues: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: '方向打架', zValues: [3, -3, 3, -3, 3, -3, 3, -3, 3] },
  { name: '单个极端值·截断', zValues: [-180] },
  { name: '三项中等', zValues: [1.0, 0.9, 1.1] },
  { name: '刚好压线高', zValues: [3, 3, 3, 3, 3, 3, 3, 3, 0.35] },
  // 三条退化向量（第二步改造后新增）：只有它们能抓住「重复读数被当成多份证据」这类错。
  { name: '退化·同一读数九次', zValues: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
  {
    name: '退化·九源同值（真多重印证）',
    zValues: [
      { z: 1.2, source: 'm1' }, { z: 1.2, source: 'm2' }, { z: 1.2, source: 'm3' },
      { z: 1.2, source: 'm4' }, { z: 1.2, source: 'm5' }, { z: 1.2, source: 'm6' },
      { z: 1.2, source: 'm7' }, { z: 1.2, source: 'm8' }, { z: 1.2, source: 'm9' },
    ],
  },
  { name: '退化·单值三点', zValues: [1.0] },
];

export function buildContract() {
  return {
    service: 'ternary-oracle',
    contractVersion: 2,
    generatedBy: 'vm/export-contract.mjs',
    // 这几个数只在这里出现一次；python 侧必须读它们，不许自己写 0.45 / 0.22 / 0.8。
    cut: { high: CUT.high, mid: CUT.mid },
    zLimit: Z_LIMIT,
    spreadEps: 1e-9,
    expectedDefault: 9,
    dedupRule: '同一 source 只计一次（同来源多读数取均值）；无 source 标签时按原始读数去重（相同读数算一份证据）；去重键用截断前的原值，避免 3.1/3.2/3.4 截断成 3 后被误合并',
    zRule: 'clamp(z, -zLimit, +zLimit)；非有限值不计入有效数；截断只影响计分，不影响「算几个证据」',
    formula: 'nSources=去重后来源数 · nValid=min(1, nSources/expectedDefault或expected) · strength=tanh(|meanZ|) · agreement=(nSources<2?0:tanh(|meanZ|/spread)) · confidence=strength*agreement*nValid',
    verdictRule: 'confidence>=high → +1 ; >=mid → 0 ; 否则 -1 ; value=+1 且 meanZ=0 → -1（脱钩保护）',
    votes: {
      arity: VOTE_ARITY,
      rule: '到票率 (ACCEPT+REVISE)/expected < arity → 一律 unreviewed/insufficient，不看 confidence',
      rosterRule: 'expected（应评名额）未显式声明 → 到票率不可算 → 一律 unreviewed/no-roster；绝不把 votes.length 当成应评名额',
      ACCEPT: 1,
      REVISE: -1,
      unreviewed: 'excluded（但仍占应评名额）',
      sources: '每张票是一个独立来源（评审人 id，缺省 ballot:i），三张 ACCEPT 是三个证据',
    },
    vectors: VECTORS.map((v) => {
      const r = judge({ zValues: v.zValues });
      const st = r.details.stats;
      return {
        name: v.name,
        zValues: v.zValues.map((x) => (x && typeof x === 'object' ? { z: x.z, source: x.source } : x)),
        value: r.value,
        confidence: Number(r.confidence.toFixed(12)),
        meanZ: st.meanZ,
        spread: st.spread,
        nValid: st.nValid,
        strength: st.strength,
        agreement: st.agreement,
        nSources: st.nSources,
      };
    }),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const i = process.argv.indexOf('--out');
  const out = i >= 0 ? process.argv[i + 1] : path.join(here, 'oracle-contract.json');
  fs.writeFileSync(out, JSON.stringify(buildContract(), null, 2) + '\n', 'utf8');
  console.log('契约已写：' + out + '（' + VECTORS.length + ' 组参考向量）');
}
