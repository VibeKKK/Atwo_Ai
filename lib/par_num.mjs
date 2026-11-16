/**
 * par_num.mjs —— 数字格式化工具（Node ESM，只用内置能力）。
 *
 * 三个导出函数共用一套输入约定：
 * - 只接受 number 类型的有限值；NaN、Infinity、null、undefined、字符串等一律抛 TypeError。
 * - 绝对值超过 Number.MAX_SAFE_INTEGER 的输入抛 RangeError：此时数字本身已无法精确表示，
 *   继续格式化只会输出不可信的结果，所以选择显式失败而不是静默给个错数。
 * - 负数不丢符号，按原值加 "-" 前缀输出（例如 -1536 → "-1.5 KB"）。
 * - -0 与 0 等价处理，输出不带负号。
 *
 * 不引第三方包，也不依赖 Intl，保证任意 Node 版本下输出完全一致。
 */

/** 字节单位表，1024 进制逐级递进。 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

/**
 * 校验入参是有限数字，否则按具体类型抛出可读错误。
 * @param {unknown} value 待校验的值
 * @param {string} name 参数名，用于错误信息
 * @returns {number} 校验通过的原值
 */
function assertFiniteNumber(value, name) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} 必须是有限数字，收到 ${String(value)}`);
    }
    return value;
  }
  if (value === null || value === undefined) {
    throw new TypeError(`${name} 不能为空，收到 ${String(value)}`);
  }
  throw new TypeError(`${name} 必须是数字，收到 ${typeof value}：${String(value)}`);
}

/**
 * 校验绝对值未超出安全整数范围，避免对已经丢失精度的数字做格式化。
 * @param {number} value 已确认为有限数字的值
 * @param {string} name 参数名，用于错误信息
 * @returns {number} 校验通过的原值
 */
function assertSafeRange(value, name) {
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} 超出安全整数范围（±${Number.MAX_SAFE_INTEGER}）`);
  }
  return value;
}

/**
 * 四舍五入到一位小数，并把 -0 归一成 0，防止出现 "-0.0"。
 * @param {number} value 非负有限数字
 * @returns {number} 一位小数的结果
 */
function roundToTenth(value) {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/**
 * 把字节数格式化成人类可读的字符串，1024 进制，KB 及以上保留一位小数。
 *
 * 边界处理：
 * - 0（含 -0）→ "0 B"，不走小数分支。
 * - 负数保留符号，按绝对值选单位：-1536 → "-1.5 KB"。
 * - 非整数字节抛 TypeError，字节本身没有小数含义，避免隐式取整。
 * - 超出安全整数抛 RangeError，理由见文件头。
 * - 低位进位到 1024.0 时自动升一级，例如 1048575 → "1.0 MB"，不会出现 "1024.0 KB"。
 *
 * @param {number} n 字节数，必须是安全范围内的整数
 * @returns {string} 形如 "0 B" / "1.5 KB" / "2.0 GB" 的字符串
 * @example
 * formatBytes(1536); // "1.5 KB"
 * formatBytes(0);    // "0 B"
 */
export function formatBytes(n) {
  const value = assertSafeRange(assertFiniteNumber(n, 'formatBytes 的 n'), 'formatBytes 的 n');
  if (!Number.isInteger(value)) {
    throw new TypeError(`formatBytes 的 n 必须是整数字节，收到 ${value}`);
  }
  if (value === 0) {
    return '0 B';
  }
  const sign = value < 0 ? '-' : '';
  let abs = Math.abs(value);
  let unitIndex = 0;
  while (abs >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    abs /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${sign}${abs} B`;
  }
  let scaled = roundToTenth(abs);
  if (scaled >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    scaled = roundToTenth(scaled / 1024);
    unitIndex += 1;
  }
  return `${sign}${scaled.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * 把毫秒数格式化成人类可读的时长，粒度到分钟（不输出小时）。
 *
 * 边界处理：
 * - 0（含 -0）→ "0毫秒"。
 * - 负数保留符号：-3500 → "-3.5秒"。
 * - 小于 1000 毫秒按整数毫秒输出，0.4 毫秒这类小数四舍五入，不出现 "0.4毫秒"。
 * - 1000~59999 毫秒按秒输出，一位小数且整数秒省略小数位：5000 → "5秒"。
 *   因舍入变成 60 秒的（如 59999）提升为 "1分0秒"，不输出 "60秒"。
 * - 60000 毫秒及以上输出 "X分Y秒"，秒取整且由取模得出，不会出现 "1分60秒"。
 * - 非数字抛 TypeError，超出安全整数抛 RangeError。
 *
 * @param {number} ms 毫秒数
 * @returns {string} 形如 "600毫秒" / "3.5秒" / "1分30秒" 的字符串
 * @example
 * formatDuration(90000); // "1分30秒"
 * formatDuration(3500);  // "3.5秒"
 */
export function formatDuration(ms) {
  const value = assertSafeRange(assertFiniteNumber(ms, 'formatDuration 的 ms'), 'formatDuration 的 ms');
  if (value === 0) {
    return '0毫秒';
  }
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) {
    return `${sign}${Math.round(abs)}毫秒`;
  }
  if (abs < 60000) {
    const seconds = roundToTenth(abs / 1000);
    if (seconds >= 60) {
      return `${sign}1分0秒`;
    }
    const text = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
    return `${sign}${text}秒`;
  }
  const totalSeconds = Math.round(abs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${minutes}分${seconds}秒`;
}

/**
 * 把 0~1 的小数格式化成百分比字符串。
 *
 * 边界处理：
 * - 0（含 -0）→ 按位数输出 "0.0%"（digits=0 时为 "0%"）。
 * - x 不在 [0, 1] 内抛 RangeError：负数与 >1 都不属于本函数的定义域，
 *   静默截断会把真正的数据错误藏起来。
 * - digits 省略时默认 1。
 * - digits 为 0 时不留小数点：0.856 → "86%"。
 * - digits 必须是非负整数且不超过 20（toFixed 的上限），否则抛 RangeError；
 *   digits 为非数字抛 TypeError。
 * - 非数字 x 抛 TypeError，NaN / null / 字符串都不会被当成 0 处理。
 * - 0.9996 这类值四舍五入后允许出现 "100.0%"，不做 99.9 截断。
 *
 * @param {number} x 0 到 1 之间的比例值
 * @param {number} [digits=1] 小数位数，0~20 的整数
 * @returns {string} 形如 "85.6%" 的字符串
 * @example
 * formatPercent(0.856, 1); // "85.6%"
 * formatPercent(0.856, 0); // "86%"
 */
export function formatPercent(x, digits = 1) {
  const value = assertFiniteNumber(x, 'formatPercent 的 x');
  if (value < 0 || value > 1) {
    throw new RangeError(`formatPercent 的 x 必须在 0~1 之间，收到 ${value}`);
  }
  if (typeof digits !== 'number') {
    throw new TypeError(`formatPercent 的 digits 必须是数字，收到 ${typeof digits}`);
  }
  if (!Number.isInteger(digits) || digits < 0 || digits > 20) {
    throw new RangeError(`formatPercent 的 digits 必须是 0~20 的整数，收到 ${digits}`);
  }
  return `${(value * 100).toFixed(digits)}%`;
}
