// 单路快速失败判据（P0-3）：谁没张嘴谁先死。
// 只测纯函数。理由：GUI 自动化没法从外面取消，能保证的只有「不再等它」，
// 而「不再等」的判据就是这个函数。
import assert from 'node:assert/strict';
import { judgeLaneDeadline, TTFB_MS, pruneLanes, ttfbFor } from '../lib/outcome.mjs';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('✓ ' + name);
  } catch (e) {
    fail++;
    console.log('✗ ' + name + ' —— ' + (e && e.message));
  }
};

const START = 1_000_000;

t('默认阈值是 15 秒', () => {
  assert.equal(TTFB_MS, 15000);
});

t('刚开始不到 15 秒：不判死', () => {
  const r = judgeLaneDeadline({ startedAt: START, now: START + 3_000 });
  assert.equal(r.dead, false);
  assert.equal(r.kind, '');
  assert.equal(r.text, '');
});

t('15 秒还没出第一个字：判死，种类 ttfb', () => {
  const r = judgeLaneDeadline({ startedAt: START, now: START + 15_000 });
  assert.equal(r.dead, true);
  assert.equal(r.kind, 'ttfb');
  assert.match(r.text, /还没出第一个字/);
});

t('出过字之后再静默：走 silence 而不是 ttfb', () => {
  const r = judgeLaneDeadline({
    startedAt: START,
    firstAt: START + 2_000,
    lastAt: START + 2_000,
    now: START + 24_000,
  });
  assert.equal(r.dead, true);
  assert.equal(r.kind, 'silence');
  assert.match(r.text, /没有新输出/);
});

t('出过字、静默还在容忍内：不判死', () => {
  const r = judgeLaneDeadline({
    startedAt: START,
    firstAt: START + 2_000,
    lastAt: START + 18_000,
    now: START + 25_000,
  });
  assert.equal(r.dead, false);
});

t('firstAt 之后有更新输出时，从最后一次算起', () => {
  const r = judgeLaneDeadline({
    startedAt: START,
    firstAt: START + 1_000,
    lastAt: START + 40_000,
    now: START + 45_000,
  });
  assert.equal(r.dead, false, '最后输出到现在才 5 秒，不该判死');
});

t('ttfbMs=0 关掉首字节判据', () => {
  const r = judgeLaneDeadline({ startedAt: START, now: START + 600_000, ttfbMs: 0 });
  assert.equal(r.dead, false);
  assert.equal(r.kind, '');
});

t('silenceMs=0 关掉静默判据', () => {
  const r = judgeLaneDeadline({
    startedAt: START,
    firstAt: START + 1_000,
    lastAt: START + 1_000,
    now: START + 600_000,
    silenceMs: 0,
  });
  assert.equal(r.dead, false);
});

t('自定义 ttfbMs 生效（8 秒）', () => {
  const r = judgeLaneDeadline({ startedAt: START, now: START + 8_000, ttfbMs: 8_000 });
  assert.equal(r.dead, true);
  assert.equal(r.kind, 'ttfb');
});

t('waitedMs 不会为负（时钟回拨也不炸）', () => {
  const r = judgeLaneDeadline({ startedAt: START + 5_000, now: START });
  assert.ok(r.waitedMs >= 0);
  assert.equal(r.dead, false);
});

// ——— 通道裁剪：只砍「有样本且 0 成功」，且绝不砍光 ———

t('有样本且 0 成功：砍掉', () => {
  const rows = [
    { agent: 'trae', ok: false, elapsedMs: 30000 },
    { agent: 'trae', ok: false, elapsedMs: 28000 },
    { agent: 'codebuddy', ok: true, elapsedMs: 33000 },
  ];
  const r = pruneLanes(rows, ['trae', 'codebuddy']);
  assert.deepEqual(r.dropped.map((d) => d.lane), ['trae']);
  assert.deepEqual(r.kept, ['codebuddy']);
});

t('0 秒失败不算通道死（那是参数配错）', () => {
  const rows = [
    { agent: 'codebuddy', ok: false, elapsedMs: 0 },
    { agent: 'codebuddy', ok: false, elapsedMs: 0 },
    { agent: 'codebuddy', ok: false, elapsedMs: 0 },
  ];
  const r = pruneLanes(rows, ['codebuddy']);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.kept, ['codebuddy']);
});

t('没样本的路不砍（第一次跑就是在攒样本）', () => {
  const r = pruneLanes([], ['trae', 'doubao']);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.kept, ['trae', 'doubao']);
});

t('全砍光时照原样返回，绝不返回空数组', () => {
  const rows = [
    { agent: 'trae', ok: false, elapsedMs: 30000 },
    { agent: 'trae', ok: false, elapsedMs: 31000 },
    { agent: 'doubao', ok: false, elapsedMs: 30000 },
    { agent: 'doubao', ok: false, elapsedMs: 30000 },
  ];
  const r = pruneLanes(rows, ['trae', 'doubao']);
  assert.equal(r.dropped.length, 2);
  assert.deepEqual(r.kept, ['trae', 'doubao']);
});

t('按通道给不同首字节阈值：codebuddy 45s、GUI 15s', () => {
  assert.equal(ttfbFor('codebuddy'), 45000);
  assert.equal(ttfbFor('trae'), 15000);
  assert.equal(ttfbFor('未知通道'), TTFB_MS);
  assert.equal(ttfbFor('trae', 8000), 8000, '显式覆盖优先');
});

console.log('\n' + pass + ' passed / ' + fail + ' failed');
if (fail) process.exitCode = 1;