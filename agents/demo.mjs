// 自检：node --check agents/demo.mjs
/**
 * 接入新 agent 实操指南（docs/EXTENDING.md 的可执行注解版）。
 * 本文件既是可直接落地的适配器骨架，也是一份 120 行以上的中文指南；
 * 所有 JSDoc 只解释「为什么这么做」，不重复「做了什么」。
 *
 * 一、六步接入清单
 * 1. 新建 agents/<name>.mjs，导出 async ask<Name>(prompt, opts)。
 *    <Name> 是占位写法：真实名字必须是合法标识符，本例用 demo → askDemo，
 *    否则 node --check 会因 < 解析失败。命名规则：'ask' + 首字母大写的 name。
 * 2. 返回值字段固定为 {answer, code, notes, confidence, raw, ms,
 *    inputTokens, outputTokens}，缺项会破坏调用方的契约校验。
 * 3. 底层调用用 withLockPool(name, slots, fn) 包住，slots 是全局并发额度。
 * 4. 每次调用追加一行 memory/log.jsonl，成功与失败都要落盘用于审计。
 * 5. 调用前查 lib/budget.mjs，超预算直接抛错，禁止静默降级返回空串。
 * 6. 用 lib/contract.mjs 的 parseContract(raw) 与 lib/syntax.mjs 校验，
 *    未通过必须 throw Error，绝不返回空字符串。
 *
 * 在 orchestra.mjs 顶部登记：
 *   REGISTRY = { name: 'demo', label: '示例', ask: askDemo, slots: 1 };
 *   REGISTRY 的 {name, label, ask, slots} 四字段缺一不可。
 *
 * 二、三条坑
 * 坑一「怎么判定真答完」：不能只看非空。必须 parseContract 成功且
 *   validateSyntax 通过、拿到结构化 data，才算真答完。
 * 坑二「空回答 vs 思考中文案」：'正在思考' / '让我看一下' 这类中文过渡文案
 *   非空却不是答案。若失败返回空串，二者会被调用方混为一谈；
 *   因此失败一律 throw，由异常区分「没答」与「答错了」。
 * 坑三「slots 为什么保守」：slots 是跨调用共享的并发池额度，放大会在
 *   高峰期打爆上游限流，且日志/预算按并发累加难以追溯，故默认 1。
 *
 * 三、8 项验收清单
 * [ ] 1 导出名是合法标识符，形如 ask<Name> 且可被 import。
 * [ ] 2 返回对象 8 个字段齐全、类型稳定。
 * [ ] 3 withLockPool 覆盖了唯一的底层调用路径。
 * [ ] 4 memory/log.jsonl 六个字段都有值，失败也追加。
 * [ ] 5 预算查询发生在调用之前，超额抛错。
 * [ ] 6 parseContract + syntax 双重校验，失败 throw。
 * [ ] 7 全文件仅用 node: 内置模块，零第三方依赖。
 * [ ] 8 node --check agents/demo.mjs 通过。
 */
import { appendFile } from 'node:fs/promises';
import { withLockPool } from '../lib/lock.mjs';
import { checkBudget, charge } from '../lib/budget.mjs';
import { parseContract } from '../lib/contract.mjs';
import { validateSyntax } from '../lib/syntax.mjs';

const AGENT = 'demo';
const SLOTS = 1; // 保守并发额度，见「坑三」
const LOG = 'memory/log.jsonl';

/**
 * 估算 token 数。为什么兜底：预算扣费与日志都要求 inputTokens/outputTokens，
 * 但上游不保证回传精确计数；用字符数近似可保证契约字段永不缺失、可比较。
 * @param {string} text 输入文本
 * @returns {number} 近似 token 数
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * 写审计日志。为什么单独成函数且吞掉自身异常：日志是排障唯一依据，
 * 主流程无论成败都要落盘；但日志 IO 失败不能覆盖原始业务错误，
 * 所以这里 catch 后静默，由调用方继续抛出真正的异常。
 * @param {object} entry 含 ok/ms/promptSummary/outputChars/error 的条目
 * @returns {Promise<void>}
 */
async function logCall(entry) {
  const record = {
    ts: Date.now(),
    agent: AGENT,
    ok: entry.ok,
    ms: entry.ms,
    promptSummary: entry.promptSummary,
    outputChars: entry.outputChars,
    error: entry.error
  };
  const line = JSON.stringify(record);
  try {
    await appendFile(LOG, line + String.fromCharCode(10), 'utf8');
  } catch {
    // 日志失败不掩盖业务错误
  }
}

/**
 * 判定是否真答完。为什么不直接用空串判断：模型常把「正在思考」这类
 * 中文过渡文案当成回答返回，非空却无效；只有契约解析与语法校验都通过、
 * 且拿到结构化 data 才认定为真答完，从而避开坑一与坑二。
 * @param {string} raw 原始输出
 * @returns {{ok: boolean, data: object, reason: string}}
 */
function judgeFinished(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, data: {}, reason: '空回答' };
  }
  const contract = parseContract(raw);
  if (!contract.ok) {
    return { ok: false, data: {}, reason: contract.reason };
  }
  if (!validateSyntax(contract.data)) {
    return { ok: false, data: {}, reason: '语法校验未通过' };
  }
  return { ok: true, data: contract.data, reason: '' };
}

/**
 * 调用底层模型（30 行骨架的并发入口）。为什么用 withLockPool 包住：
 * slots 是同一 agent 的全局并发额度，不加锁排队会在高峰期突破上游限流；
 * 把真正的调用放进 fn，锁池负责排队、占用与释放，调用方无需关心并发。
 * @param {string} prompt 提示词
 * @param {object} opts 透传参数，mockRaw 仅用于本地自检
 * @returns {Promise<string>} 原始输出
 */
async function callModel(prompt, opts) {
  return withLockPool(AGENT, SLOTS, async () => {
    // 真实实现替换为上游 SDK / fetch；此处保持纯 node: 内置、零依赖。
    if (opts && opts.mockRaw) {
      return opts.mockRaw;
    }
    return '';
  });
}

/**
 * 新 agent 的唯一入口 askDemo（即指南里的 ask<Name>）。
 * 为什么失败一律 throw 而不返回空字符串：调用方靠异常触发重试与降级，
 * 返回空串会被误判为「答完了但内容为空」，与「思考中文案」混淆（坑二），
 * 进而污染验收与日志；所以未真答完、超预算、校验失败都抛 Error。
 * @param {string} prompt 用户输入
 * @param {object} [opts] 可选项
 * @returns {Promise<{answer:object,code:number,notes:string[],confidence:number,raw:string,ms:number,inputTokens:number,outputTokens:number}>}
 */
export async function askDemo(prompt, opts = {}) {
  const start = Date.now();
  const inputTokens = estimateTokens(prompt);
  const promptSummary = prompt.slice(0, 80);
  let raw = '';
  try {
    await checkBudget(inputTokens);
    raw = await callModel(prompt, opts);
    const judged = judgeFinished(raw);
    if (!judged.ok) {
      throw new Error('未真答完：' + judged.reason);
    }
    const outputTokens = estimateTokens(raw);
    await charge(inputTokens, outputTokens);
    const result = {
      answer: judged.data,
      code: 0,
      notes: [],
      confidence: 1,
      raw,
      ms: Date.now() - start,
      inputTokens,
      outputTokens
    };
    await logCall({
      ok: true,
      ms: result.ms,
      promptSummary,
      outputChars: raw.length,
      error: ''
    });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await logCall({
      ok: false,
      ms: Date.now() - start,
      promptSummary,
      outputChars: raw.length,
      error: error.message
    });
    throw error;
  }
}
