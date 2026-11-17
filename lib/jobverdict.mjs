/**
 * 退出码 → 作业结论。**唯一入口**：队列、池子、异步父审都调这里，不许各写一份。
 *
 * exit 4 = 「跑成功了但结论是红」，不是作业失败。不这么分的话，重试机制会把已经判出
 * REVISE 的产物当成没跑成反复重跑，而且 done 目录永远看不到「查出了问题」的作业 ——
 * 审计时只看 failed 会以为系统从没抓到过错。
 *
 * 曾在 lib/pool-cli.mjs 内联过一份 `const red = code === 4`，两处语义迟早漂移；
 * rank1 于 2026-11-17 指出，本轮收敛到这里。
 */
export const JOB_STATUS_CONTRACT = 'atwo-job-status/1';

export function jobVerdict(code) {
  if (typeof code !== 'number' || Number.isNaN(code)) return { ok: false, red: false, why: 'no-exit-code' };
  if (code === 0) return { ok: true, red: false, why: 'ok' };
  if (code === 4) return { ok: true, red: true, why: 'accept-red' };
  return { ok: false, red: false, why: 'exit-' + code };
}
