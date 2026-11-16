import assert from 'node:assert/strict';
import { runFanout } from '../lib/fanout-run.mjs';

let pass = 0, fail = 0;
const it = (name, fn) => { try { const r = fn(); if (r && r.then) return r.then(() => { pass++; console.log('  ok  ' + name); }, (e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };

// 假 ask：第一轮 child-2 答错、父判它 REVISE；第二轮它改对了，父全 PASS。
function makeAsk() {
  const seen = { childPrompts: [], reviewPrompts: [], calls: 0 };
  const ask = async (prompt) => {
    seen.calls++;
    if (/你是父会话/.test(prompt)) {
      seen.reviewPrompts.push(prompt);
      const n = seen.reviewPrompts.length;
      if (n === 1) {
        return { ok: true, addedText: '[{"id":"child-1","verdict":"PASS","reason":"对，行号可核对"},{"id":"child-2","verdict":"REVISE","reason":"漏了 budget=6"},{"id":"child-3","verdict":"PASS","reason":"对"}]' };
      }
      return { ok: true, addedText: '[{"id":"child-1","verdict":"PASS","reason":"对"},{"id":"child-2","verdict":"PASS","reason":"已补 budget=6，实读核对"},{"id":"child-3","verdict":"PASS","reason":"对"}]' };
    }
    seen.childPrompts.push(prompt);
    if (/漏了 budget=6/.test(prompt)) {
      return { ok: true, addedText: 'ANSWER:\n六个，含 budget=6\nEVIDENCE:\natwo.mjs:190' };
    }
    if (/这是第 2 \//.test(prompt)) {
      return { ok: true, addedText: 'ANSWER:\n五个：ok/usage/precondition/accept/channel\nEVIDENCE:\natwo.mjs:190-195（grep 常量段）' };
    }
    return { ok: true, addedText: 'ANSWER:\n六个\nEVIDENCE:\natwo.mjs:190' };
  };
  return { ask, seen };
}

await it('fixRounds=1：被判 REVISE 的子会话带批注重做，第二轮转绿', async () => {
  const { ask, seen } = makeAsk();
  const res = await runFanout({ task: 'EXIT 有几个码', parts: 3, cwd: process.cwd(), fixRounds: 1, ask });
  assert.equal(res.elapsed.rounds, 2, '应该跑了两轮');
  assert.equal(res.summary.value, 1, '第二轮应放行');
  assert.equal(res.summary.state, 'ACCEPT');
  const retried = res.children.filter((c) => c.retried);
  assert.equal(retried.length, 1, '只有 child-2 被重做');
  assert.equal(retried[0].id, 'child-2');
  assert.equal(retried[0].prevAnswer.includes('五个'), true, '重做的那条要留着上一轮的答案，便于复判');
  assert.ok(seen.childPrompts.some((p) => /漏了 budget=6/.test(p)), '父的批注必须真的注入子提示');
});

await it('fixRounds=0（默认）：判了 REVISE 也不重做，不偷偷多花钱', async () => {
  const { ask } = makeAsk();
  const res = await runFanout({ task: 'EXIT 有几个码', parts: 3, cwd: process.cwd(), ask });
  assert.equal(res.elapsed.rounds, 1);
  assert.equal(res.summary.value, -1, '仍是 REVISE');
  assert.equal(res.children.filter((c) => c.retried).length, 0);
});

await it('全 PASS 时不进自愈回路（省一次全量重派）', async () => {
  const ask = async (prompt) => /你是父会话/.test(prompt)
    ? { ok: true, addedText: '[{"id":"child-1","verdict":"PASS","reason":"ok"},{"id":"child-2","verdict":"PASS","reason":"ok"},{"id":"child-3","verdict":"PASS","reason":"ok"}]' }
    : { ok: true, addedText: 'ANSWER:\nA\nEVIDENCE:\natwo.mjs:190' };
  const res = await runFanout({ task: 'q', parts: 3, cwd: process.cwd(), fixRounds: 2, ask });
  assert.equal(res.elapsed.rounds, 1);
  assert.equal(res.summary.value, 1);
});

await it('重做后仍判 REVISE 时，汇总跟着第二轮走（不虚报通过）', async () => {
  const ask = async (prompt) => /你是父会话/.test(prompt)
    ? { ok: true, addedText: '[{"id":"child-1","verdict":"PASS","reason":"ok"},{"id":"child-2","verdict":"REVISE","reason":"还是错"},{"id":"child-3","verdict":"PASS","reason":"ok"}]' }
    : { ok: true, addedText: 'ANSWER:\nA\nEVIDENCE:\natwo.mjs:190' };
  const res = await runFanout({ task: 'q', parts: 3, cwd: process.cwd(), fixRounds: 1, ask });
  assert.equal(res.elapsed.rounds, 2);
  assert.equal(res.summary.value, -1);
  assert.equal(res.rounds.length, 2);
  assert.equal(res.rounds[1].summary.value, -1, '第二轮仍 REVISE');
});

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
