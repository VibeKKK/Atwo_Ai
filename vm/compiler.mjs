/**
 * @file vm/compiler.mjs
 * @description 极小 AST → 三值字节码编译器（零依赖）。
 *
 * 三值语义（Kleene）：AND 任一侧 -1 → -1、两侧 +1 → +1、其余 0；
 * OR 任一侧 +1 → +1、两侧 -1 → -1、其余 0；NOT 取负（0 仍是 0）。
 * 字节码是扁平 number[]，指令见 OP；跳转地址是**代码数组下标**（0 基），没有变长指令。
 *
 * 数值槽问题（必须说清，不能假装没有）：三值栈只接受 -1/0/+1，`thresh` 要比较的
 * 却是浮点数（如 confidence=0.37）。因此约定 `PUSHNUM <float>`（opcode 0x0C）把数值
 * 压进**独立的单值数值槽**（不要求栈）；`THRESH hi lo` 读该槽并压一个 trit：
 * `num >= hi → +1`、`num < lo → -1`、其余 → 0。边界写成 `>=` / `<`，于是 `THRESH t t`
 * 是“是否达到 t”的单边判据，`[0.22, 0.45)` 这种半开区间也能精确表达（等于 lo 归中档）。
 *
 * `vm/machine.mjs` 早先不认识 0x0C，本文件因此自带了一份解释器兜底。两份解释器各写一遍
 * THRESH / PUSHNUM / JZ 的语义，代价是「测试 31/31 全绿」与「atwo judge 每次必失败」同时成立。
 * 2026-11-16 起只留一个解释器：machine.mjs 已支持 0x0C 与双操作数 THRESH，
 * `runWithCompiler` 只做适配委托，不再自己实现指令。
 */

import { run as runMachine } from './machine.mjs';

/** AST 节点类型。'if' 是本任务的扩展（cond 非 0 走 then），'ifz' 才是规范里的“0 走 then”。 */
export const NODE = {
  CONST: 'const', AND: 'and', OR: 'or', NOT: 'not',
  THRESH: 'thresh', IFZ: 'ifz', IF: 'if', SEQ: 'seq',
};

/** 指令号。0x0C 是数值槽专用，不在 machine 的既有表里。 */
export const OP = {
  PUSH: 1, AND: 2, OR: 3, NOT: 4,        // [1,trit] / [2] / [3] / [4]
  JMP: 5, JZ: 6, JNZ: 7, HALT: 8,        // [5,addr] / [6,addr] 弹 trit 为零跳 / [7,addr] 非零跳 / [8]
  THRESH: 11, PUSHNUM: 0x0C,             // [11,hi,lo] 读数值槽压 trit / [0x0C,num] 写数值槽
};

/** 只接受 -1/0/+1，其它一律当 0 —— 编译期挡住脏 trit，别留到运行期。 */
function trit(v) {
  const n = Number(v);
  return n === 1 ? 1 : (n === -1 ? -1 : 0);
}

/** 节点形状不对就立刻报错；静默当 0 会让错误在很远的地方才显形。 */
function assertNode(node, where) {
  if (!node || typeof node !== 'object' || typeof node.t !== 'string') {
    throw new TypeError('AST 节点必须是对象且有字符串 t（位置：' + where + '）');
  }
  return node;
}

/** 追加若干数字，返回起始下标（用于回填跳转）。 */
function emit(prog, ...nums) {
  const at = prog.length;
  for (const n of nums) prog.push(n);
  return at;
}

/** 回填跳转目标：两格指令的目标写在第二个格子。 */
function patch(prog, at, target) {
  prog[at + 1] = target;
}

function compileNode(node, prog) {
  const n = assertNode(node, 'compile');
  switch (n.t) {
    case NODE.CONST:
      emit(prog, OP.PUSH, trit(n.v));
      return;
    case NODE.AND:
      compileNode(n.a, prog);
      compileNode(n.b, prog);
      emit(prog, OP.AND);
      return;
    case NODE.OR:
      compileNode(n.a, prog);
      compileNode(n.b, prog);
      emit(prog, OP.OR);
      return;
    case NODE.NOT:
      compileNode(n.a, prog);
      emit(prog, OP.NOT);
      return;
    case NODE.THRESH: {
      const hi = Number(n.hi);
      const lo = Number(n.lo);
      if (!Number.isFinite(Number(n.v)) || !Number.isFinite(hi) || !Number.isFinite(lo)) {
        throw new TypeError('thresh 需要有限数值 v/hi/lo');
      }
      emit(prog, OP.PUSHNUM, Number(n.v));
      emit(prog, OP.THRESH, hi, lo);
      return;
    }
    case NODE.SEQ: {
      // 顺序执行取 b：先跑 a，再把 a 的结果弹掉，最后压 b。
      // 没有 POP 指令，但 JZ 会先弹值再决定跳不跳 —— 把目标设成“JZ 的下一条”，
      // 两个分支都落到同一处，等价于无条件弹栈。这样栈深不会漂移，
      // 嵌套在 AND/OR 里也不会把操作数错位。
      compileNode(n.a, prog);
      const drop = emit(prog, OP.JZ, 0);
      patch(prog, drop, drop + 2);
      compileNode(n.b, prog);
      return;
    }
    case NODE.IFZ: {
      // cond 为 0 走 then：JZ 正好是“为零则跳”。
      compileNode(n.cond, prog);
      const jz = emit(prog, OP.JZ, 0);
      compileNode(n.else, prog);
      const jmp = emit(prog, OP.JMP, 0);
      const thenAt = prog.length;
      compileNode(n.then, prog);
      patch(prog, jz, thenAt);
      patch(prog, jmp, prog.length);
      return;
    }
    case NODE.IF: {
      // cond 非 0 走 then：JNZ 是“非零则跳”。
      compileNode(n.cond, prog);
      const jnz = emit(prog, OP.JNZ, 0);
      compileNode(n.else, prog);
      const jmp = emit(prog, OP.JMP, 0);
      const thenAt = prog.length;
      compileNode(n.then, prog);
      patch(prog, jnz, thenAt);
      patch(prog, jmp, prog.length);
      return;
    }
    default:
      throw new TypeError('未知 AST 节点类型：' + n.t);
  }
}

/**
 * 编译一个 AST。
 * @param {object} ast 根节点
 * @returns {number[]} 以 HALT 结尾的扁平字节码
 */
export function compile(ast) {
  const prog = [];
  compileNode(ast, prog);
  emit(prog, OP.HALT);
  return remapJumps(prog);
}

/**
 * 把跳转参数从「字节偏移」重写成「指令下标」。
 *
 * 为什么必须有这一步：compileNode 里 emit 返回的是 prog.length（字节偏移），
 * patch 也是按字节偏移回填的；而 L3 的 run 把字节流解码成 (opcode, arg) 数组之后，
 * pc 走的是**指令下标**。两边单位不同 —— 实测 200 组随机 AST 里 70 组算错，
 * 报错形如「跳转目标越界: 10，指令数=6」或「栈下溢」。
 *
 * 两个独立 AI（doubao 写 L4、codebuddy 写 L3）各自的单测都绿，拼起来错 35%，
 * 就是这个单位差。契约里我只写了「跳转目标是 1 字节」，没写单位。
 */
function remapJumps(prog) {
  // L4 自己的编码规则：这些操作码后面跟参数，跟几个要分开数。
  const ARG_LEN = new Map([
    [OP.PUSH, 1], [OP.JMP, 1], [OP.JZ, 1], [OP.JNZ, 1],
    [OP.LOAD, 1], [OP.STORE, 1],
    [OP.PUSHNUM, 1], [OP.THRESH, 2],
  ]);
  const byteToIdx = new Map();
  let i = 0; let idx = 0;
  while (i < prog.length) {
    byteToIdx.set(i, idx);
    const op = prog[i];
    i += 1 + (ARG_LEN.get(op) || 0);
    idx += 1;
  }
  const out = prog.slice();
  for (const [at, target] of byteToIdx) {
    const op = out[at];
    if (op !== OP.JMP && op !== OP.JZ && op !== OP.JNZ) continue;
    const t = prog[at + 1];
    // 目标可能是「程序末尾之后一位」（patch(prog, jmp, prog.length) 表示跳出），
    // 那就映射成「最后一条指令的下一个下标」。
    const mapped = byteToIdx.has(t) ? byteToIdx.get(t) : (t === prog.length ? idx : null);
    if (mapped == null) throw new RangeError('跳转目标 ' + t + ' 不落在任何指令边界上（指令下标 ' + byteToIdx.get(at) + '）');
    out[at + 1] = mapped;
  }
  return out;
}

/** 三值逻辑的数值实现（与文档字符串一一对应）。 */
function tritAnd(a, b) {
  if (a === -1 || b === -1) return -1;
  if (a === 1 && b === 1) return 1;
  return 0;
}

function tritOr(a, b) {
  if (a === 1 || b === 1) return 1;
  if (a === -1 && b === -1) return -1;
  return 0;
}

/**
 * 适配层：把 vm/machine.mjs 的执行结果挑成 judge 要的形状。
 * 语义唯一来源就是 machine.mjs：PUSHNUM 写数值槽、THRESH 读该槽压 trit。
 *
 * @param {number[]} program
 * @param {{maxSteps?:number}} [opts]
 * @returns {{value:number, steps:number, halted:boolean, stack:number[], num:number}}
 */
export function runWithCompiler(program, opts = {}) {
  // 只留一个解释器：执行一律交给 vm/machine.mjs。
  // 为什么改：这里原本自带一份解释器，与 machine.mjs 各写一遍 THRESH/PUSHNUM/JZ 的语义，
  // 两边一旦不同步，compile 出来的字节码只能在这里跑通、在真 VM 里报未知操作码，
  // 而测试又都走这里 —— 于是「28/28 全绿」和「atwo judge 每次必失败」同时成立。
  if (!Array.isArray(program) || !program.length) throw new TypeError('program 必须是非空 number[]');
  const r = runMachine(program, opts);
  if (r.error) throw new TypeError(r.error);
  return {
    value: r.stack.length ? r.stack[r.stack.length - 1] : 0,
    steps: r.steps,
    halted: r.halted,
    stack: r.stack.slice(),
    num: r.num,
  };

}
