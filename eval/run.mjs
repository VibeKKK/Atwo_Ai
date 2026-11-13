// 评测 runner
// 用法：
//   node eval/run.mjs --selftest                 判据自检（0 token，先跑这个）
//   node eval/run.mjs --judge <file> [--task id] 判一段已保存的回答（0 token）
//   node eval/run.mjs --run --agent trae --limit 5   真派活（花钱/积分）
//   node eval/run.mjs --report                   看最近一次结果
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge, line } from './judge.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL = path.join(ROOT, 'eval');
const RESULTS = path.join(EVAL, 'results');
const TASKS = JSON.parse(fs.readFileSync(path.join(EVAL, 'tasks.json'), 'utf8')).tasks;

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

function now() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- 判据自检：拿「肯定过」和「肯定不过」的样本各判一遍，确认判据不是永远返回同一结果 ----
function selftest() {
  const good = {
    id: 'selftest-good', kind: 'code', lang: 'python',
    prompt: '',
    unit: "assert f(2)==4\nprint('UNIT-OK')",
    include: ['def f'],
  };
  const bad = { ...good, id: 'selftest-bad', include: ['def never_exists_zzz'] };

  const goodText = '```python\ndef f(x):\n    return x * 2\n```';
  const badText = '我不知道怎么写。';

  const cases = [
    ['好回答 → 应 PASS', judge(good, goodText), true],
    ['空回答 → 应 FAIL', judge(good, ''), false],
    ['缺函数 → 应 FAIL', judge(bad, goodText), false],
    ['非代码 → 应 FAIL', judge(good, badText), false],
    ['散文够长 → 应 PASS', judge({ id: 'p1', kind: 'prose', prompt: '', minChars: 10, include: ['关键'] }, '这是一段足够长的回答，里面有 关键 这个词。'), true],
    ['散文太短 → 应 FAIL', judge({ id: 'p2', kind: 'prose', prompt: '', minChars: 100 }, '太短'), false],
    ['JSON 齐字段 → 应 PASS', judge({ id: 'j1', kind: 'json', prompt: '', shape: { keys: ['a'] } }, '结论如下 {"a":1}'), true],
    ['JSON 缺字段 → 应 FAIL', judge({ id: 'j2', kind: 'json', prompt: '', shape: { keys: ['a', 'b'] } }, '{"a":1}'), false],
    ['禁含词命中 → 应 FAIL', judge({ id: 'f1', kind: 'prose', prompt: '', forbid: ['密码'] }, '请把密码发我'), false],
  ];

  let pass = 0;
  for (const [label, res, want] of cases) {
    const ok = res.pass === want;
    if (ok) pass++;
    console.log(`${ok ? '✓' : '✗'} ${label}  (judge=${res.pass ? 'PASS' : 'FAIL'})`);
    if (!ok) console.log('   ', JSON.stringify(res.checks));
  }
  console.log(`\n判据自检 ${pass}/${cases.length}`);
  return pass === cases.length;
}

// ---- 判一个已保存的回答文件 ----
function judgeFile(file, taskId) {
  const text = fs.readFileSync(file, 'utf8');
  const t = taskId ? TASKS.find(x => x.id === taskId) : null;
  const task = t || { id: path.basename(file), kind: 'prose', prompt: '', minChars: 1 };
  const res = judge(task, text);
  console.log(line(task.id, res));
  for (const c of res.checks) console.log(`   ${c.ok === 'skip' ? '·' : c.ok ? '✓' : '✗'} ${c.name}  ${c.detail}`);
  return res.pass;
}

// ---- 真跑：把 orchestra 当子进程调用（走真实 CLI 路径，不做模块级 import）----
// 为什么不用 import：orchestra.mjs 是纯脚本，顶层直接读 argv 并 process.exit，
// 一旦 import 就会执行 CLI。改成 spawn 既零侵入，又顺带验证了真实入口。
function askOnce(agent, prompt, timeoutMs) {
  return new Promise(resolve => {
    const args = agent === 'auto'
      ? [path.join(ROOT, 'orchestra.mjs'), 'ask', 'auto', prompt]
      : [path.join(ROOT, 'orchestra.mjs'), 'ask', agent, prompt];
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ORCH_NO_CONTRACT: '1', ORCH_NO_CACHE: '1', ORCH_QUIET_BUDGET: '1' },
      windowsHide: true,
    });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ text: out.trim(), err: code === 0 ? null : (err.trim().split('\n').pop() || `exit ${code}`) });
    });
    child.on('error', e => { clearTimeout(timer); resolve({ text: '', err: String(e.message) }); });
  });
}

async function runLive() {
  // 2026-11-13：默认改成 codebuddy。实测同一批 8 题 codebuddy 8/8，
  // trae 最好 6/8 且会抖到 2/8（见 agents/trae.mjs 里的竞态注释）。
  // 要评 trae 必须显式 --agent trae，避免把两家的数据混在一起比。
  const agent = val('--agent') || 'codebuddy';
  const limit = Number(val('--limit') || 0) || TASKS.length;
  const only = val('--only');
  const timeoutMs = Number(val('--timeout') || process.env.EVAL_TIMEOUT_MS || 300000);
  const list = TASKS.filter(t => !only || t.id === only).slice(0, limit);

  const rows = [];
  const t0 = Date.now();
  for (const t of list) {
    process.stdout.write(`… ${t.id} `);
    const s = Date.now();
    const { text, err } = await askOnce(agent, t.prompt, timeoutMs);
    const ms = Date.now() - s;
    const res = err ? { pass: false, checks: [{ name: '派活', ok: false, detail: err }] }
      : judge(t, text);
    rows.push({ id: t.id, agent, pass: res.pass, ms, err, checks: res.checks, chars: text.length, text: text.slice(0, 2000) });
    console.log(res.pass ? '✓' : '✗' + (err ? ' ' + err.slice(0, 80) : ''));
  }

  const pass = rows.filter(r => r.pass).length;
  const real = rows.filter(r => r.agent !== 'auto');
  const out = {
    ts: now(), agent, total: rows.length, pass,
    rate: rows.length ? +(pass / rows.length * 100).toFixed(1) : 0,
    durationMs: Date.now() - t0,
    avgMs: rows.length ? Math.round(rows.reduce((a, b) => a + b.ms, 0) / rows.length) : 0,
    rows,
  };
  if (!fs.existsSync(RESULTS)) fs.mkdirSync(RESULTS, { recursive: true });
  const f = path.join(RESULTS, `${out.ts}-${agent}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n${agent}: ${pass}/${rows.length} = ${out.rate}%   均 ${out.avgMs}ms`);
  console.log(`结果 → ${path.relative(ROOT, f)}`);
}

function report() {
  if (!fs.existsSync(RESULTS)) { console.log('还没有评测结果。先跑 node eval/run.mjs --run --agent trae --limit 5'); return; }
  const files = fs.readdirSync(RESULTS).filter(f => f.endsWith('.json')).sort();
  const latest = {};
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8'));
    latest[d.agent] = d;   // 只留该 agent 最新一次
  }
  console.log('agent      时间            通过率   均耗时   样本');
  for (const [agent, d] of Object.entries(latest)) {
    console.log(`${agent.padEnd(10)} ${d.ts.padEnd(15)} ${String(d.rate + '%').padEnd(8)} ${String(d.avgMs + 'ms').padEnd(8)} ${d.pass}/${d.total}`);
  }
  const fails = Object.entries(latest).flatMap(([a, d]) => d.rows.filter(r => !r.pass).map(r => `${a}  ${r.id}  ${(r.checks.find(c => c.ok === false) || {}).detail || r.err || ''}`));
  if (fails.length) {
    console.log('\n失败明细（前 12 条）：');
    for (const f of fails.slice(0, 12)) console.log('  ' + f);
  }
}

// ---- 入口 ----
if (has('--selftest')) {
  process.exit(selftest() ? 0 : 1);
} else if (has('--judge')) {
  process.exit(judgeFile(val('--judge'), val('--task')) ? 0 : 1);
} else if (has('--run')) {
  await runLive();
} else if (has('--report')) {
  report();
} else {
  console.log(`评测（${TASKS.length} 个固定任务）

  node eval/run.mjs --selftest              判据自检，0 token，改判据后必跑
  node eval/run.mjs --judge <file> [--task]  判一段已保存的回答，0 token
  node eval/run.mjs --run --agent <a> --limit N   真派活（花 token/积分）
  node eval/run.mjs --report                各 agent 最新通过率

判据来自 task 定义：编译、必含/禁含正则、最小长度、JSON 字段、python 行为测试。`);
}
