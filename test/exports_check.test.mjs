// test/exports_check.test.mjs —— 闸门第 9 步：import 的名字必须真的被导出。
// 为什么单测它：2026-11-17 真实事故 —— HEAD 的 lib/outcome.mjs import 了 land.mjs 的
// selfLanded，而 selfLanded 只在某人的工作区里没提交。语法全对、文件全在、测试全绿（在我这边），
// 但 git clone 之后 atwo 起不来。closure 查文件存在性，查不出「名字不在」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportsOf, importsOf, findMissingExports, formatMissingExports, EXPORTS_CONTRACT } from '../lib/exports-check.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

function sandbox(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exports-'));
  for (const [rel, body] of Object.entries(layout)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

test('契约名固定', () => {
  assert.equal(EXPORTS_CONTRACT, 'atwo-exports-check/1');
});

test('exportsOf 认函数/类/常量/异步函数', () => {
  const { names } = exportsOf('export function a() {}\nexport class B {}\nexport const c = 1;\nexport async function d() {}\nexport let e = 2;\nexport var f = 3;\n');
  assert.deepEqual([...names].sort(), ['B', 'a', 'c', 'd', 'e', 'f']);
});

test('exportsOf 认带括号的重命名导出', () => {
  const { names } = exportsOf('const x = 1;\nexport { x as y, x };\n');
  assert.deepEqual([...names].sort(), ['x', 'y']);
});

test('exportsOf 认 default', () => {
  assert.ok(exportsOf('export default function () {}').names.has('default'));
});

test('exportsOf 遇 export-star 标 unknown', () => {
  const r = exportsOf("export * from './x.mjs';\n");
  assert.equal(r.unknown, true);
});

test('importsOf 只收本地 .mjs 具名导入', () => {
  const src = [
    "import { a, b } from './x.mjs';",
    "import fs from 'node:fs';",
    "import { c } from 'somepkg';",
    "import { d } from './y.js';",
    "import * as ns from './z.mjs';",
  ].join('\n');
  assert.deepEqual(importsOf(src), [{ from: './x.mjs', names: ['a', 'b'] }]);
});

test('importsOf 别名取原名', () => {
  assert.deepEqual(importsOf("import { foo as bar } from './a.mjs';"), [{ from: './a.mjs', names: ['foo'] }]);
});

test('缺导出被抓到', () => {
  const d = sandbox({
    'lib/a.mjs': 'export function foo() {}\n',
    'lib/b.mjs': "import { foo, bar } from './a.mjs';\nexport const z = 1;\n",
  });
  const p = findMissingExports(d);
  assert.equal(p.length, 1);
  assert.equal(p[0].file, 'lib/b.mjs');
  assert.equal(p[0].name, 'bar');
  assert.equal(p[0].reason, 'missing-export');
});

test('导出都在就不报', () => {
  const d = sandbox({
    'lib/a.mjs': 'export function foo() {}\nexport const bar = 1;\n',
    'lib/b.mjs': "import { foo, bar } from './a.mjs';\n",
  });
  assert.deepEqual(findMissingExports(d), []);
});

test('import 的文件不存在也算', () => {
  const d = sandbox({ 'lib/b.mjs': "import { x } from './nope.mjs';\n" });
  const p = findMissingExports(d);
  assert.equal(p.length, 1);
  assert.equal(p[0].reason, 'missing-file');
});

test('目标文件有 export-star 时不判（静态无法确定）', () => {
  const d = sandbox({
    'lib/a.mjs': "export * from './impl.mjs';\n",
    'lib/b.mjs': "import { anything } from './a.mjs';\n",
  });
  assert.deepEqual(findMissingExports(d), []);
});

test('上层目录的相对路径也能解析', () => {
  const d = sandbox({
    'lib/a.mjs': 'export const v = 1;\n',
    'vm/c.mjs': "import { v } from '../lib/a.mjs';\n",
  });
  assert.deepEqual(findMissingExports(d), []);
});

test('atwo.mjs 与 orchestra.mjs 在扫描范围', () => {
  const d = sandbox({
    'lib/a.mjs': 'export const v = 1;\n',
    'atwo.mjs': "import { v } from './lib/a.mjs';\n",
    'orchestra.mjs': "import { missing } from './lib/a.mjs';\n",
  });
  const p = findMissingExports(d);
  assert.equal(p.length, 1);
  assert.equal(p[0].file, 'orchestra.mjs');
});

test('当前仓库导出与引用一致', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
  const p = findMissingExports(root);
  assert.deepEqual(p, [], '发现 ' + p.length + ' 处：' + formatMissingExports(p));
});

test('格式化文案点出文件行号与名字', () => {
  const s = formatMissingExports([{ file: 'lib/b.mjs', line: 3, from: './a.mjs', name: 'bar', reason: 'missing-export' }]);
  assert.ok(s.includes('lib/b.mjs:3'));
  assert.ok(s.includes('bar'));
  assert.equal(formatMissingExports([]), '导出与引用一致');
});

console.log('\n' + passed + ' passed / ' + failed + ' failed');
process.exit(failed ? 1 : 0);
