// 契约自身的格式校验：契约写错必须说「契约错」，不能抛异常、不能静默通过。
import { validateSpec, checkApiSpecSource, formatApiSpec, emitSpecSource } from '../lib/apispec.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
};

const src = 'export function loadTasks(filePath) { return []; }';
const notesOf = (s) => { try { return checkApiSpecSource(src, s, 'a.mjs').notes.join(' '); } catch (e) { return 'THROW ' + e.message; } };

ok('空对象：说没写 exports，不抛异常', /没写 exports/.test(notesOf({})));
ok('exports 是字符串：说必须是数组，不抛异常', /必须是数组/.test(notesOf({ exports: 'nope' })));
ok('exports 空数组：说等于没给契约', /空数组/.test(notesOf({ exports: [] })));
ok('name 不是字符串：指出位置', /exports\[0\]\.name/.test(notesOf({ exports: [{ name: 123 }] })));
ok('params 不是数组：指出位置', /params/.test(notesOf({ exports: [{ name: 'loadTasks', params: 'x' }] })));
ok('null 契约：说契约必须是对象', /必须是对象/.test(notesOf(null)));
ok('好契约通过', validateSpec({ exports: [{ name: 'f', params: ['a'] }] }).ok === true);
ok('无 params 允许但留痕', /签名未校验/.test(notesOf({ exports: [{ name: 'loadTasks' }] })));
ok('formatApiSpec 失败时带原因', /契约没写 exports/.test(formatApiSpec(checkApiSpecSource(src, {}, 'a.mjs'))));
ok('emit 标了 draft', emitSpecSource(src).draft === true);

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
