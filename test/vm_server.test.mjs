// 判定服务（ternary-oracle）测试 —— 服务端 + 客户端 + fail-closed。
//
// 为什么要在同一个文件里测两头：这层的价值全在「不可用时的行为」。只测服务端就等于
// 只测 happy path；只测客户端就等于测 mock。这里起真服务、走真 HTTP、再用真客户端打它。
//
// 端口一律用 0（系统分配），不占固定端口 —— 否则本机同时跑着 oracle 时测试会随机红，
// 而那种红看起来像「服务写坏了」，实际是测试自己抢端口。

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async (rel) => {
  try { return await import(pathToFileURL(path.join(root, rel)).href); }
  catch (e) { return { __missing: (e && e.message) || String(e) }; }
};

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

const S = await load('vm/server.mjs');
const C = await load('vm/client.mjs');

if (S.__missing || C.__missing) {
  check('vm/server.mjs 与 vm/client.mjs 可加载', false, (S.__missing || C.__missing));
} else {
  const svc = await S.createServer({ port: 0 });
  const base = 'http://127.0.0.1:' + svc.port;
  const post = async (p, body, headers) => {
    const res = await fetch(base + p, { method: 'POST', headers: headers || { 'content-type': 'application/json' }, body });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  // —— 服务自述 ——
  const h = await fetch(base + '/health').then((r) => r.json()).catch(() => null);
  check('GET /health 是判定服务', h && h.service === 'ternary-oracle' && h.ok === true, JSON.stringify(h && h.service));
  check('GET /health 带分档阈值', !!(h && h.cut && h.cut.high === 0.45 && h.cut.mid === 0.22), JSON.stringify(h && h.cut));

  // —— 判定：9 项强证据 → 可判 +1 ——
  const strong = [3.1, 2.9, 3.4, 2.8, 3.0, 3.2, 2.7, 3.3, 3.1];
  const r1 = await post('/judge', JSON.stringify({ zValues: strong }));
  check('POST /judge 强证据 → value=1 可判', r1.status === 200 && r1.data && r1.data.value === 1, JSON.stringify(r1.data && r1.data.value));
  check('POST /judge 回带可复算的 stats', !!(r1.data && r1.data.stats && typeof r1.data.stats.nValid === 'number'), JSON.stringify(r1.data && r1.data.stats));
  check('POST /judge 带编译/现算一致性自检', !!(r1.data && r1.data.checked && r1.data.checked.consistent === true));

  // —— 判定：全零 → 别判 -1 ——
  const r2 = await post('/judge', JSON.stringify({ zValues: [0, 0, 0, 0, 0, 0, 0, 0, 0] }));
  check('POST /judge 全零 → value=-1 别判', r2.data && r2.data.value === -1, JSON.stringify(r2.data && r2.data.value));

  // —— GET 形式与 POST 等价 ——
  const g = await fetch(base + '/judge?z=' + strong.join(',') + '&expected=9').then((r) => r.json());
  check('GET /judge?z= 与 POST 结论一致', g && g.value === r1.data.value, JSON.stringify(g && g.value));

  // —— 畸形输入一律 4xx，不猜 ——
  const bad1 = await post('/judge', '{not json');
  check('坏 JSON → 400', bad1.status === 400 && bad1.data.ok === false, String(bad1.status));
  const bad2 = await post('/judge', JSON.stringify({ zValues: [1, 'x'] }));
  check('z 里混非数字 → 400', bad2.status === 400 && bad2.data.ok === false, String(bad2.status));
  const bad3 = await post('/judge', JSON.stringify({ zValues: [] }));
  check('空 z → 400（没数据不该问判定）', bad3.status === 400 && bad3.data.ok === false, String(bad3.status));
  const bad4 = await post('/judge', JSON.stringify({ zValues: [1], expected: -3 }));
  check('expected 非法 → 400', bad4.status === 400, String(bad4.status));
  const nf = await fetch(base + '/nope');
  check('未知路径 → 404', nf.status === 404, String(nf.status));
  const mw = await fetch(base + '/votes', { method: 'GET' });
  check('GET /votes → 405', mw.status === 405, String(mw.status));
  const big = await post('/judge', 'x'.repeat(70 * 1024));
  check('超大请求体 → 4xx（不无限吃内存）', big.status === 413 || big.status === 400, String(big.status));

  // —— 票 → 三态 ——
  // 过闸门必须带 expected（应评名单）：不带 = 到票率不可算 = 一律 no-roster。
  const v1 = await post('/votes', JSON.stringify({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'], expected: 3 }));
  check('POST /votes 三票全 ACCEPT → ACCEPT', v1.data && v1.data.state === 'ACCEPT' && v1.data.value === 1, JSON.stringify(v1.data && v1.data.state));
  const v1b = await post('/votes', JSON.stringify({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'] }));
  check('POST /votes 不带 expected → no-roster（不放行）', v1b.data && v1b.data.state === 'unreviewed' && v1b.data.reason === 'no-roster', JSON.stringify(v1b.data && v1b.data.reason));
  const v2 = await post('/votes', JSON.stringify({ votes: ['REVISE', 'REVISE', 'REVISE'], expected: 3 }));
  check('POST /votes 三票全 REVISE → REVISE', v2.data && v2.data.state === 'REVISE' && v2.data.direction === -1, JSON.stringify(v2.data && v2.data.state));
  const v3 = await post('/votes', JSON.stringify({ votes: ['ACCEPT', 'REVISE', 'ACCEPT'], expected: 3 }));
  check('POST /votes 2:1 分歧 → unreviewed（不按多数票放行）', v3.data && v3.data.state === 'unreviewed', JSON.stringify(v3.data && v3.data.reason));
  const v4 = await post('/votes', JSON.stringify({ votes: ['ACCEPT', 'MAYBE', null] }));
  check('POST /votes 有认不出的票 → 400', v4.status === 400, String(v4.status));

  // —— 客户端打真服务 ——
  const c1 = await C.remoteJudge(strong, { url: base });
  check('客户端 remoteJudge 打到真服务', c1.ok === true && c1.source === 'remote' && c1.value === 1, JSON.stringify(c1.value || c1.error));
  const c2 = await C.health({ url: base });
  check('客户端 health 认出服务', c2.ok === true && c2.service === 'ternary-oracle', JSON.stringify(c2.error || c2.version));

  await svc.close();

  // —— fail-closed：服务关了以后，客户端必须说拿不到，不许给替代结论 ——
  const c3 = await C.remoteJudge(strong, { url: base });
  check('服务关掉 → ok:false 且无 value', c3.ok === false && c3.value === undefined, String(c3.error).slice(0, 60));
  const c4 = await C.health({ url: base });
  check('服务关掉 → health 也给 ok:false', c4.ok === false, String(c4.error).slice(0, 60));

  // —— 超时要有界：故意造一个 300ms 才回话的服务，客户端 80ms 就该放弃 ——
  const slow = (await import('node:http')).createServer((req, res) => {
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"value":1}'); }, 300);
  });
  const slowPort = await new Promise((done) => slow.listen(0, '127.0.0.1', () => done(slow.address().port)));
  const t0 = Date.now();
  const c5 = await C.remoteVotes(['ACCEPT'], { url: 'http://127.0.0.1:' + slowPort, timeoutMs: 80 });
  const spent = Date.now() - t0;
  await new Promise((done) => slow.close(done));
  check('慢服务 → 超时放弃（不是无限等）', c5.ok === false && spent < 250, spent + 'ms · ' + String(c5.error).slice(0, 40));

  // —— 显式降级：只有调用方选了才降级，且 source 要如实写 ——
  const c6 = await C.judgeWithFallback(strong, { url: 'http://127.0.0.1:1', timeoutMs: 300 });
  check('judgeWithFallback 降级时标 source=local 且带 remoteError', c6.ok === true && c6.source === 'local' && c6.degraded === true && !!c6.remoteError, String(c6.remoteError).slice(0, 50));

  // —— 空输入在客户端就拦下（不浪费一次网络往返） ——
  const c7 = await C.remoteJudge([], { url: base });
  check('客户端空 z → ok:false', c7.ok === false, c7.error);
}

let pass = 0; let fail = 0;
for (const r of results) {
  if (r.ok) { pass++; console.log('  ✓ ' + r.name); }
  else { fail++; console.log('  ✗ ' + r.name + (r.detail ? '  → ' + r.detail : '')); }
}
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
