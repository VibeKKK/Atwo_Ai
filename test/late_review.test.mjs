import test from 'node:test';
import assert from 'node:assert/strict';
import { lateReviewNotice, LATE_REVIEW_CONTRACT } from '../lib/late-review.mjs';

test('没票时提示一句「进了 done 不等于验过」，且不拦', () => {
  const r = lateReviewNotice({ reviewState: 'unreviewed', queue: { items: [] } });
  assert.equal(r.contract, LATE_REVIEW_CONTRACT);
  assert.equal(r.unreviewed, true);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /没有第三方评审票/);
  assert.match(r.lines[0], /不等于验过/);
});

test('有票在路上时列出件数与前几件，并给看进度的命令', () => {
  const items = [
    { id: 'j1', kind: 'review', state: 'pending' },
    { id: 'j2', kind: 'fanout', state: 'running' },
    { id: 'j3', kind: 'army', state: 'pending' },
    { id: 'j4', kind: 'review', state: 'pending' },
    { id: 'j5', kind: 'gate', state: 'pending' }, // 不在 LATE_KINDS 里
  ];
  const r = lateReviewNotice({ reviewState: 'ACCEPT', queue: { items }, limit: 2 });
  assert.equal(r.pending.length, 4);
  assert.match(r.lines[0], /还有 4 件评审\/派活没跑完/);
  assert.match(r.lines[0], /等 4 件/);
  assert.match(r.lines[1], /atwo queue --json/);
  assert.deepEqual(r.pending.map((x) => x.id), ['j1', 'j2', 'j3', 'j4']);
});

test('票已到位、队列也空 → 一句都不打（不许每次收工都喊狼来了）', () => {
  const r = lateReviewNotice({ reviewState: 'ACCEPT', queue: { items: [] } });
  assert.deepEqual(r.lines, []);
  assert.equal(r.unreviewed, false);
});

test('queue 传坏数据也不许抛：收工提示不能反过来把收工搞挂', () => {
  assert.deepEqual(lateReviewNotice({}).lines, []);
  assert.deepEqual(lateReviewNotice({ reviewState: 'unreviewed', queue: null }).lines.length, 1);
  assert.deepEqual(lateReviewNotice({ reviewState: 'undecided', queue: { items: 'nope' } }).unreviewed, true);
});

test('atwo done 真接了这段（源码断言，防接线被回滚后测试还绿）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../atwo.mjs', import.meta.url), 'utf8');
  assert.match(src, /import { lateReviewNotice } from '\.\/lib\/late-review\.mjs';/);
  assert.match(src, /const late = lateReviewNotice\(\{/);
  assert.match(src, /queue: listQueue\(HERE\),/);
});
