// WorkBuddy 派活（CDP Input 真实事件版）：清空 → 输入 → 点发送 → 等回答
// 用法: node _wb_send2.mjs "只回复两个字：收到"
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
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let seq = 0;
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const on = (raw) => { let o; try { o = JSON.parse(raw.toString()); } catch { return; } if (o.id !== id) return; ws.off('message', on); o.error ? rej(new Error(m + ' → ' + JSON.stringify(o.error))) : res(o.result); };
  ws.on('message', on); ws.send(JSON.stringify({ id, method: m, params: p }));
});
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
};

// 1) 聚焦 + 清空
await ev(`(()=>{const e=document.querySelector('div[data-slate-editor="true"]');e.focus();return true})()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
console.log('[1] 已清空:', await ev(`(document.querySelector('div[data-slate-editor="true"]').innerText||'').length`));

// 2) 真实输入
await send('Input.insertText', { text: prompt });
const typed = await ev(`(()=>{const e=document.querySelector('div[data-slate-editor="true"]');return JSON.stringify({len:(e.innerText||'').length,txt:(e.innerText||'').slice(0,50)})})()`);
console.log('[2] 输入后:', typed);

const before = await ev(`(document.body.innerText||'').length`);
console.log('[3] 点发送前 bodyLen =', before);

// 3) 点发送（aria-label=发送）
const clicked = await ev(`(()=>{const b=document.querySelector('button[aria-label="发送"]');
  if(!b) return 'no-button'; if(b.disabled) return 'disabled'; b.click(); return 'clicked'})()`);
console.log('[4] 发送:', clicked);

// 4) 轮询
let last = before, stable = 0, maxLen = before;
for (let i = 1; i <= 45; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const len = await ev(`(document.body.innerText||'').length`);
  if (len > maxLen) maxLen = len;
  const grew = len > last;
  stable = grew ? 0 : stable + 1;
  last = len;
  if (i % 3 === 0 || grew) console.log(`[poll ${i}s] len=${len} max=${maxLen} stable=${stable}`);
  if (maxLen > before + 20 && stable >= 4) break;
}

console.log('\n=== 页面尾部 2000 字符 ===');
console.log(await ev(`(document.body.innerText||'').slice(-2000)`));
console.log('\n=== 消息区候选选择器 ===');
console.log(await ev(`JSON.stringify((()=>{
  const cands = ['[class*=message]','[class*=chat]','[class*=turn]','[class*=bubble]','[class*=markdown]','[data-role]','[class*=conversation]'];
  return cands.map(s=>({sel:s,n:document.querySelectorAll(s).length})).filter(x=>x.n>0);
})(),null,1)`));
ws.close();
process.exit(0);
