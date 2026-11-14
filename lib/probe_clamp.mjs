/**

@file probe_clamp.mjs
@module probe-clamp
@description
供 probe 系列脚本复用的输入探测 / 归一化纯函数工具：
{@link clamp} 把数值夹逼到指定闭区间
{@link isBlank} 判断字符串是否不含可见内容
{@link chunk} 把数组按固定长度切成若干段
约定：不修改入参；非法入参抛 TypeError / RangeError，
不静默返回半结果，也不做隐式类型转换。
@example
import { clamp, isBlank, chunk } from './lib/probe_clamp.mjs';
clamp(12, 0, 10); // 10
isBlank(' \u3000\n '); // true
chunk([1, 2, 3, 4, 5], 2); // [[1, 2], [3, 4], [5]]
*/

/**

「空白」规则：\s 覆盖 JS 全部 Unicode 空白（空格、\t\n、NBSP \u00A0、
全角空格 \u3000、BOM \uFEFF 等），另补零宽字符 \u200B / \u200C /
\u200D / \u2060。锚定首尾；不带 g/y 标志，test 无 lastIndex 状态副作用。
@type {RegExp}
@private
/
const BLANK_RE = /^[\s\u200B\u200C\u200D\u2060]$/u;

/**

把任意值转成可安全拼进错误信息的短文本：不深度序列化，
避免 Symbol 拼接异常、循环引用或大对象拖慢报错路径。
@param {*} value 任意值。
@returns {string} 简短描述文本。
@private
*/
function formatValue(value) {
if (typeof value === 'string') {
return JSON.stringify(value);
}
if (typeof value === 'symbol') {
return value.toString();
}
if (typeof value === 'function') {
return [Function ${value.name || 'anonymous'}];
}
if (value === null || value === undefined) {
return String(value);
}
if (typeof value === 'object') {
if (Array.isArray(value)) {
return Array(${value.length});
}
return [object ${value.constructor?.name ?? 'Object'}];
}
return String(value);
}

/**

校验数值：必须是 number 且非 NaN；±Infinity 允许作为区间端点
（可表达只有上界 / 只有下界）。抽成内部函数以共享判定与文案。
@param {*} value 待校验的值。
@param {string} name 参数名，用于错误信息。
@returns {void}
@throws {TypeError} value 不是 number 或为 NaN。
@private
*/
function assertNumber(value, name) {
if (typeof value !== 'number' || Number.isNaN(value)) {
throw new TypeError(
${name} 必须是 number 且不能为 NaN，实际收到 ${formatValue(value)}
);
}
}

/**

校验分段长度：先走 assertNumber，再排除 0、负数、小数、±Infinity。
超大正整数只会让结果退化为「单段」，语义明确，故不额外限制。
@param {*} size 待校验的分段长度。
@returns {void}
@throws {TypeError} size 不是 number 或为 NaN。
@throws {RangeError} size 不是有限正整数。
@private
*/
function assertChunkSize(size) {
assertNumber(size, 'size');
if (!Number.isFinite(size) || !Number.isInteger(size) || size < 1) {
throw new RangeError(
size 必须是有限的正整数，实际收到 ${formatValue(size)}
);
}
}

/**

把数值 n 夹逼到闭区间 [lo, hi] 内：n < lo 返回 lo，n > hi 返回 hi，
区间内（含端点）原样返回 n，不做四舍五入或字符串化。
lo / hi 允许 ±Infinity；lo > hi 视为区间定义错误，不静默交换。
@param {number} n 待夹逼的数值，不能是 NaN。
@param {number} lo 区间下界（含）。
@param {number} hi 区间上界（含）。
@returns {number} 落在 [lo, hi] 内的数值。
@throws {TypeError} 任一参数不是 number，或为 NaN。
@throws {RangeError} lo > hi。
@example
clamp(-3, 0, 10); // 0
clamp(42, 0, 10); // 10
clamp(1e9, -Infinity, 1); // 1
*/
export function clamp(n, lo, hi) {
assertNumber(n, 'n');
assertNumber(lo, 'lo');
assertNumber(hi, 'hi');
if (lo > hi) {
throw new RangeError(
lo 不能大于 hi（lo=${formatValue(lo)}, hi=${formatValue(hi)}）
);
}
// 先抬到下界、再压到上界，天然覆盖 ±Infinity 端点。
return Math.min(Math.max(n, lo), hi);
}

/**

判断字符串是否为「空白」——即不含任何可见内容。
空串或全空白（含零宽字符 \u200B / \u200C / \u200D / \u2060）返回 true；
非字符串入参一律返回 true（同 StringUtils.isBlank 惯例），且刻意不做
String() 隐式转换，因此 isBlank(0) 为 true 而 isBlank('0') 为 false。
只做判定，不 trim、不分配新字符串。
@param {*} s 待检查的值，通常是字符串。
@returns {boolean} 空串 / 全空白 / 非字符串时返回 true，否则 false。
@example
isBlank(' \t\n\u3000 '); // true
isBlank('\u200B'); // true
isBlank(' a '); // false
isBlank(null); // true
*/
export function isBlank(s) {
if (typeof s !== 'string') {
return true;
}
return BLANK_RE.test(s);
}

/**

把数组按固定长度切成若干段，最后一段允许不足 size。
返回新数组，分段也是新数组（浅拷贝），源数组不被修改；空数组返回 []，
size >= arr.length 时返回单段；对象元素仍共享引用，稀疏空洞会保留。
size 必须是有限正整数：0、负数、小数、NaN、Infinity 均抛 RangeError。
@param {Array<*>} arr 源数组，不会被修改。
@param {number} size 每段的最大长度（正整数）。
@returns {Array<Array<*>>} 由若干分段组成的二维数组。
@throws {TypeError} arr 不是数组，或 size 不是数值。
@throws {RangeError} size 不是有限正整数。
@example
chunk([1, 2, 3, 4, 5], 2); // [[1, 2], [3, 4], [5]]
chunk([], 3); // []
chunk([1, 2], 10); // [[1, 2]]
*/
export function chunk(arr, size) {
if (!Array.isArray(arr)) {
throw new TypeError(arr 必须是数组，实际收到 ${formatValue(arr)});
}
assertChunkSize(size);
const result = [];
const length = arr.length;
// size 已校验为有限正整数，循环必然推进、不会死循环。
for (let start = 0; start < length; start += size) {
result.push(arr.slice(start, start + size));
}
return result;
}
查看所有产物 (1)
