// WorkBuddy 派活探针：输入 → 发送 → 等回答
// 用法: node _wb_send.mjs "只回复两个字：收到"
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/kkk/.dsh/profiles/desktop/node_modules/');
const WebSocket = require('ws');
const ROOT = 'D:/ai project/ai team work';
const prompt = process.argv[2] || '只回复两个字：收到';

const targets = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', '.wb-targets.json'), 'utf8'));
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'), { origin: 'http://localhost' });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let seq = 0;
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      let o; try { o = JSON.parse(raw.toString()); } catch { return; }
      if (o.id !== id) return;
      ws.off('message', onMsg);
      o.error ? reject(new Error(method + ' → ' + JSON.stringify(o.error))) : resolve(o.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

const bodyLen = () => evalJs('(document.body.innerText||"").length');

// 1) 输入
const typed = await evalJs(`(() => {
  const el = document.querySelector('div[contenteditable="true"]');
  if (!el) return { ok: false, why: '找不到输入框' };
  el.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
  const got = el.innerText || el.textContent || '';
  return { ok: got.includes(${JSON.stringify(prompt.slice(0, 6))}), len: got.length, got: got.slice(0, 80) };
})()`);
console.log('[1] 输入:', JSON.stringify(typed));
if (!typed.ok) { console.error('输入失败，停止'); ws.close(); process.exit(1); }

const before = await bodyLen();
console.log('[2] 发送前 bodyLen =', before);

// 2) 点发送
const clicked = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(x => (x.innerText || '').trim() === '发送');
  if (!b) return { ok: false, why: '找不到发送按钮' };
  if (b.disabled) return { ok: false, why: '发送按钮 disabled' };
  b.click();
  return { ok: true, cls: String(b.className).slice(0, 60) };
})()`);
console.log('[3] 发送:', JSON.stringify(clicked));

// 3) 轮询等回答
let last = before;
let stable = 0;
for (let i = 1; i <= 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const len = await bodyLen();
  const grew = len > last;
  if (grew) { last = len; stable = 0; } else { stable++; }
  console.log(`[poll ${i}s] bodyLen=${len} grew=${grew} stable=${stable}`);
  if (len > before + 8 && stable >= 3) break;
}

const tail = await evalJs('(document.body.innerText||"").slice(-1500)');
console.log('\n=== 页面尾部 1500 字符 ===');
console.log(tail);
ws.close();
process.exit(0);
