// atwo score 动词的行为测试：只看 CLI 输出与账本，不测内部函数（模块层已有 test/score.test.mjs）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendScore, scoreRecord } from '../lib/score.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATWO = path.join(HERE, 'atwo.mjs');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (extra ? ' —— ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-score-'));
const ledger = path.join(tmpDir, 'score.jsonl');

function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [ATWO, ...args], {
    cwd: HERE,
    env: { ...process.env, ATWO_SCORE: ledger, ...extraEnv },
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 1. 空账本：说人话、不许崩
{
  const r = run(['score']);
  ok('空账本 exit 0', r.code === 0, 'code=' + r.code);
  ok('空账本说清是空的', r.out.includes('还没有分数记录'), r.out.slice(-120));
  ok('空账本不报错', !/TypeError|ReferenceError/.test(r.out), r.out.slice(-200));
}

// 2. 有记录：出通过率与按天
{
  appendScore(ledger, scoreRecord({ task: 't1', assertion: 'a', ok: true, now: '2026-11-16T10:00:00.000Z' }));
  appendScore(ledger, scoreRecord({ task: 't1', assertion: 'b', ok: false, now: '2026-11-16T10:01:00.000Z' }));
  const r = run(['score']);
  ok('有记录 exit 0', r.code === 0, 'code=' + r.code);
  ok('报总数 2 条', r.out.includes('2 条断言'), r.out.slice(0, 160));
  ok('报通过 1/2', r.out.includes('通过 1 / 2'), r.out.slice(0, 200));
  ok('报通过率 0.500', r.out.includes('0.500'), r.out.slice(0, 200));
  ok('按天列出 2026-11-16', r.out.includes('2026-11-16'), r.out.slice(0, 240));
}

// 3. --json 是机器可读且字段齐
{
  const r = run(['score', '--json']);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* 下面断言会报 */ }
  ok('--json 可解析', !!j, r.out.slice(0, 160));
  ok('--json verb=score', j && j.verb === 'score', j && j.verb);
  ok('--json exitCode=0', j && j.exitCode === 0, j && String(j.exitCode));
  const s = j && j.data && j.data.score;
  ok('data.score 有 total/passed/rate', !!s && s.total === 2 && s.passed === 1 && Math.abs(s.rate - 0.5) < 1e-9, JSON.stringify(s && { total: s.total, passed: s.passed, rate: s.rate }));
  ok('data.score 有按天趋势', !!s && Array.isArray(s.trend) && s.trend.length === 1, s && JSON.stringify(s.trend));
  ok('--json 里人话不丢', !!(j && typeof j.log === 'string' && j.log.includes('通过')));
}

// 4. 不认识的开关 → 用法错 2（不许静默忽略）
{
  const r = run(['score', '--nope']);
  ok('未知开关 exit 2', r.code === 2, 'code=' + r.code);
  ok('未知开关有提示', /不认识|可用/.test(r.out), r.out.slice(0, 200));
}

// 5. 账本缺行/坏行不崩
{
  const bad = path.join(tmpDir, 'bad.jsonl');
  fs.writeFileSync(bad, 'not json\n{"kind":"score","time":"2026-11-16T10:00:00.000Z","task":"x","assertion":"a","ok":true}\n', 'utf8');
  const r = run(['score'], { ATWO_SCORE: bad });
  ok('坏行被跳过仍出结果', r.code === 0 && r.out.includes('1 条断言'), r.code + ' ' + r.out.slice(0, 160));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
console.log(pass + ' passed / ' + fails.length + ' failed');
if (fails.length) {
  for (const f of fails) console.log('  ! ' + f);
  process.exit(1);
}
