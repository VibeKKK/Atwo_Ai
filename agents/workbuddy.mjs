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
// 2026-11-15 修（决定性）：页面上有 **10 个** `[data-slate-editor]` —— 0–8 是历史消息的
// Slate 渲染（706×574~632，y 从 -2206 到 1446），只有最后一个 760×64 在底部的是真输入框。
// `querySelector(SEL.edit[0])` 拿到的是 index 0（一条历史消息），于是「清框」清错了元素、
// 「读回校验」读的也是历史消息 → 表现为 ①清不干净 ②答案残缺（历史消息里没有本次回答）
// ③把字母 s 当空白删（`.mjs`→`.mj`）。判据：宽>300 且高<200 的最后一个。
const ED_TEXT = `(() => {
  const eds = [...document.querySelectorAll('[data-slate-editor="true"]')]
    .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 300 && b.height < 520; });
  const e = eds[eds.length - 1];
  if (!e) return null;
  const c = e.cloneNode(true);
  c.querySelectorAll('[data-slate-placeholder]').forEach((x) => x.remove());
  return c.innerText || '';
})()`;

// 注意「已处理」和「已完成」不是一回事：思考中显示「已处理 5s」，收尾才变「已完成」。
// 2026-11-14 实测：把「已处理 5s / 准备中 / 思路在堵车，我正在指挥交通 / 不再显示」当成答案返回过。
const CHROME_LINE = /^(WorkBuddy|已完成.*|已处理.*|准备中|不再显示|思路在堵车.*|思考中.*|Hy4|DeepSeek.*|等待模型响应|脑子转得冒烟.*|深度求索中.*|正在生成.*|加载中.*|用时\s*\d+.*|\d{1,2}:\d{2}(:\d{2})?|\d+\s*[s秒]|\|)$/;
// 「还在跑」的界面信号：命中就说明这一屏不是答案，别当完成
// 2026-11-15 实测：新会话第一条消息会先渲染「等待模型响应 / 脑子转得冒烟了」，
// 它稳定超过 settle 窗口 → 曾被当成答案返回（len=14 全是占位文案）。
const RUNNING_RE = /(思路在堵车|正在指挥交通|准备中|已处理\s*\d|思考中|等待模型响应|脑子转得冒烟|深度求索中|正在生成|加载中)/;
// 任务卡（实测会把 prompt 全文抄进「- 任务：…」）：它是摘要气泡，不是答案。
// 判定：同时出现「任务：」与「耗时」，或者出现「产出长度」。
const TASK_CARD_RE = (t) => {
  const x = String(t || "");
  return (/任务\s*[:：]/.test(x) && /耗时/.test(x)) || /产出长度/.test(x);
};

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
  // 2026-11-14 修（结构性）：答案在 .cr-agent__body-row 里；任务卡是「另一条」.cr-agent
  // （内容是「- 任务：<prompt 全文> / - 耗时 / - 结果 / - 产出长度」）。
  // 以前取最后一条，碰上任务卡就整段回声 prompt。改成从后往前挑第一条「不是卡」的。
  const bodyOf = (el) => { const b = el.querySelector('.cr-agent__body-row'); return (b || el).innerText || ''; };
  const isCard = (t) => /产出长度/.test(t) || (/任务\s*[:：]/.test(t) && /耗时/.test(t)) || /^\s*\[子目标\]/.test(t);
  let chosen = '';
  for (let i = agents.length - 1; i >= 0; i--) {
    const t = bodyOf(agents[i]);
    if (t && !isCard(t)) { chosen = t; break; }
  }
  const hasEdit = (() => {
    const eds = [...document.querySelectorAll('[data-slate-editor="true"]')]
      .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 300 && b.height < 520; });
    return eds.length > 0;
  })();
  const sendBtn = document.querySelector(${JSON.stringify(SEL.send[0])});
  return JSON.stringify({
    agentCount: agents.length,
    text: chosen,
    hasEdit,
    sendDisabled: sendBtn ? !!sendBtn.disabled : null,
    bodyLen: (document.body && document.body.innerText || '').length,
  });
})()`;

export function cleanReply(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/\r/g, '').split('\n').map((l) => l.trim());
  const kept = lines.filter((l) => !CHROME_LINE.test(l) && !/^[-*]?\s*(任务|耗时|结果|产出长度|\/记忆)\s*[:：]/.test(l));
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

    // 聚焦 + 清空（2026-11-15 修：原来只发一次 Ctrl+A/Backspace 且不校验，
    // 而且用的是 querySelector 命中的第一条历史消息编辑器，压根没清到真输入框）
    // 现在统一走 ED_TEXT：底部那个 宽>300 高<200 的最后一个 slate 编辑器。
    // 关键手法：**全选后直接 insertText 覆盖**（insertText 会替换选区），
    // 比「先删干净再输入」可靠 —— 删除键对 Slate 的软换行/占位残留不总是生效。
    const edLen = `(() => { const t = ${ED_TEXT}; return t === null ? -1 : t.replace(/\\s/g, '').length; })()`;
    const norm = (x) => String(x || '').replace(/\s+/g, '');
    const focusEd = `(() => {
      const eds = [...document.querySelectorAll('[data-slate-editor="true"]')]
        .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 300 && b.height < 520; });
      const e = eds[eds.length - 1]; if (e) e.focus(); return !!e;
    })()`;
    const selectAll = async () => {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await sleep(150);
    };
    let typedOk = false;
    for (let attempt = 1; attempt <= 3 && !typedOk; attempt++) {
      if (!(await c.ev(focusEd))) throw new Error('界面已变：找不到 Slate 输入框');
      await selectAll();
      // 覆盖写入：选区被替换，残留不会接在前面
      await c.send('Input.insertText', { text: prompt });
      await sleep(400);
      const inBox = await c.ev(ED_TEXT);
      const nb = norm(inBox);
      const np = norm(prompt);
      if (nb === np) { typedOk = true; break; }
      // 允许首尾极少量空白差异，但长度不能超过 prompt 的 105%（超了说明有残留）
      if (nb.includes(np.slice(-40)) && nb.length <= Math.ceil(np.length * 1.05)) { typedOk = true; break; }
      console.error('[重试] 输入框内容不符（第 ' + attempt + ' 次）：框内 ' + nb.length + ' 字 / 期望 ' + np.length + ' 字');
    }
    if (!typedOk) {
      const inBox = await c.ev(ED_TEXT);
      throw new Error('输入框内容与预期不符（残留未清掉）：框内 ' + norm(inBox).length + ' 字，期望 ' + norm(prompt).length + ' 字');
    }

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
      // 2026-11-14 修：任务卡与答案是同一个气泡，所以不能在循环里整条跳过卡片
      // （那样会永远等不到答案）。改成：卡片字段已在 cleanReply 里剥掉，
      // 剩下为空 = 还没答；剩下基本等于 prompt = 回声，也不算答。
      const echoed = (() => {
        // 回声 = 回来的内容基本就是 prompt 本身。必须带长度门槛：
        // 短答案（如「丙丁」两个字）天然是 prompt 的子串，不能算回声（实测误杀过）。
        // 2026-11-15 修：原来是 /s+/g（把正文里所有字母 s 删了，".mjs"→".mj"、"ls"→"l"），
        // 导致比对和返回内容全是残缺的。必须是 /\s+/g（去空白）。
        const p = String(prompt || "").replace(/\s+/g, "").trim();
        const t = String(cleanedNow || "").replace(/\s+/g, "").trim();
        if (!p || !t) return false;
        if (t.length < 20) return false;
        // 只有「回来的一半以上都是 prompt」才算回声。长 prompt 里答案引用要求是正常的，
        // 门槛设低了会把正经回答全判成回声（实测：拆解任务 242 秒空等）。
        if (t.length < p.length * 0.6) return false;
        return p.includes(t) || t.includes(p.slice(0, 120));
      })();
      const looksRunning = !cleanedNow || RUNNING_RE.test(s.text || "") || echoed;
      if (looksRunning) {
        stable = 0;
        continue;
      }
      if (s.text === base.text) { stable = 0; continue; }   // 页面还没动，别把旧答案记成新答案
      const progressed = (s.agentCount !== base.agentCount) || (s.bodyLen !== base.bodyLen);
      if (progressed && s.text && s.text !== lastText) {
        lastText = s.text; stable = 0;
      } else if (s.text === lastText && lastText) {
        stable++;
      }
      if (progressed && stable >= Math.ceil(settleMs / 900)) break;
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

/**
 * 换模型（2026-11-16 实测可用的唯一一条 GUI 通道）。
 *
 * 为什么这块必须短轮询：点开 trigger 之后菜单只活几百毫秒，
 * 先 sleep(900) 再查必然拿到空数组（我第一版就是这么写的，误判成「菜单不是 DOM」）。
 * 现在 120ms 一轮、最多 10 轮，抓到就立刻点。
 *
 * 判据用「读回 trigger 的文字」，不用返回值 —— 点一下没报错不代表切成功了。
 *
 * @param {string} name 菜单里显示的名字，如 Hy3 / GLM-5.3-Flash / Kimi-K3.1-Pro
 * @returns {Promise<{ok:boolean, from:string|null, to:string|null, reason?:string, menu?:string[]}>}
 *          永不抛异常：换模型是优化，不是前置条件（切不动只记一行，不阻断派活）
 */
export async function setModel(name) {
  const want = String(name == null ? '' : name).trim();
  if (!want) return { ok: false, from: null, to: null, reason: '没给模型名' };
  const open = await portOpen();
  if (!open) return { ok: false, from: null, to: null, reason: '端口 ' + PORT + ' 没开' };

  let c;
  try {
    c = await connect();
    const CUR = `(() => { const t = document.querySelector('.cr-model-selector__trigger'); return t ? t.textContent.trim().replace(/\\s+/g, ' ') : null; })()`;
    const from = await c.ev(CUR);
    if (from && from.includes(want)) return { ok: true, from, to: from, reason: '本来就是它' };

    await c.ev(`(() => { const b = document.querySelector('.cr-model-selector__trigger'); if (b) { b.click(); return 'ok'; } return 'no-trigger'; })()`);

    const ITEMS = `(() => [...document.querySelectorAll('.cr-model-selector__item')].map((el) => {
      const r = el.getBoundingClientRect();
      return { t: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40), vis: r.width > 10 && r.height > 6 };
    }).filter((x) => x.vis).map((x) => x.t))()`;

    let menu = [];
    for (let i = 0; i < 10; i++) {
      await sleep(120);
      menu = (await c.ev(ITEMS)) || [];
      if (menu.length) break;
    }
    if (!menu.length) return { ok: false, from, to: from, reason: '点了 trigger 但菜单没弹出（原生菜单或还没渲染）', menu: [] };

    const hit = await c.ev(`(() => {
      const want = ${JSON.stringify(want)};
      for (const el of document.querySelectorAll('.cr-model-selector__item')) {
        if (el.textContent.replace(/\\s+/g, ' ').includes(want)) { el.click(); return 'clicked'; }
      }
      return 'not-found';
    })()`);
    if (hit !== 'clicked') return { ok: false, from, to: from, reason: '菜单里没有「' + want + '」', menu };

    await sleep(1200);
    const to = await c.ev(CUR);
    if (to && to.includes(want)) return { ok: true, from, to, menu };
    return { ok: false, from, to, reason: '点了但 trigger 还是「' + to + '」', menu };
  } catch (e) {
    return { ok: false, from: null, to: null, reason: (e && e.message) || String(e) };
  } finally {
    try { if (c) c.close(); } catch { }
  }
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

/**
 * 只读一次菜单：当前选的是哪个、菜单里现在有哪些模型。
 *
 * 为什么要有它：模型会消失（用户 2026-11-17：「hy3 没了，模型变动很正常」）。
 * 派活前问一次菜单，比失败后再问便宜得多 —— 失败一次是 45 秒起。
 * 不点任何模型，读完按 Escape 关菜单。
 */
export async function listModels() {
  let c;
  try {
    const open = await portOpen();
    if (!open) return { ok: false, reason: '端口 ' + PORT + ' 没开' };
    c = await connect();
    const CUR = `(() => { const t = document.querySelector('.cr-model-selector__trigger'); return t ? t.textContent.trim().replace(/\s+/g, ' ') : null; })()`;
    const current = await c.ev(CUR);
    await c.ev(`(() => { const b = document.querySelector('.cr-model-selector__trigger'); if (b) { b.click(); return 'ok'; } return 'no-trigger'; })()`);
    const ITEMS = `(() => [...document.querySelectorAll('.cr-model-selector__item')].map((el) => {
      const r = el.getBoundingClientRect();
      return { t: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40), vis: r.width > 10 && r.height > 6 };
    }).filter((x) => x.vis).map((x) => x.t))()`;
    let menu = [];
    for (let i = 0; i < 10; i++) {
      await sleep(120);
      menu = (await c.ev(ITEMS)) || [];
      if (menu.length) break;
    }
    try { await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); } catch { }
    if (!menu.length) return { ok: false, current, reason: '点了 trigger 但菜单没弹出' };
    return { ok: true, current, models: menu };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  } finally {
    try { if (c) c.close(); } catch { }
  }
}
