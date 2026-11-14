// self.mjs —— 让 Orchestra 用自己养的 agent 改自己的代码（自举 / 自我改进）
//
// 流程（每一步都可停下、都可回滚）：
//   1) 开提案分支（pr.mjs start）
//   2) 把任务描述交给执行层 agent（默认 codebuddy，要机器判据的活用它）
//   3) 从回答里抽出「FILE: 路径」标记的完整文件
//   4) 只写项目内的、非 protected 的文件；其余一律拒绝
//   5) 跑全部回归（selftest / lockpool / batch_offline / ui_smoke / eval --selftest）
//   6) 全绿 → pr.mjs finish（提案成型，等人或 rank1 审阅后 approve）；有红 → 还原并 reject
//
// 用法：
//   node self.mjs "任务描述"                 # 干跑：只生成方案、打印将改的文件，不动盘
//   node self.mjs "任务描述" --apply         # 真写盘 + 跑测 + 开提案
//   node self.mjs "任务描述" --agent trae --apply
//   node self.mjs --list                     # 看历史自改记录
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const SELF_LOG = path.join(ROOT, 'memory', 'SELF.md');

// 不允许自改的文件：改了等于绕过审阅门或破坏可回滚性
const FORBIDDEN = [
  'pr.mjs', 'self.mjs', 'lib/vcs.mjs', 'lib/lock.mjs',
  'collab/authority.json', 'collab/SHARED.md', '.git/',
];

const TESTS = [
  ['selftest', ['test/selftest.mjs']],
  ['lockpool', ['test/lockpool.mjs']],
  ['batch_offline', ['test/batch_offline.mjs']],
  ['ui_smoke', ['test/ui_smoke.mjs']],
  ['eval_selftest', ['eval/run.mjs', '--selftest']],
];

function run(args, opts = {}) {
  const r = spawnSync(NODE, args, {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
    timeout: opts.timeout ?? 240000,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}

function say(s) { process.stdout.write(s + '\n'); }

function buildPrompt(task) {
  return [
    '你在改一个 Node.js 项目（零依赖，ESM）。目录：' + ROOT,
    '',
    '任务：' + task,
    '',
    '硬性要求：',
    '1. 只输出需要改动的**完整文件**，每个文件用一个 ``` 围栏包起来；',
    '2. 围栏的第一行必须是 `FILE: 相对路径`（例如 FILE: lib/syntax.mjs），不要写解释；',
    '3. 不要用第三方依赖，不要改 package.json 的 name/bin；',
    '4. 保持原有导出与函数签名兼容，除非任务要求改；',
    '5. 代码里不要写 TODO，要能直接跑。',
    '',
    '⚠ 不要先说计划和步骤，也不要问问题：能读文件就自己读（只读），读不到就按你理解的接口写，',
    '⚠ 但最终回答**必须**只包含文件围栏（可以有极简的说明在围栏之外）。',
    '⚠ 不要自己调用 Write/Edit 改文件——落盘由调用方统一做，你只负责给内容。',
  ].join('\n');
}

/** 从回答里抽 [{ file, content }] */
function extractFiles(text) {
  const ALLOWED = /\.(mjs|js|json|md|txt)$/i;
  const out = [];
  const seen = new Set();
  const push = (file, content) => {
    const f = String(file || '').trim().replace(/^["'`]|["'`]$/g, '').replace(/^\.\//, '').replace(/\\/g, '/');
    if (!f || !ALLOWED.test(f) || seen.has(f)) return;
    seen.add(f);
    out.push({ file: f, content: String(content || '').replace(/\r\n/g, '\n') });
  };
  const body = String(text || '');

  // 第一优先：围栏首行写 `FILE: path`（或 `// FILE: path` / `# FILE: path`）
  const fence = /```[a-zA-Z]*\r?\n([\s\S]*?)```/g;
  let m;
  const leftovers = [];
  while ((m = fence.exec(body)) !== null) {
    const inner = m[1];
    const lines = inner.split(/\r?\n/);
    const first = (lines[0] || '').trim();
    const hit = /^(?:\/\/|#|\/\*)?\s*FILE:\s*(.+?)\s*(?:\*\/)?$/i.exec(first);
    if (hit) { push(hit[1], lines.slice(1).join('\n')); continue; }
    // 第二优先：首行是「看着像路径」的注释，例如 `// test/store_history.mjs`
    const cmt = /^(?:\/\/|#|\/\*|<!--)\s*([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))\b/i.exec(first);
    if (cmt) { push(cmt[1], lines.slice(1).join('\n')); continue; }
    leftovers.push({ inner, start: m.index, lines });
  }

  // 第三优先：围栏前面最近一条「像路径」的标题行（`### test/x.mjs` / `**test/x.mjs**` / 裸路径行）
  for (const lf of leftovers) {
    const before = body.slice(Math.max(0, lf.start - 400), lf.start);
    const cands = [...before.matchAll(/([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))/gi)].map(x => x[1]);
    if (cands.length) { push(cands[cands.length - 1], lf.inner); continue; }
    // 第四优先：整段回答里只有这一个围栏 → 用文件名线索兜底
    const name = /(?:^|\n)\s*(?:创建|新增|改成|edit|add)\s*([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))/i.exec(body);
    if (name) push(name[1], lf.inner);
  }
  return out;
}

function safeTarget(rel) {
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep)) return '拒绝：路径跑出项目目录';
  for (const f of FORBIDDEN) {
    if (rel === f || rel.startsWith(f)) return '拒绝：' + f + ' 属于禁改清单';
  }
  if (!/\.(mjs|js|json|md)$/.test(rel)) return '拒绝：只允许改 .mjs/.js/.json/.md';
  return null;
}

function testsAll() {
  const rows = [];
  for (const [name, args] of TESTS) {
    const t0 = Date.now();
    const r = run(args, { timeout: 300000 });
    const ms = Date.now() - t0;
    const ok = r.code === 0;
    rows.push({ name, ok, ms, tail: r.out.trim().split('\n').slice(-2).join(' / ').slice(0, 160) });
    say('  ' + (ok ? 'PASS' : 'FAIL').padEnd(5) + name.padEnd(16) + String(ms).padStart(6) + 'ms  ' + (ok ? '' : r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 200)));
  }
  return rows;
}

function log(entry) {
  fs.mkdirSync(path.dirname(SELF_LOG), { recursive: true });
  const block = [
    '',
    '## ' + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' · ' + entry.task,
    '- agent: ' + entry.agent + ' · 结果: ' + entry.verdict,
    '- 文件: ' + (entry.files.length ? entry.files.join(', ') : '(无)'),
    '- 测试: ' + entry.tests.map(t => t.name + '=' + (t.ok ? 'ok' : 'FAIL')).join(' '),
    entry.note ? '- 备注: ' + entry.note : '',
  ].filter(Boolean).join('\n');
  fs.appendFileSync(SELF_LOG, block + '\n', 'utf8');
}

// ---------------- main ----------------
const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
  say('用法: node self.mjs "任务描述" [--agent codebuddy|trae] [--apply]');
  say('      node self.mjs --list');
  process.exit(argv.length ? 0 : 2);
}
if (argv[0] === '--list') {
  if (fs.existsSync(SELF_LOG)) say(fs.readFileSync(SELF_LOG, 'utf8').trim());
  else say('(还没有自改记录)');
  process.exit(0);
}

const apply = argv.includes('--apply');
const ai = argv.indexOf('--agent');
const agent = ai >= 0 ? argv[ai + 1] : 'codebuddy';
const task = argv.filter((a, i) => !a.startsWith('--') && (ai < 0 || i !== ai + 1)).join(' ').trim();
if (!task) { say('缺少任务描述'); process.exit(2); }

say('[1/6] 提案分支');
let prId = null;
const started = run(['pr.mjs', 'start', task.slice(0, 50)]);
if (started.code === 0) {
  const hit = /(PR-\d{8}-\d{3})/.exec(started.out);
  prId = hit ? hit[1] : null;
  say('  ' + (prId || '已开分支（未解析出提案号）'));
} else {
  say('  开分支失败：' + started.out.trim().split('\n').slice(-1)[0]);
  if (apply) process.exit(1);
}

say('[2/6] 交给 ' + agent + ' 出方案');
// 2026-11-14 两次踩坑后的定稿：
//   ① 完全关工具（CODEBUDDY_TOOLS=''）→ 模型只会念叨「我先去看一下项目」然后不给文件；
//   ② max-turns 硬编码 1 → 直接 "Max turns (1) exceeded"。
// 现在：放开只读工具 Read 让它自己核对 API，禁 Write/Edit（落盘由本脚本统一做，便于回滚）；
// 超时放到 660s（一次生成一整个测试文件在 240s 里做不完）。
const asked = run(['orchestra.mjs', 'ask', agent, buildPrompt(task)], {
  timeout: 660000,
  env: { CODEBUDDY_TOOLS: 'Read', CODEBUDDY_MAX_TURNS: '8', ORCH_TIMEOUT_MS: '660000' },
});
const answer = asked.stdout || asked.out;
if (!answer.trim()) { say('  没拿到回答'); process.exit(1); }

say('[3/6] 抽文件');
const files = extractFiles(answer);
if (!files.length) {
  say('  抽不出文件围栏 —— 原始回答已存 memory/self-answers/ 供排查');
  say('  回答前 300 字：' + JSON.stringify(answer.slice(0, 300)));
  try {
    const dir = path.join(ROOT, 'memory', 'self-answers');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, (prId || 'no-pr') + '.md');
    fs.writeFileSync(f, answer, 'utf8');
    say('  已存 ' + path.relative(ROOT, f) + '（' + answer.length + ' 字符）');
  } catch { }
  if (prId) run(['pr.mjs', 'reject', prId, '没有可应用的文件']);
  process.exit(1);
}
for (const f of files) {
  const bad = safeTarget(f.file);
  say('  ' + (bad ? '✗ ' : '✓ ') + f.file + (bad ? '  ' + bad : '  ' + f.content.length + ' 字符'));
}
const accepted = files.filter(f => !safeTarget(f.file));
if (!accepted.length) { say('  全部被拒，退出'); if (prId) run(['pr.mjs', 'reject', prId, '无可应用文件']); process.exit(1); }

if (!apply) {
  say('');
  say('干跑结束。加 --apply 才会写盘、跑测、开提案。');
  for (const f of accepted) say('--- ' + f.file + ' ---\n' + f.content.slice(0, 600) + (f.content.length > 600 ? '\n…(截断)' : ''));
  process.exit(0);
}

say('[4/6] 写盘');
const backups = [];
for (const f of accepted) {
  const abs = path.resolve(ROOT, f.file);
  if (fs.existsSync(abs)) backups.push([abs, fs.readFileSync(abs, 'utf8')]);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, f.content, 'utf8');
  say('  写入 ' + f.file);
}

say('[5/6] 回归');
const tests = testsAll();
const green = tests.every(t => t.ok);

say('[6/6] 收尾');
let verdict;
if (green) {
  const fin = run(['pr.mjs', 'finish'], { timeout: 120000 });
  verdict = fin.code === 0 ? '待审阅（提案成型）' : '测试绿但提案收尾失败';
  if (fin.code !== 0) say('  ' + fin.out.trim().split('\n').slice(-2).join(' | '));
  say('  ' + verdict + (prId ? ' · ' + prId : ''));
  say('  下一步（人来按）：node pr.mjs pending → node pr.mjs review ' + (prId || '<id>') + ' --by rank1 --note "……" → node pr.mjs approve ' + (prId || '<id>'));
} else {
  for (const [abs, text] of backups.reverse()) fs.writeFileSync(abs, text, 'utf8');
  for (const f of accepted) {
    const abs = path.resolve(ROOT, f.file);
    if (!backups.some(b => b[0] === abs)) { try { fs.unlinkSync(abs); } catch { } }
  }
  if (prId) run(['pr.mjs', 'reject', prId, '回归未通过，自动回滚']);
  verdict = '回归未通过 → 已回滚';
  say('  ' + verdict);
}

log({
  task, agent, verdict,
  files: accepted.map(f => f.file),
  tests,
  note: green ? '' : tests.filter(t => !t.ok).map(t => t.name + ': ' + t.tail).join(' ; '),
});
say('');
say('记录已写入 memory/SELF.md');
process.exit(green ? 0 : 1);
