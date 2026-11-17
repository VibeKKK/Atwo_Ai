import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRE, preGate, preGateAll, collectRefs, refMatchCheck } from '../lib/pregate.mjs';

const child = (o) => ({ id: 'child-1', answer: 'ANSWER: x', evidence: 'EVIDENCE: atwo.mjs:194', ...o });

test('空答案 → REVISE', () => {
  assert.equal(preGate(child({ answer: '' })).verdict, PRE.revise);
  assert.match(preGate(child({ answer: '' })).reason, /ANSWER 为空/);
});

test('空证据 → REVISE', () => {
  assert.equal(preGate(child({ evidence: '   ' })).verdict, PRE.revise);
});

test('证据没有文件:行 → REVISE', () => {
  assert.match(preGate(child({ evidence: '我觉得是这样的' })).reason, /不可核对/);
});

test('文件:行 / 第 N 行 / L123 都算有引用', () => {
  assert.equal(preGate(child({})).verdict, PRE.defer);
  assert.equal(preGate(child({ evidence: '第 194 行写着' })).verdict, PRE.defer);
  assert.equal(preGate(child({ evidence: 'atwo L194' })).verdict, PRE.defer);
});

test('机械判定带 mechanical 与 id', () => {
  const g = preGate(child({ answer: '' }));
  assert.equal(g.mechanical, true);
  assert.equal(g.id, 'child-1');
});

test('preGateAll 分流', () => {
  const kids = [child({ id: 'child-1' }), child({ id: 'child-2', answer: '' }), child({ id: 'child-3', evidence: '无行号' })];
  const { reviews, deferred } = preGateAll(kids, { cwd: process.cwd() });
  assert.equal(reviews.length, 2);
  assert.deepEqual(deferred.map((c) => c.id), ['child-1']);
});

test('全空按 0 处理不抛', () => {
  const { reviews, deferred } = preGateAll(null, { cwd: process.cwd() });
  assert.equal(reviews.length + deferred.length, 0);
});

// ── 第三层：引用比对（用临时文件造真值，不依赖 .atw/fanout）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pregate-'));
fs.writeFileSync(path.join(tmp, 'fake.mjs'), ['import { spawn } from "node:child_process";', 'const helper = (value) => value + 1;', 'export function runProgram(input) {', '  return input.map(helper);', '}', ''].join('\n'));

test('引用对得上原文 → defer', () => {
  const c = { id: 'c1', answer: 'ANSWER: 第 3 行是 runProgram', evidence: 'EVIDENCE: fake.mjs:3 原文 export function runProgram(input) {' };
  const r = refMatchCheck(c, { cwd: tmp });
  assert.equal(r.verdict, PRE.defer);
  assert.equal(r.refMatch.zero, 0);
});

test('引用整块捏造 → REVISE（行号下没有它写的任何标识符）', () => {
  const c = {
    id: 'c7',
    answer: 'ANSWER: EXIT 有 ok usage precondition accept channel 五个码，全部定义在这里',
    evidence: 'EVIDENCE: fake.mjs:1 / fake.mjs:2 / fake.mjs:3 / fake.mjs:4 都是 EXIT 常量的组成部分 ok usage precondition accept channel',
  };
  const r = refMatchCheck(c, { cwd: tmp });
  assert.equal(r.verdict, PRE.revise);
  assert.match(r.reason, /找不到你写的任何标识符/);
  assert.ok(r.refMatch.judged >= 4);
});

test('引用条数太少时不下结论（省略式引用合法）', () => {
  const c = { id: 'c2', answer: 'ANSWER: 改了一下', evidence: 'EVIDENCE: fake.mjs:5' };
  assert.equal(refMatchCheck(c, { cwd: tmp }).verdict, PRE.defer);
});

test('文件不存在时跳过该条，不误判', () => {
  const c = { id: 'c3', answer: 'ANSWER: x', evidence: 'EVIDENCE: no-such-file.mjs:9 / no-such-file.mjs:10 / no-such-file.mjs:11 / no-such-file.mjs:12' };
  const r = refMatchCheck(c, { cwd: tmp });
  assert.equal(r.verdict, PRE.defer);
  assert.equal(r.refMatch.judged, 0);
});

test('preGateAll 会把引用捏造的也判死（不送父审）', () => {
  const kids = [
    { id: 'ok1', answer: 'ANSWER: runProgram 在第 3 行', evidence: 'EVIDENCE: fake.mjs:3 export function runProgram(input) {' },
    { id: 'bad1', answer: 'ANSWER: EXIT 有 ok usage precondition accept channel', evidence: 'EVIDENCE: fake.mjs:1 / fake.mjs:2 / fake.mjs:3 / fake.mjs:4 ok usage precondition accept channel EXIT' },
  ];
  const { reviews, deferred } = preGateAll(kids, { cwd: tmp });
  assert.deepEqual(deferred.map((c) => c.id), ['ok1']);
  assert.deepEqual(reviews.map((r) => r.id), ['bad1']);
});

// ── 第二层：被引用原文提取 ──
test('collectRefs 抽出被引用行的原文', () => {
  const r = collectRefs([{ answer: 'x', evidence: 'fake.mjs:3 和 fake.mjs:5' }], { cwd: tmp });
  assert.equal(r.files, 1);
  assert.match(r.text, /3: export function runProgram\(input\) \{/);
});

test('collectRefs 记下读不到的文件（不静默丢）', () => {
  const r = collectRefs([{ answer: 'x', evidence: 'ghost.mjs:3' }], { cwd: tmp });
  assert.equal(r.files, 0);
  assert.equal(r.missing.length, 1);
});

test('collectRefs 行号超出文件长度时明确报出来', () => {
  const r = collectRefs([{ answer: 'x', evidence: 'fake.mjs:999' }], { cwd: tmp });
  assert.match(r.missing[0], /行号超出文件长度/);
});

test('编造的行号必须判死（文件没那么长）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-'));
  fs.writeFileSync(path.join(tmp, 'a.mjs'), 'const A = 1;\nconst B = 2;\n');
  const r = refMatchCheck({ id: 'c', answer: 'x', evidence: 'a.mjs:999 —— const A = 1;' }, { cwd: tmp });
  assert.equal(r.verdict, PRE.revise);
  assert.match(r.reason, /不存在的行/);
});

test('两处引用全部零重叠必须判死（原判据要 4 条才动）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-'));
  fs.writeFileSync(path.join(tmp, 'a.mjs'), 'export function alpha() { return 1 }\nexport function beta() { return 2 }\n');
  const r = refMatchCheck({ id: 'c', answer: 'x', evidence: 'a.mjs:1 —— zzzz qqqq wwww\na.mjs:2 —— yyyy uuuu vvvv' }, { cwd: tmp });
  assert.equal(r.verdict, PRE.revise);
});

test('同一行改数字必须判死（token 重叠抓不到，数字要对得上）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-'));
  fs.writeFileSync(path.join(tmp, 'a.mjs'), 'export const MAX_PARTS = 6;\n');
  const r = refMatchCheck({ id: 'c', answer: 'x', evidence: 'a.mjs:1 —— export const MAX_PARTS = 99;' }, { cwd: tmp });
  assert.equal(r.verdict, PRE.revise);
  assert.match(r.reason, /数字对不上/);
});

test('逐字抄对的行必须放行（新规则不许误杀）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-'));
  fs.writeFileSync(path.join(tmp, 'a.mjs'), 'export const MAX_PARTS = 6;\n');
  const r = refMatchCheck({ id: 'c', answer: 'x', evidence: 'a.mjs:1 —— export const MAX_PARTS = 6;' }, { cwd: tmp });
  assert.equal(r.verdict, PRE.defer);
});
test('引文里夹着行号（a.mjs:40 … :43）不许当抄写数字判死（2026-11-17 真语料 exact-30 的假阳性）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-'));
  fs.writeFileSync(path.join(tmp, 'a.mjs'), 'export const isCodeTask = (p) => CODE_HINTS.test(String(p));\n');
  // 40 / 43 是「文件名:行号」里的行号，不是代码里的数字；拿它们去和第 1 行比必然对不上。
  const r = refMatchCheck({ id: 'c', answer: 'x', evidence: 'a.mjs:1 —— 读作 export const isCodeTask = (p) => …；:40 读作 export function beta；:43 读作 export function gamma；实际第 1 行是 export const isCodeTask = (p) => CODE_HINTS.test(String(p));' }, { cwd: tmp });
  assert.equal(r.verdict, PRE.defer);
});

test('引用写行范围（a.mjs:1-3）时要按整段核，范围内命中就算对（原先只看起始行会误杀）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-'));
  fs.writeFileSync(path.join(tmp, 'a.mjs'), ['// header', 'export function alpha() { return 1 }', 'export function beta() { return 2 }'].join('\n') + '\n');
  const r = refMatchCheck({ id: 'c', answer: 'x', evidence: 'a.mjs:1-3 —— export function beta() { return 2 }' }, { cwd: tmp });
  assert.equal(r.verdict, PRE.defer);
});

