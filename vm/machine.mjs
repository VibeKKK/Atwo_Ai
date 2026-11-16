// file: vm/machine.mjs
export const OP = { PUSH: 1, AND: 2, OR: 3, NOT: 4, JMP: 5, JZ: 6, JNZ: 7, HALT: 8, LOAD: 9, STORE: 10, THRESH: 11, PUSHNUM: 0x0C };

const tri = (v) => (v === -1 || v === 255 ? -1 : v === 1 ? 1 : v === 0 ? 0 : null);
// THRESH(11) 与 PUSHNUM(12) 是 L4 编译器用的：thresh 带 hi/lo 两个数值参数，
// pushnum 带一个数值参数。任务里给 L3 的 THRESH 写的是「无参数、v>0?1:-1」，
// 而给 L4 的 thresh 写的是「v 与 hi/lo 比」—— 同一份契约自己跟自己打架。
// 结果是 L3 把 hi/lo 当成两条独立指令，后续全部错位。以 L4 的数值语义为准，L3 认参数。
const ARG_LEN = new Map([[OP.PUSH, 1], [OP.JMP, 1], [OP.JZ, 1], [OP.JNZ, 1], [OP.LOAD, 1], [OP.STORE, 1], [0x0C, 1], [OP.THRESH, 2]]);
const hasArg = (op) => ARG_LEN.has(op);

export function run(program, opts = {}) {
  const stack = [], regs = {};
  let pc = 0, steps = 0, halted = false, error = null, num = 0;

  const finish = () => ({
    halted,
    result: stack.length ? stack[stack.length - 1] : null,
    stack: stack.slice(),
    steps,
    regs: Object.assign({}, regs),
    num,
    error,
  });

  try {
    // 不能转 Uint8Array：L4 的字节码里有浮点操作数（0.45 / 0.22 / 信度值），
    // Uint8Array.from 会把 0.45 截成 0 —— 于是 num 永远是 0，THRESH 全部按 0 比较。
    // 保留原数组（只读）；传入 Uint8Array 的旧用法仍然成立。
    const code = Array.isArray(program) ? program : Array.from(program);
    const maxSteps = opts.maxSteps == null ? 10000 : opts.maxSteps;
    const init = opts.regs || {};
    for (const k of Object.keys(init)) {
      const v = tri(init[k]);
      regs[k] = v === null ? 0 : v;
    }

    // 解码：每条指令带「若干」操作数（THRESH 要两个，早先只支持一个，导致
    // [11,hi,lo] 被当成两条指令，hi/lo 变成操作码 —— 实测报了「未知操作码 11」）。
    const ops = [], args = [];
    for (let i = 0; i < code.length; ) {
      const op = code[i++];
      const want = ARG_LEN.get(op) || 0;
      if (i + want > code.length) { error = `指令 ${ops.length}（操作码 ${op}）缺少操作数字节`; break; }
      const list = [];
      for (let k = 0; k < want; k += 1) list.push(code[i++]);
      args.push(list);
      ops.push(op);
    }

    while (halted === false && error === null) {
      if (pc < 0 || pc >= ops.length) {
        error = `指令下标越界: pc=${pc}，指令数=${ops.length}（程序可能缺少 HALT）`;
        break;
      }
      if (steps >= maxSteps) {
        error = `超过最大步数 ${maxSteps}，程序未停机`;
        break;
      }
      steps += 1;
      const op = ops[pc], arg = args[pc];
      pc += 1;
      const pop = () => {
        if (stack.length === 0) { error = `栈下溢: 操作码 ${op} 从空栈取数`; return 0; }
        return stack.pop();
      };
      const jump = (t) => {
        if (t < 0 || t >= ops.length) error = `跳转目标越界: ${t}，指令数=${ops.length}`;
        else pc = t;
      };

      switch (op) {
        case OP.PUSH: {
          const v = tri(arg[0]);
          if (v === null) error = `PUSH 常量非法: ${arg}（只允许 0 / 1 / 255）`;
          else stack.push(v);
          break;
        }
        case OP.AND:
        case OP.OR: {
          const b = pop(), a = pop();
          if (error !== null) break;
          stack.push(op === OP.AND ? Math.min(a, b) : Math.max(a, b));
          break;
        }
        case OP.NOT: {
          const a = pop();
          if (error !== null) break;
          stack.push(a === 0 ? 0 : -a);
          break;
        }
        case OP.JMP: {
          jump(arg[0]);
          break;
        }
        case OP.JZ:
        case OP.JNZ: {
          const v = pop();
          if (error !== null) break;
          // 语义按 L4 编译器的实际用法定：JZ = 值为 0（未知）时跳，JNZ = 值非 0 时跳。
          // 任务文档里给 L3 写的是「JZ 确定真(+1)时跳、未知不跳」，给 L4 的 ifz 却是
          // 「cond 为 0 走 then，用 JZ 实现」—— 两边对 JZ 的定义相反，实测 ifz 分支全走反。
          // 以 L4 为准：Kleene 语义下「未知走 then」是保守分支，也是常规 jz 的含义。
          if (op === OP.JZ ? v === 0 : v !== 0) jump(arg[0]);
          break;
        }
        case OP.HALT: {
          halted = true;
          break;
        }
        case OP.LOAD: {
          const v = tri(regs[arg[0]]);
          stack.push(v === null ? 0 : v);
          break;
        }
        case OP.STORE: {
          const v = pop();
          if (error !== null) break;
          regs[arg[0]] = v;
          break;
        }
        case OP.THRESH: {
          // L4 的语义：读数值槽（PUSHNUM 写的），与 hi/lo 比，压三值。
          // 旧 L3 文档写的是「弹一个三值判正负」—— 两者不可兼得，以 L4 为准：
          // 否则 hi/lo 两个操作数根本没被消费，整条判定链路算不出结果。
          const hi = arg[0], lo = arg[1];
          stack.push(num >= hi ? 1 : (num < lo ? -1 : 0));
          break;
        }
        case OP.PUSHNUM: {
          num = arg[0];
          break;
        }
        default: {
          error = `未知操作码 ${op}（指令下标 ${pc - 1}）`;
          break;
        }
      }
    }
  } catch (e) {
    halted = false;
    if (error === null) error = `虚拟机内部错误: ${e && e.message ? e.message : String(e)}`;
  }

  return finish();
}
