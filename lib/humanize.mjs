/**
 * lib/humanize.mjs
 * 把评审与验收里的机器术语翻成普通用户能判断的中文句子。
 *
 * 约定：
 * - 纯函数，不读文件、不联网、不 import 任何模块。
 * - 参数不对时不抛异常，一律返回一句兜底中文。
 * - 每句都短，一句话说完，不堆分号。
 *
 * @module lib/humanize
 */

/** 评审结论的中文说法，未知值统一说「结论不明」。 @type {Record<string, string>} */
const VERDICT_ZH = {
  ACCEPT: '同意',
  REVISE: '要求改',
};

/** 失败原因的中文说法，未收录的值原样返回。 @type {Record<string, string>} */
const REASON_ZH = {
  unreviewed: '评审者全部超时，没有第三方看过',
  'fix-failed': '要求改的那版没拿回来，文件还是原样',
};

/**
 * apispec 报错串的形状：
 * `loadTasks 参数不符：要 [filePath] 实为 [path]`
 * @type {RegExp}
 */
const APISPEC_RE = /^(\S+)\s*参数不符\s*[:：]\s*要\s*\[([^\]]*)\]\s*实为\s*\[([^\]]*)\]$/;

/**
 * 安全地取评审票列表，参数不对时给空数组。
 * @param {unknown} votes - 期望是数组，每项形如 { reviewer, verdict, issues }
 * @returns {Array<Record<string, unknown>>} 只保留非空对象
 */
function safeVotes(votes) {
  if (!Array.isArray(votes)) return [];
  return votes.filter((item) => item !== null && typeof item === 'object');
}

/**
 * 数一共列了多少条问题：优先用汇总的 issues，没有再按票累加。
 * @param {Record<string, unknown>} rec - 评审记录
 * @returns {number} 问题条数，取不到时为 0
 */
function countIssues(rec) {
  const own = numOrNull(rec.issues);
  if (own !== null) return own;
  let total = 0;
  let seen = false;
  for (const vote of safeVotes(rec.votes)) {
    const n = numOrNull(vote.issues);
    if (n !== null) { total += n; seen = true; }
  }
  return seen ? total : 0;
}

/**
 * issues 两种形状都收：数字（问题条数）和数组（问题清单）。
 * 契约写的是条数，实现按数组写，两边不一致时会把「17 个问题」显示成「0 个」——
 * 所以这里不做假设，两种都认。
 * @param {unknown} v
 * @returns {number|null} 取不到返回 null
 */
function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.length;
  return null;
}

/**
 * 把 `[filePath, path]` 这种方括号清单拆成名字数组。
 * @param {string} raw - 方括号里的原文
 * @returns {string[]} 去掉空白后的名字
 */
function splitNames(raw) {
  return String(raw)
    .split(/[,\s]+/)
    .filter((name) => name.length > 0);
}

/**
 * 用一句话说清这次评审的结论。
 * @param {object} input - 形状 { consensus, verdict, votes, degraded, issues }
 * @param {string|null} [input.consensus] - 'all-accept' | 'all-revise' | 'split' | null
 * @param {string|null} [input.verdict] - 'ACCEPT' | 'REVISE' | null
 * @param {Array<object>} [input.votes] - 每项 { reviewer, verdict, issues }
 * @param {boolean} [input.degraded] - 是否有个评审者没回话
 * @param {Array<unknown>} [input.issues] - 汇总的问题清单
 * @returns {string} 一句中文结论
 */
export function humanVerdict(input) {
  const rec = input !== null && typeof input === 'object' ? input : {};
  const n = safeVotes(rec.votes).length;
  const m = countIssues(rec);
  // 单个评审者时不能说「都」—— 「1 个 AI 都看过了」中文不通。
  const acceptLine = n === 1 ? `1 个 AI 看过了，同意` : `${n} 个 AI 都看过了，都同意`;
  const reviseLine = n === 1
    ? `1 个 AI 认为还要改，共列出 ${m} 个问题`
    : `${n} 个 AI 都认为还要改，共列出 ${m} 个问题`;
  const splitLine = `${n} 个 AI 看法不一样，需要你定`;
  let line;

  if (!rec.verdict && n === 0) {
    line = '这次没有第三方看过';
  } else if (rec.consensus === 'all-accept') {
    line = acceptLine;
  } else if (rec.consensus === 'all-revise') {
    line = reviseLine;
  } else if (rec.consensus === 'split') {
    line = splitLine;
  } else if (rec.verdict === 'ACCEPT') {
    line = acceptLine;
  } else if (rec.verdict === 'REVISE') {
    line = reviseLine;
  } else if (n > 0) {
    line = `${n} 个 AI 看过了，但没有形成统一结论`;
  } else {
    line = '这次没有第三方看过';
  }

  if (rec.degraded === true) {
    line += `（只问通 ${n} 个，另一个没回话，这个结论弱一点）`;
  }
  return line;
}

/**
 * 把问题条数说成人话。
 * @param {number|null} n - 问题条数
 * @returns {string} 例如「3 个问题」
 */
export function humanIssues(n) {
  const count = numOrNull(n);
  if (count === null) return '问题数未知';
  if (count <= 0) return '没发现问题';
  return `${count} 个问题`;
}

/**
 * 把 apispec 的参数名报错翻成人话，解析不出来就原样返回。
 * @param {string} msg - 例如 `loadTasks 参数不符：要 [filePath] 实为 [path]`
 * @returns {string} 例如 `函数参数名对不上：要求 loadTasks(filePath)，实际写的是 path`
 */
export function humanApispecFail(msg) {
  if (typeof msg !== 'string') return '';
  const matched = APISPEC_RE.exec(msg.trim());
  if (!matched) return msg;

  const fnName = matched[1];
  const want = splitNames(matched[2]);
  const got = splitNames(matched[3]);
  if (!fnName || want.length === 0) return msg;

  const gotText = got.length > 0 ? got.join(', ') : '空';
  return `函数参数名对不上：要求 ${fnName}(${want.join(', ')})，实际写的是 ${gotText}`;
}

/**
 * 把失败原因代号翻成人话，未收录的值原样返回。
 * @param {string} reason - 例如 'unreviewed'
 * @returns {string} 一句中文说明
 */
export function humanReason(reason) {
  if (typeof reason !== 'string') return '';
  if (Object.prototype.hasOwnProperty.call(REASON_ZH, reason)) {
    return REASON_ZH[reason];
  }
  return reason;
}

/**
 * 把一个验收记录渲染成给人看的多行报告。
 * @param {object} rec - 形状 { file, verdict, consensus, votes, degraded, issues, ok, reason }
 * @param {boolean} [rec.ok] - 是否通过，false 时第一行加前缀
 * @param {Array<object>} [rec.votes] - 每项 { reviewer, verdict, issues }
 * @returns {string} 第一行是结论，后面每行是某个 AI 的一句话
 */
export function humanReport(rec) {
  const safe = rec !== null && typeof rec === 'object' ? rec : {};
  const head = humanVerdict(safe);
  const lines = [safe.ok === false ? `没通过：${head}` : head];

  for (const vote of safeVotes(safe.votes)) {
    const who =
      typeof vote.reviewer === 'string' && vote.reviewer.length > 0
        ? vote.reviewer
        : '没写名字的 AI';
    const zh = VERDICT_ZH[vote.verdict] || '结论不明';
    const count = numOrNull(vote.issues);
    lines.push(`- ${who}：${zh}（${humanIssues(count)}）`);
  }

  return lines.join('\n');
}
