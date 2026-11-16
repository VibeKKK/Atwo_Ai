# wave_order.mjs 测试用例清单

上游实现：`lib/wave_order.mjs`

导出函数（与实现完全一致，无其他函数）：

- `orderTotal(items)`：`items.reduce((sum, item) => sum + item.price * item.qty, 0)`，返回 `price × qty` 的累加总额，空数组返回 `0`。
- `orderCount(items)`：`items.length`，返回条目数量。

实现边界说明：两个函数都不做入参校验、不做正负过滤、不做取整或数量钳制；负数会按数学规则直接参与计算或计数。用例均只调用上面两个真实存在的函数名。

## 测试用例

| 编号 | 函数 | 输入 | 预期结果 | 覆盖边界 |
| --- | --- | --- | --- | --- |
| TC-01 | `orderTotal` | `[]` | `0` | 空数组：`reduce` 使用初值 `0`，不抛异常 |
| TC-02 | `orderCount` | `[]` | `0` | 空数组：长度为 `0` |
| TC-03 | `orderTotal` | `[{ price: 100, qty: 0 }]` | `0` | 零数量：乘积累加为 `0`，条目仍然计入 `orderCount` |
| TC-04 | `orderCount` | `[{ price: 100, qty: 0 }]` | `1` | 零数量：数量为 0 的条目不会被过滤，长度仍为 `1` |
| TC-05 | `orderTotal` | `[{ price: 100, qty: -2 }]` | `-200` | 负数：负数量不钳制，直接产生负金额 |
| TC-06 | `orderTotal` | `[{ price: -50, qty: 2 }]` | `-100` | 负数：负单价不校验，直接累加为负值 |
| TC-07 | `orderTotal` | `[{ price: 100, qty: 2 }, { price: 50, qty: -1 }]` | `150` | 正负混合：`200 + (-50)`，负数条目参与抵扣 |
| TC-08 | `orderTotal` | `[{ price: 0.1, qty: 3 }]` | `0.30000000000000004` | 浮点精度：按 IEEE-754 双精度直接相乘累加，不做四舍五入 |
| TC-09 | `orderCount` | `[{ price: 10, qty: 1 }, { price: 20, qty: 2 }, { price: 30, qty: -1 }]` | `3` | 常规多条目：计数与金额无关，负数数量条目也计入 |

## 备注

- 空数组、零数量、负数（负单价与负数量）均已覆盖。
- 实现没有对 `null`/`undefined` 入参做防御，此类输入不在本清单的正常用例范围内；如需覆盖应单独确认为异常用例，预期抛出 `TypeError`（由 `reduce`/`items.length` 访问产生）。
