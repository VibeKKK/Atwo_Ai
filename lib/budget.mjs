/**
 * 预算闸门 —— 让"花多少"变成可查、可拒的数字。
 *
 * 现实：codebuddy 单次调用固定吃 ~24,800 input token（CLI 自带 system prompt），
 *       trae 走 CDP 不吃 token 但占一个人 40-120 秒的等待。
 * 所以闸门按两个维度记：token（codebuddy）和次数（trae）。
 * 不估钱 —— 估钱是假精度；配额和等待时间才是真的约束。
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'memory', 'budget.json');

const DEFAULT_LIMITS = {
  codebuddy: { dailyInputTokens: 600000, dailyCalls: 40 },
  trae: { dailyInputTokens: 0, dailyCalls: 60 },   // trae 不吃 token，只限次数
};

const today = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { version: 1, limits: { ...DEFAULT_LIMITS, ...(j.limits || {}) }, usage: j.usage || {} };
  } catch {
    return { version: 1, limits: DEFAULT_LIMITS, usage: {} };
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** 今天某 agent 已经用了多少。 */
export function usedToday(agent) {
  const s = load();
  const day = s.usage[today()] || {};
  return day[agent] || { calls: 0, input: 0, output: 0 };
}

/**
 * 能不能再花一次。
 * @param {string} agent
 * @param {number} estInput 预计 input token（codebuddy 用 24848，其余给 0）
 * @returns {{ok:boolean, reason?:string, left?:object}}
 */
export function check(agent, estInput = 0) {
  const s = load();
  const lim = s.limits[agent] || { dailyInputTokens: 0, dailyCalls: 0 };
  const used = usedToday(agent);
  const left = {
    calls: Math.max(0, (lim.dailyCalls || 0) - used.calls),
    inputTokens: Math.max(0, (lim.dailyInputTokens || 0) - used.input),
  };
  if (lim.dailyCalls && used.calls >= lim.dailyCalls) {
    return { ok: false, reason: `${agent} 今天次数已用完（${used.calls}/${lim.dailyCalls}）`, left };
  }
  if (lim.dailyInputTokens && estInput && used.input + estInput > lim.dailyInputTokens) {
    return { ok: false, reason: `${agent} 今天 token 预算不够（已用 ${used.input}，本次需 ~${estInput}，上限 ${lim.dailyInputTokens}）`, left };
  }
  return { ok: true, left };
}

/** 记一次消耗。 */
export function record(agent, { input = 0, output = 0, ok = true } = {}) {
  const s = load();
  const day = today();
  s.usage[day] = s.usage[day] || {};
  const cur = s.usage[day][agent] || { calls: 0, input: 0, output: 0, fails: 0 };
  cur.calls += 1;
  cur.input += Number(input) || 0;
  cur.output += Number(output) || 0;
  if (!ok) cur.fails = (cur.fails || 0) + 1;
  s.usage[day][agent] = cur;
  save(s);
  return cur;
}

/** 人看的账。 */
export function report() {
  const s = load();
  const day = today();
  const cur = s.usage[day] || {};
  const names = Object.keys(s.limits);
  const rows = names.map(a => {
    const u = cur[a] || { calls: 0, input: 0, output: 0, fails: 0 };
    const lim = s.limits[a] || {};
    return {
      agent: a,
      calls: u.calls, fails: u.fails || 0,
      input: u.input, output: u.output,
      leftCalls: lim.dailyCalls ? Math.max(0, lim.dailyCalls - u.calls) : '∞',
      leftTokens: lim.dailyInputTokens ? Math.max(0, lim.dailyInputTokens - u.input) : '∞',
    };
  });
  return { date: day, rows };
}
