// ============================================================================
// vm/logic.mjs — Kleene 三值逻辑（零依赖、表驱动）
// ============================================================================
//
// 值域约定：
//   +1 = 真（T）
//   -1 = 假（F）
//    0 = 未知（U）
//
// U 不是错误，是"没有信息"。它与确定的真/假组合时，能被确定值"吸收"的
// 就被吸收：U AND F 仍是 F（假吸收未知），U OR T 仍是 T（真吸收未知）。
// 这两格是三值逻辑区别于"三态枚举 + if 分支"的全部意义所在。
//
// 实现方式：所有二元运算查二维表、一元运算查一维表，不含真值分支堆叠。
// 查表索引用 idx = v + 1，把 {-1, 0, 1} 映射到下标 {0, 1, 2}。
// ============================================================================

export const T = 1;
export const F = -1;
export const U = 0;

// 合法值集合，用于入参校验（0 会作为普通值通过 Set 校验，靠 has 判断）
const VALID = new Set([T, F, U]);

// 值 → 下标：F/-1 → 0，U/0 → 1，T/+1 → 2
const idx = (v) => v + 1;

// 入参校验：非法输入抛 TypeError，错误信息中带上非法值本身
function checked(op, v) {
  if (!VALID.has(v)) {
    throw new TypeError(
      `Kleene ${op}: 非法逻辑值 ${String(v)}（类型 ${typeof v}），只接受 {-1, 0, 1}`
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// 二元真值表：行 = a，列 = b，行/列顺序均为 [F, U, T]
// ---------------------------------------------------------------------------

// AND：U AND F = F（关键格）、U AND T = U、U AND U = U
const AND = [
  [F, F, F], // a = F
  [F, U, U], // a = U
  [F, U, T], // a = T
];

// OR：U OR T = T（关键格）、U OR F = U、U OR U = U
const OR = [
  [F, U, T], // a = F
  [U, U, T], // a = U
  [T, T, T], // a = T
];

// NOT：NOT F = T、NOT U = U、NOT T = F
const NOT = [T, U, F];

// ---------------------------------------------------------------------------
// 运算导出（签名固定）
// ---------------------------------------------------------------------------

export function and3(a, b) {
  return AND[idx(checked('and3', a))][idx(checked('and3', b))];
}

export function or3(a, b) {
  return OR[idx(checked('or3', a))][idx(checked('or3', b))];
}

export function not3(a) {
  return NOT[idx(checked('not3', a))];
}

// IMPLIES：a → b 按 Kleene 定义等价于 (NOT a) OR b，不引入新表
export function implies3(a, b) {
  return or3(not3(a), b);
}

// EQUIV：a ↔ b 等价于 (a AND b) OR (NOT a AND NOT b)
// 同为 T 或同为 F 时为 T，有确定值且相异时为 F，其余为 U
export function equiv3(a, b) {
  return or3(and3(a, b), and3(not3(a), not3(b)));
}

// ---------------------------------------------------------------------------
// 工具导出
// ---------------------------------------------------------------------------

// 生成某二元运算的 3x3 真值表，行/列顺序均为 [F, U, T]，
// 返回形如 [[fn(F,F), fn(F,U), fn(F,T)], ...] 的二维数组，用于测试和展示
export function truthTable(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError(`truthTable: 需要传入函数，收到 ${String(fn)}`);
  }
  return [F, U, T].map((a) => [F, U, T].map((b) => fn(a, b)));
}

// 已知性判断：0（未知）之外都是带信息的值
export function isKnown(v) {
  return v !== 0;
}
