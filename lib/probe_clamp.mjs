/**
 * fix_clamp.mjs
 *
 * 一个不依赖第三方库的小工具模块，导出三个纯函数：
 * clamp、isBlank、chunk。三个函数都不会修改传入的参数，
 * 并且都带有完整的 JSDoc 注释，方便编辑器提示类型。
 *
 * @module fix_clamp
 */

/**
 * 构造统一的类型错误消息。
 *
 * 这里刻意使用模板字符串拼接消息，避免多段字符串相加，
 * 也让消息格式在整个模块内保持一致。
 *
 * @param {string} name 参数名或参数名的组合。
 * @param {string} expected 期望的类型或形状描述。
 * @param {*} actual 调用方实际传入的值。
 * @returns {string} 拼好的错误消息文本。
 */
function typeError(name, expected, actual) {
  const actualType = typeof actual;
  return `参数 ${name} 期望 ${expected}，实际收到 ${actualType}`;
}

/**
 * 把数值收敛到闭区间 [lo, hi]。
 *
 * 若 lo 大于 hi，区间会被自动调整为 [hi, lo]，
 * 这样调用方即使把上下界传反了也不会得到 NaN。
 * 传入 NaN 时返回下界，避免结果被污染成 NaN。
 *
 * @param {number} n 待限制的数值。
 * @param {number} lo 区间下界（包含）。
 * @param {number} hi 区间上界（包含）。
 * @returns {number} 落在区间内的数值。
 */
export function clamp(n, lo, hi) {
  if (typeof n !== 'number' || typeof lo !== 'number' || typeof hi !== 'number') {
    throw new TypeError(typeError('n / lo / hi', 'number', n));
  }

  const lower = Math.min(lo, hi);
  const upper = Math.max(lo, hi);

  if (Number.isNaN(n)) {
    return lower;
  }

  return Math.max(lower, Math.min(n, upper));
}

/**
 * 判断一个值是否属于「空白」内容。
 *
 * 空白定义为：null、undefined、空字符串，
 * 以及仅由空白字符（含全角空格）组成的字符串。
 * 其余类型会先转换成字符串再参与判断。
 *
 * @param {*} s 待判断的值。
 * @returns {boolean} 属于空白内容时返回 true，否则返回 false。
 */
export function isBlank(s) {
  if (s === null || s === undefined) {
    return true;
  }

  const text = String(s).replace(/\u3000/g, ' ');

  return text.trim().length === 0;
}

/**
 * 把数组按固定长度切分为若干子数组。
 *
 * 最后一块可能不足 size 个元素，仍会原样返回。
 * 传入空数组时返回空数组，原数组不会被原地修改。
 * size 会经由 clamp 收敛为不小于 1 的整数。
 *
 * @param {Array<*>} arr 待切分的数组。
 * @param {number} size 每块的最大长度。
 * @returns {Array<Array<*>>} 切分后的二维数组。
 */
export function chunk(arr, size) {
  if (!Array.isArray(arr)) {
    throw new TypeError(typeError('arr', 'array', arr));
  }

  const step = clamp(Math.floor(Number(size)), 1, Number.MAX_SAFE_INTEGER);

  const blocks = [];
  for (let i = 0; i < arr.length; i += step) {
    blocks.push(arr.slice(i, i + step));
  }

  return blocks;
}

/**
 * 模块自述对象，便于在调试或健康检查时输出模块信息。
 *
 * summary 使用模板字符串生成，接口清单与模块名都来自常量，
 * 这样修改接口时只需要更新 apis 一处。
 *
 * @type {{name: string, apis: Array<string>, summary: string}}
 */
export const moduleInfo = (() => {
  const name = 'fix_clamp';
  const apis = ['clamp', 'isBlank', 'chunk'];

  return {
    name,
    apis,
    summary: `模块 ${name} 共提供 ${apis.length} 个函数：${apis.join('、')}`,
  };
})();

/**
 * 默认导出：把工具函数聚合成一个对象，方便整体引入。
 *
 * 聚合对象里的键名与具名导出保持一致，
 * 调用方既可以按需引入，也可以一次性拿到全部能力。
 *
 * @returns {{clamp: Function, isBlank: Function, chunk: Function, info: Object}}
 *   包含三个函数与模块信息的对象。
 */
function createToolkit() {
  return {
    clamp,
    isBlank,
    chunk,
    info: moduleInfo,
  };
}

export default createToolkit();
