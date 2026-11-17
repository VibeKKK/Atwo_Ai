import fs from 'node:fs';
import { loadTasks } from '../lib/batch.mjs';

const TARGET_RE = /((?:lib|docs|agents|eval|collab|memory|tools)\/[A-Za-z0-9_.\/-]+\.(?:mjs|cjs|js|md|json|txt|ya?ml))/;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + x); } };

const one = loadTasks('fixtures/tasks/par3.md');
ok('单个 md 任务 + 正文列表 → 只切出 1 段', one.length === 1, '切出 ' + one.length + ' 段');
ok('标题被拼回正文首行', /par_num\.mjs/.test(one[0].split('\n')[0]), JSON.stringify(one[0].split('\n')[0]));
ok('land 能从段里找到目标路径', (one[0].match(TARGET_RE) || [])[1] === 'lib/par_num.mjs', String((one[0].match(TARGET_RE) || [])[1]));
ok('正文里的硬要求还在', /120 到 180 行/.test(one[0]));

const multi = loadTasks('# 1 写 a\n正文A\n\n# 2 写 b\n正文B\n\n# 3 写 c\n正文C');
ok('三个 md 标题 → 3 段', multi.length === 3, '切出 ' + multi.length);
ok('段 2 带自己的标题', multi[1].startsWith('2 写 b'), JSON.stringify(multi[1].slice(0, 12)));

const legacy1 = loadTasks('甲|||乙');
ok('||| 老格式仍可用', legacy1.length === 2);
const legacy2 = loadTasks('任务一\n---\n任务二');
ok('--- 老格式仍可用', legacy2.length === 2);
const legacy3 = loadTasks('- 甲\n- 乙');
ok('列表行老格式仍可用', legacy3.length === 2);
const legacy4 = loadTasks('- 只有一行列表');
ok('单行列表不被当成多任务', legacy4.length === 1, JSON.stringify(legacy4));
const plain = loadTasks('一句话任务');
ok('纯行仍可用', plain.length === 1 && plain[0] === '一句话任务');

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
