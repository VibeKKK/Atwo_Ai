// 坑账本（atwo pitfall）行为测试：只走 CLI，全部用临时账本，不碰 memory/pitfalls.jsonl
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATWO = path.join(HERE, '..', 'atwo.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-pf-'));
const LEDGER = path.join(TMP, 'pitfalls.jsonl');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; return; }
  fail += 1;
  console.log('✗ ' + name + (extra ? '  ' + extra : ''));
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [ATWO, ...args], {
    cwd: path.join(HERE, '..'),
    env: { ...process.env, ATWO_PITFALL: LEDGER, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 1) 空账本：list 不报错、明确说空
{
  const r = run(['pitfall']);
  check('空账本 exit 0', r.code === 0, 'code=' + r.code);
  check('空账本说明为空', r.out.includes('还没有坑记录'));
  check('空账本给用法', r.out.includes('atwo pitfall add'));
  check('空账本不抛 TypeError', !r.out.includes('TypeError'));
}

// 2) 记两条：带 trigger 与 fix
{
  const r1 = run(['pitfall', 'add', '补丁里引号嵌套会闭合字符串', '--trigger', '补丁', '--fix', '只用「」']);
  check('add#1 exit 0', r1.code === 0, 'code=' + r1.code);
  check('add#1 回执', r1.out.includes('已记一条坑'), r1.out.slice(0, 80));
  const r2 = run(['pitfall', 'add', 'CRLF 里行尾锚点静默失效', '--trigger', '锚点']);
  check('add#2 exit 0', r2.code === 0, 'code=' + r2.code);
}

// 3) list 能看到两条
{
  const r = run(['pitfall']);
  check('list 计数 2', r.out.includes('（2 条）'), r.out.slice(0, 60));
  check('list 有 trigger 补丁', r.out.includes('[补丁]'));
  check('list 有 trigger 锚点', r.out.includes('[锚点]'));
  check('list 显示修法', r.out.includes('只用「」'));
}

// 4) 不带 --trigger 时用现象前 24 字兜底
{
  const r = run(['pitfall', 'add', '没有触发短语时用现象兜底']);
  check('兜底 add exit 0', r.code === 0, 'code=' + r.code);
  const l = run(['pitfall']);
  check('兜底 trigger 生效', l.out.includes('[没有触发短语时用现象兜底]'), l.out.slice(0, 120));
}

// 5) 缺内容：退出 2 且给用法
{
  const r = run(['pitfall', 'add']);
  check('缺现象 exit 2', r.code === 2, 'code=' + r.code);
  check('缺现象给用法', r.out.includes('用法：atwo pitfall add'));
}

// 6) --json 结构
{
  const r = run(['pitfall', '--json']);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* 下面断言会红 */ }
  check('json 可解析', !!j, r.out.slice(0, 80));
  check('json verb', j && j.verb === 'pitfall');
  check('json exitCode 0', j && j.exitCode === 0);
  check('json data.pitfall.total 是数字', j && j.data && typeof j.data.pitfall.total === 'number');
  check('json triggers 是数组', j && Array.isArray(j.data.pitfall.triggers));
  check('json log 含中文', j && typeof j.log === 'string' && /[\u4e00-\u9fa5]/.test(j.log));
}

// 7) 派活前提示：PRD 文本命中 trigger 时，go --plan 要打 ⚠ 头号坑
{
  const prdDir = path.join(TMP, 'prd');
  fs.mkdirSync(prdDir, { recursive: true });
  const prd = path.join(prdDir, 'prd.md');
  fs.writeFileSync(prd, '# 探针\n要求：写一个补丁脚本改 lib/probe_pf.mjs\n', 'utf8');
  run(['mode', 'off']); // 干净 clone 里没有进行中的任务，strict 会让 go 退 3（前置不满足）
  const r = run(['go', prd, '--size', 'S', '--plan']);
  check('plan exit 0', r.code === 0, 'code=' + r.code);
  check('plan 提示头号坑', r.out.includes('头号坑'), r.out.slice(0, 120));
  check('plan 提示里带 trigger', r.out.includes('补丁'));
  // 没命中的 PRD 不应打头号坑
  const prd2 = path.join(prdDir, 'prd2.md');
  fs.writeFileSync(prd2, '# 无关任务\n要求：写 lib/probe_zz.mjs\n', 'utf8');
  const r2 = run(['go', prd2, '--size', 'S', '--plan']);
  run(['mode', 'strict']);
  check('未命中不打头号坑', !r2.out.includes('头号坑'), r2.out.slice(0, 120));
}

// 8) 没污染真实账本
{
  const real = path.join(HERE, '..', 'memory', 'pitfalls.jsonl');
  const existed = fs.existsSync(real);
  const size = existed ? fs.statSync(real).size : -1;
  check('临时账本存在', fs.existsSync(LEDGER));
  check('真实账本未被本测试写入', !existed || size === fs.statSync(real).size, existed ? 'size=' + size : 'absent');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(pass + ' passed / ' + fail + ' failed');
if (fail > 0) process.exit(1);
