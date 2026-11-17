// detectTarget 必须遍历所有候选：任务文本里先提到的往往是数据文件（memory/log.jsonl），
// 真正要落的是后面那个交付物。2026-11-18 实测撞上：PRD 里写了 memory/log.jsonl，
// 结果把 8.5KB 的分析稿写成了 memory/log.js（.jsonl 被扩展名交替截成 .json 再落成 .js）。
import { detectTarget } from '../lib/land.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass += 1; console.log('ok ' + name); }
  else { fail += 1; console.log('FAIL ' + name + (extra ? '  ← ' + extra : '')); }
};

const cases = [
  ['数据文件在 memory/log.jsonl，交付 lib/a.mjs', 'lib/a.mjs'],
  ['只提到 memory/log.jsonl', ''],
  ['只提到 logs/nightwatch.log', ''],
  ['新建 lib/board.mjs', 'lib/board.mjs'],
  ['改 docs/research/x.md', 'docs/research/x.md'],
  ['第一个是 memory/pitfalls.jsonl，第二个是 lib/pitfalls.mjs', 'lib/pitfalls.mjs'],
];

for (const [text, exp] of cases) {
  const got = detectTarget(text, null);
  ok(got === exp, '[' + text + '] → ' + JSON.stringify(got), '期望 ' + JSON.stringify(exp));
}

// 数据文件绝不能被当成交付物：扩展名不许被截断成 .js
{
  const got = detectTarget('只有 memory/log.jsonl 这一个路径', null);
  ok(got === '' || !/\.js$/.test(got), '.jsonl 不会被截成 .js（实际 ' + JSON.stringify(got) + '）');
}

console.log('');
console.log((fail === 0 ? '全部通过' : '有失败') + '：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
