// file: vm/attest.mjs
// 可复算凭证：把一次裁决的 (程序, 输入, 输出) 三元组固定下来，任何人拿到都能离线重算。
// 这是这台虚拟机存在的唯一正当理由 —— 判定要能从"相信我"变成"你自己算"。
import { createHash } from 'node:crypto';
import { runVerdict } from './verdict.mjs';

const hashOf = (program, inputs, output) =>
  createHash('sha256').update(JSON.stringify([program, inputs, output])).digest('hex');

/**
 * @param {{program:number[], inputs:object, output:object, contract?:object}} spec
 */
export function makeAttestation({ program, inputs, output, contract = null }) {
  if (!Array.isArray(program)) throw new Error('makeAttestation: program 必须是数组');
  const hash = hashOf(program, inputs, output);
  return {
    v: 1,
    contractVersion: contract && contract.contractVersion !== undefined ? contract.contractVersion : null,
    program: program.slice(),
    inputs: { ...inputs },
    output: { ...output },
    hash,
  };
}

/**
 * 三步校验：hash 未被改 → 重算得到同一 value → 程序与输入自洽。
 * @returns {{ok:boolean, reason:string, recomputed:number|null}}
 */
export function verifyAttestation(att) {
  if (!att || typeof att !== 'object') return { ok: false, reason: 'not-an-attestation', recomputed: null };
  if (!Array.isArray(att.program)) return { ok: false, reason: 'program-missing', recomputed: null };
  if (!att.output || typeof att.output !== 'object') return { ok: false, reason: 'output-missing', recomputed: null };

  const expect = hashOf(att.program, att.inputs, att.output);
  if (expect !== att.hash) return { ok: false, reason: 'hash-mismatch', recomputed: null };

  let recomputed;
  try {
    recomputed = runVerdict({ program: att.program }, att.inputs).value;
  } catch (e) {
    return { ok: false, reason: 'recompute-error:' + String(e.message).slice(0, 60), recomputed: null };
  }
  if (recomputed !== att.output.value) return { ok: false, reason: 'recompute-mismatch', recomputed };
  return { ok: true, reason: 'ok', recomputed };
}
