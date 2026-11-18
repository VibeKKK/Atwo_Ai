// atwo 还活着吗 —— 一条命令答完，五行输出。
//
// 为什么不用「跑全量测试」回答这个问题（2026-11-18）：全量 132 个测试文件要 3~4 分钟，
// 而真正决定「今天能不能用它干活」的是另外四件事：图有没有过期、通道还通不通、
// 账本还读不读得动、预算还剩多少。测试只是其中一项，而且是离线也能绿的一项。
// 所以 selfcheck 只**数**测试文件（不跑），其余四项真读盘。
import fs from 'node:fs';
import path from 'node:path';
import { VERBS } from './cli-spec.mjs';
import { graphAge, renderGraphAge } from './graph-age.mjs';
import { readHealthFromLog } from './lane-health.mjs';

function countTests(cwd) {
  try {
    return fs.readdirSync(path.join(cwd, 'test')).filter((n) => n.endsWith('.test.mjs')).length;
  } catch {
    return 0;
  }
}

function readLedger(cwd) {
  const file = path.join(cwd, 'memory', 'log.jsonl');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    let lastTs = '';
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 50; i -= 1) {
      try {
        const o = JSON.parse(lines[i]);
        lastTs = String(o.ts || o.at || o.time || '');
        if (lastTs) break;
      } catch { /* 坏行跳过，不影响「账本可读」这个判断 */ }
    }
    return { ok: true, file, entries: lines.length, lastTs };
  } catch (e) {
    return { ok: false, file, entries: 0, lastTs: '', error: String((e && e.message) || e) };
  }
}

function readBudget(cwd) {
  const file = path.join(cwd, 'memory', 'budget.json');
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    const limits = o && typeof o.limits === 'object' && o.limits ? Object.keys(o.limits) : [];
    return { ok: true, file, limits };
  } catch (e) {
    // 没有预算文件不算病（很多人不设闸），坏了才算病
    const missing = e && e.code === 'ENOENT';
    return { ok: missing, file, limits: [], missing, error: missing ? '' : String((e && e.message) || e) };
  }
}

/** 五行体检数据。绝不抛：任何一项读不到都变成一条负结果，而不是异常。 */
export function collectSelfcheck(cwd, { now = Date.now() } = {}) {
  const verbs = Object.keys(VERBS);
  const tests = countTests(cwd);
  const graph = graphAge(cwd, { now });
  let health = [];
  try { health = readHealthFromLog(cwd) || []; } catch { health = []; }
  // lane-health 的行用 lane 字段（不是 agent），这里统一取一次，别让上层猜。
  const usable = health.filter((r) => r && r.rate > 0 && !r.broken).map((r) => r.lane);
  const ledger = readLedger(cwd);
  const budget = readBudget(cwd);
  const ok = tests > 0 && ledger.ok && budget.ok && verbs.length > 0;
  return { ok, verbs, tests, graph, health, usable, ledger, budget, now };
}

/** 固定六行（前五行是体检结论，第六行是「怎么修」）。 */
export function renderSelfcheck(s) {
  const lines = [];
  lines.push('动词：' + s.verbs.length + ' 个' + (s.verbs.length ? '（' + s.verbs.slice(0, 6).join(' / ') + ' …）' : ''));
  lines.push('测试：' + s.tests + ' 个测试文件' + (s.tests ? '' : '  ← 一个都没找到，仓库不对？'));
  lines.push(renderGraphAge(s.graph, { now: s.now }));
  if (!s.health.length) lines.push('通道：库里没有派活记录（没跑过，或账本指到别处）');
  else {
    const top = s.health.slice(0, 3).map((r) => r.lane + ' ' + Math.round(r.rate * 100) + '%(' + r.ok + '/' + r.calls + ')');
    lines.push('通道：' + (s.usable.length ? '可用 ' + s.usable.join('、') : '没有成功率 > 0 的通道') + ' ｜ ' + top.join(' · '));
  }
  lines.push('账本：' + (s.ledger.ok ? s.ledger.entries + ' 条' + (s.ledger.lastTs ? '，最近 ' + s.ledger.lastTs : '') : '读不动（' + s.ledger.error + '）'));
  lines.push('预算：' + (s.budget.missing ? '没设闸（memory/budget.json 不存在）' : s.budget.ok ? '可读，' + s.budget.limits.length + ' 条 limits' : '坏了（' + s.budget.error + '）'));
  if (!s.ok) lines.push('结论：有硬伤，先修上面带「←」的那行；修不好就别派活。');
  else if (s.graph.stale) lines.push('结论：能派活，但先跑一次 graft index（三处融合现在等于没接）。');
  else lines.push('结论：可以派活。');
  return lines.join('\n');
}
