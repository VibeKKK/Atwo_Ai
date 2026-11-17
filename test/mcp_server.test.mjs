// test/mcp_server.test.mjs —— 钉住两条不许漂移的不变量
//   1. 每个 verb 都必须有一个 MCP 工具（曾三次「注册了动词忘加规格」，这里是同一类错的另一半）
//   2. tools/call 必须回结构化 JSON，exit 4 不许被当成工具故障
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERBS } from '../lib/cli-spec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'lib', 'mcp-server.mjs');

let pass = 0; let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}

/** 起一次服务器，喂一串消息，收齐回答后关闭。 */
function session(messages, waitMs = 12000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    setTimeout(() => {
      child.stdin.end();
      const lines = [];
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { lines.push(JSON.parse(t)); } catch { /* 忽略非 JSON 行 */ }
      }
      child.kill();
      resolve({ lines, err });
    }, waitMs);
  });
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
const inited = { jsonrpc: '2.0', method: 'notifications/initialized' };
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const callModels = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'atwo_models', arguments: {} } };
const callBad = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'atwo_not_a_verb', arguments: {} } };
const badMethod = { jsonrpc: '2.0', id: 5, method: 'no/such/method' };

const { lines, err } = await session([init, inited, list, callModels, callBad, badMethod]);
const byId = (id) => lines.find((l) => l.id === id);

ok(byId(1)?.result?.protocolVersion === '2024-11-05', 'initialize 回协议版本', JSON.stringify(byId(1)));
ok(byId(1)?.result?.serverInfo?.name === 'atwo', 'initialize 报 serverInfo.name = atwo');
ok(byId(1)?.result?.capabilities?.tools !== undefined, 'initialize 声明 tools 能力');

const tools = byId(2)?.result?.tools ?? [];
const verbNames = Object.keys(VERBS);
ok(tools.length === verbNames.length, `工具数 === 动词数（${tools.length} vs ${verbNames.length}）`);
const missing = verbNames.filter((v) => !tools.some((t) => t.name === `atwo_${v}`));
ok(missing.length === 0, '每个动词都有同名工具', `缺：${missing.join(', ')}`);
const schemaBad = tools.filter((t) => !t.description || t.inputSchema?.type !== 'object' || !Array.isArray(t.inputSchema?.properties?.args?.items?.type === undefined ? [] : [1]));
ok(schemaBad.length === 0, '每个工具都有 description 与 object 型 inputSchema', schemaBad.map((t) => t.name).join(', '));
ok(tools.every((t) => /成本：/.test(t.description)), '每个工具都写清成本（AI 需要知道花不花钱）');

const modelsRes = byId(3)?.result;
const modelsPayload = (() => { try { return JSON.parse(modelsRes?.content?.[0]?.text ?? ''); } catch { return null; } })();
ok(modelsRes?.isError === false, 'tools/call atwo_models 不是工具故障', JSON.stringify(modelsRes)?.slice(0, 200));
ok(modelsPayload?.verb === 'models', 'tools/call 回结构化 JSON（含 verb 字段）', JSON.stringify(modelsPayload)?.slice(0, 200));
ok(typeof modelsPayload?.exitCode === 'number' && typeof modelsPayload?.exitMeaning === 'string', 'tools/call 回 exitCode 与人话含义');

ok(byId(4)?.result?.isError === true, '未知工具回 isError=true');
ok(/未知工具/.test(byId(4)?.result?.content?.[0]?.text ?? ''), '未知工具的错误文本说清是哪个名字');

ok(byId(5)?.error?.code === -32601, '未知方法回 -32601');
ok(lines.filter((l) => l.id === null || l.id === undefined).length === 0, '通知不产生回答');

console.log(`\n${pass} 通过 / ${fail} 失败${err ? ' ；stderr 非空：' + err.slice(0, 200) : ''}`);
process.exit(fail === 0 ? 0 : 1);
