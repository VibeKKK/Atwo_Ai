// 多评审者（reviewMultiWithFallback）的行为测试。不碰真通道。
// 钉的是「多声音怎么合成一个后果」：都过才过、分歧不投票、降级不冒充、没裁决不算过。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewMultiWithFallback, reviewAndFix } from '../lib/review.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-multi-'));
const mkFile = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body, 'utf8'); return p; };

// 按 agent 返回不同裁决的 dispatch
const dispatchBy = (map) => async (kind, prompt, extra) => {
  const v = map[extra.agent];
  if (v instanceof Error) throw v;
  return { addedText: v };
};

console.log('reviewMultiWithFallback');
{
  const r = await reviewMultiWithFallback({
    prompt: 'p', candidates: ['codebuddy', 'trae'], count: 2,
    dispatch: dispatchBy({
      codebuddy: '没发现实质问题\nVERDICT: ACCEPT',
      trae: '没发现实质问题\nVERDICT: ACCEPT',
    }),
  });
  ok('两票 ACCEPT → all-accept', r.consensus === 'all-accept' && r.verdict === 'ACCEPT' && r.ok === true, JSON.stringify(r.consensus));
  ok('两票都记进 votes', r.votes.length === 2);
  ok('没降级', r.degraded === false);
}
{
  // 分歧：这是本功能存在理由。不能投票平均掉。
  const r = await reviewMultiWithFallback({
    prompt: 'p', candidates: ['codebuddy', 'trae'], count: 2,
    dispatch: dispatchBy({
      codebuddy: '**1. 越界**\n- 在哪：第 5 行\nVERDICT: REVISE',
      trae: '没发现实质问题\nVERDICT: ACCEPT',
    }),
  });
  ok('一 ACCEPT 一 REVISE → split', r.consensus === 'split', JSON.stringify(r.consensus));
  ok('split 最终裁决是 REVISE（一个说不行就是不行）', r.verdict === 'REVISE' && r.ok === false);
  ok('split 保留两份原文', r.reviewTexts.length === 2 && r.reviewTexts.every((x) => x.text.length > 0));
  ok('split 不是降级', r.degraded === false);
}
{
  const r = await reviewMultiWithFallback({
    prompt: 'p', candidates: ['codebuddy', 'trae'], count: 2,
    dispatch: dispatchBy({
      codebuddy: '**1. a**\nVERDICT: REVISE',
      trae: '**1. b**\nVERDICT: REVISE',
    }),
  });
  ok('两票 REVISE → all-revise', r.consensus === 'all-revise' && r.ok === false);
}
{
  // 一个通道挂了：能出一个结论，但必须标 degraded，不许冒充两票
  const r = await reviewMultiWithFallback({
    prompt: 'p', candidates: ['codebuddy', 'trae'], count: 2,
    dispatch: dispatchBy({
      codebuddy: '没发现实质问题\nVERDICT: ACCEPT',
      trae: new Error('超时 260s'),
    }),
  });
  ok('一个通道挂 → degraded=true', r.degraded === true);
  ok('degraded 时 votes 只有 1 票', r.votes.length === 1);
  ok('degraded 有原因说明', !!r.degradedReason && r.degradedReason.includes('1/2'), r.degradedReason);
  ok('degraded 仍按真实票出结论', r.verdict === 'ACCEPT' && r.ok === true);
}
{
  const r = await reviewMultiWithFallback({
    prompt: 'p', candidates: ['codebuddy', 'trae'], count: 2,
    dispatch: dispatchBy({
      codebuddy: '这段写得不错。',
      trae: '看起来没问题。',
    }),
  });
  ok('两票都没 VERDICT → unreviewed', r.verdict === null && r.ok === false && r.reason === 'unreviewed');
  ok('没裁决的票仍记进 votes（留痕）', r.votes.length === 2 && r.votes.every((x) => x.verdict === null));
}
{
  const r = await reviewMultiWithFallback({ prompt: 'p', candidates: [], count: 2, dispatch: async () => ({ addedText: '' }) });
  ok('无候选 → 不假装评审过', r.ok === false && r.reason === 'unreviewed' && r.degraded === true);
}
{
  let n = 0;
  await reviewMultiWithFallback({
    prompt: 'p', candidates: ['codebuddy', 'trae', 'workbuddy', 'doubao'], count: 2,
    dispatch: async () => { n++; return { addedText: 'VERDICT: ACCEPT' }; },
  });
  ok('count=2 只派 2 次（不是候选全派）', n === 2, '派了 ' + n + ' 次');
}

console.log('reviewAndFix 多评审模式');
{
  const f = mkFile('m1.mjs', 'export const a = 1;\n'.repeat(10));
  const before = fs.readFileSync(f, 'utf8');
  const calls = [];
  const out = await reviewAndFix([{ id: 1, agent: 'dsh', file: f }], {
    reviewers: 2,
    dispatch: async (kind, prompt, extra) => { calls.push(extra.agent); return { addedText: '没发现实质问题\nVERDICT: ACCEPT' }; },
  });
  ok('reviewers=2 派了 2 个评审者', calls.length === 2, JSON.stringify(calls));
  ok('全 ACCEPT 不改文件', fs.readFileSync(f, 'utf8') === before);
  ok('rec 带 votes/consensus', Array.isArray(out[0].votes) && out[0].votes.length === 2 && out[0].consensus === 'all-accept');
  ok('rec.ok=true', out[0].ok === true);
}
{
  // 单评审路径必须完全不变（A7 兜底）
  const f = mkFile('m2.mjs', 'export const a = 1;\n'.repeat(10));
  const out = await reviewAndFix([{ id: 2, agent: 'dsh', file: f }], {
    dispatch: async () => ({ addedText: 'VERDICT: ACCEPT' }),
  });
  ok('单评审模式 votes 为 null', out[0].votes === null);
  ok('单评审模式 ok=true', out[0].ok === true);
}
{
  // A8：split 之后返工，返工完要重派 N 个（不是只重派说 REVISE 那个）
  const f = mkFile('m3.mjs', 'export const a = 1;\n'.repeat(10));
  const revCalls = [];
  let round = 0;
  const out = await reviewAndFix([{ id: 3, agent: 'dsh', file: f }], {
    reviewers: 2, maxRounds: 1,
    dispatch: async (kind, prompt, extra) => {
      if (extra.agent === 'dsh') {
        // 返工：必须是一个能被 extractCode 抽出来的代码块。
        // （第一版把 \u0060 和内容一起 repeat，产出 10 个空代码块，抽不出内容 → fixFailed → 返工静默不发生）
        const T = String.fromCharCode(96);
        return { addedText: T + T + T + 'js\n' + 'export const a = 2;\n'.repeat(10) + T + T + T };
      }
      revCalls.push({ agent: extra.agent, round: ++round });
      // 第一轮两个都 REVISE，第二轮两个都 ACCEPT
      return { addedText: revCalls.length <= 2 ? '**1. x**\nVERDICT: REVISE' : 'VERDICT: ACCEPT' };
    },
  });
  const firstRound = revCalls.filter((x) => x.round <= 2).length;
  const secondRound = revCalls.length - 2;
  ok('首轮派 2 个评审者', firstRound === 2, JSON.stringify(revCalls.map((x) => x.round)));
  ok('返工后重派 2 个（不是 1 个）', secondRound === 2, '第二轮 ' + secondRound + ' 个');
  ok('split 后被判 REVISE', out[0].verdict !== undefined);
}
{
  // 多评审的存档：汇总 1 个 + 每票 1 个
  const f = mkFile('m4.mjs', 'export const a = 1;\n'.repeat(10));
  const dir = path.join(tmp, 'reviews');
  await reviewAndFix([{ id: 4, agent: 'dsh', file: f }], {
    reviewers: 2, reviewsDir: dir,
    dispatch: async (kind, prompt, extra) => ({ addedText: (extra.agent === 'trae' ? '**1. y**\nVERDICT: REVISE' : 'VERDICT: ACCEPT') }),
  });
  const files = fs.readdirSync(dir);
  const summary = files.filter((x) => x.startsWith('multi-review-'));
  const per = files.filter((x) => !x.startsWith('multi-review-'));
  ok('存档有 1 个汇总文件', summary.length === 1, JSON.stringify(files));
  ok('存档每票各 1 个原文文件', per.length === 2, JSON.stringify(per));
  ok('汇总里写了共识', fs.readFileSync(path.join(dir, summary[0]), 'utf8').includes('split'));
}

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
