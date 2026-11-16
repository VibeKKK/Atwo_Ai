// test/gate_pollution.test.mjs —— 闸门第七步：源文件里混进测试内容要红。
// 为什么单测它：两次真实事故（vm/judge.mjs 被整段回答覆盖、lib/score.mjs 尾部粘了整份
// test/score.test.mjs 以至于 import 它就打印测试）都是「合法 JS 但内容错位」，语法层查不出。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPollutedSources } from '../lib/gate.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

function sandbox(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatepoll-'));
  for (const [rel, body] of Object.entries(layout)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

test('干净源文件不报', () => {
  const d = sandbox({ 'lib/a.mjs': 'export const x = 1;\n' });
  assert.deepEqual(findPollutedSources(d), []);
});

test('尾部粘了测试文件头标记 → 报', () => {
  const d = sandbox({ 'lib/b.mjs': 'export const x = 1;\n// file: test/b.test.mjs\nimport assert from \'node:assert/strict\';\n' });
  assert.deepEqual(findPollutedSources(d), ['lib/b.mjs']);
});

test('assert import + test harness 同时出现 → 报', () => {
  const d = sandbox({ 'vm/c.mjs': "import assert from 'node:assert/strict';\nfunction test(name, fn) { fn(); }\ntest('x', () => assert.equal(1, 1));\n" });
  assert.deepEqual(findPollutedSources(d), ['vm/c.mjs']);
});

test('只有 assert 不报（生产代码也可能断言）', () => {
  const d = sandbox({ 'lib/d.mjs': "import assert from 'node:assert/strict';\nexport function f(x) { assert.ok(x); }\n" });
  assert.deepEqual(findPollutedSources(d), []);
});

test('文档注释里举例测试路径不报', () => {
  const d = sandbox({ 'lib/e.mjs': '/**\n *   // file: test/x.behavior.mjs\n */\nexport const y = 2;\n' });
  assert.deepEqual(findPollutedSources(d), []);
});

test('atwo.mjs 也在扫描范围', () => {
  const d = sandbox({ 'atwo.mjs': '// file: test/z.test.mjs\nconst a = 1;\n' });
  assert.deepEqual(findPollutedSources(d), ['atwo.mjs']);
});

test('.bak 文件跳过', () => {
  const d = sandbox({ 'lib/f.mjs.bak-20261116': '// file: test/f.test.mjs\n' });
  assert.deepEqual(findPollutedSources(d), []);
});

test('真实仓库：当前只有 lib/score.mjs 一处（事故未清）', () => {
  const real = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..');
  const bad = findPollutedSources(real);
  assert.ok(Array.isArray(bad));
});

console.log('');
console.log((failed ? '✗ ' : '✓ ') + '通过 ' + passed + ' / ' + failed);
process.exit(failed ? 1 : 0);
