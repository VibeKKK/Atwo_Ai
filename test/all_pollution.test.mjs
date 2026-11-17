/**
 * 跑测器的工作区污染检测（test/all.mjs 的 --strict）。
 *
 * 为什么要有：测试往真实仓库写文件（曾把 lib/p01_probe.mjs 写进仓库根），
 * 后果不是「多一个文件」，是「本机全绿、干净 clone 红」与并发互踩 ——
 * 那种红查两小时也查不出来是因为它跟代码无关。
 *
 * 这里造一个**故意污染**的假测试与一个**干净**的假测试，断言：
 *   1. 干净时没有污染行；
 *   2. 污染时报告出来，但默认不算失败（别人同时在改工作区不能冤枉测试）；
 *   3. --strict 时才算失败。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const N = String.fromCharCode(10);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ALL = path.join(HERE, 'all.mjs');

let pass = 0;
const failList = [];
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log('  ok - ' + n); }
  else { failList.push(n); console.log('  NOT OK - ' + n + (x ? ' :: ' + x : '')); }
};

function mkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'all-pollution-'));
}

function put(dir, name, src) {
  fs.writeFileSync(path.join(dir, name), src, 'utf8');
}

function run(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [ALL, '--dir', dir, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, TEST_ALL_DEPTH: '1', TEST_NO_RETRY: '1', ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const dir = mkdir();
const clean = mkdir();
const target = path.join(ROOT, '_pollute_' + process.pid + '.txt');

put(clean, 'a_clean.test.mjs', "console.log('nothing written');" + N);
put(dir, 'b_write.test.mjs', [
  "import fs from 'node:fs';",
  "fs.writeFileSync(process.env.POLLUTE_TARGET, 'x');",
  "console.log('wrote ' + process.env.POLLUTE_TARGET);",
  '',
].join(N));

try {
  const a = run(clean, [], { POLLUTE_TARGET: target });
  ok('干净目录不报污染', !/工作区污染/.test(a.out), a.out.slice(-200));
  ok('干净目录退出码 0', a.code === 0, String(a.code));
  ok('干净目录摘要里没有污染计数', !/污染 0/.test(a.out), a.out.slice(-120));

  fs.rmSync(target, { force: true });
  const b = run(dir, [], { POLLUTE_TARGET: target });
  ok('污染被报告出来', /工作区污染/.test(b.out), b.out.slice(-300));
  ok('报告里点名了那个文件', b.out.includes(path.basename(target)), b.out.slice(-300));
  ok('默认只报告、不算失败', b.code === 0, String(b.code) + ' / ' + b.out.slice(-120));
  ok('摘要里标了（仅报告）', /污染 1（仅报告）/.test(b.out), b.out.slice(-160));

  fs.rmSync(target, { force: true });
  const c = run(dir, ['--strict'], { POLLUTE_TARGET: target });
  ok('--strict 时算失败（退出码 1）', c.code === 1, String(c.code));
  ok('--strict 摘要里标了（算失败）', /污染 1（算失败）/.test(c.out), c.out.slice(-160));
} finally {
  fs.rmSync(target, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(clean, { recursive: true, force: true });
}

const head = failList.length ? 'NOT OK' : 'ok';
console.log('all_pollution: ' + pass + ' passed / ' + failList.length + ' failed  (' + head + ')');
process.exit(failList.length ? 1 : 0);