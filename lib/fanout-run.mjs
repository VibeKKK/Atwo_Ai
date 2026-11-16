// lib/fanout-run.mjs —— 父会话派活 / 子会话并发 / 父审查。纯执行层，判定全在 lib/fanout.mjs。
import { askCodeBuddy } from '../agents/codebuddy.mjs';
import { buildChildPrompt, buildReviewPrompt, parseChildOutput, parseReview, summarizeFanout, writeFanout } from './fanout.mjs';

export const MAX_PARTS = 6; // 实测并发拐点 6–8 路，超过 6 只增加「每路变慢」不增加吞吐

/** 子会话并发上限从实测来，不是拍脑袋：12 路时单路由 4.85s 涨到 11.05s，吞吐 0.96/s 基本停住。 */
export function clampParts(n) {
  const v = Math.floor(Number(n) || 0);
  if (v < 1) return 1;
  return Math.min(v, MAX_PARTS);
}

async function runChild(ask, task, i, n, cwd, timeoutMs, childModel, note) {
  const id = 'child-' + (i + 1);
  const t = Date.now();
  try {
    const r = await ask(buildChildPrompt(task, i, n, note), { cwd, timeoutMs, model: childModel });
    const parsed = parseChildOutput(r && r.addedText);
    return { id, index: i, ok: !!(r && r.ok), elapsedMs: Date.now() - t, raw: (r && r.addedText) || '', ...parsed };
  } catch (e) {
    return { id, index: i, ok: false, elapsedMs: Date.now() - t, raw: String(e && e.message || e), answer: '', evidence: '', malformed: true };
  }
}

export async function runFanout(opts) {
  const { task, parts = 3, cwd, timeoutMs = 180000, reviewModel, childModel, onProgress, fixRounds = 0 } = opts;
  const ask = opts.ask || askCodeBuddy; // 测试可注入：自愈回路必须能在不起 CLI 的情况下验
  if (!task || !String(task).trim()) throw new Error('fanout：缺少任务（--task）');
  const n = clampParts(parts);
  const t0 = Date.now();

  if (onProgress) onProgress({ phase: 'children-start', n });
  let children = await Promise.all(Array.from({ length: n }, (_, i) => runChild(ask, task, i, n, cwd, timeoutMs, childModel)));
  if (onProgress) onProgress({ phase: 'children-done', children });

  const reviewOnce = async (kids) => {
    const t = Date.now();
    let raw = '', err = null;
    try {
      // 2026-11-16：父会话只给 Read —— 它能去核对证据，但物理上改不了文件（原先「父只审不干」只是提示词）。
      const rr = await ask(buildReviewPrompt(task, kids), { cwd, timeoutMs, model: reviewModel, tools: 'Read' });
      raw = (rr && rr.addedText) || '';
    } catch (e) { err = String(e && e.message || e); }
    const reviews = parseReview(raw, kids.map((c) => c.id));
    const summary = summarizeFanout(reviews);
    if (err) summary.error = err;
    return { raw, reviews, summary, ms: Date.now() - t };
  };

  const t1 = Date.now();
  const first = await reviewOnce(children);
  let current = first;
  let rounds = [{ round: 1, children, reviews: first.reviews, summary: first.summary }];

  // 自愈：父会话判了 REVISE 的子会话，带着批注重做一轮（上限 fixRounds，默认 0 = 关）。
  for (let r = 0; r < Math.min(Math.max(0, Math.floor(fixRounds)), 2); r += 1) {
    const bad = current.reviews.filter((rv) => rv.verdict === 'REVISE');
    if (!bad.length) break;
    if (onProgress) onProgress({ phase: 'fix-start', ids: bad.map((b) => b.id) });
    const badIds = new Set(bad.map((b) => b.id));
    const redone = await Promise.all(children.map((c) => {
      if (!badIds.has(c.id)) return c;
      const note = (bad.find((b) => b.id === c.id) || {}).reason;
      return runChild(ask, task, c.index, n, cwd, timeoutMs, childModel, note).then((nc) => ({ ...nc, retried: true, prevAnswer: c.answer }));
    }));
    children = redone;
    current = await reviewOnce(children);
    rounds.push({ round: rounds.length + 1, children, reviews: current.reviews, summary: current.summary });
    if (onProgress) onProgress({ phase: 'fix-done', summary: current.summary });
  }

  const elapsed = { childrenMs: t1 - t0, reviewMs: current.ms, totalMs: Date.now() - t0, rounds: rounds.length };

  return {
    task, parts: n, children, reviews: current.reviews, summary: current.summary,
    reviewRaw: current.raw, elapsed, rounds, error: current.summary.error || null,
  };
}

export function finishFanout(result, dir) {
  const file = writeFanout(dir, { task: result.task, children: result.children, reviews: result.reviews, summary: result.summary, meta: { elapsed: result.elapsed, parts: result.parts } });
  return file;
}
