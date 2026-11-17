// 判定不许「猜错就当失败」：PRD 猜的目标不存在时，必须扫盘看看有没有真产物。
// 这条是 2026-11-17 那天 6 次误报的直接回归（board.mjs / runs.mjs / handoff.mjs 都真落盘却报 failed）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeOutcome, scanSince } from '../lib/outcome.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('ok ' + name); }
  else { fail += 1; console.log('FAIL ' + name); }
};

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-scan-'));
const write = (root, rel, text) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return abs;
};

// ① PRD 猜 lib/wanted.mjs，实际写在 lib/actual.mjs → 必须判 ok，并标明是扫出来的
{
  const root = mkdir();
  const since = Date.now() - 1000;
  write(root, 'lib/actual.mjs', 'export const x = 1;\n');
  const o = judgeOutcome({ srcText: '新建 lib/wanted.mjs 导出常量', sinceMs: since, cwd: root });
  ok(o.verdict === 'ok', '猜错目标但盘上有产物 → ok（实际 ' + o.verdict + '）');
  ok(o.landedVia === 'scan', '标明产物是扫盘找到的');
  ok(o.landed.some((l) => l.path === 'lib/actual.mjs'), 'landed 指向真实文件');
  ok(String(o.hint).includes('lib/wanted.mjs'), 'hint 里点名 PRD 猜的那个路径');
}

// ② 盘上真的什么都没有 → 仍然判 failed（不能变成永远成功）
{
  const root = mkdir();
  const o = judgeOutcome({ srcText: '新建 lib/wanted.mjs', sinceMs: Date.now() - 1000, cwd: root });
  ok(o.verdict === 'failed', '真没产物 → failed');
  ok(o.hint === '盘上没有产物', 'hint 保持原话');
  ok(!o.landedVia, '没有产物时不标 scan');
}

// ③ 老文件不算：早于 sinceMs 的文件不能被当成本轮产物
{
  const root = mkdir();
  const old = write(root, 'lib/old.mjs', 'export const y = 2;\n');
  const past = Date.now() - 600000;
  fs.utimesSync(old, new Date(past), new Date(past));
  const o = judgeOutcome({ srcText: '新建 lib/wanted.mjs', sinceMs: Date.now() - 1000, cwd: root });
  ok(o.verdict === 'failed', '只有旧文件时仍 failed（时间窗生效）');
}

// ④ 扫盘要跳过运行时目录：memory / .atw / node_modules / _probe 里新写的文件不算产物
{
  const root = mkdir();
  const since = Date.now() - 1000;
  write(root, 'memory/log.jsonl', '{"a":1}\n');
  write(root, '.atw/fanout/x/FANOUT.md', '# 不是产物\n');
  write(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  write(root, '_probe/patch.mjs', 'console.log(1);\n');
  const hits = scanSince(root, since, { minBytes: 8 });
  ok(hits.length === 0, '运行时目录里的新文件不算产物（实际 ' + hits.length + ' 个）');
}

// ⑤ 扫盘要能给出「最新的那个」排在最前
{
  const root = mkdir();
  const since = Date.now() - 5000;
  const a = write(root, 'lib/a.mjs', 'export const a = 1;\n');
  const b = write(root, 'lib/b.mjs', 'export const b = 2;\n');
  fs.utimesSync(a, new Date(Date.now() - 3000), new Date(Date.now() - 3000));
  fs.utimesSync(b, new Date(Date.now() - 1000), new Date(Date.now() - 1000));
  const hits = scanSince(root, since, { minBytes: 8 });
  ok(hits.length === 2 && hits[0].path === 'lib/b.mjs', '最新写入的排第一（实际 ' + hits.map((h) => h.path).join(',') + '）');
}

// ⑥ 扫到的产物语法坏 → partial 而不是 ok
{
  const root = mkdir();
  write(root, 'lib/broken.mjs', 'export const = ;\n');
  const o = judgeOutcome({ srcText: '新建 lib/wanted.mjs', sinceMs: Date.now() - 1000, cwd: root });
  ok(o.verdict === 'partial', '扫到的 JS 语法坏 → partial（实际 ' + o.verdict + '）');
  ok(o.landedVia === 'scan', '仍然标明 scan');
}

console.log('');
console.log((fail === 0 ? '全部通过' : '有失败') + '：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
