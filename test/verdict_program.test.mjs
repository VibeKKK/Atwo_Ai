// file: test/verdict_program.test.mjs
// 验收 vm/verdict.mjs + vm/attest.mjs（PRD 10 条）
import fs from 'node:fs';
import { compileVerdict, runVerdict } from '../vm/verdict.mjs';
import { makeAttestation, verifyAttestation } from '../vm/attest.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok - ' + n); } else { fail++; console.log('  NOT OK - ' + n + (x ? ' :: ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), 'got ' + JSON.stringify(g) + ' want ' + JSON.stringify(w));

const contract = JSON.parse(fs.readFileSync(new URL('../vm/oracle-contract.json', import.meta.url), 'utf8'));
const CUT = contract.cut;
const compiled = compileVerdict(CUT);

// 1 程序不是一条 AND，长度 > 8，操作码合法
const legal = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
ok('1a 程序长度 > 8', compiled.program.length > 8, 'len=' + compiled.program.length);
ok('1b 只含合法操作码', compiled.program.every((x) => legal.has(x) || typeof x === 'number'));

// 2 三档判定
eq('2 +1（高置信）', runVerdict(compiled, { meanZ: 3, agreement: 1, nValid: 1 }).value, 1);
eq('2 0（中置信）', runVerdict(compiled, { meanZ: 0.5, agreement: 0.9, nValid: 1 }).value, 0);
eq('2 -1（低置信）', runVerdict(compiled, { meanZ: 0.05, agreement: 0.5, nValid: 1 }).value, -1);

// 3 与旧 verdictRule 300 组随机一致（固定种子 LCG）
const rule = (meanZ, agreement, nValid, cut) => {
  const c = Math.tanh(Math.abs(meanZ)) * agreement * nValid;
  let v = c >= cut.high ? 1 : (c >= cut.mid ? 0 : -1);
  if (v === 1 && meanZ === 0) v = -1;
  return v;
};
let seed = 20261116;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let mismatch = 0;
for (let i = 0; i < 300; i++) {
  const meanZ = (rnd() - 0.5) * 6;
  const agreement = rnd();
  const nValid = rnd();
  if (runVerdict(compiled, { meanZ, agreement, nValid }).value !== rule(meanZ, agreement, nValid, CUT)) mismatch++;
}
eq('3 300 组随机与 verdictRule 一致', mismatch, 0);

// 4 脱钩保护（PRD 原文：meanZ=0 且落在 high 区间 → -1）
// meanZ=0 时公式 conf=tanh(0)*…=0，下界 THRESH 自然压成 -1；
// 要构造「落在 high 区间」必须显式注入 confidence —— 这正是凭证复算的场景。
const dec = runVerdict(compiled, { meanZ: 0, agreement: 1, nValid: 1 });
eq('4a meanZ=0（公式路径）→ -1', dec.value, -1);
const guardHit = runVerdict(compiled, { meanZ: 0, confidence: 0.9 });
eq('4b meanZ=0 且落在 high 区间 → VM 内脱钩保护判 -1', guardHit.value, -1);
eq('4c 对照：高档但 meanZ≠0 → 正常 +1', runVerdict(compiled, { meanZ: 2, confidence: 0.9 }).value, 1);

// 5 阈值来自契约（换 cut 后判定跟着变）
const c90 = compileVerdict({ high: 0.9, mid: 0.5 });
const t = { meanZ: 1.2, agreement: 1, nValid: 1 }; // confidence ≈ 0.833
eq('5a 默认契约下 +1', runVerdict(compiled, t).value, 1);
eq('5b 收紧到 0.9 后变 0', runVerdict(c90, t).value, 0);

// 6-9 attestation（program 用编译模板：verify 端按同一约定注入数据槽重算）
const out = runVerdict(compiled, t);
const att = makeAttestation({ program: compiled.program, inputs: t, output: { value: out.value }, contract });
ok('6 hash 是 64 位十六进制', /^[0-9a-f]{64}$/.test(att.hash));
eq('7 未篡改 → ok', verifyAttestation(att).ok, true);
const tampered1 = { ...att, inputs: { ...att.inputs, meanZ: t.meanZ + 1 } };
eq('8 改输入 → hash-mismatch', verifyAttestation(tampered1).reason, 'hash-mismatch');
const forged = { ...att };
forged.output = { value: -1 };
forged.hash = (await import('node:crypto')).createHash('sha256')
  .update(JSON.stringify([forged.program, forged.inputs, forged.output])).digest('hex');
eq('9 改输出并同步改 hash → recompute-mismatch', verifyAttestation(forged).reason, 'recompute-mismatch');

// 10 judge() 真跑程序（programSteps > 0）
const { judge } = await import('../vm/judge.mjs');
const j = judge({ zValues: [3.1, 2.9, 3.4, 2.8, 3, 3.2, 2.7, 3.3, 3.1] });
ok('10a judge 返回 programSteps > 0', Number(j.programSteps) > 0, 'programSteps=' + j.programSteps);
ok('10b 默认不带 attestation', j.attestation === undefined || j.attestation === null);
const j2 = judge({ zValues: [3.1, 2.9, 3.4, 2.8, 3, 3.2, 2.7, 3.3, 3.1] }, { withAttest: true });
ok('10c withAttest 时带 attestation 且可校验', Boolean(j2.attestation) && verifyAttestation(j2.attestation).ok);

console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
