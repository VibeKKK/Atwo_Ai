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
import { fileURLToPath } from 'node:url';
import { askTrae, peekTrae, meta as traeMeta } from './agents/trae.mjs';
import { askCodeBuddy, peekCodeBuddy, meta as cbMeta } from './agents/codebuddy.mjs';
import { readState, writeState, appendLog, readLog, setLastJob, buildContext } from './lib/memory.mjs';
import { brief as projectBrief } from './lib/project-memory.mjs';
import { JSON_CONTRACT, PROSE_CONTRACT, parseContract, renderContract, fallbackCode, isCodeTask } from './lib/contract.mjs';
import { withLock, withTimeout, listLocks } from './lib/lock.mjs';
import { check as budgetCheck, record as budgetRecord, report as budgetReport, usedToday } from './lib/budget.mjs';
import { start as prStart, finish as prFinish } from './pr.mjs';
import { loadTasks, buildBatchPrompt, splitResults } from './lib/batch.mjs';

const TASK_TIMEOUT_MS = Number(process.env.ORCH_TIMEOUT_MS || 240000);
const EST_INPUT = { codebuddy: 24848, trae: 0 };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = {
  trae: { ask: askTrae, peek: peekTrae, meta: traeMeta },
  codebuddy: { ask: askCodeBuddy, peek: peekCodeBuddy, meta: cbMeta },
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
  if (prose && !code) return { name: 'trae', why: '偏评审/解释' };
  if (code && prose) return { name: 'codebuddy', why: '代码+评审混合，代码优先（出码可直接用）' };
  return { name: 'trae', why: '默认走自然语言' };
}

/** trae 出代码必须带围栏，否则它渲染成单段落、缩进丢失。这里自动补一句。 */
function ensureFenceHint(name, prompt) {
  if (name !== 'trae') return prompt;
  const p = String(prompt || '');
  if (!CODE_HINTS.test(p)) return p;
  if (p.includes('```')) return p;
  return p + '\n\n（要求：用 markdown 代码块 ``` 输出代码，缩进必须是 4 个空格，不要行号。）';
}

const [cmd, who, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`Orchestra — AI 协作台
  ask <agent> "<prompt>"     派任务（自动附带共享工作记忆）
  ask auto "<prompt>"        按任务性质自动挑 agent（代码→codebuddy，评审/解释→trae）
  auto "<prompt>"            同上，更短的写法
  review <agent> <file>      让对方审文件，评审存进 reviews/
  duo <agentA> <agentB> "p"  同题并行派给两个 agent，对比耗时与产出
  batch <agent> <任务源>      N 个小任务压进一次调用（省掉 N-1 份固定开销）
                             任务源：tasks.md 文件 / "甲|||乙|||丙" / - 开头的行
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
  for (const [k, v] of Object.entries(REGISTRY)) {
    console.log(`${k}\t${v.meta.kind}\t${v.meta.transport}:${v.meta.port}\t${v.meta.strengths.join(' / ')}`);
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
    const cbCli = path.join(process.env.USERPROFILE || 'C:\Users\kkk', 'Tools', 'codebuddy-cli', 'package', 'bin', 'codebuddy');
    const cbOk = fs.existsSync(cbCli) || fs.existsSync(cbCli + '.cmd') || fs.existsSync(cbCli + '.cmd');
    console.log('agent	通道	活着	今天已用	剩次数');
    const locks = listLocks();
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

const needsAgent = cmd !== 'duo' && cmd !== 'stats' && cmd !== 'auto' && cmd !== 'pick';
let agent = REGISTRY[who];
let effectiveWho = who;
let autoWhy = '';
if (needsAgent && who === 'auto') {
  const p = rest.join(' ');
  const pick = pickAgent(p);
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
  let tail = buildContext();
  if (project) {
    try {
      const b = projectBrief(project, { slim: true });
      if (b && !b.missing && b.slim) tail += `\n\n[项目接续 · ${b.name}]\n${b.slim}\n[/项目接续]\n`;
    } catch { /* 项目没注册就静默跳过，不挡派活 */ }
  }

  // 契约：代码活用 code 契约、其余用 answer 契约。散文也要 —— 否则 Trae 的页面 diff
  // 会把「@ 添加上下文」「完全访问」这类 UI 文案算进回答（实测污染过一次）。
  const codeTask = isCodeTask(rawPrompt);
  const wantContract = extra.contract ?? (process.env.ORCH_NO_CONTRACT !== '1');
  const base = ensureFenceHint(name, rawPrompt) + tail;
  const prompt = wantContract ? base + (codeTask ? JSON_CONTRACT : PROSE_CONTRACT) : base;

  // 闸门：先问预算，超了直接拒，别浪费一次调用
  const gate = budgetCheck(name, EST_INPUT[name] || 0);
  if (!gate.ok) {
    const e = new Error(gate.reason);
    e.code = 'EBUDGET';
    throw e;
  }

  const t0 = Date.now();
  let r = null, err = null, contract = null, retried = false;

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

  const runOnce = (p) => withLock(name, () => withTimeout(
    () => ag.ask(p, { timeoutMs: TASK_TIMEOUT_MS }),
    TASK_TIMEOUT_MS + 20000, name
  ), {
    onWait: (info) => console.error(`[队列] ${name} 正忙（pid=${info.held && info.held.pid}），排队等待…`),
  });

  try {
    r = await runOnce(prompt);
  } catch (e) {
    err = e;
    r = e.partial || null;
  }

  if (wantContract && r && r.ok) {
    contract = parseContract(r.addedText || '');
    if (!contract.ok && process.env.ORCH_NO_RETRY !== '1') {
      retried = true;
      const stricter = prompt + '\n\n[重试] 上一次输出无法被 JSON.parse 解析。这次只输出 JSON 对象本身，不要任何解释文字。';
      try {
        const r2 = await runOnce(stricter);
        if (r2 && r2.ok) { r = r2; contract = parseContract(r2.addedText || ''); }
      } catch (e2) { /* 重试失败就用第一次的原文兜底 */ }
    }
  }

  const usage = (r && r.usage) || {};
  if (r || err) {
    // 各适配层字段不统一：codebuddy 给 {in,out}，有的给 snake_case —— 这里一次归一
    const tokIn = usage.input_tokens ?? usage.inputTokens ?? usage.in ?? usage.prompt_tokens ?? 0;
    const tokOut = usage.output_tokens ?? usage.outputTokens ?? usage.out ?? usage.completion_tokens ?? 0;
    budgetRecord(name, { input: tokIn, output: tokOut, ok: !!(r && r.ok) });
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
  if (wantContract) entry.contract = contract ? (contract.ok ? 'ok' : contract.reason) : 'skipped';
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
    }
  }

  appendLog(entry);
  try { setLastJob(entry); } catch { }

  if (err) {
    if (r && r.addedText) console.log(renderOut(r, contract));
    throw err;
  }
  return { ...r, contract };
}

/** 统一渲染：契约成功就出干净内容，失败就出原文（并标注）。 */
function renderOut(r, contract) {
  if (contract && contract.ok) return renderContract(contract.data);
  const raw = (r && r.addedText) || '';
  if (contract && !contract.ok) {
    const fb = fallbackCode(raw);
    if (fb) return fb + `\n\n[契约失败: ${contract.reason} · 已降级为原文提取]`;
  }
  return raw || '(没有拿到新增文本)';
}

try {
  if (cmd === 'ask') {
    const prompt = rest.join(' ').trim();
    if (!prompt) { console.error('prompt 不能为空'); process.exit(2); }
    const r = await dispatch('ask', prompt);
    console.log(renderOut(r, r.contract));
    process.exit(0);
  }

  if (cmd === 'review') {
    const file = rest[0];
    if (!file) { console.error('要指定文件'); process.exit(2); }
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) { console.error('文件不存在: ' + abs); process.exit(2); }
    const base = path.basename(abs);
    const content = fs.readFileSync(abs, 'utf8').slice(0, 12000);
    const r = await dispatch('review', REVIEW_PROMPT(base, content), { summary: '评审 ' + base });

    const outDir = path.join(ROOT, 'reviews');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${who}-review-${base}-${nowStr()}.md`);
    fs.writeFileSync(outFile,
      `# ${who} 评审：${base}\n\n- 时间：${new Date().toLocaleString('zh-CN')}\n- 耗时：${((r.elapsedMs || 0) / 1000).toFixed(1)}s\n\n---\n\n${r.addedText || '(空)'}\n`, 'utf8');
    console.log(renderOut(r, r.contract));
    console.log('\n[saved] ' + outFile);
    process.exit(0);
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
    process.exit(okCount ? 0 : 1);
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
    console.log(renderOut(r, r.contract));
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
    try {
      raw = String(await withLock(agentName, () => withTimeout(
        () => ag.ask(prompt, { timeoutMs: TASK_TIMEOUT_MS }),
        TASK_TIMEOUT_MS + 20000, agentName,
      ), { onWait: () => console.error('[队列] ' + agentName + ' 正忙，排队等待…') }) || '');
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
      budgetRecord(agentName, { input: B, output: Math.ceil(raw.length / 4), ok });
      appendLog({
        at: new Date().toISOString(), kind: 'batch', agent: agentName, ok,
        promptSummary: `[batch ${tasks.length} 项] ` + String(tasks[0]).slice(0, 40),
        chars: raw.length, secs: Number(secs), items: items.length,
      });
    } catch { /* 记账失败不挡结果 */ }
    process.exit(0);
  }

  if (cmd === 'peek') {
    console.log(await agent.peek());
    process.exit(0);
  }

  usage(); process.exit(2);
} catch (e) {
  console.error('ERR ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
