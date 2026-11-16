import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { runCompareCheck, applyRegress } = await import(pathToFileURL(path.join(ROOT, 'lib', 'verify.mjs')).href);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regress-'));
const cases = path.join(tmp, 'cases.mjs');
fs.writeFileSync(cases, [
  'export default [',
  "  { name: 'f(1)', call: (m) => String(m.f(1)) },",
  "  { name: 'f(2)', call: (m) => String(m.f(2)) },",
  '];',
].join('\n'));

const sameA = path.join(tmp, 'same_a.mjs');
const sameB = path.join(tmp, 'same_b.mjs');
const src = 'export function f(n) { return n * 2; }\n';
fs.writeFileSync(sameA, src);
fs.writeFileSync(sameB, src);

const diff = path.join(tmp, 'diff.mjs');
fs.writeFileSync(diff, 'export function f(n) { return n * 3; }\n');

// 1. 实现等价 → 一致
const r1 = runCompareCheck(sameA, sameB, cases);
ok('等价实现判定一致', r1.ok === true, JSON.stringify(r1));
ok('detail 里带计数', /2\/2 一致/.test(r1.detail || ''), r1.detail);

// 2. 行为变了 → 报差异并点名用例
const r2 = runCompareCheck(sameA, diff, cases);
ok('行为不同判定不一致', r2.ok === false, JSON.stringify(r2));
ok('detail 点名了用例', /f\(1\)/.test(r2.detail || ''), r2.detail);
ok('detail 带新旧值', /旧 .*新 /.test(r2.detail || ''), r2.detail);

// 3. 旧版本不存在 → 不装通过
const r3 = runCompareCheck(sameA, path.join(tmp, 'nope.mjs'), cases);
ok('旧版本不在就不假装对拍过', r3.ok === false && /旧版本备份不在/.test(r3.detail || ''), r3.detail);

// 4. 用例文件不存在
const r4 = runCompareCheck(sameA, sameB, path.join(tmp, 'nope_cases.mjs'));
ok('用例不在说人话', r4.ok === false && /用例文件不存在/.test(r4.detail || ''), r4.detail);

// 5. applyRegress 的一票否决：默认只报，strict 才翻假
const mkRec = () => ({ verify: { ok: true, checks: [] } });
const okReg = { ok: true, detail: '6/6 一致', against: 'x' };
const badReg = { ok: false, detail: '2/6 一致', against: 'x' };

const a1 = mkRec();
applyRegress(a1, okReg, false);
ok('对拍一致：verify 不变且 checks 记一条', a1.verify.ok === true && a1.verify.checks.length === 1 && a1.verify.checks[0].ok === true, JSON.stringify(a1));
ok('对拍结果落到 rec.regress', a1.regress && a1.regress.ok === true, JSON.stringify(a1.regress));

const a2 = mkRec();
applyRegress(a2, badReg, false);
ok('默认只报不判：verify 仍过但 checks 记了失败', a2.verify.ok === true && a2.verify.checks.length === 1 && a2.verify.checks[0].ok === false, JSON.stringify(a2));

const a3 = mkRec();
applyRegress(a3, badReg, true);
ok('strict 一票否决：verify 被翻假', a3.verify.ok === false, JSON.stringify(a3));
ok('rec.regress 如实记不一致', a3.regress.ok === false && /2\/6/.test(a3.regress.detail), JSON.stringify(a3.regress));

const a4 = { verify: null };
applyRegress(a4, badReg, true);
ok('没有 verify 对象时不崩', a4.regress.ok === false && a4.verify === null, JSON.stringify(a4));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log((fail === 0 ? '✓ 通过 ' : '✗ 失败 ') + pass + ' / ' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
