// 对拍层（--against）：不给人期望值，只比两个实现结论一不一样。
// 它抓的是「同一件事被定义了两遍、两遍不一样」—— 跨层契约 70/200 不一致就是这么出来的。
import { accept } from '../packages/accept/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const bad = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok  ' + name); }
  else { fail++; bad.push(name + (detail ? ' -> ' + detail : '')); console.log('  NG  ' + name + (detail ? ' -> ' + detail : '')); }
}

const A = path.join(ROOT, 'fixtures', 'accept', 'cmp_a.mjs');
const B = path.join(ROOT, 'fixtures', 'accept', 'cmp_b.mjs');
const SAME = path.join(os.tmpdir(), 'atwo_cmp_same_' + process.pid + '.mjs');
const CASES = path.join(ROOT, 'fixtures', 'accept', 'cmp_cases.mjs');
fs.writeFileSync(SAME, fs.readFileSync(A, 'utf8'), 'utf8');

// 1) 两份写同一个意思（n*2 与 n+n）→ 对拍必须过
const same = accept(A, { behave: CASES, against: SAME });
check('两个等价实现 -> 对拍通过', same.layers.compare.ok === true, JSON.stringify(same.layers.compare.notes));
check('对拍报告 total/passed', same.layers.compare.total === 2 && same.layers.compare.passed === 2);

// 2) 两份行为不同 -> 对拍必须报差异（这是它存在的理由）
const diff = accept(A, { behave: CASES, against: B });
check('行为不同时对拍不过', diff.layers.compare.ok === false, 'ok=' + diff.layers.compare.ok);
check('差异里点名了用例', /f\(3\)/.test(diff.layers.compare.notes.join(' ')), diff.layers.compare.notes.join(' '));

// 3) 两边都抛同样的错 -> 算一致（对拍比的是结论，包括「都炸了」这个结论）
const bothThrow = accept(A, { behave: CASES, against: SAME });
check('两边都抛同样的错算一致', !bothThrow.layers.compare.notes.some((n) => /g\(1\)/.test(n)), bothThrow.layers.compare.notes.join(' '));

// 4) 没给 against 时不出现 compare 层（默认行为不变）
const none = accept(A, { behave: CASES });
check('没给 against 就没有对拍层', none.layers.compare === undefined);

// 5) 对拍失败不影响 behavior 层自己的结论（两层各判各的）
check('对拍不过时 behavior 仍单独给结论', diff.layers.behavior && typeof diff.layers.behavior.ok === 'boolean');

// 6) 清理
for (const f of [SAME]) { try { fs.unlinkSync(f); } catch { } }

console.log('');
console.log('对拍：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) { console.log(bad.join(String.fromCharCode(10))); process.exit(1); }
