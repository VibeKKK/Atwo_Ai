import { loadTasks } from './model.mjs';

/** 取任务文本：优先 text、其次 title，非对象返回空串。
 * @param {unknown} item 任务项 @returns {string} 文本内容 */
const textOf = (item) =>
  item && typeof item === 'object' ? String(item.text ?? item.title ?? '') : '';

/** @param {unknown} item 任务项 @returns {boolean} 是否已完成 */
const isDone = (item) => Boolean(item && typeof item === 'object' && item.done);

/**
 * 由任务文件生成一段 markdown 报告（ESM，零第三方依赖，只读不写盘）。
 *
 * 通过 model.mjs 的 loadTasks 读取任务数组，统计总数与已完成数，
 * 并把未完成项列成清单。声明为 async 便于调用方按 Promise 使用，
 * 将来换异步存储也无需改动调用点；文件不存在时按空数组处理并给出零值统计。
 *
 * @param {string} filePath - JSON 任务文件路径，透传给 loadTasks
 * @returns {Promise<string>} 含总数、已完成数、未完成清单的 markdown 文本
 * @throws {SyntaxError} 任务文件不是合法 JSON
 * @throws {TypeError} 任务文件顶层不是数组
 * @example
 * const md = await buildReport('todo.json');
 */
export async function buildReport(filePath) {
  const tasks = loadTasks(filePath);
  const pending = tasks.filter((item) => !isDone(item));
  const lines = [
    '# 待办报告',
    '',
    `- 总数：${tasks.length}`,
    `- 已完成数：${tasks.length - pending.length}`,
    `- 未完成数：${pending.length}`,
    '',
    '## 未完成清单',
    '',
  ];
  if (pending.length === 0) {
    lines.push('（暂无未完成项）');
  } else {
    for (const item of pending) lines.push(`- [ ] ${textOf(item)}`);
  }
  return `${lines.join('\n')}\n`;
}
