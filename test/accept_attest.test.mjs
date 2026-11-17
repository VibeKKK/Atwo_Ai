// test/accept_attest.test.mjs
// 验收：lib/accept-attest.mjs（12 条断言，重点是"文件被动过一定抓得到"）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  makeAcceptAttestation, appendAttestation, readAttestations,
  verifyAcceptAttestation, attestFiles,
} from '../lib/accept-attest.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok - ' + n); } else { fail++; console.log('  NOT OK - ' + n + (x ? ' :: ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), 'got ' + JSON.stringify(g) + ' want ' + JSON.stringify(w));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-'));
const f1 = path.join(TMP, 'a.mjs');
fs.writeFileSync(f1, 'export const a = 1;\n', 'utf8');

// 1 造凭证：字段齐、digest 64 位、hash 64 位
const att = makeAcceptAttestation({ task: 't1', file: f1, acceptExit: 0, now: '2026-11-16T07:00:00Z' });
ok('1a digest 是 64 位十六进制', /^[0-9a-f]{64}$/.test(att.digest));
ok('1b hash 是 64 位十六进制', /^[0-9a-f]{64}$/.test(att.hash));
eq('1c 时间归一 ISO', att.time, '2026-11-16T07:00:00.000Z');
eq('1d size 是真实字节数', att.size, fs.statSync(f1).size);
eq('1e file 用正斜杠', att.file.includes('\\'), false);

// 2 未篡改 → ok
eq('2 原样校验 ok', verifyAcceptAttestation(att).ok, true);

// 3 改 hash → hash-mismatch
eq('3 改 hash 被抓', verifyAcceptAttestation({ ...att, size: att.size + 1 }).reason, 'hash-mismatch');

// 4 文件内容被改 → content-changed
fs.writeFileSync(f1, 'export const a = 2;\n', 'utf8');
const v4 = verifyAcceptAttestation(att);
ok('4 内容变了被抓', v4.ok === false && (v4.reason === 'content-changed' || v4.reason === 'size-changed'), v4.reason);

// 5 文件被删 → file-missing
fs.writeFileSync(f1, 'export const a = 1;\n', 'utf8');
const att5 = makeAcceptAttestation({ task: 't1', file: f1 });
fs.unlinkSync(f1);
eq('5 文件没了被抓', verifyAcceptAttestation(att5).reason, 'file-missing');
fs.writeFileSync(f1, 'export const a = 1;\n', 'utf8');

// 6 缺字段
eq('6 缺字段被抓', verifyAcceptAttestation({ v: 1 }).reason.startsWith('field-missing'), true);

// 7 落账 + 读回
const ledger = path.join(TMP, 'sub', 'attest.jsonl');
eq('7a append 返回 ok', appendAttestation(ledger, att).ok, true);
fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8') + 'NOT JSON\n', 'utf8');
eq('7b 坏行跳过，读到 1 条', readAttestations(ledger).length, 1);
eq('7c 账本不存在 → []', readAttestations(path.join(TMP, 'nope.jsonl')), []);

// 8 批量：不存在的文件跳过，不许假装验过
const good = path.join(TMP, 'b.mjs');
fs.writeFileSync(good, 'export const b = 1;\n', 'utf8');
const batch = attestFiles({
  task: 't2', files: [good, path.join(TMP, 'ghost.mjs')], acceptExit: 0,
  ledger: path.join(TMP, 'attest2.jsonl'),
});
eq('8a 只对存在的文件出凭证', batch.count, 1);
eq('8b 全部落账', batch.appended, 1);
eq('8c 落账后能读回且可校验', readAttestations(path.join(TMP, 'attest2.jsonl')).every((x) => verifyAcceptAttestation(x).ok), true);

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
