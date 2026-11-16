// 三值机统一出口 —— 四层是四个不同的 AI 并行写的，这里只做重命名与再导出，不加任何逻辑。
//
// 为什么要这一层：四层各自导出的名字有冲突（machine 与 compiler 都有一个 OP），
// 直接 `export *` 会让后者静默覆盖前者 —— 调用方拿到哪个 OP 取决于 import 顺序，
// 这种 bug 只在运行时显形，而且看起来像「虚拟机不认某条指令」。
//
// 名字定死，谁改了要在这里显式改，不许靠顺序。

// L1 三值算术（trit 的进位制表示）
export {
  toTrits, fromTrits, addTrits, negTrits, mulTrits, roundTrits, formatTrits,
} from './ternary.mjs';

// L2 Kleene 三值逻辑
export {
  T, F, U, and3, or3, not3, implies3, equiv3, truthTable, isKnown,
} from './logic.mjs';

// L3 栈式虚拟机（OP 改名，避免与 L4 的 OP 撞）
export { OP as MACHINE_OP, run } from './machine.mjs';

// L4 编译器与判定（OP 改名）
export { OP as COMPILER_OP, NODE, compile } from './compiler.mjs';

// 判定层：置信度 → 三值
export { judge, computeConfidence, verdictOf } from './judge.mjs';
