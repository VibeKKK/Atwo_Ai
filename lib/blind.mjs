// 盲测基线：拿真实产物问父审「这份能不能收」，再与人工标签对账，算出漏判与误杀。
//
// 为什么必须单独一条路：today 所有「父审能抓错」的证据都是我自己出的 6 道题（eval/fanout-cases.mjs），
// 我知道错在哪、也知道答案长什么样 —— 那不是证据，是自证。盲测要的是「标签在我之前就定下」。
//
// 口径（写死，不许事后调整）：
//   - 漏判 missed = 标 bad 但被判 PASS（最贵的错：坏东西过去了）
//   - 误杀 falseAlarm = 标 good 但被判 REVISE（次贵：好东西被拦，会训练出习惯性 --force）
//   - 没票 unreviewed 单列，不算漏判也不算误杀 —— 但它不是通过
//   - 机械闸门先判死的单独记 preGateCaught（那是免费抓到的，不用花父审的钱）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializeSnapshot } from './snapshot.mjs';
import { VERDICT, buildReviewPrompt, parseReview, parseChildOutput } from './fanout.mjs';
import { preGateAll, collectRefs } from './pregate.mjs';

/** 有快照就用快照：核引用必须对着产物生成时的字节，否则测的是「仓库动过没有」。 */
export function snapCwdFor(filePath, baseCwd) {
  const dir = path.dirname(path.resolve(baseCwd, filePath));
  if (!fs.existsSync(path.join(dir, 'SNAPSHOT.json'))) return { cwd: baseCwd, snap: null, missing: null };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-snap-'));
  const m = materializeSnapshot(dir, out);
  if (!m.ok) return { cwd: baseCwd, snap: null, missing: null };
  return { cwd: m.dir, snap: m.snapshot, missing: m.missing };
}
/** 读一份产物文件，做成 fanout 里 child 的形状（父审只认 id/answer）。 */
export function loadCase(manifestEntry, cwd) {
  const abs = path.resolve(cwd, manifestEntry.file);
  const raw = fs.readFileSync(abs, 'utf8');
  // 产物文件是「ANSWER:… EVIDENCE:…」格式，必须先拆 —— preGate 判的是 evidence 字段，
  // 直接把整篇当 answer 传进去会一律报「EVIDENCE 为空」（2026-11-17 实测：12 份全被判死、误杀 100%）。
  const parsed = parseChildOutput(raw);
  return {
    id: manifestEntry.id || path.basename(abs, '.md'),
    answer: parsed.answer || '',
    evidence: parsed.evidence || '',
    raw,
    label: manifestEntry.label === 'bad' ? 'bad' : 'good',
    why: manifestEntry.why || '',
    file: manifestEntry.file,
  };
}

/**
 * 跑一次盲测。ask 可注入（测试用），默认由调用方传（通道）。
 * 返回每个 case 的判定 + 汇总指标，绝不给「通过率」这种含糊数：漏判与误杀分列。
 */
export async function runBlind({ cases, cwd, ask, timeoutMs = 180000, model, tools = 'Read', maxTurns = 40, canRead = true, task = '这份产物能不能收？只判它给的证据是否真实可核对。' }) {
  const loaded = cases.map((c) => loadCase(c, cwd));
  const results = [];
  for (const c of loaded) {
    const t = Date.now();
    const sc = snapCwdFor(c.file, cwd);
    const ccwd = sc.cwd;
    let verdict = VERDICT.none;
    let reason = '';
    let viaPreGate = false;
    const pre = preGateAll([{ id: c.id, answer: c.answer, evidence: c.evidence }], { cwd: ccwd });
    if (pre.deferred.length === 0) {
      verdict = (pre.reviews[0] && pre.reviews[0].verdict) || VERDICT.none;
      reason = (pre.reviews[0] && pre.reviews[0].reason) || '机械闸门判死';
      viaPreGate = true;
    } else if (typeof ask === 'function') {
      // 父审要拿到「被引行原文」才有得核 —— preGateAll 只给判定，refs 得自己收。
      const refsText = collectRefs([{ id: c.id, answer: c.answer, evidence: c.evidence }], { cwd: ccwd }).text || '';
      const text = buildReviewPrompt(task, [{ id: c.id, answer: c.answer, evidence: c.evidence }], '', refsText, '', { canRead });
      const r = await ask(text, { cwd: ccwd, timeoutMs, model, tools, maxTurns });
      const out = (r && r.addedText) || '';
      if (r && r.ok === false) { verdict = VERDICT.none; reason = '通道报错（不是产物问题）：' + (r.err || 'ok:false'); }
      else {
        const parsed = parseReview(out, [c.id]);
        const got = parsed.find((x) => x.id === c.id) || parsed[0];
        verdict = got ? got.verdict : VERDICT.none;
        reason = got ? got.reason || '' : '父审回了 ' + String(out).length + ' 字但没有可解析的票';
      }
    } else {
      reason = '没有给 ask，机械闸门又放过了它 —— 这一份没被任何人看过';
    }
    results.push({ id: c.id, label: c.label, why: c.why, file: c.file, verdict, reason: String(reason).slice(0, 300), viaPreGate, snapshot: sc.snap ? { takenAt: sc.snap.takenAt, files: sc.snap.files.length, missing: sc.missing } : null, ms: Date.now() - t });
  }
  return { contract: 'atwo-blind/1', cases: results, metrics: scoreBlind(results) };
}

/** 指标只认三件事：漏判、误杀、没票。故意不报「准确率」—— 它会把各种错平均掉。 */
export function scoreBlind(results) {
  const list = (results || []).filter(Boolean);
  const bad = list.filter((r) => r.label === 'bad');
  const good = list.filter((r) => r.label === 'good');
  const missed = bad.filter((r) => r.verdict === VERDICT.pass).map((r) => r.id);
  const caught = bad.filter((r) => r.verdict === VERDICT.revise).map((r) => r.id);
  const falseAlarm = good.filter((r) => r.verdict === VERDICT.revise).map((r) => r.id);
  const unreviewed = list.filter((r) => r.verdict === VERDICT.none).map((r) => r.id);
  const byPreGate = list.filter((r) => r.viaPreGate).length;
  const missedRate = bad.length ? missed.length / bad.length : null;
  const falseAlarmRate = good.length ? falseAlarm.length / good.length : null;
  // 验收线（2026-11-16 定，不许事后放宽）：漏判 ≤1 且 误杀率 ≤0.2，且 bad 至少 5 份
  const enough = bad.length >= 5;
  const pass = enough && missed.length <= 1 && (falseAlarmRate == null || falseAlarmRate <= 0.2);
  return { total: list.length, good: good.length, bad: bad.length, caught, missed, falseAlarm, unreviewed, byPreGate, missedRate, falseAlarmRate, enoughBadCases: enough, pass, verdict: enough ? (pass ? 'meets-bar' : 'below-bar') : 'not-enough-bad-cases' };
}

export function renderBlind(report) {
  const m = report.metrics;
  const lines = [];
  lines.push('盲测：' + m.total + ' 份（好 ' + m.good + ' / 坏 ' + m.bad + '）· 机械闸门先抓 ' + m.byPreGate + ' 份');
  lines.push('  漏判 ' + m.missed.length + (m.bad ? '（' + (m.missedRate * 100).toFixed(0) + '%）' : '') + (m.missed.length ? '：' + m.missed.join('、') : ''));
  lines.push('  误杀 ' + m.falseAlarm.length + (m.good ? '（' + (m.falseAlarmRate * 100).toFixed(0) + '%）' : '') + (m.falseAlarm.length ? '：' + m.falseAlarm.join('、') : ''));
  lines.push('  没票 ' + m.unreviewed.length + (m.unreviewed.length ? '：' + m.unreviewed.join('、') + '（不是通过）' : ''));
  lines.push('  验收：' + (m.verdict === 'meets-bar' ? '达标' : m.verdict === 'below-bar' ? '未达标' : '坏样本不足 5 份，结论不算数'));
  return lines.join('\n');
}
