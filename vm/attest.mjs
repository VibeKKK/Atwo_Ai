// file: vm/attest.mjs
// 可复算凭证：把一次裁决的 (程序, 输入, 输出) 三元组固定下来，任何人拿到都能离线重算。
// 这是这台虚拟机存在的唯一正当理由 —— 判定要能从"相信我"变成"你自己算"。
//
// 2026-11-16 补的一环：凭证还要绑**契约内容哈希**，不能只绑 contractVersion。
// 版本号是自报的：把 cut.high 0.45 改成 0.50 而不动版本号，旧写法下全部旧凭证照样
// 「重算通过」——那等于凭证替一个已经变了的尺子背书。绑字节哈希之后，「尺子变了」
// 这件事在凭证层自己会响（reason: contract-changed），不依赖任何人记得改版本号。
import { createHash } from 'node:crypto';
import { runVerdict } from './verdict.mjs';

const hashOf = (program, inputs, output) =>
  createHash('sha256').update(JSON.stringify([program, inputs, output])).digest('hex');

/**
 * @param {{program:number[], inputs:object, output:object, contract?:object, contractHash?:string}} spec
 */
export function makeAttestation({ program, inputs, output, contract = null, contractHash = null }) {
  if (!Array.isArray(program)) throw new Error('makeAttestation: program 必须是数组');
  const hash = hashOf(program, inputs, output);
  return {
    v: 2,
    contractVersion: contract && contract.contractVersion !== undefined ? contract.contractVersion : null,
    contractHash: contractHash == null ? null : String(contractHash),
    program: program.slice(),
    inputs: { ...inputs },
    output: { ...output },
    hash,
  };
}

/**
 * 四步校验：hash 未被改 → 契约未变（给了当前哈希才查）→ 重算得到同一 value → 程序与输入自洽。
 *
 * @param {object} att 凭证
 * @param {{contractHash?:string}} [opts] 当前契约哈希；给了就核对，不给就跳过（保持旧凭证可审）
 * @returns {{ok:boolean, reason:string, recomputed:number|null}}
 */
export function verifyAttestation(att, opts = {}) {
  if (!att || typeof att !== 'object') return { ok: false, reason: 'not-an-attestation', recomputed: null };
  if (!Array.isArray(att.program)) return { ok: false, reason: 'program-missing', recomputed: null };
  if (!att.output || typeof att.output !== 'object') return { ok: false, reason: 'output-missing', recomputed: null };

  const expect = hashOf(att.program, att.inputs, att.output);
  if (expect !== att.hash) return { ok: false, reason: 'hash-mismatch', recomputed: null };

  const now = opts && opts.contractHash ? String(opts.contractHash) : null;
  if (now) {
    if (!att.contractHash) {
      // v1 凭证没绑哈希：不能判它坏，但必须让调用方看见「这份凭证管不到尺子变化」。
      return { ok: false, reason: 'contract-unbound', recomputed: null };
    }
    if (String(att.contractHash) !== now) return { ok: false, reason: 'contract-changed', recomputed: null };
  }

  let recomputed;
  try {
    recomputed = runVerdict({ program: att.program }, att.inputs).value;
  } catch (e) {
    return { ok: false, reason: 'recompute-error:' + String(e.message).slice(0, 60), recomputed: null };
  }
  if (recomputed !== att.output.value) return { ok: false, reason: 'recompute-mismatch', recomputed };
  return { ok: true, reason: 'ok', recomputed };
}
