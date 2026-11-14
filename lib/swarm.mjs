// 群体派活（swarm）：把 N 个独立任务同时甩给多个 agent，榨干每一路并发。
//
// 为什么需要它：单件派活架构上必输 —— 写 prompt + 等 + 验收三份开销摊在一件事上。
// swarm 把开销摊到 N 件事上，并且**异构并行**：trae 快（~23s/个）但只有 1 路，
// codebuddy 慢（~168s/个）但有 6 路。混合起来的总吞吐约等于两者之和，不是取其一。
//
// 用法：
//   node orchestra.mjs swarm tasks.md
//   node orchestra.mjs swarm tasks.md --slots trae=1,codebuddy=6
//   node orchestra.mjs swarm tasks.md --agent codebuddy     （强制单 agent）
//   node orchestra.mjs swarm tasks.md --out report.md
//   node orchestra.mjs swarm tasks.md --resume              （接着上次没跑完的）

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadTasks } from './batch.mjs';
import { planLanding, applyLanding, renderPlan } from './land.mjs';
import { verifyContent, feedbackFor } from './verify.mjs';

/** 默认并发：trae 只有一个 Agent 页面（硬约束），codebuddy 是独立子进程可放开 */
export const DEFAULT_SLOTS = { trae: 1, codebuddy: 6, workbuddy: 1 };

/**
 * 强信号：明确要求「产出代码/命令/测试」—— 这类必须给 codebuddy（trae 输出的代码常编译不过）。
 * 写法是「动作 + 产物」同句出现，避免「举一个代码里的例子」这种问句被误判。
 */
const HEAVY_STRONG = /(写|实现|重构|改造|修复|优化|改写|补全|生成|产出|给个|来个|review|评审)([^。；\n]{0,24})(函数|类|接口|模块|脚本|命令|sql|正则|测试|代码|组件|api|程序|算法)/i;
/** 弱信号：出现这些词说明是工程活，但只有长任务才值得付 codebuddy 的 168s */
const HEAVY_WEAK = /(代码|实现|重构|改造|修复|脚本|报错|编译|部署|迁移|单元测试)/i;
const LIGHT_MAX = 160;

/**
 * 判断任务该给谁。依据不是「谁更强」，而是「谁的单位时间产出更高」：
 *   workbuddy: ~22s/次，1 路并行 → 单路 2.7 个/分钟，代码质量中上，无会话回合上限
 *   trae:      ~23s/次，1 路并行 → 单路 2.6 个/分钟，但代码质量弱且约 8 回合后读出失灵
 *   codebuddy: ~168s/次，6 路并行 → 6 路合计 2.1 个/分钟，代码质量明显更强
 * 所以：短散文给 trae/workbuddy，代码/长文给 codebuddy；混在一起时几条流水线同时跑。
 *
 * 注意：workbuddy 与 trae 是同一档的快路（20-25s），差别在失效模式 ——
 * trae 会随回合数衰减，workbuddy 目前没观察到衰减但要求应用开着（CDP 9224）。
 * 所以快路溢出时优先改派 workbuddy，而不是直接掉到 168s 的 codebuddy。
 */

/** 失败回退链：先换到同档或更快的路，别一头掉进最慢的。 */
export const FALLBACK = { trae: 'workbuddy', workbuddy: 'trae', codebuddy: 'workbuddy' };
export function routeTask(text, mode = 'auto') {
  if (mode === 'trae' || mode === 'codebuddy' || mode === 'workbuddy') return mode;
  const t = String(text || '');
  if (HEAVY_STRONG.test(t)) return 'codebuddy';          // 要产出代码 → 慢但准
  // 短问答默认给 workbuddy：同样 ~22s，但没有 trae 那种「回合数一多就失灵」的衰减。
  // trae 退成备用路（workbuddy 没开时由 runSwarm 的探测逻辑整体转过去）。
  if (t.length <= 800) return 'workbuddy';
  if (HEAVY_WEAK.test(t)) return 'codebuddy';            // 超长的工程活
  return 'codebuddy';                                    // 超长文（trae 单轮窗口吃不下）
}

/** 解析 --slots trae=1,codebuddy=6 */
export function parseSlots(spec) {
  const out = { ...DEFAULT_SLOTS };
  if (!spec) return out;
  for (const part of String(spec).split(',')) {
    const m = part.match(/^\s*([a-z]+)\s*=\s*(\d+)\s*$/i);
    if (m) out[m[1].toLowerCase()] = Math.max(1, Number(m[2]));
  }
  return out;
}

/** 读任务源 */
export function loadSwarmTasks(arg) {
  return loadTasks(arg).map((t, i) => ({ id: i + 1, text: t }));
}

/** 断点续跑目录：.swarm/<runId>/<id>.json */
export function runDir(runId) {
  const dir = path.join(process.cwd(), '.swarm', runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveResult(dir, item) {
  try { fs.writeFileSync(path.join(dir, item.id + '.json'), JSON.stringify(item, null, 2)); } catch { }
}

/** 每完成一个任务就刷新一次进度快照。
 *  为什么单独写 _progress.json 而不是直接改写 _meta.json：
 *  _meta.json 的结构被 top / cost 命令按固定形状解析，中途写半成品会让看板读到不一致的数据。
 *  进程被打断（Ctrl-C / 超时被杀 / 崩溃）时，只有 _meta.json 在最后写 —— 结果只剩零散单任务 json，
 *  既看不出这批是谁派的，也不知道跑到第几个。_progress.json 补的就是这个缺口。 */
function touchProgress(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
    const items = files.map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
    const ok = items.filter((i) => i.status === 'done').length;
    const snap = {
      partial: true,
      updatedAt: new Date().toISOString(),
      done: items.length,
      ok,
      items: items.map((i) => ({ id: i.id, agent: i.agent, ok: i.status === 'done', ms: i.elapsedMs, chars: String(i.output || '').length })),
    };
    fs.writeFileSync(path.join(dir, '_progress.json'), JSON.stringify(snap, null, 2));
  } catch { }
}

export function loadResults(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (o && o.id) out.set(o.id, o);
    } catch { }
  }
  return out;
}

export const fmtMs = (ms) => ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
const fmt = fmtMs;

/** 跑一池：同一 agent 的任务在这里排队，池内并发 = slots[agent] */
async function runPool(agentName, tasks, opts) {
  const { dispatchFn, slots, onProgress, retrySwitch, dir, tag } = opts;
  const n = Math.max(1, slots[agentName] || 1);
  const results = [];
  let cursor = 0;
  let done = 0;

  const worker = async (slotIdx) => {
    for (;;) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      const item = tasks[idx];
      const t0 = Date.now();
      onProgress({ type: 'start', id: item.id, agent: agentName, slot: slotIdx, text: item.text });

      const rec = { id: item.id, text: item.text, agent: agentName, status: 'fail', elapsedMs: 0, output: '', error: '' };
      const maxFix = Math.max(0, Number(opts.maxFix || 0));
      let prompt = item.text;
      let fixRound = 0;

      // 一次任务的生命周期：派活 →（失败换路）→ 落盘 → 验收 →（不合格回喂重试）。
      // 为什么要有回喂这一环：昨晚 6 份产出里有 1 份是「任务描述原样回显」，
      // agent 自报 done，内容却一句有用的都没有。只靠 status 判断等于不判断。
      for (;;) {
        try {
          const tagFix = fixRound ? ' 修' + fixRound : '';
          const r = await dispatchFn(prompt, {
            agent: agentName,
            summary: '[swarm ' + tag + ' #' + item.id + tagFix + '] ' + item.text.slice(0, 50),
          });
          rec.output = String((r && (r.addedText || r.text)) || '');
          rec.status = (r && r.ok && rec.output) ? 'done' : 'fail';
          if (rec.status === 'fail' && !rec.error) rec.error = (r && r.error) || '空产出';
        } catch (e) {
          rec.error = String((e && e.message) || e).slice(0, 300);
        }

        // 换路只在第一轮做：回喂的时候 prompt 已经变了，换路会丢掉「上次错在哪」这个上下文。
        if (rec.status === 'fail' && retrySwitch && retrySwitch !== agentName && fixRound === 0) {
          onProgress({ type: 'retry', id: item.id, from: agentName, to: retrySwitch, error: rec.error });
          const t1 = Date.now();
          try {
            const r2 = await dispatchFn(prompt, {
              agent: retrySwitch,
              summary: '[swarm ' + tag + ' #' + item.id + ' 换路] ' + item.text.slice(0, 40),
            });
            const out2 = String((r2 && (r2.addedText || r2.text)) || '');
            if (r2 && r2.ok && out2) {
              rec.agent = retrySwitch;
              rec.output = out2;
              rec.status = 'done';
              rec.error = '';
              rec.retriedFrom = agentName;
            }
          } catch (e2) { rec.error += ' | 换路失败：' + String((e2 && e2.message) || e2).slice(0, 160); }
          rec.elapsedMs += Date.now() - t1;
        }

        if (rec.status !== 'done') break;

        // 落盘 + 验收（--land / --verify 才做，默认保持「只拿文本」的旧行为）
        if (opts.land || opts.verify) {
          const plan = planLanding([rec], { minBytes: opts.minBytes });
          const one = plan[0] || {};
          if (one.target && one.content) {
            if (opts.land) {
              const applied = applyLanding([one], { force: !!opts.force });
              const a = applied[0] || {};
              rec.land = { target: one.target, result: a.result, bytes: one.bytes };
              if (a.result === 'written' || a.result === 'need-force') rec.landPath = one.target;
            }
            const vres = verifyContent(one.target, one.content, item.text, { mode: opts.deep ? 'deep' : 'normal' });
            rec.verify = { target: one.target, ok: vres.ok, checks: vres.checks };
            if (!vres.ok) {
              onProgress({ type: 'verify-fail', id: item.id, target: one.target, checks: vres.checks.filter((c) => !c.ok) });
              if (fixRound < maxFix) {
                fixRound++;
                prompt = feedbackFor(rec, item.text, vres);
                onProgress({ type: 'fix', id: item.id, round: fixRound, target: one.target });
                continue;
              }
            }
          } else {
            rec.verify = { ok: false, checks: [{ name: '落盘目标', ok: false, detail: one.reason || '没识别出目标路径' }] };
            onProgress({ type: 'verify-fail', id: item.id, target: '', checks: [{ name: '落盘目标', ok: false, detail: one.reason || '' }] });
          }
        }
        break;
      }
      rec.elapsedMs = Date.now() - t0;

      if (dir) { saveResult(dir, rec); touchProgress(dir); }
      results.push(rec);
      done++;
      onProgress({ type: 'done', total: tasks.length, done, item: rec });
    }
  };

  await Promise.all(Array.from({ length: Math.min(n, Math.max(1, tasks.length)) }, (_, i) => worker(i + 1)));
  return results;
}

/** 主入口：分组 → 各池并行 → 汇总。总耗时 ≈ 最慢那一池，不是两池之和。 */
export async function runSwarm(tasks, opts) {
  const {
    mode = 'auto', slots = DEFAULT_SLOTS, dispatchFn, onProgress = () => {},
    resume = false, runId = 'r' + Date.now(), switchOnFail = true,
  } = opts;

  const startedAt = Date.now();
  const dir = runDir(runId);
  const prev = resume ? loadResults(dir) : new Map();

  // workbuddy 是 CDP 系执行端：应用没开就等于这条路不存在。
  // 派活前先探端口，探不到就把它的任务整体改派，别让整池白等 22s 再失败。
  let wbUsable = null;
  if (opts.probe !== false) {
    wbUsable = await new Promise((resolve) => {
      const port = Number(process.env.WB_PORT || 9224);
      const s = net.connect({ host: '127.0.0.1', port });
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; try { s.destroy(); } catch {} resolve(v); };
      s.setTimeout(1500, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
    if (!wbUsable) onProgress({ type: 'warn', msg: 'workbuddy 未就绪（9224 未监听），本批不派给它' });
  }

  const todo = [];
  const skipped = [];
  for (const t of tasks) {
    const hit = prev.get(t.id);
    if (hit && hit.status === 'done') { skipped.push(hit); continue; }
    todo.push({ ...t, agent: routeTask(t.text, mode) });
  }

  const groups = new Map();
  for (const t of todo) {
    if (!groups.has(t.agent)) groups.set(t.agent, []);
    groups.get(t.agent).push(t);
  }

  // 探测失败时把 workbuddy 组的任务整体改派给 trae，保持「不失败」优先于「省时间」。
  if (wbUsable === false) {
    const wg = groups.get('workbuddy') || [];
    if (wg.length) {
      const moved = wg.map((t) => ({ ...t, agent: 'trae', movedFrom: 'workbuddy' }));
      groups.delete('workbuddy');
      groups.set('trae', [...(groups.get('trae') || []), ...moved]);
      onProgress({ type: 'move', from: 'workbuddy', to: 'trae', count: moved.length });
    }
  }

  // Trae 的硬限制：会话列表是虚拟化的，一条会话稳定承载约 8 个来回。
  // 超过之后「回合数」不再增长、文本指纹又可能撞车，判据会失灵（实测）。
  // 开新会话这条路已被证伪（点新建后会话区读不到文本），所以正确做法不是硬修，
  // 而是把超出部分**动态改派**给它旁边那条能开多路的流水线 —— 用慢一点换「不失败」。
  const traeLimit = Number(process.env.ORCH_TRAE_SOFT_LIMIT || 8);
  const tg = groups.get('trae') || [];
  if (tg.length > traeLimit) {
    // 溢出部分先给 workbuddy（22s，同档快路），它接不住才落到 codebuddy（168s）。
    const wbReady = wbUsable !== false;
    const to = wbReady ? 'workbuddy' : 'codebuddy';
    const moved = tg.slice(traeLimit).map((t) => ({ ...t, agent: to, movedFrom: 'trae' }));
    groups.set('trae', tg.slice(0, traeLimit));
    groups.set(to, [...(groups.get(to) || []), ...moved]);
    onProgress({ type: 'split', from: 'trae', to, count: moved.length, limit: traeLimit });
  }

  const pools = [...groups.entries()].map(([agentName, list]) => {
    // 回退目标优先级：同档快路 > 另一条快路 > 最慢但最强的 codebuddy。
    let other = FALLBACK[agentName] || 'trae';
    if (other === agentName) other = 'trae';
    if (agentName === 'codebuddy' && wbUsable === false) other = 'trae';
    if (other !== 'codebuddy' && wbUsable === false && agentName === 'trae') other = 'codebuddy';
    return runPool(agentName, list, {
      dispatchFn, slots, onProgress, dir, tag: agentName,
      retrySwitch: switchOnFail ? other : null,
      // 落盘/验收开关必须显式透传。runPool 只认自己 opts 上的字段，
      // 漏传的症状是「任务全 ✓ 但 land/verify 全是 null、磁盘上什么都没写」——
      // 实测踩过一次，因为 runSwarm 的 opts 不会自动流到 runPool。
      land: opts.land, verify: opts.verify, maxFix: opts.maxFix,
      force: opts.force, deep: opts.deep,
    });
  });

  const settled = await Promise.all(pools);
  const all = [...skipped, ...settled.flat()].sort((a, b) => a.id - b.id);
  const now = Date.now();
  const meta = {
    runId, taskSource: String(opts.taskSource || '').slice(0, 120),
    startedAt: now - (now - startedAt), endedAt: now, wallMs: now - startedAt,
    tasks: tasks.length, ok: all.filter((r) => r.status === 'done').length,
    skipped: skipped.length,
    plan: Object.fromEntries([...groups.entries()].map(([k, v]) => [k, v.length])),
    serialMs: all.reduce((s, r) => s + (r.elapsedMs || 0), 0),
  };
  try { fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify(meta, null, 2)); } catch { }
  return { runId, dir, results: all, skipped: skipped.length, meta };
}

/** 读全部批次历史（吞吐看板用） */
export function listRuns(limit = 20) {
  const root = path.join(process.cwd(), '.swarm');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root)) {
    const mf = path.join(root, d, '_meta.json');
    if (!fs.existsSync(mf)) continue;
    try { out.push(JSON.parse(fs.readFileSync(mf, 'utf8'))); } catch { }
  }
  return out.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, limit);
}

/** 汇总成 markdown 报告 */
export function renderReport(taskSource, out) {
  const { results, runId, skipped } = out;
  const ok = results.filter((r) => r.status === 'done');
  const bad = results.filter((r) => r.status !== 'done');
  const totalMs = results.reduce((s, r) => s + (r.elapsedMs || 0), 0);
  const wallMs = Math.max(0, ...results.map((r) => r.elapsedMs || 0));
  const F = "```";
  const L = [];
  L.push('# swarm 报告');
  L.push('');
  L.push('- 任务源：' + String(taskSource).slice(0, 120));
  L.push('- 批次：' + runId + (skipped ? '（续跑，跳过已有 ' + skipped + ' 项）' : ''));
  L.push('- 结果：**' + ok.length + '/' + results.length + ' 成功**');
  L.push('- 单任务最长耗时：' + fmt(wallMs) + '；全部任务耗时之和：' + fmt(totalMs));
  L.push('');
  for (const r of results) {
    L.push('## #' + r.id + '  ' + (r.status === 'done' ? '✓' : '✗') + '  ' + r.agent + '  ' + fmt(r.elapsedMs || 0));
    L.push('');
    L.push('> ' + String(r.text || '').replace(/\n/g, ' ').slice(0, 160));
    L.push('');
    if (r.status === 'done') {
      L.push(F);
      L.push(String(r.output || '').slice(0, 4000));
      L.push(F);
    } else {
      L.push('**失败**：' + (r.error || '未知'));
    }
    if (r.retriedFrom) L.push('_' + r.retriedFrom + ' 失败后换路成功_');
    L.push('');
  }
  if (bad.length) {
    L.push('---');
    L.push('');
    L.push('## 需要重派');
    L.push('');
    for (const r of bad) L.push('- #' + r.id + '  ' + (r.error || '未知'));
  }
  return L.join(String.fromCharCode(10));
}
