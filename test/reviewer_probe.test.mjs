// test/reviewer_probe.test.mjs —— 父审探活：接线通了不等于能当父审。
// 这一层存在的理由是一条实测事实：trae 占位/超时、workbuddy 回服务端错误、ollama 退化重复且误杀，
// 三条通道「连得上」，但没有一条能给出可信判定。探活不过就必须在报告里写「无可用异源父审」。
import assert from 'node:assert/strict';
import { buildProbeChildren, degeneracy, formatProbes, judgeProbe, probeReviewer } from '../lib/reviewer-probe.mjs';

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

console.log('reviewer probe');

const cite = { trueRef: 'atwo.mjs:230', trueText: 'const EXIT = { ok: 0, usage: 2, precondition: 3, accept: 4, channel: 5, budget: 6 };', falseRef: 'atwo.mjs:999', falseText: '（这一行不存在）' };
const good = JSON.stringify({ reviews: [
  { id: 'child-1', verdict: 'PASS', reason: 'atwo.mjs:230 原文六码，与产物一致' },
  { id: 'child-2', verdict: 'REVISE', reason: 'atwo.mjs:999 不存在，产物编了四码' },
  { id: 'child-3', verdict: 'REVISE', reason: '读了 atwo.mjs:230，原文是六码不是两码' },
] });

await ta('三条产物：真 / 编造 / 行号真内容假（第三条才是核对能力）', () => {
  const kids = buildProbeChildren(cite);
  assert.equal(kids.length, 3);
  assert.match(kids[0].evidence, /atwo\.mjs:230/);
  assert.match(kids[1].evidence, /atwo\.mjs:999/);
  assert.match(kids[2].evidence, /atwo\.mjs:230 （这一行不存在）/);
});

await ta('合规父审 → usable', () => {
  const j = judgeProbe(good);
  assert.equal(j.usable, true, j.reasons.join(';'));
});

await ta('误杀（对正确产物给 REVISE）→ 不可用，理由点名误杀', () => {
  const bad = JSON.stringify({ reviews: [{ id: 'child-1', verdict: 'REVISE', reason: 'x' }, { id: 'child-2', verdict: 'REVISE', reason: 'y' }] });
  const j = judgeProbe(bad);
  assert.equal(j.usable, false);
  assert.ok(j.reasons.some((r) => /误杀/.test(r)), j.reasons.join(';'));
});

await ta('抓不住错（对编造产物给 PASS）→ 不可用，理由点名抓不住', () => {
  const bad = JSON.stringify({ reviews: [{ id: 'child-1', verdict: 'PASS', reason: 'x' }, { id: 'child-2', verdict: 'PASS', reason: 'y' }] });
  const j = judgeProbe(bad);
  assert.ok(j.reasons.some((r) => /抓不住错/.test(r)), j.reasons.join(';'));
});

await ta('空内容 / 非 JSON → 不可用', () => {
  assert.equal(judgeProbe('').usable, false);
  assert.equal(judgeProbe('我觉得还行').usable, false);
});

await ta('退化重复（ollama 实测那种原地打转）被识别', () => {
  const loop = '证据完全一致，但注释行内容一致，'.repeat(20);
  assert.ok(degeneracy(loop) > 0.45, 'degeneracy=' + degeneracy(loop));
  const j = judgeProbe(JSON.stringify({ reviews: [{ id: 'child-1', verdict: 'PASS', reason: loop }, { id: 'child-2', verdict: 'REVISE', reason: 'y' }] }));
  assert.ok(j.reasons.some((r) => /退化/.test(r)), j.reasons.join(';'));
});

await ta('通道抛错 → 不可用且原因保留（取不到 ask 的情况）', async () => {
  const r = await probeReviewer('nope', cite);
  assert.equal(r.usable, false);
  assert.match(r.reasons[0], /没有这个通道/);
});

await ta('注入合规 ask → usable；注入错误文案 → 不可用', async () => {
  const ok = await probeReviewer('injected', cite, { ask: async () => ({ ok: true, addedText: good }) });
  assert.equal(ok.usable, true, ok.reasons.join(';'));
  const bad = await probeReviewer('injected', cite, { ask: async () => ({ ok: false, err: '通道返回的是错误文案（抱歉，发生未知错误暂无响应）', addedText: '抱歉，发生未知错误暂无响应' }) });
  assert.equal(bad.usable, false);
});

await ta('formatProbes：只有同源可用时要明说「拿不出手」', () => {
  const text = formatProbes([
    { lane: 'codebuddy', usable: true, ms: 1000, reasons: [] },
    { lane: 'trae', usable: false, ms: 187000, reasons: ['等待超时'] },
  ]);
  assert.match(text, /只有同源通道能用/);
  assert.match(text, /✗ trae/);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
