// Trae 驱动：把一句话送进 Trae 的 Agent 面板，等它干完，把「新增的回复」拿回来
// 原理：Trae 是 Electron，用 --remote-debugging-port 开 CDP，直接操作 DOM。
// 由 Trae 自己评审过一轮（reviews/trae-review-trae.mjs.md），下面按它的意见修了 1/2/3/4/5/9 条。
import { attach } from '../lib/cdp.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';

const PORT = Number(process.env.TRAE_CDP_PORT || 9223);
const SEL_EDIT = '[contenteditable="true"]';
const TRAE_EXE = process.env.TRAE_EXE || 'D:\\code app\\ai code\\Trae CN\\Trae CN.exe';

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
    .filter(x => x.r.width > 200 && x.r.height > 20);
  if (!all.length) return null;
  all.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
  return all[0].e;
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
  return c.js(`(() => { const e = ${PICK_EDIT}; return e ? e.innerText : null; })()`);
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
  const payload = JSON.stringify(text);
  const dispatched = await c.js(`(() => {
    const e = ${PICK_EDIT};
    if (!e) return 'NO_EDITABLE';
    e.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(e);
    sel.removeAllRanges();
    sel.addRange(range);
    const dt = new DataTransfer();
    dt.setData('text/plain', ${payload});
    e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return 'DISPATCHED';
  })()`);
  if (dispatched === 'NO_EDITABLE') throw new Error('Trae 输入框不见了（面板切走了？）');

  const norm = (s) => String(s || '').replace(/\r/g, '').replace(/\n+/g, '\n').trim();
  const want = norm(text).slice(-30);
  let last = '';
  for (let i = 0; i < 50; i++) {
    await sleep(120);
    last = norm(await readEditor(c));
    if (last.includes(want)) return last;
  }
  return last;
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
async function pageText(c) {
  return c.js(SER_TEXT);
}

/** 判断 Trae 是否还在干活。作用域尽量收窄，避免用户提问里出现关键词就永远 busy */
async function isBusy(c) {
  return c.js(`(() => {
    // 只看页面末尾：历史消息里残留的「思考中」会让整页判断永远 busy
    const tail = (document.body.innerText || '').slice(-1200);
    if (/思考中|生成中|正在生成|Stop generating/i.test(tail)) return true;
    const stop = document.querySelector('[data-testid*="stop" i],[aria-label*="停止"],[aria-label*="Stop" i]');
    if (stop) { const r = stop.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return true; }
    return false;
  })()`);
}

async function pressEnter(c) {
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

/** 从新增区域里剥出 Trae 真正说的话：TRAE 标记之后、「由 AI 生成」之前 */
function extractReply(text) {
  const s = String(text || '');
  const i = s.lastIndexOf('TRAE');
  const j = s.lastIndexOf('由 AI 生成');
  let body = (i >= 0 && j > i) ? s.slice(i + 4, j) : s;
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

/** 从文本里抽出第一个 ```lang … ``` 代码块；没有围栏就原样返回 */
export function extractCode(text) {
  const s = String(text || '');
  const m = s.match(/```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)```/);
  return (m ? m[1] : s).replace(/^\s*\n/, '').replace(/\s*$/, '');
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
  await ensureTrae({ port: opts.port ?? PORT, waitMs: opts.bootTimeoutMs ?? 90000 });
  // 端口开了不等于窗口建好了，等 Agent 面板目标出现再连
  await waitForTarget(opts.port ?? PORT, 'Agent', opts.bootTimeoutMs ?? 90000);
  const c = await attach(opts.port ?? PORT, 'Agent');
  try {
    if (!await inputSelectorReady(c)) throw new Error('Trae Agent 面板没就绪');

    let left = await clearInput(c);
    if (left < 0) throw new Error('输入框不存在（面板可能没打开）');
    if (left > 0) { await sleep(400); left = await clearInput(c); }
    if (left < 0) throw new Error('输入框不存在');
    if (left > 0) throw new Error('清空输入框失败，还剩 ' + left + ' 个非空白字符');

    const typed = await typeInto(c, prompt);
    const tailWant = String(prompt).replace(/\r/g, '').replace(/\n+/g, '\n').trim().slice(-30);
    if (!typed.includes(tailWant)) {
      throw new Error('写入内容不完整。期望结尾「' + JSON.stringify(tailWant) + '」，实际结尾「' + JSON.stringify(typed.slice(-60)) + '」');
    }

    // 基线必须在「输入框已写满、还没发送」这一刻取 —— 之前取会把残留草稿算进去
    const beforeText = await pageText(c);
    const baseAns = await readAnswers(c);   // 发送前的回复容器数量（判断"是否新增一条"的基准）
    await sleep(250);
    await pressEnter(c);

    // 1) 确认发出去了：输入框被清空
    const t0 = Date.now();
    let sent = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const cur = await readEditor(c);
      if (cur !== null && cur.replace(/[\s\u200b]/g, '') === '') { sent = true; break; }
    }
    if (!sent) throw new Error('回车没发出去，输入框还留着文字');

    // 2) 等它干完
    // 判据只能看「回合数增长 + 内容稳定」。不能拿"busy 变 false"当完成信号——
    // 实测（2026-11-13）：Trae 先 busy 约 2 秒表示已收到，然后 busy 归 false 出现空档，
    // 真正的内容是之后才流进来的。早期版本在 busy 一掉就收工，于是把"还没来"误判成"没回答"。
    const DEBUG = process.env.ORCH_DEBUG_TRAE === '1';
    const HARD_TIMEOUT = timeoutMs;
    let lastText = '', stableSince = Date.now(), sawBusy = false, finished = false;
    while (Date.now() - t0 < HARD_TIMEOUT) {
      await sleep(700);
      const ans = await readAnswers(c);
      const busy = await isBusy(c);
      const grew = ans.turns > baseAns.turns;
      const hasText = ans.text.length > 0;
      if (DEBUG) console.error(`[poll ${((Date.now() - t0) / 1000).toFixed(1)}s] busy=${busy} turns=${ans.turns}(base ${baseAns.turns}) len=${ans.text.length} grew=${grew}`);
      if (busy) sawBusy = true;

      if (grew && hasText) {
        if (ans.text !== lastText) {
          lastText = ans.text;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= settleMs) {
          finished = true;
          break;
        }
      } else {
        lastText = '';
        stableSince = Date.now();
      }
    }

    // 3) 取结果：容器法优先（干净），失败才退回页面文本 diff
    const ans = await readAnswers(c);
    let added, source;
    if (ans.turns > baseAns.turns && ans.text) {
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
      const rawAdded = afterText.slice(commonPrefixLen(beforeText, afterText)).trim();
      added = cleanCodeChrome(extractReply(rawAdded));
      source = 'text-diff';
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

// ---- 精确取回复：读"最后一条助手回合"里的最后一个 markdown 容器 ----
// 实测结构（2026-11-13 探针）：div.turn__agent-message > div.agent-message-plan-flow > div.markdown-renderer > p
// 注意：答案的渲染容器**也在** plan-flow 里面，所以不能排除 plan-flow，
// 只能按"回合数增长 + 取回合内最后一个 renderer"来定位（思考过程是前一个）。
const ANSWER_JS = `(() => {
  const turns = document.querySelectorAll('.turn__agent-message');
  const last = turns[turns.length - 1];
  let text = '';
  if (last) {
    const rs = last.querySelectorAll('.markdown-renderer');
    const r = rs[rs.length - 1];
    if (r) text = (r.innerText || '').trim();
  }
  return { turns: turns.length, text: text };
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

/** 只读：拿当前页面的渲染文本（含滚动外内容） */
export async function peekTrae(opts = {}) {
  const c = await attach(opts.port ?? PORT, 'Agent');
  try {
    return await pageText(c);
  } finally {
    try { await c.close(); } catch { }
  }
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