// 这些用例不是编的，每一条都对应今天真实发生过的一次错交付。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accept, formatReport, validateSpec, parseExports, parseSignatures, parseLineRange } from '../index.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-test-'));
let pass = 0; let fail = 0;
const w = (name, txt) => { const p = path.join(dir, name); fs.writeFileSync(p, txt, 'utf8'); return p; };
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
}

console.log('— 场景 1：注释开头的两个星号被渲染层吃掉（真事故）');
{
  const src = '// 工具\n/\n * 把 n 限制在区间内\n */\nexport function clamp(n, lo, hi) { return Math.max(lo, Math.min(n, hi)); }\n';
  const r = accept(w('mangled.mjs', src));
  ok(r.verdict === 'FAIL', '判为未通过');
  ok(r.layers.syntax && r.layers.syntax.ok === false, '语法层拦下', JSON.stringify(r.layers.syntax));
}

console.log('— 场景 2：占位符还在（半成品冒充完成）');
{
  const r = accept(w('todo.mjs', 'export function f() {\n  // TODO: 实现\n}\n'));
  ok(r.verdict === 'FAIL', '判为未通过');
  ok(/未完成标记/.test(r.layers.shape.notes.join('')), '形状层指认占位符');
}

console.log('— 场景 3：任务要 120-180 行，交上来 20 行');
{
  const body = Array.from({ length: 18 }, (_, i) => '// 填充 ' + i).join('\n');
  const r = accept(w('short.mjs', 'export const x = 1;\n' + body + '\n'), { lines: { min: 120, max: 180 } });
  ok(r.verdict === 'FAIL', '判为未通过');
  ok(/行数越界/.test(r.layers.custom.notes.join('')), '要求层报出实际行数', JSON.stringify(r.layers.custom));
}

console.log('— 场景 4：接口契约参数名不符（下游会拼不上）');
{
  const src = 'export function loadTasks(p) { return []; }\n';
  const r = accept(w('sig.mjs', src), { spec: { exports: [{ name: 'loadTasks', params: ['filePath'] }] } });
  ok(r.verdict === 'FAIL', '判为未通过');
  ok(/参数名不符/.test(r.layers.contract.notes.join('')), '契约层指出第几个参数错了');
}

console.log('— 场景 5：全都对的产物');
{
  const src = '/**\n * 夹紧数值\n */\nexport function clamp(n, lo, hi) {\n  return Math.max(lo, Math.min(n, hi));\n}\n';
  const r = accept(w('good.mjs', src), { spec: { exports: [{ name: 'clamp', params: ['n', 'lo', 'hi'] }] }, lines: { min: 1, max: 50 } });
  ok(r.verdict === 'PASS', '判为通过', formatReport(r));
}

console.log('— 场景 6：空文件');
{
  const r = accept(w('empty.mjs', '   \n'));
  ok(r.verdict === 'FAIL', '判为未通过');
  ok(/空的/.test(r.layers.shape.notes.join('')), '形状层指认空文件');
}

console.log('— 场景 7：文件根本不存在');
{
  const r = accept(path.join(dir, 'nope.mjs'));
  ok(r.verdict === 'FAIL', '判为未通过');
  ok(/读不到文件/.test(r.layers.shape.notes.join('')), '不抛异常，报成人话');
}

console.log('— 场景 8：契约自己写错，要比坏产物先报出来');
{
  const bad = validateSpec({ exports: 'nope' });
  ok(bad.ok === false && /exports 数组/.test(bad.notes.join('')), '坏契约给人话，不抛 want.map');
  const bad2 = validateSpec({ exports: [{ name: 123 }] });
  ok(bad2.ok === false && /name 必须是非空字符串/.test(bad2.notes.join('')), '名字不是字符串也报出来');
  const r = accept(w('any.mjs', 'export const a = 1;\n'), { spec: { exports: 'nope' } });
  ok(r.verdict === 'FAIL' && /exports 数组/.test(r.layers.contract.notes.join('')), '验收时也不崩');
}

console.log('— 场景 9：文档类靠章节数验');
{
  const md = '# 标题\n\n## 一\n\n## 二\n';
  const r1 = accept(w('doc.md', md), { sections: 3 });
  ok(r1.verdict === 'FAIL', '章节不足判未通过');
  const r2 = accept(w('doc.md', md), { sections: 2 });
  ok(r2.verdict === 'PASS', '章节够判通过');
}

console.log('— 场景 10：解析器本身');
{
  ok(JSON.stringify(parseLineRange('写 120-180 行')) === '{"min":120,"max":180}', '解析行数区间');
  ok(parseLineRange('随便写点') === null, '没有行数要求返回 null');
  const ex = parseExports('export function a() {}\nexport const b = 1;\nexport class C {}\n');
  ok(ex.includes('a') && ex.includes('b') && ex.includes('C'), '静态扒出三种导出');
  const sig = parseSignatures('export function f(a, { b, c }, d = 1) {}');
  ok(JSON.stringify(sig.get('f')) === '["a","{ b, c }","d"]', '解构整体算一个参数', JSON.stringify(sig.get('f')));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
