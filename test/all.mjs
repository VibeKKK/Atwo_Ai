#!/usr/bin/env node
/**
 * 一条命令跑完 test/ 下所有测试。
 *
 * 为什么要有这个：`package.json` 的 test 脚本只列了 6 个老文件，
 * 而 test/ 现在有 20 个（含 *.test.mjs 14 个）。谁加测试都得手工改脚本，
 * 少改一次就「以为全绿」。这个跑测器改成**发现式**——目录里有什么就跑什么。
 *
 * 用法：
 *   node test/all.mjs                 # 全跑
 *   node test/all.mjs --only ledger   # 只跑文件名含 ledger 的
 *   node test/all.mjs --quiet         # 只打失败的
 *
 * 设计取舍：
 *   - **串行**。测试里有抢锁、抢 GUI 通道、写 _probe 的，并行会互相踩，
 *     而串行的总时长现在也就几分钟 —— 用确定性换那点时间不亏。
 *   - **独立子进程 + 超时**。某个测试挂死不能拖垮整批；超时按 600 秒算。
 *   - 退出码：任一条红就是 1，别让 CI/脚本以为过了。
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
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '';
const quiet = argv.includes('--quiet');

const files = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => f !== SELF)
  .filter((f) => (only ? f.includes(only) : true))
  .sort();

if (!files.length) {
  console.log('没有匹配的测试文件' + (only ? '（--only ' + only + '）' : ''));
  process.exit(2);
}

console.log('跑 ' + files.length + ' 个测试文件' + (only ? '（--only ' + only + '）' : '') + '：');

const failed = [];
const startedAll = Date.now();

for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, f)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    // 子测试里有的会 spawn 自己的子进程（GUI/agent），继承环境但不要 stdin
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ms = Date.now() - t0;
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  const ok = !timedOut && r.status === 0;

  if (ok) {
    if (!quiet) console.log('  ✓ ' + f + '  ' + (ms / 1000).toFixed(1) + 's');
  } else {
    failed.push({ f, ms, timedOut, out: (r.stdout || '') + (r.stderr || ''), code: r.status });
    console.log('  ✗ ' + f + '  ' + (ms / 1000).toFixed(1) + 's' + (timedOut ? '（超时 ' + TIMEOUT_MS + 'ms）' : '（退出码 ' + r.status + '）'));
  }
}

const totalS = ((Date.now() - startedAll) / 1000).toFixed(1);

if (failed.length) {
  console.log('\n──── 失败明细 ────');
  for (const x of failed) {
    console.log('\n✗ ' + x.f);
    // 只打尾巴：测试的失败原因通常在最后几行，前面全是 ✓ 噪音
    const tail = x.out.trim().split(/\r?\n/).slice(-12).join('\n');
    console.log(tail || '（没有输出）');
  }
}

console.log('\n' + (failed.length ? '✗ ' : '✓ ') + '通过 ' + (files.length - failed.length) + ' / ' + files.length + ' · 用时 ' + totalS + 's');
process.exit(failed.length ? 1 : 0);
