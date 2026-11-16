// 退出码语义（裂痕 1）：调用方只该看退出码判成败，不该读文案猜。
// 这一组钉住「成功 / 用法错 / 前置条件不满足」三种必须分得开。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const bad = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok  ' + name); }
  else { fail++; bad.push(name + (detail ? ' -> ' + detail : '')); console.log('  NG  ' + name + (detail ? ' -> ' + detail : '')); }
}
function run(args, env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'atwo.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ...(env || {}) },
  });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// 1) 成功 = 0
check('atwo --help 退出 0', run(['--help']).code === 0);
check('atwo raw stats 退出 0', run(['raw', 'stats']).code === 0);

// 2) 用法错 = 2
const unk = run(['nosuchverb']);
check('未知动词退出 2', unk.code === 2, '实际 ' + unk.code);
const badMode = run(['mode', 'not-a-mode']);
check('非法档位退出 2', badMode.code === 2, '实际 ' + badMode.code);

// 3) 前置条件不满足 = 3（用空任务目录造「没有正在做的任务」，不动真实 .atw/tasks）
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-empty-'));
const noTask = run(['go', '_probe/mode_s.md'], { ATWO_TASKS_DIR: empty });
check('没有在做任务时 go 退出 3', noTask.code === 3, '实际 ' + noTask.code);
fs.rmSync(empty, { recursive: true, force: true });

// 4) --json 模式下退出码同样成立（机器读路径）
const jsonUnk = run(['nosuchverb', '--json']);
check('--json 未知动词退出 2', jsonUnk.code === 2, '实际 ' + jsonUnk.code);
let jr = null;
try { jr = JSON.parse(jsonUnk.out.trim()); } catch { }
check('--json 未知动词 stdout 是合法 JSON', !!jr, (jsonUnk.out || '').slice(0, 80));
check('--json 里 exitCode 等于进程退出码', !!jr && jr.exitCode === jsonUnk.code, jr ? ('exitCode=' + jr.exitCode + ' proc=' + jsonUnk.code) : 'no json');

console.log('');
console.log('退出码：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) { console.log(bad.join(String.fromCharCode(10))); process.exit(1); }
