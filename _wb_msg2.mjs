import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire('C:/Users/kkk/.dsh/profiles/desktop/node_modules/');
const WebSocket = require('ws');
const targets = JSON.parse(fs.readFileSync('D:/ai project/ai team work/memory/.wb-targets.json','utf8'));
const page = targets.find(t=>t.type==='page');
const ws = new WebSocket(page.webSocketDebuggerUrl.replace('localhost','127.0.0.1'), { origin:'http://localhost' });
await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j)});
let seq=0;
const send=(m,p={})=>new Promise((res,rej)=>{const id=++seq;const on=(raw)=>{let o;try{o=JSON.parse(raw.toString())}catch{return}if(o.id!==id)return;ws.off('message',on);o.error?rej(new Error(JSON.stringify(o.error))):res(o.result)};ws.on('message',on);ws.send(JSON.stringify({id,method:m,params:p}))});
const ev=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
console.log(await ev(`JSON.stringify([...document.querySelectorAll('[data-message-id]')].map((e,i)=>({
  i, id:e.getAttribute('data-message-id'),
  role:e.getAttribute('data-role')||e.getAttribute('data-author')||'',
  cls:String(e.className).slice(0,80),
  txt:(e.innerText||'').slice(0,120),
  md: e.querySelectorAll('[class*=markdown]').length
})),null,1)`));
ws.close(); process.exit(0);
