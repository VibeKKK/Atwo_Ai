// lib/fanout-run.mjs —— 父会话派活 / 子会话并发 / 父审查。纯执行层，判定全在 lib/fanout.mjs。
import fs from 'node:fs';
import { askCodeBuddy } from '../agents/codebuddy.mjs';
import { VERDICT, buildChildPrompt, buildReviewPrompt, parseChildOutput, parseReview, summarizeFanout, writeFanout } from './fanout.mjs';
import { LANE_DEFS, describePlan, planLanes, probeLanes, resolveAsk } from './lanes.mjs';
import { collectRefs, preGateAll } from './pregate.mjs';
import { appendEntry } from './reviewer-ledger.mjs';
import { writeSnapshot } from './snapshot.mjs';
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
    // 无分片时也必须给预算：2026-11-17 实测，给一份长简报（方向讨论）派三路，
    // 三路全部「Max turns (10) exceeded」→ ANSWER 为空 → 机械闸门判 REVISE。
    // 那不是子会话不干活，是我们只让它读十次文件就把嘴捂上了。
    // 无分片的回合预算按任务长度给：2026-11-17 固定 20 回合仍不够读一份 3.1KB 简报
    // （child-2 还是撞满 20 回合），而 child-1 干脆在 180s 上被掐。两个都不是「不会做」，
    // 是我们把预算按「默认值」拍死而不是按任务体量给。
    const taskChars = String(childTask || '').length;
    const turnCap = units > 0
      ? { maxTurns: Math.min(60, 8 + units * 3) }
      : { maxTurns: Number(process.env.ATWO_CHILD_MAX_TURNS || 0) || Math.min(60, 24 + Math.ceil(taskChars / 150)) };
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
  // 异源父审（2026-11-16）：默认沿用主力通道 —— 但主力与评审同源时只能抓矛盾与硬错。
  // 给了 reviewLane 就用那条通道的 ask；解析失败直接抛，不静默退回（否则会产生
  // 「以为异源、其实同源」的假象，而这种假象在结论层是看不出来的）。
  const reviewAsk = opts.reviewAsk || (opts.reviewLane ? resolveAsk(opts.reviewLane) : ask);
  const reviewLane = opts.reviewLane || (opts.ask ? 'injected' : 'codebuddy');
  // GUI 通道当父审时 180s 不够：2026-11-17 实测 trae 当父审，187.4s 仍未收工（它自己判 timedOut），
  // 而 codebuddy 审同一批只要 25.2s。通道的脾气不同，超时不能一刀切 ——
  // 但也不能无限等：给一个明确的上限，超了就报「通道太慢」，让人去换通道而不是重试到天亮。
  const GUI_REVIEW_LANES = new Set(['trae', 'workbuddy', 'doubao']);
  const guiReviewFloor = Number(process.env.ATWO_GUI_REVIEW_TIMEOUT_MS || 0) || 300000;
  const reviewTimeoutMs = (opts.reviewTimeoutMs == null ? (GUI_REVIEW_LANES.has(reviewLane) ? Math.max(timeoutMs, guiReviewFloor) : timeoutMs) : Number(opts.reviewTimeoutMs) || timeoutMs);
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
  if (opts.splitPlan && Array.isArray(opts.splitPlan.chunks) && opts.splitPlan.chunks.length >= 2) {
    // 外部已经算好并做过字节负载均衡的计划优先（lib/split-load.mjs 的 rebalanceByLoad 产物）。
    // 为什么不让 runFanout 自己再算一遍：均衡需要 stat 每个单元的字节数，这属于「读盘的尺子」，
    // 放 CLI 侧算一次、把结果当纯数据传进来，runFanout 就能保持可注入、可测。
    splitPlan = opts.splitPlan;
  } else if (opts.split) {
    const maxChunks = Number(opts.split) > 1 ? Math.floor(Number(opts.split)) : DEFAULT_MAX_CHUNKS;
    splitPlan = planSplit(task, { cwd, maxChunks });
  }
  if (splitPlan && splitPlan.chunks && splitPlan.chunks.length >= 2) {
    const first = jobs[0];
    const laneAsk = (typeof first === 'function' ? first : (first && first.ask)) || opts.ask || askCodeBuddy;
    const laneName = (first && first.lane) || 'codebuddy';
    jobs = splitPlan.chunks.map((c) => ({ ask: laneAsk, lane: laneName, model: undefined, task: chunkTask(task, c), chunkLabel: c.label, units: c.units.length }));
    // 片数也要夹在上限里：--split 12 会直接开出 12 路并发（2026-11-17 实测：12 路时单路
    // 从 4.85s 涨到 11.05s、吞吐停在 0.96/s，等于白花）。
    n = clampFanoutParts(jobs.length);
    if (jobs.length > n) { jobs = jobs.slice(0, n); }
    if (onProgress) onProgress({ phase: 'split', desc: describeSplit(splitPlan), chunks: n, units: splitPlan.units.length });
  } else if (splitPlan && onProgress) {
    onProgress({ phase: 'split-skip', reason: splitPlan.reason });
  }
  const planDesc = planned ? describePlan(planned) : 'codebuddy×' + n;

  // notes.md 的读法：每送一个父审片之前重读一次。原先只在子会话全部回来时读一次，
  // 流式送审之后第一片可能在半路就发出去了 —— 那时读过的「运行中指令」必须是最新的。
  const readNote = () => {
    if (!notesPath || !fs.existsSync(notesPath)) return '';
    return String(fs.readFileSync(notesPath, 'utf8') || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  };
  let note = readNote();
  if (note && onProgress) onProgress({ phase: 'notes', note });
  const refreshNote = () => {
    const v = readNote();
    if (v && v !== note) {
      note = v;
      if (onProgress) onProgress({ phase: 'notes', note });
    }
    return note;
  };

  // 父审真实耗时：只累「真把产物送给 LLM」的那一段。
  // 2026-11-17 实测的错账：3 份全被机械闸门判死、一次父审都没调，却报「子会话 256.6s + 审查 256.6s」——
  // 因为 ms 取的是整个 streamRound 的墙钟。这种账会让人去优化父审，而父审根本没跑。
  let llmReviewMs = 0;

  const reviewChunkDefault = () => (Number.isFinite(opts.reviewChunk) ? Math.max(0, Math.floor(opts.reviewChunk)) : 3);

  // 一片父审 = 一次独立的无状态调用。抽出来是为了让「批量」与「流式」两种送审
  // 走同一段代码 —— 否则两条路径的回合预算/错误理由迟早会漂。
  const runReviewChunk = async (slice) => {
    // 父审的回合预算必须按「这一片有几份」给：每份产物通常要核对 3–8 个引用行，
    // 而 codebuddy 的默认上限是 10 回合 —— 3 份一片时必然断在中途，返回的错误被当成「没给票」。
    // 2026-11-16 实测：不调这个值，6 片必丢 3 条票。
    const reviewMaxTurns = Number(process.env.ATWO_REVIEW_MAX_TURNS || 0) || Math.min(60, 12 + slice.length * 8);
    const text = buildReviewPrompt(task, slice, refreshNote(), collectRefs(slice, { cwd }).text);
    try {
      // 父会话只给 Read —— 它能去核对证据，但物理上改不了文件（原先「父只审不干」只是提示词）。
      // 硬墙：GUI 通道的 ask 不一定认我们传的 timeoutMs（2026-11-17 实测 workbuddy 当父审
      // 从 01:14 一直挂到 01:31，17 分钟没有任何结论，连 deadline 都没把它收住）。
      // 「每路超时」不能当成「整体会结束」—— 这里再套一层墙，超了就报「通道太慢」，
      // 让调用方拿到结论（unreviewed）而不是一个永远不返回的 promise。
      const capMs = Number(process.env.ATWO_REVIEW_HARD_CAP_MS || 0) || Math.max(reviewTimeoutMs + 60000, 240000);
      let capTimer = null;
      const capped = Promise.race([
        reviewAsk(text, { cwd, timeoutMs: reviewTimeoutMs, model: reviewModel, tools: 'Read', maxTurns: reviewMaxTurns }),
        new Promise((resolve) => { capTimer = setTimeout(() => resolve({ ok: false, timedOut: true, hardCap: true, err: '父审超过 ' + Math.round(capMs / 1000) + 's 未回（通道太慢，不是在思考）', addedText: '' }), capMs); }),
      ]);
      const __rt = Date.now();
      const rr = await capped.finally(() => { if (capTimer) clearTimeout(capTimer); });
      llmReviewMs += Date.now() - __rt;
      // 通道自己报了失败（ok:false 且带 err）时不许当成「父审没给票」：占位文案、超时、
      // 端口没通都长这样。理由要分得清，否则事后不知道该重跑还是该修解析。
      const laneErr = rr && rr.ok === false ? (rr.err || '通道返回 ok:false 且没给 err') : null;
      return { slice, text: (rr && rr.addedText) || '', err: laneErr };
    } catch (e) {
      return { slice, text: '', err: String(e && e.message || e) };
    }
  };

  // 把「机械结论 + 各片父审输出」拼成一次完整判定。机械结论里 id 与 deferred 不重叠，
  // 直接拼起来即可（不覆盖父审的判定）。
  // REVISE 必须带可核对引文（2026-11-17 子会话指出、父审核对通过）：
  // 真 REVISE 会精确到行（docs/decisions/2026-11-16-army.md:39-41 那种），
  // 而 011246 那次 ollama 把「同一句复读十余次」当理由判 REVISE，其实是误杀。
  // 没有「文件:行」的 REVISE 一律降级为没结论（unreviewed）—— 它不该触发重做，也不该算通过。
  const CITE_RE = /[\w./-]+\.(?:mjs|js|cjs|ts|json|md|py|yml|yaml|txt)(?::\d+)?/;
  const requireCitation = (rv) => {
    if (!rv || rv.verdict !== VERDICT.revise) return rv;
    const why = String(rv.reason || '');
    if (CITE_RE.test(why)) return rv;
    return { ...rv, verdict: VERDICT.none, downgraded: 'revise-without-citation', reason: '父审判了 REVISE 但理由里没有可核对的「文件:行」，降级为没结论（原话：' + why.slice(0, 120) + '）' };
  };

  const assembleReviews = (mech, outs, chunkCount) => {
    let raw = '', err = null;
    const partsReviews = [];
    for (const o of outs) {
      if (o.text) raw += (raw ? '\n\n' : '') + o.text;
      if (o.err) err = (err ? err + '; ' : '') + o.err;
      if (o.text) {
        partsReviews.push(...parseReview(o.text, o.slice.map((c) => c.id)));
      } else {
        // 空片不能记成「父审没给票」—— 那是解析问题；空片是调用失败，理由必须写清楚，
        // 否则事后只看到 3 条 unreviewed，分不清该重跑还是该修解析。
        const why = o.err ? '父审这一片调用失败：' + o.err
          : (o.text ? '父审回了 ' + String(o.text).length + ' 字但没有可解析的票（原始输出见 REVIEW-RAW.md）' : '父审这一片返回了空内容');
        for (const c of o.slice) partsReviews.push({ id: c.id, verdict: VERDICT.none, reason: why });
      }
    }
    const reviews = [...mech, ...partsReviews].map(requireCitation);
    const summary = summarizeFanout(reviews);
    summary.preGate = { mech: mech.length, deferred: reviews.length - mech.length };
    summary.reviewChunks = chunkCount;
    if (err) summary.error = err;
    return { raw, reviews, summary, preGate: summary.preGate, errs: outs.map((o) => o.err).filter(Boolean) };
  };

  // 第一层机械闸门（只判证据形式）单份版：判死的直接进 reviews，不送父审 ——
  // 父审一次 14–20s、几千 token，拿去读「没有行号」的产物是纯浪费。
  const gateOne = (child) => {
    if (opts.noPreGate) return { review: null };
    const { reviews, deferred } = preGateAll([child], { cwd });
    if (deferred.length) return { review: null };
    return { review: reviews[0] || { id: child.id, verdict: VERDICT.none, reason: '机械闸门未给出理由' } };
  };

  /** 批量送审（自愈回合用）：等全部产物回来，再按片并发。 */
  const reviewOnce = async (kids) => {
    const t = Date.now();
    const mech = [];
    const deferred = [];
    for (const c of kids) {
      const g = gateOne(c);
      if (g.review) mech.push(g.review);
      else deferred.push(c);
    }
    if (!deferred.length) {
      if (onProgress) onProgress({ phase: 'pregate-all-revise', n: mech.length });
      const r = assembleReviews(mech, [], 0);
      return { ...r, ms: Date.now() - t };
    }
    // 第二层：父审分片并行。2026-11-16 实测 8 份送一个父审要 67.4s（约 8s/份线性叠加），
    // 而父审是独立无状态调用 —— 拆成 3 份一片并发就能把墙钟压到 ~1/3。
    // 代价：跨产物的矛盾只能在片内发现（同一片的 3 份仍互相可见）。要全局矛盾就 --review-chunk 0。
    const chunkSize = reviewChunkDefault();
    const chunks = [];
    if (chunkSize <= 0) chunks.push(deferred);
    else for (let i = 0; i < deferred.length; i += chunkSize) chunks.push(deferred.slice(i, i + chunkSize));
    let doneChunks = 0;
    const outs = await Promise.all(chunks.map((slice) => runReviewChunk(slice).then((o) => {
      doneChunks += 1;
      if (onProgress) onProgress({ phase: 'review-chunk-done', done: doneChunks, total: chunks.length, ids: slice.map((c) => c.id) });
      return o;
    })));
    const r = assembleReviews(mech, outs, chunks.length);
    return { ...r, ms: Date.now() - t };
  };

  /** 流式送审（提速）：谁先回来谁先送审，不等最慢那一路。
   * 2026-11-17 实测的浪费：3 路子会话 12.3s 全回，父审 13.7s —— 串起来 26s；
   * 而父审只需要「够一片」的产物（默认 3 份），第一批回来就能开工。
   * 附带第二件事（投机重发）：机械闸门判死的产物不等父审，当场带机械理由重发一次。
   * 父审再快也要 14–20s，而机械红是可判定的失败，等它只是排队。 */
  const streamRound = async () => {
    const t = Date.now();
    const kids = new Array(n).fill(null);
    const mech = [];
    let buffer = [];
    let dispatched = 0;
    let completed = 0;
    const outs = [];
    const pending = [];
    const chunkSize = reviewChunkDefault();
    const flush = () => {
      if (!buffer.length) return;
      const slice = buffer;
      buffer = [];
      dispatched += 1;
      const mine = dispatched;
      pending.push(runReviewChunk(slice).then((o) => {
        completed += 1;
        if (onProgress) onProgress({ phase: 'review-chunk-done', done: completed, total: dispatched, ids: slice.map((c) => c.id) });
        outs.push({ ...o, order: mine });
        return o;
      }));
    };
    const one = async (i) => {
      let child = await runChild(jobs[i], task, i, n, cwd, timeoutMs, childModel, undefined, onProgress, childTools);
      let gate = gateOne(child);
      // 投机重发：只对「通道成功但违反产物形式」的那一路做，且只做一次。
      // 通道自己失败（ok:false）不重发 —— 那是环境问题，重发只是再烧一次同样的等待。
      const canResend = opts.speculativeResend !== false && !opts.noPreGate && child.ok !== false;
      if (gate.review && canResend) {
        if (onProgress) onProgress({ phase: 'speculative-resend', id: child.id, reason: gate.review.reason });
        const again = await runChild(jobs[i], task, i, n, cwd, timeoutMs, childModel, gate.review.reason, onProgress, childTools);
        if (again.ok !== false) {
          const gate2 = gateOne(again);
          if (!gate2.review || (again.answer && String(again.answer).length > String(child.answer || '').length)) {
            child = { ...again, retried: true, speculative: true, prevAnswer: child.answer };
            gate = gate2;
          }
        }
      }
      kids[i] = child;
      // 通道自己失败（ok:false）时不能记成「ANSWER 为空」—— 那是我们的问题描述错了。
      // 实测：Max turns 超限 / 通道占位 / 服务端错误 全都会落成 ANSWER 空，
      // 事后分不清「子会话没交」与「通道没送到」，也就不知道该重发还是该修环境。
      if (child.ok === false && gate.review) {
        gate = { review: { id: child.id, verdict: VERDICT.none, reason: '通道报错（不是产物问题）：' + String(child.raw || '').slice(0, 160) } };
      }
      if (gate.review) mech.push(gate.review);
      else buffer.push(child);
      if (chunkSize > 0 && buffer.length >= chunkSize) flush();
    };
    if (onProgress) onProgress({ phase: 'children-start', n, plan: planDesc });
    await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
    if (onProgress) onProgress({ phase: 'children-done', children: kids.filter(Boolean) });
    const childMs = Date.now() - t;
    flush();
    if (!pending.length) {
      if (onProgress) onProgress({ phase: 'pregate-all-revise', n: mech.length });
    }
    await Promise.all(pending);
    outs.sort((a, b) => a.order - b.order);
    const r = assembleReviews(mech, outs, dispatched);
    return { children: kids, ...r, childMs, ms: Date.now() - t };
  };

  const t1 = Date.now();
  const first = await streamRound();
  let children = first.children;
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
      const why = (bad.find((b) => b.id === c.id) || {}).reason;
      return runChild(jobs[c.index], task, c.index, n, cwd, timeoutMs, childModel, why, undefined, childTools).then((nc) => ({ ...nc, retried: true, prevAnswer: c.answer }));
    }));
    children = redone;
    current = await reviewOnce(children);
    rounds.push({ round: rounds.length + 1, children, reviews: current.reviews, summary: current.summary });
    if (onProgress) onProgress({ phase: 'fix-done', summary: current.summary });
  }

  // childrenMs 取「子会话阶段」的实际时长（流式送审后它不等于 t1-t0：
  // 父审已经在子会话还没全回来时开工了，两者重叠，不能相加也不能互相覆盖）。
  const elapsed = { childrenMs: Number.isFinite(first.childMs) ? first.childMs : t1 - t0, reviewMs: llmReviewMs, totalMs: Date.now() - t0, rounds: rounds.length };

  // 真实跑过的父审也进台账：探活只是模拟（一份产物三张票），真跑的成/败更有信息量。
  // reviewLane 是 'injected'（测试注入 ask）时不记 —— 那不是真实通道的可用性。
  if (reviewLane && reviewLane !== 'injected') {
    const laneErr = (current.errs && current.errs.length) ? current.errs.join('；') : null;
    appendEntry(cwd, { lane: reviewLane, ok: !laneErr, ms: elapsed.reviewMs, reason: laneErr ? String(laneErr).slice(0, 200) : null, chunks: current.raw ? current.raw.length : 0, source: 'fanout' });
  }

  return {
    task, cwd, parts: n, plan: planned, planDesc, probes, children, reviews: current.reviews, summary: current.summary, notes: note,
    split: splitPlan && splitPlan.chunks && splitPlan.chunks.length ? { desc: describeSplit(splitPlan), chunks: n, units: splitPlan.units.length } : null,
    merged: mergeParts(children, splitPlan),
    reviewRaw: current.raw, elapsed, rounds, error: current.summary.error || null,
    // 谁审的：产物与汇总里都要留痕，否则事后无法回答「这份结论是不是同源自审」。
    reviewLane, writerLane: planned ? 'planned' : (opts.ask ? 'injected' : 'codebuddy'),
    homogeneous: reviewLane === (planned ? 'planned' : (opts.ask ? 'injected' : 'codebuddy')),
  };
}
export function finishFanout(result, dir) {
  // 先落快照再写 FANOUT.md：产物里引用的行号只对「当时那些字节」有意义，
  // 事后拿现在的仓库核引用等于测「仓库动过没有」（2026-11-17 盲测踩过）。
  try {
    const texts = (result.children || []).map((c) => String(c.raw || '') + '\n' + String(c.answer || '') + '\n' + String(c.evidence || ''));
    writeSnapshot(dir, { cwd: result.cwd || process.cwd(), texts });
  } catch (e) {
    // 快照落不下不该带崩调用方，但绝不能静默：盲测需要知道这份产物没有快照。
    process.stderr.write('[snapshot] 没落成：' + (e && e.message) + '\n');
  }
  const file = writeFanout(dir, { task: result.task, children: result.children, reviews: result.reviews, summary: result.summary, merged: result.merged, reviewRaw: result.reviewRaw, meta: { elapsed: result.elapsed, parts: result.parts, notes: result.notes || '', split: result.split || null, reviewLane: result.reviewLane || null, homogeneous: result.homogeneous !== false } });
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
