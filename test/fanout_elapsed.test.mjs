import assert from 'node:assert';
import { runFanout } from '../lib/fanout-run.mjs';

let pass = 0; let fail = 0;
const t = async (name, fn) => { try { await fn(); pass += 1; console.log('✓ ' + name); } catch (e) { fail += 1; console.log('✗ ' + name + ' —— ' + e.message); } };

// 2026-11-17 实测的错账：3 份产物全被机械闸门判死（EVIDENCE 为空），一次父审都没调，
// 却报「子会话 256.6s + 审查 256.6s」。这种账会让人去优化一个根本没跑的环节。
await t('全被机械闸门判死时，reviewMs 必须是 0（父审没跑就别记时间）', async () => {
  let reviewCalls = 0;
  const res = await runFanout({
    task: '说点什么',
    parts: 3,
    cwd: process.cwd(),
    ask: async (prompt) => {
      if (/你是父会话/.test(prompt)) { reviewCalls += 1; return { ok: true, addedText: '[]' }; }
      return { ok: true, addedText: '我觉得还行，没什么问题。' }; // 没有 ANSWER/EVIDENCE → 机械红
    },
  });
  assert.strictEqual(reviewCalls, 0, '父审不该被调');
  assert.strictEqual(res.elapsed.reviewMs, 0, 'reviewMs=' + res.elapsed.reviewMs);
  assert.ok(Number.isFinite(res.elapsed.childrenMs), '子会话时间要照记（假 ask 瞬时返回，数值可为 0，但不能是 undefined）');
});

await t('真调了父审时 reviewMs 必须非 0（不许一律记 0 掩盖）', async () => {
  const res = await runFanout({
    task: '说点什么',
    parts: 2,
    cwd: process.cwd(),
    reviewChunk: 2,
    ask: async (prompt) => {
      if (/你是父会话/.test(prompt)) {
        await new Promise((r) => setTimeout(r, 60));
        return { ok: true, addedText: JSON.stringify([{ id: 'child-1', verdict: 'PASS', reason: 'atwo.mjs:190 对得上' }, { id: 'child-2', verdict: 'PASS', reason: 'atwo.mjs:190 对得上' }]) };
      }
      return { ok: true, addedText: 'ANSWER: 有\nEVIDENCE: atwo.mjs:190 就是 EXIT 表' };
    },
  });
  assert.ok(res.elapsed.reviewMs >= 50, 'reviewMs=' + res.elapsed.reviewMs);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
