// lib/blindspots.mjs —— 让评审结果变成下一次派活的输入。
//
// 为什么需要它：评审现在只做了一件事——产出一份 markdown 存进 reviews/ 目录，
// 然后没有任何东西读它。同一个通道在同一个地方摔倒第二次、第三次，系统记不住。
// 那不是记忆，那是日志。
//
// 记忆的最小形态：**把「这个通道反复被挑出的问题类型」记下来，下次派活前先提醒它。**
// 不追求理解语义，只做分类计数 —— 粗糙但真的会改变行为。
//
// 刻意不做的事：
//   1. 不做语义聚类。中文评审文本自由度高，硬做聚类会得到一堆没意义的簇。
//      用预定义类别 + 关键词命中，粗糙但可解释，人一眼能看懂为什么记了这一类。
//   2. 不限量囤积例子。每类只留最近 3 条原文片段，其余只留计数——存的是判断，不是语料。
//   3. 不因为「类别命中」就断定产物有问题。它只用于**派活前的提醒**，
//      不参与任何 pass/fail 判定。提醒错了顶多浪费几个 token，判错会毁掉整条验收链。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 问题类别。关键词取自真实评审文本（codebuddy 那次挑出的 6 条全命中）。
 * 顺序即优先级：一条问题命中多类时，取最先匹配的那个，避免同一句话被记两次。
 */
export const CATEGORIES = [
  { id: 'boundary', label: '边界与越界', re: /越界|边界|超出|off[- ]by[- ]one|下标|索引|<=|数组长度|循环上界/ },
  { id: 'null', label: '空值与缺省', re: /\bnull\b|undefined|空值|缺省|未定义|\bNaN\b|空数组|空列表/ },
  { id: 'type', label: '类型混用', re: /字符串|类型|隐式转换|Number\(|parseInt|typeof|数字与/ },
  { id: 'error', label: '错误处理', re: /异常|捕获|catch|抛出|throw|失败时|错误处理|没兜住/ },
  { id: 'concurrency', label: '并发与时序', re: /并发|竞态|时序|锁|死锁|异步|await 漏|Promise/ },
  { id: 'contract', label: '接口与契约', re: /参数|签名|导出|接口|调用方|返回类型|不一致/ },
  { id: 'data', label: '数据假设', re: /平行数组|假设|长度不一致|硬编码|写死|默认值/ },
  { id: 'perf', label: '性能', re: /性能|复杂度|O\(n|重复计算|缓存|内存占用/ },
  { id: 'security', label: '安全', re: /注入|越权|未校验|信任输入|路径穿越|XSS|命令执行/ },
];

const DEFAULT_FILE = path.join('memory', 'blindspots.json');
const MAX_EXAMPLES = 3;

/** 判断一段评审文本属于哪一类（取第一个命中的） */
export function classify(text) {
  const s = String(text || '');
  for (const c of CATEGORIES) if (c.re.test(s)) return c;
  return null;
}

/** 把评审文本按行切成「一条一条问题」，逐条分类 */
export function extractIssues(reviewText) {
  const lines = String(reviewText || '').split('\n');
  const out = [];
  for (const ln of lines) {
    const t = ln.trim();
    // 只认像问题的行：编号项、圆点项，或者明确带「不对/错误/问题」的句子
    if (!t) continue;
    const isItem = /^(?:\*\*)?\d+[.)、]/.test(t) || /^[-*]\s+/.test(t);
    if (!isItem) continue;
    const body = t.replace(/^(?:\*\*)?\d+[.)、]\s*/, '').replace(/^[-*]\s+/, '').replace(/\*\*/g, '').trim();
    if (body.length < 4) continue;
    // 每条问题下面常挂「在哪 / 错在哪 / 怎么改」三行，那是解释不是新问题。
    // 不过滤的话 6 条问题会被记成 18 条（review 里数 issues 时踩过同一个坑）。
    if (/^(?:在哪|错在哪|怎么改|为什么|影响|原因|位置|行号|建议)[:：]?/.test(body)) continue;
    const cat = classify(body);
    out.push({ text: body.slice(0, 120), category: cat ? cat.id : 'other', label: cat ? cat.label : '其他' });
  }
  return out;
}

export function load(file) {
  const p = file || DEFAULT_FILE;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.agents) return data;
  } catch { }
  return { version: 1, updatedAt: null, agents: {} };
}

export function save(data, file) {
  const p = file || DEFAULT_FILE;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/**
 * 把一次评审结果记进盲区账本。
 * @param {{agent:string, reviewer?:string, reviewText:string, file?:string}} ev
 * @param {{file?:string}} opts
 * @returns {Array<{category:string,label:string,text:string}>} 这次记下的条目
 */
export function record(ev, opts = {}) {
  const agent = String(ev.agent || 'unknown');
  const issues = extractIssues(ev.reviewText || '');
  if (!issues.length) return [];
  const data = load(opts.file);
  const a = data.agents[agent] || (data.agents[agent] = { counts: {}, examples: {}, lastSeen: null });
  for (const it of issues) {
    if (it.category === 'other') continue;
    a.counts[it.category] = (a.counts[it.category] || 0) + 1;
    const arr = a.examples[it.category] || (a.examples[it.category] = []);
    arr.push({ text: it.text, at: new Date().toISOString().slice(0, 10), file: ev.file ? path.basename(ev.file) : null });
    if (arr.length > MAX_EXAMPLES) arr.splice(0, arr.length - MAX_EXAMPLES);
  }
  a.lastSeen = new Date().toISOString();
  save(data, opts.file);
  return issues.filter((i) => i.category !== 'other');
}

/**
 * 取某个通道最常被挑出的问题类型。
 * @returns {Array<{id:string,label:string,count:number,examples:Array}>} 按次数降序，最多 limit 条
 */
export function recall(agent, opts = {}) {
  const limit = opts.limit == null ? 3 : opts.limit;
  const data = load(opts.file);
  const a = data.agents[String(agent || '')];
  if (!a || !a.counts) return [];
  return Object.entries(a.counts)
    .map(([id, count]) => {
      const cat = CATEGORIES.find((c) => c.id === id);
      return { id, label: cat ? cat.label : id, count, examples: a.examples[id] || [] };
    })
    .filter((x) => x.count > 0)
    .sort((x, y) => y.count - x.count)
    .slice(0, limit);
}

/** 渲染成能直接拼进提示词的一段（空则返回空串，调用方可无条件拼接） */
export function renderBlock(agent, opts = {}) {
  const top = recall(agent, opts);
  if (!top.length) return '';
  const lines = top.map((t) => {
    const eg = t.examples.length ? '（比如：' + t.examples[t.examples.length - 1].text.slice(0, 60) + '）' : '';
    return '- ' + t.label + ' 被挑出 ' + t.count + ' 次' + eg;
  });
  return [
    '【你过去被评审反复挑出的问题类型，这次先自查再交】',
    ...lines,
    '这不是任务要求，是历史记录。若本任务与这些无关，忽略即可。',
    '',
  ].join('\n');
}

export default { CATEGORIES, classify, extractIssues, record, recall, renderBlock, load, save };
