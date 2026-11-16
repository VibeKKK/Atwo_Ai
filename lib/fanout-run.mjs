// lib/fanout-run.mjs —— 父会话派活 / 子会话并发 / 父审查。纯执行层，判定全在 lib/fanout.mjs。
import fs from 'node:fs';
import { askCodeBuddy } from '../agents/codebuddy.mjs';
import { VERDICT, buildChildPrompt, buildReviewPrompt, parseChildOutput, parseReview, summarizeFanout, writeFanout } from './fanout.mjs';
import { LANE_DEFS, describePlan, planLanes, probeLanes } from './lanes.mjs';
import { collectRefs, preGateAll } from './pregate.mjs';
import { DEFAULT_MAX_CHUNKS, chunkTask, describeSplit, mergeParts, planSplit } from './split.mjs';

/** 子会话默认只读：codebuddy 的 --tools 默认是 Write,Edit,Read，
 * 2026-11-16 事故 —— vm/judge.mjs 被某次派活的子会话写成一坨 LLM 回答文本（3 行）。
 * 子会话的产物是文本回答，落盘由 fanout 自己做，它不需要写权限。 */
export const READ_ONLY_TOOLS = 'Read,Grep,Glob';
export const MAX_PARTS = 6; // 单通道拐点：实测 12 路时单路由 4.85s 涨到 11.05s，吞吐停在 0.96/s
export const MAX_TOTAL_PARTS = 14; // 编队总上限 = codebuddy 6 + ollama 8（2026-11-16 实测 8 路 ollama 4.88s 全部完成）

/** 子会话并发上限从实测来，不是拍脑袋：12 路时单路由 4.85s 涨到 11.05s，吞吐 0.96/s 基本停住。 */
export function clampParts(n) {
  const v = Math.floor(Number(n) || 0);
  if (v < 1) return 1;
  return Math.min(v, MAX_PARTS);
}

/** 编队版上限：跨通道可以超过单通道拐点，但总和仍有天花板。 */
export function clampFanoutParts(n) {
  const v = Math.floor(Number(n) || 0);
  if (v < 1) return 1;
  return Math.min(v, MAX_TOTAL_PARTS);
}

async function runChild(job, task, i, n, cwd, timeoutMs, childModel, note, onProgress, childTools) {
  // job = {ask, lane, model}：编队后每一路可能来自不同通道，来源必须跟着产物走，
  // 否则父审看到 6 份产物时无法区分「云端高质」与「本地 8B 粗活」。
  const ask = typeof job === 'function' ? job : job.ask;
  const lane = typeof job === 'function' ? 'codebuddy' : (job.lane || 'codebuddy');
  const id = 'child-' + (i + 1);
  const t = Date.now();
  const done = (out) => {
    // 逐路回调：Promise.all 要等最慢那路，中途看不到任何东西 = 黑箱。
    if (onProgress) onProgress({ phase: 'child-done', id, lane: out.lane, ok: out.ok, elapsedMs: out.elapsedMs, chars: String(out.answer || '').length });
    return out;
  };
  try {
    // 分片时 job.task 已经是「原任务 + 本片清单」的完整文本，buildChildPrompt 只负责套输出契约。
    const childTask = (typeof job === 'object' && job.task) || task;
    // 回合预算跟着单元数走：一个子会话要逐个 Read 片内每个文件，而 codebuddy 默认只给 10 回合。
    // 2026-11-16 实测 9 个文件一片时，子会话撞满回合后一路挣扎到 180s 超时（171.7 / 175.9 / 178.6s）。
    const units = (typeof job === 'object' && Number.isFinite(job.units)) ? job.units : 0;
    const turnCap = units > 0 ? { maxTurns: Math.min(60, 8 + units * 3) } : {};
    const r = await ask(buildChildPrompt(childTask, i, n, note), { cwd, timeoutMs, model: (typeof job === 'object' && job.model) || childModel, tools: childTools, ...turnCap });
    const parsed = parseChildOutput(r && r.addedText);
    return done({ id, index: i, lane, ok: !!(r && r.ok), elapsedMs: Date.now() - t, raw: (r && r.addedText) || '', chunkLabel: (typeof job === 'object' && job.chunkLabel) || null, ...parsed });
  } catch (e) {
    return done({ id, index: i, lane, ok: false, elapsedMs: Date.now() - t, raw: String(e && e.message || e), answer: '', evidence: '', malformed: true });
  }
}

async function runFanoutInner(opts) {
  const { task, parts = 3, cwd, timeoutMs = 180000, reviewModel, childModel, onProgress, fixRounds = 0, notesPath, childTools = READ_ONLY_TOOLS } = opts;
  const ask = opts.ask || askCodeBuddy; // 测试可注入：自愈回路必须能在不起 CLI 的情况下验
  if (!task || !String(task).trim()) throw new Error('fanout：缺少任务（--task）');
  let n = clampFanoutParts(parts);
  const t0 = Date.now();

  // 编队：autoLanes / lanes 给了就真探测再分派；没给就走老路（单通道 opts.ask）。
  // 默认不自动探测是为了可预测 —— 测试与离线场景不该被一次 /api/version 探测拖慢。
  let planned = null;
  let probes = null;
  if (opts.lanes || opts.autoLanes) {
    try {
      probes = opts.probes || (opts.autoLanes ? await probeLanes({ only: ['codebuddy', 'codex', 'ollama'] }) : null);
      planned = planLanes(n, { probes, lanes: opts.lanes, role: 'writer' }).plan;
    } catch (e) {
      if (!opts.ask) throw e; // 一路都派不出去且没有注入 ask → 报错，不许静默降级成单通道
      planned = null;
    }
  }
  let jobs = planned
    ? planned.flatMap((pl) => Array.from({ length: pl.count }, () => ({ ask: LANE_DEFS[pl.lane].ask, lane: pl.lane, model: undefined })))
    : Array.from({ length: n }, () => ({ ask: opts.ask || askCodeBuddy, lane: 'codebuddy' }));
  while (jobs.length < n) jobs.push(jobs[0]);

  // 长尾切分：墙钟等于最慢那一个，加路数对它零作用，只能把最慢那一个本身变小。
  // 切分优先于 parts —— 片数就是路数，并且每片自己就是一个「更小的活」。
  let splitPlan = null;
  if (opts.split) {
    const maxChunks = Number(opts.split) > 1 ? Math.floor(Number(opts.split)) : DEFAULT_MAX_CHUNKS;
    splitPlan = planSplit(task, { cwd, maxChunks });
    if (splitPlan.chunks && splitPlan.chunks.length >= 2) {
      const first = jobs[0];
      const laneAsk = (typeof first === 'function' ? first : (first && first.ask)) || opts.ask || askCodeBuddy;
      const laneName = (first && first.lane) || 'codebuddy';
      jobs = splitPlan.chunks.map((c) => ({ ask: laneAsk, lane: laneName, model: undefined, task: chunkTask(task, c), chunkLabel: c.label, units: c.units.length }));
      n = jobs.length;
      if (onProgress) onProgress({ phase: 'split', desc: describeSplit(splitPlan), chunks: n, units: splitPlan.units.length });
    } else if (onProgress) onProgress({ phase: 'split-skip', reason: splitPlan.reason });
  }
  const planDesc = planned ? describePlan(planned) : 'codebuddy×' + n;

  if (onProgress) onProgress({ phase: 'children-start', n, plan: planDesc });
  let children = await Promise.all(Array.from({ length: n }, (_, i) => runChild(jobs[i], task, i, n, cwd, timeoutMs, childModel, undefined, onProgress, childTools)));
  if (onProgress) onProgress({ phase: 'children-done', children });

  // 父审开始前读一次 notes.md：子会话跑完之前的追加指令都算数。
  // 为什么不轮询：子会话是并行短任务，轮询只增加复杂度；父审是唯一消费指令的环节。
  let note = '';
  if (notesPath && fs.existsSync(notesPath)) {
    note = String(fs.readFileSync(notesPath, 'utf8') || '').replace(/<!--[\s\S]*?-->/g, '').trim();
    // 只有真写了指令才广播：空文件不该在 --follow 里报「吸收了 0 行」。
    if (note && onProgress) onProgress({ phase: 'notes', note });
  }

  const reviewOnce = async (kids) => {
    const t = Date.now();
    // 第一层：机械闸门（只判证据形式）。判死的直接进 reviews，不送父审 ——
    // 父审一次 14–20s、几千 token，拿去读「没有行号」的产物是纯浪费。
    const { reviews: mech, deferred } = opts.noPreGate ? { reviews: [], deferred: kids } : preGateAll(kids, { cwd });
    if (!deferred.length) {
      const summary = summarizeFanout(mech);
      if (onProgress) onProgress({ phase: 'pregate-all-revise', n: mech.length });
      return { raw: '', reviews: mech, summary, ms: Date.now() - t, preGate: { mech: mech.length, deferred: 0 } };
    }
    // 第二层：父审分片并行。2026-11-16 实测 8 份送一个父审要 67.4s（约 8s/份线性叠加），
    // 而父审是独立无状态调用 —— 拆成 3 份一片并发就能把墙钟压到 ~1/3。
    // 代价：跨产物的矛盾只能在片内发现（同一片的 3 份仍互相可见）。要全局矛盾就 --review-chunk 0。
    const chunkSize = Number.isFinite(opts.reviewChunk) ? Math.max(0, Math.floor(opts.reviewChunk)) : 3;
    const chunks = [];
    if (chunkSize <= 0) chunks.push(deferred);
    else for (let i = 0; i < deferred.length; i += chunkSize) chunks.push(deferred.slice(i, i + chunkSize));
    let raw = '', err = null;
    const partsReviews = [];
    try {
      // 2026-11-16：父会话只给 Read —— 它能去核对证据，但物理上改不了文件（原先「父只审不干」只是提示词）。
      let doneChunks = 0;
      // 父审的回合预算必须按「这一片有几份」给：每份产物通常要核对 3–8 个引用行，
      // 而 codebuddy 的默认上限是 10 回合 —— 3 份一片时必然断在中途，返回的错误被当成「没给票」。
      // 2026-11-16 实测：不调这个值，6 片必丢 3 条票。
      const reviewMaxTurns = Number(process.env.ATWO_REVIEW_MAX_TURNS || 0) || Math.min(60, 12 + chunks.reduce((m, s) => Math.max(m, s.length), 1) * 8);
      const outs = await Promise.all(chunks.map((slice) => ask(buildReviewPrompt(task, slice, note, collectRefs(slice, { cwd }).text), { cwd, timeoutMs, model: reviewModel, tools: 'Read', maxTurns: reviewMaxTurns })
        .then((rr) => { doneChunks += 1; if (onProgress) onProgress({ phase: 'review-chunk-done', done: doneChunks, total: chunks.length, ids: slice.map((c) => c.id) }); return { slice, text: (rr && rr.addedText) || '', err: null }; })
        .catch((e) => ({ slice, text: '', err: String(e && e.message || e) }))));
      for (const o of outs) {
        if (o.text) raw += (raw ? '\n\n' : '') + o.text;
        if (o.err) err = (err ? err + '; ' : '') + o.err;
        if (o.text) {
          partsReviews.push(...parseReview(o.text, o.slice.map((c) => c.id)));
        } else {
          // 空片不能记成「父审没给票」—— 那是解析问题；空片是调用失败，理由必须写清楚，
          // 否则事后只看到 3 条 unreviewed，分不清该重跑还是该修解析。
          const why = o.err ? '父审这一片调用失败：' + o.err : '父审这一片返回了空内容';
          for (const c of o.slice) partsReviews.push({ id: c.id, verdict: VERDICT.none, reason: why });
        }
      }
    } catch (e) { err = String(e && e.message || e); }
    // 机械结论里 id 与 deferred 不重叠，直接拼起来即可（不覆盖父审的判定）。
    const reviews = [...mech, ...partsReviews];
    const reviewChunks = chunks.length;
    const summary = summarizeFanout(reviews);
    summary.preGate = { mech: mech.length, deferred: deferred.length };
    summary.reviewChunks = reviewChunks;
    if (err) summary.error = err;
    return { raw, reviews, summary, ms: Date.now() - t, preGate: summary.preGate };
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
      return runChild(jobs[c.index], task, c.index, n, cwd, timeoutMs, childModel, note, undefined, childTools).then((nc) => ({ ...nc, retried: true, prevAnswer: c.answer }));
    }));
    children = redone;
    current = await reviewOnce(children);
    rounds.push({ round: rounds.length + 1, children, reviews: current.reviews, summary: current.summary });
    if (onProgress) onProgress({ phase: 'fix-done', summary: current.summary });
  }

  const elapsed = { childrenMs: t1 - t0, reviewMs: current.ms, totalMs: Date.now() - t0, rounds: rounds.length };

  return {
    task, parts: n, plan: planned, planDesc, probes, children, reviews: current.reviews, summary: current.summary, notes: note,
    split: splitPlan && splitPlan.chunks && splitPlan.chunks.length ? { desc: describeSplit(splitPlan), chunks: n, units: splitPlan.units.length } : null,
    merged: mergeParts(children, splitPlan),
    reviewRaw: current.raw, elapsed, rounds, error: current.summary.error || null,
  };
}

export function finishFanout(result, dir) {
  const file = writeFanout(dir, { task: result.task, children: result.children, reviews: result.reviews, summary: result.summary, merged: result.merged, reviewRaw: result.reviewRaw, meta: { elapsed: result.elapsed, parts: result.parts, notes: result.notes || '', split: result.split || null } });
  return file;
}
/**
 * 墙钟兜底。2026-11-16 实测：一次 3 路子会话 + 父审跑了 17 分钟没有任何输出，
 * 而每路都有自己的 timeoutMs（180s）—— 说明「每路超时」不等于「整体会结束」：
 * 子进程被 kill 但它的孙进程仍握着 stdout 管道，promise 就永远等不到 close。
 *
 * 所以整体必须有一个外部上限：到点就带着「已经拿到的部分」返回，并明确标记
 * deadlineHit —— 不许伪装成通过，也不许无声挂死。上层（atwo fanout）看到
 * deadlineHit 直接退出 5（通道失败），而不是当成 REVISE 或 PASS。
 *
 * 注意：race 输掉的 work 分支不会被取消（Node 没有取消语义），它会在后台跑完。
 * 这是可接受的：进程本来就要退出，泄漏的只是一个已经没人等的 promise。
 */
export async function runFanout(opts) {
  const timeoutMs = Number(opts && opts.timeoutMs) || 180000;
  const deadlineMs = Number(opts && opts.deadlineMs) || (timeoutMs * 2 + 120000);
  let timer = null;
  const guard = new Promise((resolve) => {
    // 不 unref：这个定时器此刻是唯一会让事件循环活下去的东西（work 分支可能已经
    // 卡在没有 close 的管道上），unref 会直接让进程退出，连兜底返回值都拿不到。
    timer = setTimeout(() => resolve({ __deadline: true }), deadlineMs);
  });
  let res;
  try {
    res = await Promise.race([runFanoutInner(opts), guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res && res.__deadline) {
    return {
      task: String((opts && opts.task) || ''),
      parts: clampFanoutParts((opts && opts.parts) || 3),
      children: [],
      reviews: [],
      summary: { value: 0, state: 'unreviewed', counts: { PASS: 0, REVISE: 0, unreviewed: 0 }, total: 0, deadlineHit: true },
      reviewRaw: '',
      elapsed: { childrenMs: deadlineMs, reviewMs: 0, totalMs: deadlineMs, rounds: 0 },
      rounds: [],
      error: 'deadline：整体跑了 ' + Math.round(deadlineMs / 1000) + 's 仍未收齐（每路超时不会让整体结束 —— 见 runFanout 注释）',
      deadlineHit: true,
    };
  }
  return res;
}
