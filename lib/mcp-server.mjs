#!/usr/bin/env node
// lib/mcp-server.mjs —— 把 atwo 的动词表暴露成 MCP 工具（stdio JSON-RPC 2.0，零依赖）
//
// 为什么要有它：atwo 的入口是 CLI，AI 每次调用都要拼 bash 字符串，
// 转义（引号/反斜杠/中文）已经坑过三次：`split('\n')` 被吃成 `split('` 换行 `')`。
// MCP 让 AI 直接给结构化参数，不经过 shell，根因消失。
//
// 单一真源：工具列表由 lib/cli-spec.mjs 的 VERBS 生成。
// 加一个动词只需要在 cli-spec 里写规格，这里自动多一个工具 —— 不再有「注册忘加规格」。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERBS, EXIT_CODES } from './cli-spec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ATWO = path.join(ROOT, 'atwo.mjs');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'atwo', version: '1.0.0' };

/** 会真派 AI / 跑很久的动词给更长默认超时。 */
const LONG_VERBS = new Set(['go', 'army', 'batch', 'fanout', 'review', 'triage', 'doctor', 'raw']);
const SHORT_TIMEOUT_MS = 120000;
const LONG_TIMEOUT_MS = 900000;

const COST_NOTE = {
  none: '不花钱',
  io: '只读写本地，不派 AI',
  spawn: '会真派 AI，按次花额度',
};

function buildTools() {
  return Object.entries(VERBS).map(([verb, spec]) => {
    const bits = [spec.summary];
    bits.push(`成本：${COST_NOTE[spec.cost] ?? spec.cost}${spec.writes ? ' · 会改仓库里的文件' : ''}`);
    if (spec.pos) bits.push(`位置参数：${spec.pos}`);
    const flags = Object.keys(spec.flags || {});
    if (flags.length) bits.push(`带值开关：${flags.join(' ')}`);
    const switches = spec.switches || [];
    if (switches.length) bits.push(`开关位：${switches.join(' ')}`);
    return {
      name: `atwo_${verb}`,
      description: bits.join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: `原样传给 \`atwo ${verb}\` 的参数（结尾自动补 --json，不要自己传）`,
          },
          cwd: { type: 'string', description: `工作目录，默认 ${ROOT}` },
          timeoutMs: {
            type: 'number',
            description: `超时毫秒，默认 ${LONG_VERBS.has(verb) ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS}`,
          },
        },
      },
    };
  });
}

const TOOLS = buildTools();

function callTool(name, input) {
  const verb = String(name || '').replace(/^atwo_/, '');
  if (!VERBS[verb]) {
    return { isError: true, text: `未知工具 ${name}；可用：${TOOLS.map((t) => t.name).join(', ')}` };
  }
  const argv = [ATWO, verb];
  if (Array.isArray(input?.args)) for (const a of input.args) argv.push(String(a));
  argv.push('--json');
  const cwd = input?.cwd ? path.resolve(String(input.cwd)) : ROOT;
  const asked = Number(input?.timeoutMs);
  const timeout = asked > 0 ? asked : (LONG_VERBS.has(verb) ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS);

  const r = spawnSync(process.execPath, argv, {
    cwd, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  const code = r.status === null ? 5 : r.status;
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();

  let payload = null;
  try { payload = JSON.parse(stdout); } catch { payload = null; }

  const exitCode = payload && Number.isInteger(payload.exitCode) ? payload.exitCode : code;
  const out = payload
    ? {
      ok: payload.ok !== false,
      verb,
      exitCode,
      exitMeaning: EXIT_CODES[exitCode] ?? '',
      data: payload.data ?? null,
      log: payload.log ?? '',
    }
    : {
      ok: code === 0,
      verb,
      exitCode,
      exitMeaning: EXIT_CODES[code] ?? '',
      stdoutHead: stdout.slice(0, 20000),
      stderrTail: stderr.slice(-4000),
      note: '这个动词没有输出可解析的 JSON，下面是原始输出',
    };

  // exit 4 是「跑成了但结论红」，属于有效结论，不是工具故障。
  const isError = code !== 0 && code !== 4 && !payload;
  return { isError, text: JSON.stringify(out, null, 2) };
}

function reply(id, result) { return { jsonrpc: '2.0', id, result }; }
function fail(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function handle(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: 'atwo：AI 任务编排与验收。每个工具都自动带 --json，返回 {ok, verb, exitCode, exitMeaning, data, log}。exitCode 4 = 跑成了但结论红（不是失败）。',
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const input = params?.arguments ?? {};
    const { isError, text } = callTool(name, input);
    return reply(id, { content: [{ type: 'text', text }], isError });
  }
  if (isNotification) return null; // notifications/initialized 等：不回
  return fail(id, -32601, `未实现的方法：${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify(fail(null, -32700, 'JSON 解析失败')) + '\n');
      continue;
    }
    let res;
    try { res = handle(msg); } catch (e) {
      res = fail(msg?.id ?? null, -32603, e?.message ?? String(e));
    }
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
