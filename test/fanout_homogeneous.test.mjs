// test/fanout_homogeneous.test.mjs —— 「同源 / 异源」这个标签本身必须是对的。
// 2026-11-17 实测：旧写法 `homogeneous: reviewLane === (planned ? 'planned' : ...)` 恒为 false，
// 把 8 次同源跑全印成「（异源）」—— 读产物的人会以为有人交叉核过，这是最难查的假象。
import assert from 'node:assert';
import fs from 'node:fs';
import { runFanout } from '../lib/fanout-run.mjs';

const childAsk = async () => ({ ok: true, addedText: 'ANSWER:\n答案\nEVIDENCE:\natwo.mjs:190 const EXIT' });
// 探活要注入，不许让单元测试去 spawn 真实通道：`lanes: ['codebuddy']` 一旦走真解析，
// 每次用例都要付一次通道探测（本机实测 30–100s，负载下直接超时判红）。
// 这个测试要验的是「同源/异源这个标签算得对不对」，与通道能不能起来无关。
const PROBES = [{ lane: 'codebuddy', ready: true, parallel: 6, quality: 'high', roles: ['writer', 'review'] }];
const reviewAskOf = (tag) => async () => ({ ok: true, addedText: JSON.stringify({ reviews: [{ id: 'child-1', verdict: 'PASS', why: 'w' }, { id: 'child-2', verdict: 'PASS', why: 'w' }] }), tag });

let pass = 0, fail = 0;
async function ta(name, fn) { try { await fn(); pass += 1; console.log('  ✓ ' + name); } catch (e) { fail += 1; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); } }
console.log('fanout homogeneous');

await ta('注入同一个 ask 当写手与父审 → 同源', async () => {
  const r = await runFanout({ task: 't', parts: 2, ask: childAsk, reviewAsk: reviewAskOf('x'), preGate: false, reviewChunk: 0 });
  assert.strictEqual(r.writerLane, 'injected');
  assert.strictEqual(r.homogeneous, true);
});

await ta('编队写手是真实通道、父审是注入的另一源 → 异源', async () => {
  const r = await runFanout({ task: 't', parts: 2, lanes: ['codebuddy'], autoLanes: false, probes: PROBES, ask: childAsk, reviewAsk: reviewAskOf('x'), preGate: false, reviewChunk: 0 });
  assert.strictEqual(r.homogeneous, false, '写手与父审不是同一来源时不许标同源');
});

await ta('writerLane 记真实通道，不再写 planned 占位符', async () => {
  const r = await runFanout({ task: 't', parts: 2, lanes: ['codebuddy'], autoLanes: false, probes: PROBES, ask: childAsk, reviewAsk: reviewAskOf('x'), preGate: false, reviewChunk: 0 });
  assert.notStrictEqual(r.writerLane, 'planned');
  assert.ok(String(r.writerLane).includes('codebuddy'));
});

await ta('源码里不许再出现 planned 参与同源判定', async () => {
  const src = fs.readFileSync(new URL('../lib/fanout-run.mjs', import.meta.url), 'utf8');
  assert.ok(!/homogeneous:\s*reviewLane === \(planned/.test(src), '旧的占位符比较会把同源判成异源');
  assert.ok(/writerLanes/.test(src));
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
