// 成败语义的唯一实现（P0-1 产物优先 + P0-2 停摆判据 + 三档回执）。
//
// 为什么要有这个文件：go / swarm / army 三个入口各写一套判据，就会出现
// 「同一件事一个入口说 ok、另一个说 failed」——那正是我们最恨的撒谎。
// 判据只能有一份，入口只能是调用方。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectTarget, selfLanded } from './land.mjs';

/** 小文件也是产物：能不能用交给语法闸判断，不用大小猜。 */
export const MIN_BYTES = 8;

/** P0-2：20 秒没有一行新输出就算卡住（死通道不该让人等 300 秒）。 */
export const STALL_MS = 20000;

/**
 * P0-3 快速失败：一路多久没吐出第一个字就算死。
 *
 * 为什么要有它：2026-11-17 那次四路论文，trae 309.9s、workbuddy 281.4s、doubao 300s
 * 全是「静默到超时」，白烧 891 秒。而真活着的通道通常 3–15 秒内就有第一行。
 * 所以判据不该是「等它超时」，而是「它多久没张嘴」。
 */
export const TTFB_MS = 15000;

/**
 * 首字节阈值必须按通道分开定。
 *
 * 依据（2026-11-17 实测）：GUI 通道（trae/workbuddy/doubao）真活着的 3–15 秒就有第一行；
 * 而 codebuddy 是 CLI 子进程，要启动 node、读配置、握手、首 token，历史上正常也要 20–40 秒才吐第一行。
 * 用同一个 15 秒去判它 = 把最能干活的路当死路砍掉（实测当场误杀了 codebuddy）。
 */
export const TTFB_BY_AGENT = Object.freeze({
  codebuddy: 45000,
  trae: 15000,
  workbuddy: 15000,
  doubao: 15000,
});

/** 取某通道的首字节阈值：通道表 → 全局 env → 默认。 */
export function ttfbFor(agent, override) {
  if (override !== undefined && override !== null && override !== '') return Number(override) || 0;
  const a = String(agent || '');
  return TTFB_BY_AGENT[a] === undefined ? TTFB_MS : TTFB_BY_AGENT[a];
}

const CHECKABLE = new Set(['.mjs', '.js', '.cjs']);

/** 判定失败时要扫的目录：这些里面出现「刚写出来的文件」不算产物（都是运行时垃圾）。 */
const SCAN_SKIP = new Set(['node_modules', '.git', '.atw', 'memory', 'runs', 'coverage', '.cache', '_probe', '.dsh']);

/** 能被当成产物的扩展名。html/css/txt 也算：board.html 这种交付物根本不是 JS。 */
const PRODUCT_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.json', '.md', '.py', '.yml', '.yaml', '.html', '.css', '.txt']);

/**
 * 扫「这一轮新出现的文件」。
 *
 * 为什么需要它：judgeOutcome 的目标路径是从 PRD 文本猜出来的（detectTarget），
 * 而写手实际写到哪儿由它自己决定。猜错时盘上明明有产物，判定却说「盘上没有产物」——
 * 2026-11-17 一天里这样误报 6 次（board.mjs / runs.mjs / handoff.mjs 都是真落盘却报失败）。
 * 反过来也有更糟的一次：产物被写进了 lib/outcome.codebuddy.mjs（猜错+落错叠在一起）。
 * 所以判定不能只信猜，要扫盘：猜的那个不在，就看看有没有别人刚写的文件。
 */
export function scanSince(cwd, sinceMs, opts = {}) {
  const minBytes = Number(opts.minBytes || MIN_BYTES);
  const maxDepth = Number(opts.maxDepth || 3);
  const maxFiles = Number(opts.maxFiles || 4000);
  const floor = Number(sinceMs) - 2000;
  const hits = [];
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen >= maxFiles) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (seen >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SCAN_SKIP.has(e.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!PRODUCT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      seen += 1;
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size < minBytes) continue;
      if (st.mtimeMs < floor) continue;
      hits.push({ path: path.relative(cwd, full).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(cwd, 0);
  // 最新的排前面：同一轮写了好几个文件时，最后落盘的那个最可能是本次产物。
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hits;
}

/**
 * 判一次派活的成败：只看盘上的产物，不看进程退出码。
 * @param {{srcText?: string, sinceMs?: number, cwd?: string, minBytes?: number}} opts
 * @returns {{verdict: 'ok'|'partial'|'failed', target: string|null, landed: Array<{path:string,size:number}>, verified: Array<{path:string,syntax:boolean}>, hint: string}}
 */
export function judgeOutcome(opts = {}) {
  const srcText = String(opts.srcText || '');
  const sinceMs = Number(opts.sinceMs || 0);
  const cwd = opts.cwd || process.cwd();
  const minBytes = Number(opts.minBytes || MIN_BYTES);

  const target = detectTarget(srcText);
  // selfLanded 是按 process.cwd() 解析的，而调用方可能给了别的 cwd（测试、army 的沙箱目录）
  // → 这里先转绝对路径再交给它，回执里再转回相对路径给人看。
  const abs = target ? (path.isAbsolute(String(target)) ? String(target) : path.resolve(cwd, String(target))) : '';
  const found = abs ? selfLanded(abs, sinceMs, { minBytes }) : null;
  const landed = found ? { path: target, size: found.size, mtimeMs: found.mtimeMs } : null;
  if (!landed) {
    // 猜的那个没有，但盘上可能有别人刚写的：扫一遍再下结论，别把成功当失败。
    const hits = scanSince(cwd, sinceMs, { minBytes });
    if (!hits.length) {
      return { verdict: 'failed', target, landed: [], verified: [], hint: '盘上没有产物' };
    }
    const best = hits[0];
    const bestExt = path.extname(best.path).toLowerCase();
    let syntax = true;
    if (CHECKABLE.has(bestExt)) {
      const chk = spawnSync(process.execPath, ['--check', path.resolve(cwd, best.path)], { cwd, encoding: 'utf8' });
      syntax = chk.status === 0;
    }
    const why = target ? '（PRD 猜的是 ' + target + '，它不在或没更新）' : '（PRD 里没认出目标路径）';
    return {
      verdict: syntax ? 'ok' : 'partial',
      target,
      landed: hits.slice(0, 3),
      verified: CHECKABLE.has(bestExt) ? [{ path: best.path, syntax }] : [],
      landedVia: 'scan',
      hint: syntax ? '产物在 ' + best.path + why : '产物落下了但语法没过：' + best.path,
    };
  }

  const ext = path.extname(String(abs)).toLowerCase();
  if (!CHECKABLE.has(ext)) {
    // 不该假装验过：非 JS 产物只说「在」，不说「能跑」。
    return { verdict: 'ok', target, landed: [landed], verified: [], hint: '' };
  }

  const chk = spawnSync(process.execPath, ['--check', String(landed.path)], { cwd, encoding: 'utf8' });
  const syntax = chk.status === 0;
  if (!syntax) {
    return {
      verdict: 'partial',
      target,
      landed: [landed],
      verified: [{ path: landed.path, syntax }],
      hint: '产物落下了但语法没过，重跑或直接修它',
    };
  }
  return { verdict: 'ok', target, landed: [landed], verified: [{ path: landed.path, syntax }], hint: '' };
}

/** 三档回执：任何人都能一眼看出「东西在不在、能不能用、下一步做什么」。 */
export function formatOutcome(o) {
  const out = [];
  const verdict = o && o.verdict ? o.verdict : 'failed';
  const mark = verdict === 'ok' ? '✓' : verdict === 'partial' ? '~' : '✗';
  out.push(mark + ' 结果：' + verdict + '（看产物，不看退出码）');
  for (const l of (o && o.landed) || []) out.push('  产物：' + l.path + ' ' + l.size + 'B');
  if (o && o.hint) out.push('  下一步：' + o.hint);
  return out;
}

/** 退出码跟着诚实：产物 ok 就 0，否则保留调用方给的码。 */
export function exitForOutcome(code, o) {
  return o && o.verdict === 'ok' ? 0 : code;
}

/**
 * 停摆判据：多久没新输出算卡住。
 * @param {{lastOutputAt?: number, now?: number, stallMs?: number}} opts
 */
export function judgeStall(opts = {}) {
  const now = Number(opts.now || Date.now());
  const last = Number(opts.lastOutputAt || 0);
  const stallMs = Number(opts.stallMs || STALL_MS);
  const idleMs = last ? now - last : 0;
  return {
    stalled: !!last && idleMs >= stallMs,
    idleMs,
    stallMs,
    text: last && idleMs >= stallMs ? Math.round(idleMs / 1000) + ' 秒没有新输出，判卡住' : '',
  };
}

/**
 * 单路快速失败判据：这一路该不该现在就被判死。
 *
 * 两种死法分开报，因为下一步动作不同：
 *   · `ttfb`    —— 还没张嘴：直接换模型/换路，别等。
 *   · `silence` —— 张过嘴又静了：可能是长思考，给更长的容忍（silenceMs）。
 *
 * @param {{startedAt?: number, firstAt?: number, lastAt?: number, now?: number, ttfbMs?: number, silenceMs?: number}} opts
 * @returns {{dead: boolean, kind: ''|'ttfb'|'silence', waitedMs: number, limitMs: number, text: string}}
 */
export function judgeLaneDeadline(opts = {}) {
  const now = Number(opts.now || Date.now());
  const startedAt = Number(opts.startedAt || 0);
  const firstAt = Number(opts.firstAt || 0);
  const lastAt = Number(opts.lastAt || 0);
  const ttfbMs = Number(opts.ttfbMs === undefined ? TTFB_MS : opts.ttfbMs);
  const silenceMs = Number(opts.silenceMs === undefined ? STALL_MS : opts.silenceMs);

  // 没张嘴：从开始时刻算
  if (!firstAt) {
    const waitedMs = startedAt ? Math.max(0, now - startedAt) : 0;
    const dead = ttfbMs > 0 && waitedMs >= ttfbMs;
    return {
      dead,
      kind: dead ? 'ttfb' : '',
      waitedMs,
      limitMs: ttfbMs,
      text: dead ? Math.round(waitedMs / 1000) + ' 秒还没出第一个字，判死' : '',
    };
  }

  // 张过嘴又静了：从最后一次输出算
  const base = lastAt || firstAt;
  const waitedMs = Math.max(0, now - base);
  const dead = silenceMs > 0 && waitedMs >= silenceMs;
  return {
    dead,
    kind: dead ? 'silence' : '',
    waitedMs,
    limitMs: silenceMs,
    text: dead ? Math.round(waitedMs / 1000) + ' 秒没有新输出，判卡住' : '',
  };
}

/**
 * 通道裁剪：账本里「近期一次都没成」的路，本轮别派。
 *
 * 为什么要有它：2026-11-17 四路征求看法，两路恒死，白占时间额度；
 * 而人不会记得改 `--agent`，所以让账本来决定。
 * 只砍「有样本且 0 成功」，不动「没样本」（第一次跑就是在攒样本）；
 * 而且**绝不砍光**——全砍光说明账本坏了，宁可照原样派。
 *
 * @param {Array<{agent?: string, ok?: boolean}>} records
 * @param {string[]} lanes
 * @param {{minSamples?: number, window?: number}} opts
 */
export function pruneLanes(records, lanes, opts = {}) {
  const minSamples = Number(opts.minSamples === undefined ? 2 : opts.minSamples);
  const window = Number(opts.window === undefined ? 50 : opts.window);
  const list = Array.isArray(records) ? records : [];
  const want = Array.isArray(lanes) ? lanes : [];
  const kept = [];
  const dropped = [];
  for (const lane of want) {
    const rs = list
      // 0 秒失败不是「通道死了」，是「参数配错了」（模型名不认、CLI 立刻退）。
      // 拿它当通道死因会把最强的路砍掉 —— 2026-11-17 就这么差点砍掉 codebuddy。
      .filter((r) => r && r.agent === lane && typeof r.ok === 'boolean' && Number(r.elapsedMs) > 0)
      .slice(-window);
    const rate = rs.length ? rs.filter((r) => r.ok).length / rs.length : null;
    if (rs.length >= minSamples && rate === 0) dropped.push({ lane, samples: rs.length, rate: 0 });
    else kept.push(lane);
  }
  return { kept: kept.length ? kept : want.slice(), dropped };
}

/**
 * 派活前的四行预测：全部来自历史账本，算不出就明说算不出。
 * @param {{records?: Array<{agent?:string, ok?:boolean, elapsedMs?:number}>, lanes?: string[], units?: number}} opts
 */
export function predictRun(opts = {}) {
  const records = Array.isArray(opts.records) ? opts.records : [];
  const lanes = Array.isArray(opts.lanes) ? opts.lanes : [];
  const units = Number(opts.units || 0);

  const byLane = new Map();
  for (const r of records) {
    const a = String((r && r.agent) || '');
    if (!a) continue;
    if (!byLane.has(a)) byLane.set(a, []);
    byLane.get(a).push(r);
  }
  const p50 = (xs) => {
    const v = xs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.floor((v.length - 1) / 2)];
  };

  const perLane = [];
  for (const lane of lanes) {
    const rs = byLane.get(lane) || [];
    const okRate = rs.length ? rs.filter((r) => r.ok === true).length / rs.length : null;
    perLane.push({ lane, samples: rs.length, okRate, ms: p50(rs.map((r) => Number(r.elapsedMs))) });
  }

  const known = perLane.filter((x) => x.ms !== null);
  const slowest = known.length ? known.reduce((a, b) => (a.ms >= b.ms ? a : b)) : null;
  const worstRate = perLane.filter((x) => x.okRate !== null).sort((a, b) => a.okRate - b.okRate)[0] || null;

  const laneMs = slowest ? slowest.ms : null;
  const wall = laneMs === null ? null : units > 1 ? laneMs + Math.ceil(units / Math.max(1, lanes.length)) * 30000 : laneMs;
  const laneText = lanes.length ? lanes.join(', ') : '(未定)';
  const etaText = wall === null ? '算不出（这个通道没有历史样本）' : Math.round(wall / 1000) + 's';
  const riskText = worstRate
    ? worstRate.lane + ' 近 ' + worstRate.samples + ' 次成功率 ' + Math.round(worstRate.okRate * 100) + '%'
    : '没有历史样本，第一次跑就是在攒样本';

  return {
    lines: [
      '▶ 本次：' + lanes.length + ' 路（' + laneText + '）' + (units ? ' · ' + units + ' 个单元' : ''),
      '▶ 预计：' + etaText + (slowest ? '（按 ' + slowest.lane + ' 的 p50）' : ''),
      '▶ 最可能死法：' + riskText,
      '▶ 口径：成败看产物；卡 20 秒没有新输出就判卡住',
    ],
    perLane,
    wallMs: wall,
  };
}
