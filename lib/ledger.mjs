// 把「这次派活」翻成 decision_log 的一行。
//
// 为什么单独一个文件：atwo.mjs 是带顶层的 CLI 脚本，import 它就会执行命令，
// 所以任何想被测的措辞逻辑都得搬出来。这里只做纯函数，不读盘、不 spawn。
//
// 分工（2026-11-16 与副总管定，Q2）：
//   memory/log.jsonl  → 机器事实（谁、多久、多少字节、ok 与否），append-only，**成败只由它判定**
//   decision-log.md   → 人的判断（为什么这么派、放弃了什么），**不写「已完成/已通过」**
//
// 所以这一行只记「把什么交给谁、为什么」，并给出 log.jsonl 的指针；
// 唯一会写进人话判定的是「派活可能根本没开跑」——那是人该看一眼的异常，不是执行结果。

/**
 * @param {object} p
 * @param {object} p.task  当前 ATW 任务（至少要有 title）
 * @param {object|null} p.entry  memory/log.jsonl 的最后一条（可能没有：命令没跑起来就退出了）
 * @param {number} p.code  orchestra 的退出码
 * @returns {{args: string[], mark: string|null, abnormal: boolean}} 交给 decision_log.py add 的参数
 */
export function ledgerLine({ task, entry, code }) {
  const title = (task && task.title) || '（未命名任务）';
  const e = entry || null;

  const agent = e && e.agent ? e.agent : '（没有通道回话）';
  const entryOk = e ? e.ok !== false : false;
  const abnormal = !e || code !== 0 || !entryOk;

  let result;
  if (!e) {
    // 唯一一种「需要人看一眼」的判定：命令说跑完了，但日志里一条都没有 → 根本没开跑
    result = '命令返回 ' + code + '，但日志里没有任何条目 —— 派活可能没真正开跑，需要你看一眼';
  } else if (code !== 0) {
    result = '命令返回 ' + code + '；日志最后一条是 ' + agent + '，本行不做成败判定';
  } else if (!entryOk) {
    result = agent + ' 那条 ok=false，原因见 log.jsonl 该条的 error 字段，本行不做成败判定';
  } else {
    result = '派给 ' + agent + '；成败与耗时以 memory/log.jsonl 最后一条为准，本行不做判定';
  }

  const evidence = e
    ? 'memory/log.jsonl 最后一条（' + (e.time || '无时间') + ' ' + agent + (e.kind ? ' ' + e.kind : '') + '）'
    : 'memory/log.jsonl（空）';

  const args = [
    'add',
    '--phase', '派活',
    '--decision', '把「' + title + '」交给 ' + agent,
    '--why', 'atwo go 按档位派活：路数与评审由 size 决定，这次只留一条决定，免得事后说不清是谁跑的',
    '--evidence', evidence,
    '--result', result,
  ];

  return { args, mark: abnormal ? 'needs-you' : null, abnormal };
}
