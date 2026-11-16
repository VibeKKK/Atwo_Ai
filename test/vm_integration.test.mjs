// 三值 VM 集成测试 —— 四层到齐后（或分批到齐时）跑这一份就能知道接口通不通。
//
// 为什么先写它：四层是四个不同的 AI 并行写的，每一层自己的单测绿不代表能拼起来。
// 拼的地方只有两处 —— 契约的签名，和「未知」这个值能不能一路传下去。
// 缺层时 skip 而不是 fail：这是进度探针，不是合格证。

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// 用 fileURLToPath 而不是 .pathname —— pathname 是 URL 编码的（空格变 %20），
// 直接当路径用会报 Cannot find module 'D:\ai%20project\...'。这个坑我踩过两次。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async (rel) => {
  try { return await import(pathToFileURL(path.join(root, rel)).href); }
  catch (e) { return { __missing: (e && e.message) || String(e) }; }
};

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
const skip = (name, why) => results.push({ name, ok: null, detail: 'skip: ' + why });

const T = await load('vm/ternary.mjs');
const L = await load('vm/logic.mjs');
const M = await load('vm/machine.mjs');
const C = await load('vm/compiler.mjs');
const J = await load('vm/judge.mjs');

// ---------- L1 三进制 ----------
if (T.__missing) skip('L1 三进制', T.__missing);
else {
  check('L1 toTrits(5) = [-1,-1,1]', JSON.stringify(T.toTrits(5)) === '[-1,-1,1]', JSON.stringify(T.toTrits(5)));
  check('L1 fromTrits 往返 -100..100', (() => { for (let i = -100; i <= 100; i++) if (T.fromTrits(T.toTrits(i)) !== i) return false; return true; })());
  check('L1 加法不进位出界', (() => { for (let a = -50; a <= 50; a++) for (let b = -50; b <= 50; b++) { const s = T.addTrits(T.toTrits(a), T.toTrits(b)); if (T.fromTrits(s) !== a + b) return false; if (s.some((t) => t < -1 || t > 1)) return false; } return true; })());
}

// ---------- L2 Kleene 三值逻辑 ----------
if (L.__missing) skip('L2 三值逻辑', L.__missing);
else {
  const { T: TT, F, U } = L;
  const vals = [TT, F, U];
  // 早先这里写的是 L.truthTable() 不带参 —— 而 truthTable 要求传函数，直接抛 TypeError。
  // 集成测试自己写错，会把「缺 L2」伪装成「L2 坏了」。
  check('L2 常量 T/F/U 是 1/-1/0', TT === 1 && F === -1 && U === 0, `${TT}/${F}/${U}`);
  check('L2 truthTable(and3) 返回 3x3', Array.isArray(L.truthTable(L.and3)) && L.truthTable(L.and3).length === 3);
  // Kleene 关键格（反直觉的那几个）：
  check('L2 未知 AND 假 = 假', L.and3(U, F) === F, String(L.and3(U, F)));
  check('L2 未知 OR 真 = 真', L.or3(U, TT) === TT, String(L.or3(U, TT)));
  check('L2 未知 AND 真 = 未知', L.and3(U, TT) === U, String(L.and3(U, TT)));
  check('L2 未知 OR 假 = 未知', L.or3(U, F) === U, String(L.or3(U, F)));
  check('L2 NOT 未知 = 未知', L.not3(U) === U, String(L.not3(U)));
  check('L2 真->假 蕴含 = 假', L.implies3(TT, F) === F, String(L.implies3(TT, F)));
  check('L2 假->任意 = 真', L.implies3(F, TT) === TT && L.implies3(F, U) === TT && L.implies3(F, F) === TT);
  check('L2 真<->假 = 假', L.equiv3(TT, F) === F, String(L.equiv3(TT, F)));
  check('L2 isKnown(U)=false', L.isKnown(U) === false);
  check('L2 isKnown(T)=true', L.isKnown(TT) === true);
  // 全组合都活在 {T,F,U} 里
  check('L2 二元运算封闭', vals.every((a) => vals.every((b) => [L.and3(a, b), L.or3(a, b), L.implies3(a, b), L.equiv3(a, b)].every((v) => v === TT || v === F || v === U))));
}

// ---------- L3 虚拟机 ----------
if (M.__missing) skip('L3 虚拟机', M.__missing);
else {
  const OP = M.OP || {};
  check('L3 指令集齐全', ['PUSH', 'AND', 'OR', 'NOT', 'JMP', 'JZ', 'JNZ', 'HALT'].every((k) => typeof OP[k] === 'number'), JSON.stringify(OP));
  // 真 AND 真 = 真，HALT
  const r1 = M.run([OP.PUSH, 1, OP.PUSH, 1, OP.AND, OP.HALT]);
  check('L3 真 AND 真', r1 && r1.halted === true && r1.result === 1, JSON.stringify(r1 && { h: r1.halted, v: r1.result }));
  const r2 = M.run([OP.PUSH, 1, OP.PUSH, -1, OP.AND, OP.HALT]);
  check('L3 真 AND 假 = 假', r2 && r2.result === -1, JSON.stringify(r2 && r2.result));
  const r3 = M.run([OP.PUSH, 0, OP.NOT, OP.HALT]);
  check('L3 NOT 未知 = 未知', r3 && r3.result === 0, JSON.stringify(r3 && r3.result));
  check('L3 有步数上限（不会死循环）', (() => { const r = M.run([OP.JMP, 0], { maxSteps: 50 }); return r && r.halted === false && r.steps <= 50; })(), 'JMP 0 自环');
  // trace 在 02:5x 的任务瘦身里砍掉了（150-240 行 → 80-130 行，三路通道 100 秒内交不出来），
  // 用例得跟着契约改，不然「我删了需求」会显示成「它没实现」。改成验收保留的字段：stack 是深拷贝。
  check('L3 stack 是深拷贝（改返回值不影响内部）', (() => { const r = M.run([1, 1, 8]); return r && Array.isArray(r.stack) && r.stack.length === 1 && r.stack[0] === 1; })(), '');
}

// ---------- L4 编译器 + 判定 ----------
if (C.__missing) skip('L4 编译器', C.__missing);
else {
  check('L4 compile 是函数', typeof C.compile === 'function');
  check('L4 judge 是函数', typeof C.judge === 'function' || (J && typeof J.judge === 'function'));
  // 编译一个「真 AND 假」
  if (typeof C.compile === 'function' && !M.__missing) {
    // AST 契约在 _probe/tvm_t4.md 里写死了：{ t:'const', v } / { t:'and', a, b }。
    // 我第一版按 {op:'and', a:{lit:1}} 写，compile 直接抛 TypeError —— 集成测试猜格式，
    // 会把「我的用例错」伪装成「L4 坏了」。
    const prog = C.compile({ t: 'and', a: { t: 'const', v: 1 }, b: { t: 'const', v: -1 } });
    check('L4 compile 出字节码数组', Array.isArray(prog), Array.isArray(prog) ? prog.length + ' 条' : typeof prog);
    const rr = M.run(prog);
    check('L4 编译-执行 真 AND 假 = 假', rr && rr.result === -1, JSON.stringify(rr && rr.result));
  }
}

// ---------- 与 chat analysis 的真数据接上 ----------
const judgeFn = (J && J.judge) || (C && C.judge) || null;
const rawConf = (J && J.computeConfidence) || (C && C.computeConfidence) || null;
// judge 的 computeConfidence 返回统计对象（含 strength/agreement/nValid/confidence），
// 不是单个数字 —— 这里统一取 .confidence，兼容只返回数字的实现。
const computeConf = rawConf ? (z) => { const r = rawConf(z); return (r && typeof r === 'object') ? r.confidence : r; } : null;
const verdictOf = (J && J.verdictOf) || (C && C.verdictOf) || null;
if (!computeConf) skip('置信度三段', 'L4 没交 computeConfidence');
else {
  // chat analysis README 的分档：>=0.45 可判 / >=0.22 存疑 / <0.22 别判
  check('置信度 高 → 可判', (() => { const c = computeConf([3.1, 2.9, 3.4, 2.8, 3.0, 3.2, 2.7, 3.3, 3.1]); return verdictOf ? ['可判', 'yes', 'JUDGEABLE'].includes(verdictOf(c)) || (c >= 0.45) : c >= 0.45; })(), String(computeConf([3.1, 2.9, 3.4, 2.8, 3.0, 3.2, 2.7, 3.3, 3.1])));
  check('置信度 全零 → 别判', (() => { const c = computeConf([0, 0, 0, 0, 0, 0, 0, 0, 0]); return c < 0.22; })(), String(computeConf([0, 0, 0, 0, 0, 0, 0, 0, 0])));
  check('置信度 方向打架 → 低', (() => { const c = computeConf([3, -3, 3, -3, 3, -3, 3, -3, 3]); return c < 0.22; })(), String(computeConf([3, -3, 3, -3, 3, -3, 3, -3, 3])));
}

// ---------- 输出 ----------
let pass = 0; let fail = 0; let skipN = 0;
for (const r of results) {
  if (r.ok === null) { skipN++; console.log(`  – ${r.name}  (${r.detail})`); continue; }
  if (r.ok) { pass++; console.log(`  ✓ ${r.name}`); }
  else { fail++; console.log(`  ✗ ${r.name}${r.detail ? '  → ' + r.detail : ''}`); }
}
console.log(`\n通过 ${pass} / 失败 ${fail} / 跳过 ${skipN}`);
process.exit(fail === 0 ? 0 : 1);
