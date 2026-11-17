// 降级模式的真跑断言：readOnly 必须是真不给写权限，而不是一句注释。
// 这条测试的由来：2026-11-17 23:54 真跑降级，report.md 只有标题没正文 ——
// 根因是 runPatch 把 opts.readOnly 传给了 handler 却没复制进 base，part 里根本没有它。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runPatch } from '../lib/writeback.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0; let fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✓ ' + name); },
    (e) => { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); },
  );
}

console.log('atwo patch · 降级（readOnly）真的不给写');

await test('runPatch 必须把 readOnly 复制进 part 的入参（源码断言）', () => {
  const src = fs.readFileSync(new URL('../lib/writeback.mjs', import.meta.url), 'utf8');
  assert.ok(/readOnly: !!opts\.readOnly/.test(src), 'base 里必须有 readOnly，否则 part 收不到');
});

await test('readOnly 真跑：交报告、不产出 patch、不判 no-change', async () => {
  const seen = [];
  const r = await runPatch({
    cwd: HERE,
    task: '只读探针：说清卡在哪',
    parts: 1,
    readOnly: true,
    maxTurns: 2,
    ask: async (prompt, o) => { seen.push(o); return { ok: true, text: '卡在 army-cli.mjs 的 EXIT.precondition 分支' }; },
  });
  const p = r.parts[0];
  assert.equal(p.ok, true);
  assert.ok(/卡在/.test(String(p.report)), 'report 要有正文：' + p.report);
  assert.equal(p.patchPath, null, '降级模式不许产出 patch');
  assert.equal(r.patchPaths.length, 0);
  assert.ok(!/Bash/.test(String(seen[0] && seen[0].tools)), '降级不给 Bash：' + (seen[0] && seen[0].tools));
  assert.ok(!/Write|Edit/.test(String(seen[0] && seen[0].tools)));
  assert.notEqual(seen[0] && seen[0].permissionMode, 'bypassPermissions');
});

await test('非降级不改文件 → 仍然判 no-change（别把降级语义串味了）', async () => {
  const r = await runPatch({
    cwd: HERE,
    task: '什么都不改',
    parts: 1,
    maxTurns: 2,
    ask: async () => ({ ok: true, text: '我没改' }),
  });
  assert.equal(r.ok, false);
  assert.ok(/no-change/.test(String(r.parts[0].reason)), r.parts[0].reason);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);