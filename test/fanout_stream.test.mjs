import assert from 'node:assert/strict';
import { runFanout } from '../lib/fanout-run.mjs';

// 流式送审 + 投机重发（2026-11-17）
//
// 为什么要测这两件：
//  · 流式：父审是固定成本（3 份一片 14–38s），原先要等最慢那一路回来才开始，
//    等于把「子会话时间」和「父审时间」串成一根绳。谁先回来谁先送审，两者才能重叠。
//  · 投机重发：机械闸门（pregate）判死的产物是可判定的失败 —— 等父审 14–20s
//    再判 REVISE 再重做，等于为一个已经知道的结果排队。
// 两件都必须能在注入 ask 的情况下验证，否则只能靠真跑，回归就跑不起了。

let pass = 0, fail = 0;
const cases = [];
const it = (n, f) => cases.push([n, f]);

const OK = 'ANSWER: ok\nEVIDENCE: atwo.mjs:190';
const NO_EVIDENCE = 'ANSWER: 我觉得是这样，但没有给证据';

// 默认父审：把提示里出现的 id 全判 PASS（
// 不写这个默认值的话，注入 ask 的测试永远得到 unreviewed —— 那不是被测行为，是测试自己没交卷）。
function defaultReview(prompt) {
  const ids = [...new Set([...prompt.matchAll(/id: ([A-Za-z0-9-]+)/g)].map((m) => m[1]))];
  return JSON.stringify(ids.map((id) => ({ id, verdict: 'PASS', reason: '实读核对一致' })));
}

// fake ask：按提示词区分「子会话」与「父审」，各自记录到达/开始时间
function makeFake(opts = {}) {
  const log = { child: [], review: [], resendNotes: [] };
  const t0 = Date.now();
  const ask = async (prompt, o) => {
    const isReview = prompt.includes('你是父会话');
    const at = Date.now() - t0;
    if (isReview) {
      log.review.push({ at });
      const out = typeof opts.review === 'function' ? opts.review(prompt) : (opts.review || defaultReview(prompt));
      await new Promise((r) => setTimeout(r, opts.reviewMs || 5));
      return { ok: true, addedText: out };
    }
    const nth = log.child.length;
    log.child.push({ at, prompt });
    if (/上一轮被打回/.test(prompt)) log.resendNotes.push(prompt);
    await new Promise((r) => setTimeout(r, (opts.childMs || 10) + nth * (opts.stagger || 0)));
    log.child[log.child.length - 1].doneAt = Date.now() - t0;
    const out = typeof opts.child === 'function' ? opts.child({ nth, prompt, o }) : OK;
    if (out === null) return { ok: false, err: '通道挂了' };
    return { ok: true, addedText: out };
  };
  return { ask, log };
}

it('流式：第一片父审在最后一路回来之前就发出（不再等最慢那路）', async () => {
  const seq = [];
  const fake = makeFake({ childMs: 20, stagger: 15, reviewMs: 10 });
  await runFanout({
    task: 't', parts: 6, cwd: process.cwd(), ask: fake.ask,
    onProgress: (e) => { if (e.phase === 'child-done' || e.phase === 'review-chunk-done') seq.push(e.phase + ':' + (e.id || e.done)); },
    // 3 份一片：第 3 路回来时第一片就该发出去
  });
  // 断言：第一片父审的开始时间 < 最后一路子会话的完成时间
  const lastChildDone = Math.max(...fake.log.child.map((c) => c.doneAt || c.at));
  const firstReviewStart = fake.log.review[0] && fake.log.review[0].at;
  assert.ok(firstReviewStart < lastChildDone, '第一片父审应在最后一路回来之前发出（review ' + firstReviewStart + 'ms vs lastChild ' + lastChildDone + 'ms）');
  assert.equal(fake.log.review.length, 2, '6 份 3 一片应派 2 次父审');
});

it('投机重发：机械红（无证据）立即带机械理由重发一次，并用重发产物', async () => {
  let firstPass = 0;
  const fake = makeFake({ childMs: 5, child: ({ prompt }) => {
    firstPass += 1;
    if (firstPass <= 2) return NO_EVIDENCE; // 前两路第一次都没证据
    return OK;
  } });
  const r = await runFanout({ task: 't', parts: 2, cwd: process.cwd(), ask: fake.ask });
  // 2 路 × (首次 + 重发) = 4 次子会话调用
  assert.equal(fake.log.child.length, 4, '两路机械红应各重发一次');
  assert.equal(fake.log.resendNotes.length, 2, '重发提示必须带父批注（机械理由），否则重发等于重抽奖');
  assert.match(fake.log.resendNotes[0], /机械闸门/);
  assert.equal(r.summary.state, 'ACCEPT');
  assert.ok(r.children.every((c) => c.speculative === true), '重发回来的产物要留痕（speculative）');
});

it('重发只做一次：两次都机械红就认命，记 mech，不再烧第三次', async () => {
  const fake = makeFake({ childMs: 3, child: () => NO_EVIDENCE });
  const r = await runFanout({ task: 't', parts: 2, cwd: process.cwd(), ask: fake.ask });
  assert.equal(fake.log.child.length, 4, '两路各 2 次（首发 + 一次重发），不许循环重试');
  assert.equal(r.summary.preGate.mech, 2);
  assert.equal(fake.log.review.length, 0, '机械红不许送父审（那是纯浪费）');
});

it('通道自己失败（ok:false）不重发 —— 那是环境问题，重发只是再等一遍', async () => {
  const fake = makeFake({ childMs: 3, child: () => null });
  await runFanout({ task: 't', parts: 2, cwd: process.cwd(), ask: fake.ask });
  assert.equal(fake.log.child.length, 2, '通道失败不该触发投机重发');
});

it('speculativeResend:false 能整体关掉（离线/省钱场景）', async () => {
  const fake = makeFake({ childMs: 3, child: () => NO_EVIDENCE });
  const r = await runFanout({ task: 't', parts: 2, cwd: process.cwd(), ask: fake.ask, speculativeResend: false });
  assert.equal(fake.log.child.length, 2);
  assert.equal(r.summary.preGate.mech, 2);
});

it('reviewChunk 0（全局一片）时不流式：唯一一次父审必须在全部回齐之后', async () => {
  const fake = makeFake({ childMs: 10, stagger: 10, reviewMs: 5 });
  await runFanout({ task: 't', parts: 3, cwd: process.cwd(), ask: fake.ask, reviewChunk: 0 });
  assert.equal(fake.log.review.length, 1);
  const lastChild = Math.max(...fake.log.child.map((c) => c.doneAt || c.at));
  assert.ok(fake.log.review[0].at >= lastChild, '全局一片语义必须等齐（跨产物矛盾才能看见）');
});

it('elapsed 里 childrenMs 记的是子会话阶段，不是 0（流式后 t1-t0 已经不成立）', async () => {
  const fake = makeFake({ childMs: 30 });
  const r = await runFanout({ task: 't', parts: 2, cwd: process.cwd(), ask: fake.ask });
  assert.ok(r.elapsed.childrenMs >= 20, 'childrenMs 应该是子会话阶段真耗时，实际 ' + r.elapsed.childrenMs);
  assert.ok(r.elapsed.reviewMs >= 0);
});

for (const [name, fn] of cases) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);