// test/apispec.test.mjs —— 证明契约校验器真的能拦住错，而不只是能跑通对。
// 用今晚真实产出的 todo 零件当样本（不是我编的假文件）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApiSpec, parseExports, formatApiSpec } from '../lib/apispec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 样本是仓内 fixture：2026-11-17 CI 实测，原先写死 D:\\ai work replace\\TDW place\\... 绝对路径，
// Windows 上恰好存在所以一直是绿的，Linux 上直接 ENOENT。
const M = path.join(HERE, '..', 'fixtures', 'apispec', 'lib', 'todo', 'model.mjs');
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('1) 解析真实产物');
const { list } = parseExports(await import('node:fs').then(m => m.readFileSync(M, 'utf8')));
console.log('   解析到导出：' + list.map(e => e.name + '(' + (e.params || []).join(',') + ')').join('  '));
t('parseExports 抓到 loadTasks 与 saveTasks', list.length >= 2);

console.log('2) 正确的契约应该通过');
const good = { exports: [
  { name: 'loadTasks', params: ['filePath'] },
  { name: 'saveTasks', params: ['filePath', 'list'] },
] };
const r1 = checkApiSpec(M, good);
t('ok=true', r1.ok === true, formatApiSpec(r1));

console.log('3) 参数名写错必须被抓到（这是"拼得上但语义反了"的典型来源）');
const badName = { exports: [
  { name: 'loadTasks', params: ['path'] },
  { name: 'saveTasks', params: ['filePath', 'list'] },
] };
const r2 = checkApiSpec(M, badName);
t('ok=false', r2.ok === false);
t('指出第 1 个参数就错', r2.arity[0] && r2.arity[0].firstDiff === 0, formatApiSpec(r2));

console.log('4) 参数个数不对必须被抓到');
const badArity = { exports: [
  { name: 'loadTasks', params: ['filePath', 'extra'] },
] };
const r3 = checkApiSpec(M, badArity);
t('ok=false 且 arity 有记录', r3.ok === false && r3.arity.length === 1, formatApiSpec(r3));

console.log('5) 缺导出必须被抓到');
const missing = { exports: [{ name: 'nopeTask', params: [] }] };
const r4 = checkApiSpec(M, missing);
t('ok=false 且 missing 列出 nopeTask', r4.ok === false && r4.missing.includes('nopeTask'));

console.log('6) 文件不存在要明说，不能当成通过');
const r5 = checkApiSpec(M.replace('model.mjs', 'nofile.mjs'), good);
t('ok=false 且 notes 说明', r5.ok === false && r5.notes.some(n => n.includes('不存在')));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
