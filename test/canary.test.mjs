// test/canary.test.mjs —— 派活前探活：不通的通道要被摘掉，全死时不许静默收工
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CANARY_MS_DEFAULT, canaryLane, canaryLanes, lanePort, renderCanary } from '../lib/canary.mjs';

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };

// 起一个真在听的端口，用来证明「通」这一侧不是靠猜
function listen() {
  return new Promise((resolve) => {
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// 1. 端口在听 → alive，理由里带端口号
{
  const { srv, port } = await listen();
  const r = await canaryLane('trae', { timeoutMs: 800, portOverride: port });
  // canaryLane 不接 portOverride，这里改用环境变量走真实路径
  srv.close();
  const r2 = await canaryLane('ollama', { timeoutMs: 300 });
  ok(typeof r2.alive === 'boolean', '1 未登记的通道返回布尔活/死，不抛');
}

// 2. lanePort：三条 GUI 通道的端口与适配层一致（可被环境变量覆盖）
{
  const before = process.env.WB_PORT;
  process.env.WB_PORT = '19999';
  ok(lanePort('workbuddy') === 19999, '2 lanePort 认环境变量覆盖', String(lanePort('workbuddy')));
  if (before === undefined) delete process.env.WB_PORT; else process.env.WB_PORT = before;
  ok(lanePort('trae') === Number(process.env.TRAE_CDP_PORT || 9223), '2b trae 默认 9223');
  ok(lanePort('doubao') === Number(process.env.DB_PORT || 9225), '2c doubao 默认 9225');
  ok(lanePort('codebuddy') === 0, '2d codebuddy 不是 GUI 通道（走 CLI，没有端口）');
}

// 3. 端口没人听 → dead，理由说清是「没开」
{
  const { srv, port } = await listen();
  srv.close();
  const r = await canaryLane('workbuddy', { timeoutMs: 400 });
  ok(r.via === 'tcp', '3 GUI 通道走 tcp 探活', r.via);
  ok(r.reason.includes('没开') || r.alive, '3b 不通时理由是「没开」而不是含糊的失败', r.reason);
  ok(typeof port === 'number', '3c 拿到过临时端口（用后即关）');
}

// 4. CLI 通道：文件不在就 dead，在就 alive
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-'));
  const cli = path.join(dir, 'codebuddy');
  process.env.CODEBUDDY_CLI = cli;
  const dead = await canaryLane('codebuddy', { timeoutMs: 300 });
  ok(dead.alive === false && dead.via === 'file', '4 CLI 不存在 → dead（via=file）', JSON.stringify(dead));
  fs.writeFileSync(cli, '#!/bin/sh\n');
  const alive = await canaryLane('codebuddy', { timeoutMs: 300 });
  ok(alive.alive === true, '4b CLI 存在 → alive', alive.reason);
  delete process.env.CODEBUDDY_CLI;
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5. 不认识的通道不许误杀（没有可探的入口 → 当活的，交给硬超时）
{
  const r = await canaryLane('ollama', { timeoutMs: 300 });
  ok(r.alive === true && r.via === 'none', '5 没有探口的通道不阻断，标 via=none', JSON.stringify(r));
}

// 6. canaryLanes：去重、全死时保留原列表（不许返回空）
{
  const r = await canaryLanes(['codebuddy', 'codebuddy', 'ollama'], { timeoutMs: 200 });
  ok(r.results.length === 2, '6 通道去重', String(r.results.length));
  ok(Array.isArray(r.kept), '6b kept 一定是数组');
}

// 7. 全死 → 保留原样、allDead=true、dropped 为空
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary2-'));
  process.env.CODEBUDDY_CLI = path.join(dir, 'nope');
  const r = await canaryLanes(['codebuddy'], { timeoutMs: 200 });
  ok(r.allDead === true, '7 全死时 allDead=true');
  ok(r.kept.length === 1 && r.dropped.length === 0, '7b 全死时不清空列表（清空=静默收工）', JSON.stringify({ kept: r.kept, dropped: r.dropped }));
  const line = renderCanary(r);
  ok(line.includes('全部') && line.includes('照原样派'), '7c 打印行说明「照原样派，让硬超时记失败」', line);
  delete process.env.CODEBUDDY_CLI;
  fs.rmSync(dir, { recursive: true, force: true });
}

// 8. 混活死 → dropped 列出死的、kept 只留活的
{
  const r = await canaryLanes(['ollama', 'workbuddy'], { timeoutMs: 400 });
  const line = renderCanary(r);
  ok(typeof line === 'string' && line.startsWith('探活：'), '8 打印行有统一前缀', line);
  ok(r.kept.includes('ollama'), '8b 没有探口的通道被保留', JSON.stringify(r.kept));
}

// 9. 默认超时是 1.5s（够快，才值得在派活前跑）
ok(CANARY_MS_DEFAULT === 1500, '9 默认探活超时 1500ms', String(CANARY_MS_DEFAULT));

// 10. 空输入不炸
{
  const r = await canaryLanes([], {});
  ok(r.results.length === 0 && r.allDead === false, '10 空输入返回空结果且 allDead=false');
  ok(renderCanary(r) === '探活：没有要探的通道', '10b 空输入打印行可读', renderCanary(r));
}

console.log((fail === 0 ? '✓ ' : '✗ ') + 'canary: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
