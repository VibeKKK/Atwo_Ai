// WorkBuddy CDP 探针：重启应用 → 抓 browser WS 地址 → 列目标
// 用法: node _wb_cdp.mjs            （重启并列表）
//       node _wb_cdp.mjs --keep     （不重启，只用已有 WS 文件）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const EXE = 'D:\\code app\\ai code\\WorkBuddy\\WorkBuddy.exe';
const WS_FILE = path.join(ROOT, 'memory', '.wb-ws.txt');
const require = createRequire('C:/Users/kkk/.dsh/profiles/desktop/node_modules/');
const WebSocket = require('ws');

function waitWsUrl(proc, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('等 DevTools 地址超时')), timeoutMs);
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { clearTimeout(t); proc.stdout.off('data', onData); resolve(m[1]); }
    };
    proc.stdout.on('data', onData);
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error('应用退出 code=' + c)); });
  });
}

async function rpc(ws, id, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const onMsg = (raw) => {
      let o; try { o = JSON.parse(raw.toString()); } catch { return; }
      if (o.id !== id) return;
      ws.off('message', onMsg);
      o.error ? reject(new Error(method + ' → ' + JSON.stringify(o.error))) : resolve(o.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify(msg));
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: 'http://localhost' });
    ws.on('open', () => resolve(ws));
    ws.on('error', (e) => reject(e));
  });
}

const keepMode = process.argv.includes('--keep');
let url;
if (keepMode && fs.existsSync(WS_FILE)) {
  url = fs.readFileSync(WS_FILE, 'utf8').trim();
  console.log('[i] 复用已保存的 WS: ' + url);
} else {
  console.log('[1] 启动 WorkBuddy（带 WORKBUDDY_REMOTE_DEBUGGING_PORT=9224）…');
  const p = spawn(EXE, [], {
    env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: '9224' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  });
  p.unref();
  url = await waitWsUrl(p);
  fs.mkdirSync(path.dirname(WS_FILE), { recursive: true });
  fs.writeFileSync(WS_FILE, url);
  console.log('[2] DevTools: ' + url);
}
console.log('[3] 连接 browser 级 WS…');
const ws = await connect(url);
console.log('[4] Target.getTargets …');
const { targetInfos } = await rpc(ws, 1, 'Target.getTargets');
for (const t of targetInfos) {
  console.log(`    [${t.type}] ${t.title || '(无题)'}  ${t.url ? t.url.slice(0, 90) : ''}`);
}
fs.writeFileSync(path.join(ROOT, 'memory', '.wb-targets.json'), JSON.stringify(targetInfos, null, 2));
console.log('[5] 已写 memory/.wb-targets.json，目标数 ' + targetInfos.length);
ws.close();
process.exit(0);
