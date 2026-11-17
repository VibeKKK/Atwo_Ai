// atwo blind —— 用客观标签（lib/labelizer.mjs）跑盲测，顺便把「人工标签 vs 客观标签」的不一致列出来。
//
// 这是 2026-11-17 那次「误杀 86%」的修法：先由 labelizer 对产物自己的引用做逐字核对定标签，
// 再让父审判一次，最后只报三件事 —— 漏判（标 bad 却 PASS）/ 误杀（标 good 却 REVISE）/ 没票。
// 与 lib/blind.mjs 的区别：那版标签是人手贴的，这版标签是读字节算出来的；两版口径都留着对照。
import fs from 'node:fs';
import path from 'node:path';
import { loadCase, snapCwdFor } from './blind.mjs';
import { labelCases, labelClassOfHand, labelClassOfObjective } from './labelizer.mjs';
import { runBlind } from './blind.mjs';
import { VERDICT } from './fanout.mjs';

export const BLIND_CONTRACT = 'atwo-blind-objective/1';

export function readManifest(manifestPath, cwd) {
  const p = path.resolve(cwd, manifestPath);
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cases = Array.isArray(m) ? m : m.cases || [];
  return { ok: true, path: p, note: m.note || '', cases };
}

/**
 * 全量跑：每份产物先用「它自己的快照」定客观标签（有快照就用快照字节），再送父审。
 * ask 可注入（测试用）；不给 ask 就只算客观标签、不花父审的钱（第一批跑法：先看标签对不对）。
 */
export async function runObjectiveBlind({ manifestPath, cwd, ask = null, timeoutMs = 180000, limit = 0, parts = 4, onProgress = null }) {
  const man = readManifest(manifestPath, cwd);
  if (!man.cases.length) return { ok: false, reason: 'manifest-empty' };
  const picked = limit > 0 ? man.cases.slice(0, limit) : man.cases;
  // 客观标签必须对着「产物生成时的字节」算，所以逐份切快照目录。
  const labelled = [];
  for (const entry of picked) {
    const c = loadCase(entry, cwd);
    const sc = snapCwdFor(c.file, cwd);
    const one = labelCases([{ id: c.id, file: c.file, label: c.label, answer: c.answer, evidence: c.evidence }], { cwd: sc.cwd });
    labelled.push({ entry, case: c, label: one.rows[0], snap: sc.snap ? 'used' : 'none', snapCwd: sc.cwd });
  }
  const counts = { exact: 0, sloppy: 0, bad: 0, empty: 0, unknown: 0 };
  for (const x of labelled) counts[x.label.objective]++;
  const disagree = labelled
    .filter((x) => labelClassOfHand(x.label.hand) && labelClassOfObjective(x.label.objective) && labelClassOfHand(x.label.hand) !== labelClassOfObjective(x.label.objective))
    .map((x) => ({ id: x.label.id, hand: x.label.hand, objective: x.label.objective, why: x.label.why }));

  let review = null;
  if (typeof ask === 'function') {
    review = {};
    // 逐份独立：34 份串行跑要十几分钟且全程无输出（2026-11-17 实测跑了 12 分钟还是 0 字节日志）。
    // 并发 4 路（实测拐点 6–8 路，这里保守取 4），每份回来就打一行进度。
    const queue = labelled.slice();
    let qidx = 0;
    const worker = async () => { while (qidx < queue.length) { const x = queue[qidx++]; await reviewOne(x); } };
    const reviewOne = async (x) => {
      const r = await runBlind({ cases: [{ id: x.case.id, file: x.case.file, label: (x.label.objective === 'bad' || x.label.objective === 'sloppy' || x.label.objective === 'empty') ? 'bad' : 'good', answer: x.case.answer, evidence: x.case.evidence }], cwd, ask, timeoutMs });
      const one = (r.cases || r.results || [])[0] || {};
      const v = one.verdict || VERDICT.none;
      const obj = x.label.objective;
      // 没票不是漏判也不是通过（父审没交卷 ≠ 坏东西过去了）
      // exact 才算「本该放行」；sloppy/bad/empty 都是有缺陷的产物，父审打回是对的
      const defect = obj === 'sloppy' || obj === 'bad' || obj === 'empty';
      const bucket = v === VERDICT.none ? 'unreviewed'
        : (obj === 'unknown' ? 'unknown'
          : (defect ? (v === VERDICT.pass ? 'missed' : 'caught')
            : (v === VERDICT.revise ? 'falseAlarm' : 'ok')));
      review[x.case.id] = { verdict: v, bucket, reason: one.reason || '', viaPreGate: !!one.viaPreGate };
      if (typeof onProgress === 'function') { try { onProgress(x.case.id, review[x.case.id], Object.keys(review).length, labelled.length); } catch {} }
    };
    const n = Math.max(1, Math.min(Number(parts) || 4, queue.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
  }
  const s = review ? summarizeReview(labelled, review) : null;
  return { ok: true, contract: BLIND_CONTRACT, manifest: man.path, note: man.note, total: labelled.length, counts, disagree, review: s, rows: labelled.map((x) => ({ id: x.label.id, file: x.case.file, hand: x.label.hand, objective: x.label.objective, why: x.label.why, facts: x.label.facts, snap: x.snap, reviewed: review ? review[x.case.id] : null })) };
}

export function summarizeReview(labelled, review) {
  const sum = { reviewed: 0, caught: 0, missed: 0, falseAlarm: 0, unknown: 0, ok: 0, missedIds: [], falseAlarmIds: [], unreviewed: 0, defects: 0, exactN: 0 };
  for (const x of labelled) {
    // 样本量：有缺陷的份数（sloppy/bad/empty）与「本该放行」的份数（exact）。
    // 分母不够就报不了误杀率 —— 2026-11-17 实测 12 份里 exact 只有 0 份，那次数字因此无效。
    const obj = x.label.objective;
    if (obj === 'sloppy' || obj === 'bad' || obj === 'empty') sum.defects++;
    if (obj === 'exact') sum.exactN++;
    const r = review[x.label.id];
    if (!r) continue;
    if (r.bucket === 'unreviewed') { sum.unreviewed++; continue; }
    if (r.bucket === 'unknown') { sum.unknown++; continue; }
    sum.reviewed++;
    if (r.bucket === 'caught') sum.caught++;
    if (r.bucket === 'missed') { sum.missed++; sum.missedIds.push(x.label.id); }
    if (r.bucket === 'falseAlarm') { sum.falseAlarm++; sum.falseAlarmIds.push(x.label.id); }
    if (r.bucket === 'ok') sum.ok++;
  }
  // 误杀率的分母只能是「本该放行的份数」（exact）—— 拿全部 reviewed 当分母会把缺陷份数混进分母，
  // 让误杀率被稀释（2026-11-17 那次的 0.182 就是这么算出来的，实际是 2/2）。
  sum.falseAlarmRate = sum.exactN > 0 ? Number((sum.falseAlarm / sum.exactN).toFixed(3)) : null;
  // 验收线三条：① 有缺陷样本 ≥5 ② 本该放行样本 ≥3（否则误杀率没有分母）
  // ③ 漏判 ≤1 且误杀率 ≤0.2。样本不够就报 not-enough-cases，不许报 meets-bar。
  sum.verdict = (sum.defects < 5 || sum.exactN < 3) ? 'not-enough-cases'
    : (sum.missed <= 1 && sum.falseAlarmRate <= 0.2 ? 'meets-bar' : 'below-bar');
  return sum;
}

export function renderBlindObjective(r) {
  const L = [];
  L.push('盲测（客观标签）· 共 ' + r.total + ' 份：exact ' + r.counts.exact + ' · sloppy ' + r.counts.sloppy + ' · bad ' + r.counts.bad + ' · empty ' + r.counts.empty + ' · unknown ' + r.counts.unknown);
  if (r.disagree.length) L.push('  人工标签与客观标签不一致 ' + r.disagree.length + ' 份（人工标签不可引用）：' + r.disagree.map((d) => d.id + ' 人工=' + d.hand + ' 客观=' + d.objective).join(' · '));
  else L.push('  人工标签与客观标签全部一致');
  if (r.review) {
    L.push('  父审：' + r.review.reviewed + ' 份有结论（其中抓到 ' + r.review.caught + ' · 放过真坏的 ' + r.review.missed + '）· 漏判 ' + r.review.missed + (r.review.missedIds.length ? '（' + r.review.missedIds.join(',') + '）' : '') + ' · 误杀 ' + r.review.falseAlarm + (r.review.falseAlarmIds.length ? '（' + r.review.falseAlarmIds.join(',') + '）' : '') + ' · 没票 ' + r.review.unreviewed);
    L.push('  样本：有缺陷 ' + r.review.defects + ' 份 · 本该放行 ' + r.review.exactN + ' 份');
    L.push('  误杀率 ' + (r.review.falseAlarmRate == null ? '—（没有本该放行的样本，算不出）' : r.review.falseAlarmRate) + ' · 判定 ' + r.review.verdict);
  } else {
    L.push('  （只打了标签，没跑父审：给 --lane 才会花 LLM 的钱）');
  }
  return L.join('\n');
}

export function makeBlindVerb({ EXIT, RESULT, HERE, die, resolveAsk }) {
  return async function cmdBlind(argv) {
    const opt = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; return v && !String(v).startsWith('--') ? v : ''; };
    const manifestPath = opt('--manifest') || 'eval/blind-manifest.json';
    const lane = opt('--lane');
    const limit = Number(opt('--limit')) || 0;
    const timeoutMs = Number(opt('--timeout')) || 180000;
    const parts = Number(opt('--parts')) || 4;
    let ask = null;
    if (lane) {
      try { ask = resolveAsk(lane); } catch (e) { die('这个通道用不了：' + (e && e.message), EXIT.channel); }
    }
    const onProgress = (id, row, done, total) => {
      process.stderr.write('[' + String(done).padStart(2) + '/' + total + '] ' + id + ' → ' + row.bucket + (row.viaPreGate ? '（机械闸门）' : '') + String.fromCharCode(10));
    };
    const r = await runObjectiveBlind({ manifestPath, cwd: HERE, ask, timeoutMs, limit, parts, onProgress });
    if (!r.ok) die('盲测没跑成：' + r.reason, EXIT.precondition);
    // 明细跟着 manifest 走：原先固定写 blind-objective.json，跑第二份 manifest 会把第一份的结果覆盖掉。
    const base = path.basename(manifestPath).replace(/\.json$/, '');
    const out = path.join(HERE, 'eval', base + '-report.json');
    fs.writeFileSync(out, JSON.stringify(r, null, 2) + '\n', 'utf8');
    RESULT.data = { contract: r.contract, total: r.total, counts: r.counts, disagree: r.disagree, review: r.review, wrote: out };
    console.log(renderBlindObjective(r));
    console.log('  明细：' + out);
    if (r.review && r.review.verdict === 'below-bar') return EXIT.accept;
    return EXIT.ok;
  };
}