// atwo review —— 对已有的 fanout 目录补做一次父审，可以排进队列用 GUI 通道慢慢跑。
//
// 为什么需要它：GUI 通道（trae/workbuddy/doubao）单窗口独占、一次 28–190s，放在前台会把整条流水线拖住。
// 有它就能「先收产物、立刻继续干活」，把父审当后台作业交给 supervisor（或 atwo pool）去做。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseChildOutput, buildReviewPrompt, parseReview, VERDICT } from './fanout.mjs';
import { preGateAll, collectRefs } from './pregate.mjs';

/** 从一个 fanout 目录里读回所有 child-*.md（按 id 排序），解析成父审需要的形状。 */
export function readChildren(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return { ok: false, reason: 'no-dir: ' + abs, children: [] };
  const ids = fs.readdirSync(abs)
    .filter((n) => /^child-\d+\.md$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  if (!ids.length) return { ok: false, reason: 'no-child-artifacts', children: [] };
  const children = ids.map((n) => {
    const o = parseChildOutput(fs.readFileSync(path.join(abs, n), 'utf8'));
    return { id: n.replace(/\.md$/, ''), answer: o.answer, evidence: o.evidence, raw: n };
  });
  return { ok: true, children, dir: abs };
}

/** 纯逻辑：拿现成产物跑一遍机械闸门 + 父审，返回票与要落盘的内容。ask 可注入（测试用）。 */
export async function reviewDir(dir, { ask, cwd, task = '', note = null, timeoutMs = 300000 } = {}) {
  const read = readChildren(dir);
  if (!read.ok) return { ok: false, reason: read.reason, votes: [] };
  if (typeof ask !== 'function') return { ok: false, reason: 'no-ask', votes: [] };
  const rawDir = path.resolve('.'); // 引用核对用当前仓库
  const kids = read.children.map((c) => ({ id: c.id, answer: c.answer, evidence: c.evidence }));
  const mech = preGateAll(kids, { cwd: cwd || rawDir });
  const mechVotes = (mech.reviews || []).filter((r) => r && r.verdict && r.verdict !== VERDICT.none);
  const already = new Set(mechVotes.map((r) => r.id));
  const need = kids.filter((k) => !already.has(k.id));
  let llmVotes = [];
  let reviewed = 0;
  if (need.length) {
    const refsText = collectRefs(need, { cwd: cwd || rawDir }).text;
    const prompt = buildReviewPrompt(task || '（补审：原始任务没写在目录里）', need, note, refsText);
    const r = await ask(prompt, { timeoutMs });
    const text = String((r && (r.text || r.out || r.addedText)) || '');
    llmVotes = parseReview(text, need.map((k) => k.id));
    reviewed = llmVotes.length;
  }
  const votes = [...mechVotes, ...llmVotes];
  const body = votes.map((v) => '- ' + v.id + '  ' + v.verdict + (v.reason ? ' —— ' + v.reason : '')).join('\n');
  return {
    ok: true,
    votes,
    mechCount: mechVotes.length,
    llmCount: llmVotes.length,
    digest: createHash('sha256').update(JSON.stringify(votes)).digest('hex').slice(0, 16),
    markdown: '# 异步父审\n\n机械闸门 ' + mechVotes.length + ' 票 · 父审 ' + llmVotes.length + ' 票（' + reviewed + '/' + need.length + '）\n\n' + body + '\n',
  };
}

export function makeReviewVerb({ EXIT, RESULT, HERE, die, resolveAsk }) {
  return async function cmdReview(argv) {
    const opt = (n) => {
      const i = argv.indexOf(n);
      if (i < 0) return null;
      const v = argv[i + 1];
      return v && !String(v).startsWith('--') ? v : '';
    };
    const dir = opt('--dir') || opt('--fanout');
    if (!dir) die('用法：atwo review --dir .atw/fanout/<时间戳> [--lane workbuddy] [--task "原任务"]', EXIT.usage);
    const lane = opt('--lane') || 'codebuddy';
    const task = opt('--task') || '';
    const timeoutMs = Number(opt('--timeout')) || 300000;
    let ask;
    try {
      ask = resolveAsk(lane);
    } catch (e) {
      die('这个通道用不了：' + (e && e.message), EXIT.channel);
    }
    const r = await reviewDir(dir, { ask, cwd: HERE, task, timeoutMs });
    if (!r.ok) die('补审没做成：' + r.reason, EXIT.precondition);
    const outMd = path.join(path.resolve(dir), 'REVIEW-ASYNC.md');
    fs.writeFileSync(outMd, r.markdown, 'utf8');
    fs.writeFileSync(path.join(path.resolve(dir), 'REVIEW-ASYNC.json'), JSON.stringify({ lane, digest: r.digest, votes: r.votes }, null, 2) + '\n', 'utf8');
    RESULT.data = { lane, digest: r.digest, votes: r.votes, mech: r.mechCount, llm: r.llmCount, wrote: outMd };
    console.log('补审完成（' + lane + '）· 机械 ' + r.mechCount + ' 票 · 父审 ' + r.llmCount + ' 票');
    for (const v of r.votes) console.log('  ' + v.id + '  ' + v.verdict + (v.reason ? ' —— ' + String(v.reason).slice(0, 120) : ''));
    console.log('写入：' + outMd);
    return r.votes.some((v) => v.verdict === VERDICT.revise) ? EXIT.accept : EXIT.ok;
  };
}
