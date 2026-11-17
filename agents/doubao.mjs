// 豆包客户端适配层：CDP 发指令 + 文件信箱收产物。
//
// 为什么这条通道和 trae / codebuddy / workbuddy 本质不同：
//   那三条靠 innerText 从聊天气泡里抓回答，而聊天气泡是 markdown 渲染后的结果，
//   反引号、井号、双星号这些语法字符在渲染时就被吃掉了（实测：workbuddy 生成的
//   lib/probe_clamp.mjs 第 45 行反引号全丢、docs/probe-guide.md 反引号数 0、## 数 0）。
//   豆包客户端有本地 shell 执行能力（实测它能跑 Get-Location / Test-Path / Set-Content），
//   所以产物可以走文件系统回传 —— 文件不经过任何渲染器，字节原样。
//
// 协议：
//   1) 把 prompt 写成 .mailbox/<id>.task.md
//   2) 通过 CDP 在输入框发一句极短的指令，只包含两个绝对路径
//   3) 轮询 .mailbox/<id>.result.md 出现
//   4) 读文件，字节原样返回
//
// 环境变量：
//   DB_PORT        调试端口，默认 9225（启动时必须带 --remote-debugging-port=9225）
//   DB_WORKSPACE   文件信箱根目录，默认 D:\\ai work replace\\doubao place\\work test one
//                  （2026-11-14 用户换区：原先的 D:\\code app\\ai code\\doubao\\workplace\\work one 已删除）
//   DB_TIMEOUT_MS  单次任务超时，默认 300000（豆包一次任务实测 7-60 秒，留足余量）
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { withLockPool } from '../lib/lock.mjs';
import { check, record } from '../lib/budget.mjs';
import { appendLog } from '../lib/memory.mjs';
import { CDP, attachUrl } from '../lib/cdp.mjs';

const NAME = 'doubao';
const PORT = Number(process.env.DB_PORT || 9225);
const WORKSPACE = process.env.DB_WORKSPACE || 'D:\\ai work replace\\doubao place\\work test one';
// 三通道共享工作区：opts.shared=true 走这里，用于跨通道协作/特殊需求
const SHARED_WS = process.env.ORCH_SHARED_WS || 'D:\\ai work replace\\TDW place';
const BOX = join(WORKSPACE, '.mailbox');
const TIMEOUT_MS = Number(process.env.DB_TIMEOUT_MS || 300000);

// ---- 自愈：调试端口消失就带参数重启客户端 ----
//
// 为什么必须有这一段（2026-11-15 实测）：
//   豆包客户端会自己重启（自动更新 / 崩溃 / 用户手动关），重启后不再带
//   --remote-debugging-port，端口静默消失。此时 attachPage 只会抛
//   「9225 上找不到 doubao-chat 页面」，而 runPool 那头把这个错误记成
//   「通道超时」。于是一整轮任务全被判失败，看起来像模型不会干活，
//   实际是客户端根本没在调试模式。当晚 trae 240s / doubao 260s /
//   workbuddy 1094.9s 的超时全是这个原因，重启三条通道后三条全活。
//   所以：判据取端口，不取通道的自我报告；修法是自动重启，不是重试。
const EXE = process.env.DB_EXE || 'D:\\code app\\ai code\\doubao\\app\\Doubao.exe';

async function portAlive(ms = 900) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/version', {
      headers: { Host: 'localhost:' + PORT }, signal: ac.signal,
    });
    clearTimeout(timer);
    return r.ok;
  } catch { return false; }
}

// 页面登记了 != 渲染完了。实测：端口一起来 /json/list 里立刻就有
// doubao-chat，但 DOM 里还没有 div.tiptap.ProseMirror，此时去 sendPrompt
// 会报「找不到豆包输入框，界面结构可能变了」—— 一句 3 秒的假警报。
// 所以判据要落到输入框本身。
async function chatPageReady(ms = 1200) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list', {
      headers: { Host: 'localhost:' + PORT }, signal: ac.signal,
    })).json();
    clearTimeout(timer);
    const t = (Array.isArray(list) ? list : [])
      .find(x => x.type === 'page' && /doubao-chat/.test(x.url || ''));
    if (!t || !t.webSocketDebuggerUrl) return false;
    const c = await new CDP(t.webSocketDebuggerUrl).connect();
    try {
      return String(await c.js("!!document.querySelector('div.tiptap.ProseMirror')")) === 'true';
    } finally { try { c.close(); } catch { } }
  } catch { return false; }
}

/**
 * 确保豆包客户端在调试端口上就绪；不在就带 --remote-debugging-port 重启。
 * @param {object} opts { waitMs, onLog, force }
 * @returns {Promise<{ok:boolean, restarted:boolean, why:string}>}
 */
export async function ensureDoubao(opts = {}) {
  const force = !!opts.force;
  if (!force && await portAlive(600)) {
    return { ok: true, restarted: false, why: '端口已在' };
  }
  if (process.env.ORCH_DB_RESTART === '0' && !force) {
    throw new Error('豆包调试端口 ' + PORT + ' 没监听，且 ORCH_DB_RESTART=0 禁止自动重启');
  }
  if (!existsSync(EXE)) {
    throw new Error('豆包调试端口 ' + PORT + ' 没监听，且找不到客户端：' + EXE);
  }
  const say = typeof opts.onLog === 'function' ? opts.onLog : () => { };
  say('[doubao] 端口 ' + PORT + ' 没监听，带调试参数重启客户端…');
  try { execSync('taskkill /IM "Doubao.exe" /F', { stdio: 'ignore' }); } catch { }
  await new Promise(r => setTimeout(r, 1500));
  // detached 必须开：工具调用启的常驻进程会在调用收尾时被回收（mihomo 踩过三次）
  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], {
    detached: true, stdio: 'ignore', windowsHide: false,
  });
  child.unref();

  const waitMs = Number(opts.waitMs || 60000);
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    await new Promise(r => setTimeout(r, 1000));
    if (!(await portAlive(700))) continue;
    if (await chatPageReady(700)) {
      const sec = Math.round((Date.now() - started) / 100) / 10;
      say('[doubao] 已重启并就绪（' + sec + 's）');
      return { ok: true, restarted: true, why: '已重启并就绪（' + sec + 's）' };
    }
  }
  throw new Error('已尝试重启豆包，' + Math.round(waitMs / 1000) + 's 内端口 ' + PORT + ' 仍未就绪');
}

async function attachPage() {
  // 端口没了就先重启，别把「客户端没开调试」报成「模型超时」
  await ensureDoubao();
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list', {
    headers: { Host: 'localhost:' + PORT },
  })).json();
  const t = list.find(x => x.type === 'page' && /doubao-chat/.test(x.url));
  if (!t) throw new Error('豆包客户端未就绪：' + PORT + ' 上找不到 doubao-chat 页面。' +
    '启动方式：Doubao.exe --remote-debugging-port=' + PORT);
  return new CDP(t.webSocketDebuggerUrl).connect();
}

/** 在输入框里打字并回车 */
async function sendPrompt(c, text) {
  // 页面刚起来时输入框可能迟到几秒，等它出现再打（最多 12s）
  for (let i = 0; i < 24; i++) {
    const ok = String(await c.js("!!document.querySelector('div.tiptap.ProseMirror')")) === 'true';
    if (ok) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const box = JSON.parse(await c.js(`(() => {
    const ed = document.querySelector('div.tiptap.ProseMirror');
    if (!ed) return 'null';
    ed.focus();
    const b = ed.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) });
  })()`) || 'null');
  if (!box) throw new Error('找不到豆包输入框（tiptap ProseMirror），界面结构可能变了');
  await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 250));
  await c.call('Input.insertText', { text });
  await new Promise(r => setTimeout(r, 600));
  const got = String(await c.js(`(document.querySelector('div.tiptap.ProseMirror')||{}).innerText || ''`));
  if (got.replace(/\s/g, '').length < Math.min(6, text.replace(/\s/g, '').length)) {
    throw new Error('输入没落住（编辑器里只有 ' + got.length + ' 字符）');
  }

  // ---- 发送：这里曾经整条通道假死 ----
  // 原实现只有 keyDown + keyUp 两发，丢了两件事：
  //   ① Page.bringToFront —— 窗口不在前台时 tiptap 的 Enter 不触发提交，
  //      指令留在输入框里，调用方等 result.md 等到超时，报「通道超时」。
  //      症状极易误判：页面一切正常，只有输入框里的字一直没发出去。
  //   ② char 事件 —— Chromium 的 rawKeyDown 不带 text 时，回车在 contenteditable
  //      里只走 keydown 路径，部分编辑器因此不提交。
  // 现在补上 bringToFront + rawKeyDown/char/keyUp 三连，并在发完后校验输入框已清空，
  // 没清空就点发送按钮兜底。判据取「框里空了没」，不取按键有没有派发成功。
  try { await c.call('Page.bringToFront', {}); } catch { }
  await new Promise(r => setTimeout(r, 200));
  const pressEnter = async () => {
    for (const type of ['rawKeyDown', 'char', 'keyUp']) {
      await c.call('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        text: type === 'char' ? '\r' : undefined,
      });
    }
  };
  const boxEmpty = async () =>
    String(await c.js(`((document.querySelector('div.tiptap.ProseMirror')||{}).innerText || '').trim()`)).length === 0;

  await pressEnter();
  await new Promise(r => setTimeout(r, 1200));
  if (!(await boxEmpty())) {
    // 兜底：找右下角发送按钮点一下
    const btn = JSON.parse(await c.js(`(() => {
      const cands = [...document.querySelectorAll('button, div[role="button"]')];
      for (const el of cands) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) continue;
        const txt = (el.innerText || '').trim();
        const al = (el.getAttribute('aria-label') || '').trim();
        const looksSend = /发送|send/i.test(txt + al) ||
          (r.y > window.innerHeight * 0.65 && r.x > window.innerWidth * 0.55 && !txt);
        if (looksSend) return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
      }
      return 'null';
    })()`) || 'null');
    if (btn) {
      await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  // 别拿「输入框清空」当唯一证据。实测：tiptap 清空不是同步的，
  // 消息已经发出、豆包已经开始答了，输入框可能还留着原文一两秒；
  // 反过来也有「字被吃进富文本只剩换行」的假阴性。真正的判据是
  // result.md 出现（askDoubao 已经在那等了），这里只判「指令有没有落地」：
  // 页面上能看到这条指令的开头 = 发出去了。
  if (!(await boxEmpty())) {
    const head = text.replace(/\s+/g, ' ').slice(0, 40);
    let landed = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await boxEmpty()) { landed = true; break; }
      const pageText = String(await c.js('document.body ? document.body.innerText : ""'));
      if (head && pageText.includes(head)) { landed = true; break; }
    }
    if (!landed) {
      // 不抛错：让等待 result.md 的那一端去判死，它有时间预算，
      // 这里的误判会把「其实成功」报成「发送失败」（m07157 实测过）。
      console.warn('[doubao] 发送后输入框未清空且页面未见指令，可能窗口被遮挡，继续等结果文件');
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 走文件信箱问豆包一次。产物字节原样，不经过任何 markdown 渲染。
 * @param {string} prompt 任务正文，会原样落成 task.md
 * @param {object} opts { ext, timeoutMs, id }
 * @returns {{answer:string, code:string, notes:string[], confidence:string,
 *            raw:string, ms:number, inputTokens:number, outputTokens:number, file:string}}
 */
export async function askDoubao(prompt, opts = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt 为空');

  // opts.shared=true 走三通道共享区；opts.workspace 可显式指定
  const wsRoot = opts.workspace || (opts.shared ? SHARED_WS : null) || WORKSPACE;
  const box = opts.workspace || opts.shared ? join(wsRoot, '.mailbox') : BOX;

  return withLockPool(NAME, Number(opts.slots || 1), async () => {
    check(NAME, Math.ceil(text.length / 2));
    mkdirSync(box, { recursive: true });

    const id = opts.id || ('t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const taskPath = join(box, id + '.task.md');
    const resultPath = join(box, id + '.result.md');
    const timeoutMs = Number(opts.timeoutMs || TIMEOUT_MS);

    // task.md 里包一层收尾约定，让豆包知道产物写哪
    const wrapped = text + '\n\n---\n' +
      '完成上面的任务后，把最终产物原样写入下面这个文件的完整内容里（不要摘要、不要省略、不要加解释）：\n' +
      resultPath + '\n' +
      '写完后只回复两个字：完成';
    writeFileSync(taskPath, wrapped, 'utf8');
    if (existsSync(resultPath)) rmSync(resultPath, { force: true });

    const t0 = Date.now();
    let c = null;
    try {
      c = await attachPage();
      const instruct = '读取 ' + taskPath + ' 里的任务并执行，产物写入 ' + resultPath + '。只回复「完成」两个字。';
      await sendPrompt(c, instruct);

      // 轮询结果文件
      let waited = 0;
      const step = 1500;
      while (waited < timeoutMs) {
        await sleep(step);
        waited += step;
        if (existsSync(resultPath)) {
          // 再等一拍，防止文件还在写
          await sleep(600);
          const content = readFileSync(resultPath, 'utf8');
          if (content.trim()) {
            const ms = Date.now() - t0;
            record(NAME, { input: Math.ceil(text.length / 2), output: Math.ceil(content.length / 2), ok: true });
            // 字段名必须和 orchestra.mjs stats 读取的口径一致（第 661-662 行读 elapsedMs / outputChars）。
            // 2026-11-15 rank2：原来写 ms / resultChars，stats 读不到，doubao 在流水里显示「均 0.0s / 0 字符」——
            // 5 次调用全被记成 0，看板上等于这条通道不存在。旧字段保留一份，方便回看历史流水。
            appendLog({ agent: NAME, elapsedMs: ms, outputChars: content.length, ok: true, mode: 'file', taskChars: text.length, resultChars: content.length, ms, id });
            const code = opts.ext && /\.(mjs|js|cjs|ts|py|sh|ps1)$/.test(opts.ext) ? content : '';
            return {
              // orchestra.mjs 的 dispatch 只认 addedText（第 508 行 `r.addedText`）。
              // 原来只返回 answer/code/raw，上层统计拿不到正文，字符数一律记 0。
              addedText: content,
              answer: code ? '' : content.trim(),
              code,
              notes: [],
              confidence: '',
              raw: content,
              ms,
              inputTokens: 0,
              outputTokens: 0,
              file: resultPath,
            };
          }
        }
      }
      throw new Error('等结果文件超时 ' + Math.round(timeoutMs / 1000) + 's（' + resultPath + '）');
    } catch (err) {
      const ms = Date.now() - t0;
      appendLog({ agent: NAME, elapsedMs: ms, outputChars: 0, ok: false, mode: 'file', err: String(err && err.message || err).slice(0, 200), ms, id });
      throw err;
    } finally {
      if (c) try { c.close(); } catch {}
    }
  });
}

/** doctor 用：能不能连上客户端 */
export async function doubaoDoctor() {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list', {
      headers: { Host: 'localhost:' + PORT },
    })).json();
    const t = list.find(x => x.type === 'page' && /doubao-chat/.test(x.url));
    if (!t) return { ok: false, detail: PORT + ' 可连但没有 doubao-chat 页面' };
    return { ok: true, detail: PORT + ' 已连 · 工作区 ' + WORKSPACE };
  } catch (err) {
    return { ok: false, detail: '连不上 ' + PORT + '：' + String(err.message || err).slice(0, 120) +
      '（需带 --remote-debugging-port=' + PORT + ' 启动）' };
  }
}

export const doubaoMeta = {
  name: NAME,
  label: '豆包（客户端 + 文件信箱）',
  kind: 'cdp-file',
  // transport / strengths 这两项是 `orchestra.mjs list` 的硬依赖，缺一个就 TypeError。
  // doubao 是后加的通道，第一版只写了 kind/port，结果 list 在前三个 agent 打印完之后
  // 直接崩在 `.strengths.join` 上（2026-11-15 实测）。补全。
  transport: 'cdp',
  port: PORT,
  strengths: ['文件信箱交付（反引号/双星号/井号零损伤）', '长任务不易串台', '走豆包客户端额度'],
  costModel: '豆包客户端额度',
  workspace: WORKSPACE,
};

// ── 换模型（2026-11-16 实测打通）────────────────────────────────────────────
// 用户原话：「doubao在自动那里」。对 —— 输入框右下角那个「自动」，点开是 11 项：
//   自动 / 豆包 2.1 Lite(0.01x 限时) / 豆包 2.1 Pro(0.65x) / DeepSeek V4.1 Flash(0.01x 限时) /
//   Kimi K3.1 Pro(0.95x) / Kimi K3.1 Pro 高速(1.44x) / Kimi K3(1.48x) / GLM 5.3(0.80x) /
//   GLM 5.3 Flash(0.08x) / DeepSeek V4 Pro(0.46x) / 推理强度：高
//
// 我此前写「客户端没有模型入口」是错的 —— 我把「找不到模型名」当成了「没有入口」，
// 其实入口显示的是当前选中值（「自动」），模型名要点开才看得见。
//
// 两个硬条件（缺一个就点不开，且不会有任何报错）：
//   1. 必须先 Page.bringToFront —— 窗口不在前台时 React 的 popover 根本不渲染，
//      查询菜单会得到 0 项，看起来完全像「这个按钮不能点」。
//   2. 点击要发 pointerdown/mousedown/pointerup/mouseup/click 一整套 —— 只发 click
//      在 Radix 这类组件上常常不触发（它们听 pointerdown）。

const DB_MODELS = [
  { name: '自动', cost: '小额免费' },
  { name: '豆包 2.1 Lite', cost: '0.01x' },
  { name: '豆包 2.1 Pro', cost: '0.65x' },
  { name: 'DeepSeek V4.1 Flash', cost: '0.01x' },
  { name: 'Kimi K3.1 Pro', cost: '0.95x' },
  { name: 'Kimi K3.1 Pro 高速', cost: '1.44x' },
  { name: 'Kimi K3', cost: '1.48x' },
  { name: 'GLM 5.3', cost: '0.80x' },
  { name: 'GLM 5.3 Flash', cost: '0.08x' },
  { name: 'DeepSeek V4 Pro', cost: '0.46x' },
];

const DB_OPEN = `(() => {
  // 触发区是输入框右下角那个 <button>：文本形如「自动高」「GLM 5.3 Flash高」——
  // 模型名 + 推理强度（「高」）挤在同一个 button 里，所以模型名本身不是独立叶子。
  // 我一开始按「找文本叶子」去定位，永远找不到（叶子只有那个「高」字），
  // 最后靠 dump 右侧区域才看清它是 button。定位按语义（button + 位置 + 文本模式）最稳。
  const btn = [...document.querySelectorAll('button')].filter((b) => {
    const t = (b.textContent || '').trim().replace(/\\s+/g, '');
    if (!t || t.length > 30) return false;
    if (!/^(自动|豆包|DeepSeek|Kimi|GLM)/.test(t)) return false;
    const r = b.getBoundingClientRect();
    return r.width >= 40 && r.height >= 16 && r.x > 600 && r.y > 500;
  });
  if (!btn.length) return { ok: false, why: '找不到模型触发按钮' };
  const el = btn[0];
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) { try { el.dispatchEvent(new MouseEvent(t, o)); } catch {} }
  return { ok: true, from: (el.textContent || '').trim().replace(/\\s+/g, ' ') };
})()`;

const DB_LIST = `(() => {
  const kws = ['自动', '豆包', 'DeepSeek', 'Kimi', 'GLM'];
  const out = [];
  document.querySelectorAll('*').forEach((el) => {
    if (el.children.length) return;
    const t = (el.textContent || '').trim();
    if (!t || t.length > 40) return;
    if (!kws.some((k) => t.includes(k))) return;
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 6 || r.y < 200) return;
    out.push(t);
  });
  return out;
})()`;

const DB_PICK = (name) => `(() => {
  const want = ${JSON.stringify(name)};
  const hits = [...document.querySelectorAll('*')].filter((el) => {
    if (el.children.length) return false;
    if ((el.textContent || '').trim() !== want) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 10 && r.height >= 6 && r.y > 200;
  });
  if (!hits.length) return { ok: false, why: '菜单里没有「' + want + '」' };
  const el = hits[0];
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) { try { el.dispatchEvent(new MouseEvent(t, o)); } catch {} }
  if (el.parentElement) for (const t of ['pointerdown', 'mouseup', 'click']) { try { el.parentElement.dispatchEvent(new MouseEvent(t, o)); } catch {} }
  return { ok: true };
})()`;

const DB_CUR = `(() => {
  const btn = [...document.querySelectorAll('button')].filter((b) => {
    const t = (b.textContent || '').trim().replace(/\\s+/g, '');
    if (!t || t.length > 30) return false;
    if (!/^(自动|豆包|DeepSeek|Kimi|GLM)/.test(t)) return false;
    const r = b.getBoundingClientRect();
    return r.width >= 40 && r.x > 600 && r.y > 500;
  });
  return btn.length ? btn[0].textContent.trim().replace(/\\s+/g, ' ') : null;
})()`;

/** 读出豆包可选的模型清单（点开菜单抓，抓完按 Escape 关掉）。永不抛异常。 */
export async function listModels() {
  let c;
  try {
    c = await attachUrl(PORT, 'doubao');
  } catch (e) {
    return { ok: false, models: [], reason: '连不上豆包：' + String((e && e.message) || e).slice(0, 80) };
  }
  try {
    try { await c.call('Page.bringToFront'); } catch {}
    await new Promise((r) => setTimeout(r, 400));
    const o = await c.js(DB_OPEN);
    if (!o || !o.ok) return { ok: false, models: [], reason: (o && o.why) || '点不开' };
    await new Promise((r) => setTimeout(r, 400));
    const list = await c.js(DB_LIST);
    try { await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); } catch {}
    const models = (list || []).filter((x) => x !== '自动' && !x.includes('推理强度')).concat(['自动']);
    return { ok: true, models, table: DB_MODELS, current: o.from };
  } catch (e) {
    return { ok: false, models: [], reason: String((e && e.message) || e).slice(0, 120) };
  } finally {
    try { c.close(); } catch {}
  }
}

/**
 * 换豆包的模型。永不抛异常 —— 换模型是优化，不是前置条件。
 * 返回 { ok, from, to, reason? }
 */
export async function setModel(name) {
  const want = String(name == null ? '' : name).trim();
  if (!want) return { ok: false, from: null, to: null, reason: '没给模型名' };
  let c;
  try {
    c = await attachUrl(PORT, 'doubao');
  } catch (e) {
    return { ok: false, from: null, to: null, reason: '连不上豆包：' + String((e && e.message) || e).slice(0, 80) };
  }
  try {
    // 这个 bringToFront 不是礼貌，是必需：窗口在后台时 popover 不渲染，菜单永远是空的
    try { await c.call('Page.bringToFront'); } catch {}
    await new Promise((r) => setTimeout(r, 400));

    const from = await c.js(DB_CUR);
    if (from && from.includes(want)) return { ok: true, from, to: from, reason: '本来就是它' };

    const o = await c.js(DB_OPEN);
    if (!o || !o.ok) return { ok: false, from, to: null, reason: (o && o.why) || '点不开模型菜单' };
    await new Promise((r) => setTimeout(r, 400));

    const pick = await c.js(DB_PICK(want));
    if (!pick || !pick.ok) {
      try { await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); } catch {}
      return { ok: false, from, to: null, reason: (pick && pick.why) || '菜单里没找到' };
    }
    await new Promise((r) => setTimeout(r, 700));

    const to = await c.js(DB_CUR);
    if (to && to.includes(want)) return { ok: true, from, to };
    return { ok: false, from, to, reason: '点了但触发区没变：' + String(to) };
  } catch (e) {
    return { ok: false, from: null, to: null, reason: String((e && e.message) || e).slice(0, 120) };
  } finally {
    try { c.close(); } catch {}
  }
}
