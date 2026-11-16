// file: test/atwo_judge.test.mjs
// 目的：钉死「编译执行 = 现算」这条不变式。
// 为什么要有这个测试：31/31 全绿的时候，atwo judge 曾经每次必失败 ——
// 因为测试只走编译器自带的解释器，而 atwo 走的是 vm/machine.mjs。
// 这条测试只从 CLI 走，任何一侧单独改坏都会红。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; } else { fail += 1; console.log('  \u2717 ' + msg); }
};

function judgeJson(z) {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'atwo.mjs'), 'judge', '--z', z, '--json'], {
    cwd: ROOT, encoding: 'utf8',
  });
  return JSON.parse(out);
}

// 三个置信带各一例：可判(+1) / 存疑(0) / 别判(-1)
const CASES = [
  ['3.1,2.9,3.4,2.8,3.2,2.95,3.05,3.0,2.9', 1],
  ['0.5,0.2,0.4,0.1,0.3,0.25,0.35,0.15,0.45', 0],
  ['0.05,-0.03,0.02,-0.01,0.04,0.0,-0.02,0.01,0.03', -1],
];

for (const [z, wantVerdict] of CASES) {
  const r = judgeJson(z);
  const d = r.data || {};
  ok(r.ok === true, 'ok=true  z=' + z);
  ok(r.exitCode === 0, 'exitCode=0  z=' + z);
  ok(d.consistent === true, '\u7f16\u8bd1\u6267\u884c\u4e0e\u73b0\u7b97\u5fc5\u987b\u4e00\u81f4  z=' + z);
  ok(d.compiled === d.direct, 'compiled === direct  z=' + z);
  ok(d.verdict === wantVerdict, '\u7ed3\u8bba\u5e94\u4e3a ' + wantVerdict + '\uff0c\u5b9e\u5f97 ' + d.verdict + '  z=' + z);
  ok(typeof d.confidence === 'number' && d.confidence >= 0 && d.confidence <= 1, 'confidence \u5728 [0,1]  z=' + z);
  ok(typeof r.log === 'string' && r.log.length > 0, 'log \u91cc\u8981\u6709\u4eba\u8bdd  z=' + z);
}

// \u8131\u94a9\u4fdd\u62a4\uff1a\u5168\u662f\u5e9f\u6570\u65f6\u4e0d\u5141\u8bb8\u7ed9\u53ef\u5224
const bad = judgeJson('abc');
ok(bad.data && bad.data.verdict === -1, '\u5168\u5e9f\u6570\u5fc5\u987b\u7ed9\u300c\u522b\u5224\u300d');
ok(bad.data.validRatio === 0, '\u6709\u6548\u7387\u5e94\u4e3a 0');

console.log((fail === 0 ? '\u2713 ' : '\u2717 ') + 'atwo_judge: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
