// lib/canary.mjs —— 派活前探活：这条路现在到底能不能干活
// 为什么需要（2026-11-17 实测）：四路并派时三条 GUI 通道客户端根本没开，
// 每条都要等 15 秒 TTFB 才判死，四路墙钟 70 秒里有 45 秒是「等一个已知死了的通道」。
// 探活只花 1–2 秒就能知道「端口没开 / 进程不在」，把这段等待整段省掉。
//
// 探活能证明什么：客户端在、CDP 在听、CLI 文件在。
// 探活不能证明什么：模型还在菜单里（那是 verifyModels 的事）、额度够（只有真发一次才知道）、
// 点了会不会生效（GUI 适配层的历史坑）。所以探活是「必要条件的快筛」，不是可用性证明。
import fs from 'node:fs';
import net from 'node:net';

export const CANARY_MS_DEFAULT = 1500;

/** GUI 通道的 CDP 端口（与 agents/*.mjs 的 PORT 常量保持一致，可用环境变量覆盖） */
export function lanePort(agent) {
  switch (agent) {
    case 'trae': return Number(process.env.TRAE_CDP_PORT || 9223);
    case 'workbuddy': return Number(process.env.WB_PORT || 9224);
    case 'doubao': return Number(process.env.DB_PORT || 9225);
    default: return 0;
  }
}

/** CLI 通道的可执行入口（codebuddy 走 CLI，不走 CDP） */
export function laneCli(agent) {
  if (agent !== 'codebuddy') return '';
  return process.env.CODEBUDDY_CLI || process.env.CODEBUDDY_BIN || '';
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, reason: `${label} 在 ${ms}ms 内没应答` });
    }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, reason: `${label} 报错：${e instanceof Error ? e.message : String(e)}` }); } },
    );
  });
}

/** TCP 连通性（不依赖 http 库，CDP 端口只要在听就算活） */
export function probeTcp(port, { host = '127.0.0.1', timeoutMs = CANARY_MS_DEFAULT } = {}) {
  return withTimeout(new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const finish = (ok, reason) => {
      try { sock.destroy(); } catch { /* 已关就别管 */ }
      resolve({ ok, reason });
    };
    sock.once('connect', () => finish(true, `端口 ${port} 在听`));
    sock.once('error', (e) => finish(false, `端口 ${port} 不通（${e.code || e.message}）`));
  }), timeoutMs + 200, `端口 ${port}`);
}

/**
 * 探一条通道。
 * @returns {{agent:string, alive:boolean, reason:string, ms:number, via:string}}
 */
export async function canaryLane(agent, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : CANARY_MS_DEFAULT;
  const t0 = Date.now();
  const port = lanePort(agent);
  if (port > 0) {
    const r = await probeTcp(port, { timeoutMs });
    return { agent, alive: r.ok, reason: r.ok ? r.reason : `${agent} 没开（${r.reason}）`, ms: Date.now() - t0, via: 'tcp' };
  }
  const cli = laneCli(agent);
  if (cli) {
    const exists = fs.existsSync(cli);
    return { agent, alive: exists, reason: exists ? 'CLI 在' : `${agent} 的 CLI 不在（${cli}）`, ms: Date.now() - t0, via: 'file' };
  }
  // 不认识也没有可探的东西：不阻断，交回给派活时的硬超时
  return { agent, alive: true, reason: `${agent} 没有可探的入口（跳过）`, ms: Date.now() - t0, via: 'none' };
}

/**
 * 探一批通道。
 * 全死的时候**不返回空**——空列表会让上层以为「没有通道要派」而静默收工，
 * 那比慢更糟。全死就原样保留，让它在派活时按硬超时记失败。
 */
export async function canaryLanes(agents, opts = {}) {
  const list = [...new Set((agents || []).filter(Boolean))];
  const results = await Promise.all(list.map((a) => canaryLane(a, opts)));
  const alive = results.filter((r) => r.alive).map((r) => r.agent);
  const dead = results.filter((r) => !r.alive);
  const allDead = alive.length === 0 && list.length > 0;
  return {
    results,
    alive: allDead ? list : alive,
    dead: allDead ? [] : dead,
    allDead,
    kept: allDead ? list : alive,
    dropped: allDead ? [] : dead.map((d) => d.agent),
  };
}

/** 一行给人看 */
export function renderCanary(r) {
  if (!r || !r.results || !r.results.length) return '探活：没有要探的通道';
  if (r.allDead) {
    return '探活：全部通道都不通（' + r.results.map((x) => x.agent + ' ' + x.reason).join('；') + '）—— 照原样派，让硬超时记失败';
  }
  const alive = r.results.filter((x) => x.alive).map((x) => `${x.agent} ${x.ms}ms`);
  const dead = r.dead.map((x) => `${x.agent}（${x.reason}）`);
  return '探活：' + (alive.length ? '可用 ' + alive.join('、') : '无可用')
    + (dead.length ? ' · 跳过 ' + dead.join('、') : '');
}
