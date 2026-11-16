#!/usr/bin/env node
// accept <file> [--spec s.json] [--lines 120-180] [--exports a,b,c] [--sections 9] [--task task.md] [--behave cases.mjs] [--against other.mjs] [--json]
//
// 退出码是这条命令唯一的机器接口：0 = 通过，1 = 未通过，2 = 用法错误。
// 为什么不用「打印 PASS 就算过」—— shell 里没人读得懂输出，只认退出码。

import fs from 'node:fs';
import { accept, formatReport, parseLineRange } from '../index.mjs';

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
  console.log('用法：accept <file> [--spec s.json] [--lines 120-180] [--exports a,b,c] [--sections 9] [--task task.md] [--behave cases.mjs] [--against other.mjs] [--json]');
  process.exit(argv.length ? 0 : 2);
}

const file = argv[0];
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const opts = {};

const specPath = flag('--spec');
if (specPath) {
  try { opts.spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
  catch (e) { console.error('契书读不了：' + e.message); process.exit(2); }
}
const linesArg = flag('--lines');
if (linesArg) {
  const lr = parseLineRange(linesArg + ' 行') || (() => {
    const m = String(linesArg).match(/^(\d+)\s*[-–~]\s*(\d+)$/);
    return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
  })();
  if (!lr) { console.error('--lines 要写成 120-180'); process.exit(2); }
  opts.lines = lr;
}
const exArg = flag('--exports');
if (exArg) opts.exports = exArg.split(/[,\s]+/).filter(Boolean);
const secArg = flag('--sections');
if (secArg) opts.sections = Number(secArg);
const taskArg = flag('--task');
if (taskArg) { try { opts.taskText = fs.readFileSync(taskArg, 'utf8'); } catch { } }
const behaveArg = flag('--behave');
if (behaveArg) {
  if (!fs.existsSync(behaveArg)) { console.error('用例文件不存在：' + behaveArg); process.exit(2); }
  opts.behave = behaveArg;
const againstArg = flag('--against');
if (againstArg) {
  if (!fs.existsSync(againstArg)) { console.error('对拍目标不存在：' + againstArg); process.exit(2); }
  if (!behaveArg) { console.error('--against 要和 --behave 一起用：对拍得有一组用例'); process.exit(2); }
  opts.against = againstArg;
}
}

const r = accept(file, opts);
if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
else console.log(formatReport(r));
process.exit(r.verdict === 'PASS' ? 0 : 1);
