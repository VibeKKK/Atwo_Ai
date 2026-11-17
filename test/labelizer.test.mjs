// test/labelizer.test.mjs —— 客观标签：靠「引用是否真存在、引文是否真对得上」给产物定好坏。
//
// 为什么需要它：2026-11-17 那次盲测报出「误杀 86%」，全是人工标签跟着仓库漂行号造成的假数。
// 这组断言钉死的是口径本身：exact / sloppy / bad / empty / unknown 五档不许混。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { objectiveFacts, labelCases, codeToken, candidates, LABEL_CONTRACT } from '../lib/labelizer.mjs';
import { summarizeReview, renderBlindObjective } from '../lib/blind-objective.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') throw new Error('用例必须同步'); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

const SRC = ['export const A = 1;', 'const b = 2;', 'export function planSplit(task, opts = {}) {', '  return task;', '}', ''].join('\n');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labeliz-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'split.mjs'), SRC, 'utf8');
  return dir;
}
const ev = (body) => 'ANSWER: 结论\nEVIDENCE:\n' + body;

test('契约号是 atwo-label/2', () => assert.equal(LABEL_CONTRACT, 'atwo-label/2'));

test('引文逐行对得上 → exact', () => {
  const dir = sandbox();
  const f = objectiveFacts({ evidence: ev('- lib/split.mjs:3 — \x60export function planSplit(task, opts = {})\x60') }, { cwd: dir });
  assert.equal(f.label, 'exact');
  assert.equal(f.refs, 1);
  assert.equal(f.why.includes('逐行'), true);
});

test('引文在文件里但不在写的行上 → sloppy（不是 exact，也不是 bad）', () => {
  const dir = sandbox();
  const f = objectiveFacts({ evidence: ev('- lib/split.mjs:1 — \x60export function planSplit(task, opts = {})\x60') }, { cwd: dir });
  assert.equal(f.label, 'sloppy');
  assert.equal(f.shifted >= 1, true);
});

test('引用的文件根本不存在 → bad（历史里也没有）', () => {
  const dir = sandbox();
  const f = objectiveFacts({ evidence: ev('- fanout/service.go:42 — \x60func main() {}\x60') }, { cwd: dir });
  assert.equal(f.label, 'bad');
  assert.equal(f.bad >= 1, true);
});

test('EVIDENCE 是占位「(空)」→ empty', () => {
  const dir = sandbox();
  const f = objectiveFacts({ evidence: '(空)\n\n--- raw ---\n通道报错' }, { cwd: dir });
  assert.equal(f.label, 'empty');
});

test('一处「文件:行」都没有 → unknown（不是 bad，也不是 exact）', () => {
  const dir = sandbox();
  const f = objectiveFacts({ evidence: ev('- 我读了代码，确认没问题。') }, { cwd: dir });
  assert.equal(f.label, 'unknown');
  assert.equal(f.refs, 0);
});

test('不带目录的写法按 basename 解析（army-run.mjs:2）', () => {
  const dir = sandbox();
  const f = objectiveFacts({ evidence: ev('- split.mjs:2 — \x60const b = 2;\x60') }, { cwd: dir });
  assert.equal(f.label, 'exact');
  assert.equal(f.detail[0].resolved, 'lib/split.mjs');
});

test('中文「第 N 行」也算引用（.go 这种扩展名也要认）', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'lib', 'x.go'), 'package main\n\nfunc main() {}\n', 'utf8');
  const f = objectiveFacts({ evidence: ev('- \x60lib/x.go\x60 第 3 行 —— \x60func main() {}\x60') }, { cwd: dir });
  assert.equal(f.refs, 1);
  assert.equal(f.label, 'exact');
});

test('codeToken 只对代码形状的引文出手，散文返回空', () => {
  // 取「最长」的标识符当指纹：Math.max 比 count 更能定性这一行（2026-11-17 改：原先只认不含点的单词，
  // 结果 'opts.lanes' 这类引用拿不到指纹 → 跳过核对 → 内容对不上的产物被判 exact）
  assert.equal(codeToken('\x60const count = Math.max(2, n)\x60'), 'Math.max');
  assert.equal(codeToken('（这一行是作者自己的描述）'), '');
  assert.equal(codeToken('measure to artifacts'), '');
});

test('candidates 多命中时按路径尾部挑', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'other', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'other', 'lib', 'split.mjs'), 'x\n', 'utf8');
  const c = candidates(dir, 'lib/split.mjs');
  assert.equal(c[0], 'lib/split.mjs');
});

test('labelCases 统计五档 + 列出与人工标签不一致的', () => {
  const dir = sandbox();
  const out = labelCases([
    { id: 'a', label: 'good', evidence: ev('- lib/split.mjs:2 — \x60const b = 2;\x60') },
    { id: 'b', label: 'good', evidence: ev('- lib/split.mjs:4 — \x60export function planSplit(task, opts = {})\x60') },
    { id: 'c', label: 'bad', evidence: ev('- nope/x.go:9 — \x60func main()\x60') },
    { id: 'd', label: 'bad', evidence: '(空)' },
    { id: 'e', label: 'bad', evidence: ev('- 没有引用') },
  ], { cwd: dir });
  assert.deepEqual(out.counts, { exact: 1, sloppy: 1, bad: 1, empty: 1, unknown: 1 });
  // d 是人工 bad / 客观 empty，同属「有缺陷」大类，不算不一致
  // e 是 unknown（一处引用都没有）→ 归不了类，不参与比对
  assert.deepEqual(out.disagree.map((x) => x.id), ['b']);
});

test('summarizeReview：exact 被判 REVISE 算误杀，缺陷被判 PASS 算漏判，没票单列', () => {
  const labelled = [
    { label: { id: 'e1', objective: 'exact' } },
    { label: { id: 's1', objective: 'sloppy' } },
    { label: { id: 'b1', objective: 'bad' } },
    { label: { id: 'u1', objective: 'unknown' } },
  ];
  const sum = summarizeReview(labelled, {
    e1: { verdict: 'REVISE', bucket: 'falseAlarm' },
    s1: { verdict: 'PASS', bucket: 'missed' },
    b1: { verdict: 'REVISE', bucket: 'caught' },
    u1: { verdict: 'unreviewed', bucket: 'unreviewed' },
  });
  assert.equal(sum.falseAlarm, 1);
  assert.equal(sum.missed, 1);
  assert.equal(sum.caught, 1);
  assert.equal(sum.unreviewed, 1);
  // 样本不够（有缺陷 2 份、本该放行 1 份）→ 不许给及格/不及格，只能报样本不够。
  // 这是 2026-11-17 的教训：12 份里 exact 只有 0 份，那次「误杀率 0.182 / meets-bar」是没分母的假数。
  assert.equal(sum.verdict, 'not-enough-cases');
});

test('summarizeReview：分母只算「本该放行」的份数，样本够了才判', () => {
  const mk = (id, objective) => ({ label: { id, objective } });
  const labelled = [
    mk('e1', 'exact'), mk('e2', 'exact'), mk('e3', 'exact'),
    mk('d1', 'sloppy'), mk('d2', 'sloppy'), mk('d3', 'bad'), mk('d4', 'bad'), mk('d5', 'empty'),
  ];
  const review = {
    e1: { verdict: 'PASS', bucket: 'ok' }, e2: { verdict: 'PASS', bucket: 'ok' }, e3: { verdict: 'REVISE', bucket: 'falseAlarm' },
    d1: { verdict: 'REVISE', bucket: 'caught' }, d2: { verdict: 'REVISE', bucket: 'caught' }, d3: { verdict: 'REVISE', bucket: 'caught' },
    d4: { verdict: 'PASS', bucket: 'missed' }, d5: { verdict: 'REVISE', bucket: 'caught' },
  };
  const sum = summarizeReview(labelled, review);
  assert.equal(sum.defects, 5);
  assert.equal(sum.exactN, 3);
  // 误杀 1 / 本该放行 3 = 0.333（拿全部 8 份当分母会算成 0.125，把缺陷混进分母 = 稀释）
  assert.equal(sum.falseAlarmRate, 0.333);
  assert.equal(sum.verdict, 'below-bar');
});

test('renderBlindObjective 说清五档与三个指标', () => {
  const txt = renderBlindObjective({
    total: 12,
    counts: { exact: 2, sloppy: 5, bad: 1, empty: 3, unknown: 1 },
    disagree: [],
    review: { reviewed: 9, caught: 7, missed: 0, falseAlarm: 2, unknown: 1, unreviewed: 1, defects: 9, exactN: 2, falseAlarmRate: 1, verdict: 'below-bar', missedIds: [], falseAlarmIds: ['x'] },
  });
  assert.equal(txt.includes('exact 2'), true);
  assert.equal(txt.includes('漏判 0'), true);
  assert.equal(txt.includes('误杀 2'), true);
});

console.log('\n' + passed + ' 通过 / ' + failed + ' 失败');
if (failed) process.exit(1);