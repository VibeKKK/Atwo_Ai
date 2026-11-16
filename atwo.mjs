#!/usr/bin/env node
/**
 * atwo — 五个动词管住整套工作流。
 *
 * 它自己不实现派活、验收、评审：只做三件事 ——
 *   1) 转发给 orchestra.mjs / .atw 脚本
 *   2) 检查前置条件（没有 in-progress 任务就不许派活）
 *   3) 把结果说成人话
 *
 * 老命令一个都没删，全部还能用：atwo raw <原命令> 直接转过去。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { discoverVotes as discoverReviewVotes } from './lib/review-feed.mjs';
import { parseLines, progressLine, classifyLine, decideAbort, summarizeRun } from './lib/supervise.mjs';
import { judgeVotes } from './vm/votes.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { groupByBehavior, splitByBehavior, renderDecisions } from './lib/divergence.mjs';
import { ledgerLine } from './lib/ledger.mjs';
import { summarize } from './lib/report.mjs';
import { quotaRecord, appendQuota } from './lib/quota-log.mjs';
import { makeFanoutVerb } from './lib/fanout-cli.mjs';
import { VERBS, GLOBAL_FLAGS, EXIT_CODES, LIMITS, isHelp, checkFlags, positional, specOf, formatSpec, capsJson, valueFlagsOf } from './lib/cli-spec.mjs';
import { detectEnvironment, quickSelfCheck } from './lib/bootstrap.mjs';
import { shouldDelegate, formatShould } from './lib/should.mjs';
import { runGate, formatGate } from './lib/gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 三个环境变量是测试缝（与 ATWO_TASKS_DIR 同一个理由）：测试要造「日志不可写」「假 orchestra」，
// 真去动 memory/log.jsonl 与界面既破坏性又慢。不设时行为与以前完全一致。
const ORCH = process.env.ATWO_ORCH || path.join(HERE, 'orchestra.mjs');
const ATW = path.join(HERE, '.atw');
const TASK_PY = path.join(ATW, 'scripts', 'task.py');
// 允许指向别的目录：测试要复现「一条任务都没有」的状态，真去清空 .atw/tasks 是破坏性的。
const TASKS_DIR = process.env.ATWO_TASKS_DIR || path.join(ATW, 'tasks');
const ACCEPT = path.join(HERE, 'packages', 'accept', 'bin', 'accept.mjs');
const LOG = process.env.ATWO_LOG || path.join(HERE, 'memory', 'log.jsonl');
const MODE_FILE = process.env.ATWO_MODE_FILE || path.join(ATW, 'mode.json');

const STAGE = {
  discover: '想清楚要做什么',
  specify: '需求文档写好了，等你看一眼',
  slice: '正在拆任务',
  implement: '正在做',
  accept: '做完了，等你验收',
  completed: '已经完成',
};

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    // JSON_MODE 时必须 capture：spawnSync 用 stdio:'inherit' 时子进程直接写继承的文件描述符，
    // 完全绕过 Node 的 process.stdout.write 包装 —— 实测把 write 换成 ()=>true 之后，
    // 子进程的 123 照样出现在终端上。结果就是 atwo 的 --json 出口被架空：
    // `atwo raw stats --json` 打出来的是表格，不是 JSON。
    stdio: (opts.capture || JSON_MODE) ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    cwd: opts.cwd || HERE,
    // crazy 档要改超时、禁缓存，只能通过环境变量传给 orchestra。
    // 不传 env 时 spawnSync 继承父进程，行为与以前完全一致。
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  return { code: r.status == null ? 1 : r.status, out: r.stdout || '', err: r.stderr || '' };
}

// 本机 bash 里没有 python3 别名，必须 py -3
const py = (args, opts) => sh('py', ['-3', ...args], opts);
const orchestra = (args, opts = {}) => {
  const r = sh(process.execPath, [ORCH, ...args], { cwd: HERE, ...opts });
  // capture 模式下子进程的输出进的是 r.out/r.err，不转写就彻底丢了（终端上一个字都看不到）。
  // JSON 模式下 process.stdout.write 已被接管，这两行会落进 RESULT.log。
  if (JSON_MODE || opts.capture) {
    if (r.out) process.stdout.write(r.out);
    if (r.err) process.stderr.write(r.err);
  }
  return r;
};

// 派活守护（2026-11-16）：一次派活可能几分钟。以前用 spawnSync，跑完才回话——
// 中途某一路已经死了、或者整批卡住，人只能干等（实测一次 15 分钟零输出）。
// 这里改成流式：每一行都带上「跑了多久」，并且用 supervise 的三条判断决定要不要提前收尾。
// 环境变量 ATWO_GO_DEADLINE_MS 可改总上限（默认 15 分钟）。
function orchestraSupervised(argv, opts = {}) {
  return new Promise((resolve) => {
    const deadlineMs = Number(process.env.ATWO_GO_DEADLINE_MS) || 900000;
    const expected = Number(opts.expected) || 1;
    const startedAt = Date.now();
    const channels = [];
    let buf = '';
    let lastLine = '';
    let sawReview = false;
    let aborted = false;
    let abortReason = '';

    const child = spawn(process.execPath, [ORCH, ...argv], {
      cwd: HERE,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // orchestra 有两种写法，都得认：
    //   进度行  `[02:56:52] ✓ #1 codebuddy 103ms`（标记在前）
    //   报告头  `## #1  ✓  codebuddy  98ms`（标记在后）
    // 而且验收行 `  ✓ #1 lib/probe_add.mjs` 也长这样，所以只认计划内的通道名，别把文件名当通道。
    const laneSet = new Set(opts.lanes || []);
    const noteChannel = (text) => {
      // 必须用正则找 #N：报告头是 markdown 的 `## #1  ✓  codebuddy`，
      // 用 indexOf('#') 会命中 `##`，把 '##' 当成通道名（实测就是这么漏的）。
      const m = /#(\d+)/.exec(text);
      if (!m) return;
      const ok = text.includes('✓') && !text.includes('✗');
      const after = text.slice(m.index + m[0].length).replace(/[✓✗]/g, ' ').trim();
      const name = (after.split(/\s+/)[0] || '');
      if (!laneSet.has(name)) return;
      if (channels.some((c) => c.name === name)) return;
      // 报告头 `## #1  ✓  codebuddy  98ms` 自带耗时；额度账本按路记账要它（拿不到就是 0）
      const dm = /(\d+(?:\.\d+)?)\s*(ms|s)\b/.exec(after);
      const elapsedMs = dm ? Math.round(Number(dm[1]) * (dm[2] === 's' ? 1000 : 1)) : 0;
      channels.push({ name, ok, reason: ok ? '' : (text.trim().split(/\s+/).pop() || '失败'), elapsedMs });
    };

    const handleLine = (line) => {
      if (!line.trim()) return;
      lastLine = line;
      // 颜色码会把「✓ #1 xxx」拆成 ✓+ESC+#…，直接拿原文匹配会一条都认不出来（实测 0/0 路成功）。
      const plain = line.replace(/\u001b\[[0-9;]*m/g, '');
      const kind = classifyLine(plain);
      if (kind === 'review') sawReview = true;
      noteChannel(plain);
      if (JSON_MODE) return;
      // 有意义的行加时间戳，噪音行原样透传（否则 orchestra 的表格会被拆得看不出结构）
      if (kind === 'noise') process.stdout.write(line + '\n');
      else process.stdout.write(progressLine({ elapsedMs: Date.now() - startedAt, text: line }) + '\n');
    };

    const checkAbort = () => {
      if (aborted) return;
      const d = decideAbort({
        elapsedMs: Date.now() - startedAt,
        deadlineMs,
        lastLine,
        channels,
        expectedChannels: expected,
        sawReview,
      });
      if (!d.abort) return;
      aborted = true;
      abortReason = d.reason;
      if (!JSON_MODE) {
        process.stdout.write('\n' + progressLine({ elapsedMs: Date.now() - startedAt, text: '⛔ ' + d.reason + ' —— 提前收尾' }) + '\n');
      }
      child.kill('SIGTERM');
      // orchestra 有子进程（GUI 通道），SIGTERM 未必一次收干净
      const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, 3000);
      if (force.unref) force.unref();
    };

    const timer = setInterval(checkAbort, 1000);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (chunk) => {
      const cut = parseLines(buf + chunk.toString());
      buf = cut.rest;
      for (const line of cut.lines) { handleLine(line); checkAbort(); }
    });
    child.stderr.on('data', (chunk) => {
      if (!JSON_MODE) process.stderr.write(chunk.toString());
    });
    child.on('error', () => {
      clearInterval(timer);
      resolve(EXIT.channel);
    });
    child.on('close', (code) => {
      clearInterval(timer);
      if (buf) handleLine(buf);
      const elapsedMs = Date.now() - startedAt;
      const s = summarizeRun({ channels, elapsedMs });
      // 一路都没认出来（比如 orchestra 换了输出格式）时不许谎报 0/0，只报「完成」与耗时。
      // 被守护掐掉的，不能说「完成」——那是撒谎。
      let text;
      if (aborted) text = '已中止（' + abortReason + '）· 用时 ' + (elapsedMs / 1000).toFixed(1) + 's';
      else if (s.total === 0) text = '完成 · 用时 ' + (elapsedMs / 1000).toFixed(1) + 's';
      else text = s.text;
      if (!JSON_MODE) process.stdout.write('\n' + progressLine({ elapsedMs, text }) + '\n');
      RESULT.data.run = { channels, elapsedMs, aborted };
      if (aborted) return resolve(EXIT.channel);
      resolve(code == null ? EXIT.channel : code);
    });
  });
}

// 退出码表（定死，别让调用方靠读文案猜）：
//   0 成功 / 2 用法错 / 3 前置不满足 / 4 验收不过 / 5 通道错 / 6 预算超
const EXIT = { ok: 0, usage: 2, precondition: 3, accept: 4, channel: 5, budget: 6 };

function die(msg, code = 2) {
  console.log(msg);
  return code;
}

// ─────────────────────────── 运行档位 ───────────────────────────

/**
 * 三档。**strict 是默认，而且不靠文件存在**：
 * .atwo/mode.json 不存在 = strict。默认值一旦依赖「建过档」，
 * 换机器 / 清目录 / 重装之后就丢了，而那时候没人会记得回来补。
 */
const MODES = {
  strict: { name: 'strict', label: '按任务量', hint: '小活少派、大活全押' },
  crazy: { name: 'crazy', label: '不计消耗', hint: '四路全上 + 三评审 + 返工三轮 + 禁缓存' },
  off: { name: 'off', label: '流程关闭', hint: '只转发，不拦' },
};

/** size 决定闸门硬度。S 单路不评、M 两路一评、L 四路两评。 */
const SIZE_PLAN = {
  S: { lanes: ['codebuddy'], review: 0 },
  M: { lanes: ['codebuddy', 'trae'], review: 1 },
  L: { lanes: null, review: 2 }, // null = 四路全上
};

const CRAZY_PLAN = { lanes: null, review: 3, maxFix: 3 };

function readMode() {
  try {
    const j = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    if (j && MODES[j.mode]) return { ...MODES[j.mode], since: j.since || null, by: j.by || null };
  } catch { /* 文件不存在 / 坏掉，都回 strict —— 这才是「装上就生效」 */ }
  return { ...MODES.strict, since: null, by: null };
}

function writeMode(name) {
  fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true });
  const body = { mode: name, since: new Date().toISOString(), by: process.env.ATWO_BY || 'dsh' };
  fs.writeFileSync(MODE_FILE, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return body;
}

/** 从 args 里抠「带值开关」，抠掉的部分不再当成位置参数。 */
function takeOpt(args, name) {
  const rest = [];
  let val = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) { val = args[i + 1] == null ? '' : args[i + 1]; i++; continue; }
    if (a.startsWith(name + '=')) { val = a.slice(name.length + 1); continue; }
    rest.push(a);
  }
  return { val, rest };
}

function cmdMode(args) {
  if (!args.length) {
    const m = readMode();
    console.log('当前档位  ' + m.name + ' · ' + m.label);
    if (m.name === 'strict') {
      console.log('生效方式  默认档，没有 mode.json 就是这个（不需要任何操作）');
    } else {
      console.log('切换时间  ' + (m.since || '（未知）') + (m.by ? '  由 ' + m.by : ''));
    }
    console.log('这一档    ' + m.hint);
    console.log('');
    if (m.name === 'strict') {
      console.log('按任务量派活：S 单路不评 / M 两路一评 / L 四路两评');
      console.log('切档：atwo mode crazy    不计消耗');
      console.log('      atwo mode off      这次别走流程');
    } else if (m.name === 'crazy') {
      console.log('派活：四路全上 · 评审 3 个 · 返工最多 3 轮 · 超时 ×1.5 · 禁缓存');
      console.log('回去：atwo mode strict');
    } else {
      console.log('派活：直接转发给 orchestra，不检查任务记录');
      console.log('回去：atwo mode strict');
    }
    return 0;
  }
  const want = String(args[0]).toLowerCase();
  if (!MODES[want]) {
    return die([
      '不认识的档：' + args[0],
      '',
      '三个合法值：',
      '  strict   按任务量（默认）',
      '  crazy    不计消耗',
      '  off      暂时关闭',
    ].join('\n'));
  }
  const body = writeMode(want);
  console.log('✓ 已切到 ' + want + ' · ' + MODES[want].label);
  console.log('  ' + MODES[want].hint);
  console.log('  记在 .atwo/mode.json（' + body.since + '）');
  console.log('  回去：atwo mode strict');
  return 0;
}

function listTasks() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(TASKS_DIR)) {
    const f = path.join(TASKS_DIR, name, 'task.json');
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.status === 'completed') continue;
      out.push({ dir: path.join(TASKS_DIR, name), json: f, ...j });
    } catch { /* 坏文件跳过，不让它拖垮整个列表 */ }
  }
  // updatedAt 只到「天」（实测两个任务都是 "2026-11-16"），同一天里排不出先后，
  // 于是 activeTask 会稳定地选错 —— 派活就派到上一件活的账上。
  // createdAtMs 是我们自己写的毫秒时间戳，能区分；没有它时退回字符串比较。
  return out.sort((a, b) => {
    const am = Number(a.createdAtMs || 0), bm = Number(b.createdAtMs || 0);
    if (am !== bm) return am - bm;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
}

/**
 * 正在做的那个：implement 优先，其次 accept。
 * 同类里取**最新建的那个** —— 取第一个会把一周前的旧任务当成当前任务，
 * 实测 `atwo state` 曾因此显示 11-15-review-fallback 而不是刚建的 atwo-v1。
 */
function activeTask() {
  const list = listTasks();
  const pick = (st) => { const x = list.filter((t) => t.status === st); return x.length ? x[x.length - 1] : null; };
  return pick('implement') || pick('accept') || null;
}

function lastLog(n = 1) {
  if (!fs.existsSync(LOG)) return [];
  try {
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n');
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function usage() {
  // 动词表从 lib/cli-spec.mjs 生成，不在这里手写第二份 ——
  // 手写过一次，就漂了：usage 承诺「加 --help 看每个动词的参数」，
  // 而代码里根本没有分动词 help，--help 被 fanout 当成任务真派出去了三个子会话。
  const L = [];
  L.push('atwo — 给 AI 用的编排 CLI。人只看结论，机器只读 --json。');
  L.push('');
  L.push('先自学（不花钱、不派活）：');
  L.push('  atwo caps --json            全部动词 + 参数 + 退出码 + 上限，一屏 JSON');
  L.push('  atwo help <动词> [--json]   单动词完整规格');
  L.push('');
  L.push('动词（代价决定你敢不敢随手敲）：');
  for (const [k, v] of Object.entries(VERBS)) {
    const cost = v.cost === 'spawn' ? '[派活·花钱]' : v.cost === 'io' ? '[本地·免费]' : '[不动]    ';
    L.push('  atwo ' + k.padEnd(7) + cost + ' ' + v.summary);
  }
  L.push('');
  L.push('档位（.atwo/mode.json 不存在 = strict，装上就生效）：');
  L.push('  strict   按任务量：S 单路不评 / M 两路一评 / L 四路两评');
  L.push('  crazy    不计消耗：四路全上 · 评审 3 个 · 返工 3 轮 · 超时 ×1.5 · 禁缓存');
  L.push('  off      只转发，不检查任务记录');
  L.push('');
  L.push('全局开关：' + Object.entries(GLOBAL_FLAGS).map(([k, d]) => k + '（' + d + '）').join(' · '));
  L.push('上限：parts ≤ ' + LIMITS.maxParts + ' · timeout 默认 ' + LIMITS.defaultTimeoutMs + 'ms · 自愈 ≤ ' + LIMITS.maxFixRounds + ' 轮');
  L.push('');
  L.push('退出码（机器判成败只看这个，不要靠读文案）：');
  for (const [c, d] of Object.entries(EXIT_CODES)) L.push('  ' + c + '  ' + d);
  L.push('');
  L.push('铁律：-h / --help / help 在任何位置都只是求助，不会变成任务文本；不认识的参数一律退出 2。');
  console.log(L.join(String.fromCharCode(10)));
}

function cmdNew(args) {
  const { val: sizeRaw, rest } = takeOpt(args, '--size');
  // 不给 --size 就是 M：绝大多数任务是一个模块 / 一份文档，M 的两路一评正对
  const size = sizeRaw == null || sizeRaw === '' ? 'M' : String(sizeRaw).toUpperCase();
  if (!SIZE_PLAN[size]) return die('--size 只能是 S / M / L（收到 ' + sizeRaw + '）');
  const title = rest.join(' ').trim();
  if (!title) return die('用法：atwo new "一句话说清你要做什么" [--size S|M|L]');
  const slug = 'atwo-' + Date.now().toString(36).slice(-6);
  const r = py(['.atw/scripts/task.py', 'create', title, '--slug', slug, '-p', 'P1', '--no-start', '-d', title], { capture: true });
  if (r.code !== 0) return die('建任务失败：' + (r.err.trim() || r.out.trim()));
  const m = r.out.match(/\.atw[\/\\]tasks[\/\\]([^\s]+)/);
  const taskId = m ? m[1] : slug;

  // size 写进 task.json —— 存文件而不是每次问，是因为「按任务量」必须可复现：
  // 明天再来跑同一个任务，不该因为记不清而换了档位。
  try {
    const jf = path.join(TASKS_DIR, taskId, 'task.json');
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
    j.size = size;
    // task.py 的 createdAt 只精确到天，同一天建两个任务就分不出先后；
    // listTasks 排序靠它，选错会让派活的账记到上一件活身上。
    j.createdAtMs = Date.now();
    fs.writeFileSync(jf, JSON.stringify(j, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.log('（size 没写进 task.json，本次按 ' + size + ' 走：' + e.message + '）');
  }

  const sp = SIZE_PLAN[size];
  console.log('✓ 建好了：' + taskId + '   [' + size + ' 档 → ' + (sp.lanes ? sp.lanes.length : 4) + ' 路'
    + (sp.review ? ' + 评审 ' + sp.review : '，不评') + ']');
  console.log('');
  console.log('下一步二选一：');
  console.log('  · 直接开工：atwo go .atw/tasks/' + taskId + '/prd.md');
  console.log('  · 先写清需求再开工（推荐，返工最少）：编辑 .atw/tasks/' + taskId + '/prd.md');
  console.log('');
  console.log('档位不对：atwo new "..." --size S|M|L （S 单函数 / M 一个模块 / L 多文件）');
  return 0;
}

/**
 * 派活结束后记一行账。
 * 失败绝不影响主流程：账本没写成是可惜，把已经跑完的活搞崩是事故。
 */
function writeLedger(task, code) {
  try {
    const entry = lastLog(1)[0] || null;
    const plan = ledgerLine({ task, entry, code });
    // 决定日志要求「先 start 再 add」：没有 start 行时 add 会直接 exit 2
    // （实测原文：错误：日志还没有：这次对话先跑 start（带 --lang））
    const td = ['--task-dir', path.relative(HERE, task.dir).replace(/\\/g, '/')];
    // --session 显式传身份名：ATW 取不到对话编号时会自己猜，猜不到就报警「别的对话插写」（Q2）
    const sd = ['--session', 'dsh-lead'];
    py(['.atw/scripts/decision_log.py', 'start', '--lang', 'zh', ...td, ...sd], { capture: true });
    const args = ['.atw/scripts/decision_log.py', ...plan.args, ...td, ...sd];
    if (plan.mark) args.push('--mark', plan.mark);
    const r = py(args, { capture: true });
    if (r.code === 0) {
      console.log('');
      // 不在这里说「成功」：成败由 memory/log.jsonl 判定，决定日志只记人的判断（Q2）
      console.log('已记账：决定日志一行' + (plan.abnormal ? '（等你确认）' : '') + '；成败以 memory/log.jsonl 为准');
    } else {
      console.log('');
      console.log('记账没写成（结果不受影响）：' + (r.err.trim() || r.out.trim()).slice(0, 200));
    }
  } catch (e) {
    console.log('');
    console.log('记账异常（结果不受影响）：' + e.message);
  }
}

const ALL_LANES = ['codebuddy', 'trae', 'workbuddy', 'doubao'];
const DEFAULT_TIMEOUTS = {
  ORCH_TIMEOUT_TRAE: 120000,
  ORCH_TIMEOUT_DOUBAO: 120000,
  ORCH_TIMEOUT_WORKBUDDY: 300000,
  ORCH_TIMEOUT_CODEBUDDY: 300000,   // 2026-11-16 产物优先：180s 太紧，实测 177.2s 写完却被判超时
};

async function cmdGo(args) {
  const mode = readMode();
  const { val: sizeRaw, rest: rest1 } = takeOpt(args, '--size');
  // --plan 只算参数不派活：四路全上的 crazy 真跑一次几分钟，验证档位不该花这个钱
  const planOnly = rest1.includes('--plan');
  const src = rest1.filter((a) => !a.startsWith('--'));
  // --agent 不透传：路数由档位决定。放行它会让「本次：N 路」这行打印与真实参数对不上，
  // 而用户唯一能核对的就是那行（PRD R6）。
  const passThrough = rest1.filter((a) => a.startsWith('--') && !a.startsWith('--agent') && a !== '--plan');

  const t = activeTask();
  if (!t && mode.name !== 'off') {
    return die([
      '现在没有正在做的任务 —— 不会替你派活。',
      '',
      '先建一个：atwo new "把你想让它做的事说成一句话"',
      '（这是故意的：没有任务记录就派活，出了问题查不到任何痕迹）',
      '',
      '确实不想走流程：atwo mode off（只影响这一次之后的派活）',
    ].join('\n'), EXIT.precondition);
  }
  if (!src.length) {
    return die([
      '任务：' + (t ? t.title : '（没有进行中的任务）'),
      '',
      '用法：atwo go <任务源> [--size S|M|L]',
      '  任务源可以是一个 .md（每段 # N 标题是一个独立任务），也可以是一句话。',
      t ? '  例：atwo go ' + path.relative(HERE, path.join(t.dir, 'prd.md')).replace(/\\/g, '/') : '',
    ].filter(Boolean).join('\n'));
  }

  let size = sizeRaw ? String(sizeRaw).toUpperCase() : '';
  if (size && !SIZE_PLAN[size]) return die('--size 只能是 S / M / L（收到 ' + sizeRaw + '）');
  if (!size) size = t && t.size ? String(t.size).toUpperCase() : 'M';
  if (!SIZE_PLAN[size]) size = 'M';

  const plan = mode.name === 'crazy' ? CRAZY_PLAN : SIZE_PLAN[size];
  const lanes = plan.lanes || ALL_LANES;

  const env = {};
  if (mode.name === 'crazy') {
    // 缓存命中意味着这一路没有真的重做一遍；上一轮被污染的产物缓存下来，crazy 也救不回来
    env.ORCH_NO_CACHE = '1';
    for (const [k, d] of Object.entries(DEFAULT_TIMEOUTS)) {
      const cur = process.env[k] ? Number(process.env[k]) : d;
      env[k] = String(Math.round(cur * 1.5));
    }
  }

  const argv = ['swarm', src[0], '--agent', lanes.join(','), '--land', '--verify', '--force'];
  if (plan.review > 0) {
    argv.push('--review');
    // swarm 的参数解析只认白名单，--by-multi 是 review 命令专用的 —— 这里必须用 --reviewers
    if (plan.review > 1) argv.push('--reviewers', String(plan.review));
  }
  if (plan.maxFix) argv.push('--max-fix', String(plan.maxFix));
  argv.push(...passThrough);

  // 按档位换模型（2026-11-16）。四路真能切的只有 workbuddy（点界面）与 codebuddy（--model）；
  // trae / doubao 的入口在哪都不存在（trae 的下拉是 Electron 原生菜单，改 state.vscdb 不生效；
  // 豆包客户端根本不暴露模型选择）。切不动只记一行，绝不阻断派活。
  const { tierFor, renderTierLine, applyTier } = await import('./lib/models.mjs');
  const tier = tierFor(mode.name, size);

  // R6：这三行是用户唯一能核对「花了多少、开了几道闸」的地方，必须与 argv 完全一致
  console.log('▶ 任务：' + (t ? t.title : '（无任务记录 · 流程已关闭）'));
  console.log('▶ 档位：' + mode.name + (mode.name === 'strict' ? ' · ' + size : '') + ' · ' + mode.label);
  console.log('▶ 本次：' + lanes.length + ' 路（' + lanes.join(', ') + '）· 验收五层 · '
    + (plan.review > 0 ? '评审 ' + plan.review + ' 个' : '不评')
    + (mode.name === 'crazy' ? ' · 超时 ×1.5 · 禁缓存' : ''));

  if (planOnly) {
    console.log(renderTierLine(tier));
    console.log('');
    console.log('（--plan：只算参数，没派活，也不碰界面）');
    console.log('  ' + [process.execPath.split(path.sep).pop(), 'orchestra.mjs', ...argv].join(' '));
    if (Object.keys(env).length) console.log('  env: ' + JSON.stringify(env));
    return 0;
  }

  // 真跑才切。plan 模式上面已经 return，界面一个像素都不动。
  const mt = await applyTier(tier, {
    agents: lanes,
    switchModel: async (agent, model) => {
      const m = await import('./agents/' + agent + '.mjs');
      if (typeof m.setModel !== 'function') return { ok: false, reason: '适配层还没有 setModel' };
      return m.setModel(model);
    },
  });
  console.log(renderTierLine(tier));
  for (const f of mt.failed) console.log('  · ' + f.agent + ' 没切成：' + f.reason);
  for (const w of mt.warnings) console.log('  · ' + w);
  Object.assign(env, mt.env);
  console.log('');

  const code = await orchestraSupervised(argv, { env, expected: lanes.length, lanes });
  RESULT.data.agents = lanes;
  RESULT.data.argv = argv;
  RESULT.data.channelExit = code;
  if (t) writeLedger(t, code);

  // 额度账本：一路一条，写完才算「这次派活花了多少分」有据可查。
  // 账写不进去是可惜，把已经跑完的活搞崩是事故 —— 所以整段 try 住，只打一行。
  const quota = [];
  try {
    const run = RESULT.data.run || {};
    const channels = Array.isArray(run.channels) ? run.channels : [];
    // 模型只认「真的切成了的」：切不动（或流程关闭）一律空串，不拿计划里的值冒充实际值。
    const appliedBy = new Map((mt.applied || []).map((x) => [x.agent, x.model]));
    for (const lane of lanes) {
      const c = channels.find((x) => x && x.name === lane) || null;
      quota.push(quotaRecord({
        agent: lane,
        model: appliedBy.get(lane) || '',
        ok: c ? c.ok === true : false,
        elapsedMs: c ? c.elapsedMs || 0 : 0,
      }));
    }
    RESULT.data.quota = quota;
    for (const rec of quota) appendQuota(LOG, rec);
  } catch (e) {
    RESULT.data.quota = quota;
    console.log('! 额度账本写入失败：' + (e && e.message ? e.message : String(e)));
  }
  return code;
}

function cmdCheck(args) {
  if (!fs.existsSync(ACCEPT)) return die('没找到 packages/accept/bin/accept.mjs —— 验收器不在，先确认仓库完整。');
  if (!args.length) {
    return die([
      '用法：atwo check <文件> [--lines 120-180] [--exports a,b] [--sections 9]',
      '  例如：atwo check lib/humanize.mjs --lines 120-180 --exports humanVerdict,humanIssues',
    ].join('\n'));
  }
  return sh(process.execPath, [ACCEPT, ...args], { cwd: HERE }).code;
}

// atwo judge —— 把「判不了」这件事本身变成可执行的判定。
//
// 为什么它属于 atwo 而不属于 chat analysis：atwo 的验收是三态的
//（ACCEPT / REVISE / 没评成），而两态系统会把「没评成」硬塞进通过或不通过，两种都错。
// 这个子命令就是把三值裁决接出来的那一端。
//
// 分档沿用 chat analysis 的定义：z 截断 ±3 → meanZ → strength×agreement×nValid
// → >=0.45 可判 / >=0.22 存疑 / <0.22 别判。改 vm/judge.mjs 的 CUT 会同时改这里。
async function cmdJudge(args) {
  // 参数分四组：判什么（--z / --input / --votes）、期望指标数（--expect）、
  // 走不走网络（--remote / --url / --timeout）、其余当开关位。
  const a1 = takeOpt(args, '--z');
  const a2 = takeOpt(a1.rest, '--input');
  const a3 = takeOpt(a2.rest, '--votes');
  const a4 = takeOpt(a3.rest, '--expect');
  const a5 = takeOpt(a4.rest, '--url');
  const a6 = takeOpt(a5.rest, '--timeout');
  const switches = a6.rest;
  const remote = switches.includes('--remote');
  const zRaw = String(a1.val || '').trim();
  const inFile = String(a2.val || '').trim();
  const votesRaw = String(a3.val || '').trim();
  const expectN = Number(a4.val);
  const expected = Number.isFinite(expectN) && expectN > 0 ? expectN : undefined;
  const timeoutMs = Number.isFinite(Number(a6.val)) && Number(a6.val) > 0 ? Number(a6.val) : undefined;
  const netOpts = { url: String(a5.val || '').trim() || undefined, timeoutMs };
  let zValues = [];
  let votes = [];
  try {
    if (votesRaw) {
      votes = votesRaw.split(/[,\s]+/).filter((s) => s !== '');
    } else if (inFile) {
      const body = JSON.parse(fs.readFileSync(path.resolve(HERE, inFile), 'utf8'));
      zValues = Array.isArray(body) ? body : (body.zValues || body.z || []);
    } else if (zRaw) {
      zValues = zRaw.split(/[,\s]+/).filter(Boolean).map(Number);
    } else {
      console.log('用法: atwo judge --z 3.1,2.9,3.4   或   atwo judge --input zz.json');
      console.log('      atwo judge --votes ACCEPT,REVISE,ACCEPT --expect 3');
      console.log('      atwo judge --z ... --remote [--url http://127.0.0.1:8731]   （走 vm/server.mjs 判定服务）');
      console.log('z 值 = 每项可复算指标的标准分。--votes 把多评审者的三态票判成 ACCEPT / REVISE / unreviewed。');
      return EXIT.usage;
    }

    // —— 票 → 三态（本地或远程） ——
    if (votes.length) {
      // 认不出的票必须在本地就先拦下：远程服务会回 400，本地路径若静默跳过，
      // 同一个 --votes 在两种模式下结论不同 —— 那是最难查的一类不一致。
      const { parseVote } = await import('./vm/votes.mjs');
      const unknown = votes.filter((v) => parseVote(v) === undefined);
      if (unknown.length) {
        console.log('票面认不出：' + unknown.slice(0, 6).join(', ') + '（只认 ACCEPT / REVISE / 没评成）');
        return EXIT.usage;
      }
      let r;
      if (remote) {
        const C = await import('./vm/client.mjs');
        const got = await C.remoteVotes(votes, { ...netOpts, expected });
        if (!got.ok) {
          console.log('判定服务拿不到：' + got.error);
          console.log('（起服务: node vm/server.mjs   ·   或去掉 --remote 用本地判定）');
          RESULT.data = { error: got.error, url: got.url || null, source: 'remote' };
          return EXIT.channel;
        }
        r = got;
      } else {
        const V = await import('./vm/votes.mjs');
        r = { ...V.judgeVotes({ votes, expected }), source: 'local' };
      }
      const c = r.counts || {};
      RESULT.data = {
        mode: 'votes', source: r.source,
        votes: { ACCEPT: c.ACCEPT || 0, REVISE: c.REVISE || 0, unreviewed: c.unreviewed || 0, invalid: c.invalid || 0 },
        expected: r.expected,
        rosterMissing: r.rosterMissing === true,
        state: r.state, verdict: r.value, direction: r.direction,
        reason: r.reason, reasonText: r.reasonText || null,
        confidence: Number(r.confidence),
        strength: r.stats ? r.stats.strength : null,
        agreement: r.stats ? r.stats.agreement : null,
        validRatio: r.stats ? r.stats.nValid : null,
      };
      const zh = { ACCEPT: 'ACCEPT（都认了，可以过）', REVISE: 'REVISE（都要求改）', unreviewed: 'unreviewed（下不了结论）' };
      // 「应评」必须写实：没声明名单时印 votes.length 会让人误以为到票率 100%。
      console.log('票型 ' + (c.ACCEPT || 0) + ' 认 / ' + (c.REVISE || 0) + ' 改 / ' + (c.unreviewed || 0) + ' 没评成（应评 '
        + (r.rosterMissing ? '未声明 · 用 --expect 3 或 --expect 名单' : r.expected) + '）');
      // reason 是机器码（consensus-accept / insufficient …），人话在 reasonText；
      // 「别判」这种字眼只能出现在括号里给人看，不能拿去当判断条件。
      console.log('结论 ' + zh[r.state] + ' · 置信度 ' + Number(r.confidence).toFixed(3) + ' · 判定 ' + r.value
        + '（' + (r.reasonText ? r.reasonText + ' / ' : '') + r.reason + '）');
      if (r.stats && typeof r.stats.strength === 'number') {
        console.log('  三个因子：强度 ' + r.stats.strength.toFixed(2) + ' × 一致 ' + r.stats.agreement.toFixed(2) + ' × 有效 ' + Math.round(r.stats.nValid * 100) + '%');
      }
      if (r.state === 'unreviewed') console.log('  ! 这票型不足以定调：既不当通过，也不当否决 —— 按没评成处理（补评或人看）');
      return EXIT.ok;
    }

    // —— z 值 → 三值（本地或远程） ——
    let r;
    if (remote) {
      const C = await import('./vm/client.mjs');
      const got = await C.remoteJudge(zValues, { ...netOpts, expected });
      if (!got.ok) {
        console.log('判定服务拿不到：' + got.error);
        console.log('（起服务: node vm/server.mjs   ·   或去掉 --remote 用本地判定）');
        RESULT.data = { error: got.error, url: got.url || null, source: 'remote' };
        return EXIT.channel;
      }
      r = {
        value: got.value, confidence: got.confidence, reason: got.reason,
        details: { stats: got.stats, steps: got.checked ? got.checked.steps : null, compiled: got.checked ? got.checked.compiled : null, direct: got.checked ? got.checked.direct : null },
        source: 'remote',
      };
    } else {
      const J = await import('./vm/judge.mjs');
      r = { ...J.judge({ zValues, expected }), source: 'local' };
    }
    const st = r.details ? r.details.stats : {};
    const label = r.value === 1 ? '可判（数据够下结论）' : (r.value === 0 ? '存疑（能看出方向，但别当结论用）' : '别判（这批数据下不了结论）');
    RESULT.data = {
      mode: 'z', source: r.source || 'local',
      confidence: Number(r.confidence),
      strength: typeof st.strength === 'number' ? st.strength : null,
      agreement: typeof st.agreement === 'number' ? st.agreement : null,
      validRatio: typeof st.nValid === 'number' ? st.nValid : null,
      verdict: r.value,
      verdictLabel: label,
      steps: r.details ? r.details.steps : null,
      compiled: r.details ? r.details.compiled : null,
      direct: r.details ? r.details.direct : null,
      consistent: r.details ? r.details.compiled === r.details.direct : null,
      reason: r.reason || null,
    };
    console.log('置信度 ' + Number(r.confidence).toFixed(3) + ' · ' + label);
    if (typeof st.strength === 'number') {
      console.log('  三个因子：强度 ' + st.strength.toFixed(2) + ' × 一致 ' + st.agreement.toFixed(2) + ' × 有效 ' + Math.round(st.nValid * 100) + '%');
    }
    if (r.details) {
      console.log('  执行 ' + r.details.steps + ' 步，编译结果 ' + r.details.compiled + ' / 现算 ' + r.details.direct + (r.details.compiled === r.details.direct ? '（一致）' : '（不一致，结论作废）'));
    }
    if (r.reason === 'compiler-mismatch') console.log('  ! 编译执行与现算不一致 —— 这不是数据问题，是 VM 自身出了问题');
    if (r.reason === 'decoupled-guard') console.log('  ! 触发脱钩保护：所有 z 都被截断成 0，绝不给「可判」');
    return r.reason === 'compiler-mismatch' ? EXIT.accept : EXIT.ok;
  } catch (e) {
    console.log('判定失败：' + String((e && e.message) || e).slice(0, 160));
    console.log('（vm/judge.mjs 还没交上来，或者 z 值不是数字）');
    return EXIT.precondition;
  }
}
function cmdState() {
  const list = listTasks();
  if (!list.length) {
    console.log('还没有任何任务。');
    RESULT.data.tasks = [];
    console.log('开一个：atwo new "一句话说清要做什么"');
    return 0;
  }
  const t = activeTask() || list[list.length - 1];
  console.log('任务  ' + t.title);
  console.log('阶段  ' + (STAGE[t.status] || t.status));
  console.log('档期  ' + (t.priority || '-'));
  const m0 = readMode();
  console.log('档位  ' + m0.name + ' · ' + m0.label + (t.size ? '    尺寸 ' + t.size : '    尺寸 M（默认）'));
  console.log('目录  ' + path.relative(HERE, t.dir).replace(/\\/g, '/'));
  const others = list.filter((x) => x.id !== t.id);
  if (others.length) {
    console.log('');
    console.log('还有 ' + others.length + ' 个没结：');
    for (const o of others) console.log('  · [' + (STAGE[o.status] || o.status) + '] ' + o.title);
  }
  RESULT.data.task = path.relative(HERE, t.dir).replace(/\\/g, '/');
  RESULT.data.title = t.title;
  RESULT.data.status = t.status;
  RESULT.data.size = t.size || 'M';
  RESULT.data.mode = m0.name;
  RESULT.data.openTasks = others.map((o) => ({ dir: path.relative(HERE, o.dir).replace(/\\/g, '/'), title: o.title, status: o.status }));
  const tail = lastLog(1)[0];
  if (tail) {
    console.log('');
    RESULT.data.lastRun = { agent: tail.agent || null, ok: Boolean(tail.ok), elapsedMs: tail.elapsedMs || 0, outputChars: tail.outputChars || 0 };
    console.log('上一次派活  ' + (tail.agent || '?') + '  ' + (tail.ok ? '成功' : '失败') +
      '  ' + Math.round((tail.elapsedMs || 0) / 1000) + 's  ' + (tail.outputChars || 0) + ' 字符');
  }
  return 0;
}

async function cmdDiff(args) {
  // --out 要单独抠出来：它是「带值的开关」，不能和那个唯一的文件名混在一起
  // Q1（2026-11-16 定）：机器可读的留 _probe/（草稿区、被 gitignore），
  // 人话决策清单进 docs/decisions/ —— 它正是「第二天要能翻回来」的东西，必须进 git。
  let outDir = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') { outDir = args[i + 1] || outDir; i++; continue; }
    if (a.startsWith('--out=')) { outDir = a.slice('--out='.length) || outDir; continue; }
    rest.push(a);
  }
  const draftDir = outDir || '_probe';
  const humanDir = outDir || path.join('docs', 'decisions');
  const file = rest.find((x) => !x.startsWith('--'));
  if (!file) {
    return die(`用法：atwo diff <用例文件.mjs> [--out 目录]

用例文件里导出两样东西：
  export const products = [{ agent: 'trae', fn: trae产物 }, ...]   每个通道的产物
  export const cases    = [{ name: '负数 -1024', call: (m) => m.formatBytes(-1024) }, ...]

它会拿每份产物在同一组用例上各跑一遍：
相同用例给出不同**行为**的，归并成你能直接回答的选择题；
写法不同但**行为一致**的（1h 1m 1s 与 01:01:01），单列一节，不用你回答。`);
  }
  const abs = path.resolve(HERE, file);
  if (!fs.existsSync(abs)) return die('用例文件不存在：' + abs);
  const mod = await import(pathToFileURL(abs).href);
  const products = Array.isArray(mod.products) ? mod.products : [];
  const cases = Array.isArray(mod.cases) ? mod.cases : [];
  if (products.length < 2) return die('至少要有两份产物才谈得上分歧（products 数组里现在 ' + products.length + ' 份）');
  if (!cases.length) return die('没有用例就没法比（cases 数组是空的）');
  const { divergences } = groupByBehavior(products, cases);
  const { decisions, formatOnly } = splitByBehavior(divergences);
  console.log('比了 ' + cases.length + ' 个用例，' + products.length + ' 份产物，'
    + divergences.length + ' 个用例上有分歧 → ' + decisions.length + ' 个要你定的事');
  console.log('');

  // 落盘：只停在屏幕上的结论，第二天就找不到了（PRD R3 要求两份产物）
  const rel = (p) => path.relative(HERE, p).replace(/\\/g, '/');
  const t0 = activeTask();
  const slug = t0 ? t0.id : 'adhoc';
  // 日期用本地时区：toISOString() 是 UTC，凌晨跑会写成前一天，翻历史时会错一天
  const d0 = new Date();
  const day = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0');
  const absDraft = path.resolve(HERE, draftDir);
  const absHuman = path.resolve(HERE, humanDir);
  fs.mkdirSync(absDraft, { recursive: true });
  fs.mkdirSync(absHuman, { recursive: true });
  const jsonPath = path.join(absDraft, 'decisions.json');
  // 人话版带任务名与日期：docs/decisions/<slug>-<YYYY-MM-DD>.md，翻历史时不用猜是哪一件
  const mdPath = outDir
    ? path.join(absHuman, 'decisions.md')
    : path.join(absHuman, slug + '-' + day + '.md');
  const payoad = {
    generatedAt: new Date().toISOString(),
    source: rel(abs),
    agents: products.map((p) => p.agent).filter(Boolean),
    caseCount: cases.length,
    divergenceCount: divergences.length,
    decisions,
    formatOnly,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payoad, null, 2) + '\n', 'utf8');
  const mdHeader = [
    '# 分歧清单',
    '',
    '- 来源：' + rel(abs),
    '- 通道：' + (payoad.agents.join('、') || '（未命名）'),
    '- 用例 ' + cases.length + ' 个，有分歧 ' + divergences.length + ' 个，需你拍板 ' + decisions.length + ' 个',
    '- 生成于 ' + payoad.generatedAt,
    '',
    '> 每个决策点直接回答一个字母即可；「只是写法不同」那一节不用回答。',
  ].join('\n');
  fs.writeFileSync(mdPath, mdHeader + '\n\n' + renderDecisions(decisions, { formatOnly }) + '\n', 'utf8');

  console.log(renderDecisions(decisions, { formatOnly }));
  console.log('');
  console.log('已落盘：');
  console.log('  机器可读  ' + rel(jsonPath));
  console.log('  人话版    ' + rel(mdPath));
  return 0;
}

/**
 * 收工闸门（PRD M 层 R4，2026-11-16 与副总管定：闸门放入口层，不碰 orchestra.mjs）。
 *
 * 两条规矩：
 *   1. check 不通过就不许结 —— 「做完了」不能靠嘴说，得靠验
 *   2. 状态只改 task.json 一处 —— 不在别处存副本，避免两处不一致
 */
function cmdDone(args) {
  const force = args.includes('--force');
  const yes = args.includes('--yes');
  const iTask = args.indexOf('--task');
  const wantDir = iTask >= 0 ? args[iTask + 1] : '';

  let t = activeTask();
  if (wantDir) {
    const abs = path.resolve(HERE, wantDir);
    t = listTasks().find((x) => path.resolve(x.dir) === abs) || null;
    if (!t) return die('没有这个任务：' + wantDir + '（atwo state 看目录名）');
  }
  if (!t) {
    return die('没有正在做的任务 —— 不知道要给谁收工。atwo state 看现在有哪些。', EXIT.precondition);
  }

  // 不问就结是危险的：activeTask 是「最近在动的那个」，不一定是「你想结的那个」。
  // 2026-11-16 我就在错误路径审查里这么干过，把别人手上的 P0 标成了 completed。
  if (!yes && !force && !wantDir) {
    return die([
      '将要结的是这件：' + t.title,
      '  目录：' + path.relative(HERE, t.dir).replace(/\\/g, '/') + '（状态 ' + t.status + '）',
      '',
      '确认后重跑：atwo done --task ' + path.relative(HERE, t.dir).replace(/\\/g, '/') + ' --yes',
      '要结别的一件：atwo done --task <目录>',
      '确实要硬结（跳过验收）：atwo done --force --yes',
    ].join('\n'));
  }

  if (force) {
    console.log('⚠ --force：跳过验收闸门，直接结。这条不会被当成「验过了」。');
  } else if (process.env.ATWO_DONE_SKIP_REGRESSION === '1') {
    // 只给自测用：收工闸门本身要跑全量回归，而回归里又有测 done 的用例 —— 不设这个开关会无限递归。
    console.log('── 验收与回归 ──');
    console.log('  ⚠ ATWO_DONE_SKIP_REGRESSION=1：本次只验状态机，不跑全量回归（自测专用）');
  } else {
    const files = Array.isArray(t.relatedFiles) ? t.relatedFiles.filter((f) => f && fs.existsSync(path.resolve(HERE, f))) : [];
    if (files.length) {
      console.log('── 交付物验收 ──');
      for (const f of files) {
        const r = sh(process.execPath, [ACCEPT, f], { cwd: HERE, capture: true });
        console.log((r.code === 0 ? '  ✓ ' : '  ✗ ') + f);
        if (r.code !== 0) {
          console.log('');
          return die(['交付物没通过验收：' + f, '', (r.out || r.err || '').trim().slice(0, 800), '',
            '改完再来：atwo done', '确实要硬结：atwo done --force（会留下明确标记）'].join('\n'), EXIT.accept);
        }
      }
    }
    // 回归走 gate（闭包 + 语法 + 契约 + 全量测试），不是只跑 test/*.test.mjs。
    // 只跑测试会漏两类致命情况：import 了不存在的文件、契约阈值被写死在代码里 ——
    // 这两种都能让测试全绿而线上全错。
    console.log('── 回归闸门（gate）──');
    const g = runGate({ cwd: HERE, files: [], skipTests: false });
    console.log(formatGate(g));
    if (!g.ok) {
      const red = g.steps.filter((s) => !s.ok);
      console.log('');
      return die(['闸门没全过，不许结：', '', ...red.map((s) => '  ✗ ' + s.name + '：' + String(s.detail || '').slice(0, 200)), '',
        '单跑一步：node atwo.mjs gate', '确实要硬结：atwo done --force'].join('\n'), EXIT.accept);
    }
  }

    // ── 评审票闸门：三态裁决（ACCEPT / REVISE / unreviewed）──
    // 为什么放在回归之后：回归只证明「没弄坏」，评审证明「该不该交」。两道都过才收工。
    // 没票不拒：「没人评审 = 永远收不了工」会把人训练成无脑 --yes，那比没闸门更坏。
    try {
      const subjects = (Array.isArray(t.relatedFiles) ? t.relatedFiles : [])
        .map((f) => path.basename(String(f))).filter(Boolean);
      const expectOpt = String(takeOpt(args, '--expect').val || '').trim();
      const declared = expectOpt ? expectOpt.split(/[,\s]+/).filter(Boolean) : [];
      const feed = discoverReviewVotes({
        dir: path.join(HERE, 'reviews'),
        subjects: subjects.length ? subjects : undefined,
        expectedReviewers: declared.length ? declared : undefined,
      });
      // 应评名额只认「显式声明」：--expect-n N 或 --expect 名单。
      // 以前这里还有 '|| feed.votes.length' —— 等于「来几张算几张」，三张 ACCEPT 自动满票通过。
      const expectN = Number(takeOpt(args, '--expect-n').val || 0) || declared.length || 0;
      console.log('── 评审票 ──');
      if (!feed.votes.length) {
        console.log('  证据不足：reviews/ 里没有与本任务交付物对应的评审票。');
        if (feed.missing.length) console.log('  还缺：' + feed.missing.join('、'));
        console.log('  这不算失败也不算通过：先补评审，或 --yes 明示放行（会写一行审计）。');
        RESULT.data.review = { votes: 0, expected: expectN, state: 'unreviewed', reason: 'no-votes' };
      } else {
        const jv = judgeVotes({ votes: feed.votes.map((v) => v.vote), expected: expectN || undefined });
        console.log('  票型 ' + feed.votes.length + ' 张（认 ' + (feed.counts.ACCEPT || 0) + ' / 改 ' + (feed.counts.REVISE || 0) + ' / 未评 ' + (feed.counts.unreviewed || 0) + '）· 应评 '
          + (jv.rosterMissing ? '未声明（补 --expect 名单 或 --expect-n N，否则按证据不足算）' : expectN));
        console.log('  裁决 ' + jv.state + ' · ' + jv.reason + ' · 置信度 ' + Number(jv.confidence).toFixed(3));
        RESULT.data.review = {
          votes: feed.votes.length, expected: expectN, state: jv.state,
          reason: jv.reason, confidence: jv.confidence, byThread: feed.bySubject,
        };
        if (jv.value <= 0 && yes !== true) {
          console.log('');
          return die([
            '评审没给出通过结论：' + jv.state + '（' + (jv.reasonText || jv.reason) + '）', '',
            '先改再交：按评审意见改完重新评审',
            '确实要硬结：atwo done --yes（会写审计）',
          ].join('\n'), EXIT.accept);
        }
        if (jv.value <= 0) {
          console.log('  ⚠ --yes 放行：评审为 ' + jv.state + '，审计已记入 memory/log.jsonl（如有下一代审计开关）');
          RESULT.data.review.bypassed = true;
        }
      }
    } catch (e) {
      console.log('  ! 评审票闸门跳过：' + String((e && e.message) || e).slice(0, 120));
    }

  // M2：修复必须留下一条防回归断言，否则下次同样的问题还会回来。
  // 只提醒不阻断 —— 不是每次收工都该往 test/ 里塞东西（比如纯文档任务）。
  const dirtyTest = sh('git', ['status', '--porcelain', '--', 'test/'], { cwd: HERE, capture: true });
  const addedAssertions = Boolean((dirtyTest.out || '').trim());
  if (!force && !addedAssertions) {
    console.log('');
    console.log('  ⚠ 这次没往 test/ 里加断言 —— 修的是同一类问题的话，下次它还会回来。');
  }
  RESULT.data.assertionsAdded = addedAssertions;

  // 收工写状态：只改 task.json 一处。
  // 注意 dirRel 之前根本没声明过 —— 沿用旧版本残留变量名会让「成功收工」这条路径必崩（实测 ReferenceError）。
  const dirRel = path.relative(HERE, t.dir).replace(/\\/g, '/');
  const st = py(['.atw/scripts/task.py', 'set-status', dirRel, 'completed'], { capture: true });
  if (st.code !== 0) return die('改状态失败：' + ((st.err || st.out || '').trim().slice(0, 400)));
  // 只有 task.json 一处记状态，这里不另写副本
  console.log('');
  RESULT.data.task = path.relative(HERE, t.dir).replace(/\\/g, '/');
  RESULT.data.title = t.title;
  RESULT.data.status = 'completed';
  console.log('✓ 已结：' + t.title);
  console.log('  状态只写在 ' + dirRel + '/task.json');
  return 0;
}

/**
 * 批量派活（PRD R5）：一次跑 N 个任务，输出**一份**报告而不是 N 份。
 *
 * 做法上不重写调度：直接调 `atwo go` 子进程跑每个源，再读 memory/log.jsonl
 * 新增的那几条来判断每条断在哪 —— 这样「单条跑」和「批量跑」走的是同一条代码路径，
 * 不会出现「批量有行为、单条没有」的分叉。
 */
function countLog() {
  if (!fs.existsSync(LOG)) return 0;
  return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length;
}

function cmdBatch(args) {
  // 带值的开关：下一个 token 是它的值，不是任务源。
  // （第一版没处理这个，'--size S' 里的 S 被当成第三个任务源，批量真跑了 3 个。）
  const WITH_VALUE = new Set([
    '--size', '--agent', '--by-multi', '--max-fix', '--out', '--lang',
    '--timeout', '--model', '--task-dir', '--port', '--lane-suffix',
  ]);
  const sources = [];
  const pass = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { sources.push(a); continue; }
    pass.push(a);
    if (!a.includes('=') && WITH_VALUE.has(a) && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      pass.push(args[++i]);
    }
  }
  if (!sources.length) {
    return die([
      '用法：atwo batch <任务源1> <任务源2> ... [--size S|M|L]',
      '  一次跑多个任务，最后只出**一份**报告：成功几个、失败几个、哪几个要你拍板。',
      '  失败的那条会写明断在哪一步、下一步该点哪里 —— 不会静默丢。',
    ].join('\n'));
  }

  const runs = [];
  for (const src of sources) {
    console.log('');
    console.log('▶▶ ' + src);
    const before = countLog();
    const r = sh(process.execPath, [path.join(HERE, 'atwo.mjs'), 'go', src, ...pass], { cwd: HERE, capture: true });
    if (r.out) process.stdout.write(r.out);
    if (r.err) process.stderr.write(r.err);
    // 只认这一次新增的日志行：拿「跑之前的行数」当下标，避免把上一条的结果算到这一条头上
    const tail = lastLog(1)[0] || null;
    const after = countLog();
    const entry = after > before ? tail : null;
    runs.push({ source: src, code: r.code, entry });
  }

  const s = summarize(runs);
  const d = new Date();
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const dir = path.join(HERE, 'docs', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, day + '-batch.md');
  fs.writeFileSync(mdPath, s.markdown, 'utf8');

  console.log('');
  console.log('──── 汇总 ────');
  console.log('成功 ' + s.ok + ' · 失败 ' + s.failed + ' · 待你拍板 ' + s.pending + ' · 合计 ' + runs.length);
  console.log('');
  for (const l of s.lines) console.log('  ' + l);
  console.log('');
  RESULT.data.ok = s.ok;
  RESULT.data.failed = s.failed;
  RESULT.data.pending = s.pending;
  RESULT.data.total = runs.length;
  RESULT.data.report = path.relative(HERE, mdPath).replace(/\\/g, '/');
  console.log('报告：' + path.relative(HERE, mdPath).replace(/\\/g, '/'));
  return s.failed ? 1 : 0;
}

function cmdRaw(args) {
  if (!args.length) return die('用法：atwo raw <原命令> ...  例如 atwo raw stats');
  // 注意返回的是 .code（数字），不是 {code,out,err} 对象 ——
  // 直接把对象交给 process.exit 会抛 ERR_INVALID_ARG_TYPE，而且是在命令已经跑完、输出已经打完之后才崩。
  // --json 必须往下透传：atwo 自己吞掉它、又不给 orchestra，结果就是
  // `atwo raw stats --json` 打出表格 —— 你以为拿到机器可读出口，其实没有。
  const a = (JSON_MODE && !args.includes('--json')) ? [...args, '--json'] : args;
  return orchestra(a).code;
}

// ── doctor / try / 裸命令 ────────────────────────────────────────────────
// 陌生 AI 打开 atwo 时问的不是「有哪些动词」，是「在我这台机器上哪条路真能跑」。
// 所以裸命令不再是 usage，而是「诊断 + 三个候选动作」。
function printCan(c) {
  const ch = Object.entries(c.channels).map(([k, v]) => k + (v.ok ? '✓' : '✗')).join(' ');
  console.log('这台机器 ' + c.platform + ' · node ' + c.node);
  console.log('仓库     ' + c.cwd + (c.repo.isGit ? '（git）' : '') + (c.repo.tests ? '（有测试入口）' : '（没有 test/all.mjs）'));
  console.log('通道     ' + ch + (c.channelUp.length ? '' : '  ← 一个都不可用'));
  const o = c.ollama;
  console.log('本地     ollama ' + (o.ok ? '✓ ' + (o.models.slice(0, 2).join(' / ') || '已有模型') : '✗ ' + (o.why || '')));
  console.log('');
  console.log('现在能做：' + c.can.join(' · '));
  if (c.cannot.length) console.log('现在不能：' + c.cannot.join(' · '));
}

async function cmdBare() {
  const c = await detectEnvironment();
  console.log('atwo — AI 自用的编排 CLI（不是给人读的）');
  console.log('');
  printCan(c);
  console.log('');
  console.log('下一步：');
  console.log('  atwo try            2 秒自检，看它真能干活（不花钱、不派活）');
  console.log('  atwo caps --json    全部动词 + 参数 + 代价，比你猜快');
  console.log('  atwo doctor         详细诊断 + 每个缺的东西怎么补');
  RESULT.data = { doctor: c };
  return EXIT.ok;
}

async function cmdDoctor(args) {
  const c = await detectEnvironment();
  printCan(c);
  console.log('');
  const fixes = Object.entries(c.channels).filter(([, v]) => !v.ok && v.fix);
  if (fixes.length) {
    console.log('怎么补：');
    for (const [k, v] of fixes) console.log('  ' + k.padEnd(10) + v.fix + (v.path ? '（当前指向 ' + v.path + '，不存在）' : '（没有默认路径）'));
    console.log('');
  }
  console.log('建议：');
  for (const a of c.advice) console.log('  · ' + a);
  RESULT.data = { doctor: c };
  return EXIT.ok;
}

async function cmdTry() {
  const r = await quickSelfCheck();
  console.log('自检三连（零依赖、不花钱、不联网）：');
  for (const s of r.steps) {
    console.log('  ' + (s.ok ? 'ok  ' : 'FAIL') + '  ' + s.name.padEnd(8) + s.detail);
  }
  console.log('');
  console.log(r.ok ? '✓ 全部正常 · ' + r.elapsedMs + 'ms' : '✗ 有步骤没过 · ' + r.elapsedMs + 'ms');
  console.log(r.next);
  RESULT.data = { try: r };
  return r.ok ? EXIT.ok : EXIT.accept;
}

// ── should / gate ────────────────────────────────────────────────────────────
async function cmdShould(args) {
  const t = positional('should', args).join(' ').trim();
  if (!t) {
    console.error('要判什么？给一句话，比如：atwo should "把 lib/ 下 12 个文件的 import 统一改成 ESM"');
    console.error('这一条没有派活、没有改任何东西。');
    return EXIT.usage;
  }
  const r = shouldDelegate(t);
  RESULT.data = r;
  if (JSON_MODE) return EXIT.ok;
  console.log(formatShould(r));
  if (r.verdict === 'delegate') console.log('\n要真派：atwo fanout "' + t + '"');
  return EXIT.ok;
}

async function cmdGate(args) {
  const fi = args.indexOf('--files');
  const files = (fi >= 0 ? String(args[fi + 1] || '') : '').split(/[,\s]+/).filter(Boolean);
  const r = runGate({ files, skipTests: args.includes('--no-tests') });
  RESULT.data = r;
  if (JSON_MODE) return r.ok ? EXIT.ok : EXIT.accept;
  console.log(formatGate(r));
  return r.ok ? EXIT.ok : EXIT.accept;
}

// ─────────── 机器可读出口（操作者是 AI 时走这条）───────────
// 人话一个字都不丢，但全部进 JSON 的 log 字段；stdout 只留最后那一个对象。
const JSON_MODE = process.argv.includes('--json');
const RESULT = { ok: true, verb: '', exitCode: 0, data: {}, log: '' };
const realWrite = process.stdout.write.bind(process.stdout);
if (JSON_MODE) {
  const collect = (chunk) => { RESULT.log += String(chunk); return true; };
  process.stdout.write = collect;
  process.stderr.write = collect;
}

const cmdFanout = makeFanoutVerb({ EXIT, RESULT, HERE, die, activeTask });

const bareCall = !process.argv[2];
const verb = String(process.argv[2] || '__bare').toLowerCase();
const rest = process.argv.slice(3).filter((a) => a !== '--json');
const table = { doctor: cmdDoctor, should: cmdShould, gate: cmdGate, try: cmdTry, new: cmdNew, batch: cmdBatch, go: cmdGo, check: cmdCheck, diff: cmdDiff, judge: cmdJudge, fanout: cmdFanout, done: cmdDone, state: cmdState, mode: cmdMode, raw: cmdRaw };

/** 打印规格：人读走 stdout，机器读塞进 RESULT.data（由统一收尾出 JSON）。 */
function printSpec(target) {
  const t = String(target || '').replace(/^--?/, '').toLowerCase();
  if (!t) {
    if (JSON_MODE) { RESULT.data = capsJson(); return; }
    usage();
    return;
  }
  const s = specOf(t);
  if (!s) {
    if (JSON_MODE) { RESULT.data = { error: 'no-such-verb', verb: t, verbs: Object.keys(VERBS) }; return; }
    console.log('没有这个动词：' + t);
    console.log('有的：' + Object.keys(VERBS).join(' '));
    return;
  }
  if (JSON_MODE) { RESULT.data = s; return; }
  console.log(formatSpec(t));
}

let code;
if (verb === 'caps' || verb === 'spec' || verb === 'capabilities') {
  // caps 就是机器格式，不管加没加 --json 都出 JSON —— 它存在的唯一理由是被 AI 读一次。
  if (JSON_MODE) {
    RESULT.data = capsJson();
  } else {
    process.stdout.write(JSON.stringify(capsJson(), null, 2) + String.fromCharCode(10));
  }
  code = EXIT.ok;
} else if (verb === '__bare') {
  // 裸命令永远不是「打一遍 usage 让你自己找」——那是人的交互习惯。
  // AI 需要的是「你这台机器现在能跑什么 + 下一步敲哪三个」。
  code = await cmdBare();
} else if (isHelp(verb)) {
  const tgt = rest.find((a) => !a.startsWith('--')) || '';
  printSpec(tgt);
  code = EXIT.ok;
} else if (table[verb]) {
  // ① 求助护栏：--help / -h / help 出现在任何位置都只打规格，绝不进入动词实现。
  //    2026-11-16 13:58 我跑 `atwo fanout --help`，它把 --help 当任务文本，
  //    真派出三个子会话跑了 61 秒。护栏必须在 dispatch 这一层，不能靠每个动词自觉。
  if (rest.some((a) => isHelp(a))) {
    printSpec(verb);
    code = EXIT.ok;
  } else {
    // ② 未知参数护栏：strict 动词出现不认识的 --x 直接退出 2，并给可照抄的下一步。
    //    静默忽略一个拼错的开关，等于让 AI 以为自己改了档位其实没改。
    const chk = checkFlags(verb, rest);
    if (!chk.ok) {
      const known = [...Object.keys(VERBS[verb].flags || {}), ...(VERBS[verb].switches || []), ...Object.keys(GLOBAL_FLAGS)];
      code = die([
        '不认识的参数：' + chk.unknown.join(' ') + '（atwo ' + verb + ' 不认它）',
        '这一条没有派活、没有改任何东西。',
        '',
        '可用的：' + known.join(' '),
        '完整规格：atwo help ' + verb + ' --json',
      ].join(String.fromCharCode(10)), EXIT.usage);
    } else {
      // ③ --dry-run 只对会派活的动词有意义。对本地动词明说它没用（不静默忽略），
      //    对还没实现试跑的派活动词直接拦住 —— 半吊子的 dry-run 比没有更危险。
      let args = rest;
      if (args.includes('--dry-run')) {
        const v = VERBS[verb];
        if (verb === 'go') {
          args = args.map((a) => (a === '--dry-run' ? '--plan' : a));
        } else if (verb === 'fanout') {
          // fanout-cli 自己认 --dry-run
        } else if (v.cost === 'spawn') {
          code = die('atwo ' + verb + ' 还不支持 --dry-run：它会在你确认前就派活。\n要么去掉这个参数直接跑，要么改用 atwo fanout "<任务>" --dry-run 先验一遍。', EXIT.usage);
          args = null;
        } else {
          console.log('（--dry-run 对 ' + verb + ' 无意义：它不派活，照常执行）');
          args = args.filter((a) => a !== '--dry-run');
        }
      }
      if (args) {
        // await 不能省：cmdDiff 是 async，不 await 的话 code 是 Promise，
        // process.exit 会抛 ERR_INVALID_ARG_TYPE —— 而且是在输出全部打完之后才崩。
        code = await table[verb](args);
      }
    }
  }
} else {
  console.log('不认识的动词：' + verb);
  console.log('');
  console.log('（atwo caps --json 拿全部动词的机器规格，比你猜快）');
  console.log('');
  usage();
  code = EXIT.usage;
}
if (JSON_MODE) {
  RESULT.verb = verb;
  RESULT.exitCode = code == null ? EXIT.ok : code;
  RESULT.ok = RESULT.exitCode === EXIT.ok;
  RESULT.log = RESULT.log.trimEnd();
  process.stdout.write = realWrite;
  realWrite(JSON.stringify(RESULT, null, 2) + String.fromCharCode(10));
  process.exit(RESULT.exitCode);
}
process.exit(code == null ? EXIT.ok : code);
