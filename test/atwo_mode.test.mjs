// 逐条验 atwo 三档 PRD 的 A1-A8。全程 --plan（只算参数不派活），不烧任何额度。
// 副作用：会临时改写 .atwo/mode.json，结束时恢复 strict；会建/删一个空任务目录。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.resolve(import.meta.dirname, '..');
const ATWO = path.join(HERE, 'atwo.mjs');
const MODE = path.join(HERE, '.atw', 'mode.json');
// PRD 必须由测试自己造：原先指向 .atw/tasks/11-16-atwo-i234fz/prd.md（运行时目录，被 gitignore），
// 干净 clone 里不存在 → go 一律退 3，五条断言全红（2026-11-17 干净检出实证）。
const PRD = '.atw/tasks/_mode_fixture/prd.md';
fs.mkdirSync(path.join(HERE, '.atw', 'tasks', '_mode_fixture'), { recursive: true });
fs.copyFileSync(path.join(HERE, 'fixtures', 'tasks', 'mode_prd.md'), path.join(HERE, PRD));
const EMPTY = path.join(HERE, 'test', '_tmp_empty_tasks');

const run = (args, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [ATWO, ...args], {
    cwd: HERE, encoding: 'utf8',
    timeout: Number(process.env.ATWO_TEST_SPAWN_MS || 180000), // 负载下不给上限会挂到框架超时，红得没信息
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); }
};
const agentCount = (out) => {
  const m = out.match(/--agent (\S+)/);
  return m ? m[1].split(',').length : 0;
};
const claimedLanes = (out) => {
  const m = out.match(/▶ 本次：(\d+) 路/);
  return m ? Number(m[1]) : -1;
};

// 起点：删掉 mode.json
if (fs.existsSync(MODE)) fs.unlinkSync(MODE);

console.log('A1  mode.json 不存在 = strict');
let r = run(['mode']);
ok('输出 strict', /strict/.test(r.out), r.out.slice(0, 120));
ok('文件仍不存在', !fs.existsSync(MODE));

console.log('A3  非法档报错且不写文件');
r = run(['mode', 'bogus']);
ok('退出码 2', r.code === 2, 'code=' + r.code);
ok('列出三个合法值', /strict/.test(r.out) && /crazy/.test(r.out) && /off/.test(r.out));
ok('文件没被创建', !fs.existsSync(MODE));

console.log('A2  切 crazy 留下三字段');
r = run(['mode', 'crazy']);
const j = fs.existsSync(MODE) ? JSON.parse(fs.readFileSync(MODE, 'utf8')) : {};
ok('退出码 0', r.code === 0);
ok('mode/since/by 齐全', j.mode === 'crazy' && !!j.since && !!j.by, JSON.stringify(j));

// 探活（lib/canary.mjs）会按「端口在不在」把死通道从编队里摘掉，于是「配了几路」
// 在这台机器上会随客户端开没开而变。档位测试要判的是**配置语义**，不是机器现状，
// 所以两处四路断言一律加 --no-canary（关探活），把环境变量从断言里摘出去。
console.log('A6  crazy 参数：四路 + 三评审 + 返工三轮');
r = run(['go', PRD, '--plan', '--no-canary']);
const laneNames = ((r.out.match(/--agent (\S+)/) || [])[1] || '').split(',').filter(Boolean);
ok('四路都在', ['codebuddy', 'trae', 'workbuddy', 'doubao'].every((n) => laneNames.includes(n)), laneNames.join(','));
ok('多评审 = 3（--by-multi / --reviewers 同义，二者之一即可）', /--(?:by-multi|reviewers) 3/.test(r.out));
ok('--max-fix 3', /--max-fix 3/.test(r.out));
ok('禁缓存 env', /ORCH_NO_CACHE/.test(r.out));
ok('打印路数 = 5? 不对就说明打印与参数不一致', claimedLanes(r.out) === 4, 'claimed=' + claimedLanes(r.out));

console.log('A4  strict + M：单路一评');
run(['mode', 'strict']);
// 必须显式 --size M：不传时尺寸取自 activeTask()，也就是「当前哪个任务在跑」——
// 2026-11-16 实测被这个坑到：新任务标了 L，A4 立刻按 4 路 + --by-multi 2 跑，
// 两条断言全红，看起来像档位坏了，其实是测试依赖了运行环境的当前任务。
// 2026-11-17：SIZE_PLAN.M 从 ['codebuddy','trae'] 改成 ['codebuddy']（trae 常空产出，评审另由
// probeReviewers 挑），所以这里断言单路；四路并派要显式 --all-lanes（A4b 覆盖）。
r = run(['go', PRD, '--plan', '--size', 'M']);
ok('--agent codebuddy', /--agent codebuddy(\s|$)/.test(r.out), r.out.slice(0, 300));
ok('带 --review', /--review/.test(r.out));
ok('不带 --by-multi（单评审）', !/--by-multi/.test(r.out));
ok('带 --land --verify', /--land/.test(r.out) && /--verify/.test(r.out));
ok('打印 1 路', claimedLanes(r.out) === 1, 'claimed=' + claimedLanes(r.out));

console.log('A4b  --all-lanes 强制四路（M 档也能四路并派）');
r = run(['go', PRD, '--plan', '--size', 'M', '--all-lanes', '--no-canary']);
const allLaneNames = ((r.out.match(/--agent (\S+)/) || [])[1] || '').split(',').filter(Boolean);
ok('四路都在', ['codebuddy', 'trae', 'workbuddy', 'doubao'].every((n) => allLaneNames.includes(n)), allLaneNames.join(','));
ok('打印 4 路', claimedLanes(r.out) === 4, 'claimed=' + claimedLanes(r.out));

console.log('A5  strict + S：单路不评');
r = run(['go', PRD, '--plan', '--size', 'S']);
ok('--agent codebuddy（单路）', /--agent codebuddy(\s|$)/.test(r.out), r.out.slice(0, 300));
ok('不含 --review', !/--review/.test(r.out));
ok('打印 1 路', claimedLanes(r.out) === 1, 'claimed=' + claimedLanes(r.out));

console.log('A8  打印路数 == --agent 个数（三档各测一次）');
fs.mkdirSync(EMPTY, { recursive: true });
for (const [label, args, mode] of [
  ['strict·M', ['go', PRD, '--plan'], 'strict'],
  ['strict·L', ['go', PRD, '--plan', '--size', 'L'], 'strict'],
  ['crazy', ['go', PRD, '--plan'], 'crazy'],
]) {
  run(['mode', mode]);
  const rr = run(args);
  ok(label + '  打印 ' + claimedLanes(rr.out) + ' 路 / 参数 ' + agentCount(rr.out) + ' 路一致',
    claimedLanes(rr.out) === agentCount(rr.out) && agentCount(rr.out) > 0);
}

console.log('A7  off：没有任务也照样派活');
run(['mode', 'strict']);
r = run(['go', 'x.md', '--plan'], { ATWO_TASKS_DIR: EMPTY });
ok('strict 无任务 → 拒绝（退出码 3 = 前置条件不满足）', r.code === 3, 'code=' + r.code);
run(['mode', 'off']);
r = run(['go', 'x.md', '--plan'], { ATWO_TASKS_DIR: EMPTY });
ok('off 无任务 → 放行（退出码 0）', r.code === 0, 'code=' + r.code + ' ' + r.out.slice(0, 200));
ok('off 打印「流程已关闭」', /流程已关闭|off/.test(r.out));

// 收尾：回到 strict，删掉临时空目录
run(['mode', 'strict']);
try { fs.rmdirSync(EMPTY); } catch { }

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);