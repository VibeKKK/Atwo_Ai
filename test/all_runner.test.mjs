// file: test/all_runner.test.mjs
// 验收 test/all.mjs 的三态与复跑：
//   假红（首跑红、单跑绿）不算失败但要单独列出来；
//   两次都红才算失败，且退出码 1；
//   红要能分清「超时」与「断言失败」；
//   TEST_NO_RETRY=1 时假红直接算失败（严格模式）。
// 做法：在系统临时目录造四个假测试，用 --dir 让真跑测器跑它们，断言它的输出与退出码。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ALL = path.join(HERE, 'all.mjs');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok - ' + n); } else { fail++; console.log('  NOT OK - ' + n + (x ? ' :: ' + x : '')); } };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-all-'));
  const put = (n, b) => fs.writeFileSync(path.join(dir, n), b);
  put('a_pass.test.mjs', "console.log('  ok - pass');\n");
  // 首跑红、二跑绿：靠一个标记文件区分第几次
  put('b_flaky.test.mjs', [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const mark = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1')), '.flaky-mark');",
    "if (!fs.existsSync(mark)) { fs.writeFileSync(mark, '1'); console.log('NOT OK - 第一次故意红'); process.exit(1); }",
    "console.log('  ok - 第二次绿');",
  ].join('\n'));
  put('c_fail.test.mjs', "console.log('NOT OK - 永远红'); process.exit(1);\n");
  put('d_timeout.test.mjs', "console.log('ETIMEDOUT 模拟环境抖动'); process.exit(1);\n");
  // 只是正文里出现「超时」二字，不该被判成超时（这条曾经把我自己的断言带偏）
  put('e_mentions.test.mjs', "console.log('NOT OK - 这句只是在讲超时该怎么办'); process.exit(1);\n");
  return dir;
}

function runAll(dir, env = {}) {
  const r = spawnSync(process.execPath, [ALL, '--dir', dir], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const dir = fixture();
try {
  const a = runAll(dir);
  ok('1a 有真失败时退出码 1', a.code === 1, 'code=' + a.code);
  ok('1b 通过的打 ✓', /✓ a_pass\.test\.mjs/.test(a.out));
  ok('1c 假红打 ⟳ 且写明首红→单跑绿', /⟳ b_flaky\.test\.mjs .*首红.*单跑.*绿/.test(a.out), a.out.slice(0, 300));
  ok('1d 永远红打 ✗ 且标「复跑仍红」', /✗ c_fail\.test\.mjs.*复跑仍红/.test(a.out));
  ok('1e 假红单独成节，不混进失败明细', a.out.includes('──── 假红') && a.out.indexOf('──── 失败明细') > a.out.indexOf('──── 假红'));
  ok('1f 汇总行把假红说清（不算失败）', /假红 1（复跑已绿）/.test(a.out), a.out.split('\n').slice(-2).join(' | '));
  ok('1g 超时与断言分开标', /d_timeout\.test\.mjs（timeout）/.test(a.out) && /c_fail\.test\.mjs（assert）/.test(a.out));
  ok('1h 没把假红算成失败（分母仍是 5）', /通过 2 \/ 5/.test(a.out), a.out.split('\n').slice(-1)[0]);
  ok('1i 只是提到「超时」不算超时，标成 timeout-suspect', /e_mentions\.test\.mjs（timeout-suspect）/.test(a.out), a.out.slice(0, 200));

  // 严格模式：关掉复跑，假红就该是真失败
  const strict = runAll(dir, { TEST_NO_RETRY: '1' });
  ok('2a TEST_NO_RETRY=1 时假红算失败', strict.code === 1);
  ok('2b 严格模式不再出现 ⟳', !/⟳/.test(strict.out), strict.out.slice(0, 200));
  ok('2c 严格模式汇总没有假红节', !strict.out.includes('──── 假红'));

  // 全绿的目录
  const green = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-all-green-'));
  fs.writeFileSync(path.join(green, 'x.test.mjs'), "console.log('  ok - x');\n");
  try {
    const g = runAll(green);
    ok('3a 全绿退出码 0', g.code === 0);
    ok('3b 全绿不打假红节', !g.out.includes('假红'));
  } finally {
    fs.rmSync(green, { recursive: true, force: true });
  }

  // 空目录：报「没有匹配」并退出码 2，不能假装通过
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-all-empty-'));
  try {
    const e = runAll(empty);
    ok('4a 空目录退出码 2', e.code === 2, 'code=' + e.code);
    ok('4b 空目录不撒谎通过', !/通过 0 \/ 0/.test(e.out));
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail === 0 ? '\n' + pass + ' 通过 / 0 失败' : '\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);