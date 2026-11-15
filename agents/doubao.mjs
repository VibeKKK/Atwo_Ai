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
import { join } from 'node:path';
import { withLockPool } from '../lib/lock.mjs';
import { check, record } from '../lib/budget.mjs';
import { appendLog } from '../lib/memory.mjs';
import { CDP } from '../lib/cdp.mjs';

const NAME = 'doubao';
const PORT = Number(process.env.DB_PORT || 9225);
const WORKSPACE = process.env.DB_WORKSPACE || 'D:\\ai work replace\\doubao place\\work test one';
// 三通道共享工作区：opts.shared=true 走这里，用于跨通道协作/特殊需求
const SHARED_WS = process.env.ORCH_SHARED_WS || 'D:\\ai work replace\\TDW place';
const BOX = join(WORKSPACE, '.mailbox');
const TIMEOUT_MS = Number(process.env.DB_TIMEOUT_MS || 300000);

async function attachPage() {
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
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
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
  port: PORT,
  workspace: WORKSPACE,
};
