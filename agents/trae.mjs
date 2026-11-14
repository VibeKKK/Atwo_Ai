// Trae 驱动：把一句话送进 Trae 的 Agent 面板，等它干完，把「新增的回复」拿回来
// 原理：Trae 是 Electron，用 --remote-debugging-port 开 CDP，直接操作 DOM。
// 由 Trae 自己评审过一轮（reviews/trae-review-trae.mjs.md），下面按它的意见修了 1/2/3/4/5/9 条。
import { attach } from '../lib/cdp.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.TRAE_CDP_PORT || 9223);
const SEL_EDIT = '[contenteditable="true"]';
const TRAE_EXE = process.env.TRAE_EXE || 'D:\\code app\\ai code\\Trae CN\\Trae CN.exe';
// 三通道共享工作区（2026-11-14 用户指定）：需要跨通道协作时传 opts.shared=true 就走这里
const SHARED_WS = process.env.ORCH_SHARED_WS || 'D:\\ai work replace\\TDW place';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 9223 是否已监听（CDP 桥在不在） */
function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { sock.destroy(); } catch { } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * 确保 Trae（GUI）在跑且 CDP 桥可用。
 * 关键坑（2026-11-13 实测）：DSH 本身是 Electron，环境里带着 ELECTRON_RUN_AS_NODE=1，
 * 继承给子进程后 Trae 会以 node 模式启动、打印 v22.21.1 后立刻退出，9223 永不监听。
 * 所以启动前必须把这两个变量删掉。
 */
export async function ensureTrae({ port = PORT, exe = TRAE_EXE, waitMs = 90000 } = {}) {
  if (await portOpen(port)) return { started: false, port, waitedMs: 0 };
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // ← 不删就会变成 node 进程
  delete env.NODE_OPTIONS;
  delete env.VSCODE_DEV;
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    cwd: exe.replace(/[\\/][^\\/]+$/, ''),
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(500);
    if (await portOpen(port)) return { started: true, port, waitedMs: Date.now() - t0, pid: child.pid };
  }
  throw new Error(`Trae 拉起失败：${waitMs}ms 内 ${port} 未监听（exe=${exe}）。手动开一次 Trae 再试。`);
}

/** 文档里可能有多个 contenteditable（搜索框、重命名框…），取尺寸最大的那个当输入框 */
const PICK_EDIT = `(() => {
  const all = [...document.querySelectorAll('${SEL_EDIT}')]
    .map(e => ({ e, r: e.getBoundingClientRect() }))
    .filter(x => x.r.width > 100 && x.r.height > 10);
  // 2026-11-13 修：Trae 面板切换瞬间输入框尺寸会归零，旧版宽高门槛（200x20）会把元素全滤掉，
  // 表现为「明明有输入框却读到 null」。筛不到时退回任意 contenteditable。
  if (all.length) {
    all.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    return all[0].e;
  }
  return document.querySelector('${SEL_EDIT}') || null;
})()`;

async function inputSelectorReady(c, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await c.js(`!!${PICK_EDIT}`)) return true;
    await sleep(400);
  }
  return false;
}

async function readEditor(c) {
  // 2026-11-13 修：元素未渲染时 e.innerText === undefined，经 JSON 序列化变 null，
  // 于是「输入框空着」被误判成「读不到输入框」。改为：有元素就必返回字符串（退回 textContent）。
  return c.js(`(() => {
    const e = ${PICK_EDIT};
    if (!e) return null;
    const t = e.innerText;
    if (typeof t === 'string') return t;
    return (e.textContent == null ? '' : e.textContent);
  })()`);
}

/**
 * 清空输入框。
 * Lexical 不认 JS 层的 execCommand('delete')，只能用 CDP 真实键盘。
 * 已经用 range 手动全选了，Ctrl+A 是冗余的，而且 macOS 上 Ctrl+A 是「移到行首」会折叠选区——
 * 所以只在非 darwin 上补一次 Ctrl+A（保险），Delete 之后校验长度。
 * @returns {Promise<number>} 剩余「非空白」字符数；-1 表示输入框不存在
 */
async function clearInput(c) {
  const ok = await c.js(`(() => {
    const e = ${PICK_EDIT};
    if (!e) return false;
    e.focus();
    const s = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(e);
    s.removeAllRanges();
    s.addRange(r);
    return true;
  })()`);
  if (!ok) return -1;
  await sleep(120);

  if (process.platform !== 'darwin') {
    await c.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await sleep(150);
  }
  await c.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await sleep(350);

  const left = await readEditor(c);
  return left === null ? -1 : left.replace(/[\s\u200b]/g, '').length;
}

/** 把文字写进输入框：派发 paste 事件（Lexical 只认这条），然后轮询等 DOM 更新 */
async function typeInto(c, text) {
  // 用 CDP 真键盘输入（Input.insertText），不用合成 paste 事件：
  // 合成事件只改 DOM，不更新 Slate 内部状态，导致随后的 Enter 不触发提交。
  const ok = await focusEditor(c);
  if (!ok) throw new Error('Trae 输入框不见了（面板切走了？）');
  try { await clearInput(c); } catch { }
  await focusEditor(c);
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      // Shift+Enter 换行（纯 Enter 会提交）
      await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 });
      await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 });
    }
    if (lines[i]) await c.call('Input.insertText', { text: lines[i] });
  }

  const norm = (s) => String(s || '').replace(/\r/g, '').replace(/\n+/g, '\n').trim();
  const want = norm(text).slice(-30);
  let last = '';
  for (let i = 0; i < 50; i++) {
    await sleep(120);
    last = norm(await readEditor(c));
    if (last.includes(want)) return last;
  }
  throw new Error('输入没进去（读回不匹配）：' + last.slice(0, 60));
}

/** 等某个 CDP 目标出现（Trae 刚启动时窗口还没建，直接 attach 会 no target） */
async function waitForTarget(port, titlePart, timeoutMs = 90000) {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      last = list;
      const hit = list.find(t => t.type === 'page' && (t.title || '').includes(titlePart));
      if (hit) return hit;
    } catch { /* 端口刚开、/json/list 还没就绪 */ }
    await sleep(700);
  }
  throw new Error(`等了 ${timeoutMs}ms 也没见到 "${titlePart}" 目标；当前有: ` + last.map(t => t.title || '(空)').join(' | '));
}

/**
 * 整页文本序列化器（带换行）。
 * 为什么不用 document.body.innerText：Trae 的代码块把每行渲染成独立的块级元素，
 * innerText 在这些元素之间会吐空格而不是 \n —— 结果整段代码被压成一行，
 * 拿去跑就是 IndentationError（2026-11-13 实测：top_lnk 函数被压成 1 行）。
 * 这里自己走一遍 DOM：块级元素前后补 \n，<br> 补 \n，<pre> 直接取 innerText。
 */
const SER_TEXT = `(() => {
  const BLOCK = new Set(['DIV','P','LI','TR','SECTION','ARTICLE','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','UL','OL','TABLE','PRE','HEADER','FOOTER','DT','DD']);
  const out = [];
  function walk(n) {
    if (!n) return;
    if (n.nodeType === 3) { out.push(n.nodeValue); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
    if (tag === 'BR') { out.push('\\n'); return; }
    if (tag === 'PRE') {
      out.push('\\n');
      out.push(n.innerText != null ? n.innerText : (n.textContent || ''));
      out.push('\\n');
      return;
    }
    const block = BLOCK.has(tag);
    if (block) out.push('\\n');
    for (const ch of n.childNodes) walk(ch);
    if (block) out.push('\\n');
  }
  walk(document.body);
  return out.join('').replace(/\\n[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n');
})()`;

/** 整页渲染文本（含滚动外内容，块级换行已保留） */
/** 等页面文本连续 quietMs 不再变化，再拿基线。
 *  为什么必须有这一步：上一批被 kill 时 Trae 页面往往还在流式生成上一个答案。
 *  此时 readAnswers 取到的基线是「半截文本」，生成结束后 ans.text !== baseAns.text 天然成立，
 *  新调用就会把**别人的答案**当成自己的返回 —— 实测踩过：问 clamp，回的是上一轮的 plan.mjs。
 *  静默数据损坏比调用直接失败严重得多（错误答案会被当成真结果落盘），所以宁可多等 2.5 秒。
 *  超过 maxMs 还不安静也不阻塞调用：页面长期忙，后续判据本来就会超时，让它按原路径失败。
 *  @param {object} c CDP 连接对象
 *  @param {{quietMs?: number, maxMs?: number}} [opts] quietMs 默认 2500，maxMs 默认 30000
 *  @returns {Promise<{ok: boolean, waitedMs: number}>} ok=false 表示是超时放行，不是成功 */
async function waitSettled(c, opts = {}) {
  const quiet = opts.quietMs ?? 2500;
  const max = opts.maxMs ?? 30000;
  const t0 = Date.now();
  let last = '';
  let sameSince = Date.now();
  while (Date.now() - t0 < max) {
    const cur = String((await readAnswers(c).catch(() => null) || {}).text || '');
    if (cur !== last) { last = cur; sameSince = Date.now(); }
    else if (Date.now() - sameSince >= quiet) return { ok: true, waitedMs: Date.now() - t0 };
    await sleep(500);
  }
  return { ok: false, waitedMs: Date.now() - t0 };
}

async function pageText(c, scope) {
  // 2026-11-13：默认收窄到对话区 `.ai-chat`。整页 body 会把左侧任务列表
  // （"Create Python Retry Decorator" / "写 Python retry 装饰器" 之类）也算进答案，
  // 实测抽出来的文本前面掺着会话标题。收窄后 diff 只包含真正的消息。
  const sel = scope === undefined ? '.ai-chat' : scope;
  if (!sel) return c.js(SER_TEXT);
  const inScope = SER_TEXT.replace('walk(document.body)',
    'walk(document.querySelector(' + JSON.stringify(sel) + ') || document.body)');
  return c.js(inScope);
}

/** 判断 Trae 是否还在干活。作用域尽量收窄，避免用户提问里出现关键词就永远 busy */
// 2026-11-14 决定性发现（_probe_busy2.mjs 实测）：Trae 没有 aria-busy、没有独立停止按钮，
// 但**发送键自己就是状态指示灯** —— 同一个 button.chat-input-v2-send-button：
//   · 生成中：svg path 以 `M9.9345` 开头（方块 = 停止），class 里没有 disabled
//   · 空闲：  svg path 以 `M7.65576` 开头（上箭头 = 发送）
// 这比「看文本变没变」可靠得多：文本判据分不清「答案迟到 / 回声 / 已写完」三种状态，
// 而按钮状态由界面自己维护，且与流式文本无关。
async function genState(c) {
  const r = await c.js(`(() => {
    const b = document.querySelector('button.chat-input-v2-send-button');
    if (!b) return 'no-button';
    const svg = b.querySelector('svg');
    const p = svg && svg.querySelector('path');
    const d = p ? (p.getAttribute('d') || '') : '';
    const cls = String(b.className || '');
    if (/^M9\\.9345/.test(d)) return 'generating';          // 方块图标 = 停止键
    if (/^M7\\.65576/.test(d)) return 'idle';               // 上箭头 = 发送键
    if (/disabled/.test(cls)) return 'idle';
    return 'unknown:' + d.slice(0, 12);
  })()`);
  return String(r || 'unknown');
}

async function isBusy(c) {
  // 1) 结构信号（首选）：发送键图标是不是「方块/停止」
  const st = await genState(c).catch(() => 'unknown');
  if (st === 'generating') return true;
  if (st === 'idle') return false;
  // 2) 退化信号：只在结构信号拿不到（按钮不存在 / 图标变了）时才看文本与停止按钮
  return c.js(`(() => {
    // 只看页面末尾：历史消息里残留的「思考中」会让整页判断永远 busy
    const tail = (document.body.innerText || '').slice(-1200);
    if (/思考中|生成中|正在生成|Stop generating/i.test(tail)) return true;
    const stop = document.querySelector('[data-testid*="stop" i],[aria-label*="停止"],[aria-label*="Stop" i]');
    if (stop) { const r = stop.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return true; }
    return false;
  })()`);
}

// 点一下输入框中心拿焦点：新开对话后输入组件会被重建，没焦点时输入与回车都会落空。
async function focusEditor(c) {
  // 2026-11-13 修：优先用 JS `el.focus()` + Range 把光标放到末尾。
  // 只用鼠标坐标点击时，页面一滚动/布局一动，点击就落空 → 焦点没进编辑器 → Enter 白按
  //（表现为「回车没发出去，输入框还留着文字」）。鼠标点击降级为后备。
  const viaJs = await c.js(`(() => {
    const eds = [...document.querySelectorAll(SEL_EDIT)].filter(e => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 10; });
    const e = eds[0] || document.querySelector(SEL_EDIT);
    if (!e) return 'NO_EDITOR';
    try { e.focus(); } catch (err) { return 'FOCUS_THROW:' + String(err && err.message || err).slice(0, 60); }
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(e);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    const act = document.activeElement;
    const ok = act === e || (act && e.contains(act)) || e.contains(act);
    return ok ? 'OK' : 'NOT_ACTIVE:' + (act ? (act.className || act.tagName) : 'null');
  })()`.replace(/SEL_EDIT/g, JSON.stringify(SEL.edit)));
  if (String(viaJs).startsWith('OK')) { await sleep(80); return true; }

  // 后备：鼠标点元素中心
  const rect = await c.js(`(() => {
    const eds = [...document.querySelectorAll(SEL_EDIT)].filter(e => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 10; });
    const e = eds[0]; if (!e) return null;
    const r = e.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`.replace(/SEL_EDIT/g, JSON.stringify(SEL.edit)));
  if (!rect) return false;
  const p = JSON.parse(rect);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.call('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  await sleep(150);
  return true;
}

/**
 * 点进任务列表里的某一条（发送后有些情况下会停留在「任务列表」而不是对话页）。
 * needle 是提示词结尾，用来优先命中刚发出去的那条；找不到就点第一条。
 */
async function openTaskWith(c, needle) {
  const r = await c.js(`(() => {
    const items = [...document.querySelectorAll("div.taskItem, div.taskItemWrapper")];
    if (!items.length) return "NO_ITEM";
    const n = ${JSON.stringify(String(needle || ""))};
    let hit = n ? items.find(e => ((e.innerText || "").includes(n))) : null;
    if (!hit) hit = items[0];
    hit.click();
    return "CLICKED";
  })()`);
  await sleep(1200);
  return r;
}
// 2026-11-13 实测（_probe_send4.mjs）：真正的发送键是 `button.chat-input-v2-send-button`
// （32×32，无 aria-label / title / 文本，所以按文字找必然点错；chat-icon-up 是模型选择器）。
// 点它比按回车可靠：回车在长文本 / 焦点被抢时会被吞掉。
async function clickSend(c) {
  const box = await c.js(`(() => {
    const b = document.querySelector('button.chat-input-v2-send-button');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const disabled = b.disabled === true || b.getAttribute('aria-disabled') === 'true';
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), disabled });
  })()`);
  if (!box) return { ok: false, reason: 'no-button' };
  const b = JSON.parse(box);
  if (b.disabled) return { ok: false, reason: 'disabled' };
  const { x, y } = b;
  await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    const cur = await readEditor(c).catch(() => null);
    if (cur === null) return { ok: true, sentBy: 'button-editor-gone', at: { x, y } };
    if (String(cur).replace(/[\s\u200b]/g, '') === '') return { ok: true, sentBy: 'button', at: { x, y } };
  }
  return { ok: false, reason: 'not-cleared', at: { x, y } };
}

async function pressEnter(c) {
  // 实测（2026-11-13，_probe_enter.mjs）：Trae 只认 keyDown + keyUp，不带 text；
  // rawKeyDown+char 反而发不出去。另一个必要条件是**发送前重新聚焦**。
  // 2026-11-13 修（第二轮）：先点 `button.chat-input-v2-send-button`——实测回车在长文本
  // 时会被吞（连按 4 次输入框仍留 64 字符），而按钮点击一次就过。回车降级为后备。
  // 返回 {ok, sentBy, rounds, lastLen, lastFocus}。
  try {
    const click = await clickSend(c);
    if (click.ok) return { ok: true, sentBy: click.sentBy, rounds: 0, lastLen: 0, lastFocus: 'click', editorFound: true };
  } catch (e) { /* 按钮路径失败就走回车 */ }
  const BACKOFF = [300, 600, 1000, 1500];
  let lastLen = -1;
  let lastFocus = '';
  let noEditor = 0;
  for (let round = 1; round <= BACKOFF.length; round++) {
    try { lastFocus = String(await focusEditor(c)); } catch (e) { lastFocus = 'THROW:' + (e && e.message); }
    await sleep(120);
    await c.call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await c.call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    // 清空可能不是瞬时的：每轮最多轮询 1.2 秒
    for (let i = 0; i < 6; i++) {
      await sleep(200);
      const cur = await readEditor(c).catch(() => null);
      // 2026-11-13 修（决定性）：按 Enter 之后 Trae 会切走/卸载输入框，
      // 于是 readEditor 返回 null。旧逻辑把这个 null 当成「没清空 → 没发出去」，
      // 把已经成功的发送误报成失败（实测连测两次都是 0/1 且报「输入框读不到」）。
      // 现在：编辑器消失 = 已发送，交给外层用「是否出现新答案」来最终确认。
      if (cur === null) {
        return { ok: true, rounds: round, lastLen: 0, lastFocus, editorFound: false, sentBy: 'editor-gone' };
      }
      const stripped = String(cur).replace(/[\s\u200b]/g, '');
      if (stripped === '') return { ok: true, rounds: round, lastLen: 0, lastFocus, editorFound: true };
      lastLen = stripped.length;
    }
    await sleep(BACKOFF[round - 1]);
  }
  return { ok: false, rounds: BACKOFF.length, lastLen, lastFocus, editorFound: noEditor === 0 };
}

// 发送失败时的自愈。实测：卡住的会话里按钮和回车会持续失效（日志里同一题连挂 4 次），
// 而换新对话后同一份文本能正常发出 —— 坏的会话层状态，不是输入方式本身。
// 返回 true 表示两档之中有一档已成功送出。
async function recoverSend(c, text) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt === 1) {
        // 一档：原地清空 + 重新粘贴（面板只是被打断时，这一档就够）
        await clearInput(c);
        await sleep(200);
      } else {
        // 二档：开新对话彻底重置（会话状态坏了，原地清空救不回来）
        await clickNewTask({ port: PORT });
        await sleep(700);
      }
      await typeInto(c, text);
      await sleep(250);
      const e = await pressEnter(c);
      if (e && e.ok) { console.error('[自愈' + attempt + '] 已送出'); return true; }
    } catch (err) {
      console.error('[自愈' + attempt + '] 失败：' + (err && err.message));
    }
  }
  return false;
}

/** 从新增区域里剥出 Trae 真正说的话：TRAE 标记之后、「由 AI 生成」之前 */
function extractReply(text) {
  const s = String(text || '');
  const i = s.lastIndexOf('TRAE');
  // 2026-11-14 实测修正：Trae CN 1.107 的回答**没有**「由 AI 生成」尾标（出现 0 次），
  // 旧逻辑 j > i 永不成立 → 直接返回整段 .ai-chat 全文 → extractCode 抓到最早那个
  // 围栏（旧任务的答案），表现为「问 clamp 回的是上一轮的 retry 装饰器」。
  // 正确做法：以「最后一个 TRAE」为起点（那必然是最近一次助手回复），
  // 再把可能存在的尾标当可选裁剪 —— 有就切，没有就不切。
  let body = i >= 0 ? s.slice(i + 4) : s;
  const j = body.lastIndexOf('由 AI 生成');
  if (j > 0) body = body.slice(0, j);
  body = body.replace(/^\s*思考过程\s*$/m, '');
  return body.trim();
}

/**
 * 清掉代码块的「外壳」：行号栏、语言标签、复制按钮文字。
 * 实测（2026-11-13）：Trae 的代码块渲染成 <pre> + 行号 gutter，
 * 序列化后行号 1..N 会作为独立行混进来，语言名（Python）也会单独一行。
 * @param {string} text
 */
function cleanCodeChrome(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const isNum = (s) => /^\s*\d{1,4}\s*$/.test(s);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isNum(lines[i])) {
      let j = i;
      while (j < lines.length && isNum(lines[j])) j++;
      if (j - i >= 3) { i = j; continue; }   // 连续 ≥3 行纯数字 = 行号栏，整块丢掉
    }
    out.push(lines[i]);
    i++;
  }
  const lang = /^(python|py|python3|javascript|js|typescript|ts|java|c|cpp|csharp|go|rust|bash|sh|powershell|json|yaml|xml|html|css|sql|text|plaintext)$/i;
  const kept = out.filter((l, idx) => !(idx < 4 && lang.test(l.trim())));
  const noCopy = kept.filter((l) => !/^(复制|拷贝|复制代码|copy|copy code|run|运行)$/i.test(l.trim()));
  while (noCopy.length && !noCopy[0].trim()) noCopy.shift();
  while (noCopy.length && !noCopy[noCopy.length - 1].trim()) noCopy.pop();
  return noCopy.join('\n').trim();
}

// 修复 markdown 渲染吃掉成对星号造成的损伤。
// 2026-11-14 实测：Trae 的回答区不是 pre 标签，裸 JSON 里的 JSDoc 开头（斜杠加两个星号）
// 会被浏览器当 bold 解析，结果只剩一个斜杠（两个星号都被吃掉）；而 JSDoc 结尾的
// 星号加斜杠是单个星号，反而不受影响 —— 非对称损伤。
// 落盘后 node --check 立刻报 "Invalid regular expression: missing /"。
// 判据很窄：一行只有斜杠或斜杠加星号，且下一行以星号开头 → 原本必然是 JSDoc 开头。
export function repairBoldMangled(code) {
  return String(code || '')
    .replace(/^([ \t]*)\/\*(?=\n[ \t]*\*)/gm, '$1/**')
    .replace(/^([ \t]*)\/(?=\n[ \t]*\*)/gm, '$1/**');
}

/** 从文本里抽出代码：优先认契约 JSON，其次第一个 ```lang … ``` 围栏，都没有就原样返回 */
export function extractCode(text) {
  const s = String(text || '');
  // 2026-11-14 实测补充：Trae 输出契约时**不走围栏**，直接吐裸 JSON
  // （`{"summary":"…","code":"…","notes":[…]}`）。只查围栏正则会整段 JSON 当代码返回，
  // 落盘后 node --check 立刻失败。这里先按「从后往前」试 JSON.parse，
  // 取最后一个能解析出 code/content/implementation 的对象 —— 最后一个才是本次回答。
  const braced = s.match(/\{[\s\S]*\}/g) || [];
  for (let k = braced.length - 1; k >= 0; k--) {
    try {
      const o = JSON.parse(braced[k]);
      const code = o.code ?? o.content ?? o.implementation;
      if (typeof code === 'string' && code.trim()) {
        return repairBoldMangled(code.replace(/^\s*\n/, '').replace(/\s*$/, ''));
      }
    } catch { /* 不是合法 JSON，继续往前试 */ }
  }
  const m = s.match(/```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)```/);
  return repairBoldMangled((m ? m[1] : s).replace(/^\s*\n/, '').replace(/\s*$/, ''));
}

const commonPrefixLen = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
};

/**
 * 发送一条提示词，等 Trae 回复完，返回新增的文本。
 * @param {string} prompt
 * @param {{timeoutMs?:number, settleMs?:number, port?:number}} opts
 */
export async function askTrae(prompt, opts = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt 为空');
  const timeoutMs = Math.max(opts.timeoutMs ?? 240000, 30000);
  const settleMs = opts.settleMs ?? 3500;   // busy 判断已收窄到页尾，不需要长等
  // 确保 Trae 在跑（没跑就带干净环境拉起来，避免 ELECTRON_RUN_AS_NODE 把它变成 node 进程）
  // 2026-11-13 加（rank2）：`--no-autostart` / ORCH_TRAE_NO_AUTOSTART=1 关掉自动拉起。
  // 用户手动开着 Trae 干别的事时，自动拉起会插一个新窗口抢焦点。
  // 关掉后若端口本来就不通，要明确报错，不能让它静默走到 attach 失败。
  const noAuto = opts.autostart === false || process.env.ORCH_TRAE_NO_AUTOSTART === '1';
  if (noAuto) {
    if (!(await portOpen(PORT))) throw new Error('Trae 未运行，且已禁用自动拉起（ORCH_TRAE_NO_AUTOSTART=1）：请先手动打开 Trae CN 再派活');
  } else {
    await ensureTrae({ port: opts.port ?? PORT, waitMs: opts.bootTimeoutMs ?? 90000 });
  }
  // 端口开了不等于窗口建好了，等 Agent 面板目标出现再连
  await waitForTarget(opts.port ?? PORT, 'Agent', opts.bootTimeoutMs ?? 90000);
  const c = await attach(opts.port ?? PORT, 'Agent');
  try {
    if (!await inputSelectorReady(c)) throw new Error('Trae Agent 面板没就绪');

    // 开新对话默认关闭（2026-11-13 回退）：
    // 实测「点新建任务 → 落地页输入 → 发送」这条路里，Trae 把消息接下去但
    // 会话区（.ai-chat / 虚拟列表）读不到任何文本，判据必空转。
    // 目前可靠的仍是「在已有会话里继续问 + 用最后一条回合文本判完成」。
    //   ORCH_TRAE_NEW_CHAT=1 手动开启（适合人工盯着跑）
    const useNewChat = process.env.ORCH_TRAE_NEW_CHAT === '1';
    if (useNewChat) {
      try {
        const nc = await clickNewTask({ port: opts.port ?? PORT });
        if (!nc.ok) console.error('[提示] 开新对话失败：' + nc.reason);
        await sleep(500);
        await focusEditor(c);   // 新对话会换掉输入组件，必须重新点一下拿焦点
      } catch (err) { console.error('[提示] 开新对话异常：' + err.message); }
    }

    let left = await clearInput(c);
    if (left < 0) throw new Error('输入框不存在（面板可能没打开）');
    if (left > 0) { await sleep(400); left = await clearInput(c); }
    if (left < 0) throw new Error('输入框不存在');
    if (left > 0) throw new Error('清空输入框失败，还剩 ' + left + ' 个非空白字符');

    const typed = await typeInto(c, prompt);
    // 2026-11-13 修（关键）：开新对话后页面会整体换掉输入组件。若在切换途中写进去，
    // 文字会落在已被丢弃的旧编辑器上 —— 表现为「typeInto 校验通过、发送键却是 disabled、
    // 发出去什么都没有、轮询 45 秒 turns 恒为 0」。
    // 这里做一次硬校验：当前可见编辑器里的字数必须接近 prompt 长度，否则报错而不是白等。
    {
      const wantLen = String(prompt).replace(/\s/g, '').length;
      let gotLen = -1;
      for (let i = 0; i < 10; i++) {
        const cur = await readEditor(c).catch(() => null);
        gotLen = cur === null ? -1 : String(cur).replace(/\s/g, '').length;
        if (gotLen >= Math.min(8, wantLen)) break;
        await sleep(200);
      }
      if (gotLen < Math.min(8, wantLen)) {
        throw new Error('输入框内容没落住（可见编辑器里只有 ' + gotLen + ' 个非空白字符，期望 ≈' + wantLen +
          '）；通常是刚开新对话、页面还没换成新输入框。可重试一次。');
      }
    }
    const tailWant = String(prompt).replace(/\r/g, '').replace(/\n+/g, '\n').trim().slice(-30);
    if (!typed.includes(tailWant)) {
      throw new Error('写入内容不完整。期望结尾「' + JSON.stringify(tailWant) + '」，实际结尾「' + JSON.stringify(typed.slice(-60)) + '」');
    }

    // 基线必须在「输入框已写满、还没发送」这一刻取 —— 之前取会把残留草稿算进去

    // 2026-11-14 修（串台）：先等页面安静，再取基线，见 waitSettled 注释
    const settled = await waitSettled(c, { quietMs: 2500, maxMs: 30000 });
    if (!settled.ok) console.error('[提示] 发送前页面 ' + Math.round(settled.waitedMs / 1000) + 's 未安静，按现状取基线（可能读到半截答案）');

    const beforeText = await pageText(c);
    let baseAns = await readAnswers(c);   // 发送前的回复容器数量（判断"是否新增一条"的基准）
    // 2026-11-14 增（治串题）：记下发送前所有已知回合的指纹，收工时只认「不在这个集合里」的那条。
    let baseFps = new Set(((baseAns && baseAns.list) || []).map((x) => x.fp));
    // Trae 的会话列表只保留最近若干条；接近上限后「回合数」不再增长，
    // 此时只有「文本指纹变化」可用 —— 同问题同答案会判不出来，需要开新对话。
    if (baseAns.turns >= 8) console.error('[提示] 当前会话已有 ' + baseAns.turns + ' 条回合（接近虚拟化上限），建议在 Trae 里开一个新对话以免判据失灵');
    await sleep(250);
    const enter = await pressEnter(c);

    // 1) 确认发出去了：以 pressEnter 的返回值为准（它内部已做 4 轮退避 + 每轮 1.2s 轮询）
    let t0 = Date.now();
    let sent = enter.ok;
    if (!sent) {
      // 兜底：再等 3 秒看是否是慢清空
      for (let i = 0; i < 12; i++) {
        await sleep(250);
        const cur = await readEditor(c).catch(() => null);
        if (cur !== null && String(cur).replace(/[\s\u200b]/g, '') === '') { sent = true; break; }
      }
    }
    if (!sent) {
      // 2026-11-13 修（rank2）：实测「发不出去」是状态累积型故障 —— 一旦卡住，
      // 同一会话里会连续失败（日志里 py-retry-decorator 连挂 4 次、py-dedup 连挂 3 次，
      // 合计 10 次白丢任务）。旧逻辑直接抛错，等于把可自愈的故障当终局。
      // 现在先自愈两级再判死：① 原地清空重贴重发 ② 开新对话重置后重贴重发。
      const healed = await recoverSend(c, tailWant);
      if (healed) {
        sent = true;
        t0 = Date.now();
        baseAns = await readAnswers(c).catch(() => baseAns);
      }
    }
    if (!sent) {
      if (enter.lastLen < 0 || enter.editorFound === false) {
        throw new Error('Trae 输入框读不到（重试 ' + enter.rounds + ' 轮 + 自愈 2 级均失败；聚焦结果 ' + enter.lastFocus + '；可能是面板正在切换，稍等重试）');
      }
      throw new Error('回车没发出去（重试 ' + enter.rounds + ' 轮 + 自愈 2 级均失败；输入框还留着 ' + enter.lastLen + ' 字符；聚焦结果 ' + enter.lastFocus + '）');
    }

    // 实测：发送后有时会停在「任务列表」页（div.taskItem），此时对话区的 SEL.turn 为 0，
    // 不点进去就永远读不到答案（表现为 ESTALE）。点进去后基线清零，用「非空 + 稳定」判完成。
    {
      let inConv = await readAnswers(c);
      for (let i = 0; i < 3 && inConv.turns === 0; i++) {
        const clicked = await openTaskWith(c, tailWant).catch(() => 'ERR');
        if (clicked === 'NO_ITEM') break;
        await sleep(900);
        inConv = await readAnswers(c);
      }
      if (inConv.turns > 0 && baseAns.turns === 0) {
        baseAns = { turns: 0, text: '' };   // 进了新对话：把基线清空
        t0 = Date.now();
      }
    }

    // 2) 等它干完
    // 判据只能看「最后一条助手回合的文本变了 + 内容稳定」。
    // 两个都不能用的旧信号：
    //   · busy 变 false —— 实测先 busy ~2 秒表示收到，然后空档，内容之后才流进来；
    //   · 回合数增长 —— Trae 的会话列表是**虚拟化**的，DOM 里只保留最近约 5 条，
    //     回合数到 5 就不再涨（实测卡在 turns=5(base 5)），此时回答其实已经到了。
    const DEBUG = process.env.ORCH_DEBUG_TRAE === '1';
    const HARD_TIMEOUT = timeoutMs;
    let recovered = false;   // 本轮是否已经用过「开新对话重发」的恢复
    let lastText = '', stableSince = Date.now(), sawBusy = false, finished = false;
    // 2026-11-14 新增：结构信号判定收工时，当场把容器文本抓下来存这里。
    // 为什么必须在循环里抓：Trae 的会话列表是虚拟化的，收工后再读一次，turns 可能从 10 掉到 2
    // （会话被切走/重排），`grew` 判据（2 > 10）为假 → 最终取到的答案是空串（实测 len=0）。
    let capturedText = '';
    let source0 = '';
    while (Date.now() - t0 < HARD_TIMEOUT) {
      await sleep(700);
      const ans = await readAnswers(c);
    // 选「本次新产生」的那条回合：指纹不在 baseFps 里，且文本不像 prompt 本身
    try {
      const fresh = ((ans && ans.list) || []).slice().reverse()
        .find((x) => !baseFps.has(x.fp) && String(x.text || '').replace(/\s/g, '').length > 20);
      if (fresh) { capturedText = fresh.text; source0 = 'fresh-turn'; }
    } catch { }
      const busy = await isBusy(c);
      // 2026-11-13 修：容器里先出现的是「用户自己那条消息」，此时 ans.text 已经变了但答案还没来。
      // 若把它当完成信号，就会在 3.5 秒后 break、抽出空答案（实测 ok=false len=0 src=container）。
      // 所以要求容器文本长度必须超过 prompt 本身，才算真有回答。
      const promptLen = String(prompt).length;
      const changed = !!ans.text && ans.text !== baseAns.text && ans.text.length > promptLen + 5;
      // 盲区修复：如果两次问的是同一句话、答案也一模一样，文本指纹就不会变。
      // 这时用「回合数变多」或「确实忙过一轮 + 当前有文本」作为补充证据。
      const grew = ans.turns > baseAns.turns;
      // 第三信号（2026-11-13 新增，解决新对话判据失灵）：
      // 新建任务后 Trae 的会话区是 Virtuoso 虚拟列表，`.task-session-content .ai-chat`
      // 这一层 textContent 为空（消息在虚拟滚动容器里尚未挂载），于是 turns 恒 0、text 恒空，
      // 判据等 45 秒也等不到。这里改用整页文本增长作为证据 —— 页面文本一定包含答案。
      let pageGrew = false;
      let ptText = '';
      try {
        ptText = await pageText(c);
        pageGrew = ptText.length > beforeText.length + 20 && ptText !== beforeText;
      } catch { }
      // 注意：不拿 sawBusy 兜底 —— 那会在 Trae 没真回答时接受上一轮的旧文本（实测过）。
      const active = changed || grew || pageGrew;
      // 指纹：会话容器能读到文本就用它，读不到（Virtuoso 未挂载）就用整页文本尾部。
      const fp = (ans.text && ans.text.length) ? ans.text : ptText.slice(-3000);
      if (DEBUG) console.error(`[poll ${((Date.now() - t0) / 1000).toFixed(1)}s] busy=${busy} turns=${ans.turns}(base ${baseAns.turns}) len=${ans.text.length} changed=${changed} pageGrew=${pageGrew}`);
      if (busy) sawBusy = true;
      // 2026-11-14 新增（治三种竞态的根）：结构信号优先。
      // 只要「发送键从方块变回箭头」（= 生成结束）且文本已经出现过变化，就不必再等 settle 窗口。
      // 反过来，只要发送键还是方块，就绝不当成写完 —— 这条直接消灭「答案迟到」和「回声」：
      // 迟到是因为在上一轮还没写完时就读了旧回合；回声是因为 prompt 刚回显就被当成答案。
      const genSt = await genState(c).catch(() => 'unknown');
      if (genSt === 'generating') sawBusy = true;
      if (genSt === 'idle' && active && sawBusy) {
        // 给流式渲染留一拍，避免读到半截
        await sleep(Math.min(settleMs, 800));
        const ans2 = await readAnswers(c);
        const len2 = (ans2.text || '').length;
        if (len2 > String(prompt).length + 5) {
          if (DEBUG) console.error(`[finish] 结构信号 idle 且文本 ${len2} 字符 → 收工`);
          capturedText = ans2.text;
          finished = true;
          break;
        }
      }
      // 快速失败：45 秒内既没新回合、文本也没变 —— 说明 Trae 没接这轮
      // （典型两种：会话已满到虚拟化上限、或答案与上一轮完全相同导致指纹不变）
      if (!active && Date.now() - t0 > 45000) {
        // 自愈第一式：开新对话重发一次。会话到虚拟化上限或指纹撞车时这是唯一出路。
        if (process.env.ORCH_TRAE_NO_RECOVER !== '1' && !recovered) {
          recovered = true;
          console.error('[恢复] 45 秒无新回合，自动开新对话重发一次');
          try {
            const nc2 = await clickNewTask({ port: opts.port ?? PORT });
            if (!nc2.ok) console.error('[恢复] 开新对话失败：' + nc2.reason);
            await sleep(900);
            await focusEditor(c);
            await clearInput(c);
            const typed2 = await typeInto(c, prompt);
            if (!String(typed2).includes(tailWant)) console.error('[恢复] 重发时写入不完整，仍继续尝试');
            baseAns = await readAnswers(c);
            await sleep(250);
            await pressEnter(c);
            t0 = Date.now();
            continue;
          } catch (e3) {
            console.error('[恢复] 失败：' + e3.message);
          }
        }
        const e2 = new Error('Trae 45 秒内没有产生新回合（会话已满或答案与上一轮完全相同，自动恢复也没救回来）。建议换问法；设 ORCH_TRAE_NO_RECOVER=1 可关闭自动恢复。');
        e2.code = 'ESTALE';
        throw e2;
      }

      if (active) {
        if (fp !== lastText) {
          lastText = fp;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= settleMs) {
          finished = true;
          // 同一条道理：收工瞬间把文本留下，别指望循环结束后再读（虚拟化会让 turns 掉回去）
          capturedText = (ans && ans.text) ? ans.text : (ptText || '');
          break;
        }
      } else {
        lastText = '';
        stableSince = Date.now();
      }
    }

    // 3) 取结果：容器法优先（干净），失败才退回页面文本 diff
    const ans = await readAnswers(c);
    // 与循环里同一把尺：容器文本必须超过 prompt 长度才算「真有回答」，
    // 否则会抽出用户自己那条消息（extractReply 会把它剥掉 → 空串 → ok=false）。
    const promptLenNow = String(prompt).length;
    const changedNow = !!ans.text && ans.text !== baseAns.text && ans.text.length > promptLenNow + 5;
    const grewNow = ans.turns > baseAns.turns && !!ans.text && ans.text.length > promptLenNow + 5;
    const activeNow = changedNow || grewNow;
    let added, source;
    if (DEBUG && capturedText) {
      try { (await import('node:fs')).writeFileSync('_cap.txt', capturedText, 'utf8'); } catch { }
    }
    if (!activeNow && capturedText) {
      // 结构信号当时抓到的文本才是真答案：这里 turns 已经掉回 2（< base 10），
      // 所有「增长」判据都会判假。直接用捕获值。
      added = cleanCodeChrome(extractReply(capturedText));
      source = 'container-captured';
    } else if (activeNow) {
      added = cleanCodeChrome(extractReply(ans.text));
      source = 'container';
    } else {
      // 没新增回合：只有明确报错才算失败。注意别把常驻的会员促销横幅当额度不足——
      // 「升级会员 / 大额积分 / 立即升级 / 免费额度」是营销文案，永远都在。
      const st = await probeState(c);
      if (st.errors.length) {
        const err = new Error('Trae 报错：' + st.errors.join('、') + '（没生成新回合）');
        err.code = 'EAGENTFAIL';
        err.partial = { ok: false, addedText: '', outputChars: 0, elapsedMs: Date.now() - t0, sawBusy };
        throw err;
      }
      const afterText = await pageText(c);
      // 2026-11-13 修（评测实测暴露两种抢跑）：① 拿到的其实是 prompt 自己（回声）
      // ② 拿到上一题的答案（答案迟到，diff 从上一轮末尾开始）。两者都会让判据误判。
      // 统一修法：只在「本题 prompt 之后」的内容里取答案——定位 prompt 首句，从它后面切。
      const rawAdded = afterText.slice(commonPrefixLen(beforeText, afterText)).trim();
      added = cleanCodeChrome(extractReply(rawAdded));
      source = 'text-diff';
    }

    // 2026-11-13 修（评测实测暴露）：判据会「抢跑」——用户那条消息先出现，diff 拿到的
    // 其实是 prompt 自己，于是 rows 里出现「FAIL 但 text 是题目原文」；偶尔还会拿到上一题的答案。
    // 这里加一道终检：如果抽出来的内容基本就是 prompt 本身（或短得不像答案），继续等答案。
    {
      const pNorm = String(prompt).replace(/\s+/g, '');
      const looksEcho = (s) => {
        const t = String(s || '').replace(/\s+/g, '');
        if (!t) return true;
        if (t.length < 20) return true;
        return pNorm.startsWith(t.slice(0, 30)) || t === pNorm;
      };
      for (let i = 0; i < 28 && looksEcho(added); i++) {
        await sleep(700);
        const a2 = await readAnswers(c);
        const cand = cleanCodeChrome(extractReply(a2.text || ''));
        if (!looksEcho(cand)) { added = cand; source = 'container-late'; break; }
        const aft = await pageText(c);
        const raw2 = aft.slice(commonPrefixLen(beforeText, aft)).trim();
        const cand2 = cleanCodeChrome(extractReply(raw2));
        if (!looksEcho(cand2)) { added = cand2; source = 'text-diff-late'; break; }
        added = cand2.length > added.length ? cand2 : added;
      }
    }
    const result = {
      ok: finished && added.length > 0,
      timedOut: !finished,
      addedText: added,
      source,
      outputChars: added.length,
      elapsedMs: Date.now() - t0,
      sawBusy,
    };
    if (!finished) {
      const err = new Error('等待超时（' + Math.round(timeoutMs / 1000) + 's），以下是已拿到的部分');
      err.partial = result;
      throw err;
    }
    return result;
  } finally {
    try { await c.close(); } catch { /* 关连接失败不影响结果 */ }
  }
}

// ---- 选择器集中：界面一改只动这一处 ----
// 每个键给一组候选，按顺序试，第一个命中的算数（降级链）。
// 为什么要降级链：Trae 改版时类名会变，但结构不会一次全变；
// 给出多个候选比单点硬编码多活几轮，且 probe 能提前报警。
export const SEL = {
  // 助手回合容器
  // 2026-11-13 实测：Trae 更新后对话区变成 solo-lite-chat-panel + message-list-cache-item，
  // 旧的 turn__agent-message 已不存在；两个都留着，按顺序降级。
  // 2026-11-14 实测（决定性）：message-list-cache-item 是**会话级外壳**（一个 cache-item 就是一整段对话，
  // 实测 textContent 达 28,499 字符、含 50 个 <pre>），拿它当「一条回合」必然取到上一条/半截 → 这就是串题的根因。
  // 真正的单条消息容器是 div.turn（子节点含 turn__user-message 与 div.markdown-renderer）。
  turn: ['div.turn', 'div.message-list-cache-item', 'div.turn__agent-message', '[class*="turn__agent-message"]', '[data-testid*="agent-message"]'],
  // 回合内的 markdown 渲染容器（答案取最后一个）
  renderer: ['div.markdown-renderer', '[class*="markdown-renderer"]', '[class*="markdown-body"]'],
  // 输入框（可编辑区）
  // 首选类名：实测 Trae 某些时刻 contenteditable 属性选择器命中 0，类名更稳
  edit: ['div.chat-input-v2-input-box-editable', 'div[contenteditable="true"]', '[contenteditable="true"]', 'textarea'],
  // 界面噪音行（stripUiChrome 用，整行匹配）
  chrome: ['@ 添加上下文', '完全访问', '正常模式', '深度思考', '发送', '停止', '复制'],
};

/** 生成"在 root 下按降级链找第一个节点"的浏览器端表达式 */
export function selExpr(key, rootVar = 'document') {
  const list = SEL[key] || [];
  return `(${rootVar}.querySelector(${JSON.stringify(list.join(','))}) )`;
}

// ---- 精确取回复：读"最后一条助手回合"里的最后一个 markdown 容器 ----
// 实测结构（2026-11-13 探针）：div.turn__agent-message > div.agent-message-plan-flow > div.markdown-renderer > p
// 注意：答案的渲染容器**也在** plan-flow 里面，所以不能排除 plan-flow，
// 只能按"回合数增长 + 取回合内最后一个 renderer"来定位（思考过程是前一个）。
// 2026-11-13 实测（Trae 3.4.18）：代码块的 textContent 保留完整缩进（4/8 空格），
// 而 innerText 会被 CSS white-space 折叠成 1 空格 —— 直接读 innerText 会把所有 Python 代码废掉。
// 所以这里自写序列化：块级元素补换行，PRE/CODE 一律取 textContent，绕开 CSS。
const ANSWER_JS = `(() => {
  const TURN = ${JSON.stringify(SEL.turn.join(','))};
  const REND = ${JSON.stringify(SEL.renderer.join(','))};
  const BLOCK = /^(DIV|P|LI|UL|OL|TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|BLOCKQUOTE|H[1-6]|DT|DD|FIGURE)$/;
  function ser(root) {
    let out = '';
    (function walk(n) {
      if (!n) return;
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'PRE' || tag === 'CODE') { out += '\\n' + (n.textContent || '') + '\\n'; return; }
      if (tag === 'BR') { out += '\\n'; return; }
      const block = BLOCK.test(tag);
      if (block) out += '\\n';
      for (const ch of n.childNodes) walk(ch);
      if (block) out += '\\n';
    })(root);
    return out.replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]+$/gm, '');
  }
  const turns = document.querySelectorAll(TURN);
  const last = turns[turns.length - 1];
  let text = '';
  if (last) {
    const rs = last.querySelectorAll(REND);
    const r = rs[rs.length - 1];
    if (r) text = ser(r).trim();
  }
  // 2026-11-14 补（治串题）：把最近 4 条回合各自的「指纹 + 文本」一起返回。
  // 指纹 = 该回合 renderer 文本的头 40 + 尾 40 + 长度，用它判断「哪一条是本次新产生的」，
  // 而不是「最后一条是谁」——虚拟化列表里最后一条常常还是上一题的答案。
  const list = [];
  for (let i = Math.max(0, turns.length - 4); i < turns.length; i++) {
    const t = turns[i];
    const rs = t ? t.querySelectorAll(REND) : [];
    const r = rs && rs.length ? rs[rs.length - 1] : null;
    const tx = r ? ser(r).trim() : '';
    const head = tx.slice(0, 40), tail = tx.slice(-40);
    list.push({ i, fp: head + '|' + tail + '|' + tx.length, text: tx });
  }
  return { turns: turns.length, text: text, list };
})()`;

// 额度/异常探针：Trae 免费积分用尽时会挂「升级会员立即获得大额积分」横幅，请求静默失败
const QUOTA_JS = `(() => {
  const t = document.body.innerText || '';
  // 只认「明确说不够」的措辞。营销横幅（升级会员 / 大额积分 / 立即升级 / 免费额度）
  // 是常驻广告，永远都在，拿它当额度信号会 100% 假阳性（2026-11-13 踩过）。
  const marks = ['积分不足', '额度不足', '余额不足', '超出限制', '今日已达上限'];
  const hit = marks.filter(function (m) { return t.indexOf(m) >= 0; });
  const errs = ['请求失败', '网络异常', '服务繁忙', '请稍后重试', 'rate limit', 'quota exceeded'];
  const hitErr = errs.filter(function (m) { return t.indexOf(m) >= 0; });
  return { quota: hit, errors: hitErr };
})()`;

async function probeState(c) {
  try { return (await c.js(QUOTA_JS)) || { quota: [], errors: [] }; }
  catch { return { quota: [], errors: [] }; }
}

async function readAnswers(c) {
  try { return (await c.js(ANSWER_JS)) || { turns: 0, text: '' }; }
  catch { return { turns: 0, text: '' }; }
}

/** 抓到的文本是不是「写到一半」。
 *  2026-11-14 实测：Trae 流式渲染会短暂进 idle，半截答案被当成完整收工
 *  （py-csv-dict 在 encoding=' 处被截断 → SyntaxError: unterminated string literal）。
 *  保守启发：宁可多等一轮，也不收半截。 */
function looksTruncated(t) {
  const s = String(t || '').trimEnd();
  if (!s) return true;
  const last = s.split('\n').pop().trim();
  if (!last) return false;
  if (/^```/.test(last)) return false;                  // 收尾围栏在，算写完
  const sq = (last.match(/'/g) || []).length;
  const dq = (last.match(/"/g) || []).length;
  if (sq % 2 === 1 || dq % 2 === 1) return true;        // 引号没闭合
  if (/[=,([{\\+*/%<>|&]$/.test(last)) return true;     // 行尾悬着运算符或开括号
  return false;
}

/** 只读：拿当前页面的渲染文本（含滚动外内容） */
// 体检用快照：只做廉价 DOM 计数，不写不点，用于 preflight 判断「界面结构还在不在」
const SNAP_JS = `(() => {
  const cnt = (list) => { for (const s of list) { try { const n = document.querySelectorAll(s).length; if (n > 0) return n; } catch {} } return 0; };
  const body = document.body ? (document.body.innerText || '') : '';
  return JSON.stringify({
    turns: cnt(${JSON.stringify(SEL.turn)}),
    renderer: cnt(${JSON.stringify(SEL.renderer)}),
    edit: cnt(${JSON.stringify(SEL.edit)}),
    len: body.length,
  });
})()`;

export async function snapshotTrae(opts = {}) {
  const c = await attach(opts.port ?? PORT, 'Agent');
  try {
    const raw = await c.js(SNAP_JS);
    const s = JSON.parse(raw || '{}');
    return { agentTurns: s.turns || 0, renderer: s.renderer || 0, editable: s.edit || 0, textLen: s.len || 0 };
  } finally {
    try { c.close(); } catch { }
  }
}

// 开新对话：点 Trae 的「新建任务」按钮，把会话清空。
// 为什么需要它：Trae 的会话列表是虚拟化的，DOM 只保留最近约 5-11 条，
// 到上限后「回合数」不再增长，只能靠文本指纹判断；而连续两次问同一句话、
// 答案又完全一样时指纹也不变 —— 那种情况判不出来。开新对话让回合数归零，
// 判据就重新变得可靠（实测：点击后 agentTurns/userTurns 都归 0）。
export async function clickNewTask(opts = {}) {
  const c = await attach(opts.port ?? PORT, 'Agent');
  try {
    // 2026-11-13 修：① 改成 CDP 真实鼠标点击（React 组件不认 JS .click()）
    //               ② 目标改成侧栏条目 `div.task-list-new-task-item`（3.4.18 实测坐标 12,56 276×34）
    //               ③ 清空判据改用 SEL.turn（旧类 turn__agent-message 已不存在）
    const TURN_SEL = Array.isArray(SEL.turn) ? SEL.turn.join(',') : SEL.turn;
    const box = await c.js(`(() => {
      const cands = [...document.querySelectorAll('div.task-list-new-task-item, button[aria-label="新建任务"]')];
      const b = cands.find(x => {
        const r = x.getBoundingClientRect();
        return r.width > 60 && r.height > 20;
      });
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
        cls: String(b.className || '').slice(0, 40), text: (b.innerText || '').trim().slice(0, 10) });
    })()`);
    if (!box) return { ok: false, reason: '找不到「新建任务」按钮（宽高 >60×20 的可见元素）' };
    const { x, y } = JSON.parse(box);
    await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    // 等它真的清空：turns 归 0 或元素整体消失
    let lastTurns = -1;
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      lastTurns = await c.js(`document.querySelectorAll(${JSON.stringify(TURN_SEL)}).length`);
      if (lastTurns === 0) return { ok: true, at: { x, y } };
    }
    return { ok: false, reason: '点了但会话没清空（turns=' + lastTurns + '）', at: { x, y } };
  } finally {
    try { c.close(); } catch { }
  }
}

export async function peekTrae(opts = {}) {
  const c = await attach(opts.port ?? PORT, 'Agent');
  try {
    return await pageText(c);
  } finally {
    try { await c.close(); } catch { }
  }
}

/**
 * Trae 文件信箱（2026-11-14 加）：产物走文件系统，绕开 markdown 渲染器。
 *
 * 为什么需要它：Trae 的回答区是渲染后的 DOM，`x` 会变成 <code>、## 会变成 <h2>、
 * **b** 会变成 <strong>，innerText 取回来只剩文字，语法字符全丢。
 * 之前 extractCode 里那些"字符还原"补丁都是在猜，永远追不上语法。
 * 实测直接让 Trae 写文件，反引号 / ## / ** / JSDoc 边界一个字符都不少，而且 9.9 秒完成。
 *
 * 协议与 agents/doubao.mjs 一致：写 task → 只发一句含两个绝对路径的短指令 → 轮询 result。
 */
export async function askTraeFile(taskPrompt, opts = {}) {
  if (!taskPrompt || !String(taskPrompt).trim()) throw new Error('taskPrompt 为空');
  // 2026-11-14 用户换区：trae 的工作区统一到这里。
  // opts.shared=true 时改用三通道共享区（跨通道协作/特殊需求时用）。
  const ws = opts.workspace ||
    (opts.shared ? SHARED_WS : null) ||
    process.env.TRAE_WORKSPACE ||
    'D:\\ai work replace\\trae place\\work test one';
  const box = path.join(ws, '.mailbox');
  fs.mkdirSync(box, { recursive: true });
  const id = 'tr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
  const r = await askTrae(ins, opts);

  // askTrae 返回不等于文件已落盘：轮询到非空为止
  const budget = opts.fileWaitMs ?? 60000;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    try {
      const s = fs.readFileSync(resultPath, 'utf8');
      if (s && s.trim()) {
        return { ok: true, text: s, file: resultPath, elapsedMs: Date.now() - t0 };
      }
    } catch { /* 还没写 */ }
    await sleep(1500);
  }
  return {
    ok: false, text: '', file: null, elapsedMs: Date.now() - t0,
    reason: '结果文件 ' + budget + 'ms 内没有出现（任务可能没执行完，或 Trae 没权限写该目录）',
    reply: (r && (r.text || r.answer || '')) || '',
  };
}

export const meta = {
  name: 'trae',
  kind: 'gui-agent',
  transport: 'cdp',
  port: PORT,
  strengths: ['前端/全栈实现', '多文件改造', 'IDE 内联运行', '交叉评审'],
  // 实测（2026-11-13）：不要求围栏时，Trae 把整段代码渲染成一个 <p>，缩进在 DOM 里就没了；
  // 要求 ```python 围栏后走 <pre>，缩进完整保留，但会混进行号 gutter 与语言标签（cleanCodeChrome 已清）。
  codeHint: '要它出代码时，prompt 里必须写「用 markdown 代码块（```python）输出」，否则缩进会丢；拿到结果后用 extractCode() 取块。',
  costModel: '积分（Trae 账号内扣减，本地只能读到界面显示）',
};