// lib/army-run.mjs —— 三三制阵型的执行层：侦察 1 路 → 主力 N 路异题并发 → 评审 M 路并发 → 票面结算。
// 判定全在 lib/army.mjs（纯函数），这里只负责真的把活派出去。
//
// 复用什么、不复用什么：
//   复用 —— fanout 的子会话契约（buildChildPrompt/parseChildOutput）、评审票解析（parseReview）、
//          机械闸门（pregateAll）、票面结算（vm/votes.mjs 的 judgeVotes）。
//   不复用 —— 不复制 runFanout：三段是串行的，主力是「异题并行」而不是「同题 N 路」，
//          硬塞进 fanout 会让两边的默认值互相打架。
import fs from 'node:fs';
import path from 'node:path';
import { askCodeBuddy } from '../agents/codebuddy.mjs';
import { askOllama, probeOllama } from '../agents/ollama.mjs';
import { READ_ONLY_TOOLS } from './fanout-run.mjs';
import { buildChildPrompt, parseChildOutput, parseReview } from './fanout.mjs';
import { preGateAll } from './pregate.mjs';
import {
  ARMY_LIMITS, buildArmyReviewPrompt, buildMainTask, buildScoutPrompt, parseScout,
  pickUnits, renderArmy, settleArtifacts, summarizeArmy, validateArmy,
} from './army.mjs';

const p2 = (v) => String(v).padStart(2, '0');
const errText = (e) => String((e && e.message) || e || 'unknown');

/** 一次 ask 的封装：统一返回 {ok, text, ms, err}，绝不抛到外层（一路失败不该炸掉整场）。 */
async function askOne(ask, prompt, opts) {
  const t = Date.now();
  try {
    const r = await ask(prompt, opts);
    const text = (r && (r.addedText != null ? r.addedText : (r.text != null ? r.text : r.answer))) || '';
    return { ok: !!(r && r.ok !== false && String(text).trim()), text: String(text), ms: Date.now() - t, err: null };
  } catch (e) {
    return { ok: false, text: '', ms: Date.now() - t, err: errText(e) };
  }
}

/** 侦察段选通道：默认 auto —— 本地 ollama 通就用它（快、免费），否则 codebuddy。
 *  无论选谁，产出都会在 parseScout 里被强制标成候选。 */
async function pickScoutLane(opts) {
  // 测试注入：给了 opts.ask 就不探测通道（自测不该被一次 /api/version 探测拖慢）。
  if (typeof opts.ask === 'function') return { lane: opts.scoutLane || 'codebuddy', ask: opts.ask };
  if (opts.scoutLane && opts.scoutLane !== 'auto') {
    return { lane: opts.scoutLane, ask: opts.scoutLane === 'ollama' ? askOllama : askCodeBuddy };
  }
  try {
    const r = await probeOllama(3000);
    if (r && r.ok) return { lane: 'ollama', ask: askOllama };
  } catch { /* 探测失败就走云端 */ }
  return { lane: 'codebuddy', ask: askCodeBuddy };
}

async function runArmyInner(opts) {
  const prd = String(opts.task || opts.prd || '').trim();
  if (!prd) throw new Error('army：缺少 PRD（-t 或位置参数）');
  const cwd = opts.cwd || process.cwd();
  const unitsPick = pickUnits(prd, { cwd, units: opts.units });
  const units = unitsPick.units;
  // 不在这里夹：夹一下会让用法错变成「1 路」静默运行（CLI 层已严格解析，这里只做兜底判定）。
  const reviewers = opts.reviewers == null ? 1 : Math.floor(Number(opts.reviewers));
  if (!Number.isFinite(reviewers) || reviewers < ARMY_LIMITS.minReviewers || reviewers > ARMY_LIMITS.maxReviewers) {
    throw new Error('reviewers 必须是 ' + ARMY_LIMITS.minReviewers + '-' + ARMY_LIMITS.maxReviewers + ' 的整数：收到 ' + JSON.stringify(opts.reviewers));
  }
  const gate = validateArmy({ units, reviewers });
  if (!gate.ok) {
    const e = new Error(gate.reason + '：' + gate.hint);
    e.reason = gate.reason;
    e.units = units;
    throw e;
  }
  const timeoutMs = Number(opts.timeoutMs) || 180000;
  const onProgress = opts.onProgress || (() => {});
  const t0 = Date.now();

  // ── 第一段：侦察 ───────────────────────────────────────────────
  const scoutLane = await pickScoutLane(opts);
  onProgress({ phase: 'scout-start', lane: scoutLane.lane, units: units.length });
  const scoutOut = await askOne(scoutLane.ask, buildScoutPrompt(prd, units), {
    cwd, timeoutMs, model: opts.scoutModel || undefined, tools: READ_ONLY_TOOLS, maxTurns: 14,
  });
  const scout = parseScout(scoutOut.text, { model: opts.scoutModel || scoutLane.lane });
  const scoutMs = Date.now() - t0;
  onProgress({ phase: 'scout-done', lane: scoutLane.lane, candidates: scout.total, ms: scoutMs, err: scoutOut.err });

  // ── 第二段：主力（异题并行，一单元一路）──────────────────────
  const mainLane = opts.mainLane || 'codebuddy';
  const mainAsk = typeof opts.ask === 'function' ? opts.ask : (mainLane === 'ollama' ? askOllama : askCodeBuddy);
  const mainT0 = Date.now();
  onProgress({ phase: 'children-start', n: units.length, plan: mainLane + '×' + units.length });
  const mainResults = await Promise.all(units.map(async (unit, i) => {
    const prompt = buildChildPrompt(buildMainTask(unit, prd, scout), i, units.length);
    const r = await askOne(mainAsk, prompt, {
      cwd, timeoutMs, model: opts.mainModel || undefined, tools: READ_ONLY_TOOLS, maxTurns: 20,
    });
    const parsed = parseChildOutput(r.text);
    const out = {
      id: 'unit-' + (i + 1), index: i, unit, lane: mainLane,
      ok: r.ok, elapsedMs: r.ms, raw: r.text, answer: parsed.answer, evidence: parsed.evidence,
      malformed: !!parsed.malformed || !r.ok, err: r.err,
    };
    onProgress({ phase: 'child-done', id: out.id, lane: mainLane, ok: out.ok, elapsedMs: r.ms, chars: String(r.text).length, unit });
    return out;
  }));
  const mainMs = Date.now() - mainT0;

  // ── 第三段：评审（只找反例；多路是为了到票率与分歧，不是为了投票凑数）──
  const reviewLane = opts.reviewLane || 'codebuddy';
  const reviewAsk = typeof opts.reviewAsk === 'function' ? opts.reviewAsk : (typeof opts.ask === 'function' ? opts.ask : (reviewLane === 'ollama' ? askOllama : askCodeBuddy));
  // 机械闸门：缺「文件:行」的产物不送评审 —— 评审一次几千 token，拿去读没有引证的产物是纯浪费。
  const pre = opts.noPreGate ? { reviews: [], deferred: mainResults } : preGateAll(mainResults, { cwd });
  const mechById = new Map(pre.reviews.map((r) => [r.id, r]));
  const reviewT0 = Date.now();
  const reviewMaxTurns = Math.min(60, 14 + units.length * 8);
  onProgress({ phase: 'review-start', reviewers, n: pre.deferred.length, preGate: pre.reviews.length });
  const passes = await Promise.all(Array.from({ length: reviewers }, async (_, ri) => {
    const prompt = buildArmyReviewPrompt(prd, pre.deferred, { note: opts.note });
    const r = await askOne(reviewAsk, prompt, {
      cwd, timeoutMs, model: opts.reviewModel || undefined, tools: 'Read', maxTurns: reviewMaxTurns,
    });
    const ids = pre.deferred.map((a) => a.id);
    const parsed = r.ok && r.text ? parseReview(r.text, ids) : ids.map((id) => ({ id, verdict: 'unreviewed', reason: r.err ? '评审调用失败：' + r.err : '评审返回了空内容' }));
    onProgress({ phase: 'reviewer-done', reviewer: ri + 1, ok: r.ok, ms: r.ms, votes: parsed.length });
    // 原始文本必须留：只存结算后的票，误杀就无从追溯（本次 unit-2 被判 REVISE 却看不到理由）。
    return { votes: parsed, raw: r.text || '', ok: r.ok, err: r.err || null };
  }));
  const reviewMs = Date.now() - reviewT0;

  const settled = settleArtifacts(mainResults, passes.map((p) => p.votes)).map((s) => {
    const m = mechById.get(s.id);
    if (!m) return s;
    // 机械闸门判死的产物：票面不参与（它连评审都没进），直接 REVISE，理由保留机械判据。
    return { ...s, value: -1, state: 'REVISE', reason: 'pre-gate', reasonText: m.reason, confidence: s.confidence };
  });
  const summary = summarizeArmy(settled);
  const elapsed = { scoutMs, mainMs, reviewMs, totalMs: Date.now() - t0 };

  return {
    task: prd, units, unitsFrom: unitsPick.from, scout, artifacts: mainResults, reviewPasses: passes.map((p) => p.votes),
    reviewRaw: passes.map((p, i) => ({ reviewer: i + 1, ok: p.ok, err: p.err, chars: String(p.raw || '').length, text: p.raw })),
    settled, summary, elapsed, preGate: { mech: pre.reviews.length, deferred: pre.deferred.length },
    sources: {
      scout: opts.scoutModel || scoutLane.lane,
      main: mainLane + (opts.mainModel ? ':' + opts.mainModel : ''),
      review: reviewLane + (opts.reviewModel ? ':' + opts.reviewModel : ''),
      reviewers,
      // 同源不是错，但不能假装是异源：同模型不同调用只能抓矛盾与硬错，抓不了同源共错。
      homogeneous: reviewLane === mainLane && String(opts.reviewModel || '') === String(opts.mainModel || ''),
    },
    error: null,
  };
}

/** 墙钟兜底：与 runFanout 同理 —— 每段有超时不等于整体会结束（孙进程握着管道）。 */
export async function runArmy(opts) {
  const timeoutMs = Number(opts && opts.timeoutMs) || 180000;
  const deadlineMs = Number(opts && opts.deadlineMs) || (timeoutMs * 4 + 180000);
  let timer = null;
  const guard = new Promise((resolve) => {
    // 不 unref（同 runFanout 的坑：unref 会让进程没有句柄直接退出，兜底返回值都拿不到）。
    timer = setTimeout(() => resolve({ __deadline: true }), deadlineMs);
  });
  let res;
  try {
    res = await Promise.race([runArmyInner(opts), guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res && res.__deadline) {
    return {
      task: String((opts && opts.task) || ''),
      units: [], artifacts: [], reviewPasses: [], settled: [],
      summary: { value: 0, state: 'unreviewed', counts: { ACCEPT: 0, REVISE: 0, unreviewed: 0 }, total: 0, confidence: null, deadlineHit: true },
      scout: { total: 0, skeleton: [], risks: [], checks: [], empty: true, model: 'none' },
      elapsed: { scoutMs: 0, mainMs: 0, reviewMs: 0, totalMs: deadlineMs },
      sources: { scout: 'n/a', main: 'n/a', review: 'n/a', reviewers: 0, homogeneous: true },
      error: 'deadline：整体跑了 ' + Math.round(deadlineMs / 1000) + 's 仍未收齐（每段超时不会让整体结束 —— 见 runArmy 注释）',
      deadlineHit: true,
    };
  }
  return res;
}

/** 落盘：ARMY.md（三段全记录）+ 每路产物一个文件。 */
export function finishArmy(result, dir, task) {
  fs.mkdirSync(dir, { recursive: true });
  for (const a of result.artifacts) {
    fs.writeFileSync(path.join(dir, a.id + '.md'), ['# ' + a.id + ' · ' + a.unit, '', 'ANSWER:', a.answer || '(空)', '', 'EVIDENCE:', a.evidence || '(空)', ''].join('\n'), 'utf8');
  }
  const md = renderArmy({ prd: result.task || task, units: result.units, scout: result.scout, artifacts: result.artifacts, settled: result.settled, summary: result.summary, elapsed: result.elapsed, sources: result.sources });
  const file = path.join(dir, 'ARMY.md');
  fs.writeFileSync(file, md, 'utf8');
  // 评审原文另存一份：票面只留机器码，判错了要靠这段原文定位是谁在瞎判。
  if (Array.isArray(result.reviewRaw) && result.reviewRaw.length) {
    const raw = ['# 评审原始输出（每路一份，误杀从这里查）', '',
      ...result.reviewRaw.map((r) => ['## 评审 ' + r.reviewer + (r.ok ? '' : ' · 调用失败：' + r.err), '', r.text || '(空)', ''].join('\n')),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'REVIEW-RAW.md'), raw, 'utf8');
  }
  return file;
}

/** 目录命名与 fanout 一致：.atw/army/<yyyymmdd-hhmmss>/ */
export function armyStamp(now = new Date()) {
  return '' + now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '-' + p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds());
}
