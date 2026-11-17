// file: lib/score.mjs
import fs from 'node:fs';
import path from 'node:path';
const NL = String.fromCharCode(10);

function normalizeTime(now) {
  let d;
  if (now instanceof Date) {
    d = now;
  } else if (typeof now === 'number' && Number.isFinite(now)) {
    d = new Date(now);
  } else if (typeof now === 'string') {
    const t = Date.parse(now);
    d = Number.isNaN(t) ? new Date(NaN) : new Date(t);
  } else {
    d = new Date(NaN);
  }
  if (Number.isNaN(d.getTime())) d = new Date();
  return d.toISOString();
}

export function scoreRecord({ task, assertion, ok, now } = {}) {
  return { kind: 'score', time: normalizeTime(now), task, assertion, ok: ok === true };
}

function lineCountOf(content) {
  if (content.length === 0) return 0;
  const nl = content.split(NL).length - 1;
  return content.endsWith(NL) ? nl : nl + 1;
}

export function appendScore(file, rec) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  let line = 1;
  if (fs.existsSync(file)) line = lineCountOf(fs.readFileSync(file, 'utf8')) + 1;
  fs.appendFileSync(file, JSON.stringify(rec) + NL, 'utf8');
  return { ok: true, file, line };
}

export function readScore(file) {
  if (!fs.existsSync(file)) return [];
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const raw of content.split(NL)) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch { /* skip bad line */ }
  }
  return out;
}

export function summarizeScores(records) {
  const total = records.length;
  let passed = 0;
  for (const r of records) if (r && r.ok === true) passed++;
  const failed = total - passed;
  const rate = total === 0 ? 0 : Math.round((passed / total) * 1000) / 1000;
  return { total, passed, failed, rate };
}

export function dailyTrend(records) {
  const map = new Map();
  for (const r of records) {
    if (!r || typeof r.time !== 'string') continue;
    const date = r.time.slice(0, 10);
    if (!map.has(date)) map.set(date, { total: 0, passed: 0 });
    const g = map.get(date);
    g.total++;
    if (r.ok === true) g.passed++;
  }
  return [...map.keys()].sort().map((date) => {
    const g = map.get(date);
    const rate = g.total === 0 ? 0 : Math.round((g.passed / g.total) * 1000) / 1000;
    return { date, total: g.total, passed: g.passed, rate };
  });
}

export function delta(records, { days } = {}) {
  const n = Number(days);
  const span = (Number.isFinite(n) && n > 0 ? n : 1) * 86400000;
  let anchor = -Infinity;
  const valid = [];
  for (const r of records) {
    if (!r || typeof r.time !== 'string') continue;
    const t = Date.parse(r.time);
    if (Number.isNaN(t)) continue;
    valid.push({ r, t });
    if (t > anchor) anchor = t;
  }
  let beforeTotal = 0, beforePassed = 0, afterTotal = 0, afterPassed = 0;
  if (anchor > -Infinity) {
    const afterStart = anchor - span;
    const beforeStart = anchor - 2 * span;
    for (const { r, t } of valid) {
      const pass = r.ok === true;
      if (t >= afterStart && t <= anchor) { afterTotal++; if (pass) afterPassed++; }
      else if (t >= beforeStart && t < afterStart) { beforeTotal++; if (pass) beforePassed++; }
    }
  }
  const round = (x) => Math.round(x * 1000) / 1000;
  const before = beforeTotal === 0 ? 0 : round(beforePassed / beforeTotal);
  const after = afterTotal === 0 ? 0 : round(afterPassed / afterTotal);
  const d = round(after - before);
  let direction = 'flat';
  if (beforeTotal > 0 && afterTotal > 0) {
    if (d > 0) direction = 'up';
    else if (d < 0) direction = 'down';
  }
  return { before, after, delta: d, direction };
}
