/**
 * 切分侧的尺子（用户要求：任务分割与检查机制等价占比，各占一半）。
 *
 * 检查那一半早就有五层闸门、三值票决、凭证；这一半此前只有「报了片数」。
 * 这里的断言就是在钉：切分必须**可判**，而不是「点了 --split 就算切了」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_IMBALANCE, MIN_UNITS_PER_CHUNK,
  checkSplit, renderSplitLine, exitForSplit,
} from '../lib/split.mjs';

/** 造一份干净的切分计划：units 个单元、count 片、轮流分。 */
function makePlan(units, count) {
  const list = Array.from({ length: units }, (_, i) => ({ unit: 'lib/f' + (i + 1) + '.mjs', abs: '/x', exists: true }));
  const chunks = Array.from({ length: count }, (_, i) => ({ index: i, total: count, label: 'chunk-' + (i + 1) + '/' + count, units: [] }));
  list.forEach((u, i) => chunks[i % count].units.push(u));
  return { chunks, units: list, count, strategy: 'units', reason: 'ok' };
}

test('均衡合法的切分判 ok', () => {
  const r = checkSplit(makePlan(8, 4));
  assert.equal(r.verdict, 'ok');
  assert.equal(r.ok, true);
  assert.equal(r.count, 4);
  assert.equal(r.units, 8);
  assert.equal(r.load.ratio, 1);
  assert.equal(r.coverage, 1);
});

test('没单元 / 只切一片，都判 bad（一片等于没切）', () => {
  assert.equal(checkSplit({ chunks: [], units: [] }).verdict, 'bad');
  const one = makePlan(4, 1);
  const r = checkSplit(one);
  assert.equal(r.verdict, 'bad');
  assert.equal(r.items.find((i) => i.code === 'chunks>=2').ok, false);
});

test('单元重复落在两片 → 判 bad（两路会同改一个文件）', () => {
  const p = makePlan(6, 3);
  p.chunks[1].units.push(p.chunks[0].units[0]);
  const r = checkSplit(p);
  assert.equal(r.verdict, 'bad');
  const item = r.items.find((i) => i.code === 'mutually-exclusive');
  assert.equal(item.ok, false);
  assert.match(item.detail, /重复单元 1 个/);
});

test('单元漏掉 → 判 bad（漏掉的等于没人做）', () => {
  const p = makePlan(6, 3);
  p.chunks[2].units.pop();
  const r = checkSplit(p);
  assert.equal(r.verdict, 'bad');
  assert.equal(r.items.find((i) => i.code === 'complete').ok, false);
  assert.ok(r.coverage < 1, '覆盖度必须小于 1');
});

test('负载差 3 倍 → 判 bad（慢的那片会拖住整批）', () => {
  const units = Array.from({ length: 10 }, (_, i) => ({ unit: 'lib/g' + i + '.mjs' }));
  const p = {
    units,
    count: 2,
    chunks: [
      { index: 0, total: 2, label: 'c1', units: units.slice(0, 7) },
      { index: 1, total: 2, label: 'c2', units: units.slice(7) },
    ],
  };
  const r = checkSplit(p);
  assert.equal(r.verdict, 'bad');
  assert.ok(r.load.ratio > MAX_IMBALANCE);
});

test('密度不足只降级为 weak，不判死（单元本来就少不该被规则否掉）', () => {
  const p = makePlan(4, 2);
  const r = checkSplit(p, { minUnitsPerChunk: MIN_UNITS_PER_CHUNK + 1 });
  assert.equal(r.verdict, 'weak');
  assert.equal(r.items.find((i) => i.code === 'dense').ok, false);
  assert.equal(exitForSplit(r, { ok: 0, precondition: 3 }), 0, 'weak 要放行');
});

test('bad 时退出码是前置条件（不该开工）', () => {
  const r = checkSplit({ chunks: [], units: [] });
  assert.equal(exitForSplit(r, { ok: 0, precondition: 3 }), 3);
});

test('打印行：合格项打 ✓ 且带均衡倍数，不合格项打 ✗ 并说明原因', () => {
  const okLine = renderSplitLine(checkSplit(makePlan(8, 4)));
  assert.match(okLine, /^▶ 切分：4 片 · 8 个单元/);
  assert.match(okLine, /互斥 ✓/);
  assert.match(okLine, /无遗漏 ✓/);
  assert.match(okLine, /均衡 1\.00× ✓/);
  assert.doesNotMatch(okLine, /✗/);

  const bad = makePlan(6, 3);
  bad.chunks[1].units.push(bad.chunks[0].units[0]);
  const badLine = renderSplitLine(checkSplit(bad));
  assert.match(badLine, /互斥 ✗/);
});

test('单元太少而选择不切 → 判 skip 而不是 bad（不许被自己的闸门拒掉）', () => {
  const r = checkSplit({ chunks: [], units: [{ unit: 'lib/a.mjs' }, { unit: 'lib/b.mjs' }], reason: 'units<4' });
  assert.equal(r.verdict, 'skip');
  assert.equal(r.ok, true);
  assert.equal(exitForSplit(r, { ok: 0, precondition: 3 }), 0);
  assert.match(renderSplitLine(r), /不切/);
});

test('没有计划时打印行不崩', () => {
  assert.match(renderSplitLine(null), /没有切分计划/);
  assert.match(renderSplitLine({}), /没有切分计划/);
});
