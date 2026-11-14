// WorkBuddy 适配层：CDP 驱动（环境变量开端口 → 输入 → 发送 → 读回答）
//
// 关键事实（都是实测出来的，别改回去）：
//  1) WorkBuddy 5.11.2+ 只认环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT，
//     命令行 --remote-debugging-port 会被丢弃（asar 原文见 README）。
//  2) CDP 的 HTTP 端点必须覆盖 Host: localhost:<port>，否则连接被强断
//     （Chrome 的 DNS-rebinding 防护）。
//  3) 输入框是 Slate 编辑器 div[data-slate-editor="true"]，必须用 CDP
//     Input.insertText 走真实输入事件，直接改 innerText Slate 状态不同步。
//  4) 发送键是 button[aria-label="发送"]。
//  5) 回答在最后一个 .cr-agent 里，文本夹着 WorkBuddy/已完成 Xs/Hy4/时间 这些界面行。
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { config } from '../lib/config.mjs';

// ws 不装进本仓库（保持零依赖），从 DSH profile 的 node_modules 里借；
// 路径由 lib/config.mjs 给出（DSH_HOME / config.local.json 的 dshRoot 可覆盖）。
const require = createRequire(path.join(config.dshRoot, 'profiles', 'desktop', 'node_modules') + path.sep);
const WebSocket = require('ws');

const PORT = Number(process.env.WB_PORT || 9224);
const EXE = process.env.WB_EXE || config.workbuddyExe || 'D:\\code app\\ai code\\WorkBuddy\\WorkBuddy.exe';
// 工作区（2026-11-14 用户指定）：产物写这里，走文件信箱而不是抓 DOM。
// 原先没有这个配置项，所以 WorkBuddy 只能靠 innerText 取回答 —— 实测反引号和 ## 全被
// markdown 渲染吃掉（343 秒还交回一个废产物）。文件通道绕开渲染器，字节原样。
const WORKSPACE = process.env.WB_WORKSPACE || config.workbuddyWorkspace ||
  'D:\\ai work replace\\workbuddy place\\work test one';
// 三通道共享工作区：opts.shared=true 走这里，用于跨通道协作/特殊需求
const SHARED_WS = process.env.ORCH_SHARED_WS || 'D:\\ai work replace\\TDW place';
const SEL = {
  edit: ['div[data-slate-editor="true"][contenteditable="true"]', 'div[contenteditable="true"]'],
  send: ['button[aria-label="发送"]', 'button[aria-label="Send"]'],
  agent: ['.cr-agent', '[data-message-id].cr-agent'],
};
// 注意「已处理」和「已完成」不是一回事：思考中显示「已处理 5s」，收尾才变「已完成」。
// 2026-11-14 实测：把「已处理 5s / 准备中 / 思路在堵车，我正在指挥交通 / 不再显示」当成答案返回过。
const CHROME_LINE = /^(WorkBuddy|已完成.*|已处理.*|准备中|不再显示|思路在堵车.*|思考中.*|Hy4|DeepSeek.*|\d{1,2}:\d{2}(:\d{2})?|\d+\s*[s秒]|\|)$/;
// 「还在跑」的界面信号：命中就说明这一屏不是答案，别当完成
const RUNNING_RE = /(思路在堵车|正在指挥交通|准备中|已处理\s*\d|思考中)/;

export const META = {
  name: 'workbuddy',
  label: 'WorkBuddy (Hy4)',
  kind: 'gui-agent',
  transport: 'cdp',
  port: PORT,
  exe: EXE,
  strengths: ['环境变量开 CDP', 'Slate 编辑器', '走用户 WorkBuddy 积分'],
  note: '环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT 开端口；命令行 flag 无效',
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpJson(p, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: 'GET',
      headers: { Host: `localhost:${PORT}`, Connection: 'close' }, timeout,
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('CDP http timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function portOpen() {
  try { await httpJson('/json/version', 1500); return true; } catch { return false; }
}

function killAll() {
  try {
    spawn('taskkill', ['/F', '/IM', 'WorkBuddy.exe'], { windowsHide: true, stdio: 'ignore' });
  } catch { /* ignore */ }
}

export async function ensureWorkbuddy({ waitMs = 90000, allowRestart = process.env.ORCH_WB_RESTART !== '0' } = {}) {
  if (await portOpen()) return { started: false };
  if (!allowRestart) throw new Error('WorkBuddy 没开调试端口，且 ORCH_WB_RESTART=0 禁止重启');
  const had = (() => { try { return require('node:child_process').execSync('tasklist /FI "IMAGENAME eq WorkBuddy.exe"', { windowsHide: true }).toString().includes('WorkBuddy.exe'); } catch { return false; } })();
  if (had) {
    console.error('[workbuddy] 需要重启才能开调试端口（当前实例没带环境变量），正在重启…');
    killAll();
    await sleep(3000);
  }
  const p = spawn(EXE, [], {
    env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: String(PORT), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
    detached: true, stdio: 'ignore', windowsHide: false,
  });
  p.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(700);
    if (await portOpen()) return { started: true, ms: Date.now() - t0 };
  }
  throw new Error('WorkBuddy 启动后 ' + waitMs + 'ms 内仍没有调试端口');
}

async function pageWsUrl() {
  const list = await httpJson('/json/list');
  const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page');
  if (!page) throw new Error('WorkBuddy 没有 page 目标');
  return page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1');
}

async function connect() {
  const url = await pageWsUrl();
  const ws = new WebSocket(url, { origin: 'http://localhost' });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let seq = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const onMsg = (raw) => {
      let o; try { o = JSON.parse(raw.toString()); } catch { return; }
      if (o.id !== id) return;
      ws.off('message', onMsg);
      o.error ? reject(new Error(method + ' → ' + JSON.stringify(o.error))) : resolve(o.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  };
  return { ws, send, ev, close: () => ws.close() };
}

const Q = (arr) => JSON.stringify(arr);

const SNAP_JS = `(() => {
  const pick = (sels) => { for (const s of ${Q(SEL.agent)}) { const n = document.querySelectorAll(s); if (n.length) return n; } return []; };
  const agents = [...pick()];
  const last = agents[agents.length - 1];
  const hasEdit = !!document.querySelector(${JSON.stringify(SEL.edit[0])});
  const sendBtn = document.querySelector(${JSON.stringify(SEL.send[0])});
  return JSON.stringify({
    agentCount: agents.length,
    text: last ? (last.innerText || '') : '',
    hasEdit,
    sendDisabled: sendBtn ? !!sendBtn.disabled : null,
    bodyLen: (document.body && document.body.innerText || '').length,
  });
})()`;

export function cleanReply(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/\r/g, '').split('\n').map((l) => l.trim());
  const kept = lines.filter((l) => !CHROME_LINE.test(l));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function ask(prompt, { timeoutMs = 240000, settleMs = 3500 } = {}) {
  const t0 = Date.now();
  await ensureWorkbuddy();
  const c = await connect();
  try {
    // 发送前先等页面安静：上一轮还在流式生成时取的基线，会让「页面没变」被误判成
    // 「答案稳定」，最后把上一条答案当成本次结果返回（实测串台：问 DAG 回 CAP）。
    // 静默数据损坏比调用失败严重得多，所以这里宁可多等 12 秒。
    let base = JSON.parse(await c.ev(SNAP_JS));
    {
      let quiet = 0;
      const quietDeadline = Date.now() + 12000;
      while (Date.now() < quietDeadline && quiet < 3) {
        await sleep(700);
        const s = JSON.parse(await c.ev(SNAP_JS));
        const runningNow = RUNNING_RE.test(s.text || '');
        if (!runningNow && s.text === base.text && s.agentCount === base.agentCount) quiet++;
        else { quiet = 0; base = s; }
      }
      if (quiet < 3) console.error('[提示] workbuddy 页面 ' + Math.round((Date.now() - (quietDeadline - 12000)) / 1000) + 's 未安静，继续发送');
    }
    if (!base.hasEdit) throw new Error('界面已变：找不到 Slate 输入框（div[data-slate-editor]）');

    // 聚焦 + 清空
    await c.ev(`(()=>{const e=document.querySelector(${JSON.stringify(SEL.edit[0])});if(e)e.focus();return true})()`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });

    // 真实输入
    await c.send('Input.insertText', { text: prompt });
    const typed = await c.ev(`(()=>{const e=document.querySelector(${JSON.stringify(SEL.edit[0])});return (e&&e.innerText||'').length})()`);
    if (!typed) throw new Error('输入没进到输入框');

    const clicked = await c.ev(`(()=>{const b=document.querySelector(${JSON.stringify(SEL.send[0])});
      if(!b) return 'no-button'; if(b.disabled) return 'disabled'; b.click(); return 'clicked'})()`);
    if (clicked !== 'clicked') throw new Error('发送失败：' + clicked);

    // 不继承基线文本：只接受「发送之后新出现的」内容，否则旧答案会被当成新答案。
    let lastText = '';
    let stable = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(900);
      const s = JSON.parse(await c.ev(SNAP_JS));
      const cleanedNow = cleanReply(s.text || '');
      // 2026-11-14 修：思考中的界面文案是「稳定的」，旧逻辑 3.5 秒就当成答案收工。
      // 现在只有「洗完还剩正文」且「没有还在跑的标记」才算候选答案。
      const looksRunning = !cleanedNow || RUNNING_RE.test(s.text || '');
      if (looksRunning) {
        stable = 0;
        continue;
      }
      if (s.text === base.text) { stable = 0; continue; }   // 页面还没动，别把旧答案记成新答案
      if (s.agentCount > base.agentCount && s.text && s.text !== lastText) {
        lastText = s.text; stable = 0;
      } else if (s.text === lastText && lastText) {
        stable++;
      }
      if (s.agentCount > base.agentCount && stable >= Math.ceil(settleMs / 900)) break;
    }
    if (!lastText) throw new Error('等了 ' + Math.round((Date.now() - t0) / 1000) + ' 秒没拿到回答');
    const text = cleanReply(lastText);
    const ms = Date.now() - t0;
    // orchestra 约定字段：addedText / usage / elapsedMs / outputChars
    return {
      ok: true,
      agent: 'workbuddy',
      addedText: text,
      text,
      raw: lastText,
      ms,
      elapsedMs: ms,
      outputChars: text.length,
      usage: { in: 0, out: 0 },
    };
  } finally {
    c.close();
  }
}

/**
 * 文件信箱（2026-11-14 加）：产物走文件，绕开 markdown 渲染器。
 *
 * WorkBuddy 抓 DOM 的实测代价：反引号和 ## 全被渲染吃掉，343 秒还交回一个废产物
 * （`return [Function ${value.name}];` —— 两个反引号不见，代码直接坏掉）。
 * 让 WorkBuddy 自己写文件后，23.5 秒拿到逐字正确的产物，反引号/##/** 一个不少。
 *
 * 协议与 trae / 豆包一致：写 task → 只发一句含两个绝对路径的短指令 → 轮询 result。
 */
export async function askFile(taskPrompt, opts = {}) {
  if (!taskPrompt || !String(taskPrompt).trim()) throw new Error('taskPrompt 为空');
  const ws = opts.workspace || (opts.shared ? SHARED_WS : null) || WORKSPACE;
  const box = path.join(ws, '.mailbox');
  fs.mkdirSync(box, { recursive: true });
  const id = 'wb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const taskPath = path.join(box, id + '.task.md');
  const resultPath = path.join(box, id + '.result.md');
  fs.writeFileSync(taskPath, String(taskPrompt), 'utf8');

  const ins = [
    '请读取这个文件：' + taskPath,
    '按文件里写的任务执行，把最终产物完整写入：' + resultPath,
    '两个都是绝对路径，不要改写路径，不要在回复里粘贴产物。',
    '写完后只回复「完成」两个字。',
  ].join('\n');

  const t0 = Date.now();
  const r = await ask(ins, opts);

  const budget = opts.fileWaitMs ?? 60000;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    try {
      const s = fs.readFileSync(resultPath, 'utf8');
      if (s && s.trim()) {
        return { ok: true, agent: 'workbuddy', text: s, raw: s, file: resultPath, ms: Date.now() - t0 };
      }
    } catch { /* 还没写 */ }
    await new Promise(res => setTimeout(res, 1500));
  }
  return {
    ok: false, agent: 'workbuddy', text: '', file: null, ms: Date.now() - t0,
    reason: '结果文件 ' + budget + 'ms 内没有出现',
    reply: (r && (r.text || r.raw || '')) || '',
  };
}

export async function doctor() {
  const open = await portOpen();
  return {
    agent: 'workbuddy',
    port: PORT,
    portOpen: open,
    exeExists: (() => { try { return require('node:fs').existsSync(EXE); } catch { return false; } })(),
    exe: EXE,
    hint: open ? '可直接派活' : '端口没开 —— 派活时会重启应用（或设 ORCH_WB_RESTART=0 禁止）',
  };
}

// 直接命令行试跑：node agents/workbuddy.mjs "只回复两个字：收到"
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/agents/workbuddy.mjs')) {
  const p = process.argv[2] || '只回复两个字：收到';
  ask(p).then((r) => { console.log(r.text); console.log('---', r.ms + 'ms'); }).catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
