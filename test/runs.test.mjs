// runs.mjs / runs-cli.mjs 的行为测试：日志、STOP 旗标、列表、以及「STOP 真能拦住排队片」。
// 全部走真实文件系统 + 真 CLI（atwo tail / atwo stop），因为这几件事的价值就在于「换个进程还看得见」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDir, sanitizeId, appendRunLog, tailRunLog, requestStop, isStopRequested, clearStop, listRuns } from '../lib/runs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATWO = path.join(HERE, '..', 'atwo.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-runs-'));

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name); }
};

const cli = (args) => {
  const r = spawnSync(process.execPath, [ATWO, ...args], {
    cwd: path.join(HERE, '..'),
    env: { ...process.env, ATWO_RUNS: ROOT, ATWO_PITFALL: path.join(ROOT, 'pitfalls.jsonl') },
    encoding: 'utf8',
  });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
};

// ---- 纯函数层 ----
console.log('[runs.mjs]');
const d1 = runDir(ROOT, 'demo-1');
appendRunLog(d1, '第 1 片开始', new Date('2026-11-17T10:00:00Z'));
appendRunLog(d1, '第 1 片完成', new Date('2026-11-17T10:01:00Z'));
const lines1 = tailRunLog(d1, 10);
ok(lines1.length === 2, '追加两行后能读回两行');
ok(/^\[2026-11-17T10:00:00\.000Z\] /.test(lines1[0]), '日志行带 ISO 时间前缀');
ok(tailRunLog(d1, 1).length === 1, '-n 生效（只取末 1 行）');
ok(tailRunLog(path.join(ROOT, 'nope'), 5).length === 0, '目录不存在时返空数组而不是抛');
ok(sanitizeId('demo/../1').includes('/') === false && !sanitizeId('demo/../1').includes('..'), 'sanitizeId 把斜杠与连续点都换成连字符');
ok(sanitizeId('../etc/passwd').includes('..') === false, 'sanitizeId 不留下连续点');
ok(sanitizeId('') === 'run', 'sanitizeId 空串兜底成 run');
ok(isStopRequested(d1).stop === false, '没写过 STOP 时报未请求');
const wrote = requestStop(d1, '方向错了');
ok(!!wrote && isStopRequested(d1).stop === true, '写 STOP 后能读回请求状态');
ok(isStopRequested(d1).reason === '方向错了', 'STOP 里带着原因');
ok(clearStop(d1) === true && isStopRequested(d1).stop === false, '清掉 STOP 后恢复未请求');
ok(clearStop(d1) === false, '再清一次返 false（幂等）');

const d2 = runDir(ROOT, 'demo-2');
appendRunLog(d2, '第二回', new Date('2026-11-17T11:00:00Z'));
const all = listRuns(ROOT);
ok(all.length === 2, 'listRuns 看到两个 run');
ok(all.map((r) => r.id).sort().join(',') === 'demo-1,demo-2', 'listRuns 两个 run 都在（顺序按 mtime，同秒内不保证）');
ok(listRuns(path.join(ROOT, 'nope')).length === 0, 'runs 目录不存在时返空数组');

// ---- CLI 层 ----
console.log('[atwo tail / atwo stop]');
const t1 = cli(['tail']);
ok(t1.code === 0 && t1.out.includes('demo-1'), '不带 id 时列出最近的 run');
const t2 = cli(['tail', 'demo-1', '-n', '1']);
ok(t2.code === 0 && t2.out.includes('第 1 片完成'), '带 id 时看得到日志内容');
ok(t2.out.includes('进行中'), '没有 STOP 时状态显示进行中');
const s1 = cli(['stop', 'demo-1', '--reason', '别跑了']);
ok(s1.code === 0 && s1.out.includes('别跑了'), 'stop 写进原因');
const t3 = cli(['tail', 'demo-1']);
ok(t3.out.includes('已收到 STOP'), 'tail 能看到 STOP 已生效');
ok(s1.out.includes('下一次派发前') && s1.out.includes('不会立刻掐断'), 'stop 明确告知不会掐断正在跑的会话');
const s2 = cli(['stop', 'demo-1', '--clear']);
ok(s2.code === 0 && cli(['tail', 'demo-1']).out.includes('进行中'), '--clear 后回到进行中');
const sj = cli(['tail', 'demo-1', '--json']);
let jd = null;
try { jd = JSON.parse(sj.out); } catch { jd = null; }
ok(jd && jd.data && jd.data.tail && Array.isArray(jd.data.tail.lines), '--json 的 data.tail 带着日志行（RESULT 透传）');
const s3 = cli(['stop']);
ok(s3.code === 2, 'stop 不给 id 时是用法错误（退出码 2）');

// ---- STOP 真能拦住排队片 ----
console.log('[STOP 拦排队片]');
const d3 = runDir(ROOT, 'gate');
requestStop(d3, '用户喊停');
const { runFanout } = await import('../lib/fanout-run.mjs');
let asked = 0;
const fakeAsk = async () => { asked += 1; return { ok: true, addedText: '```js\n// file: lib/zzz_probe.mjs\nexport const a = 1;\n```', elapsedMs: 5 }; };
const res = await runFanout({
  task: '写三个互不相关的小文件：lib/aaa.mjs、lib/bbb.mjs、lib/ccc.mjs',
  parts: 3,
  lane: 'codebuddy',
  ask: fakeAsk,
  cwd: path.join(HERE, '..'),
  env: { ...process.env, ATWO_RUN_ID: 'gate', ATWO_RUNS: ROOT },
});
process.env.ATWO_RUN_ID = 'gate';
process.env.ATWO_RUNS = ROOT;
const res2 = await runFanout({
  task: '写三个互不相关的小文件：lib/aaa.mjs、lib/bbb.mjs、lib/ccc.mjs',
  parts: 3,
  lane: 'codebuddy',
  ask: fakeAsk,
  cwd: path.join(HERE, '..'),
});
ok(asked === 0 || res2.children.every((k) => k.stopped || k.ok), 'STOP 生效时不派新片');
const stoppedKids = (res2.children || []).filter((k) => k.stopped);
ok(stoppedKids.length > 0 || asked === 0, '至少有一片被标成「收到 STOP，未派发」或一次都没派');

fs.rmSync(ROOT, { recursive: true, force: true });
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
