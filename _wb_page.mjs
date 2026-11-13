// WorkBuddy 页面探针：连 page WS，读 DOM 结构，找输入框/消息区
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/kkk/.dsh/profiles/desktop/node_modules/');
const WebSocket = require('ws');
const PORT = Number(process.env.WB_PORT || 9224);
const ROOT = 'D:/ai project/ai team work';

const targets = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', '.wb-targets.json'), 'utf8'));
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('没有 page 目标'); process.exit(1); }
const url = page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1');

const ws = new WebSocket(url, { origin: 'http://localhost' });
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

const PROBE = `(() => {
  const out = { title: document.title, url: location.href, bodyLen: 0, editables: [], textareas: [], buttons: [], anchors: [], inputs: [] };
  out.bodyLen = (document.body && document.body.innerText || '').length;
  const desc = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.className && String(el.className).slice(0, 90)) || '',
    id: el.id || '',
    ce: el.getAttribute('contenteditable'),
    ph: el.getAttribute('placeholder') || el.getAttribute('aria-label') || '',
    vis: !!(el.offsetWidth || el.offsetHeight),
  });
  document.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach((e) => out.editables.push(desc(e)));
  document.querySelectorAll('textarea').forEach((e) => out.textareas.push(desc(e)));
  document.querySelectorAll('input').forEach((e) => out.inputs.push(desc(e)));
  document.querySelectorAll('button, [role=button]').forEach((e) => {
    const t = (e.innerText || e.getAttribute('aria-label') || e.title || '').trim().slice(0, 24);
    if (t) out.buttons.push({ text: t, cls: (e.className && String(e.className).slice(0, 50)) || '', vis: !!(e.offsetWidth || e.offsetHeight) });
  });
  out.buttons = out.buttons.slice(0, 40);
  out.tail = (document.body.innerText || '').slice(-1200);
  return JSON.stringify(out);
})()`;

const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: false });
const d = JSON.parse(r.result.value);
console.log('=== 页面 ===');
console.log('title :', d.title);
console.log('url   :', d.url.slice(0, 120));
console.log('bodyLen:', d.bodyLen);
console.log('\n=== 可输入元素 ===');
console.log('contenteditable:', JSON.stringify(d.editables, null, 1));
console.log('textarea       :', JSON.stringify(d.textareas, null, 1));
console.log('input          :', JSON.stringify(d.inputs.slice(0, 6), null, 1));
console.log('\n=== 可见按钮（前 40）===');
for (const b of d.buttons) if (b.vis) console.log('  ', JSON.stringify(b.text), '|', b.cls);
console.log('\n=== 页面尾部文本 ===');
console.log(d.tail.slice(-700));
ws.close();
process.exit(0);
