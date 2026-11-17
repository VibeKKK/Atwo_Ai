// 收工闸门的「成功路径」回归 —— 之前只测了拒绝路径，所以 dirRel 未声明这种崩法一直没被抓到。
// 两个自测开关（只在测试里用，不许进生产路径）：
//   ATWO_DONE_SKIP_REGRESSION=1  收工闸门不跑全量回归（否则回归里再测 done 会无限递归）
//   临时任务必须建在 .atw/tasks 下 —— task.py 拒绝操作该目录之外的路径
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TASKS = path.join(ROOT, '.atw', 'tasks');

let pass = 0;
let fail = 0;
const out = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; out.push(`  ✓ ${name}`); }
  else { fail += 1; out.push(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`); }
};

const taskDir = path.join(TASKS, '11-16-tmp-done-gate');
fs.rmSync(taskDir, { recursive: true, force: true });
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
  id: 'tmp-done-gate',
  title: '收工闸门成功路径自测（临时任务，用完即删）',
  status: 'implement',
  priority: 'P3',
  size: 'S',
  creator: 'self-test',
  assignee: 'self-test',
  createdAt: new Date().toISOString().slice(0, 10),
  createdAtMs: Date.now(),
  relatedFiles: [],
}, null, 2), 'utf8');
fs.writeFileSync(path.join(taskDir, 'prd.md'), '# 临时任务\n\n只用来验收工闸门的成功路径。\n', 'utf8');

const run = spawnSync(process.execPath, [
  'atwo.mjs', 'done', '--task', taskDir, '--yes', '--json',
], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, ATWO_DONE_SKIP_REGRESSION: '1' },
});

let parsed = null;
try { parsed = JSON.parse((run.stdout || '').trim()); } catch { parsed = null; }

ok('done 成功路径退出码 0', run.status === 0, `status=${run.status} stderr=${(run.stderr || '').slice(0, 300)}`);
ok('输出是合法 JSON', !!parsed, (run.stdout || '').slice(0, 200));
ok('JSON 里 exitCode=0', parsed && parsed.exitCode === 0, JSON.stringify(parsed && parsed.exitCode));
ok('verb 是 done', parsed && parsed.verb === 'done', JSON.stringify(parsed && parsed.verb));
ok('status 记为 completed', parsed && parsed.data && parsed.data.status === 'completed', JSON.stringify(parsed && parsed.data));
ok('不再抛 ReferenceError', !/ReferenceError/.test(run.stderr || ''), (run.stderr || '').slice(0, 200));
ok('评审票闸门不再报 votesMod', !/votesMod/.test((run.stdout || '') + (run.stderr || '')), '闸门里还引用了未定义变量');

let diskStatus = '';
try { diskStatus = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')).status; } catch { diskStatus = '(读不出)'; }
ok('task.json 落盘为 completed', diskStatus === 'completed', diskStatus);

// 第二条：done 的回归不该只是「跑 test/*.test.mjs」，而是 gate（闭包 + 语法 + 契约 + 测试）。
// 用 ATWO_GATE_NESTED=1 让 gate 里的全量测试跳过（否则递归），其余步骤真跑。
const taskDir2 = path.join(TASKS, '11-16-tmp-done-gate-g');
fs.rmSync(taskDir2, { recursive: true, force: true });
fs.mkdirSync(taskDir2, { recursive: true });
fs.writeFileSync(path.join(taskDir2, 'task.json'), JSON.stringify({
  id: 'tmp-done-gate-g',
  title: '收工闸门走 gate 自测（临时任务，用完即删）',
  status: 'implement',
  priority: 'P3',
  size: 'S',
  creator: 'self-test',
  assignee: 'self-test',
  createdAt: new Date().toISOString().slice(0, 10),
  createdAtMs: Date.now(),
  relatedFiles: [],
}, null, 2), 'utf8');

const run2 = spawnSync(process.execPath, ['atwo.mjs', 'done', '--task', taskDir2, '--yes'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, ATWO_GATE_NESTED: '1' },
});
const out2 = (run2.stdout || '') + (run2.stderr || '');
ok('done 的回归走 gate（不是只跑测试文件）', /回归闸门（gate）/.test(out2) && /九步全绿/.test(out2), out2.slice(0, 400));
ok('gate 全绿时 done 退出码 0', run2.status === 0, 'status=' + run2.status + ' ' + out2.slice(0, 400));
fs.rmSync(taskDir2, { recursive: true, force: true });
ok('第二个临时任务已清理', !fs.existsSync(taskDir2));

// 清理：这一条自己不干净的话会污染后续 state/list
fs.rmSync(taskDir, { recursive: true, force: true });
ok('临时任务已清理', !fs.existsSync(taskDir));

console.log(out.join('\n'));
console.log(`\n${fail === 0 ? 'done_gate: ' : 'done_gate FAILED: '}${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
