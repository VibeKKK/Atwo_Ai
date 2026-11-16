/**
 * @file lib/par_num3.mjs
 * @description 数字格式化工具（Node ESM），提供字节、时长、百分比三种格式化。
 *
 * 统一边界约定（各函数不再重复）：
 *   1. 非法输入（NaN / Infinity / 非 number / 非有限值）返回占位符 '—'，
 *      不抛异常，便于在表格里直接渲染。
 *   2. 负数：字节与时长按「带符号绝对值」处理（保留 '-' 前缀）；百分比
 *      允许为负，表示下降/亏损。
 *   3. 零值：0 字节 -> '0 B'；0 毫秒 -> '0s'；total 为 0 -> '—'（避免除零）。
 *   4. 字节用 1024 进制（磁盘/内存惯例），标签写 KB/MB/...；改 BYTE_BASE
 *      即可切换到 1000 进制。
 *   5. 小数用 toFixed（有浮点精度限制）；digits 夹到 [0, 6]。
 *
 * @author codebuddy
 * @license MIT
 */

/** 字节换算进制。 */
const BYTE_BASE = 1024;

/** 单位标签，索引与换算级数对应。 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 非法输入的统一占位符。 */
const INVALID = '—';

/**
 * 仅接受有限 number；字符串数字、null、undefined 等一律视为非法。
 * @param {*} v 待检测值
 * @returns {boolean} 是否为有限 number
 */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 去掉小数尾部多余的 0：'12.50' -> '12.5'，'12.00' -> '12'。
 * @param {string} s toFixed 结果
 * @returns {string} 精简后的字符串
 */
function trimTrailingZeros(s) {
  // parseFloat 会去掉小数尾部多余的 0：'12.50' -> 12.5 -> '12.5'
  return String(parseFloat(s));
}

/**
 * 字节数转人类可读字符串（B/KB/MB/GB/TB）。
 *
 * 边界：
 *   - 非有限 number -> '—'；n === 0 -> '0 B'。
 *   - 负数取绝对值换算并保留 '-'，如 -2048 -> '-2 KB'。
 *   - 量级封顶到 TB，不进位到 PB。
 *   - B 不保留小数；其余单位最多 2 位小数并去掉尾部多余的 0。
 *
 * @param {number} n 字节数
 * @returns {string} 如 '1.5 MB' / '0 B' / '—'
 * @example
 *   formatBytes(0)        // '0 B'
 *   formatBytes(1536)     // '1.5 KB'
 *   formatBytes(-2048)    // '-2 KB'
 *   formatBytes(Infinity) // '—'
 */
export function formatBytes(n) {
  if (!isFiniteNumber(n)) return INVALID;
  if (n === 0) return '0 B';

  const sign = n < 0 ? '-' : '';
  let value = Math.abs(n);
  let unitIndex = 0;

  // 逐级除以 1024，直到落入当前量级或到达最大单位 TB。
  while (value >= BYTE_BASE && unitIndex < BYTE_UNITS.length - 1) {
    value /= BYTE_BASE;
    unitIndex += 1;
  }

  const unit = BYTE_UNITS[unitIndex];
  let text;
  if (unitIndex === 0) {
    text = String(Math.round(value)); // 字节单位四舍五入到整数
  } else {
    text = trimTrailingZeros(value.toFixed(2));
  }
  return `${sign}${text} ${unit}`;
}

/**
 * 毫秒转「时分秒」字符串。
 *
 * 边界：
 *   - 非有限 number -> '—'；ms === 0 -> '0s'。
 *   - 负数取绝对值并保留 '-'，如 -90000 -> '-1m 30s'。
 *   - 不足 1 秒四舍五入到整秒，故 999ms -> '1s'；1ms -> '0s'。
 *   - 值为 0 的段省略：1 小时 0 分 5 秒 -> '1h 5s'。
 *   - 超过 24 小时不折叠成天，仍累计小时，如 25h。
 *
 * @param {number} ms 毫秒数
 * @returns {string} 如 '1h 2m 3s' / '0s' / '—'
 * @example
 *   formatDuration(0)        // '0s'
 *   formatDuration(3661000)  // '1h 1m 1s'
 *   formatDuration(999)      // '1s'
 *   formatDuration(-90000)   // '-1m 30s'
 */
export function formatDuration(ms) {
  if (!isFiniteNumber(ms)) return INVALID;
  if (ms === 0) return '0s';

  const sign = ms < 0 ? '-' : '';
  const totalSeconds = Math.round(Math.abs(ms) / 1000); // 先取整秒
  if (totalSeconds === 0) return '0s'; // 如 1ms 四舍五入后回到 0

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  if (parts.length === 0) return '0s'; // 兜底，防御未来改动

  return `${sign}${parts.join(' ')}`;
}

/**
 * 计算 part 占 total 的百分比。
 *
 * 边界：
 *   - part / total 非有限 number，或 digits 非有限数 -> '—'。
 *   - total === 0 -> '—'（除零无意义）。
 *   - part 为负 -> 负百分比，如 -1/4 -> '-25%'。
 *   - part > total 不封顶，可超过 100%（超额完成率）。
 *   - digits 夹到 [0, 6] 并向下取整；省略时默认 0。
 *   - 使用 toFixed，极小值可能显示 '0%'。
 *
 * @param {number} part 分子
 * @param {number} total 分母
 * @param {number} [digits=0] 小数位数，范围 [0, 6]
 * @returns {string} 如 '25%' / '33.33%' / '—'
 * @example
 *   formatPercent(1, 4)     // '25%'
 *   formatPercent(1, 3, 2)  // '33.33%'
 *   formatPercent(0, 0)     // '—'
 *   formatPercent(5, 4)     // '125%'
 */
export function formatPercent(part, total, digits = 0) {
  if (!isFiniteNumber(part) || !isFiniteNumber(total)) return INVALID;
  if (total === 0) return INVALID;
  if (!isFiniteNumber(digits)) return INVALID;

  const clamped = Math.min(6, Math.max(0, Math.trunc(digits)));
  const ratio = (part / total) * 100;
  return `${ratio.toFixed(clamped)}%`;
}
