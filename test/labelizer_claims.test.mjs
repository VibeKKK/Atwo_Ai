// test/labelizer_claims.test.mjs —— exact 档不只要核 EVIDENCE，还要核 ANSWER 正文里的行号与计数声称。
//
// 为什么需要它：2026-11-18 的 PRD 指出，ANSWER 里另写的 (file,line) 与「共 N 处」原先完全没被核，
// 于是 exact 这个分母本身就不可靠。这里钉死两条反例 + 三种行号写法 + 计数口径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { objectiveFacts, claimsOf, countClaimsOf } from '../lib/labelizer.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') throw new Error('用例必须同步'); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

const SRC = Array.from({ length: 12 }, (_, i) => 'const v' + (i + 1) + ' = ' + (i + 1) + ';').join('\n') + '\n';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labeliz-claims-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'a.mjs'), SRC, 'utf8');
  return dir;
}
const ev = (body) => 'ANSWER: 结论\nEVIDENCE:\n' + body;
const line10 = '- lib/a.mjs:10 — \x60const v10 = 10;\x60';

test('claimsOf 认三种写法：单行、区间、逗号连写', () => {
  const cs = claimsOf('见 lib/a.mjs:123，另见 lib/a.mjs:130-135 与 lib/b.mjs:7,9');
  assert.deepEqual(cs.map((c) => c.file + ':' + c.line), ['lib/a.mjs:123', 'lib/a.mjs:130', 'lib/b.mjs:7', 'lib/b.mjs:9']);
  assert.equal(cs[0].raw, 'lib/a.mjs:123');
});

test('countClaimsOf 抽「共 N 处 / N 个文件 / N 份」', () => {
  const cc = countClaimsOf('共 3 处改动，涉及 2 个文件，另有 1 份补充');
  assert.deepEqual(cc.map((c) => c.n + c.subject), ['3处', '2个文件', '1份']);
});

test('反例一：ANSWER 声称 lib/a.mjs:99，EVIDENCE 只引 :10 → sloppy', () => {
  const dir = sandbox();
  const f = objectiveFacts({ answer: '结论：问题在 lib/a.mjs:99。', evidence: ev(line10) }, { cwd: dir });
  assert.equal(f.label, 'sloppy');
  assert.equal(f.why.includes('lib/a.mjs:99'), true);
  assert.equal(f.why.includes('未在 EVIDENCE 引用'), true);
});

test('反例二：ANSWER 说「共 3 处」，EVIDENCE 只有 2 条引用 → sloppy', () => {
  const dir = sandbox();
  const f = objectiveFacts({
    answer: '两处都核过了，共 3 处需要改。',
    evidence: ev(line10 + '\n- lib/a.mjs:12 — \x60const v12 = 12;\x60'),
  }, { cwd: dir });
  assert.equal(f.label, 'sloppy');
  assert.equal(f.why.includes('共 3 处'), true);
});

test('声称的每一条都在 EVIDENCE 里 → 仍 exact', () => {
  const dir = sandbox();
  const f = objectiveFacts({
    answer: '见 lib/a.mjs:10 与 lib/a.mjs:12，共 2 处。',
    evidence: ev(line10 + '\n- lib/a.mjs:12 — \x60const v12 = 12;\x60'),
  }, { cwd: dir });
  assert.equal(f.label, 'exact');
});

test('声称的行号落在 EVIDENCE 引用的区间内 → exact', () => {
  const dir = sandbox();
  const f = objectiveFacts({
    answer: '整段见 lib/a.mjs:12。',
    evidence: ev('- lib/a.mjs:10-12 — \x60const v10 = 10;\x60'),
  }, { cwd: dir });
  assert.equal(f.label, 'exact');
});

test('ANSWER 引了 EVIDENCE 完全没提的文件 → sloppy', () => {
  const dir = sandbox();
  const f = objectiveFacts({ answer: '另见 lib/other.mjs:3。', evidence: ev(line10) }, { cwd: dir });
  assert.equal(f.label, 'sloppy');
  assert.equal(f.why.includes('lib/other.mjs:3'), true);
});

console.log('\n' + passed + ' 通过 / ' + failed + ' 失败');
if (failed) process.exit(1);
