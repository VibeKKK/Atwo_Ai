#!/usr/bin/env node
/**
 * 一条命令跑完 test/ 下所有测试。
 *
 * 为什么要有这个：`package.json` 的 test 脚本只列了 6 个老文件，
 * 而 test/ 现在有 50+ 个。谁加测试都得手工改脚本，少改一次就「以为全绿」。
 * 这个跑测器是**发现式**的 —— 目录里有什么就跑什么。
 *
 * 用法：
 *   node test/all.mjs                     # 全跑（失败自动隔离复跑一次）
 *   node test/all.mjs --only ledger       # 只跑文件名含 ledger 的
 *   node test/all.mjs --dir <目录>        # 跑另一个目录（自测用）
 *   node test/all.mjs --quiet             # 只打失败的
 *   TEST_NO_RETRY=1 node test/all.mjs     # 关掉复跑（CI 想严格时用）
 *   node test/all.mjs --no-strict         # 降级：跑测期间新增文件只报告不判失败
 *                                          （默认**判失败**；别人同时在改工作区时才用它）
 *
 * 三态而不是两态（2026-11-16 改）：
 *   - ✓ 通过
 *   - ⟳ 首次红 / 单跑绿 —— **假红**。这台机器上每条测试都会 spawn 真 AI 子进程，
 *     负载一高就撞 agents/*.mjs 的内部超时，报出来的红跟代码无关。
 *     以前这种红直接算失败，一天里能出现两三次；结果是「真失败」被淹在噪音里，
 *     人开始习惯性无视红色 —— 比测试少更危险。
 *   - ✗ 两次都红 —— 才算真失败，退出码 1。
 * 复跑是**单独**跑的（不与其它测试并发），所以它复现的就是「同一份代码、更小的负载」；
 * 复跑绿说明红来自环境抖动，不是断言。
 *
 * 其它取舍：
 *   - **串行**。测试里有抢锁、抢 GUI 通道、写 _probe 的，并行会互相踩。
 *   - **独立子进程 + 超时**。某个测试挂死不能拖垮整批；超时按 600 秒算。
 *   - 红的时候要能分清**超时**与**断言失败**：超时是 ETIMEDOUT 或输出里出现超时字样。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SELF = path.basename(fileURLToPath(import.meta.url));
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 600000) || 600000;

const argv = process.argv.slice(2);
const pick = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const only = pick('--only', '');
const dirArg = pick('--dir', '');
const DIR = dirArg ? path.resolve(dirArg) : HERE;
const quiet = argv.includes('--quiet');
// 复跑只允许在最外两层发生（最外层跑测器 + 它 spawn 的直接子进程），再深就直接算红，
// 防止「测试里再跑一次全量」这种结构无限套下去。
// 注意不能用一刀切的 TEST_ALL_RETRY=1 —— 那会把嵌套调用的正常复跑也关掉
// （all_runner.test.mjs 里就是要验复跑本身，曾被自己关掉导致 5 条假红）。
const DEPTH = Number(process.env.TEST_ALL_DEPTH || 0) || 0;
const noRetry = process.env.TEST_NO_RETRY === '1' || DEPTH >= 2;

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => (DIR === HERE ? f !== SELF : true))
  .filter((f) => (only ? f.includes(only) : true))
  .sort();

if (!files.length) {
  console.log('没有匹配的测试文件' + (only ? '（--only ' + only + '）' : '') + '：' + DIR);
  process.exit(2);
}

console.log('跑 ' + files.length + ' 个测试文件' + (only ? '（--only ' + only + '）' : '') + (noRetry ? '（不复跑）' : '') + '：');

// 真超时信号（spawnSync 的 ETIMEDOUT 或子进程自己打出来的 ETIMEDOUT / timed out）
const HARD_TIMEOUT = /ETIMEDOUT|timed out|timed-out/i;
// 只是「提到超时」——测试正文里出现这两个字很正常，不能据此判它超时（曾被自己的断言带偏）
const SOFT_TIMEOUT = /超时|timeout/i;

function runOnce(f) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    // 子测试里有的会 spawn 自己的子进程（GUI/agent），继承环境但不要 stdin
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TEST_ALL_DEPTH: String(DEPTH + 1) },
  });
  const ms = Date.now() - t0;
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = !timedOut && r.status === 0;
  // 红的类别：超时 / 断言失败。前者多为环境，后者多为代码 —— 混在一起就没法判断严重性。
  const kind = ok ? 'ok'
    : (timedOut || HARD_TIMEOUT.test(out) ? 'timeout'
      : (SOFT_TIMEOUT.test(out) ? 'timeout-suspect' : 'assert'));
  return { f, ok, ms, timedOut, code: r.status, out, kind };
}

// 跑测前后的工作区快照：测试写到真实仓库里 = 污染。
// 判据是**新增**（跑完多出来的路径），不是差异总量 —— 别人同时在改工作区不会冤枉测试。
//
// 2026-11-19 改：**默认就判失败**，--no-strict 才降级成只报告。
// 原来默认「仅报告」的后果是实测过的：作者自己的机器上跑出
// `✓ 通过 145 / 145 · 污染 1（仅报告）`，退出码 0 —— 检测逻辑是对的，
// 没接线到失败判定，污染就一直存在（docs/decisions/ 积了多个非常规命名的文件）。
// 报告没人看等于没报。
//
// 保留的退路：别人同时在改工作区时，新增文件未必是测试写的 ——
// 这层用 --no-strict 手动降级，而不是让默认值替所有人决定「不用管」。
function gitSnapshot() {
  const r = spawnSync('git', ['status', '--porcelain', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const map = new Map();
  for (const item of String(r.stdout || '').split('\0')) {
    if (item.length > 3) map.set(item.slice(3), item.slice(0, 2));
  }
  return map;
}
const strict = !argv.includes('--no-strict');
const snapBefore = gitSnapshot();
const t = (ms) => (ms / 1000).toFixed(1) + 's';
const startedAll = Date.now();
const passed = [];
const flaky = [];
const failed = [];

for (const f of files) {
  const first = runOnce(f);
  if (first.ok) {
    passed.push(first);
    if (!quiet) console.log('  ✓ ' + f + '  ' + t(first.ms));
    continue;
  }
  let verdict = first;
  let retried = false;
  if (!noRetry) {
    const again = runOnce(f);
    retried = true;
    verdict = again;
  }
  if (verdict.ok) {
    flaky.push({ ...first, retryMs: verdict.ms });
    console.log('  ⟳ ' + f + '  ' + t(first.ms) + ' 首红 → 单跑 ' + t(verdict.ms) + ' 绿（假红：' + first.kind + '）'
      + (first.code != null ? '' : ''));
  } else {
    failed.push({ ...verdict, firstKind: first.kind, firstMs: first.ms, retried });
    console.log('  ✗ ' + f + '  ' + t(verdict.ms)
      + (verdict.timedOut ? '（超时 ' + TIMEOUT_MS + 'ms）' : '（退出码 ' + verdict.code + '）')
      + (retried ? ' · 复跑仍红' : ''));
  }
}

const totalS = ((Date.now() - startedAll) / 1000).toFixed(1);

if (flaky.length) {
  console.log('\n──── 假红（首跑红、单跑绿；不算失败，但要看见）────');
  for (const x of flaky) {
    const tail = x.out.trim().split(/\r?\n/).slice(-3).join(' / ');
    console.log('  ⟳ ' + x.f + ' —— ' + x.kind + (tail ? '：' + tail.slice(0, 200) : ''));
  }
}

if (failed.length) {
  console.log('\n──── 失败明细 ────');
  for (const x of failed) {
    console.log('\n✗ ' + x.f + '（' + x.kind + (x.firstKind && x.firstKind !== x.kind ? '，首跑 ' + x.firstKind : '') + '）');
    // 只打尾巴：测试的失败原因通常在最后几行，前面全是 ✓ 噪音
    const tail = x.out.trim().split(/\r?\n/).slice(-12).join('\n');
    console.log(tail || '（没有输出）');
  }
}

const snapAfter = gitSnapshot();
const polluted = [];
const touched = [];
if (snapBefore && snapAfter) {
  for (const [file, st] of snapAfter) {
    if (!snapBefore.has(file)) polluted.push(file);
    else if (snapBefore.get(file) !== st) touched.push(file);
  }
}
if (polluted.length) {
  console.log('\n──── 工作区污染（跑测期间新出现；测试该写到临时目录/被忽略路径）────');
  for (const x of polluted.slice(0, 20)) console.log('  + ' + x);
  if (polluted.length > 20) console.log('  … 另有 ' + (polluted.length - 20) + ' 条');
  if (strict) console.log('  （算失败；确实要放过用 --no-strict）');
}
if (touched.length) {
  // 不判死：别人（或我自己）可能正在同一个工作区里改文件，跑测期间 mtime/状态变了。
  // 但如果这些文件跟代码无关，就该怀疑是测试写了已跟踪文件 —— 用 git diff 看一眼比猜快。
  console.log('\n──── 跑测期间被改动的已跟踪文件（不判失败，请 git diff 确认是谁改的）────');
  for (const x of touched.slice(0, 20)) console.log('  ~ ' + x);
}
const head = failed.length || (strict && polluted.length) ? '✗ ' : '✓ ';
const flakyNote = flaky.length ? ' · 假红 ' + flaky.length + '（复跑已绿）' : '';
const dirtyNote = polluted.length ? ' · 污染 ' + polluted.length + (strict ? '（算失败）' : '（仅报告）') : '';
console.log('\n' + head + '通过 ' + (passed.length + flaky.length) + ' / ' + files.length + flakyNote + dirtyNote + ' · 用时 ' + totalS + 's');
process.exit(failed.length || (strict && polluted.length) ? 1 : 0);