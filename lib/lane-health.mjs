/**
 * 通道健康度：从自己的账本里数出来，不探活、不进模型、不发请求。
 *
 * 为什么要这个：选路一直只看「注册了没有 / 探测通了没有」，不看「最近真干活成不成」。
 * 实测 memory/log.jsonl 里 codebuddy 254 单 81.1%、workbuddy 49 单 63.3%、
 * doubao 10 单 0% —— 这个差别在派活时完全没被使用。
 *
 * 三条口径（不写死会得出相反的结论）：
 * 1. 只数真干活的 kind（ask/review/swarm/batch/duo/sub/sub-decompose/auto），
 *    不数 quota（那是记账失败，不是通道干不成活）；
 * 2. 样本不足不下结论（默认 5 单起），未知通道既不优先也不排除；
 * 3. 只看时间窗内（默认 7 天），三个月前的成功率不能代表今天。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const WORK_KINDS = new Set(['ask', 'review', 'swarm', 'batch', 'duo', 'sub', 'sub-decompose', 'auto']);

const DAY = 24 * 60 * 60 * 1000;

/**
 * 成功率的下界（Wilson 95% 下界），用来排序「谁更可信」，不是用来显示。
 * 直接按 rate 排会让「1 单 1 成 = 100%」压过「254 单 206 成 = 81%」——
 * 这就是把小样本的运气当成能力。下界对样本量敏感：1/1 ≈ 0.21，5/6 ≈ 0.44，206/254 ≈ 0.76。
 */
export function wilsonLower(ok, calls, z = 1.96) {
  const n = Number(calls) || 0;
  if (!n) return 0;
  const ph = (Number(ok) || 0) / n;
  const z2 = z * z;
  const centre = ph + z2 / (2 * n);
  const spread = z * Math.sqrt((ph * (1 - ph) + z2 / (4 * n)) / n);
  const denom = 1 + z2 / n;
  return Math.max(0, (centre - spread) / denom);
}
/** 从账本条目里数出每个通道的成败。entries 是已解析的对象数组。 */
export function laneHealth(entries, { now = Date.now(), windowMs = 7 * DAY } = {}) {
  const since = now - windowMs;
  const by = new Map();
  for (const e of entries) {
    if (!e || !WORK_KINDS.has(e.kind)) continue;
    const lane = String(e.agent || e.lane || '').trim();
    if (!lane) continue;
    const t = Date.parse(e.time || '');
    if (Number.isFinite(t) && t < since) continue;
    const rec = by.get(lane) || { lane, calls: 0, ok: 0, ms: [], lastOk: null };
    rec.calls += 1;
    if (e.ok === true) {
      rec.ok += 1;
      if (Number.isFinite(t)) rec.lastOk = t;
    }
    if (Number.isFinite(e.elapsedMs) && e.elapsedMs > 0) rec.ms.push(e.elapsedMs);
    by.set(lane, rec);
  }
  const rows = [];
  for (const rec of by.values()) {
    const ms = rec.ms.slice().sort((a, b) => a - b);
    rows.push({
      lane: rec.lane,
      calls: rec.calls,
      ok: rec.ok,
      rate: rec.calls ? rec.ok / rec.calls : null,
      score: wilsonLower(rec.ok, rec.calls),
      p50: ms.length ? ms[Math.min(ms.length - 1, Math.ceil(0.5 * ms.length) - 1)] : null,
      lastOk: rec.lastOk,
    });
  }
  // 按下界排，不按裸 rate：小样本的 100% 不算能力（见 wilsonLower 注释）。
  rows.sort((a, b) => b.score - a.score || b.calls - a.calls);
  return rows;
}

/** 「这路明显不行」的判定：样本够 + 成功率低于底线。样本不够一律不当坏。 */
export function looksBroken(row, { minCalls = 5, minRate = 0.25 } = {}) {
  if (!row || !row.calls) return false;
  if (row.calls < minCalls) return false;
  return (row.rate ?? 0) < minRate;
}

/**
 * 按健康度给候选排序：健康的排前面，明显不行的沉底（**不删**——删了就没法解释
 * 为什么这一路没被用，而且样本可能是旧的）。
 * 没有样本的通道保持原始相对顺序，插在「健康」与「坏」之间。
 */
export function rankByHealth(cands, health, opts = {}) {
  const map = new Map((health || []).map((h) => [h.lane, h]));
  const good = [];
  const unknown = [];
  const bad = [];
  for (const c of cands || []) {
    const h = map.get(typeof c === 'string' ? c : c && c.lane);
    if (!h || h.calls < (opts.minCalls || 5)) unknown.push(c);
    else if (looksBroken(h, opts)) bad.push(c);
    else good.push(c);
  }
  // good 内部按成功率降序（同率按样本量降序），保证确定性
  good.sort((a, b) => {
    const ha = map.get(typeof a === 'string' ? a : a.lane);
    const hb = map.get(typeof b === 'string' ? b : b.lane);
    return (hb.score - ha.score) || (hb.calls - ha.calls);
  });
  return [...good, ...unknown, ...bad];
}

/** 给人看的一行：codebuddy 81% (206/254)、doubao 0% (0/10)… */
export function renderHealth(rows, { limit = 6 } = {}) {
  if (!rows || !rows.length) return '通道健康度：账本里没有可用的派活记录';
  const parts = rows.slice(0, limit).map((r) => {
    const pctText = r.rate === null ? '-' : Math.round(r.rate * 100) + '%';
    return r.lane + ' ' + pctText + (r.calls ? ' (' + r.ok + '/' + r.calls + ')' : '');
  });
  return '通道健康度：' + parts.join(' · ');
}

/** 直接读账本文件（默认 memory/log.jsonl），坏行跳过 —— 账本是运行时写的，可能有半行。 */
export function readHealthFromLog(cwd, { file, ...opts } = {}) {
  const target = file || (process.env.ATWO_LOG || path.join(cwd || process.cwd(), 'memory', 'log.jsonl'));
  let raw = '';
  try { raw = readFileSync(target, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of raw.split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* 半行跳过 */ }
  }
  return laneHealth(entries, opts);
}