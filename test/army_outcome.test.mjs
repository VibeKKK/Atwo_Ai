// test/army_outcome.test.mjs —— 三入口一份判据：army 的主力单元也走「产物优先」。
// 这一条防的是「通道超时但文件已经写好 → 被判失败 → 白重跑」那类假失败（今天真烧过 12 分钟）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runArmy } from '../lib/army-run.mjs';
import { judgeOutcome } from '../lib/outcome.mjs';

let pass = 0, fail = 0;
const cases = [];
function it(name, fn) { cases.push([name, fn]); }

it('主力超时但产物已落 → 单元判 ok，并标记 recovered', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'army-out-'));
  fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true });

  const res = await runArmy({
    task: 'PRD', cwd, units: ['lib/a.mjs', 'lib/b.mjs'], reviewers: 1, timeoutMs: 5000,
    ask: async (prompt) => {
      if (/你是侦察兵/.test(prompt)) return { ok: true, addedText: 'SKELETON:\n- lib/a.mjs:1 入口' };
      if (/你是评审/.test(prompt)) {
        const ids = [...prompt.matchAll(/### (unit-\d+)/g)].map((m) => m[1]);
        return { ok: true, addedText: JSON.stringify(ids.map((id) => ({ id, verdict: 'PASS', reason: '' }))) };
      }
      // 主力：把文件写盘，然后假装通道超时（ok:false + 空文本）
      const unit = (prompt.match(/\/\/ file: (\S+)/) || [])[1] || '';
      if (unit) fs.writeFileSync(path.join(cwd, unit), 'export const ok = true;\n');
      return { ok: false, addedText: '', err: 'timeout' };
    },
  });

  const units = res.artifacts || [];
  assert.equal(units.length, 2, '两个单元都要有结果');
  for (const u of units) {
    assert.equal(u.ok, true, '产物已在盘上，不许再判失败：' + u.id);
    assert.equal(u.recovered, true, '要标出这是靠产物救回来的：' + u.id);
    assert.equal(u.product && u.product.verdict !== 'failed', true, 'product 判定不能是 failed：' + u.id);
  }
});

it('主力超时且盘上什么都没有 → 仍然判失败（不许把没产物当成功）', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'army-out2-'));
  fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true });

  const res = await runArmy({
    task: 'PRD', cwd, units: ['lib/c.mjs', 'lib/d.mjs'], reviewers: 1, timeoutMs: 5000,
    ask: async (prompt) => {
      if (/你是侦察兵/.test(prompt)) return { ok: true, addedText: '' };
      if (/你是评审/.test(prompt)) {
        const ids = [...prompt.matchAll(/### (unit-\d+)/g)].map((m) => m[1]);
        return { ok: true, addedText: JSON.stringify(ids.map((id) => ({ id, verdict: 'REVISE', reason: '没产物' }))) };
      }
      return { ok: false, addedText: '', err: 'timeout' };
    },
  });

  const units = res.artifacts || [];
  assert.equal(units.length, 2);
  for (const u of units) {
    assert.equal(u.ok, false, '没产物就是失败：' + u.id);
    assert.ok(!u.recovered, '不许无中生有：' + u.id);
  }
});

it('judgeOutcome 与 army 用的是同一份判据（同一目录同一目标，结论一致）', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'army-out3-'));
  fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'lib', 'z.mjs'), 'export const z = 1;\n');
  const o = judgeOutcome({ srcText: '交付 lib/z.mjs', sinceMs: Date.now() - 60000, cwd });
  assert.equal(o.verdict, 'ok');
  assert.equal(o.landed[0].path, 'lib/z.mjs');
});

for (const [name, fn] of cases) {
  try { await fn(); console.log('  ok  ' + name); pass += 1; }
  catch (e) { console.log('  FAIL ' + name + ' :: ' + (e && e.message)); fail += 1; }
}
console.log(`\narmy_outcome.test.mjs: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
