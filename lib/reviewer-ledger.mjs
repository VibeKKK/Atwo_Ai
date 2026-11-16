// lib/reviewer-ledger.mjs —— 异源父审的「可用性台账」（2026-11-17）
//
// 为什么要台账：异源评审的价值全压在「另一家真的能读、真的会给票」上。
// 而这件事昨天只有一句话的证据（"trae 那次回了 9 字节「思考中」"），人一换会话就丢。
// 台账把每次探活与每次真跑都记成一行 JSON：谁、什么时候、多久、成没成、失败原因。
// 之后「哪个通道能当父审」不再靠回忆，而是 readLedger().filter(verdict === 'usable')。
//
// 落盘位置：memory/reviewer-ledger.jsonl（memory/ 在 .gitignore 里 —— 这是运行时证据，不是源码）。
import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_CONTRACT = 'atwo-reviewer-ledger/1';
/** 判「可用」的门槛：最近 5 次里至少 3 次成，且失败不连续超 2 次。 */
export const USABLE_MIN_OK = 3;
export const USABLE_WINDOW = 5;

const dirOf = (cwd) => path.join(cwd || process.cwd(), 'memory');
export const ledgerPath = (cwd) => path.join(dirOf(cwd), 'reviewer-ledger.jsonl');

/** 记一行。失败吞掉：台账是旁证，不该让一次探活把调用方带崩。 */
export function appendEntry(cwd, entry) {
  try {
    fs.mkdirSync(dirOf(cwd), { recursive: true });
    const row = { v: 1, contract: LEDGER_CONTRACT, ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(ledgerPath(cwd), JSON.stringify(row) + '\n');
    return row;
  } catch { return null; }
}

export function readLedger(cwd, opts = {}) {
  const file = ledgerPath(cwd);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of String(fs.readFileSync(file, 'utf8')).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* 半行/坏行跳过，不猜 */ }
  }
  let out = rows;
  if (opts.lane) out = out.filter((r) => r.lane === opts.lane);
  if (opts.source) out = out.filter((r) => (r.source || 'probe') === opts.source);
  if (Number(opts.limit) > 0) out = out.slice(-Number(opts.limit));
  return out;
}

const median = (ns) => {
  const a = ns.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
};

/**
 * 一条通道的判读。'unknown' 表示没有样本 —— 没有样本不等于不可用，
 * 也不等于可用：把没测过的东西说成可用，是这套体系里最贵的错。
 */
export function summarizeLane(records) {
  const rs = (records || []).slice(-USABLE_WINDOW);
  const runs = rs.length;
  const okRuns = rs.filter((r) => r.ok).length;
  const failStreak = (() => { let n = 0; for (const r of rs.slice().reverse()) { if (r.ok) break; n += 1; } return n; })();
  const lastOk = rs.filter((r) => r.ok).slice(-1)[0] || null;
  const lastFail = rs.filter((r) => !r.ok).slice(-1)[0] || null;
  let verdict = 'unknown';
  if (runs > 0) {
    if (failStreak >= 3) verdict = 'dead';
    else if (okRuns >= USABLE_MIN_OK && failStreak <= 2) verdict = 'usable';
    else if (okRuns > 0) verdict = 'flaky';
    else verdict = 'dead';
  }
  return {
    lane: rs.length ? rs[rs.length - 1].lane : null,
    runs, okRuns, failStreak, verdict,
    medianMs: median(rs.filter((r) => r.ok).map((r) => r.ms)),
    lastOkAt: lastOk ? lastOk.ts : null,
    lastFailAt: lastFail ? lastFail.ts : null,
    lastFailReason: lastFail ? String(lastFail.reason || lastFail.err || '').slice(0, 120) : null,
  };
}

export function summarizeLedger(cwd, opts = {}) {
  const all = readLedger(cwd, opts);
  const lanes = [...new Set(all.map((r) => r.lane).filter(Boolean))];
  const summary = lanes.map((lane) => summarizeLane(all.filter((r) => r.lane === lane)));
  const order = { usable: 0, flaky: 1, unknown: 2, dead: 3 };
  summary.sort((a, b) => (order[a.verdict] - order[b.verdict]) || ((a.medianMs || 9e9) - (b.medianMs || 9e9)));
  return { contract: LEDGER_CONTRACT, total: all.length, window: USABLE_WINDOW, lanes: summary };
}

/** 推荐父审：只要 'usable' 的，按中位耗时升序。挑不到就明说挑不到，不拿 flaky 顶上。 */
export function recommendReviewers(summary, n = 1) {
  const usable = (summary && summary.lanes ? summary.lanes : []).filter((l) => l.verdict === 'usable');
  return {
    lanes: usable.slice(0, Math.max(1, n)).map((l) => l.name || l.lane),
    why: usable.length ? '按台账最近 ' + USABLE_WINDOW + ' 次的表现排序（' + usable.map((l) => l.lane + ' ' + (l.medianMs || '?') + 'ms').join(' / ') + '）'
      : '台账里没有达到 ' + USABLE_MIN_OK + '/' + USABLE_WINDOW + ' 的通道 —— 先跑 atwo doctor --reviewers 探活',
  };
}

export function renderLedger(summary) {
  if (!summary || !summary.lanes || !summary.lanes.length) return '▶ 异源台账：（空 —— 跑一次 atwo doctor --reviewers 开始记）';
  const tag = { usable: '✓ 可用', flaky: '~ 不稳', dead: '✗ 不可用', unknown: '? 未测' };
  return '▶ 异源台账：' + summary.lanes.map((l) => {
    const ms = l.medianMs == null ? '' : ' ' + l.medianMs + 'ms';
    const why = l.verdict === 'usable' || l.verdict === 'unknown' ? '' : (l.lastFailReason ? '（' + l.lastFailReason + '）' : '');
    return l.lane + ' ' + (tag[l.verdict] || l.verdict) + ' ' + l.okRuns + '/' + l.runs + ms + why;
  }).join(' · ');
}

/** 从一次 probeReviews 的结果批量记账（probe 与真跑共用一套字段）。 */
export function recordProbes(cwd, results, source = 'probe') {
  const rows = [];
  for (const r of results || []) {
    if (!r || !r.lane) continue;
    rows.push(appendEntry(cwd, {
      lane: r.lane,
      ok: !!r.ok,
      ms: Number.isFinite(r.ms) ? r.ms : (Number.isFinite(r.elapsedMs) ? r.elapsedMs : null),
      // 三种输入都要认：探活结果是 reasons 数组、通道错误是 err、上游已拼好是 reason。
      reason: r.ok ? null : String(r.reason != null ? r.reason : (Array.isArray(r.reasons) ? r.reasons.join('；') : (r.err || '未给原因'))).slice(0, 200),
      caught: r.caught == null ? null : r.caught,
      source,
    }));
  }
  return rows.filter(Boolean);
}
