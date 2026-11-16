// lib/report.mjs 的单测（PRD R5 的 A10/A12）。
//
// 重点不是「能算数」，而是那三条硬要求：
//   1. 三个数都要有（成功/失败/待拍板）
//   2. 失败必须带「哪一步断的 + 下一步点哪里」
//   3. **不许静默丢任务** —— 连日志都没留下的那条也必须出现在报告里
import assert from 'node:assert/strict';
import { summarize, whereBroke } from '../lib/report.mjs';

let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log('  ✓ ' + name);
}

// ── 三个数 ──
ok('成功/失败/待定 三个数都对', () => {
  const s = summarize([
    { source: 'a.md', code: 0, entry: { ok: true, agent: 'codebuddy', elapsedMs: 30000, outputChars: 120 } },
    { source: 'b.md', code: 1, entry: { ok: false, agent: 'trae', error: 'CDP 被占用' } },
    { source: 'c.md', code: 0, entry: { ok: true }, needsYou: true },
  ]);
  assert.equal(s.ok, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.pending, 1);
});

// ── 失败要说人话 ──
ok('失败那行带「断在」和「下一步」', () => {
  const s = summarize([{ source: 'b.md', code: 1, entry: { ok: false, agent: 'trae', error: 'CDP 被占用' } }]);
  const joined = s.lines.join('\n');
  assert.match(joined, /断在：/);
  assert.match(joined, /下一步：/);
});

// ── 不许静默丢 ──
ok('连日志都没留下的任务也出现在报告里', () => {
  const s = summarize([{ source: 'ghost.md', code: 1, entry: null }]);
  assert.equal(s.lines.filter((l) => l.includes('ghost.md')).length >= 1, true);
  assert.match(s.markdown, /ghost\.md/);
  assert.equal(s.failed, 1);
});

ok('一个任务都没有时不崩', () => {
  const s = summarize([]);
  assert.equal(s.ok + s.failed + s.pending, 0);
  assert.match(s.markdown, /合计 0 个/);
});

// ── whereBroke 的四种分支 ──
ok('产物没过程序检查 → 提示改产物而不是重派', () => {
  const w = whereBroke({ ok: true, contract: 'fail' });
  assert.match(w.step, /程序检查/);
  assert.match(w.next, /别重派/);
});

ok('通道报错 → 提示去看通道登录态', () => {
  const w = whereBroke({ ok: false, error: 'no response' });
  assert.match(w.step, /通道报错/);
  assert.match(w.next, /doctor/);
});

ok('返回失败但没写原因 → 不许编原因', () => {
  const w = whereBroke({ ok: false });
  assert.match(w.step, /没写原因/);
});

ok('没有日志记录 → 明说「没跑起来」', () => {
  assert.match(whereBroke(null).step, /没跑起来/);
});

// ── markdown 三段齐 ──
ok('报告里有「成功 N 个 · 失败 M 个 · 需要你拍板 K 个」', () => {
  const s = summarize([{ source: 'a.md', code: 0, entry: { ok: true, agent: 'x' } }]);
  assert.match(s.markdown, /成功 1 个 · 失败 0 个 · 需要你拍板 0 个 · 合计 1 个/);
  assert.match(s.markdown, /^# 批量派活汇总/m);
});

console.log('\n' + n + ' 项通过');
