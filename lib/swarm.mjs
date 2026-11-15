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
import { emitSpecFile } from './apispec.mjs';
import { askTraeFile } from '../agents/trae.mjs';
import { askFile as askWorkbuddyFile } from '../agents/workbuddy.mjs';
import { askDoubao } from '../agents/doubao.mjs';
import { layers as dagLayers } from './dag.mjs';

/**
 * 文件信箱派活（2026-11-14 加）：要产物的任务不再从渲染后的 DOM 里抠代码。
 *
 * 为什么非改不可：GUI 客户端的回答区是渲染后的 DOM，`x`→<code>、##→<h2>、**b**→<strong>，
 * innerText 只剩下文字，语法字符全丢。实测代价 —— trae 掉双星号、workbuddy 343 秒
 * 交回的代码里反引号一个不剩（`return [Function ${x}];` 直接是坏的）。
 * 让 agent 自己写文件、我们读字节，渲染器根本不在链路上。
 *
 * 只对三条 GUI 通道生效；codebuddy 是 CLI 子进程，本来就直出字节，不用绕。
 */
const MAILBOX_AGENTS = new Set(['trae', 'workbuddy', 'doubao']);

async function askViaMailbox(agent, prompt, opts = {}) {
  const shared = opts.shared !== false;   // 默认落 TDW place，多通道碰头用
  const timeoutMs = opts.timeoutMs;
  if (agent === 'trae') {
    const r = await askTraeFile(prompt, { shared, timeoutMs });
    return { ok: !!r.ok, text: r.text || '', raw: r.text || '', file: r.file, ms: r.elapsedMs };
  }
  if (agent === 'workbuddy') {
    const r = await askWorkbuddyFile(prompt, { shared, timeoutMs });
    return { ok: !!r.ok, text: r.text || '', raw: r.text || '', file: r.file, ms: r.ms };
  }
  if (agent === 'doubao') {
    const r = await askDoubao(prompt, { shared, timeoutMs });
    return { ok: true, text: r.raw || r.answer || '', raw: r.raw || '', file: r.file, ms: r.ms };
  }
  throw new Error('not a mailbox agent: ' + agent);
}

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

/** 读任务源。
 *  两种格式：
 *  1) JSON 文件（.json）：[{id, text, deps:[1,2]}] —— 唯一能完整表达依赖的格式，分波次靠它。
 *  2) 纯文本：在行首写 [dep:1,2] 表达依赖，解析时把这段标记剥掉，正文保持干净。
 *  没有 deps 时行为与原来完全一致（一把并行），所以老用法不受影响。
 */
export function loadSwarmTasks(arg) {
  const s = String(arg == null ? '' : arg).trim();
  if (/\.json$/i.test(s) && fs.existsSync(s)) {
    const raw = JSON.parse(fs.readFileSync(s, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.tasks) ? raw.tasks : null);
    if (!arr) throw new Error('任务 JSON 必须是数组，或是 {tasks:[...]}：' + s);
    return arr.map((t, i) => ({
      id: t.id == null ? i + 1 : t.id,
      text: String(t.text || t.prompt || t.task || ''),
      deps: t.deps || t.dependencies || [],
      title: String(t.title || ''),
      // contract：本次产物的接口契约；dependsOn：上游产物路径。
      // 这两个字段必须在这里显式带出来 —— 9-15 夜里我只在 verifyContent 里读了 item.contract，
      // 却没让 loadSwarmTasks 把它放进 item，结果契约永远是 null、静默不生效。
      contract: t.contract || null,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
    })).filter((t) => t.text);
  }
  return loadTasks(arg).map((t, i) => {
    const m = String(t).match(/^\s*\[dep:([\d,\s]+)\]\s*/i);
    const deps = m ? m[1].split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n)) : [];
    return { id: i + 1, text: m ? String(t).slice(m[0].length) : String(t), deps };
  });
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

/** 把上游产物的真实导出签名拼成一段前置说明。抽成独立函数是为了能单测 ——
 *  这段决定了模型看到什么，写错了整批任务都在按错的签名写。 */
export function buildUpstreamBlock(dependsOn) {
  const NL = String.fromCharCode(10);
  const blocks = [];
  for (const up of dependsOn || []) {
    const sp = emitSpecFile(up);
    const sig = (sp.exports || [])
      .map((e) => e.name + '(' + (e.params ? e.params.join(', ') : '…') + ')')
      .join(' · ');
    blocks.push('  ' + up + '  →  ' + (sig || '（没解析到导出，自己读文件确认）'));
  }
  return '【上游已有接口，不要改它们，按这些签名调用】' + NL + blocks.join(NL) + NL + NL;
}

/** 通道超时后从磁盘抢救产物。
 *  2026-11-15 实测三次：workbuddy 每次都把文件写对了，244 秒后报「没拿到回答」被判失败。
 *  判据取磁盘字节（本次派活之后被改写过的文件），不取通道的自我报告 ——
 *  通道说失败，任务可能已经做完了。抽成独立函数是为了能单测。 */
export function salvageFromDisk(promptText, sinceMs, opts = {}) {
  const minBytes = opts.minBytes == null ? 40 : opts.minBytes;
  const picks = (String(promptText || '').match(/[A-Za-z]:[\\/][^\s"'<>|*?\r\n]+?\.\w{1,5}/g) || [])
    .map((s) => s.replace(/[，。；、）)\]]+$/, ''))
    .filter((v, i, a) => a.indexOf(v) === i);
  let best = null;
  for (const p of picks) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size < minBytes) continue;
      if (st.mtimeMs < sinceMs - 2000) continue;
      if (!best || st.size > best.size) best = { p, size: st.size, mtimeMs: st.mtimeMs };
    } catch { }
  }
  return best;
}

/** 跑一池：同一 agent 的任务在这里排队，池内并发 = slots[agent] */
async function runPool(agentName, tasks, opts) {
  const { dispatchFn, slots, onProgress, retrySwitch, dir, tag } = opts;
  const n = Math.max(1, slots[agentName] || 1);

  // 2026-11-15 rank2：信箱改默认。DOM 抓取必丢语法字符（反引号变 code 标签、井号变 h2、
  // 双星号变 strong），innerText 取回只剩文字；给每条通道写字符还原补丁等于永久打地鼠。
  // 信箱走磁盘、渲染器不在链路上、字节零损伤，所以默认用它；只有显式 --fast
  // （只要一段人看的话、不要产物、要最快）才退回 DOM。
  const useMailbox = opts.mailbox !== false && opts.fast !== true;
  const dispatch = async (prompt, extra) => {
    const agent = (extra && extra.agent) || agentName;
    if (useMailbox && MAILBOX_AGENTS.has(agent)) {
      try {
        return await askViaMailbox(agent, prompt, opts);
      } catch (e) {
        // 信箱不是单点：挂了就退回原路，宁可掉字符也别整批失败
        onProgress({ type: 'warn', msg: agent + ' 信箱失败，退回直连：' + String((e && e.message) || e).slice(0, 90) });
        return dispatchFn(prompt, extra);
      }
    }
    return dispatchFn(prompt, extra);
  };
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
      // 上游接口注入：把上游产物里**真实的导出签名**拼在任务前面。
      // 这样派活的人不用手抄、模型也不用猜 —— 签名来自磁盘上的字节，不是记忆。
      if (item.dependsOn && item.dependsOn.length) {
        prompt = buildUpstreamBlock(item.dependsOn) + item.text;
      }
      let fixRound = 0;

      // 一次任务的生命周期：派活 →（失败换路）→ 落盘 → 验收 →（不合格回喂重试）。
      // 为什么要有回喂这一环：昨晚 6 份产出里有 1 份是「任务描述原样回显」，
      // agent 自报 done，内容却一句有用的都没有。只靠 status 判断等于不判断。
      for (;;) {
        try {
          const tagFix = fixRound ? ' 修' + fixRound : '';
          const r = await dispatch(prompt, {
            agent: agentName,
            summary: '[swarm ' + tag + ' #' + item.id + tagFix + '] ' + item.text.slice(0, 50),
          });
          rec.output = String((r && (r.addedText || r.text)) || '');
          rec.status = (r && r.ok && rec.output) ? 'done' : 'fail';
          if (rec.status === 'fail' && !rec.error) rec.error = (r && r.error) || '空产出';
        } catch (e) {
          const why = String((e && e.message) || e).slice(0, 300);
          const saved = useMailbox ? salvageFromDisk(item.text, t0) : null;
          if (saved) {
            try { rec.output = fs.readFileSync(saved.p, 'utf8'); } catch { rec.output = ''; }
            if (rec.output) {
              rec.status = 'done';
              rec.salvagedPath = saved.p;
              rec.error = '通道超时（' + why + '），产物已从磁盘抢救';
              onProgress({ type: 'warn', msg: '#' + item.id + ' ' + agentName + ' 超时，但产物已在磁盘：' + saved.p + '（' + saved.size + ' 字节）→ 改判成功' });
            } else { rec.error = why; }
          } else { rec.error = why; }
        }

        // 换路只在第一轮做：回喂的时候 prompt 已经变了，换路会丢掉「上次错在哪」这个上下文。
        if (rec.status === 'fail' && retrySwitch && retrySwitch !== agentName && fixRound === 0) {
          onProgress({ type: 'retry', id: item.id, from: agentName, to: retrySwitch, error: rec.error });
          const t1 = Date.now();
          try {
            const r2 = await dispatch(prompt, {
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
          // action 必须一起判。2026-11-15 实测：codebuddy 因 max-turns=1 返回 21 字符
          // "Max turns (1) exceeded"，land 判它「内容太短」给了 skip，但这里只看 target+content
          // 非空，于是照样拿去跑 node --check，报出来的错像是产物质量问题，
          // 实际是通道根本没交东西。skip 一律走 else 分支，如实报「内容太短」。
          if (one.target && one.content && one.action !== 'skip') {
            if (opts.land) {
              const applied = applyLanding([one], { force: !!opts.force });
              const a = applied[0] || {};
              rec.land = { target: one.target, result: a.result, bytes: one.bytes };
              if (a.result === 'written' || a.result === 'need-force') rec.landPath = one.target;
            }
            // item.contract 是可选的接口契约（{ exports: [{ name, params }] }）。
            // 有它才验参数个数和参数名；没有就只走原有那三层（结构/语法/导出名）。
            // 不猜、不自动生成 —— 契约写错比不写更糟，必须由派活的人显式给。
            const vres = verifyContent(one.target, one.content, item.text, { mode: opts.deep ? 'deep' : 'normal', spec: item.contract || null });
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


/**
 * 分波次执行：按依赖图把任务切成层，逐层并行。
 *
 * 为什么需要它：把所有任务一把并行，等于假装它们互不依赖。真实项目里 A 定义了接口、
 * B 才能实现它，一把并行只会让 B 基于空气写代码，产物必然要返工——返工吃掉的全部节省
 * 比并行赚回来的还多。所以正确做法不是「并行度更高」，而是「把可并行的部分认清」。
 *
 * 层间怎么传递：只传**产物文件路径**，不传内容。下游 agent 本来就有读文件的能力
 * （codebuddy 带 --tools Read），让它自己去读，比把几 KB 内容塞进 prompt 省得多，
 * 也不会触发上下文预算告警。
 *
 * @param {Array} tasks 任务列表，每项可带 deps / dependencies
 * @param {object} opts 同 runSwarm，另加 waves:false 可强制关闭分层
 * @returns {Promise<{runId:string, dir:string, results:Array, waves:number}>}
 */
export async function runSwarmWaves(tasks, opts = {}) {
  const depsOf = (t) => (t && (t.deps || t.dependencies)) || [];
  const anyDep = tasks.some((t) => depsOf(t).length > 0);
  if (!anyDep || opts.waves === false) return runSwarm(tasks, opts);

  let L;
  try {
    L = dagLayers(tasks);
  } catch (e) {
    // 有环或缺依赖：不猜，退回一把并行，让任务自己失败得明明白白
    opts.onProgress && opts.onProgress({ type: 'warn', msg: '依赖图无法分层（' + String(e.message || e).slice(0, 80) + '），退回一把并行' });
    return runSwarm(tasks, opts);
  }
  if (L.length <= 1) return runSwarm(tasks, opts);

  const baseId = opts.runId || 'r' + Date.now();
  const results = [];
  let upstream = [];
  let lastDir = '';
  for (let i = 0; i < L.length; i++) {
    const ids = new Set(L[i].map((x) => String(x)));
    const layerTasks = tasks.filter((t) => ids.has(String(t.id)));
    if (!layerTasks.length) continue;
    const inj = upstream.length
      ? '\n\n[上游产物（已落盘，请直接读取文件内容，不要凭猜测重写）]\n'
        + upstream.map((u) => '- ' + u.file + (u.title ? '  （' + u.title + '）' : '')).join('\n')
        + '\n[/上游产物]'
      : '';
    opts.onProgress && opts.onProgress({
      type: 'wave', wave: i + 1, waves: L.length, count: layerTasks.length,
      msg: '第 ' + (i + 1) + '/' + L.length + ' 波：' + layerTasks.length + ' 个并行' + (upstream.length ? '（带 ' + upstream.length + ' 个上游产物）' : ''),
    });
    const r = await runSwarm(
      layerTasks.map((t) => ({ ...t, text: String(t.text) + inj })),
      { ...opts, runId: baseId + '-w' + (i + 1) }
    );
    lastDir = r.dir || lastDir;
    results.push(...(r.results || []));
    upstream = [];
    for (const it of (r.results || [])) {
      if (it && it.land && it.land.target) upstream.push({ file: it.land.target, title: it.title || ('任务 ' + it.id) });
    }
  }
  return { runId: baseId, dir: lastDir, results, waves: L.length };
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
