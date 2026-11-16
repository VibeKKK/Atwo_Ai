// test/fanout_review_lane.test.mjs —— 异源父审：谁审的必须留痕，取不到通道必须炸。
// 为什么单独立一个文件（2026-11-16）：这一条改的是「同源/异源」这个结论的分母。
// 之前主力与父审都是 codebuddy（同源），但产物里没有任何字段能回答「这份结论是谁审的」——
// 于是读产物的人只能假设它是异源的，这就是最难查的假象。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout } from '../lib/fanout-run.mjs';
import { resolveAsk } from '../lib/lanes.mjs';

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

console.log('fanout reviewLane');

const childAsk = async () => ({ ok: true, addedText: 'ANSWER:\n答案\nEVIDENCE:\natwo.mjs:190 const EXIT' });
const reviewAsk = (tag) => async () => ({ ok: true, addedText: JSON.stringify({ reviews: [{ id: 'child-1', verdict: 'PASS', why: 'w' }, { id: 'child-2', verdict: 'PASS', why: 'w' }] }), tag });

await ta('注入 reviewAsk 时 reviewLane 标 injected，不与主力同源', async () => {
  const r = await runFanout({ task: 't', parts: 2, ask: childAsk, reviewAsk: reviewAsk('x'), preGate: false, reviewChunk: 0 });
  assert.equal(r.writerLane, 'injected');
  assert.equal(r.reviewLane, 'injected');
  assert.equal(r.homogeneous, true, '注入了同一个 ask 就算同源 —— 不能因为它是测试就谎称异源');
});

await ta('显式 --review-lane trae：reviewLane 记 trae，homogeneous=false', async () => {
  const r = await runFanout({ task: 't', parts: 2, ask: childAsk, reviewLane: 'trae', reviewAsk: reviewAsk('trae'), preGate: false, reviewChunk: 0 });
  assert.equal(r.reviewLane, 'trae');
  assert.equal(r.homogeneous, false);
});

await ta('reviewLane 指向不存在的通道要抛错，不静默退回 codebuddy', async () => {
  await assert.rejects(
    () => runFanout({ task: 't', parts: 1, ask: childAsk, reviewLane: 'nope', preGate: false, reviewChunk: 0 }),
    /没有这个通道/,
  );
});

await ta('默认（不指定 reviewLane、不注入）父审是 codebuddy → 同源，必须如实标出来', async () => {
  const saved = resolveAsk('codebuddy');
  assert.equal(typeof saved, 'function');
});

await ta('产物里落 reviewLane 与 homogeneous', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-lane-'));
  const r = await runFanout({ task: 't', parts: 2, ask: childAsk, reviewLane: 'workbuddy', reviewAsk: reviewAsk('w'), preGate: false, reviewChunk: 0 });
  const { finishFanout } = await import('../lib/fanout-run.mjs');
  const file = finishFanout(r, dir);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /- 父审: workbuddy（异源）/, '父审通道要是一眼可见的字段，不是只躺在 meta JSON 里');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
