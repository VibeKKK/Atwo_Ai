// test/apispec_e2e.mjs —— 端到端：拿今晚真的 9 个产物当样本，先证「对的全过」，再埋 2 个错证「错的会被拦住」。
// 判据很硬：埋的错拦不住，这个模块就等于没写。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkApiSpec, formatApiSpec } from '../lib/apispec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 仓内 fixture（原来写死 D:/ai work replace/TDW place/todo-demo，CI 上 ENOENT）
const D = path.join(HERE, '..', 'fixtures', 'apispec');
const SPEC = {
  'lib/todo/model.mjs': [{ name: 'loadTasks', params: ['filePath'] }, { name: 'saveTasks', params: ['filePath', 'list'] }],
  'lib/todo/args.mjs':  [{ name: 'parseArgs', params: ['argv'] }],
  'lib/todo/render.mjs':[{ name: 'renderList', params: ['list'] }, { name: 'renderHelp', params: [] }],
  'lib/todo/io.mjs':    [{ name: 'toJson', params: ['list'] }, { name: 'fromJson', params: ['text'] },
                          { name: 'toCsv', params: ['list'] }, { name: 'fromCsv', params: ['text'] }],
};

console.log('=== 第一轮：真实产物的真实契约（应该全过）===');
let okCount = 0, total = 0;
for (const [rel, exports] of Object.entries(SPEC)) {
  total++;
  const r = checkApiSpec(path.join(D, rel), { exports });
  if (r.ok) okCount++;
  console.log((r.ok ? '  V ' : '  X ') + rel.padEnd(22) + formatApiSpec(r));
}
console.log('  -> ' + okCount + '/' + total + ' 通过');

console.log('');
console.log('=== 第二轮：埋 2 个错，看能不能拦住 ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apispec-e2e-'));

// 错 1：参数改名（名字对、签名错 —— 两边都能过 node --check，拼起来才炸）
const src1 = fs.readFileSync(path.join(D, 'lib/todo/model.mjs'), 'utf8')
  .replace('export function loadTasks(filePath)', 'export function loadTasks(p)');
fs.writeFileSync(path.join(tmp, 'bad1.mjs'), src1);
const r1 = checkApiSpec(path.join(tmp, 'bad1.mjs'), { exports: [{ name: 'loadTasks', params: ['filePath'] }] });
console.log((r1.ok ? '  X 没拦住！' : '  V 拦住') + '  错1 参数名 filePath->p：' + formatApiSpec(r1));

// 错 2：把 markdown 写进 .mjs（今晚真实事故：第三层把文档写进上一层的代码文件）
fs.writeFileSync(path.join(tmp, 'bad2.mjs'), ['# 这是文档', '', '## 二级标题', '', '正文若干', ''].join(String.fromCharCode(10)));
const r2 = checkApiSpec(path.join(tmp, 'bad2.mjs'), { exports: [{ name: 'loadTasks', params: ['filePath'] }] });
console.log((r2.ok ? '  X 没拦住！' : '  V 拦住') + '  错2 markdown 冒充 .mjs：' + formatApiSpec(r2));

// 对照：形状对、意图错的，契约拦不住 —— 要诚实记下来
const src3 = ['export function loadTasks(filePath) { return []; }', '// 但实际没读文件，永远返回空数组', ''].join(String.fromCharCode(10));
fs.writeFileSync(path.join(tmp, 'bad3.mjs'), src3);
const r3 = checkApiSpec(path.join(tmp, 'bad3.mjs'), { exports: [{ name: 'loadTasks', params: ['filePath'] }] });
console.log('  -  错3 形状对但逻辑错（永远返回空）：' + formatApiSpec(r3) + '   <- 这类契约拦不住，只能靠行为测试');

fs.rmSync(tmp, { recursive: true, force: true });

const caught = (!r1.ok ? 1 : 0) + (!r2.ok ? 1 : 0);
console.log('');
console.log('结论：埋 2 个形状级错误，拦住 ' + caught + '/2；埋 1 个意图级错误，拦不住（预期）');
process.exit(caught === 2 ? 0 : 1);