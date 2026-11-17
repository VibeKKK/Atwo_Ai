#!/usr/bin/env node
// Orchestra —— DSH 与其他 AI 之间的派活、互审、共享记忆通道
//
//   node orchestra.mjs ask <agent> "<prompt>"     派任务（自动带上共享工作记忆）
//   node orchestra.mjs review <agent> <file>      让别的 AI 审你的文件，评审自动存档
//   node orchestra.mjs peek <agent>               看它当前页面文本
//   node orchestra.mjs list                       有哪些 agent
//   node orchestra.mjs memory show                看共享工作记忆
//   node orchestra.mjs memory log [n]             看最近 n 次派活流水
//   node orchestra.mjs memory set-key <k> <v>     手动补一条「已确认的事实」
//
// 用法示例：
//   node orchestra.mjs review trae agents/trae.mjs
//   node orchestra.mjs ask trae "把 renderer.js 里的 fetch 换成 http.request"
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { askTrae, askTraeFile, peekTrae, snapshotTrae, meta as traeMeta } from './agents/trae.mjs';
import { askCodeBuddy, peekCodeBuddy, meta as cbMeta } from './agents/codebuddy.mjs';
import { ask as askWorkBuddy, askFile as askWbFile, doctor as wbDoctor, META as wbMeta } from './agents/workbuddy.mjs';
import { askDoubao, doubaoDoctor, doubaoMeta } from './agents/doubao.mjs';
import { readState, writeState, appendLog, readLog, setLastJob, buildContext } from './lib/memory.mjs';
import { brief as projectBrief } from './lib/project-memory.mjs';
import { JSON_CONTRACT, PROSE_CONTRACT, parseContract, renderContract, fallbackCode, isCodeTask } from './lib/contract.mjs';
import { withLock, withLockPool, withTimeout, listLocks } from './lib/lock.mjs';
import { checkSyntax } from './lib/syntax.mjs';
import { get as cacheGet, put as cachePut, stats as cacheStats, clear as cacheClear } from './lib/cache.mjs';
import { preflightTrae } from './lib/preflight.mjs';
import { check as budgetCheck, record as budgetRecord, report as budgetReport, usedToday } from './lib/budget.mjs';
import { start as prStart, finish as prFinish, reject as prReject } from './pr.mjs';
import { loadTasks, buildBatchPrompt, splitResults } from './lib/batch.mjs';
import { runSwarm, runSwarmWaves, loadSwarmTasks, parseSlots, renderReport, fmtMs, routeTask, listRuns, DEFAULT_SLOTS } from './lib/swarm.mjs';
import { DECOMPOSE_CONTRACT, parseSubtasks, singleTask, buildBrief, briefDir, writeBrief, digest, renderDigest } from './lib/subagent.mjs';
import { assemble, renderReport as renderBudget } from './lib/prompt.mjs';
import { add as ephAdd, list as ephList, remove as ephRemove, clear as ephClear, gc as ephGc, briefBlock as ephBrief, readSkill as ephReadSkill, stats as ephStats, KINDS as EPH_KINDS } from './lib/ephemeral.mjs';
// 会话回收：每派一次活，Trae / 豆包 / WorkBuddy 的「最近」都会多一条，跑一天就全是垃圾。
// 这里在命令收尾时按「派活前的基线」把新增的清掉：WorkBuddy 真删，豆包用归档（它没有网页删除入口）。
import { snapshotBaseline, gcAll } from './lib/session_gc.mjs';
import { pickReviewer, pickReviewers, parseVerdict, buildReviewPrompt, buildFixPrompt, reviewAndFix, reviewWithFallback, reviewMultiWithFallback } from './lib/review.mjs';
import { humanVerdict, humanIssues, humanReason } from './lib/humanize.mjs';
import { LANE_DEFS } from './lib/lanes.mjs';

/**
 * 派活结束后回收新增会话。失败一律吞掉并打一行日志 ——
 * 清理是卫生工作，不能因为客户端没开就把整批任务判成失败。
 */
async function gcAfterRun(base) {
  if (!base) return null;
  try {
    const r = await gcAll(base);
    const wbN = r.workbuddy ? r.workbuddy.done.filter((x) => x.ok).length : 0;
    const dbN = r.doubao ? r.doubao.done.filter((x) => x.ok).length : 0;
    const bad = [...(r.workbuddy?.done || []), ...(r.doubao?.done || [])].filter((x) => !x.ok);
    if (wbN || dbN) console.error('[回收] 清掉本次派活新增会话：WorkBuddy ' + wbN + ' 条、豆包 ' + dbN + ' 条');
    for (const b of bad) console.error('[回收] 未清掉「' + b.title + '」：' + b.reason);
    for (const e of r.errors || []) console.error('[回收] ' + e);
    return r;
  } catch (e) {
    console.error('[回收] 跳过：' + (e && e.message ? e.message : e));
    return null;
  }
}

const TASK_TIMEOUT_MS = Number(process.env.ORCH_TIMEOUT_MS || 240000);

// 按通道设超时。成因：2026-11-15 实测 codebuddy 写 lib/par_num3.mjs（178 行）
// 真实耗时 425.5 秒、一次成功 —— 而全局一刀切 240 秒正好切在它干到一半的位置，
// 于是「codebuddy 总超时」被误读成「codebuddy 不行」，其实是上限设错。
// 依据 memory/log.jsonl 的 p50/p90：trae 14.6s/53.9s、doubao 17.6s、
// workbuddy 49.3s（实测长任务 234~274s）、codebuddy 69.5s/300s（实测 425s）。
// 显式设 ORCH_TIMEOUT_MS 时统一覆盖，保持手动控制权。
const EXPLICIT_TIMEOUT_MS = process.env.ORCH_TIMEOUT_MS ? Number(process.env.ORCH_TIMEOUT_MS) : null;
const AGENT_TIMEOUT_MS = {
  trae: Number(process.env.ORCH_TIMEOUT_TRAE || 120000),
  doubao: Number(process.env.ORCH_TIMEOUT_DOUBAO || 120000),
  workbuddy: Number(process.env.ORCH_TIMEOUT_WORKBUDDY || 300000),
  // 2026-11-15 晚：codebuddy 默认模型从 hy4free 换成 deepseek-v4.1-flash 后，
  // 同一任务 425s → 14s。480s 是「它真的很慢」时期的余量，现在只会让四路并行的
  // 墙钟被它单独拖住（并行 = max），降到 180s。
  codebuddy: Number(process.env.ORCH_TIMEOUT_CODEBUDDY || 180000),
};
function timeoutFor(agentName) {
  if (EXPLICIT_TIMEOUT_MS) return EXPLICIT_TIMEOUT_MS;
  return AGENT_TIMEOUT_MS[agentName] || TASK_TIMEOUT_MS;
}
const EST_INPUT = { codebuddy: 24848, trae: 0 };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = {
  trae: { ask: askTrae, peek: peekTrae, meta: traeMeta },
  codebuddy: { ask: askCodeBuddy, peek: peekCodeBuddy, meta: cbMeta },
  workbuddy: { ask: askWorkBuddy, peek: null, meta: wbMeta, doctor: wbDoctor },
  // doubao：文件信箱通道，经实测字符零损伤（22.8s，反引号/双星号/井号全保留）
  doubao: { ask: askDoubao, peek: null, meta: doubaoMeta, doctor: doubaoDoctor },
};

// ---- 自动选 agent（实测依据见 SHARED.md §10）----
// codebuddy：出代码可直接落盘（py_compile + 真值比对全过）
// trae：自然语言/评审质量高，但出代码必须要求 ``` 围栏，否则缩进在 DOM 层丢失
const CODE_HINTS = /(写一个|写个|写一段|实现|编写|生成代码|重构|重写|改一下|修改代码|修复|报错|异常|堆栈|traceback|函数|方法|类|脚本|正则|SQL|接口|API|钩子|单元测试|用例|代码|code|function|class|script|bug|debug|patch|refactor|schema|parser)/i;
const PROSE_HINTS = /(评审|审一下|审视|挑错|找问题|有什么问题|意见|建议|解释|为什么|原因|分析|对比|比较|优缺点|取舍|总结|概括|归纳|文案|命名|翻译|润色|怎么理解|review|explain|why|compare|summar|critique)/i;

/**
 * 按任务性质挑 agent。两者都命中时**代码优先**——
 * 因为让 codebuddy 写代码的返工率明显低（它出的码能直接跑）。
 * @returns {{name:string, why:string}}
 */
function pickAgent(prompt) {
  const p = String(prompt || '');
  const code = CODE_HINTS.test(p);
  const prose = PROSE_HINTS.test(p);
  if (code && !prose) return { name: 'codebuddy', why: '偏写代码' };
  if (code && prose) return { name: 'codebuddy', why: '代码+评审混合，代码优先（出码可直接用）' };
  // 自然语言默认走 workbuddy：同为 ~22s，但没有 trae 那种「回合数一多就失灵」的衰减。
  // trae 仍可显式指定（ask trae），也作为 workbuddy 没开时的回退。
  return { name: 'workbuddy', why: prose ? '偏评审/解释' : '默认走自然语言' };
}

/** trae 出代码必须带围栏，否则它渲染成单段落、缩进丢失。这里自动补一句。 */
function ensureFenceHint(name, prompt) {
  if (name !== 'trae') return prompt;
  const p = String(prompt || '');
  if (!CODE_HINTS.test(p)) return p;
  if (p.includes('```')) return p;
  return p + '\n\n（要求：用 markdown 代码块 ``` 输出代码，缩进必须是 4 个空格，不要行号。）';
}

const [cmd, who0, ...rest] = process.argv.slice(2);
// 第一个词不是已知 agent 名时，把它当成 prompt 的一部分，改走自动选路。
let who = who0;

// 启动即清理过期临时能力（会话结束/超时的自动消失）
const STARTUP_GC = (() => { try { return ephGc(); } catch { return 0; } })();   // 启动即清过期

function usage() {
  console.log(`Orchestra — AI 协作台
  do "<一句话目标>"           一句话入口：替你判断该派一件还是拆开并行
                             --n 4           并行度（默认按目标里的数字取）
                             --agent trae    强制指定通道
                             --dry           只打印判断和将要执行的命令，不真跑
  ask <agent> "<prompt>"     派任务（自动附带共享工作记忆）
  ask auto "<prompt>"        按任务性质自动挑 agent（代码→codebuddy，评审/解释→trae）
  auto "<prompt>"            同上，更短的写法
  review <file> [--by <评审者>] [--author <产出者>]
                             纠错 AI：找错不夸，最后必须给 VERDICT: ACCEPT|REVISE
                             默认自动选**异源**评审者（评审者 ≠ 产出者），同一通道自审会被拒
  duo <agentA> <agentB> "p"  同题并行派给两个 agent，对比耗时与产出
  batch <agent> <任务源>      N 个小任务压进一次调用（省掉 N-1 份固定开销）
                             任务源：tasks.md 文件 / "甲|||乙|||丙" / - 开头的行
  gc [--dry] [--all]         清掉派活留下的会话垃圾（WorkBuddy 真删 / 豆包归档）
                              --dry 只列不删；--all 清全部（跳过当前选中的），默认只清派活痕迹
  top [n]                     吞吐看板：每批的墙钟 vs 串行，并行到底省了多少
  swarm <任务源> [--flags]    N 个独立任务跨 agent 并行跑（吞吐最高的一档）
  sub "<目标>" [--n 3]        把目标拆成子任务，各自独立执行，只回摘要（子 agent）
                             --agent auto|trae|codebuddy   指定/自动分配
                             --slots trae=1,codebuddy=6    各路并发数
                             --out report.md               报告落到文件
                             --resume                      接着上次没跑完的
                             --no-switch                   失败不换路重试
                             --land                        把产物写进磁盘（隐含 --verify）
                             --verify                      程序化验收：语法/规模/契约/导出名
                             --review                      跑完派给异源评审者挑错（看「话说得对不对」）
                             --max-fix N                   REVISE 时自动回流返工 N 轮
                             --strict-regress              改已有文件时，行为与旧版本不一致即判失败（默认只报告）
  stats                      效率看板：次数/成功率/均耗时/均字符/token/成本
  budget                     今天的额度账（调用次数 / token / 剩余）
  health                     谁活着、谁占着锁、还剩多少额度
  peek <agent>               看它当前页面文本
  list                       列出可用 agent
  memory show                打印共享工作记忆
  memory log [n]             最近 n 条派活流水（默认 20）
  memory set-key <k> <v>     往「已确认的事实」里加一条
agents: ${Object.keys(REGISTRY).join(', ')}

环境变量：
  ORCH_PROJECT=<项目名>      派活时附带该项目的接续状态（下一步/卡住）
                             项目用 resume.mjs init 注册，resume.mjs list 查看
                             例：ORCH_PROJECT=快捷桌面 node orchestra.mjs ask trae "..."`);
}

const nowStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

if (!cmd || cmd === 'help' || cmd === '--help') { usage(); process.exit(0); }

if (cmd === 'list') {
  // 2026-11-14：--json 便于别的 agent 直接消费（不用正则解析中文表格）
  if (process.argv.includes('--json')) {
    const rows = Object.entries(REGISTRY).map(([k, v]) => ({
      name: k, kind: v.meta.kind, transport: v.meta.transport || '?', port: v.meta.port ?? '?',
      strengths: v.meta.strengths || [], note: v.meta.note || null,
    }));
    console.log(JSON.stringify({ ok: true, count: rows.length, agents: rows }, null, 2));
    process.exit(0);
  }
  for (const [k, v] of Object.entries(REGISTRY)) {
    // 兜底：新加通道只写了 kind/port 时，list 不能整条崩掉（doubao 就这么崩的）。
    const m = v.meta || {};
    console.log(`${k}\t${m.kind || '?'}\t${(m.transport || '?')}:${m.port ?? '?'}\t${(m.strengths || []).join(' / ')}`);
  }
  process.exit(0);
}

// ---- memory 子命令：不需要 agent ----
if (cmd === 'memory') {
  const sub = who;
  if (!sub || sub === 'show') { console.log(readState()); process.exit(0); }
  if (sub === 'log') {
    const n = Number(rest[0] || 20);
    for (const e of readLog(n)) console.log(JSON.stringify(e));
    process.exit(0);
  }
  if (sub === 'set-key') {
    const k = rest[0], v = rest.slice(1).join(' ');
    if (!k || !v) { console.error('用法: memory set-key <键> <值>'); process.exit(2); }
    let s = readState();
    const line = `- ${k}：${v}`;
    if (s.includes('## 已确认的事实')) {
      s = s.replace(/## 已确认的事实\n([\s\S]*?)(\n## )/, (m, body, next) => `## 已确认的事实\n${body.replace(/\s+$/, '')}\n${line}${next}`);
    } else {
      s += `\n## 已确认的事实\n${line}\n`;
    }
    writeState(s);
    console.log('已记入共享记忆：' + line);
    process.exit(0);
  }
  console.error('未知 memory 子命令: ' + sub); usage(); process.exit(2);
}

  // ---- pr：把 agent 改动当提案管（代理到 pr.mjs，避免两套实现漂移）----
  if (cmd === 'pr') {
    const { spawnSync } = await import('node:child_process');
    // 注意：这里的参数不能复用顶部的 [cmd, who, ...rest]，因为 pr 的第二个词
    // 是动作（list/approve/…），会被当成 agent 名解析掉。
    const prArgs = process.argv.slice(3);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'pr.mjs'), ...prArgs], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    process.exit(r.status == null ? 1 : r.status);
  }

  // ---- budget：今天的额度账（按 agent / 按天）----
  if (cmd === 'budget') {
    const rep = budgetReport();
    if (process.argv.includes('--json')) { console.log(JSON.stringify({ ok: true, ...rep }, null, 2)); process.exit(0); }
    console.log('日期 ' + rep.date);
    console.log('agent	调用	失败	in tok	out tok	剩次数	剩token');
    for (const row of rep.rows) {
      console.log([row.agent, row.calls, row.fails, row.input, row.output, row.leftCalls, row.leftTokens].join('	'));
    }
    process.exit(0);
  }

  // ---- health：谁活着、谁占着锁、还剩多少额度 ----
  if (cmd === 'health') {
    const portOpen = (port, ms = 900) => new Promise((res) => {
      const sk = net.connect({ host: '127.0.0.1', port });
      const done = (v) => { try { sk.destroy(); } catch {} res(v); };
      sk.setTimeout(ms);
      sk.once('connect', () => done(true));
      sk.once('timeout', () => done(false));
      sk.once('error', () => done(false));
    });
    const traeUp = await portOpen(9223);
    const cbCli = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Tools', 'codebuddy-cli', 'package', 'bin', 'codebuddy');
    const cbOk = fs.existsSync(cbCli) || fs.existsSync(cbCli + '.cmd') || fs.existsSync(cbCli + '.cmd');
    const locks = listLocks();
    const healthRows = [];
    for (const name of Object.keys(REGISTRY)) {
      const u = usedToday(name);
      const g = budgetCheck(name, 0);
      const lock = locks.find((l) => l.name === name);
      healthRows.push({ agent: name, channel: name === 'trae' ? (traeUp ? 'ok' : 'DOWN') : (cbOk ? 'ok' : 'DOWN'),
        lock: lock ? 'BUSY(pid ' + lock.pid + ')' : 'idle', usedCalls: u.calls, leftCalls: g.left ? g.left.calls : null });
    }
    const lastRun = readLog(1)[0];
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: true, at: new Date().toISOString(), agents: healthRows,
        lastRun: lastRun ? { agent: lastRun.agent, ok: !!lastRun.ok, seconds: Math.round((lastRun.elapsedMs || 0) / 1000), contract: lastRun.contract || null } : null }, null, 2));
      process.exit(0);
    }
    console.log('agent	通道	活着	今天已用	剩次数');
    for (const name of Object.keys(REGISTRY)) {
      const up = name === 'trae' ? traeUp : cbOk;
      const u = usedToday(name);
      const g = budgetCheck(name, 0);
      const lock = locks.find((l) => l.name === name);
      console.log([name, up ? 'ok' : 'DOWN', lock ? 'BUSY(pid ' + lock.pid + ')' : 'idle', u.calls + ' 次', g.left ? g.left.calls : '?'].join('	'));
    }
    const last = readLog(1)[0];
    if (last) console.log('最近一次：' + last.agent + ' ' + (last.ok ? 'ok' : 'FAIL') + ' ' + Math.round((last.elapsedMs || 0) / 1000) + 's' + (last.contract ? ' 契约=' + last.contract : ''));
    process.exit(0);
  }

// 不需要 agent 的命令。漏登记的症状：`orchestra.mjs gc`（不带参数）会被当成「未知 agent」
// 直接 usage + exit 2，而 `gc --dry` 反而能跑 —— 因为后者凑巧把 --dry 当成了 agent 名。
//
// 2026-11-17 实录（这条注释是给下一次漏登记的人看的）：
//   `orchestra.mjs review <file>` 漏登记 'review' → who 变成了文件路径
//   → needsAgent 为真 → 走自动选路 → 最终 `未知 agent: D:/tmp/xx.md` exit 2。
//   症状不是「评审报错」，而是**每一次 4 路派活的评审阶段都判 failed**，
//   产物其实是好的，红的是评审这一环 —— 查了半天才发现是白名单少一个词。
// 判据：凡是「第一个位置参数不是通道名」的动词都必须登记在这里。
const NO_AGENT_CMDS = ['eph','ctx','duo','stats','auto','pick','doctor','probe','budget','health','list','swarm','sub','top','do','gc','review'];
const needsAgent = !NO_AGENT_CMDS.includes(cmd);
// 不需要 agent 的动词：第一个位置参数在解析时被吃进 who，必须原样还给 rest，
// 否则 `review <file>` 之类的命令会在处理块里看到空参数、直接打用法退出。
// 只还不以 '-' 开头的（`gc --dry` 这种 flags-first 的调法保持原样，别把选项名塞两遍）。
if (!needsAgent && who !== undefined && who !== null && !String(who).startsWith('-')) rest.unshift(who);
// 第一个词既不是已知 agent 也不是 auto → 它是 prompt 的开头，改走自动选路。
if (needsAgent && who && who !== 'auto' && !REGISTRY[who]) { rest.unshift(who); who = 'auto'; }
let agent = REGISTRY[who];
let effectiveWho = who;
let autoWhy = '';
if (needsAgent && who === 'auto') {
  const p = rest.join(' ');
  const pick = pickAgent(p);
  // workbuddy 是 CDP 系：应用没开这条选路等于空转，探一下再定，探不到退回 trae。
  if (pick.name === 'workbuddy') {
    const up = await new Promise((res) => {
      const s = net.connect(Number(process.env.WB_PORT || 9224), '127.0.0.1');
      const d = (v) => { s.destroy(); res(v); };
      s.setTimeout(700, () => d(false));
      s.on('connect', () => d(true));
      s.on('error', () => d(false));
    });
    if (!up) { pick.name = 'trae'; pick.why = 'workbuddy 未就绪（9224 未监听），退回 trae'; }
  }
  agent = REGISTRY[pick.name];
  effectiveWho = pick.name;
  autoWhy = pick.why;
  console.log(`[auto] → ${pick.name}（${pick.why}）`);
}
if (needsAgent && !agent) { console.error('未知 agent: ' + who); usage(); process.exit(2); }

const REVIEW_PROMPT = (file, content) => `你是评审员。下面是 DSH（另一个 AI 助手）产出的内容，文件是 ${file}。
任务：找错，而不是夸。重点看——事实错误、逻辑漏洞、漏掉的边界情况、不可能的假设、可以更简单的写法。
要求：
1. 每条问题写清楚「在哪」「错在哪」「应该怎么改」，不要笼统。
2. 没问题就明确说「没发现实质问题」，不要凑数。
3. 最后给一行结论：ACCEPT 或 REVISE（+ 一句话理由）。

===== 文件内容开始 =====
${content}
===== 文件内容结束 =====`;

/** 派活统一入口：注入记忆 → 调 agent → 记账
 *  项目接续：设了环境变量 ORCH_PROJECT 就把该项目的「下一步/卡住」一并发过去，
 *  这样对面的 AI 不用问「这个项目到哪了」。 */
async function dispatch(kindLabel, rawPrompt, extra = {}) {
  const name = extra.agent || effectiveWho;
  const ag = REGISTRY[name];
  if (!ag) throw new Error('未知 agent: ' + name);
  const project = process.env.ORCH_PROJECT;
  const memTail = buildContext();
  let projectSlim = '';
  if (project) {
    try {
      const b = projectBrief(project, { slim: true });
      if (b && !b.missing && b.slim) projectSlim = `[项目接续 · ${b.name}]\n${b.slim}\n[/项目接续]`;
    } catch { /* 项目没注册就静默跳过，不挡派活 */ }
  }

  // 契约：代码活用 code 契约、其余用 answer 契约。散文也要 —— 否则 Trae 的页面 diff
  // 会把「@ 添加上下文」「完全访问」这类 UI 文案算进回答（实测污染过一次）。
  const codeTask = isCodeTask(rawPrompt);
  // workbuddy 是散文型（不主动给 JSON），默认不套契约；ORCH_WB_CONTRACT=1 可强制
  const wantContract = extra.contract ?? (process.env.ORCH_NO_CONTRACT !== '1' && (name !== 'workbuddy' || process.env.ORCH_WB_CONTRACT === '1'));

  // 临时能力（ephemeral）：只把「有什么」压成一段注入，全文按需读 ——
  // 这样能力本身不占常驻上下文，会话结束自动失效。
  let ephBlk = '';
  if (process.env.ORCH_NO_EPHEMERAL !== '1') {
    try { ephBlk = ephBrief() || ''; } catch { /* 读不到就当没有 */ }
  }

  let skillBlk = '';
  if (extra.skill) {
    try {
      const s = ephReadSkill(extra.skill, { maxChars: Number(process.env.ORCH_SKILL_CHARS || 3000) });
      if (s.ok) skillBlk = `[技能正文 · ${extra.skill}${s.truncated ? ' · 已截断' : ''}]\n${s.text}\n[/技能正文]`;
      else console.error('[临时能力] ' + s.reason);
    } catch { /* 技能读失败不挡派活 */ }
  }

  // 结构化组装 + 注意力预算记账（见 lib/prompt.mjs 顶部注释）
  const asm = assemble({
    task: ensureFenceHint(name, rawPrompt),
    memory: memTail,
    project: projectSlim,
    ephemeral: ephBlk,
    skill: skillBlk,
    contract: wantContract ? (codeTask ? JSON_CONTRACT : PROSE_CONTRACT) : '',
  });
  const prompt = asm.prompt;
  if (asm.overBudget && process.env.ORCH_QUIET_BUDGET !== '1') {
    console.error('[上下文] 有分区超预算：' + asm.report.filter((r) => r.over).map((r) => r.section).join(','));
  }
  if (extra.dry) return { dry: true, ok: true, prompt, agent: name, codeTask, wantContract, budget: asm.report, totalTokens: asm.totalTokens };


  // 结果缓存（C②）：同 agent + 同 prompt 直接复用，不再付第二次钱。
  // 只查「成功输出」；命中后仍走同样的渲染与语法校验路径（语法再验一次很便宜）。
  // 缓存键用「原始问题」而不是拼装后的 prompt —— 团队记忆注入每次都变，
  // 用拼装后的 key 会导致永远未命中（实测过：同一问题第二次仍然真跑）。
  const cacheKeyPrompt = rawPrompt.trim() + '|' + (wantContract ? 'C' : 'R');
  const cachedHit = cacheGet(name, cacheKeyPrompt);
  if (cachedHit && !extra.noCache) {
    console.error('[缓存] 命中 ' + name + ' sha=' + cacheKeyPrompt.length + 'B → 0 token');
    const r0 = { ok: true, addedText: cachedHit.addedText, usage: { in: 0, out: 0 }, cached: true };
    const c0 = wantContract ? parseContract(cachedHit.addedText) : null;
    const s0 = c0 && c0.ok ? checkSyntax(c0.data.code || c0.data.answer, c0.data.lang || c0.data.language) : { ok: true, lang: 'skip', error: '' };
    appendLog({
      agent: name, kind: kindLabel,
      promptSummary: (extra.summary || rawPrompt).replace(/s+/g, ' ').slice(0, 120),
      elapsedMs: 0, ok: true, outputChars: (r0.addedText || '').length,
      error: '', usage: { in: 0, out: 0 }, cached: true,
      contract: c0 ? (c0.ok ? 'ok' : c0.reason) : 'skipped',
      syntax: s0 && !s0.ok ? (s0.lang + ':' + String(s0.error || '').split(String.fromCharCode(10))[0]).slice(0, 120) : 'ok',
    });
    return r0;
  }
  // 闸门：先问预算，超了直接拒，别浪费一次调用
  const gate = budgetCheck(name, EST_INPUT[name] || 0);
  if (!gate.ok) {
    const e = new Error(gate.reason);
    e.code = 'EBUDGET';
    throw e;
  }

  // 前置体检（A）：界面结构变了要立刻断得响亮，而不是让调用方等 4 分钟超时。
  // 只对走 GUI 的 trae 做；结果缓存 60 秒，同一批任务只体检一次。
  // 开关：ORCH_NO_PREFLIGHT=1 可跳过（排查用）。
  if (name === 'trae' && process.env.ORCH_NO_PREFLIGHT !== '1') {
    const pf = await preflightTrae();
    if (!pf.ok) {
      const e = new Error('[体检] ' + pf.reason);
      e.code = 'EUI_CHANGED';
      e.checks = pf.checks;
      throw e;
    }
  }

  const t0 = Date.now();
  let r = null, err = null, contract = null, retried = false, syntaxReport = null;

  // PR 模式（ORCH_PR=1）：每次派活开一个提案分支，干完形成 ready 提案。
  // 主干永远不受 agent 直接改动 —— 这就是「改动可回退」的全部意义。
  // 默认关闭，因为 PR 需要干净工作区；调用方显式打开才接管分支。
  const usePR = process.env.ORCH_PR === '1';
  let pr = null;
  if (usePR) {
    try {
      pr = prStart(extra.prTitle || rawPrompt.replace(/\s+/g, ' ').slice(0, 60));
      console.error(`[PR] 开提案 ${pr.id}  分支 ${pr.branch}`);
    } catch (e) {
      console.error(`[PR] 开提案失败，退回普通模式：${e.message}`);
    }
  }

  // 锁池：trae 恒为 1 路（只有一个 Agent 页面，并发会互相污染回答）；
  // codebuddy 是独立 CLI 进程，可以开多路，否则等于自废吞吐。
  const slots = Number(process.env['ORCH_SLOTS_' + name] || (name === 'codebuddy' ? 6 : 1)) || 1;
  // 信箱通道：DOM 抓取必丢语法字符（实测反引号全丢、## 变 h2 后消失、成对星号非对称损伤），
  // 给每条通道各写一套还原补丁等于永久打地鼠。所以代码类任务默认走文件信箱——产物由对方
  // 直接写盘，字节零损伤。散文类仍走直连（丢个别字符影响小，但省一轮写出+轮询）。
  const MAILBOX_ASK = { trae: askTraeFile, workbuddy: askWbFile };
  const runOnce = (p) => withLockPool(name, slots, () => withTimeout(
    async () => {
      const mb = MAILBOX_ASK[name];
      if (mb && codeTask && extra.mailbox !== false) {
        try {
          const fr = await mb(p, {});
          const txt = fr.text || fr.raw || fr.answer || '';
          if (String(txt).trim()) {
            console.error('[信箱] ' + name + ' 写盘回来 ' + String(txt).length + ' 字符（无损）');
            return { ok: true, addedText: String(txt), usage: { in: 0, out: 0 }, viaMailbox: true };
          }
        } catch (e) {
          console.error('[信箱] ' + name + ' 失败，退回直连：' + String((e && e.message) || e).slice(0, 90));
        }
      }
      // model 透传：故障换模型重试时由上层指定「这一条用哪个模型」。
      // 只有 codebuddy 认这个（--model / CODEBUDDY_MODEL）；workbuddy 的模型是界面状态，
      // trae / doubao 根本换不了 —— 不认的通道拿到它会忽略，不会报错。
      return ag.ask(p, { timeoutMs: timeoutFor(name), model: extra.model });
    },
    timeoutFor(name) + 20000, name
  ), {
    onWait: (n) => console.error(`[队列] ${name} 的 ${n} 路都占满，排队等待…`),
  });

  const t0Dispatch = Date.now();
  try {
    r = await runOnce(prompt);
  } catch (e) {
    err = e;
    r = e.partial || null;
    // 超时不等于失败。实测 workbuddy 已经把产物写进磁盘、只是没及时回话，
    // 等满 260s 超时后却被记成失败 —— 账是错的，而且会触发不必要的重派。
    // 判据回到产物本身：任务里点名了绝对路径，而那个文件在本次派活之后被改写过，就算完成。
    // （嘴上的回答不算证据，磁盘上的字节算。）
    const pick = (String(prompt).match(/[A-Za-z]:[\\/][^\s"'<>|*?\r\n]+?\.\w{1,5}/g) || [])
      .map((s) => s.replace(/[，。；、）)\]]+$/, ''))
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((p) => { try { const st = fs.statSync(p); return st.isFile() && st.mtimeMs >= t0Dispatch - 2000 ? { p, size: st.size } : null; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.size - a.size);
    if (pick.length) {
      const best = pick[0];
      console.error('[抢救] ' + name + ' 超时，但产物已在磁盘上：' + best.p + '（' + best.size + ' 字节）→ 改判成功');
      r = { ok: true, addedText: '（产物由' + name + '直接写盘，未回话）', salvaged: best.p, usage: { in: 0, out: 0 } };
      err = null;
    }
  }


  if (wantContract && r && r.ok) {
    contract = parseContract(r.addedText || '');
    const canRetry = process.env.ORCH_NO_RETRY !== '1';

    // 语法闸（B）：契约只保证「有 code 字段」，不保证「能编译」。
    // 编译不花钱、返工才花钱 —— 所以在交付前替调用方跑一次编译器。
    const syntaxOf = (c) => (c && c.ok && c.data && (c.data.code || c.data.answer))
      ? checkSyntax(c.data.code || c.data.answer, c.data.lang || c.data.language)
      : { ok: true, lang: 'skip', error: '' };

    let syn = syntaxOf(contract);
    if (contract.ok && !syn.ok && syn.lang !== 'skip') {
      const first = String(syn.error || '').split(String.fromCharCode(10))[0];
      console.error('[语法闸] ' + syn.lang + ' 编译失败：' + first);
      if (canRetry) {
        retried = true;
        const fixPrompt = prompt + String.fromCharCode(10) + String.fromCharCode(10)
          + '[语法闸] 你上一次给的代码编译失败，编译器原文：' + String.fromCharCode(10) + syn.error
          + String.fromCharCode(10) + '请修正后重新输出完整的 JSON 对象（不要解释）。';
        try {
          const r3 = await runOnce(fixPrompt);
          if (r3 && r3.ok) { r = r3; contract = parseContract(r3.addedText || ''); syn = syntaxOf(contract); }
        } catch (e3) { /* 修不动就带原始错误交付，由调用方决定 */ }
      }
    }

    // JSON 都解析不了 → 更严格地重来一次
    if (!contract.ok && canRetry) {
      retried = true;
      const stricter = prompt + String.fromCharCode(10) + String.fromCharCode(10) + '[重试] 上一次输出无法被 JSON.parse 解析。这次只输出 JSON 对象本身，不要任何解释文字。';
      try {
        const r2 = await runOnce(stricter);
        if (r2 && r2.ok) { r = r2; contract = parseContract(r2.addedText || ''); syn = syntaxOf(contract); }
      } catch (e2) { /* 重试失败就用第一次的原文兜底 */ }
    }

    syntaxReport = syn;
  }

  const usage = (r && r.usage) || {};
  if (r || err) {
    // 各适配层字段不统一：codebuddy 给 {in,out}，有的给 snake_case —— 这里一次归一
    const tokIn = usage.input_tokens ?? usage.inputTokens ?? usage.in ?? usage.prompt_tokens ?? 0;
    const tokOut = usage.output_tokens ?? usage.outputTokens ?? usage.out ?? usage.completion_tokens ?? 0;
    budgetRecord(name, { input: tokIn, output: tokOut, ok: !!(r && r.ok) });
  }

  // 成功才写缓存：失败/降级不缓存，否则错误会被冻结到 TTL 过期。
  if (r && r.ok && r.addedText && !r.cached) {
    try { cachePut(name, cacheKeyPrompt, r.addedText); } catch { /* 缓存失败不影响交付 */ }
  }

  const entry = {
    agent: name,
    kind: kindLabel,
    promptSummary: (extra.summary || rawPrompt).replace(/\s+/g, ' ').slice(0, 120),
    elapsedMs: Date.now() - t0,
    ok: !!r && r.ok,
    outputChars: r ? (r.outputChars ?? (r.addedText || '').length) : 0,
    error: err ? (err.message || String(err)) : '',
  };
  if (r && r.cost) entry.cost = r.cost;
  if (r && r.usage) entry.usage = r.usage;
  // 真实 token 用量（2026-11-15 加）。在此之前 392 条流水的 usage 永远是 {in:0,out:0}，
  // 不是「没消耗」，是「没去取」。现在 trae 会用 CDP Network 监听 commercial/get_session_usage
  // 拿回 input/output/cache_read，拿不到就整段不写（宁可缺字段，也不要用 0 冒充真实值）。
  if (r && r.tokens) {
    entry.usage = {
      in: r.tokens.input,
      out: r.tokens.output,
      cacheRead: r.tokens.cacheRead,
      cacheWrite: r.tokens.cacheWrite,
      credits: r.tokens.credits,
      model: r.tokens.model,
    };
  }
  if (wantContract) entry.contract = contract ? (contract.ok ? 'ok' : contract.reason) : 'skipped';
  if (syntaxReport) entry.syntax = syntaxReport.ok ? 'ok' : (syntaxReport.lang + ':' + String(syntaxReport.error || '').split(String.fromCharCode(10))[0]).slice(0, 120);
  if (r && r.cached) entry.cached = true;
  if (retried) entry.retried = true;
  if (pr) entry.pr = pr.id;

  // 提案收口：把 agent 写出的文件提交到提案分支，形成一个 ready 提案。
  // 合并与否是人的决定（orchestra_pr approve），这里只负责把它摆出来。
  if (pr) {
    try {
      const fin = prFinish(pr.id, { message: `feat(pr-${pr.id}): ${entry.promptSummary}` });
      entry.prStatus = fin.status;
      entry.prFiles = fin.files.length;
      console.error(`[PR] ${fin.id} ${fin.status}  文件 ${fin.files.length} 个` + (fin.files.length ? '：' + fin.files.map((f) => f.file).slice(0, 5).join(', ') : ''));
    } catch (e) {
      entry.prStatus = 'finish-failed';
      console.error(`[PR] 收口失败：${e.message}`);
      // 2026-11-15 修（rank2 提出的 7 个「永远 open 且无 diff」的提案根因）：
      // finish() 只有在「还在提案分支上」时才能成功；派活失败/工作区被别的通道改动后，
      // finish 会抛错，提案就永久卡在 open 且没有 diff，谁也不会再碰它。
      // 这里补一个兜底：收不了口就直接 reject，让状态机一定往前走。
      try {
        const rej = prReject(pr.id, 'Auto: 派活失败或收口失败（' + String(e.message || e).slice(0, 80) + '）');
        entry.prStatus = 'rejected(auto)';
        entry.pr = rej.id;
        console.error(`[PR] 已自动 reject ${rej.id}，避免卡在 open`);
      } catch (e2) {
        entry.prStatus = 'abandoned';
        console.error(`[PR] reject 也失败（${e2.message}），该提案需人工清理：${pr.id}`);
      }
    }
  }

  // 记「这条用的哪个模型」。拿不到就整段不写 —— 不用 0/空串冒充已知。
  if (extra && extra.model) entry.model = extra.model;
  appendLog(entry);
  try { setLastJob(entry); } catch { }

  if (err) {
    if (r && r.addedText) console.log(renderOut(r, contract, r.syntax));
    throw err;
  }
  return { ...r, contract, syntax: syntaxReport };
}

/** 统一渲染：契约成功就出干净内容，失败就出原文（并标注）。 */
function renderOut(r, contract, syntax) {
  const synWarn = (syntax && !syntax.ok && syntax.lang !== 'skip')
    ? String.fromCharCode(10, 10) + '[语法未通过] ' + syntax.lang + ' 编译失败，以下代码不能直接用：'
      + String.fromCharCode(10) + String(syntax.error || '').split(String.fromCharCode(10)).slice(0, 3).join(String.fromCharCode(10))
    : '';
  if (contract && contract.ok) return renderContract(contract.data) + synWarn;
  const raw = (r && r.addedText) || '';
  if (contract && !contract.ok) {
    const fb = fallbackCode(raw);
    if (fb) return fb + `\n\n[契约失败: ${contract.reason} · 已降级为原文提取]`;
  }
  return raw || '(没有拿到新增文本)';
}

try {
  if (cmd === 'ask') {
    // --skill <名字> 临时注入技能正文；--ttl 只是给 eph add 用，这里忽略
    const args = rest.slice();
    let skill = null;
    let dry = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--skill') { skill = args[i + 1]; args.splice(i, 2); i--; }
      if (args[i] === '--dry') { dry = true; args.splice(i, 1); i--; }
    }
    // agent 名可以省略：省略时按任务特征自动选路。
    // 短问答走 workbuddy（~22s、不随回合衰减），要产出代码走 codebuddy（慢但准）。
    // doubao 之前漏在这个表里 → `ask doubao "…"` 会被当成 prompt 开头，重新走自动选路，
    // 实测被改判给 workbuddy 并超时 260s。已知通道必须全列，否则显式指定等于没指定。
    const KNOWN = ['trae', 'codebuddy', 'workbuddy', 'doubao'];
    // 2026-11-14 修（污染评测的真 bug）：ask trae "…" 里 agent 名已被外层解析成 who0/rest，
    // 这里只看 args[0]，把「已指定的 agent」丢掉了，又调 routeTask 重新选路 →
    // eval --agent trae 实际把任务分给 workbuddy/codebuddy，测出的“trae 通过率”是别家的。
    // 现在：外层已确认的 agent 优先，其次看 args[0]，最后才自动选路。
    let autoAgent = (who0 && KNOWN.includes(String(who0).toLowerCase())) ? String(who0).toLowerCase() : null;
    if (!autoAgent && args.length && KNOWN.includes(String(args[0]).toLowerCase())) autoAgent = args.shift().toLowerCase();
    const prompt = args.join(' ').trim();
    if (!prompt) { console.error('prompt 不能为空'); process.exit(2); }
    if (!autoAgent) {
      autoAgent = routeTask(prompt);
      console.error('[选路] ' + autoAgent + '（' + prompt.length + ' 字符，自动判定）');
    }
    const gcBase = process.env.ORCH_GC === '0' ? null : await snapshotBaseline();
    const r = await dispatch('ask', prompt, { agent: autoAgent, ...((skill || dry) ? { skill, dry } : {}) });
    if (r.dry) {
      console.log('=== 将要发给 ' + r.agent + ' 的完整 prompt（' + r.prompt.length + ' 字符，未发出）===');
      console.log(r.prompt);
      process.exit(0);
    }
    console.log(renderOut(r, r.contract, r.syntax));
    await gcAfterRun(gcBase);
    // 通道拿到空文本 = 通道问题，不是「跑完了」：退出码要让调用方分得开（atwo 的 EXIT.channel=5）
    process.exit(String((r && r.addedText) || '').trim() ? 0 : 5);
  }

  if (cmd === 'review') {
    // 纠错 AI：默认**异源**评审（评审者自动避开产出者），可用 --by 指定、--author 声明产出者。
    // 11-13 那次 trae 审 trae 自己的文件，等于自说自话 —— 这条规则就是为它立的。
    const flags = new Set(rest.filter((x) => x.startsWith('--')));
    const argOf = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
    const positional = rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
    const file = positional[0];
    if (!file) { console.error('用法: review <file> [--by <评审者>] [--author <产出者>]'); process.exit(2); }
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) { console.error('文件不存在: ' + abs); process.exit(2); }
    const base = path.basename(abs);
    const authorArg = argOf('--author') || 'dsh';
    const prefer = argOf('--by');
    if (prefer && prefer === authorArg) { console.error('拒绝同源评审：产出者和评审者都是 ' + prefer + '，这样评等于没评'); process.exit(2); }
    // 候选队列而不是单个 —— 评审者超时是常态（2026-11-15 16:00 实测 codebuddy 240s / trae 260s 双超时）
    // 多评审者：--by-multi N / --reviewers N（同义）。
    // 上限 3 —— 四路全上之后如果要返工，就没有通道可用了。
    const multiRaw = argOf('--by-multi') || argOf('--reviewers');
    const multiN = multiRaw ? Number(multiRaw) : 0;
    if (multiRaw && (!Number.isFinite(multiN) || multiN < 1)) { console.error('--by-multi 需要一个 >=1 的数字，收到: ' + multiRaw); process.exit(2); }
    if (multiN > 3) { console.error('--by-multi 上限 3（四路全上之后返工没通道可用），收到: ' + multiN); process.exit(2); }
    const candidates = pickReviewers(authorArg, { prefer });
    if (!candidates.length) { console.error('没有可用的异源评审者：除了 ' + authorArg + ' 之外没有别的通道可用'); process.exit(2); }
    const content = fs.readFileSync(abs, 'utf8').slice(0, 12000);

    if (multiN > 1) {
      // 多评审路径：同时问 N 个，都 ACCEPT 才算过；分歧不投票，原文各自成档。
      console.log('[review] 产出者 ' + authorArg + ' → 多评审 ' + multiN + ' 个：' + candidates.slice(0, multiN).join('、') + '（异源）');
      const mr = await reviewMultiWithFallback({
        prompt: buildReviewPrompt(base, content, { author: authorArg }),
        summary: '多评审 ' + base + ' ×' + multiN,
        candidates: candidates.slice(0, multiN),
        count: multiN,
        dispatch,
        onProgress: (ev) => { if (ev.type === 'warn') console.log('[review] ' + ev.msg); },
      });
      if (!mr.votes.length) {
        console.error('[review] 没评成：' + multiN + ' 个异源评审者全部失败');
        process.exit(3);
      }
      const outDir = path.join(ROOT, 'reviews');
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = nowStr();
      const head = '# 多评审：' + base + '\n\n- 时间：' + new Date().toLocaleString('zh-CN')
        + '\n- 产出者：' + authorArg
        + '\n- 共识：' + (mr.consensus || '无') + (mr.degraded ? '（降级：' + mr.degradedReason + '）' : '')
        + '\n- 最终裁决：' + (mr.verdict || '未给出') + '（问题合计 ' + mr.issues + ' 条）\n\n'
        + '| 评审者 | 裁决 | 问题数 |\n|---|---|---|\n'
        + mr.votes.map((x) => '| ' + x.reviewer + ' | ' + (x.verdict || '未给出') + ' | ' + (x.issues || 0) + ' |').join('\n') + '\n';
      const sumFile = path.join(outDir, 'multi-review-' + base + '-' + stamp + '.md');
      fs.writeFileSync(sumFile, head, 'utf8');
      // 原文各存一份 —— 分歧的价值在原文里，汇总表看不出来
      const perFiles = [];
      for (const x of mr.reviewTexts) {
        const f = path.join(outDir, x.reviewer + '-review-' + base + '-' + stamp + '.md');
        fs.writeFileSync(f, '# ' + x.reviewer + ' 评审：' + base + '\n\n- 产出者：' + authorArg + '\n\n---\n\n' + x.text + '\n', 'utf8');
        perFiles.push(f);
      }
      console.log('');
      for (const x of mr.votes) console.log('  · ' + x.reviewer + ' → ' + (x.verdict || '未给出') + '（问题 ' + (x.issues || 0) + ' 条）');
      console.log('');
      // 共识行说人话（`all-revise` 这种东西目标用户看不懂），裁决行保留机器值给退出码和脚本用
      console.log('[review] 共识：' + humanVerdict({ consensus: mr.consensus, verdict: mr.verdict, votes: mr.votes, degraded: mr.degraded, issues: mr.issues }));
      console.log('[review] 裁决：' + (mr.verdict || '**所有票都没解析到 VERDICT**') + '（' + humanIssues(mr.issues) + '）');
      if (mr.degraded) console.log('[review] 注意：' + mr.degradedReason + ' —— 结论照出，但这不是完整的多评审');
      console.log('[saved] ' + sumFile);
      for (const f of perFiles) console.log('[saved] ' + f);
      process.exit(mr.verdict === 'ACCEPT' ? 0 : 1);
    }

    console.log('[review] 产出者 ' + authorArg + ' → 候选 ' + candidates.join(' → ') + '（异源）');
    const rr = await reviewWithFallback({
      prompt: buildReviewPrompt(base, content, { author: authorArg }),
      summary: '评审 ' + base + ' by ' + (prefer || candidates[0]),
      candidates,
      dispatch,
      onProgress: (ev) => { if (ev.type === 'warn') console.log('[review] ' + ev.msg); },
    });
    if (!rr.r) {
      // 三态里的第三种：没评成。既不是通过也不是不通过 —— 它就是没有结论，
      // 所以既不能写存档冒充评过，也不能返回 0。
      console.error('[review] 没评成：' + rr.tried.length + ' 个异源评审者全部失败（' + rr.tried.join('、') + '）');
      process.exit(3);
    }
    const r = rr.r;
    const reviewer = rr.reviewer;
    const v = { verdict: rr.verdict, issues: rr.issues, weak: rr.weak };

    const outDir = path.join(ROOT, 'reviews');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${reviewer}-review-${base}-${nowStr()}.md`);
    // 试过并失败的要写进头部：否则后来人只看到「X 给的结论」，不知道前面挂了几个
    const failed = rr.tried.filter((t) => t !== reviewer);
    fs.writeFileSync(outFile,
      `# ${reviewer} 评审：${base}\n\n- 时间：${new Date().toLocaleString('zh-CN')}\n- 产出者：${authorArg}\n- 耗时：${((r.elapsedMs || 0) / 1000).toFixed(1)}s\n- 裁决：${v.verdict || '未给出'}（问题 ${v.issues} 条）\n` +
      (failed.length ? `- 试过并失败：${failed.join('、')}\n` : '') +
      `\n---\n\n${r.addedText || '(空)'}\n`, 'utf8');
    console.log(renderOut(r, r.contract, r.syntax));
    console.log('');
    if (!v.verdict) console.log('[review] 裁决：**没解析到 VERDICT 行**（评审者没按要求给结论，不能当成通过）');
    else console.log('[review] 裁决：' + v.verdict + '（' + humanIssues(v.issues) + (v.weak ? '，但一条也没列，评审本身不合格' : '') + '）'
      + '  —— ' + humanVerdict({ consensus: null, verdict: v.verdict, votes: [{ reviewer, verdict: v.verdict, issues: v.issues }], degraded: false, issues: v.issues }));
    console.log('[saved] ' + outFile);
    // 退出码四态：0=ACCEPT 1=REVISE 2=用法/同源/无候选 3=没评成。
    // 原来一律 exit 0，挂 CI 等于白挂 —— 没有后果的验收不算验收。
    process.exit(v.verdict === 'ACCEPT' ? 0 : 1);
  }

  // ---- duo：同一道题并行派给两个 agent，看谁快谁好 ----
  if (cmd === 'duo') {
    const second = rest[0];
    const prompt = rest.slice(1).join(' ').trim();
    if (!REGISTRY[second] || !REGISTRY[who] || !prompt) {
      console.error('用法: duo <agentA> <agentB> "<prompt>"');
      process.exit(2);
    }
    const t0 = Date.now();
    const gcBaseDuo = process.env.ORCH_GC === '0' ? null : await snapshotBaseline();
    const runOne = (name) => dispatch('duo', prompt, { agent: name, summary: '[duo] ' + prompt.slice(0, 60) })
      .then((r) => ({ name, ok: true, text: r.addedText || '', ms: Date.now() - t0, chars: (r.addedText || '').length, cost: r.cost }))
      .catch((e) => ({ name, ok: false, text: '', ms: Date.now() - t0, err: e.message }));
    const res = await Promise.all([runOne(who), runOne(second)]);
    const bar = '─'.repeat(60);
    for (const x of res) {
      console.log(bar);
      console.log('[' + x.name + '] ' + (x.ok ? 'OK' : 'FAIL') + '  ' + (x.ms / 1000).toFixed(1) + 's  ' + x.chars + ' 字符' + (x.cost && x.cost.estUsd != null ? '  $' + x.cost.estUsd : ''));
      console.log(bar);
      console.log(x.ok ? x.text : 'ERR ' + x.err);
    }
    const okCount = res.filter((x) => x.ok).length;
    console.log('[汇总] 并行墙钟 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，成功 ' + okCount + '/' + res.length);
    await gcAfterRun(gcBaseDuo);
    process.exit(okCount === res.length ? 0 : 5);  // 部分成功同样是通道问题，不该等于「全跑完了」
  }

  // ---- stats：效率看板（从 log.jsonl 汇总）----
  if (cmd === 'stats') {
    const log = readLog(2000);
    const by = new Map();
    for (const e of log) {
      const k = e.agent || '?';
      const o = by.get(k) || { n: 0, ok: 0, ms: 0, chars: 0, cost: 0, tin: 0, tout: 0 };
      o.n++;
      if (e.ok) o.ok++;
      o.ms += e.elapsedMs || 0;
      o.chars += e.outputChars || 0;
      if (e.cost && e.cost.estUsd) o.cost += Number(e.cost.estUsd);
      if (e.usage) { o.tin += e.usage.in || 0; o.tout += e.usage.out || 0; }
      by.set(k, o);
    }
    if (process.argv.includes('--json')) {
      const rows = [...by.entries()].map(([k, o]) => ({
        agent: k, calls: o.n, okRate: Math.round((o.ok / o.n) * 100),
        avgSeconds: +(o.ms / o.n / 1000).toFixed(1), avgChars: Math.round(o.chars / o.n),
        inTok: o.tin, outTok: o.tout,
      }));
      console.log(JSON.stringify({ ok: true, totalEntries: log.length, agents: rows }, null, 2));
      process.exit(0);
    }
    if (!by.size) { console.log('(还没有派活记录)'); process.exit(0); }
    console.log('agent\t次数\t成功率\t均耗时\t均字符\tin tok\tout tok\t成本');
    for (const [k, o] of by) {
      console.log([k, o.n, Math.round((o.ok / o.n) * 100) + '%', (o.ms / o.n / 1000).toFixed(1) + 's',
        Math.round(o.chars / o.n), o.tin || '—', o.tout || '—',
        o.cost ? '$' + o.cost.toFixed(4) : '—'].join('\t'));
    }
    console.log('\n(共 ' + log.length + ' 条流水)');
    process.exit(0);
  }

  // ---- pick：只打印会选谁，不真的派活（零成本，用来验路由规则）----
  if (cmd === 'pick') {
    const prompt = [who, ...rest].join(' ').trim();
    if (!prompt) { console.error('用法: pick "<prompt>"'); process.exit(2); }
    const p = pickAgent(prompt);
    const code = CODE_HINTS.test(prompt), prose = PROSE_HINTS.test(prompt);
    console.log(`→ ${p.name}（${p.why}）  [code=${code} prose=${prose}]`);
    if (p.name === 'trae' && code && !prompt.includes('```')) console.log('  (会强制补一句：用 ``` 代码块输出，缩进 4 空格)');
    process.exit(0);
  }

  // ---- auto：按任务性质自动选 agent ----
  if (cmd === 'auto') {
    const prompt = [who, ...rest].join(' ').trim();
    if (!prompt) { console.error('用法: auto "<prompt>"'); process.exit(2); }
    const pick = pickAgent(prompt);
    console.log(`[auto] → ${pick.name}（${pick.why}）`);
    const r = await dispatch('auto', prompt, { agent: pick.name, summary: '[auto] ' + prompt.slice(0, 60) });
    console.log(renderOut(r, r.contract, r.syntax));
    process.exit(0);
  }


  // ---- doctor：这台机器缺什么，一次说清 ----
  if (cmd === 'doctor') {
    const cfgMod = await import('./lib/config.mjs');
    const cfg = cfgMod.config;
    const src = cfgMod.configSources();
    const ok = (b) => (b ? '✓' : '✗');
    const line = (mark, label, detail) => console.log(`  ${mark} ${String(label).padEnd(16)} ${detail || ''}`);
    console.log('这台机器能不能跑 Orchestra：\n');

    line(ok(Number(process.versions.node.split('.')[0]) >= 18), 'node', 'v' + process.versions.node);
    let gitVer = '';
    try { gitVer = execSync('git --version', { encoding: 'utf8', windowsHide: true }).trim(); } catch { }
    line(ok(!!gitVer), 'git', gitVer || '找不到 git（PR 流程不可用）');

    const exeOk = fs.existsSync(cfg.traeExe);
    line(ok(exeOk), 'Trae 可执行文件', exeOk ? cfg.traeExe : `不存在：${cfg.traeExe}\n      → 设 TRAE_EXE 或写进 ${cfg.localFile}（当前来源：${src.traeExe}）`);

    const portOk = await new Promise((res) => {
      const s = net.connect(cfg.traePort, '127.0.0.1');
      const done = (v) => { s.destroy(); res(v); };
      s.setTimeout(900, () => done(false));
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
    });
    line(portOk ? '✓' : '·', 'Trae 调试端口', portOk ? `${cfg.traePort} 在监听` : `${cfg.traePort} 没监听（派活时会自动拉起 Trae，属正常）`);

    // WorkBuddy：CDP 系快路（~22s/次），和 trae 同档但失效模式不同 ——
    // trae 会随回合数衰减，workbuddy 没观察到衰减，代价是必须应用开着。
    const wbPort = Number(process.env.WB_PORT || 9224);
    const wbUp = await new Promise((res) => {
      const s = net.connect(wbPort, '127.0.0.1');
      const done = (v) => { s.destroy(); res(v); };
      s.setTimeout(900, () => done(false));
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
    });
    const wbExeOk = fs.existsSync(wbMeta.exe || '');
    line(wbUp ? '✓' : '·', 'WorkBuddy 快路', wbUp
      ? `${wbPort} 在监听 → 可直接派活，~22s/次（双快路并行时吞吐翻倍）`
      : `${wbPort} 没监听（打开 WorkBuddy 即可用；不开则本批跳过这条路${wbExeOk ? '' : '，exe 也没找到：' + wbMeta.exe}）`);

    const cbOk = fs.existsSync(cfg.codebuddyCli);
    line(ok(cbOk), 'codebuddy CLI', cbOk ? cfg.codebuddyCli : `不存在：${cfg.codebuddyCli}（当前来源：${src.codebuddyCli}）`);

    // codebuddy 登录态（启发式，2026-11-14 rank2 加）
    // 官方 CLI 只有 config/mcp/sandbox/plugin/project/doctor/update/install/cleanup/daemon/ps/logs/attach，
    // 没有 auth status / whoami；凭据落在 ~/.codebuddy/local_storage/entry_*.info 且是加密的，
    // 读不出 expiresAt。所以这里只能看「凭据文件最近一次活跃时间」：
    //   · 一个文件都没有 → 肯定没登录
    //   · 长期没动过 → 要么很久没派活，要么 token 僵死，提示重登
    // 真判有效性只有跑一次最小 ask（每次固定约 7.6K input token），不适合放进 doctor。
    {
      const lsDir = path.join(process.env.USERPROFILE || 'C:\\Users\\kkk', '.codebuddy', 'local_storage');
      let lastTs = 0, nFiles = 0;
      try {
        for (const f of fs.readdirSync(lsDir)) {
          if (!f.endsWith('.info')) continue;
          nFiles++;
          try { const st = fs.statSync(path.join(lsDir, f)); if (st.mtimeMs > lastTs) lastTs = st.mtimeMs; } catch { }
        }
      } catch { }
      const ageDays = lastTs ? Math.floor((Date.now() - lastTs) / 86400000) : -1;
      if (!nFiles) line('✗', 'codebuddy 登录态', `找不到凭据文件（${lsDir}）→ 跑一次 codebuddy --serve 在 Web UI 里登录`);
      else if (ageDays > 14) line('·', 'codebuddy 登录态', `凭据 ${nFiles} 个文件，最近活跃 ${ageDays} 天前 → 建议重登确认（CLI 无 auth status，凭据加密读不到过期时间）`);
      else line('✓', 'codebuddy 登录态', `凭据 ${nFiles} 个文件，${ageDays <= 0 ? '今天' : ageDays + ' 天前'}活跃过`);
    }

    let dirty = '';
    try { dirty = execSync('git status --porcelain', { encoding: 'utf8', windowsHide: true }).trim(); } catch { }
    line(!dirty ? '✓' : '·', '仓库', !dirty ? '工作区干净' : `有 ${dirty.split('\n').length} 处未提交改动`);

    line(cfg.hasLocal ? '✓' : '·', '本机配置', cfg.hasLocal ? cfg.localFile : `还没建（node orchestra.mjs doctor --init 生成模板）`);
    console.log('');
    const hardGap = !gitVer || !exeOk || !cbOk;
    console.log(hardGap ? '结论：有硬缺口（带 ✗ 的项修好才能派活）' : '结论：可以正常派活');
    if (process.argv.includes('--init')) {
      const r = cfgMod.writeLocalTemplate(process.argv.includes('--force'));
      console.log(r.ok ? '已生成 ' + r.file : '未生成：' + r.reason);
    }
    process.exit(hardGap ? 3 : 0);
  }

  // ---- probe：适配层还认不认得当前界面（不派活、不花 token）----
  if (cmd === 'probe') {
    const cfg = (await import('./lib/config.mjs')).config;
    console.log('[probe] 检查 Trae 适配层是否仍然对得上（不派任务、不消耗额度）\n');
    const portOk = await new Promise((res) => {
      const s = net.connect(cfg.traePort, '127.0.0.1');
      const done = (v) => { s.destroy(); res(v); };
      s.setTimeout(900, () => done(false));
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
    });
    console.log(`  ${portOk ? '✓' : '✗'} CDP 端口 ${cfg.traePort}  ${portOk ? '在监听' : '没监听'}`);
    // 结论对不上 = 前置条件不满足，退出码要让调用方分得开（atwo 的 EXIT.precondition=3）
    let probeOk = false;
    if (!portOk) {
      console.log('\n  结论：Trae 没开，页面探不了。先跑一次 ask trae 让它起来，再 probe。');
      process.exit(3);
    }
    try {
      const snap = await snapshotTrae({ port: cfg.traePort });
      const txt = String(await peekTrae({ port: cfg.traePort }) || '');
      const editable = Number((snap && snap.editable) || 0);
      const turns = Number((snap && snap.agentTurns) || 0);
      // 判据是「输入框还认不认得」，那是派活的前提。别再拿按钮文案当特征词：
      // Trae 每个版本的按钮文字都换过一轮，而选择器从 1.0 到今天没变过。
      console.log(`  ${txt.length > 20 ? '✓' : '✗'} 页面文本可取  ${txt.length} 字符`);
      console.log(`  ${editable > 0 ? '✓' : '✗'} 输入框选择器  ${editable > 0 ? '命中 ' + editable + ' 个可编辑区' : '一个都没命中 —— 选择器需更新'}`);
      console.log(`  · 对话区回合    ${turns} 个${turns ? '' : '（空会话，属正常）'}`);
      console.log('');
      probeOk = txt.length > 20 && editable > 0;
      console.log(probeOk
        ? '  结论：适配层对得上，可以正常派活'
        : '  结论：对不上，需更新选择器。先跑 node test/selftest.mjs 确认纯函数层仍正确');
    } catch (e) {
      console.log('  ✗ peek 失败：' + (e && e.message ? e.message : e));
      console.log('\n  结论：连不上 Agent 面板。可能端口被别的窗口占了，或 Trae 刚起来还没建好页面。');
    }
    process.exit(probeOk ? 0 : 3);
  }

  // ---- ctx：只看「这次派活会注入什么、各占多少 token」，零成本不调模型 ----
  // 上下文是有限注意预算：团队记忆 + 项目接续 + 临时能力 + 技能正文 + 输出契约
  // 全都挤在同一窗口里。这个命令把账摊开，超预算一眼能看见。
  if (cmd === 'ctx') {
    const q = [who, ...rest].filter((x) => x && x !== 'ctx').join(' ').trim() || '示例任务：写一个 python 函数 add(a,b)';
    const name0 = (process.env.ORCH_CTX_AGENT || 'codebuddy').toLowerCase();
    const r = await dispatch('ctx', q, { agent: name0, dry: true });
    console.log(`[上下文] agent=${name0}  任务=${q.slice(0, 40)}`);
    console.log('');
    console.log(renderBudget({ report: r.budget, totalTokens: r.totalTokens, overBudget: (r.budget || []).some((x) => x.over) }));
    console.log('');
    console.log('提示：任务分区是大头时先拆任务；记忆/项目分区超预算就压 slim；');
    console.log('      技能正文超预算改用 eph add + 按需读，别整篇塞进 prompt。');
    process.exit(0);
  }

  // ---- batch：把 N 个小任务压进一次调用，摊薄固定开销 ----
  // codebuddy 每次固定吃 ~24,800 input token（CLI 自带 system prompt），
  // 5 个任务分 5 次 = 12.4 万；压成 1 次 = 2.5 万。这是最直接的省钱手段。
  if (cmd === 'batch') {
    const agentName = (who || 'codebuddy').toLowerCase();
    const src = rest.join(' ').trim();
    if (!src) { console.error('用法: batch <agent> <tasks.md | "任务1|||任务2">'); process.exit(2); }
    const tasks = loadTasks(src);
    if (!tasks.length) { console.error('没解析出任务'); process.exit(2); }
    if (tasks.length === 1) console.error('[batch] 只有 1 个任务，批处理没意义，直接用 ask 更清楚');
    const B = EST_INPUT[agentName] ?? 0;
    console.log(`[batch] ${tasks.length} 个任务 → ${agentName}（预计 ${tasks.length === 1 ? '不省' : '省 ' + (tasks.length - 1) * B} tok）`);
    const prompt = buildBatchPrompt(tasks);
    const t0 = Date.now();
    const ag = { trae: { ask: askTrae }, codebuddy: { ask: askCodeBuddy } }[agentName];
    if (!ag) { console.error('未知 agent: ' + agentName); process.exit(2); }
    const gate = budgetCheck(agentName, B);
    if (!gate.ok) { console.error('EBUDGET ' + gate.reason); process.exit(3); }
    let raw = '';
    let ok = true;
    let usageIn = 0, usageOut = 0;
    try {
      // 适配层的 ask() 返回对象 {ok,addedText,usage}，不是字符串。
      // 早期这里直接 String(...) → "[object Object]" → 整批解析降级成 fallback。
      const res = await withLockPool(agentName, 1, () => withTimeout(
        () => ag.ask(prompt, { timeoutMs: timeoutFor(agentName) }),
        timeoutFor(agentName) + 20000, agentName,
      ), { onWait: () => console.error('[队列] ' + agentName + ' 正忙，排队等待…') });
      if (typeof res === 'string') {
        raw = res;
      } else if (res && typeof res === 'object') {
        raw = String(res.addedText ?? res.text ?? '');
        usageIn = Number((res.usage && (res.usage.in ?? res.usage.input_tokens)) || 0);
        usageOut = Number((res.usage && (res.usage.out ?? res.usage.output_tokens)) || 0);
      }
      if (res && typeof res === 'object' && res.ok === false) ok = false;
    } catch (e) {
      ok = false; raw = '';
      console.error('EAGENTFAIL ' + (e && e.message ? e.message : e));
    }
    const { source, items } = splitResults(raw, tasks);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[batch] ${ok ? 'ok' : 'fail'}  ${secs}s  解析=${source}  拿到 ${items.length}/${tasks.length} 项`);
    console.log('');
    items.forEach((it, i) => {
      const task = tasks[i] || '';
      console.log(`── ${it.id}. ${task.slice(0, 60)}`);
      const body = (it.code || it.answer || '').trim();
      console.log(body ? body.split('\n').map((l) => '   ' + l).join('\n') : '   （空）');
      if (it.notes && it.notes.length) console.log('   · ' + it.notes.join(' / '));
      if (typeof it.confidence === 'number') console.log(`   (confidence ${it.confidence})`);
      console.log('');
    });
    const missing = tasks.length - items.filter((it) => (it.code || it.answer || '').trim()).length;
    if (missing > 0) console.log(`[batch] 注意：${missing} 项没拿到内容，可重派或缩小任务粒度`);
    try {
      budgetRecord(agentName, { input: usageIn || B, output: usageOut || Math.ceil(raw.length / 4), ok });
      appendLog({
        at: new Date().toISOString(), kind: 'batch', agent: agentName, ok,
        promptSummary: `[batch ${tasks.length} 项] ` + String(tasks[0]).slice(0, 40),
        chars: raw.length, secs: Number(secs), items: items.length,
      });
    } catch { /* 记账失败不挡结果 */ }
    process.exit(0);
  }

  // ---- sub：自己的子 agent ----
  // 与 swarm 的区别：swarm 跑「已经拆好的独立任务」；sub 先从一句目标拆出子任务，
  // 每个子任务带角色提示词独立执行，回来只给摘要（全文留在 runs/<id>/）。
  // 拆解失败就退化成单任务，绝不因为「拆得不漂亮」整单失败。
  // ---- do：一句话入口。用户不用记五档，这里替它判断 ----
  // 为什么要有它：ask / swarm / batch / duo / sub 五档，每档还带 --land / --verify / --slots，
  // 让用户记这些等于把工具的复杂度转嫁给用户。do 用纯规则判断（不调 AI、不多花一分钱），
  // 并且把判断依据打印出来——判错了也能一眼看懂为什么错，而不是被黑箱吞掉。
  //
  // 只有两个语义对用户是真实的：**一件** 和 **一堆**。
  // 所以 do 只映射两档：ask（一件）与 sub（一堆，内部自带拆解 + 并行）。
  // swarm 需要预先写好的任务文件，不适合「一句话」场景，故不映射。
  if (cmd === 'do') {
    const dwords = [];
    let dAgent = '';
    let dN = '';
    let dDry = false;
    {
      const av = process.argv.slice(3).filter((x) => x !== undefined);
      for (let i = 0; i < av.length; i++) {
        const a = av[i];
        if (a === '--n') dN = av[++i] || '';
        else if (a === '--agent') dAgent = String(av[++i] || '').toLowerCase();
        else if (a === '--dry') dDry = true;
        else if (a === '--no-land' || a === '--no-verify' || a === '--fast') { /* 透传给下游 */ dwords.push(a); }
        else if (a.startsWith('--')) { console.error('未知参数 ' + a); process.exit(2); }
        else dwords.push(a);
      }
    }
    const goalRaw = dwords.filter((x) => !x.startsWith('--')).join(' ').trim();
    if (!goalRaw || goalRaw.length < 4) {
      console.error('用法: do "<一句话目标>" [--n 4] [--agent codebuddy] [--dry]');
      process.exit(2);
    }
    const cntMatch = goalRaw.match(/(\d+)\s*(?:个|条|篇|份|种|项|件)/);
    const manyWord = /(和|以及|、|分别|各自|还有)/;
    const systemLike = /(系统|一整套|完整|框架|重构整个|全部|批量)/;
    let tier;
    let why;
    if (cntMatch && Number(cntMatch[1]) >= 2) {
      tier = 'sub';
      why = '目标里写了 ' + cntMatch[1] + ' 件，拆开并行';
    } else if (systemLike.test(goalRaw) || (goalRaw.length > 60 && manyWord.test(goalRaw))) {
      tier = 'sub';
      why = '像多产物/系统性目标，先拆再并行';
    } else {
      tier = 'ask';
      why = '单点且明确，一件派出去最快';
    }
    // 复用 pickAgent 的判断：它比 isCodeTask 细一档（会看是不是评审型、要不要 workbuddy），
    // 但探活是异步的，这里只取纯规则部分，探活交给下游 dispatch。
    const pk = pickAgent(goalRaw);
    const agentPick = dAgent || pk.name;
    const nPick = String(Math.max(2, Math.min(8, Number(dN) || (cntMatch ? Number(cntMatch[1]) : 3))));
    const passthru = dwords.filter((x) => x.startsWith('--'));
    const childArgs = tier === 'ask'
      ? ['ask', agentPick, goalRaw]
      : ['sub', goalRaw, '--n', nPick];
    for (const p of passthru) childArgs.push(p);
    console.error('[do] 目标：' + goalRaw.replace(/\s+/g, ' ').slice(0, 90));
    console.error('[do] 判断：' + tier + '（' + why + '）· 通道 ' + agentPick + '（' + pk.why + '）' + (tier === 'sub' ? ' · 并行 ' + nPick : ''));
    if (dDry) {
      console.log('');
      console.log('将执行: ' + [process.execPath, path.join(ROOT, 'orchestra.mjs'), ...childArgs].join(' '));
      process.exit(0);
    }
    const r0 = spawnSync(process.execPath, [path.join(ROOT, 'orchestra.mjs'), ...childArgs], { stdio: 'inherit' });
    const st = r0.status;
    if (st !== 0) {
      const hint = st === 2 ? '参数写错了，看上面用法'
        : st === 3 ? '派活阶段就挂了：先跑 health 看哪条通道活着'
        : st === 4 ? '有任务没做完，看上面 ✗ 那几个'
        : st === null ? '子进程被信号打断（超时或被 kill）'
        : '退出码 ' + st;
      console.error('\n[do] ✗ 失败：' + hint);
    }
    process.exit(st === null ? 1 : st);
  }

  if (cmd === 'sub') {
    // 参数自解析（不复用 swarm 分支的 flags，那些变量只在它自己作用域里）
    const sflags = { n: '3', agent: process.env.ORCH_SUB_LEAD || 'codebuddy', slots: '', chars: '160', resume: false, mode: 'auto' };
    const swords = [];
    {
      const av = process.argv.slice(3).filter((x) => x !== undefined);
      for (let i = 0; i < av.length; i++) {
        const a = av[i];
        if (a === '--n') sflags.n = av[++i] || '3';
        else if (a === '--agent') sflags.agent = String(av[++i] || 'codebuddy').toLowerCase();
        else if (a === '--slots') sflags.slots = av[++i] || '';
        else if (a === '--chars') sflags.chars = av[++i] || '160';
        else if (a === '--mode') sflags.mode = String(av[++i] || 'auto').toLowerCase();
        else if (a === '--resume') sflags.resume = true;
        else if (a === '--deep') { /* 预留：交给 runSwarm 的 deep */ }
        else if (a.startsWith('--')) { console.error('未知参数 ' + a); process.exit(2); }
        else swords.push(a);
      }
    }
    const goal = swords.join(' ').trim();
    if (!goal || goal.length < 4) {
      console.error('用法: sub "<目标>" [--n 3] [--agent codebuddy] [--slots trae=1,codebuddy=6] [--chars 160] [--resume]');
      process.exit(2);
    }
    const wantN = Math.max(1, Math.min(8, Number(sflags.n) || 3));
    const leadAgent = sflags.agent;
    const runId = 'sub' + Date.now();
    const t0 = Date.now();
    console.error('[sub] 目标：' + String(goal).replace(/\s+/g, ' ').slice(0, 80));
    console.error('[sub] 拆解中（' + leadAgent + '，目标 ' + wantN + ' 个子任务）…');
    let subs = [];
    try {
      const dp = DECOMPOSE_CONTRACT.replace('__N__', String(wantN)) + '\n\n[目标]\n' + String(goal).trim();
      const dr = await dispatch('sub-decompose', dp, { agent: leadAgent, contract: false });
      const txt = (dr && (dr.addedText || dr.text)) || '';
      subs = parseSubtasks(txt, wantN);
      if (!subs.length) {
        // 有的 agent 会把 JSON 塞进 code 字段
        const c = dr && dr.code ? String(dr.code) : '';
        if (c) subs = parseSubtasks(c, wantN);
      }
    } catch (e) {
      console.error('[sub] 拆解失败（' + (e && e.message) + '），退化为单任务');
    }
    if (!subs.length) subs = singleTask(goal);
    console.error('[sub] 拆出 ' + subs.length + ' 个：' + subs.map((x) => x.id + '.' + x.title).join(' | '));

    const dir = briefDir(runId);
    const briefPath = writeBrief(dir, goal, subs);

    const slots = parseSlots(sflags.slots);
    const tasks = subs.map((x) => ({ id: x.id, text: buildBrief(x) }));
    const onProgress = (ev) => {
      const t = new Date().toISOString().slice(11, 19);
      if (ev.type === 'start') console.error('[' + t + '] ▶ #' + ev.id + ' ' + ev.agent + ' 路' + ev.slot);
      else if (ev.type === 'done') console.error('[' + t + '] ' + (ev.item.status === 'done' ? '✓' : '✗') + ' #' + ev.item.id + ' ' + fmtMs(ev.item.elapsedMs));
      else if (ev.type === 'retry') console.error('[' + t + '] ↻ #' + ev.id + ' ' + ev.from + '→' + ev.to);
      else if (ev.type === 'warn' || ev.type === 'move' || ev.type === 'split') console.error('[' + t + '] ⇄ ' + (ev.msg || ev.from + '→' + ev.to));
    };
    let out = null;
    try {
      out = await runSwarm(tasks, {
        mode: sflags.mode, slots, resume: sflags.resume, taskSource: 'sub:' + runId,
        dispatchFn: (text, extra) => dispatch('sub', text, extra),
        onProgress,
      });
    } catch (e) {
      console.error('ESUBFAIL ' + (e && e.message ? e.message : e));
      process.exit(3);
    }
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    const byId = new Map(tasks.map((t) => [String(t.id), t.text]));
    const enriched = (out.results || []).map((r) => ({ ...r, shownPrompt: byId.get(String(r.id)) || "" }));
    const d = digest(enriched, Number(sflags.chars) || 160);
    console.log(renderDigest(d));
    console.error('[sub] 墙钟 ' + wall + 's   产物：' + (briefPath ? path.dirname(briefPath) : dir) + '   报告：' + (out.dir || ''));
    process.exit(d.ok === d.total ? 0 : 4);
  }

  // ---- swarm：N 个独立任务跨 agent 并行，榨干每一路并发 ----
  // 为什么这是吞吐最高的一档：单件派活写 prompt + 等 + 验收三份开销摊在一件事上是亏的；
  // swarm 把这些开销摊到 N 件事上，并且 trae(1 路快) 与 codebuddy(6 路准) 两条流水线同时跑。
  if (cmd === 'swarm') {
    const argv = [who, ...rest].filter(x => x !== undefined);
    const flags = { mode: 'auto', slotsSpec: '', out: '', resume: false, switchOnFail: true, land: false, verify: false, maxFix: 0, reviewers: 0, force: false, deep: false, fast: false, review: false };
    const words = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--agent') flags.mode = String(argv[++i] || 'auto').toLowerCase();
      else if (a === '--slots') flags.slotsSpec = argv[++i] || '';
      else if (a === '--out') flags.out = argv[++i] || '';
      else if (a === '--resume') flags.resume = true;
      else if (a === '--no-switch') flags.switchOnFail = false;
      else if (a === '--land') flags.land = true;
      else if (a === '--verify') flags.verify = true;
      else if (a === '--force') flags.force = true;
      else if (a === '--deep') flags.deep = true;
      else if (a === '--strict-regress') flags.strictRegress = true; // 对拍不一致时判失败（默认只报告）
      else if (a === '--fast') flags.fast = true; // 只要一段人看的文字、不要产物：退回 DOM（省文件开销）
      else if (a === '--review') flags.review = true; // 跑完把产物派给异源评审者挑错（配合 --max-fix N 可自动返工）
      else if (a === '--max-fix') flags.maxFix = Math.max(0, Number(argv[++i] || 0));
      else if (a === '--reviewers' || a === '--by-multi') flags.reviewers = Math.max(1, Number(argv[++i] || 0)); // 多评审者个数（reviewAndFix 早就支持 opts.reviewers，之前 swarm 没透传，atwo 传 --by-multi 直接被判未知参数）
      else if (a.startsWith('--')) { console.error('未知参数 ' + a); process.exit(2); }
      else words.push(a);
    }
    // --land 隐含 --verify：写进磁盘的东西必须过验收，否则等于把残答固化成文件。
    if (flags.land) flags.verify = true;
    const src = words.join(' ').trim();
    if (!src) { console.error('用法: swarm <tasks.md | "甲|||乙"> [--agent auto] [--slots trae=1,codebuddy=6] [--out r.md] [--resume]'); process.exit(2); }
    const tasks = loadSwarmTasks(src);
    if (!tasks.length) { console.error('没解析出任务'); process.exit(2); }
    const slots = parseSlots(flags.slotsSpec);
    const plan = {};
    for (const t of tasks) {
      const a = routeTask(t.text, flags.mode);
      plan[a] = (plan[a] || 0) + 1;
    }
    console.error('[swarm] ' + tasks.length + ' 个任务  分配：' + Object.entries(plan).map(([k, v]) => k + '×' + v).join('  ') + '  并发：' + Object.entries(slots).map(([k, v]) => k + '=' + v).join(','));
    const onProgress = (ev) => {
      const t = new Date().toISOString().slice(11, 19);
      if (ev.type === 'start') console.error('[' + t + '] ▶ #' + ev.id + ' ' + ev.agent + ' 路' + ev.slot + '  ' + String(ev.text).replace(/\s+/g, ' ').slice(0, 44));
      else if (ev.type === 'done') console.error('[' + t + '] ' + (ev.item.status === 'done' ? '✓' : '✗') + ' #' + ev.item.id + ' ' + ev.item.agent + ' ' + fmtMs(ev.item.elapsedMs) + '  进度 ' + ev.done + '/' + ev.total);
      else if (ev.type === 'retry') console.error('[' + t + '] ↻ #' + ev.id + ' ' + ev.from + '→' + ev.to + ' 换路（' + String(ev.error).slice(0, 70) + '）');
      else if (ev.type === 'split') {
        const why = ev.why
          ? ev.from + '→' + ev.to + ' ' + ev.count + ' 个（' + ev.why + '）'
          : ev.from + ' 会话上限 ' + ev.limit + '，超出的 ' + ev.count + ' 个改派给 ' + ev.to;
        console.error('[' + t + '] ⇄ ' + why);
      }
      else if (ev.type === 'move') console.error('[' + t + '] ⇄ ' + ev.from + ' 不可用，' + ev.count + ' 个任务转给 ' + ev.to);
      else if (ev.type === 'warn') console.error('[' + t + '] ! ' + ev.msg);
      else if (ev.type === 'verify-fail') {
        const why = (ev.checks || []).map((c) => c.name + '：' + String(c.detail || '').slice(0, 60)).join(' / ');
        console.error('[' + t + '] ⚠ #' + ev.id + ' 验收未过 ' + (ev.target || '') + '  ' + why);
      }
      else if (ev.type === 'fix') console.error('[' + t + '] ↺ #' + ev.id + ' 第 ' + ev.round + ' 轮回喂重试 ' + (ev.target || ''));
      else if (ev.type === 'regress') console.error('[' + t + '] ⇄ #' + ev.id + ' 回归对拍有变化（' + String(ev.detail || '').slice(0, 90) + '）');
    };
    const t0 = Date.now();
    // 派活前先记下三条客户端「最近」列表的现状，结束好做差集。
    // ORCH_GC=0 可关闭（排查会话问题时用）。
    const gcBase = process.env.ORCH_GC === '0' ? null : await snapshotBaseline();
    let out = null;
    try {
      // 分波次：任务带 deps 时按依赖图切层，逐层并行；不带 deps 时行为与原来完全一致。
      // 一把并行的代价是「下游基于空气写代码」，返工吃掉并行赚的全部收益。
      out = await runSwarmWaves(tasks, {
        mode: flags.mode, slots, resume: flags.resume, taskSource: src,
        land: flags.land, verify: flags.verify, maxFix: flags.maxFix, force: flags.force, deep: flags.deep, strictRegress: !!flags.strictRegress,
        land: flags.land, verify: flags.verify, maxFix: flags.maxFix, force: flags.force, deep: flags.deep,
        fast: flags.fast,
        dispatchFn: (text, extra) => dispatch('swarm', text, extra),
        onProgress,
      });
    } catch (e) {
      console.error('ESWARMFAIL ' + (e && e.message ? e.message : e));
      process.exit(3);
    }
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    const okN = out.results.filter(r => r.status === 'done').length;
    const rep = renderReport(src, out);
    console.error('[swarm] 完成 ' + okN + '/' + out.results.length + '，墙钟 ' + wall + 's，产物在 ' + out.dir);
    // 落盘 / 验收汇总：只有开了 --land 或 --verify 才有意义，没开就什么都不说（保持旧行为干净）
    if (flags.land || flags.verify) {
      const withV = out.results.filter((r) => r.verify);
      const vOk = withV.filter((r) => r.verify.ok);
      const written = out.results.filter((r) => r.land && (r.land.result === 'written' || r.land.result === 'need-force'));
      const needForce = out.results.filter((r) => r.land && r.land.result === 'need-force');
      if (flags.land) console.error('[swarm] 落盘 ' + written.length + '/' + out.results.length + ' 个文件' + (needForce.length ? '（' + needForce.length + ' 个已存在需 --force）' : ''));
      console.error('[swarm] 验收 ' + vOk.length + '/' + (withV.length || out.results.length) + ' 通过');
      for (const r of out.results) {
        const v = r.verify;
        if (!v) continue;
        const mark = v.ok ? '✓' : '✗';
        const bad = (v.checks || []).filter((c) => !c.ok).map((c) => c.name).join(',');
        console.error('  ' + mark + ' #' + r.id + ' ' + (v.target || '(无目标)') + (bad ? '  未过：' + bad : ''));
      }
    }
    // 纠错 AI：把落盘产物派给**异源**评审者挑错，REVISE 直接回流给产出者返工。
    // 与 --verify 的分工很硬：verify 只看形状（语法/规模/契约/导出名），
    // review 看「说的话对不对」—— 这正是 11-15 我自己错了两小时、要用户拿截图纠正的那类错。
    // 评审否决要给后果。没有后果的验收等于没验收 ——
    // 第一版这里只统计不判断，生成全 done 就 exit 0，评审全 REVISE 也照样 0，
    // 挂到 CI 上等于白挂。
    let reviewBlocked = 0;
    if (flags.review) {
      const cand = out.results.filter((r) => r.status === 'done' && r.landPath);
      if (!cand.length) {
        console.error('[review] 没有可评审的落盘产物（--review 要配合 --land，且产物得先过验收）');
      } else {
        console.error('[review] 评审 ' + cand.length + ' 个产物（异源；返工轮次上限 ' + flags.maxFix + '）');
        const rv = await reviewAndFix(
          cand.map((r) => ({ id: r.id, agent: r.agent, file: path.resolve(r.landPath) })),
          {
            dispatch: (text, extra) => dispatch('swarm', text, extra),
            onProgress: (ev) => {
              const t = new Date().toISOString().slice(11, 19);
              if (ev.type === 'review') console.error('[' + t + '] ⚖ #' + ev.id + ' ' + ev.reviewer + ' → ' + (ev.verdict || '未给裁决') + '（问题 ' + ev.issues + ' 条' + (ev.weak ? '，评审不合格' : '') + '）');
              else if (ev.type === 'fix') console.error('[' + t + '] ↺ #' + ev.id + ' 第 ' + ev.round + ' 轮返工完成，验收 ' + (ev.verifyOk ? '通过' : '未过'));
              else if (ev.type === 'warn') console.error('[' + t + '] ! ' + ev.msg);
            },
            maxRounds: flags.maxFix,
            reviewers: flags.reviewers || 0,
            reviewsDir: path.join(ROOT, 'reviews'),
          },
        );
        const accept = rv.filter((x) => x.verdict === 'ACCEPT').length;
        const revise = rv.filter((x) => x.verdict === 'REVISE').length;
        const none = rv.filter((x) => !x.verdict).length;
        const fixFailed = rv.filter((x) => x.reason === 'fix-failed').length;
        reviewBlocked = rv.filter((x) => !x.ok).length;
        console.error('[review] 裁决 ACCEPT ' + accept + ' / REVISE ' + revise + ' / 未给裁决 ' + none
          + (fixFailed ? ' / 返工未落地 ' + fixFailed : '')
          + (reviewBlocked ? '（未通过 ' + reviewBlocked + ' 个，批次判失败）' : ''));
      }
    }
    if (flags.out) {
      try { fs.writeFileSync(flags.out, rep, 'utf8'); console.error('[swarm] 报告已写入 ' + flags.out); } catch (e) { console.error('[swarm] 写报告失败：' + e.message); }
    } else {
      console.log(rep);
    }
    await gcAfterRun(gcBase);
    // 退出码要同时看两件事：活干完了没有，以及干出来的活过没过审。
    // 只看前者，评审就是摆饰。
    if (reviewBlocked) console.error('[swarm] 评审未通过 ' + reviewBlocked + ' 个产物，本批判失败');
    // 2026-11-16 修的第五个洞（附实测）：上面只看「任务 done」和「评审被否」，
    // 不看验收结果。实测：codebuddy 自写盘交付 docs/selfwrite-probe.md，
    // 落盘 1/1、验收 0/1（markdown 章节 0 个），进程却 exit 0 —— 挂 CI 等于白挂。
    // 验收没过必须有后果，和评审否决一样。
    const verifyFailed = out.results.filter((r) => r.status === 'done' && r.verify && r.verify.ok === false).length;
    if (verifyFailed) console.error('[swarm] 验收未过 ' + verifyFailed + ' 个，批次判失败');
    process.exit(okN === out.results.length && reviewBlocked === 0 && verifyFailed === 0 ? 0 : 1);
  }

  // ---- gc：清掉「派活留下的会话垃圾」 ----
  // 背景：每派一次活，客户端「最近」列表就多一条。Trae 条目级没有删除入口，
  // 豆包只能归档，WorkBuddy 能真删 —— 三条通道的能力不一样，这里分开处理。
  // 默认只清「能看出是派活痕迹」的标题，绝不碰用户自己的对话；--all 才清全部（跳过当前选中的）。
  if (cmd === 'gc') {
    const all = rest.includes('--all') || process.argv.includes('--all');
    const dry = rest.includes('--dry') || process.argv.includes('--dry');
    // Trae 的删除不可恢复，给一个可撤销的退路：--archive 改成归档
    const useArchive = rest.includes('--archive') || process.argv.includes('--archive');
    // 派活痕迹：Orchestra 派给 GUI 的提示词开头都很相似，客户端拿它当标题
    const PAT = /^(读取并执行任务|执行任务文件|只回复|回复两个字|回复收到|Write |Read and Execute|Execute Task|我来读取任务|我先读取任务)/;
    const { listWbSessions, deleteWbSession, listDoubao, archiveDoubaoAt, listTraeSessions, deleteTraeSession, archiveTraeSession } = await import('./lib/session_gc.mjs');
    let wb = [], db = [], tr = [];
    try { wb = await listWbSessions(); } catch (e) { console.error('[gc] WorkBuddy 没连上：' + e.message); }
    try { db = await listDoubao(); } catch (e) { console.error('[gc] 豆包没连上：' + e.message); }
    try { tr = await listTraeSessions(); } catch (e) { console.error('[gc] Trae 没连上：' + e.message); }

    const wbHit = wb.filter((s) => !s.selected && (all || PAT.test(s.title)));
    const dbHit = db.filter((s) => !s.active && (all || PAT.test(s.title)));
    // hasMore=false 的是当前选中的那条：⋯ 图标不渲染，菜单开不出来，跳过
    const trHit = tr.filter((s) => s.hasMore && (all || PAT.test(s.title)));
    const trStuck = tr.filter((s) => !s.hasMore && (all || PAT.test(s.title)));
    console.log('[gc] WorkBuddy 共 ' + wb.length + ' 条，命中 ' + wbHit.length + ' 条（真删）');
    for (const s of wbHit) console.log('      - ' + s.title.slice(0, 30));
    console.log('[gc] 豆包 共 ' + db.length + ' 条，命中 ' + dbHit.length + ' 条（归档）');
    for (const s of dbHit) console.log('      - ' + s.title.slice(0, 30));
    console.log('[gc] Trae 共 ' + tr.length + ' 条，命中 ' + trHit.length + ' 条（' + (useArchive ? '归档' : '真删') + '）');
    for (const s of trHit) console.log('      - ' + s.title.slice(0, 30));
    if (trStuck.length) console.log('[gc] Trae 另有 ' + trStuck.length + ' 条是选中态（⋯ 不渲染，先切到别的会话再来）');

    if (dry) { console.log('[gc] --dry 只列不删'); process.exit(0); }
    let wbOk = 0, dbOk = 0, trOk = 0;
    for (const s of wbHit) { const r = await deleteWbSession(s.id); if (r.ok) wbOk++; else console.error('[gc] 删失败「' + s.title.slice(0, 20) + '」：' + r.reason); }
    // 豆包按索引删，索引在过程中会变 → 每删一条重新取列表
    for (const s of dbHit) {
      const now = await listDoubao();
      const idx = now.findIndex((x) => x.title === s.title && !x.active);
      if (idx < 0) continue;
      const r = await archiveDoubaoAt(idx);
      if (r.ok) dbOk++; else console.error('[gc] 归档失败「' + s.title.slice(0, 20) + '」：' + r.reason);
    }
    for (const s of trHit) {
      const r = useArchive ? await archiveTraeSession(s.id) : await deleteTraeSession(s.id);
      if (r.ok) trOk++; else console.error('[gc] ' + (useArchive ? '归档' : '删') + '失败「' + s.title.slice(0, 20) + '」：' + r.reason);
      await new Promise((res) => setTimeout(res, 400));
    }
    console.log('[gc] 完成：WorkBuddy 删 ' + wbOk + '/' + wbHit.length + '，豆包归档 ' + dbOk + '/' + dbHit.length + '，Trae ' + (useArchive ? '归档 ' : '删 ') + trOk + '/' + trHit.length);
    process.exit(0);
  }

  // ---- top：吞吐看板。看清「并行到底省了多少」这件事，靠的是数字不是感觉。 ----
  // 关键指标是提速比 = 串行耗时之和 / 墙钟。低于 1.5 说明这一批并行没吃满（任务太少或分配不均）。
  if (cmd === 'top') {
    const runs = listRuns(Number(who) || 20);
    if (!runs.length) {
      console.log('还没有 swarm 批次。先跑一批：node orchestra.mjs swarm tasks.md');
      process.exit(0);
    }
    const pad = (s, n) => { const t = String(s); return t + ' '.repeat(Math.max(0, n - t.length)); };
    console.log('批次时间              任务  成功   墙钟      串行     提速  分配');
    let n = 0, ok = 0, wall = 0, serial = 0;
    for (const r of runs) {
      const when = new Date(r.endedAt || 0).toISOString().slice(5, 16).replace('T', ' ');
      const speed = r.wallMs ? (r.serialMs / r.wallMs) : 1;
      const plan = Object.entries(r.plan || {}).map(([k, v]) => k + '×' + v).join(' ');
      console.log(pad(when, 20) + pad(r.tasks, 6) + pad(r.ok, 6) + pad(fmtMs(r.wallMs), 10) + pad(fmtMs(r.serialMs), 9) + pad(speed.toFixed(2) + '×', 6) + plan);
      n += r.tasks; ok += r.ok; wall += r.wallMs || 0; serial += r.serialMs || 0;
    }
    console.log('');
    console.log('合计 ' + runs.length + ' 批 / ' + n + ' 个任务 / 成功 ' + ok + '（' + (n ? Math.round(ok / n * 100) : 0) + '%）');
    console.log('串行合计 ' + fmtMs(serial) + ' → 并行墙钟合计 ' + fmtMs(wall) + '，节省 ' + fmtMs(Math.max(0, serial - wall)) + '，平均提速 ' + (wall ? (serial / wall).toFixed(2) : '1.00') + '×');
    console.log('');
    console.log('提示：提速比低于 1.5 说明并行没吃满 —— 多半是任务太少、或全都落到了同一个慢 agent 上。');
    process.exit(0);
  }

  if (cmd === 'peek') {
    console.log(await agent.peek());
    process.exit(0);
  }

  if (cmd === 'eph') {
    // 注意 CLI 拆参：`eph add skill X` → cmd=eph, who=add, rest=['skill','X']
    // 所以参数组要把 who 拼回来，否则 sub 会变成 'skill'。
    const A = [who, ...rest].filter(x => x !== undefined);
    const sub = A[0] || 'list';
    const arg = (n) => { const i = A.indexOf(n); return i >= 0 ? A[i + 1] : null; };
    if (sub === 'list') {
      const items = ephList({});
      if (!items.length) { console.log('本会话没有临时能力。'); console.log('用法：eph add skill <名字> | eph add plugin <id> | eph add tool <名字> --file <路径> | eph add file <路径>'); process.exit(0); }
      for (const x of items) console.log(`${x.kind.padEnd(7)} ${x.name}  剩 ${x.leftMin} 分钟${x.file ? '  ' + x.file : ''}${x.note ? '  · ' + x.note : ''}`);
      process.exit(0);
    }
    if (sub === 'add') {
      const kind = A[1], name = A[2];
      if (!kind || !name) { console.error('用法：eph add <skill|plugin|tool|file> <名字> [--file 路径] [--note 说明] [--ttl 小时]'); process.exit(2); }
      const rec = ephAdd({ kind, name, file: arg('--file'), note: arg('--note') || '', ttlMs: arg('--ttl') ? Number(arg('--ttl')) * 3600 * 1000 : undefined });
      console.log(`已加入临时能力：${rec.kind} ${rec.name}（${Math.round((rec.expiresAt - Date.now()) / 60000)} 分钟后自动失效）`);
      process.exit(0);
    }
    if (sub === 'rm') { const n = ephRemove(A[1]); console.log(n ? `已移除 ${n} 条` : '没找到'); process.exit(0); }
    if (sub === 'clear') { console.log('已清除本会话 ' + ephClear({}) + ' 条'); process.exit(0); }
    if (sub === 'gc') { const n2 = ephGc(); const total = (typeof STARTUP_GC === 'number' ? STARTUP_GC : 0) + n2; console.log('清理过期 ' + total + ' 条' + (STARTUP_GC ? '（含启动时 ' + STARTUP_GC + ' 条）' : '')); process.exit(0); }
    if (sub === 'stat') { console.log(JSON.stringify(ephStats(), null, 2)); process.exit(0); }
    console.error('eph 子命令：list / add / rm / clear / gc / stat'); process.exit(2);
  }

  usage(); process.exit(2);
} catch (e) {
  console.error('ERR ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}


