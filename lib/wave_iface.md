/**
 * 返回所有条目的金额总额（price × qty 累加）。
 * @param {Array<{ price: number; qty: number }>} items - 订单条目数组
 * @returns {number} 金额总额
 */
export function orderTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

/**
 * 返回条目数量。
 * @param {Array<{ price: number; qty: number }>} items - 订单条目数组
 * @returns {number} 条目数量
 */
export function orderCount(items) {
  return items.length;
}
