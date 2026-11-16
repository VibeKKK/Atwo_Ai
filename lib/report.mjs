// 批量派活的一份汇总报告（PRD R5）。
//
// 为什么单独一个文件：atwo.mjs 是带顶层执行的 CLI，import 就会跑命令，
// 所以「怎么把 N 次结果压成一段人话」必须是纯函数才能被测。
//
// 三条硬要求（PRD R5 原话）：
//   1. 成功 N 个、失败 M 个、需要你拍板 K 个 —— 三个数先给出来
//   2. 失败的要带「哪一步断的 + 下一步点哪个按钮」
//   3. **不许静默丢任务** —— 每个输入都要在报告里出现一次，哪怕它连日志都没留下

/** 从一条 memory/log.jsonl 记录里判断「断在哪一步」。 */
export function whereBroke(entry) {
  if (!entry) return { step: '没跑起来', next: 'atwo state 看通道状态；仍不行就 atwo raw doctor' };
  if (entry.contract === 'fail' || entry.syntax === 'fail') {
    return { step: '产物没过程序检查（形态/语法）', next: '看产物文件本身，别重派——先自己改一轮再派' };
  }
  if (entry.error) return { step: '通道报错：' + String(entry.error).slice(0, 120), next: 'atwo raw doctor 看该通道登录态；或先 off 档单通道试一次' };
  if (entry.ok === false) return { step: '通道返回失败（没写原因）', next: 'atwo raw stats 看该通道最近成功率' };
  return { step: '未知', next: '看 memory/log.jsonl 对应那条' };
}

/**
 * @param {Array<{source: string, code: number, entry: object|null, needsYou?: boolean}>} runs
 * @returns {{ok: number, failed: number, pending: number, lines: string[], markdown: string}}
 */
export function summarize(runs) {
  // 待你拍板的那条只算在 pending 里，不重复算成功 ——
  // 否则「成功 2 · 待拍板 1」会让人以为跑了 3 个还成了 2 个。
  const good = (r) => r.code === 0 && r.entry && r.entry.ok !== false && !r.needsYou;
  const ok = runs.filter(good).length;
  const failed = runs.filter((r) => !good(r) && !r.needsYou).length;
  const pending = runs.filter((r) => r.needsYou).length;

  const lines = [];
  for (const r of runs) {
    const isGood = good(r);
    const mark = isGood ? '✓' : (r.needsYou ? '?' : '✗');
    const secs = r.entry && Number.isFinite(r.entry.elapsedMs) ? Math.round(r.entry.elapsedMs / 1000) + 's' : '-';
    if (isGood) {
      lines.push(mark + ' ' + r.source + '  ' + secs + '  ' + (r.entry.agent || '-') + '  ' + (r.entry.outputChars || 0) + ' 字符');
    } else {
      const w = whereBroke(r.entry);
      lines.push(mark + ' ' + r.source + '  断在：' + w.step);
      lines.push('    下一步：' + w.next);
    }
  }

  const markdown = [
    '# 批量派活汇总',
    '',
    '- 生成于 ' + new Date().toLocaleString('zh-CN', { hour12: false }),
    '- 成功 ' + ok + ' 个 · 失败 ' + failed + ' 个 · 需要你拍板 ' + pending + ' 个 · 合计 ' + runs.length + ' 个',
    '',
    '## 逐条',
    '',
    ...lines.map((l) => '- ' + l),
  ].join('\n') + '\n';

  return { ok, failed, pending, lines, markdown };
}
