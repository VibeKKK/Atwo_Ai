// reviewAndFix 的分支行为测试。不碰真通道 —— 真通道验证靠那次手工 review（codebuddy 挑出 6 条真 bug）。
// 这里钉的是「流程逻辑」：什么时候返工、什么时候保留原文件、什么时候不能算通过。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pickReviewer, parseVerdict, reviewAndFix, reviewWithFallback } from '../lib/review.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-review-'));
const mkFile = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body, 'utf8'); return p; };

console.log('pickReviewer');
ok('trae 的评审者不是 trae', pickReviewer('trae') !== 'trae', pickReviewer('trae'));
ok('codebuddy 的评审者不是自己', pickReviewer('codebuddy') !== 'codebuddy');
ok('排除所有候选时返回 null', pickReviewer('codebuddy', { exclude: ['workbuddy', 'doubao', 'trae'] }) === null);

console.log('parseVerdict');
const a = parseVerdict('没发现实质问题\nVERDICT: ACCEPT');
ok('ACCEPT 解析', a.verdict === 'ACCEPT' && a.ok === true && a.noIssue === true);
const b = parseVerdict('**1. 越界**\n- 在哪：第 5 行\n- 怎么改：i < len\n**2. null 误判**\n- 在哪\nVERDICT: REVISE');
ok('REVISE 解析', b.verdict === 'REVISE' && b.ok === false);
ok('问题条数只数顶层编号（不是子项行数）', b.issues === 2, '拿到 ' + b.issues);
const c = parseVerdict('这段写得不错。');
ok('没有 VERDICT 时不当作通过', c.verdict === null && c.ok === false);
const d = parseVerdict('有点问题\nVERDICT: REVISE');
ok('REVISE 但一条问题没列 → weak', d.weak === true);

console.log('reviewAndFix 流程');
// 场景 1：ACCEPT → 不返工
{
  const f = mkFile('a.mjs', 'export const a = 1;\n'.repeat(10));
  const before = fs.readFileSync(f, 'utf8');
  let calls = [];
  const out = await reviewAndFix([{ id: 1, agent: 'trae', file: f }], {
    dispatch: async (kind, prompt, extra) => { calls.push(extra.agent); return { addedText: '没发现实质问题\nVERDICT: ACCEPT' }; },
  });
  ok('ACCEPT 只派 1 次（评审）', calls.length === 1, JSON.stringify(calls));
  ok('ACCEPT 不改进文件', fs.readFileSync(f, 'utf8') === before);
  ok('ACCEPT 记为通过', out[0].verdict === 'ACCEPT' && !out[0].fixed);
}
// 场景 2：REVISE → 返工一轮 → 再评 ACCEPT
{
  const f = mkFile('b.mjs', 'export const b = 1;\n'.repeat(12));
  let n = 0;
  const out = await reviewAndFix([{ id: 2, agent: 'trae', file: f }], {
    maxRounds: 1,
    dispatch: async (kind, prompt, extra) => {
      n++;
      if (extra.agent !== 'trae') return { addedText: n === 1 ? '**1. 常量太单调**\nVERDICT: REVISE' : '没发现实质问题\nVERDICT: ACCEPT' };
      return { addedText: 'export const b = 2;\n'.repeat(12) };  // 返工产物
    },
  });
  ok('REVISE 触发返工（派 3 次：评审→返工→复评）', n === 3, '实际 ' + n);
  ok('返工后文件被替换', fs.readFileSync(f, 'utf8').includes('b = 2'));
  ok('复评后裁决为 ACCEPT', out[0].verdict === 'ACCEPT');
  ok('记录了返工轮次', out[0].fixed && out[0].fixed.round === 1);
}
// 场景 3：REVISE 但返工拿回垃圾 → 保留原文件
{
  const f = mkFile('c.mjs', 'export const c = 1;\n'.repeat(12));
  const before = fs.readFileSync(f, 'utf8');
  let n = 0;
  const out = await reviewAndFix([{ id: 3, agent: 'trae', file: f }], {
    maxRounds: 1,
    dispatch: async (kind, prompt, extra) => {
      n++;
      if (extra.agent !== 'trae') return { addedText: '**1. 有问题**\nVERDICT: REVISE' };
      return { addedText: '好' };  // 垃圾，太短
    },
  });
  ok('返工拿到垃圾时保留原文件', fs.readFileSync(f, 'utf8') === before);
  ok('返工失败仍如实记 REVISE', out[0].verdict === 'REVISE');
  ok('返工失败不记 fixed', !out[0].fixed);
}
// 场景 4：没有异源评审者
{
  const f = mkFile('d.mjs', 'export const d = 1;\n'.repeat(10));
  let called = false;
  const out = await reviewAndFix([{ id: 4, agent: 'trae', file: f }], {
    exclude: ['codebuddy', 'workbuddy', 'doubao'],
    dispatch: async () => { called = true; return { addedText: 'x\nVERDICT: ACCEPT' }; },
  });
  ok('没有异源评审者时不派活', called === false);
  ok('没有异源评审者时不算通过', out[0].verdict === null && out[0].reason === 'no-reviewer');
}
// 场景 5：所有评审通道都抛错
{
  const f = mkFile('e.mjs', 'export const e = 1;\n'.repeat(10));
  let tries = 0;
  const out = await reviewAndFix([{ id: 5, agent: 'trae', file: f }], {
    dispatch: async () => { tries++; throw new Error('通道死了'); },
  });
  ok('评审通道抛错时不算通过', out[0].verdict === null && out[0].ok === false);
  ok('所有评审者都失败时标 unreviewed', out[0].reason === 'unreviewed');
  ok('确实依次试过每个异源评审者', tries === 3, '试了 ' + tries + ' 次');
}
// 场景 6：主评审者挂掉，降级到下一个成功
// 这条对应今天实测的故障：trae 260s 超时、workbuddy 589s 不回话。
// 环闭上之后评审是必经环节，一次掉线不能让整轮验收白跑。
{
  const f = mkFile('f.mjs', 'export const ff = 1;\n'.repeat(10));
  const order = [];
  const out = await reviewAndFix([{ id: 6, agent: 'codebuddy', file: f }], {
    dispatch: async (kind, prompt, extra) => {
      order.push(extra.agent);
      if (extra.agent === 'trae') throw new Error('超时 260s');
      return { addedText: '没发现实质问题\nVERDICT: ACCEPT' };
    },
  });
  ok('主评审者失败后换了下一个', order.length === 2, JSON.stringify(order));
  ok('降级后拿到了裁决', out[0].verdict === 'ACCEPT' && out[0].ok === true);
  ok('存档记的是真正出裁决的那个人', out[0].reviewer === 'workbuddy', out[0].reviewer);
}
// 场景 7：评审要求返工，但返工通道挂掉 —— 必须留痕，不能看起来像改好了
{
  const f = mkFile('g.mjs', 'export const g = 1;\n'.repeat(10));
  const out = await reviewAndFix([{ id: 7, agent: 'trae', file: f }], {
    maxRounds: 1,
    dispatch: async (kind, prompt, extra) => {
      if (extra.agent === 'trae') throw new Error('返工通道死了');
      return { addedText: '**1. 有问题**\nVERDICT: REVISE' };
    },
  });
  ok('返工没落地时标记 fix-failed', out[0].reason === 'fix-failed', out[0].reason);
  ok('返工没落地时不算通过', out[0].ok === false);
  ok('返工没落地时没有 fixed 记录', !out[0].fixed);
}

// reviewWithFallback：review 命令和 reviewAndFix 共用的那一条降级链。
// 它治的病是 2026-11-15 16:00 那次实测：codebuddy 240s + trae 260s 连续超时，
// 而 review 命令当时没有换人能力，闸门当场关死。
console.log('reviewWithFallback 降级链');
{
  const calls = [];
  const rr = await reviewWithFallback({
    prompt: 'p', summary: 's',
    candidates: ['codebuddy', 'trae', 'workbuddy'],
    dispatch: async (kind, prompt, extra) => {
      calls.push(extra.agent);
      if (extra.agent !== 'workbuddy') throw new Error('超时 240s');
      return { addedText: '没问题\nVERDICT: ACCEPT' };
    },
  });
  ok('前两个挂 → 第三个给裁决', rr.verdict === 'ACCEPT' && rr.reviewer === 'workbuddy', String(rr.reviewer));
  ok('试过名单按序记全', JSON.stringify(rr.tried) === JSON.stringify(['codebuddy', 'trae', 'workbuddy']), JSON.stringify(rr.tried));
  ok('换人成功时 ok=true 且没有理由', rr.ok === true && rr.reason === null);
}
{
  const rr = await reviewWithFallback({
    prompt: 'p', summary: 's',
    candidates: ['codebuddy', 'trae', 'workbuddy'],
    dispatch: async () => { throw new Error('全挂'); },
  });
  ok('全挂 → verdict 为 null', rr.verdict === null);
  ok('全挂 → ok=false 且 reason=unreviewed', rr.ok === false && rr.reason === 'unreviewed');
  ok('全挂 → 三个人都试过', rr.tried.length === 3);
  ok('全挂 → 不产生 reviewText（不能写存档冒充评过）', rr.reviewText === '');
}
{
  const rr = await reviewWithFallback({
    prompt: 'p', summary: 's', candidates: ['trae'],
    dispatch: async () => ({ addedText: '这段写得不错。' }),
  });
  ok('散文没有 VERDICT → 不算通过', rr.verdict === null && rr.ok === false && rr.reason === 'unreviewed');
}
{
  const rr = await reviewWithFallback({
    prompt: 'p', summary: 's', candidates: ['trae'],
    dispatch: async () => ({ addedText: '**1. 越界**\nVERDICT: REVISE' }),
  });
  ok('REVISE 是有结论的失败，不是没评成', rr.verdict === 'REVISE' && rr.ok === false && rr.reason === null);
}
{
  let calls = 0;
  const rr = await reviewWithFallback({
    prompt: 'p', summary: 's', candidates: [],
    dispatch: async () => { calls++; return { addedText: 'VERDICT: ACCEPT' }; },
  });
  ok('无候选 → 一次都不派', calls === 0 && rr.ok === false && rr.reason === 'unreviewed');
}
{
  const src = fs.readFileSync(new URL('../lib/review.mjs', import.meta.url), 'utf8');
  ok('降级循环全仓只有一份', (src.match(/for \(const cand of/g) || []).length === 1);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
