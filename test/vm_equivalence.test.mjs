// 编译-执行等价性 —— 两个不同 AI 写的东西拼起来还对不对。
//
// L4 的 compile 把 AST 变成字节码，L3 的 run 执行字节码。两边由不同通道产出，
// 各自的单测绿不代表拼起来对：契约对齐靠的是「指令语义」这一层，而这一层没人单测过。
//
// 判据不看任何一方的自述：随机生成 AST → L4 编译 → L3 执行 → 与「参考求值器」比对。
// 参考求值器是我照 Kleene 定义另写的 20 行，故意不复用 L2/L3 的任何实现。

import { compile } from '../vm/compiler.mjs';
import { run } from '../vm/machine.mjs';

let pass = 0; let fail = 0; const fails = [];
const check = (name, ok, detail) => { if (ok) pass += 1; else { fail += 1; fails.push(name + (detail ? ' | ' + detail : '')); } };

// —— 参考求值器（独立实现，只用 Kleene 定义）——
const TRI = [-1, 0, 1];
const kAnd = (a, b) => (a === -1 || b === -1) ? -1 : (a === 0 || b === 0) ? 0 : 1;
const kOr = (a, b) => (a === 1 || b === 1) ? 1 : (a === 0 || b === 0) ? 0 : -1;
const kNot = (a) => (a === 0 ? 0 : -a);
function evalRef(n) {
  switch (n.t) {
    case 'const': return n.v === 1 ? 1 : n.v === -1 ? -1 : 0;
    case 'and': return kAnd(evalRef(n.a), evalRef(n.b));
    case 'or': return kOr(evalRef(n.a), evalRef(n.b));
    case 'not': return kNot(evalRef(n.a));
    case 'seq': return (evalRef(n.a), evalRef(n.b));
    case 'ifz': return evalRef(n.cond) === 0 ? evalRef(n.then) : evalRef(n.else);
    default: throw new Error('参考求值器不认识的节点: ' + n.t);
  }
}

// —— 随机 AST（只生成 const/and/or/not/seq/ifz，避开 thresh 的数值槽，那是 L4 自己的事）——
function rnd(n) { return Math.floor(Math.random() * n); }
function genAst(depth) {
  if (depth <= 0) return { t: 'const', v: TRI[rnd(3)] };
  switch (rnd(6)) {
    case 0: return { t: 'const', v: TRI[rnd(3)] };
    case 1: return { t: 'and', a: genAst(depth - 1), b: genAst(depth - 1) };
    case 2: return { t: 'or', a: genAst(depth - 1), b: genAst(depth - 1) };
    case 3: return { t: 'not', a: genAst(depth - 1) };
    case 4: return { t: 'seq', a: genAst(depth - 1), b: genAst(depth - 1) };
    default: return { t: 'ifz', cond: genAst(depth - 1), then: genAst(depth - 1), else: genAst(depth - 1) };
  }
}

const N = 200;
let mismatch = 0;
for (let i = 0; i < N; i++) {
  const ast = genAst(1 + rnd(3));
  let want; let got; let err = null;
  try { want = evalRef(ast); } catch (e) { continue; }
  try {
    const prog = compile(ast);
    const r = run(prog, { maxSteps: 100000 });
    if (!r.halted) { err = '未停机: ' + r.error; } else got = r.result;
  } catch (e) { err = 'compile/run 抛错: ' + (e && e.message); }
  if (err || got !== want) {
    mismatch += 1;
    if (mismatch <= 3) console.log('不一致 #' + i, JSON.stringify(ast), 'want', want, 'got', got, err || '');
  }
}
check('200 组随机 AST：编译执行与参考求值一致', mismatch === 0, mismatch + ' 组不一致');

// —— 定性：几条必须成立的性质 ——
const cases = [
  ['未知 AND 假 = 假', { t: 'and', a: { t: 'const', v: 0 }, b: { t: 'const', v: -1 } }, -1],
  ['未知 OR 真 = 真', { t: 'or', a: { t: 'const', v: 0 }, b: { t: 'const', v: 1 } }, 1],
  ['未知 AND 真 = 未知', { t: 'and', a: { t: 'const', v: 0 }, b: { t: 'const', v: 1 } }, 0],
  ['NOT 未知 = 未知', { t: 'not', a: { t: 'const', v: 0 } }, 0],
  ['ifz 未知走 then', { t: 'ifz', cond: { t: 'const', v: 0 }, then: { t: 'const', v: 1 }, else: { t: 'const', v: -1 } }, 1],
  ['ifz 真走 else', { t: 'ifz', cond: { t: 'const', v: 1 }, then: { t: 'const', v: 1 }, else: { t: 'const', v: -1 } }, -1],
  ['双重否定 = 原值', { t: 'not', a: { t: 'not', a: { t: 'const', v: -1 } } }, -1],
  ['seq 取后者', { t: 'seq', a: { t: 'const', v: 1 }, b: { t: 'const', v: 0 } }, 0],
];
for (const [name, ast, want] of cases) {
  let got; let err = null;
  try { const r = run(compile(ast)); got = r.halted ? r.result : null; if (!r.halted) err = r.error; } catch (e) { err = e.message; }
  check('等价性 · ' + name, got === want && !err, 'want ' + want + ' got ' + got + (err ? ' err ' + err : ''));
}

console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log('失败项：'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
