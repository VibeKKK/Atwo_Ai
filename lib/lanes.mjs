// lib/lanes.mjs —— 编队层：把「谁去干这一路」从代码里抽出来，变成可探测、可编排的表。
//
// 编队的三条硬约束（实测得来，不是设计偏好）：
//   1) 能真并行的只有 CLI/HTTP 通道；GUI 通道（trae/workbuddy/doubao）单窗口独占，parallel=1。
//   2) 通道质量不同：给一件机械活开 6 路本地 8B，比开 3 路云端慢；给一件要判断的活开本地，等于没审。
//   3) 通道可用性会变（服务没跑 / CLI 起不来 / 额度耗尽）→ 必须真探测，不能按「配置里有」就当能用。
import { askCodeBuddy } from '../agents/codebuddy.mjs';
import { askOllama, probeOllama } from '../agents/ollama.mjs';
import { askCodex, probeCodex } from '../agents/codex.mjs';

/**
 * parallel 来自实测：codebuddy 12 路时单路由 4.85s 涨到 11.05s、吞吐停在 0.96/s，所以取 6。
 * role：writer 可以出产物，review 只适合当评审（GUI 通道写文件容易和父会话抢同一窗口）。
 */
export const LANE_DEFS = {
  codebuddy: { id: 'codebuddy', kind: 'cli', parallel: 6, quality: 3, cost: 'quota', roles: ['writer', 'review'], ask: askCodeBuddy },
  codex: { id: 'codex', kind: 'cli', parallel: 6, quality: 3, cost: 'quota', roles: ['writer', 'review'], ask: askCodex },
  trae: { id: 'trae', kind: 'gui', parallel: 1, quality: 2, cost: 'free', roles: ['review'], ask: null },
  workbuddy: { id: 'workbuddy', kind: 'gui', parallel: 1, quality: 2, cost: 'free', roles: ['review'], ask: null },
  doubao: { id: 'doubao', kind: 'gui', parallel: 1, quality: 2, cost: 'free', roles: ['review'], ask: null },
  ollama: { id: 'ollama', kind: 'http', parallel: 4, quality: 1, cost: 'free', roles: ['writer', 'review'], ask: askOllama },
};

/** 写手优先级：高质量的在前，免费的本地通道作为溢出兜底（它慢且笨，但不消耗额度）。 */
const WRITER_ORDER = ['codebuddy', 'codex', 'ollama'];
const REVIEW_ORDER = ['codebuddy', 'codex', 'trae', 'workbuddy', 'doubao', 'ollama'];

export function laneIds() {
  return Object.keys(LANE_DEFS);
}

/** 真探测：不可用的通道必须能被编队自动跳过，而不是派出去再失败。 */
export async function probeLanes(opts = {}) {
  const { only } = opts;
  const out = [];
  for (const id of laneIds()) {
    if (only && !only.includes(id)) continue;
    const def = LANE_DEFS[id];
    if (id === 'ollama') {
      const p = await probeOllama(opts.timeoutMs || 4000);
      out.push({ ...p, parallel: def.parallel, quality: def.quality, roles: def.roles, ready: p.available && p.hasModel !== false });
      continue;
    }
    if (id === 'codex') {
      // 本机 codex 已知跑不起来（app-server 初始化被拒，os error 5，2026-11-16 两次实测）。
      // 默认判不可用，避免编队把活派给一个必然失败的通道；换机器时用 CODEX_LANE=1 打开并真跑一次验。
      const p = probeCodex();
      const forced = String(process.env.CODEX_LANE || '') === '1';
      out.push({
        ...p,
        parallel: def.parallel,
        quality: def.quality,
        roles: def.roles,
        ready: !!p.available && forced,
        unverified: true,
        reason: p.available && !forced ? '本机 codex app-server 起不来（os error 5）；要启用设 CODEX_LANE=1 并先 atwo doctor 深探' : p.reason || '',
      });
      continue;
    }
    if (def.kind === 'gui') {
      // GUI 通道要靠 CDP/窗口探测，成本高且会打扰用户窗口 —— 标 unknown，不主动探，编队时默认不当写手。
      out.push({ lane: id, available: null, ready: false, reason: '未探测（GUI 通道需要客户端在跑；默认不当写手）', parallel: def.parallel, quality: def.quality, roles: def.roles });
      continue;
    }
    out.push({ lane: id, available: true, ready: true, parallel: def.parallel, quality: def.quality, roles: def.roles });
  }
  return out;
}

/**
 * 把 N 路活分给可用通道。返回 [{lane, count}] 或抛错（一路都派不出去时要说清为什么）。
 * parts 超过所有通道 parallel 之和时按上限截断 —— 多出来的路不会更快的实测曲线见 LANE_DEFS 注释。
 */
export function planLanes(parts, opts = {}) {
  const n = Math.max(1, Math.floor(Number(parts) || 1));
  const role = opts.role || 'writer';
  const order = role === 'review' ? REVIEW_ORDER : WRITER_ORDER;
  const wanted = opts.lanes && opts.lanes.length ? opts.lanes : order;
  const probes = opts.probes || null;

  // 先校验用户给的名字：写错通道名不能被「过滤后什么都不剩」吞掉，那会变成
  // 一句含糊的「没有可用通道」，让人以为是服务没起。
  if (opts.lanes && opts.lanes.length) {
    for (const id of opts.lanes) {
      if (!LANE_DEFS[id]) throw new Error('未知通道：' + id + '（可用：' + laneIds().join(' / ') + '）');
    }
  }

  const usable = [];
  for (const id of order) {
    if (!wanted.includes(id)) continue;
    const def = LANE_DEFS[id];
    if (!def) throw new Error('未知通道：' + id + '（可用：' + laneIds().join(' / ') + '）');
    if (!def.roles.includes(role)) continue;
    if (probes) {
      const p = probes.find((x) => x.lane === id);
      if (p && p.ready === false) continue; // 探测说不行就跳过，别派了再失败
    }
    usable.push({ lane: id, parallel: def.parallel, quality: def.quality, cost: def.cost });
  }
  if (!usable.length) {
    const why = (probes || []).filter((p) => p.ready === false && p.reason).map((p) => p.lane + '：' + p.reason);
    throw new Error('没有可用通道（role=' + role + '）' + (why.length ? '；' + why.join('；') : ''));
  }

  const plan = [];
  let left = n;
  for (const u of usable) {
    if (left <= 0) break;
    const take = Math.min(left, u.parallel);
    plan.push({ lane: u.lane, count: take, quality: u.quality, cost: u.cost });
    left -= take;
  }
  return { plan, unassigned: left };
}

/** 按计划把 children（每路的 prompt）分派到具体通道；lane 内并行，lane 间并行。 */
export async function dispatchLanes(planned, children, opts = {}) {
  const { cwd, timeoutMs, model, onProgress } = opts;
  const jobs = [];
  let k = 0;
  for (const p of planned) {
    for (let i = 0; i < p.count && k < children.length; i += 1) {
      jobs.push({ lane: p.lane, child: children[k], index: k });
      k += 1;
    }
  }
  // 计划比 children 多时按 children 截断；比 children 少时剩下的仍走首选通道（宁可派出，不要静默丢活）
  while (k < children.length) {
    jobs.push({ lane: planned[0].lane, child: children[k], index: k });
    k += 1;
  }
  const results = await Promise.all(jobs.map(async (j) => {
    const def = LANE_DEFS[j.lane];
    // opts.asks 只为测试注入：验证「哪一路落到哪个通道」不需要真起 10 个进程。
    const ask = (opts.asks && opts.asks[j.lane]) || def.ask;
    if (!ask) throw new Error('通道 ' + j.lane + ' 没有 ask 实现（GUI 通道请走 orchestra）');
    if (onProgress) onProgress({ phase: 'lane-start', lane: j.lane, index: j.index });
    const r = await ask(j.child.prompt, { cwd, timeoutMs, model: j.child.model || model });
    if (onProgress) onProgress({ phase: 'lane-done', lane: j.lane, index: j.index, ok: !!(r && r.ok) });
    return { ...r, lane: j.lane, index: j.index };
  }));
  return results.sort((a, b) => a.index - b.index);
}

/** 一行摘要，给 --json 与父审用：每个通道给了几路、谁没上。 */
export function describePlan(planned) {
  return planned.map((p) => p.lane + '×' + p.count).join(' + ');
}
