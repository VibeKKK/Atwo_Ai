import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildChildPrompt, buildReviewPrompt, parseChildOutput, parseReview, summarizeFanout, writeFanout, VERDICT } from '../lib/fanout.mjs';
import { clampParts, MAX_PARTS } from '../lib/fanout-run.mjs';

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

it('子提示包含任务与序号，且明确说看不到其他子会话', () => {
  const p = buildChildPrompt('数一下 test 下有多少文件', 1, 3);
  assert.match(p, /数一下 test 下有多少文件/);
  assert.match(p, /2 \/ 3/);
  assert.match(p, /看不到其他子任务/);
});

it('父提示包含全部子产物的 ANSWER 与 EVIDENCE', () => {
  const p = buildReviewPrompt('q', [{ id: 'child-1', answer: 'A1', evidence: 'E1' }, { id: 'child-2', answer: 'A2', evidence: 'E2' }]);
  assert.match(p, /A1/); assert.match(p, /E2/); assert.match(p, /child-2/);
  assert.match(p, /JSON 数组/);
});

it('解析标准标签输出', () => {
  const r = parseChildOutput('ANSWER:\n3 个码：0/2/4\nEVIDENCE:\natwo.mjs:189');
  assert.equal(r.answer, '3 个码：0/2/4');
  assert.match(r.evidence, /atwo\.mjs:189/);
  assert.equal(r.malformed, false);
});

it('没有标签时退回整段文本并标 malformed（不静默丢）', () => {
  const r = parseChildOutput('随便说点什么');
  assert.equal(r.malformed, true);
  assert.match(r.answer, /随便说点什么/);
});

it('空输出不算交卷', () => {
  const r = parseChildOutput('   ');
  assert.equal(r.malformed, true);
  assert.equal(r.answer, '');
});

it('父审查 JSON 数组 → 机器码', () => {
  const r = parseReview('[{"id":"child-1","verdict":"PASS","reason":"对"},{"id":"child-2","verdict":"revise","reason":"证据是空话"}]', ['child-1', 'child-2']);
  assert.equal(r[0].verdict, VERDICT.pass);
  assert.equal(r[1].verdict, VERDICT.revise);
});

it('父漏给某条票 → unreviewed，绝不默认 PASS', () => {
  const r = parseReview('[{"id":"child-1","verdict":"PASS","reason":"对"}]', ['child-1', 'child-2']);
  assert.equal(r[1].verdict, VERDICT.none);
  assert.match(r[1].reason, /没有对这条给票/);
});

it('父输出乱码 → 全部 unreviewed，不是全过', () => {
  const r = parseReview('我觉得都挺好的', ['child-1', 'child-2']);
  assert.ok(r.every((x) => x.verdict === VERDICT.none));
});

it('父输出「通过」人话也能认（兜底按行）', () => {
  const r = parseReview('child-1 通过\nchild-2 驳回：证据不足', ['child-1', 'child-2']);
  assert.equal(r[0].verdict, VERDICT.pass);
  assert.equal(r[1].verdict, VERDICT.revise);
});

it('全过 = ACCEPT(value 1)', () => {
  const s = summarizeFanout([{ verdict: 'PASS' }, { verdict: 'PASS' }]);
  assert.equal(s.value, 1); assert.equal(s.state, 'ACCEPT');
});

it('有一条重做 = REVISE(value -1)', () => {
  const s = summarizeFanout([{ verdict: 'PASS' }, { verdict: 'REVISE' }]);
  assert.equal(s.value, -1); assert.equal(s.state, 'REVISE');
});

it('全没票 = unreviewed(value 0)，不放行', () => {
  const s = summarizeFanout([{ verdict: 'unreviewed' }, { verdict: 'unreviewed' }]);
  assert.equal(s.value, 0); assert.equal(s.state, 'unreviewed');
});

it('部分没票 = partial，同样不放行', () => {
  const s = summarizeFanout([{ verdict: 'PASS' }, { verdict: 'unreviewed' }]);
  assert.equal(s.value, 0); assert.equal(s.state, 'partial');
});

it('并发上限钳在实测拐点内（' + MAX_PARTS + '）', () => {
  assert.equal(clampParts(0), 1);
  assert.equal(clampParts(3), 3);
  assert.equal(clampParts(12), MAX_PARTS);
  assert.equal(clampParts('7'), MAX_PARTS);
});

it('落盘后有父记录 + 每个子会话一个文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'));
  const children = [{ id: 'child-1', answer: 'A', evidence: 'E', elapsedMs: 12, raw: 'raw' }];
  const reviews = [{ id: 'child-1', verdict: 'PASS', reason: 'ok' }];
  const f = writeFanout(dir, { task: 'q', children, reviews, summary: summarizeFanout(reviews), meta: { parts: 1 } });
  assert.ok(fs.existsSync(f));
  assert.ok(fs.existsSync(path.join(dir, 'child-1.md')));
  assert.match(fs.readFileSync(f, 'utf8'), /ACCEPT/);
});

it('父会话用「子会话 #N」回 id 也要认（实测 glm 就这么回，旧版 3 票全丢）', () => {
  const raw = '[{"id":"子会话 #1","verdict":"PASS","reason":"齐"},{"id":"子会话 #2","verdict":"REVISE","reason":"漏 budget"},{"id":"子会话 #3","verdict":"PASS","reason":"一致"}]';
  const r = parseReview(raw, ['c1', 'c2', 'c3']);
  assert.deepEqual(r.map((x) => x.verdict), [VERDICT.pass, VERDICT.revise, VERDICT.pass]);
  assert.equal(summarizeFanout(r).value, -1);
});

it('id 归不出来仍然全 unreviewed（归一不许变成猜测）', () => {
  const raw = '[{"id":"随便写的","verdict":"PASS"},{"id":"子会话 #9","verdict":"PASS"}]';
  const r = parseReview(raw, ['c1', 'c2']);
  assert.deepEqual(r.map((x) => x.verdict), [VERDICT.none, VERDICT.none]);
});

it('同一条子产物不会被两张票重复认领', () => {
  const raw = '[{"id":"子会话 #1","verdict":"PASS"},{"id":"c1","verdict":"REVISE"}]';
  const r = parseReview(raw, ['c1']);
  assert.equal(r.length, 1);
  assert.equal(r[0].verdict, VERDICT.pass);
});

it('父提示不许「有矛盾就全毙」—— 正确答案不能陪葬', () => {
  const p = buildReviewPrompt('q', [{ id: 'c1', answer: 'A', evidence: 'E' }]);
  assert.ok(!/有矛盾就都判 REVISE/.test(p));
  assert.match(p, /证据更强/);
});

it('父提示要求实读源码（核对权），不是凭行号自称可信', () => {
  const p = buildReviewPrompt('q', [{ id: 'c1', answer: 'A', evidence: 'atwo.mjs:190' }]);
  assert.match(p, /只读/);
  assert.match(p, /真的去读那一行/);
  assert.match(p, /实际读到的内容片段/);
});

it('父会话的工具集被限制成 Read（父只审不干不能只靠提示词）', () => {
  const src = fs.readFileSync(new URL('../lib/fanout-run.mjs', import.meta.url), 'utf8');
  assert.match(src, /tools: 'Read'/);
});

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
