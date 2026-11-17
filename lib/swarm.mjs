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
import { planLanding, applyLanding, renderPlan, selfLanded, detectTarget } from './land.mjs';
import { verifyContent, feedbackFor, runCompareCheck, applyRegress } from './verify.mjs';
import { emitSpecFile } from './apispec.mjs';
import { renderBlock as blindspotBlock } from './blindspots.mjs';
import { askTraeFile } from '../agents/trae.mjs';
import { askFile as askWorkbuddyFile } from '../agents/workbuddy.mjs';
import { askDoubao } from '../agents/doubao.mjs';
import { layers as dagLayers } from './dag.mjs';
import { judgeLaneDeadline, ttfbFor } from './outcome.mjs';

/**
 * 单路快速失败（P0-3，2026-11-17）。
 *
 * 为什么必须在这一层做：上一版把「卡住」做成了全局判据（整个 swarm 静默才掐），
 * 而实测的死法是**单路静默、其余路还在吐字** —— 全局判据永远不会触发，
 * 于是一路死了要等它自己的 timeout（270s/300s/450s）才腾出结果。
 *
 * 这里改成「谁没张嘴谁先死」：超过 ttfbMs 没回第一个字就判死，立刻走换模型/换路。
 * 底层那个 promise 不杀（GUI 自动化没法从外面取消），但**不再等它**，
 * 且挂了空 catch —— 否则它迟到 reject 会变成 unhandled rejection 把整批带崩。
 */
function withLaneDeadline(promise, opts = {}) {
  const ttfbMs = Number(opts.ttfbMs === undefined ? TTFB_MS : opts.ttfbMs);
  if (!(ttfbMs > 0)) return promise;
  const startedAt = Date.now();
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      const d = judgeLaneDeadline({ startedAt, now: Date.now(), ttfbMs });
      resolve({ __deadline: true, ok: false, text: '', addedText: '', error: d.text || '首字节超时' });
    }, ttfbMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, guard]).then(
    (r) => {
      if (timer) clearTimeout(timer);
      return r;
    },
    (e) => {
      if (timer) clearTimeout(timer);
      throw e;
    },
  ).finally(() => {
    // 输掉的那一路仍可能迟到：吞掉它的结果，别让它冒到 unhandledRejection
    if (typeof promise.catch === 'function') promise.catch(() => {});
  });
}

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
    // 2026-11-16 修：这里原先是 ok: true 硬编码，不看产出。
    // 后果是空产出也进账为成功，成功率被虚高。现在按「有没有非空文本」判。
    const _txt = r.raw || r.answer || '';
    return { ok: !!String(_txt).trim(), text: _txt, raw: _txt, file: r.file, ms: r.ms };
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
  // doubao 也要在这里放行：MailboxAgents 里已经支持它（askViaMailbox → askDoubao），
  // 但路由白名单漏了它 → `--agent doubao` 会静默掉进 auto 分支，任务被分给别人。
  if (mode === 'trae' || mode === 'codebuddy' || mode === 'workbuddy' || mode === 'doubao') return mode;
  const t = String(text || '');
  if (HEAVY_STRONG.test(t)) return 'codebuddy';          // 要产出代码 → 慢但准
  // 短问答默认给 workbuddy：同样 ~22s，但没有 trae 那种「回合数一多就失灵」的衰减。
  // trae 退成备用路（workbuddy 没开时由 runSwarm 的探测逻辑整体转过去）。
  if (t.length <= 800) return 'workbuddy';
  if (HEAVY_WEAK.test(t)) return 'codebuddy';            // 超长的工程活
  return 'codebuddy';                                    // 超长文（trae 单轮窗口吃不下）
}

/** 全部四个通道。用户 2026-11-15 明确要求「这些 AI 都要用上」——
 *  所以多路派活默认是全四路，不是挑稳的两路。 */
export const ALL_AGENTS = ['codebuddy', 'trae', 'workbuddy', 'doubao'];

/** 把 --agent 解析成「若干条通道」。
 *  单个名字 → [那一条]；逗号串 → 拆开（非法名过滤）；all / 四路 → 全四路；
 *  其余（auto/空）→ 按 task 文本自动选一条。
 *  为什么需要它：routeTask 只返回单个名字，同题多写（一起写）压根调不起来 ——
 *  实测 `--agent trae,codebuddy,workbuddy` 匹配不上任何白名单，静默掉进 auto，
 *  整批全分给 workbuddy。 */
export function routeTasks(text, mode = 'auto') {
  const m = String(mode || 'auto').toLowerCase().trim();
  if (m === 'all' || m === '四路' || m === 'everyone') return [...ALL_AGENTS];
  if (m.includes(',')) {
    const list = m.split(',').map((s) => s.trim()).filter((s) => ALL_AGENTS.includes(s));
    if (list.length) return [...new Set(list)];
  }
  return [routeTask(text, m)];
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
      // behave：行为用例文件路径。结构/语法/行数/导出名四层判不了「算得对不对」，
      // 只有真跑一遍才知道 —— 2026-11-16 的 humanVerdict 四层全过、分数全错。
      behave: t.behave || null,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
    })).filter((t) => t.text);
  }
  return loadTasks(arg).map((t, i) => {
    const m = String(t).match(/^\s*\[dep:([\d,\s]+)\]\s*/i);
    const deps = m ? m[1].split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n)) : [];
    const text = m ? String(t).slice(m[0].length) : String(t);
    // 行为用例在任务正文里用「行为：_probe/x.behavior.mjs」一行声明。
    // 从正文里剥掉这行再派活 —— 对 agent 它只是噪音，它写代码不关心我们怎么验。
    const bm = text.match(/^\s*行为\s*[:：]\s*(\S+\.mjs)\s*$/m);
    const behave = bm ? bm[1] : null;
    const body = bm ? text.replace(bm[0], '').replace(/\n{3,}/g, '\n\n') : text;
    return { id: i + 1, text: body, deps, behave };
  });
}

/** 断点续跑目录：.swarm/<runId>/<id>.json */
export function runDir(runId) {
  const dir = path.join(process.cwd(), '.swarm', runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveResult(dir, item) {
  // 同题多写时多条 lane 共用同一个 item.id，文件名不加 lane 后缀会互相覆盖 ——
  // 只剩最后一家的产物，前面几家的等于白跑。
  const name = item.id + (item.lane ? '.' + item.lane : '') + '.json';
  try { fs.writeFileSync(path.join(dir, name), JSON.stringify(item, null, 2)); } catch { }
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
  // 每路派活都过 TTFB 快闸：超过 ATWO_TTFB_MS（默认 15s）没出第一个字就判死并换路。
  // 关掉的办法只有一个：ATWO_TTFB_MS=0。
  // 阈值按通道取：codebuddy 是 CLI 子进程（启动+握手+首 token 要 20–40s），
  // GUI 通道真活着时 3–15s 就有第一行。统一阈值会误杀 codebuddy（2026-11-17 实测）。
  const ttfbOverride = process.env.ATWO_TTFB_MS;
  const dispatchDeadline = (prompt, extra) => {
    const agent = (extra && extra.agent) || agentName;
    const ttfbMs = Number(ttfbOverride === undefined ? ttfbFor(agent) : ttfbOverride) || 0;
    return withLaneDeadline(dispatch(prompt, extra), { ttfbMs });
  };
  // 派活之前先备份：codebuddy 这类带 Write 工具的通道会在「回答之前」就把目标文件改掉，
  // 等落盘时才备份，拿到的是改过的新版本 —— 对拍于是永远「一致」（实测批次 r1794769633334：
  // 备份 mtime 03:07:24 早于落盘 03:07:27，但备份内容已经是新版）。
  // 所以备份时机必须提前到 dispatch 之前，用任务文本里扫到的路径预扫一遍。
  const preBackups = new Map();
  if (opts.land) {
    for (const t of tasks) {
      if (!t.behave) continue;
      const cand = detectTarget(t.text, null);
      if (!cand) continue;
      const absOld = path.resolve(process.cwd(), cand);
      if (!fs.existsSync(absOld)) continue;
      try {
        const bakDir = path.join(dir || '.swarm', 'prev');
        fs.mkdirSync(bakDir, { recursive: true });
        const _e = path.extname(cand);
        const _s = path.basename(cand, _e);
        const bp = path.join(bakDir, _s + '.pre.' + t.id + (t.lane ? '.' + t.lane : '') + _e);
        fs.copyFileSync(absOld, bp);
        preBackups.set(String(t.id) + (t.lane ? '.' + t.lane : ''), bp);
      } catch { /* 备份失败不影响派活，落盘段还会再试一次 */ }
    }
  }

  const results = [];
  let cursor = 0;
  let done = 0;

  // 同一通道在本轮是否并发跑多路：GUI 通道的模型是「界面全局状态」，
  // 并发时 A 路换模型会把 B 路的选择一起改掉，所以并发时不做 GUI 换模型，只走换通道。
  const concurrentSame = Math.min(n, Math.max(1, tasks.length)) > 1;

  const worker = async (slotIdx) => {
    for (;;) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      const item = tasks[idx];
      const t0 = Date.now();
      onProgress({ type: 'start', id: item.id, agent: agentName, slot: slotIdx, text: item.text });

      const rec = { id: item.id, text: item.text, agent: agentName, status: 'fail', elapsedMs: 0, output: '', error: '', lane: item.lane || '' };
      const maxFix = Math.max(0, Number(opts.maxFix || 0));
      let prompt = item.text;
      // 上游接口注入：把上游产物里**真实的导出签名**拼在任务前面。
      // 这样派活的人不用手抄、模型也不用猜 —— 签名来自磁盘上的字节，不是记忆。
      if (item.dependsOn && item.dependsOn.length) {
        // 盲区注入：把「这个通道过去反复被挑出的问题类型」放在最前面。
        // 位置有讲究 —— 放在任务正文前，模型会先读到「我该怎么自查」再读任务；
        // 放在后面会被长任务正文挤掉注意力。
        // 内容来自 lib/blindspots.mjs 的账本，空的时候返回空串，不占 token。
        prompt = blindspotBlock(opts.agent || active) + buildUpstreamBlock(item.dependsOn) + item.text;
      }
      let fixRound = 0;

      // 一次任务的生命周期：派活 →（失败换路）→ 落盘 → 验收 →（不合格回喂重试）。
      // 为什么要有回喂这一环：昨晚 6 份产出里有 1 份是「任务描述原样回显」，
      // agent 自报 done，内容却一句有用的都没有。只靠 status 判断等于不判断。
      for (;;) {
        try {
          const tagFix = fixRound ? ' 修' + fixRound : '';
          const r = await dispatchDeadline(prompt, {
            agent: agentName,
            summary: '[swarm ' + tag + ' #' + item.id + tagFix + '] ' + item.text.slice(0, 50),
          });
          rec.output = String((r && (r.addedText || r.text)) || '');
          rec.status = (r && r.ok && rec.output) ? 'done' : 'fail';
          if (rec.status === 'fail' && !rec.error) rec.error = (r && r.error) || '空产出';
        } catch (e) {
          const why = String((e && e.message) || e).slice(0, 300);

          // 2026-11-15：通道失败/超时时，异常上可能挂着 partial —— 模型已经吐出来但没走完的部分。
          // 以前这类内容一律丢弃：实测 codebuddy 写 120 行模块耗掉 240 秒、日志显示已写到
          // 第三个函数，成品随异常一起消失，run json 里只留下换路后那一份。
          // 现在单独留档到 rec.partialOutput，**不判为交付**（半截代码不该自动落盘或验收），
          // 但人能打开 run json 抢救。status 记为 timeout 而不是 fail，
          // 因为它和「通道直接拒绝/起不来」不是一回事。
          const partialText = String((e && e.partial && e.partial.addedText) || '');
          if (partialText) {
            rec.partialOutput = partialText;
            rec.partialChars = partialText.length;
            if (rec.status !== 'done') rec.status = 'timeout';
            onProgress({
              type: 'warn',
              msg: '#' + item.id + ' ' + agentName + ' 失败但已收到 ' + partialText.length + ' 字节部分产出（留档不判交付）',
            });
          }

          // 2026-11-16 产物优先：通道超时/失败，但只要目标文件已在本轮写盘，就算交付。
          // 事故：codebuddy 177.2s 已写完 lib/quota-log.mjs + test/quota_log.test.mjs，
          // 180s 阈值判 timeout，后面白烧 12 分钟换模型/换路/信箱补救，结论还写成「全失败」。
          const saved = useMailbox
            ? salvageFromDisk(item.text, t0)
            : (() => {
                try {
                  const cands = [];
                  const tgt = detectTarget(item.text, null);
                  if (tgt) cands.push(tgt);
                  const rel = String(item.text || '').match(
                    /(?:lib|test|vm|agents|packages|docs|tools|fixtures)\/[\w./-]+\.\w{1,5}/g
                  ) || [];
                  for (const one of rel) if (cands.indexOf(one) < 0) cands.push(one);
                  let best = null;
                  for (const c of cands) {
                    const hit = selfLanded(c, t0 - 1000, { minBytes: 40 });
                    if (hit && (!best || hit.size > best.size)) best = hit;
                  }
                  return best ? { p: best.path, size: best.size } : null;
                } catch {
                  return null;
                }
              })();
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

        // 故障时先换模型，再换通道（2026-11-16）。
        // 用户澄清过换模型的目的：不是「按档位省钱」，是「避免某一个模型超时或用不了」——
        // 那是故障切换，触发时机在失败之后，不是派活之前。
        //
        // 但只有真能换的通道才谈得上：codebuddy 认 opts.model（一次进程一个模型，并发安全）；
        // workbuddy 的模型是界面全局状态，多路并发时会互相拆台（A 路刚设成 Hy3，B 路就改成别的）；
        // trae / doubao 曾经以为换不了 —— 2026-11-16 实测推翻了（见上面那段 GUI 换模型）。
        //
        // 证据：2026-11-15 那次 425 秒超时，trace 里 188 次 generation 全是 hy4free，
        // 换 deepseek-v4.1-flash 之后同一题 6~14 秒。这不是猜的。
        // GUI 通道换模型（2026-11-16 实测推翻旧注释：trae / workbuddy / doubao 都能切）
        //   · 触发：本轮失败/超时、还没重试过、不是 codebuddy（它走下面那条 --model 路径）
        //   · 并发保护：concurrentSame 为真时跳过（界面全局状态，会互相拆台）
        {
          const guiAgents = { workbuddy: 'workbuddy', trae: 'trae', doubao: 'doubao' };
          const guiAgent = guiAgents[agentName];
          if ((rec.status === 'fail' || rec.status === 'timeout') && fixRound === 0 && guiAgent && !concurrentSame) {
            try {
              const { nextModelFor, looksLikeQuotaError, blockModel } = await import('./models.mjs');
              const triedModels = rec.modelsTried || [];
              const curModel = rec.model || '';
              // 「超出使用次数 / 未订阅 / 无权限」是账号级限制：再点一次只是再浪费一轮 45s。
              // 先拉黑（落盘，别的 lane 立刻受益），再换下一个能用的模型。
              if (curModel && looksLikeQuotaError(rec.error)) {
                blockModel(guiAgent, curModel, String(rec.error).slice(0, 140));
                onProgress({ type: 'warn', msg: '#' + item.id + ' ' + guiAgent + ' 的 ' + curModel + ' 配额/订阅不可用，已拉黑 12 小时' });
              }
              const alt = nextModelFor(guiAgent, { current: curModel, tried: triedModels });
              if (alt) {
                onProgress({
                  type: 'warn',
                  msg: '#' + item.id + ' ' + guiAgent + ' 失败（' + String(rec.error || '').slice(0, 60) + '），同通道换模型重试：' + (curModel || '(未知)') + ' → ' + alt,
                });
                const t1 = Date.now();
                const mod = await import('../agents/' + guiAgent + '.mjs');
                const sw = typeof mod.setModel === 'function' ? await mod.setModel(alt) : { ok: false, reason: '该通道没有 setModel' };
                if (sw && sw.ok) {
                  rec.modelsTried = [...triedModels, curModel || sw.from || ''];
                  const r4 = await dispatchDeadline(prompt, {
                    agent: guiAgent,
                    summary: '[swarm ' + tag + ' #' + item.id + ' 换模型] ' + item.text.slice(0, 40),
                  });
                  const out4 = String((r4 && (r4.addedText || r4.text)) || '');
                  if (r4 && r4.ok && out4) {
                    rec.output = out4;
                    rec.status = 'done';
                    rec.error = '';
                    rec.model = alt;
                    rec.modelRetriedFrom = sw.from || curModel;
                    rec.failover = { stage: 'model', via: 'ui', from: sw.from || curModel, to: alt, tried: rec.modelsTried.slice() };
                  } else {
                    rec.error += ' | 换模型后仍无产物';
                  }
                } else {
                  rec.error += ' | GUI 换模型失败：' + String((sw && sw.reason) || '未知').slice(0, 80);
                  // 菜单是今天的真相：切不进去就把菜单带回来，从里面挑一个还能跑的。
                  if (sw && Array.isArray(sw.menu) && sw.menu.length) {
                    try {
                      const { pickFromMenu, blockModel: bm2 } = await import('./models.mjs');
                      const fromMenu = pickFromMenu(sw.menu, guiAgent);
                      if (curModel) bm2(guiAgent, curModel, '菜单里已经没有这个模型');
                      if (fromMenu && fromMenu !== alt) {
                        const sw2 = typeof mod.setModel === 'function' ? await mod.setModel(fromMenu) : { ok: false };
                        if (sw2 && sw2.ok) {
                          const r5 = await dispatchDeadline(prompt, { agent: guiAgent, summary: '[swarm ' + tag + ' #' + item.id + ' 菜单兜底] ' + item.text.slice(0, 40) });
                          const out5 = String((r5 && (r5.addedText || r5.text)) || '');
                          if (r5 && r5.ok && out5) {
                            rec.output = out5; rec.status = 'done'; rec.error = ''; rec.model = fromMenu;
                            rec.failover = { stage: 'menu', via: 'ui', from: curModel, to: fromMenu, tried: rec.modelsTried.slice() };
                            onProgress({ type: 'warn', msg: '#' + item.id + ' ' + guiAgent + ' 改用菜单里真实存在的 ' + fromMenu + '，已出产物' });
                          }
                        }
                      }
                    } catch (e6) { rec.error += ' | 菜单兜底异常：' + String((e6 && e6.message) || e6).slice(0, 60); }
                  }
                }
                rec.elapsedMs += Date.now() - t1;
              }
            } catch (e5) {
              rec.error += ' | GUI 换模型异常：' + String((e5 && e5.message) || e5).slice(0, 80);
            }
          }
        }

        if ((rec.status === 'fail' || rec.status === 'timeout') && fixRound === 0 && agentName === 'codebuddy') {
          try {
            const { nextModelFor, looksLikeQuotaError, blockModel } = await import('./models.mjs');
            const triedModels = rec.modelsTried || [];
            const curModel = rec.model || process.env.CODEBUDDY_MODEL || 'deepseek-v4.1-flash';
            if (curModel && looksLikeQuotaError(rec.error)) {
              blockModel('codebuddy', curModel, String(rec.error).slice(0, 140));
              onProgress({ type: 'warn', msg: '#' + item.id + ' codebuddy 的 ' + curModel + ' 配额/订阅不可用，已拉黑 12 小时' });
            }
            const alt = nextModelFor('codebuddy', { current: curModel, tried: triedModels });
            if (alt) {
              onProgress({
                type: 'warn',
                msg: '#' + item.id + ' ' + agentName + ' 失败（' + String(rec.error || '').slice(0, 60) + '），同通道换模型重试：' + curModel + ' → ' + alt,
              });
              const t1 = Date.now();
              rec.modelsTried = [...triedModels, curModel];
              try {
                const r3 = await dispatchDeadline(prompt, {
                  agent: agentName,
                  model: alt,
                  summary: '[swarm ' + tag + ' #' + item.id + ' 换模型] ' + item.text.slice(0, 40),
                });
                const out3 = String((r3 && (r3.addedText || r3.text)) || '');
                if (r3 && r3.ok && out3) {
                  rec.output = out3;
                  rec.status = 'done';
                  rec.error = '';
                  rec.model = alt;
                  rec.modelRetriedFrom = curModel;
                  // failover 与 size 分开存（rank1 的建议，我同意）：
                  //   size     = 「这次想花多少」，派活前定，写 task.json
                  //   failover = 「这条今天不通，换了一条」，失败后发生，只进流水
                  // 塞成一个字段，用户永远分不清「便宜是因为档位」还是「便宜是因为降级」。
                  rec.failover = { stage: 'model', from: curModel, to: alt, tried: rec.modelsTried.slice() };
                }
              } catch (e3) {
                rec.error += ' | 换模型失败：' + String((e3 && e3.message) || e3).slice(0, 120);
              }
              rec.elapsedMs += Date.now() - t1;
            }
          } catch { /* 换模型是优化，不是前置条件：表读不到就继续走换通道那条老路 */ }
        }

        // 换路只在第一轮做：回喂的时候 prompt 已经变了，换路会丢掉「上次错在哪」这个上下文。
        // timeout 也必须能换路：通道吐了半截就断了，正是该换一个人的时候。
        // 上面刚把「有部分产出」的失败标成 timeout，如果这里只认 fail，
        // 那就变成「吐了半截反而不换路」，比直接失败更糟。
        if ((rec.status === 'fail' || rec.status === 'timeout') && retrySwitch && retrySwitch !== agentName && fixRound === 0) {
          onProgress({ type: 'retry', id: item.id, from: agentName, to: retrySwitch, error: rec.error });
          const t1 = Date.now();
          try {
            const r2 = await dispatchDeadline(prompt, {
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
          const plan = planLanding([rec], { minBytes: opts.minBytes, laneSuffix: !!opts.laneSuffix });
          const one = plan[0] || {};
          // action 必须一起判。2026-11-15 实测：codebuddy 因 max-turns=1 返回 21 字符
          // "Max turns (1) exceeded"，land 判它「内容太短」给了 skip，但这里只看 target+content
          // 非空，于是照样拿去跑 node --check，报出来的错像是产物质量问题，
          // 实际是通道根本没交东西。skip 一律走 else 分支，如实报「内容太短」。
          if (one.target && one.content && one.action !== 'skip') {
            // 落盘会覆盖旧版本。先把旧的存一份，落盘之后才能对拍「行为有没有变」——
            // 改一个已通过验收的模块时，AI 最容易悄悄改坏原有行为，而形状/语法/行数全过。
            // 声明必须在 if (opts.land) 之外：对拍段在落盘段之后，同层作用域才看得见。
            let prevBackup = null;
            if (opts.land) {
              if (item.behave) {   // 已在 opts.land 分支内，不必再判一次
              // 先看派活前的预备份（更早、更可信）；没有才现做一份。
              const _pk = String(item.id) + (item.lane ? '.' + item.lane : '');
              if (preBackups && preBackups.has(_pk)) prevBackup = preBackups.get(_pk);
              const absOld = path.resolve(process.cwd(), one.target);
              if (!prevBackup && fs.existsSync(absOld)) {   // 预备份优先，别用落盘前的快照覆盖它
                try {
                  const bakDir = path.join(dir || '.swarm', 'prev');
                  fs.mkdirSync(bakDir, { recursive: true });
                  // 备份文件必须保留原扩展名（.prev 结尾 Node 会拒绝 import：Unknown file extension ".prev"）
                  const _ext = path.extname(one.target);
                  const _stem = path.basename(one.target, _ext);
                  prevBackup = path.join(bakDir, _stem + '.prev.' + item.id + (item.lane ? '.' + item.lane : '') + _ext);
                  fs.copyFileSync(absOld, prevBackup);
                } catch { prevBackup = null; }
              }
            }
              const applied = applyLanding([one], { force: !!opts.force });
              const a = applied[0] || {};
              rec.land = { target: one.target, result: a.result, bytes: one.bytes };
              if (a.result === 'written' || a.result === 'need-force') rec.landPath = one.target;
            }
            // item.contract 是可选的接口契约（{ exports: [{ name, params }] }）。
            // 有它才验参数个数和参数名；没有就只走原有那三层（结构/语法/导出名）。
            // 不猜、不自动生成 —— 契约写错比不写更糟，必须由派活的人显式给。
            const vres = verifyContent(one.target, one.content, item.text, {
              mode: opts.deep ? 'deep' : 'normal',
              spec: item.contract || null,
              behave: item.behave || null,
            });
            rec.verify = { target: one.target, ok: vres.ok, checks: vres.checks };
            // 回归对拍：落盘前备份过旧版本，就拿它当乙跑同一组用例。
            // 这一步抓的是「改动一个已通过验收的模块，形状/语法/行数全过，但行为悄悄变了」——
            // 行为层要人给期望值（判对错），对拍只要旧版本（判有没有变），两者互补。
            // 默认只报不判失败（改行为可能是本意），--strict-regress 才升级成一票否决。
            if (prevBackup && item.behave) {
              const creg = runCompareCheck(one.target, prevBackup, item.behave);
              applyRegress(rec, { ...creg, against: prevBackup }, !!opts.strictRegress);
              if (!creg.ok) onProgress({ type: 'regress', id: item.id, target: one.target, detail: creg.detail });
            }
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
            // AI 用文件工具直接写盘时，内容不进回答通道 → planLanding 判「内容太短」→
            // 落盘 0/验收 0/评审不跑，而磁盘上躺着完整产物。先查一次磁盘，再判失败。
            const selfDone = selfLanded(one.target, t0, { minBytes: opts.minBytes });
            if (selfDone) {
              let stxt = '';
              try { stxt = fs.readFileSync(path.resolve(process.cwd(), selfDone.path), 'utf8'); } catch { }
              const sv = verifyContent(selfDone.path, stxt, item.text, {
                mode: opts.deep ? 'deep' : 'normal',
                spec: item.contract || null,
                behave: item.behave || null,
              });
              rec.land = { target: selfDone.path, result: 'self-written', bytes: selfDone.size };
              rec.landPath = selfDone.path;
              rec.selfWritten = true;
              rec.verify = { target: selfDone.path, ok: sv.ok, checks: sv.checks };
              onProgress({ type: 'self-land', id: item.id, target: selfDone.path, bytes: selfDone.size, ok: sv.ok });
              if (!sv.ok) onProgress({ type: 'verify-fail', id: item.id, target: selfDone.path, checks: sv.checks.filter((c) => !c.ok) });
              break;
            }
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

  // --agent all / 逗号串 = 同题多写：一个任务展开成 N 条 lane，各走一条通道。
  // 每条 lane 带 laneSuffix，落盘时自动分叉成 lib/x.trae.mjs / lib/x.doubao.mjs，
  // 否则后到的会被 need-force 拒绝覆盖（实测豆包 150 秒的产物就这么没了）。
  const explicitLanes = (() => {
    const m = String(mode || '').toLowerCase().trim();
    if (m === 'all' || m === '四路' || m === 'everyone') return [...ALL_AGENTS];
    if (m.includes(',')) {
      const l = m.split(',').map((s) => s.trim()).filter((s) => ALL_AGENTS.includes(s));
      if (l.length) return [...new Set(l)];
    }
    return null;
  })();

  const todo = [];
  const skipped = [];
  for (const t of tasks) {
    const hit = prev.get(t.id);
    if (hit && hit.status === 'done') { skipped.push(hit); continue; }
    if (explicitLanes) {
      for (const ag of explicitLanes) {
        todo.push({ ...t, agent: ag, lane: ag, laneSuffix: ag });
      }
    } else {
      todo.push({ ...t, agent: routeTask(t.text, mode) });
    }
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
      // 对拍升级开关（一票否决）也要透传，否则 --strict-regress 到 runPool 就没了
      strictRegress: !!opts.strictRegress,
      // 同题多写时每条通道写自己的分叉路径（lib/x.trae.mjs / lib/x.doubao.mjs），
      // 否则先到的占住主路径，后到的一律 need-force 丢掉。
      laneSuffix: !!explicitLanes,
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
