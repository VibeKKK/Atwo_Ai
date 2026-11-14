#!/usr/bin/env node
// atw-mcp.mjs —— 把 Orchestra 暴露成 MCP 工具，让 AI 自主调用，而不是等用户敲命令。
//
// 为什么要有这个文件（2026-11-15 rank2）：
//   Orchestra 一直是 CLI。CLI 的致命缺陷是「想不起来」——用户不提，AI 就不会去敲。
//   而 ops_bash 这类工具之所以天天被用，是因为它的 schema 常驻在系统提示里。
//   把 orchestra 包成 MCP server 之后，atw_* 就变成了同名工具，AI 每次派活前都会看见它。
//
// 零依赖：只实现 MCP 需要的四个方法（initialize / tools/list / tools/call / ping）。
// stdio 传输用 newline-delimited JSON（MCP 规范，不是 LSP 的 Content-Length）。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ORCH = path.join(ROOT, 'orchestra.mjs');

// 单个工具调用最多等多久。orchestra 自己的 ORCH_TIMEOUT_MS 默认 240s，
// 这里留出余量给「拆解 + 多轮派活 + 验收」，否则外层先超时会把真实进度全吞掉。
const CALL_TIMEOUT_MS = Number(process.env.ATW_CALL_TIMEOUT_MS || 600000);

/** 跑一条 orchestra 子命令，收齐 stdout/stderr，返回退出码与文本。 */
function runOrch(args, { timeoutMs = CALL_TIMEOUT_MS, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ORCH, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + String(e && e.message || e), killed });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, out, err, killed });
    });
  });
}

/** 把子进程结果压成一份人可读 + 机器可解析的文本。 */
function pack(r) {
  const head = r.killed ? '超时被终止' : 'exit=' + r.code;
  const body = [r.out.trim(), r.err.trim()].filter(Boolean).join('\n');
  return head + '\n' + (body || '（无输出）');
}

const TOOLS = [
  {
    name: 'atw_do',
    description:
      '把一个「目标」交给别的 AI 执行：它自己拆任务、派给合适的通道（Trae / CodeBuddy / WorkBuddy / 豆包）、并行跑、带着落盘和验收回来。\n\n' +
      '【什么时候必须调它，而不是自己硬写】满足任一条件就调：\n' +
      '1) 要写的代码超过 30 行；2) 需要一个没被自己污染的第二个视角（评审、找错、挑刺）；\n' +
      '3) 有 3 个以上互不依赖的子任务；4) 是重复劳动（换个文件再来一遍）；\n' +
      '5) 你正准备说「那我直接写吧」——这句话本身就是触发条件。\n\n' +
      '【为什么值得调】通道走文件信箱，产物字节无损（反引号 / 井号 / 双星号 / JSDoc 边界全部原样），' +
      '且不占你的上下文——它只把摘要带回来，全文留在 runs/ 下。\n\n' +
      '【不要用它做】需要你自己持续观察和判断的事（调试一个正在变化的状态）、以及一两句话就能答完的小事。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '一句话目标。写清「做完长什么样」，否则验收没法做。' },
        chars: { type: 'number', description: '摘要字符上限，默认 160。想少占上下文就调到 80。' },
        agent: { type: 'string', description: '强制通道：trae / codebuddy / workbuddy / doubao。不填则自动选路。' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'atw_ask',
    description:
      '派一个已经拆分好的明确任务给指定通道，拿回结果文本。适合「我知道要什么、只需要一个执行力」。\n\n' +
      '要产物落盘请用 atw_do；要并行多任务请用 atw_swarm。每条通道的脾气：' +
      'codebuddy 出码最干净（CLI 直出字节，零 DOM 损耗，但一次 40–160s）；' +
      'trae 最快（20–35s，走文件信箱无损，走 DOM 会丢语法字符）；' +
      'workbuddy 中等（20–120s）；豆包约 20s 且无损。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '完整任务描述。对方看不到你的上下文，前提要自带。' },
        agent: { type: 'string', description: 'trae / codebuddy / workbuddy / doubao / auto，默认 auto。' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'atw_swarm',
    description:
      'N 个独立任务跨通道并行跑，失败自动换路重试。适合你已经把活拆成互不依赖的几块的时候。\n\n' +
      '硬规则：任务数 ≥3 且彼此独立时，不许用 atw_ask 循环——那等于把并行降级成串行。' +
      '实测 16 任务 100% 成功，6 混合任务墙钟 103.3s vs 串行 255.4s（2.47×）。',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: '任务列表。每项必须自包含（对方看不到其他任务）。',
        },
        agent: { type: 'string', description: '统一指定通道；不填则按内容自动分配（要代码→codebuddy，散文→trae）。' },
        land: { type: 'boolean', description: '产物写入磁盘（需要任务里给了目标路径）。' },
        verify: { type: 'boolean', description: '落盘后做内容验收。与 land 一起用。' },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'atw_health',
    description: '看四条通道是否活着、当前额度还剩多少、有没有卡住的锁。派活前不确定该给谁时先看一眼。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'atw_stats',
    description: '台账：各通道调用次数、成功率、平均耗时、平均字符数、累计 token。用来判断「哪条通道最近在拖后腿」。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** 由工具名 + 参数拼出 orchestra 的 argv。 */
function buildArgs(name, a) {
  a = a && typeof a === 'object' ? a : {};
  if (name === 'atw_do') {
    if (!a.goal) throw new Error('atw_do 需要 goal');
    const argv = ['sub', String(a.goal)];
    if (a.chars) argv.push('--chars', String(a.chars));
    if (a.agent) argv.push('--agent', String(a.agent));
    return argv;
  }
  if (name === 'atw_ask') {
    if (!a.prompt) throw new Error('atw_ask 需要 prompt');
    return ['ask', String(a.agent || 'auto'), String(a.prompt)];
  }
  if (name === 'atw_swarm') {
    const list = Array.isArray(a.tasks) ? a.tasks.filter(Boolean) : [];
    if (!list.length) throw new Error('atw_swarm 需要至少一个任务');
    const argv = ['swarm', list.join('|||')];
    if (a.agent) argv.push('--agent', String(a.agent));
    if (a.land) argv.push('--land');
    if (a.verify) argv.push('--verify');
    return argv;
  }
  if (name === 'atw_health') return ['health'];
  if (name === 'atw_stats') return ['stats'];
  throw new Error('未知工具 ' + name);
}

async function handleCall(name, args) {
  let argv;
  try { argv = buildArgs(name, args); }
  catch (e) { return { isError: true, text: String(e.message || e) }; }
  const r = await runOrch(argv);
  const text = pack(r);
  // 台账/健康是只读快照，永远不算失败；派活类 exits != 0 才算
  const readOnly = name === 'atw_health' || name === 'atw_stats';
  return { isError: !readOnly && (r.code !== 0 || r.killed), text };
}

// ---------- MCP stdio 传输 ----------

let buf = '';
// 未完成的 tool call 计数。stdin 一旦 EOF 就 exit 会把还在跑的派活整段吞掉
// （管道式客户端会立刻关 stdin，这里必须等异步收尾）。
let pending = 0;
let ended = false;
const maybeExit = () => { if (ended && pending === 0) setTimeout(() => process.exit(0), 30); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) dispatch(line);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function dispatch(line) {
  let msg;
  try { msg = JSON.parse(line); }
  catch { return; }
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  pending++;
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'atw', version: '1.0.0' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const out = await handleCall(name, args);
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: out.text }], isError: !!out.isError },
      });
      return;
    }
    if (isNotification) return;
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现的方法 ' + method } });
  } catch (e) {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message || e) } });
  } finally {
    pending--;
    maybeExit();
  }
}

process.stdin.on('end', () => { ended = true; maybeExit(); });
