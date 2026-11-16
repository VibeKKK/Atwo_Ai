// python 版判定服务与 node 版的**对拍**测试。
//
// 为什么必须有这一份：判定公式现在有两个实现（node 是源头，python 是为了在 Kali VM 里
// 起服务而照契约复刻的）。两份实现的危险不在于写得像不像，而在于**改了 node 忘了 python** ——
// 那时所有 node 单测照样全绿，而线上判定已经悄悄变了语义。这正是「两份解释器」那次事故的形状。
//
// 所以这里不做「python 也能跑」这种弱断言，而是拿随机向量逼两边给出同一个数：
// 结论（value/state）必须完全一致，置信度必须精确到 1e-9 以内。

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = await import(pathToFileURL(path.join(root, 'vm/judge.mjs')).href);
const V = await import(pathToFileURL(path.join(root, 'vm/votes.mjs')).href);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

/** 找 python：环境变量 > 本机常见路径 > PATH。找不到就跳过整份（不是失败）。 */
function findPython() {
  const cands = [process.env.TERNARY_PYTHON,
    'C:/Users/kkk/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
    'python3', 'python'].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

const py = findPython();
if (!py) {
  console.log('  – 跳过：本机没找到 python（设 TERNARY_PYTHON 指定解释器）');
  console.log('\n通过 0 / 失败 0 / 跳过 1');
  process.exit(0);
}

// —— 起服务：端口 0，从 stdout 那句「监听 …:端口」里把真实端口抠出来 ——
// PYTHONIOENCODING：不设的话中文按 GBK 输出，端口那行会变乱码，正则抠不出来。
const child = spawn(py, [path.join(root, 'vm/oracle_server.py'), '--host', '127.0.0.1', '--port', '0'],
  { cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
const port = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('python 服务 5s 内没起来: ' + buf.slice(-200))), 5000);
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    // 只认 「http://地址:端口」这一形态，不依赖中文那几个字（编码一变就丢）。
    const m = buf.match(/http:\/\/[0-9.]+:(\d+)/);
    if (m) { clearTimeout(timer); resolve(Number(m[1])); }
  });
  child.stderr.on('data', (d) => { buf += d.toString('utf8'); });
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error('python 服务退出 code=' + code + ' ' + buf.slice(-200))); });
});

const base = 'http://127.0.0.1:' + port;
const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

try {
  const health = await fetch(base + '/health').then((r) => r.json());
  check('python 服务自述是 ternary-oracle', health && health.service === 'ternary-oracle' && health.engine === 'python');
  check('python 服务读的是同一份契约（阈值一致）', health && health.cut.high === J.CUT.high && health.cut.mid === J.CUT.mid, JSON.stringify(health && health.cut));

  // —— 契约里的参考向量必须逐点相等 ——
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'vm/oracle-contract.json'), 'utf8'));
  let vecOk = 0;
  for (const v of contract.vectors) {
    const r = await post('/judge', { zValues: v.zValues });
    if (r.data && r.data.value === v.value && Math.abs(r.data.confidence - v.confidence) < 1e-9) vecOk += 1;
  }
  check('契约 ' + contract.vectors.length + ' 组参考向量两边完全一致', vecOk === contract.vectors.length, vecOk + '/' + contract.vectors.length);

  // —— 随机 z 值对拍：结论必一致，置信度 1e-9 ——
  let seed = 20261116;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let zOk = 0, zTotal = 0, worst = 0;
  const zBad = [];
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(rnd() * 12);
    const zs = Array.from({ length: n }, () => {
      const r = rnd();
      if (r < 0.1) return 0;
      if (r < 0.2) return (rnd() - 0.5) * 12; // 越过截断边界
      return (rnd() - 0.5) * 6;
    });
    const expected = rnd() < 0.5 ? undefined : 3 + Math.floor(rnd() * 9);
    const node = J.judge({ zValues: zs, expected });
    const got = await post('/judge', { zValues: zs, expected });
    zTotal += 1;
    const diff = Math.abs((got.data && got.data.confidence) - node.confidence);
    if (diff > worst) worst = diff;
    // 比 reason 而不只比结论：python 版曾把「别判」当中文 reason 回出去，
    // node 版回机器码 —— 结论、confidence 都一样，只比 value 根本抓不到这种漂移。
    const sameReason = !!(got.data && got.data.reason === node.reason);
    if (got.data && got.data.value === node.value && diff < 1e-9 && sameReason) zOk += 1;
    else if (zBad.length < 3) zBad.push({ zs, expected, node: node.value, py: got.data && got.data.value, diff });
  }
  check('随机 z 值 200 组：结论一致且置信度差 <1e-9', zOk === zTotal, zOk + '/' + zTotal + ' 最大差 ' + worst.toExponential(2) + (zBad.length ? ' 例:' + JSON.stringify(zBad[0]) : ''));

  // —— 随机票型对拍：state 与 confidence 都要一致 ——
  const pool = ['ACCEPT', 'REVISE', null];
  let vOk = 0, vTotal = 0;
  const vBad = [];
  for (let i = 0; i < 120; i++) {
    const n = 1 + Math.floor(rnd() * 5);
    const votes = Array.from({ length: n }, () => pool[Math.floor(rnd() * pool.length)]);
    const expected = rnd() < 0.5 ? undefined : 2 + Math.floor(rnd() * 4);
    const node = V.judgeVotes({ votes, expected });
    const got = await post('/votes', { votes, expected });
    vTotal += 1;
    const diff = Math.abs((got.data && got.data.confidence) - node.confidence);
    const sameReason = !!(got.data && got.data.reason === node.reason);
    const textOk = !!(got.data && (node.reasonText == null
      ? got.data.reasonText == null
      : got.data.reasonText === node.reasonText));
    if (got.data && got.data.state === node.state && diff < 1e-9 && sameReason && textOk) vOk += 1;
    else if (vBad.length < 3) vBad.push({ votes, expected, node: node.state, py: got.data && got.data.state, diff });
  }
  check('随机票型 120 组：三态结论一致且置信度差 <1e-9', vOk === vTotal, vOk + '/' + vTotal + (vBad.length ? ' 例:' + JSON.stringify(vBad[0]) : ''));

  // —— 放行侧：不声明名单时两边都必须是 no-roster（这是最容易一边严一边松的地方） ——
  for (const votes of [['ACCEPT', 'ACCEPT', 'ACCEPT'], ['REVISE', 'REVISE'], []]) {
    const node = V.judgeVotes({ votes });
    const got = await post('/votes', { votes });
    const same = got.data && got.data.state === node.state && got.data.reason === node.reason
      && got.data.value === node.value && (got.data.reasonText || null) === (node.reasonText || null);
    check('无名单 ' + JSON.stringify(votes) + ' → 两边都 unreviewed/no-roster', same,
      JSON.stringify({ node: [node.state, node.reason, node.value], py: got.data && [got.data.state, got.data.reason, got.data.value] }));
  }

  // —— 畸形输入两边都必须 4xx（不许一边宽容一边严） ——
  const b1 = await post('/judge', { zValues: [1, 'x'] });
  const b2 = await post('/votes', { votes: ['MAYBE'] });
  const b3 = await post('/judge', { zValues: [] });
  check('畸形输入 python 侧也 4xx', b1.status === 400 && b2.status === 400 && b3.status === 400, [b1.status, b2.status, b3.status].join('/'));
  const got404 = await fetch(base + '/nope').then((r) => r.status);
  check('未知路径 python 侧 404', got404 === 404, String(got404));
} finally {
  child.kill();
}

let pass = 0; let fail = 0;
for (const r of results) {
  if (r.ok) { pass++; console.log('  ✓ ' + r.name); }
  else { fail++; console.log('  ✗ ' + r.name + (r.detail ? '  → ' + r.detail : '')); }
}
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
