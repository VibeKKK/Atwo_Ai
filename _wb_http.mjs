// 用 Node http 直连 CDP 的 HTTP 端点（覆盖 Host 以通过 DNS-rebinding 校验）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/ai project/ai team work';
const PORT = Number(process.env.WB_PORT || 9224);

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method: 'GET',
        headers: { Host: `localhost:${PORT}`, Connection: 'close' }, timeout: 6000 },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

for (const p of ['/json/version', '/json/list']) {
  try {
    const r = await get(p);
    console.log(`[${p}] HTTP ${r.status}  ${r.body.length} 字节`);
    if (p === '/json/list') {
      const list = JSON.parse(r.body);
      console.log('  目标数: ' + list.length);
      for (const t of list) {
        console.log(`   [${t.type}] ${t.title}  ${(t.url || '').slice(0, 80)}`);
        console.log('      ws=' + t.webSocketDebuggerUrl);
      }
      fs.mkdirSync(path.join(ROOT, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'memory', '.wb-targets.json'), JSON.stringify(list, null, 2));
    } else {
      console.log('  ' + r.body.slice(0, 300));
    }
  } catch (e) {
    console.log(`[${p}] 失败: ${e.message}`);
  }
}
