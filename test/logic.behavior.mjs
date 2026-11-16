// ============================================================================
// test/logic.behavior.mjs — vm/logic.mjs 行为自测
// 导出 cases：[{ name, run }]，run 抛错即视为该用例失败
// 覆盖：两个关键格、全部 9 格 × 5 个运算、德摩根律、非法输入抛错
// ============================================================================
import {
  T, F, U,
  and3, or3, not3, implies3, equiv3,
  truthTable, isKnown,
} from '../vm/logic.mjs';

// —— 断言助手 ——
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertTypeError(fn, label, valueText) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, `${label}: 应抛错却正常返回`);
  assert(
    threw instanceof TypeError,
    `${label}: 应抛 TypeError，实际是 ${threw?.constructor?.name}: ${threw?.message}`
  );
  assert(
    String(threw.message).includes(valueText),
    `${label}: 错误信息应包含非法值 "${valueText}"，实际是 "${threw.message}"`
  );
}

// —— 期望的 Kleene 真值表（行 = a，列 = b，顺序 [F, U, T]）——
const EXPECT = {
  and3: [
    [F, F, F],
    [F, U, U],
    [F, U, T],
  ],
  or3: [
    [F, U, T],
    [U, U, T],
    [T, T, T],
  ],
  not3: [T, U, F],
  implies3: [ // a → b = (NOT a) OR b
    [T, T, T], // a = F：NOT F = T，T OR 任何 = T
    [U, U, T], // a = U：NOT U = U，U OR F = U、U OR U = U、U OR T = T
    [F, U, T], // a = T
  ],
  equiv3: [
    [T, U, F],
    [U, U, U],
    [F, U, T],
  ],
};

const VALUES = [F, U, T];
const NAME = { [F]: 'F', [U]: 'U', [T]: 'T' };
const BIN = { and3, or3, implies3, equiv3 };

// —— 用例收集 ——
const cases = [];
const add = (name, run) => cases.push({ name, run });

// 1. 两个关键格：三值逻辑区别于三态枚举的全部意义
add('关键格 and3(U, F) === F', () => {
  assert(and3(U, F) === F, `and3(U, F) = ${and3(U, F)}，应为 F(-1)`);
});
add('关键格 or3(U, T) === T', () => {
  assert(or3(U, T) === T, `or3(U, T) = ${or3(U, T)}，应为 T(+1)`);
});

// 2. 全部 9 格 × 4 个二元运算（and3 / or3 / implies3 / equiv3）
for (const op of Object.keys(BIN)) {
  for (const a of VALUES) {
    for (const b of VALUES) {
      add(`${op}(${NAME[a]}, ${NAME[b]})`, () => {
        const got = BIN[op](a, b);
        const want = EXPECT[op][a + 1][b + 1];
        assert(got === want, `${op}(${NAME[a]}, ${NAME[b]}) = ${NAME[got]}，应为 ${NAME[want]}`);
      });
    }
  }
}

// 3. not3 的全部 3 格（与上面合起来覆盖全部 5 个运算）
for (const a of VALUES) {
  add(`not3(${NAME[a]})`, () => {
    const got = not3(a);
    const want = EXPECT.not3[a + 1];
    assert(got === want, `not3(${NAME[a]}) = ${NAME[got]}，应为 ${NAME[want]}`);
  });
}

// 4. 德摩根律：NOT (a AND b) === (NOT a) OR (NOT b)，对 9 组全成立
for (const a of VALUES) {
  for (const b of VALUES) {
    add(`德摩根 ¬(${NAME[a]} ∧ ${NAME[b]}) = ¬${NAME[a]} ∨ ¬${NAME[b]}`, () => {
      const lhs = not3(and3(a, b));
      const rhs = or3(not3(a), not3(b));
      assert(lhs === rhs, `左边 ${NAME[lhs]} ≠ 右边 ${NAME[rhs]}`);
    });
  }
}

// 5. 非法输入抛 TypeError，且错误信息带非法值
add('and3(2, T) 抛 TypeError（带非法值 2）', () => {
  assertTypeError(() => and3(2, T), 'and3(2, T)', '2');
});
add('or3(null, F) 抛 TypeError（带非法值 null）', () => {
  assertTypeError(() => or3(null, F), 'or3(null, F)', 'null');
});
add('not3("x") 抛 TypeError（带非法值 x）', () => {
  assertTypeError(() => not3('x'), `not3("x")`, 'x');
});
add('implies3(0.5, T) 抛 TypeError（带非法值 0.5）', () => {
  assertTypeError(() => implies3(0.5, T), 'implies3(0.5, T)', '0.5');
});
add('equiv3(undefined, T) 抛 TypeError（带非法值 undefined）', () => {
  assertTypeError(() => equiv3(undefined, T), 'equiv3(undefined, T)', 'undefined');
});
add('and3(T, NaN) 抛 TypeError（带非法值 NaN）', () => {
  assertTypeError(() => and3(T, NaN), 'and3(T, NaN)', 'NaN');
});

// 6. truthTable 生成的表与期望真值表一致（自检工具本身）
add('truthTable(and3) 与期望 AND 表一致', () => {
  const table = truthTable(and3);
  assert(JSON.stringify(table) === JSON.stringify(EXPECT.and3),
    `truthTable(and3) = ${JSON.stringify(table)}，应为 ${JSON.stringify(EXPECT.and3)}`);
});

// 7. isKnown：0 未知、±1 已知
add('isKnown(U) === false', () => {
  assert(isKnown(U) === false, `isKnown(U) = ${isKnown(U)}，应为 false`);
});
add('isKnown(T) 与 isKnown(F) 均为 true', () => {
  assert(isKnown(T) === true && isKnown(F) === true,
    `isKnown(T) = ${isKnown(T)}，isKnown(F) = ${isKnown(F)}，均应为 true`);
});

export { cases };
