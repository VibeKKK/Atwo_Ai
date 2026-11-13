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

console.log('=== 各候选选择器命中数 ===');
console.log(await ev(`JSON.stringify((()=>{const c=['[class*=message]','[class*=Message]','[class*=turn]','[class*=bubble]','[class*=markdown]','[class*=reply]','[class*=answer]','[class*=chat-item]','[class*=dialog]','[data-message-id]','[data-testid]','[class*=cb-]'];
return c.map(s=>({s,n:document.querySelectorAll(s).length})).filter(x=>x.n>0&&x.n<200);})(),null,1)`));

console.log('\n=== main 容器结构（前 2500 字符）===');
console.log(await ev(`(()=>{const m=document.querySelector('main')||document.body;return m.outerHTML.slice(0,2500)})()`));
ws.close(); process.exit(0);
