// test/blindspots.test.mjs —— 盲区记忆。
// 每个场景对应一个真实问题：如果这条坏了，评审结果就白存了。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractIssues, classify, record, recall, renderBlock } from '../lib/blindspots.mjs';

let pass = 0, fail = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blindspots-'));
const F = path.join(tmp, 'b.json');

async function it(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + ' :: ' + e.message); }
}

const REV = [
  '**1. 循环上界 <= 导致越界**',
  '- 在哪：第 5 行',
  '- 怎么改：改成 i < len',
  '**2. null < 60 恒为真，缺考被算不及格**',
  '**3. sum += s 遇字符串污染**',
  'VERDICT: REVISE',
].join('\n');

await it('空账本 recall 返回空数组', () => {
  assert.deepStrictEqual(recall('trae', { file: F }), []);
});

await it('空账本 renderBlock 返回空串（调用方可无条件拼接）', () => {
  assert.strictEqual(renderBlock('trae', { file: F }), '');
});

await it('子项「在哪 / 怎么改」不算独立问题', () => {
  const r = extractIssues(REV);
  assert.strictEqual(r.length, 3, '应只有 3 条真问题，实际 ' + r.length);
  assert.ok(!r.some((x) => /在哪|怎么改/.test(x.text)));
});

await it('三类问题各归各位', () => {
  const cats = extractIssues(REV).map((x) => x.category);
  assert.deepStrictEqual(cats, ['boundary', 'null', 'type']);
});

await it('classify 取第一个命中的类别，不重复计', () => {
  const c = classify('循环上界越界同时 null 空值');
  assert.strictEqual(c.id, 'boundary');
});

await it('record 后 recall 能取回，按次数降序', () => {
  record({ agent: 'trae', reviewText: REV, file: F }, { file: F });
  record({ agent: 'trae', reviewText: '**1. 又一次越界**', file: F }, { file: F });
  const r = recall('trae', { file: F });
  assert.strictEqual(r[0].id, 'boundary');
  assert.strictEqual(r[0].count, 2, '越界应累计 2 次');
});

await it('例子最多留 3 条，不无限囤积', () => {
  for (let i = 0; i < 6; i++) record({ agent: 'trae', reviewText: '**1. 越界 ' + i + '**', file: F }, { file: F });
  const r = recall('trae', { file: F });
  assert.ok(r[0].examples.length <= 3, '例子数 ' + r[0].examples.length);
});

await it('不污染其他通道的账本', () => {
  assert.deepStrictEqual(recall('workbuddy', { file: F }), []);
});

await it('renderBlock 带出类别名、次数和自查提示', () => {
  const b = renderBlock('trae', { file: F });
  assert.ok(b.includes('边界与越界'), '缺类别名');
  assert.ok(b.includes('被挑出'), '缺次数');
  assert.ok(b.includes('自查'), '缺自查提示');
  assert.ok(b.includes('不是任务要求'), '缺免责说明');
});

await it('lim(i)t 生效，最多 3 类', () => {
  const b = renderBlock('trae', { file: F, limit: 1 });
  assert.strictEqual((b.match(/^- /gm) || []).length, 1);
});

await it('落盘后能被新进程读回（不是内存幻觉）', () => {
  const raw = fs.readFileSync(F, 'utf8');
  const d = JSON.parse(raw);
  assert.ok(d.agents.trae.counts.boundary >= 2);
  assert.ok(d.updatedAt, '缺时间戳');
});

await it('「其他」类不记账（避免噪音撑爆账本）', () => {
  const G = path.join(tmp, 'g.json');
  record({ agent: 'x', reviewText: '**1. 这件事我觉得可以再想想**', file: G }, { file: G });
  assert.deepStrictEqual(recall('x', { file: G }), []);
});

await it('没有编号项时什么都不记（不瞎猜）', () => {
  const H = path.join(tmp, 'h.json');
  record({ agent: 'y', reviewText: '整体不错，通过。VERDICT: ACCEPT', file: H }, { file: H });
  assert.deepStrictEqual(recall('y', { file: H }), []);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
