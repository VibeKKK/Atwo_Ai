/**
 * 收工时的「第三方意见还没到」提示。
 *
 * 规则（rank1 2026-11-17 定）：异步父审不进 done 闸门（done 要确定性），但**不许静默**。
 * 进了 done 却还有票在路上，读者会以为「验过了」；所以只打提示、不拦。
 */
export const LATE_REVIEW_CONTRACT = 'atwo-late-review/1';

const LATE_KINDS = new Set(['review', 'fanout', 'army']);

export function lateReviewNotice({ reviewState, queue, limit = 3 } = {}) {
  const items = (queue && Array.isArray(queue.items) ? queue.items : []).filter(
    (it) => (it.state === 'pending' || it.state === 'running') && LATE_KINDS.has(String(it.kind || '')),
  );
  const unreviewed = reviewState === 'unreviewed' || reviewState === 'undecided';
  const lines = [];
  if (unreviewed && !items.length) {
    lines.push('  ⚠ 这件活没有第三方评审票（进了 done 不等于验过；补 reviews/ 后重跑 atwo done 可重判）');
  }
  if (items.length) {
    const shown = items.slice(0, limit).map((it) => it.kind + ' ' + it.id + '（' + it.state + '）').join(' · ');
    const more = items.length > limit ? ' 等 ' + items.length + ' 件' : '';
    lines.push('  ⚠ 还有 ' + items.length + ' 件评审/派活没跑完：' + shown + more);
    lines.push('    结论可能被后来的票推翻；看进度：atwo queue --json');
  }
  return {
    contract: LATE_REVIEW_CONTRACT,
    unreviewed,
    pending: items.map((it) => ({ id: it.id, kind: it.kind, state: it.state })),
    lines,
  };
}
