// 交接单的验收：它存在的意义是让「够不够格」由机器判，而不是由单写得漂不漂亮决定。
// 所以这里测的全是判据与稳定性，不测文案风格。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHandoff, handoffFromRun, makeHandoff, renderHandoff } from '../lib/handoff.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('ok ' + name); }
  else { fail += 1; console.log('FAIL ' + name); }
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'lib', 'handoff.mjs'), 'utf8');

// ① 纯函数：零依赖、零时间源（这两条一破，单据就无法重放比对）
ok(!/^\s*import\s/m.test(SRC), '模块里没有任何 import');
ok(!SRC.includes('Date.now'), '模块自身不调 Date.now');
ok(!SRC.includes('Math.random'), '不引入随机');
ok(!SRC.includes('process.env'), '不读环境变量');

// ② 归一化：混写、去重、空值
{
  const h = makeHandoff({ task: '  改 fmtSec  ', files: ['a.mjs', { path: 'b.mjs', change: ' add' }, 'a.mjs', '', null], now: '2026-11-17T00:00:00.000Z' });
  ok(h.task === '改 fmtSec', 'task 去空白');
  ok(h.files.length === 2, '同名文件只留第一条（实际 ' + h.files.length + '）');
  ok(h.files[0].path === 'a.mjs' && h.files[0].change === '', '字符串项归一成 {path, change:空}');
  ok(h.files[1].change === 'add', '对象项的 change 保留');
  ok(h.time === '2026-11-17T00:00:00.000Z', 'time 只认入参');
  ok(!JSON.stringify(h).includes('undefined'), '归一化后不出现 undefined');
}

// ③ 渲染：三节顺序、占位、空破折号
{
  const text = renderHandoff(makeHandoff({ task: '', files: [], why: '', verify: '' }));
  ok(text.includes('> 交接单：（未命名任务）'), '没有任务名时有占位');
  ok(text.indexOf('## 改了什么') < text.indexOf('## 为什么') && text.indexOf('## 为什么') < text.indexOf('## 怎么验'), '三节顺序固定');
  ok(text.includes('（没有文件变更）'), '无文件时有明确说明');
  ok(text.includes('（未填）'), '空节有占位而不是空白');
  ok(!text.includes(' —— '), '没有空破折号');
  const one = renderHandoff(makeHandoff({ task: 'x', files: ['a.mjs'] }));
  ok(one.includes('- a.mjs') && !one.includes('- a.mjs ——'), '只有路径时不带破折号');
}

// ④ 纯函数：同入参两次结果逐字节相同
{
  const a = renderHandoff(makeHandoff({ task: 't', files: ['a.mjs'], why: 'w', verify: 'v' }));
  const b = renderHandoff(makeHandoff({ task: 't', files: ['a.mjs'], why: 'w', verify: 'v' }));
  ok(a === b, '两次渲染逐字节相同');
  ok(JSON.stringify(makeHandoff({ task: 't', files: ['a.mjs'] })) === JSON.stringify(makeHandoff({ task: 't', files: ['a.mjs'] })), '两次构造深相等');
}

// ⑤ 判据：三个机器码、顺序固定、no-task 不拦
{
  const empty = checkHandoff(makeHandoff({}));
  ok(empty.ok === false, '空单不合格');
  ok(empty.problems.join(',') === 'no-task,no-files,no-verify', '机器码顺序固定（实际 ' + empty.problems.join(',') + '）');
  const onlyTask = checkHandoff(makeHandoff({ task: 't' }));
  ok(onlyTask.problems.join(',') === 'no-files,no-verify', '有任务名时不报 no-task');
  const noTask = checkHandoff(makeHandoff({ files: ['a.mjs'], verify: 'v' }));
  ok(noTask.ok === true, 'no-task 只提示不拦');
  ok(noTask.problems.join(',') === 'no-task', 'no-task 仍然出现在 problems 里');
  ok(checkHandoff(makeHandoff({ task: 't', files: ['a.mjs'], verify: '跑测试' })).ok === true, '有文件有验法就合格');
}

// ⑥ 从派活产物反推：只认 EVIDENCE 里的路径、去重、summary 进「怎么验」
{
  const h = handoffFromRun({
    task: 't',
    children: [
      { lane: 'codebuddy', chunkLabel: 'chunk-1/2', evidence: 'EVIDENCE: lib/a.mjs:3 常量已加；另见 lib/a.mjs:9' },
      { lane: 'deepseek', chunkLabel: 'chunk-2/2', evidence: 'EVIDENCE: lib/b.mjs:1 导出改名' },
    ],
    summary: 'REVISE（1 过 / 1 重做 / 0 没票）',
    now: '2026-11-17T00:00:00.000Z',
  });
  ok(h.files.map((f) => f.path).join(',') === 'lib/a.mjs,lib/b.mjs', '路径去重且保序（实际 ' + h.files.map((f) => f.path).join(',') + '）');
  ok(h.verify.includes('1 过 / 1 重做 / 0 没票'), 'summary 原样进「怎么验」');
  ok(h.by.includes('chunk-1/2 / codebuddy'), '交付人写了片号与通道');
  ok(checkHandoff(h).ok === true, '反推出的单合格');
  const none = handoffFromRun({ task: '', children: [], summary: '' });
  ok(checkHandoff(none).ok === false, '没有产物时单不合格（会被下游拦）');
}

console.log('');
console.log((fail === 0 ? '全部通过' : '有失败') + '：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
