// 定位发送按钮：列出所有 button 的 aria-label/title/innerText/disabled
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/kkk/.dsh/profiles/desktop/node_modules/');
const WebSocket = require('ws');
const ROOT = 'D:/ai project/ai team work';
const targets = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', '.wb-targets.json'), 'utf8'));
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'), { origin: 'http://localhost' });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let seq = 0;
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const on = (raw) => { let o; try { o = JSON.parse(raw.toString()); } catch { return; } if (o.id !== id) return; ws.off('message', on); o.error ? rej(new Error(JSON.stringify(o.error))) : res(o.result); };
  ws.on('message', on); ws.send(JSON.stringify({ id, method: m, params: p }));
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value;

console.log('=== 所有 button（含 aria-label）===');
console.log(await ev(`JSON.stringify([...document.querySelectorAll('button')].map((b,i)=>({
  i, txt:(b.innerText||'').trim().slice(0,14), aria:b.getAttribute('aria-label')||'', title:b.title||'',
  cls:String(b.className).slice(0,44), dis:b.disabled, vis:!!(b.offsetWidth||b.offsetHeight)
})).filter(x=>x.vis||x.aria), null, 1)`));

console.log('\n=== 输入框父级往上 3 层的 HTML 片段 ===');
console.log(await ev(`(() => {
  const el = document.querySelector('div[contenteditable="true"]');
  let n = el; for (let i=0;i<3;i++) n = n.parentElement || n;
  return n.outerHTML.slice(0, 1600);
})()`));

console.log('\n=== 输入框当前内容 ===');
console.log(await ev(`(()=>{const e=document.querySelector('div[contenteditable="true"]');return JSON.stringify({txt:(e.innerText||'').slice(0,60), len:(e.innerText||'').length})})()`));
ws.close(); process.exit(0);
