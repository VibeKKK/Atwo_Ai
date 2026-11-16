// file: test/attest_contract.test.mjs
// 验收：凭证必须绑**契约内容哈希**，不能只绑 contractVersion。
// 病根：版本号是自报的 —— cut.high 0.45→0.50 而版本号不动，旧凭证照样「重算通过」，
// 等于凭证替一把已经变了的尺子背书。这里钉死四件事：
//   1) 新凭证带 contractHash 且 v=2
//   2) 契约内容变了 → contract-changed（不是 ok）
//   3) v1 旧凭证在给了当前哈希时 → contract-unbound（不假装通过）
//   4) 不给哈希时保持向后兼容，但篡改仍然要被 hash-mismatch 拦下
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeAttestation, verifyAttestation } from '../vm/attest.mjs';
import { compileVerdict } from '../vm/verdict.mjs';
import { judge, CONTRACT_HASH, CONTRACT } from '../vm/judge.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok - ' + n); } else { fail++; console.log('  NOT OK - ' + n + (x ? ' :: ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), 'got ' + JSON.stringify(g) + ' want ' + JSON.stringify(w));

const inputs = { meanZ: 1.2, agreement: 0.9999999999996569, nValid: 0.3333333333333333 };
const output = { value: 0 };
const PROGRAM = compileVerdict(CONTRACT.cut).program; // judge 内部用的是同一份（compileVerdict(CUT)）
const att = makeAttestation({ program: PROGRAM, inputs, output, contract: CONTRACT, contractHash: CONTRACT_HASH });

// 1 新凭证的形状
eq('1a v=2', att.v, 2);
ok('1b 带 contractHash 且等于当前契约哈希', att.contractHash === CONTRACT_HASH, String(att.contractHash));
eq('1c 带 contractVersion', att.contractVersion, CONTRACT.contractVersion);
ok('1d 哈希是 64 位 hex', /^[0-9a-f]{64}$/.test(CONTRACT_HASH), CONTRACT_HASH);

// 2 当前契约下可重算
eq('2a 当前哈希 → ok', verifyAttestation(att, { contractHash: CONTRACT_HASH }).reason, 'ok');
ok('2b ok 时给出重算值', verifyAttestation(att, { contractHash: CONTRACT_HASH }).recomputed === 0);

// 3 契约内容一变就失效（这是本条的全部意义）
const fakeHash = 'f'.repeat(64);
eq('3a 换哈希 → contract-changed', verifyAttestation(att, { contractHash: fakeHash }).reason, 'contract-changed');
ok('3b contract-changed 时不给重算值', verifyAttestation(att, { contractHash: fakeHash }).recomputed === null);

// 4 v1 旧凭证：不假装通过
const legacy = { v: 1, contractVersion: 3, program: att.program, inputs: att.inputs, output: att.output, hash: att.hash };
eq('4a v1 无哈希 + 给了当前哈希 → contract-unbound', verifyAttestation(legacy, { contractHash: CONTRACT_HASH }).reason, 'contract-unbound');
eq('4b 不给哈希时向后兼容 → ok', verifyAttestation(legacy).reason, 'ok');

// 5 篡改仍然被拦（新增分支不能把老防线冲掉）
const tampered = { ...att, inputs: { ...att.inputs, meanZ: 0.1 } };
eq('5a 改输入 → hash-mismatch', verifyAttestation(tampered, { contractHash: CONTRACT_HASH }).reason, 'hash-mismatch');
const forged = { ...att, output: { value: 1 } };
forged.hash = makeAttestation({ program: forged.program, inputs: forged.inputs, output: forged.output, contract: CONTRACT, contractHash: CONTRACT_HASH }).hash;
eq('5b 改输出并同步改 hash → recompute-mismatch', verifyAttestation(forged, { contractHash: CONTRACT_HASH }).reason, 'recompute-mismatch');

// 6 真链路：judge 产出的凭证自带当前契约哈希
const j = judge({ zValues: [1.2, 1.1, 1.3], withAttest: true });
ok('6a judge --attest 带 attestation', Boolean(j.attestation));
eq('6b 自带当前契约哈希', j.attestation.contractHash, CONTRACT_HASH);
eq('6c 自带版本号', j.attestation.contractVersion, CONTRACT.contractVersion);
eq('6d 能通过当前哈希校验', verifyAttestation(j.attestation, { contractHash: CONTRACT_HASH }).reason, 'ok');

// 7 CLI：atwo attest --json 里带契约指纹（机器可读）
const cli = spawnSync(process.execPath, ['atwo.mjs', 'attest', '--json'], { cwd: HERE, encoding: 'utf8', timeout: 120000 });
let payload = null;
try { payload = JSON.parse(String(cli.stdout || '')); } catch { /* 下面断言会红 */ } // --json 是整段缩进 JSON，别按行解
ok('7a attest --json 出可解析 JSON', Boolean(payload));
ok('7b data.attest.judge.contract.hash 是当前哈希前缀', Boolean(payload && payload.data && payload.data.attest && payload.data.attest.judge.contract
  && CONTRACT_HASH.startsWith(payload.data.attest.judge.contract.hash)));
ok('7c 旧版单独计数，不混进失效', Boolean(payload && payload.data && payload.data.attest.judge
  && Array.isArray(payload.data.attest.judge.legacy)
  && (payload.data.attest.judge.legacy.length === 0 || payload.data.attest.judge.bad.every((b) => b.reason !== 'contract-unbound'))));

console.log(fail === 0 ? '\n' + pass + ' 通过 / 0 失败' : '\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
