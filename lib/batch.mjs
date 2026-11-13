// 批处理派活：把 N 个小任务压进一次调用，摊薄固定开销。
//
// 为什么值得做：codebuddy 每次调用有 ~24,800 token 的固定开销（CLI 自带 system prompt），
// 而真正属于任务的只有几十个 token。5 个任务分 5 次派 = 12.4 万；压成 1 次 = 2.5 万。
//
// 用法：
//   node orchestra.mjs batch trae tasks.md
//   node orchestra.mjs batch codebuddy "任务1|||任务2|||任务3"
//
// tasks.md 支持两种写法：
//   ---
//   任务一的描述
//   ---
//   任务二的描述
//   或每行一个（以 - 或数字. 开头）
//
// 输出契约：{"results":[{"id":1,"answer":"...","code":"...","notes":[],"confidence":0.9}]}
// 解析失败会逐项降级（按分隔符硬切），不会整批丢失。
import fs from 'node:fs';
import { parseContract } from './contract.mjs';

export const BATCH_CONTRACT = `
输出必须是**一个 JSON 对象**，不要任何解释文字，不要 markdown 围栏：
{"results":[
  {"id":1,"answer":"这一项的答案（散文任务填这里）","code":"这一项的代码（代码任务填这里，保留 4 空格缩进）","notes":["要点"],"confidence":0.9}
]}
规则：
- 每个任务一条 result，id 与任务编号一致，顺序不变，不许合并、不许省略
- 代码任务填 code，散文任务填 answer；两者都空的项视为失败
- confidence 是 0~1 的数字，表示你对这一项有多确定
`;

/** 把输入文本切成任务数组 */
export function parseTasks(input) {
  const s = String(input || '').replace(/\r/g, '').trim();
  if (!s) return [];
  // 2026-11-14 修：--- 独占一行的信号强度高于 |||。
  // 踩过的坑：任务正文里引用了 `任务1|||任务2` 这种示例写法，整份文件被 ||| 切成了 2 段，
  // 而且切出来的两段各自都不是完整任务（实测 8 个任务只剩 2 个错任务）。
  // --- 只在独占一行时才算分隔，正文里偶尔出现分隔线也只在没有 ||| 时才走到下面的分支。
  if (/^---$/m.test(s)) {
    return s.split(/^---$/m).map((x) => x.trim()).filter(Boolean);
  }
  if (s.includes('|||')) {
    return s.split('|||').map((x) => x.trim()).filter(Boolean);
  }
  // 行式：- 开头 或 1. 开头
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const itemized = lines.filter((l) => /^([-*]|\d+[.)])\s+/.test(l));
  if (itemized.length >= 2) return itemized.map((l) => l.replace(/^([-*]|\d+[.)])\s+/, '').trim());
  return lines;
}

/** 拼成一次请求：任务表 + 契约 */
export function buildBatchPrompt(tasks) {
  const list = tasks.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `下面有 ${tasks.length} 个独立任务，请逐项完成。\n\n${list}\n${BATCH_CONTRACT}`;
}

/** 从回答里拿到 results 数组；契约失败时按 id 顺序硬切降级 */
export function splitResults(raw, tasks) {
  const parsed = parseContract(raw);
  const got = parsed.ok && parsed.data && Array.isArray(parsed.data.results) ? parsed.data.results : null;
  if (got && got.length) {
    return { source: 'contract', items: got.map((r, i) => ({ id: r.id ?? i + 1, answer: r.answer || '', code: r.code || '', notes: r.notes || [], confidence: r.confidence ?? null })) };
  }
  // 降级：把整段按编号切开，能捞多少算多少
  const text = String(raw || '');
  const chunks = text.split(/\n(?=\s*\d+[.)、]\s|\s*【\d+】)/).filter((x) => x.trim());
  const items = chunks.slice(0, tasks.length).map((c, i) => ({ id: i + 1, answer: c.trim(), code: '', notes: ['契约失败，按行切分降级'], confidence: null }));
  return { source: 'fallback', items: items.length ? items : tasks.map((_, i) => ({ id: i + 1, answer: '', code: '', notes: ['未取到结果'], confidence: null })) };
}

/** 读任务来源：文件路径或内联文本 */
export function loadTasks(arg) {
  if (!arg) return [];
  if (fs.existsSync(arg)) return parseTasks(fs.readFileSync(arg, 'utf8'));
  return parseTasks(arg);
}
