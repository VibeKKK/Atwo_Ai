/**
 * 把一条任务渲染成单行纯文本，供终端表格之外的场景复用。
 *
 * 序号按 3 位右对齐（不足补空格，超出不截断）；done 为真时显示
 * `[x]`，否则显示 `[ ]`；三段之间固定用 ` | ` 分隔。输出不带
 * ANSI 颜色，也不做中文显示宽度补齐，便于管道、日志与断言比较。
 *
 * 边界说明：index 允许数字或字符串；text 为 null/undefined 时按空串
 * 处理，其余类型会被转成字符串；文本按原样拼接，调用方需保证其中
 * 不含换行。本函数不读写文件、不引入任何依赖。
 *
 * @param {number|string} index - 任务序号，通常从 1 开始
 * @param {string} text - 任务内容
 * @param {boolean} done - 是否已完成
 * @returns {string} 形如 '  1 | [x] | 买牛奶' 的一行字符串
 * @example
 * formatLine(1, '买牛奶', true);    // '  1 | [x] | 买牛奶'
 * formatLine(12, '写周报', false);  // ' 12 | [ ] | 写周报'
 */
export function formatLine(index, text, done) {
  const number = String(index ?? '').padStart(3, ' ');
  const mark = done ? '[x]' : '[ ]';
  const content = text == null ? '' : String(text);
  return `${number} | ${mark} | ${content}`;
}
