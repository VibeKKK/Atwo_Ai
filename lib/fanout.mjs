// lib/fanout.mjs —— 父会话 / 子会话：一个父派 N 个子干，子不看彼此，父逐个审。
// 设计约束（都是实测逼出来的，别改）：
//   1. 子会话必须独立上下文 —— 共享上下文等于一条会话，切了没有意义。
//   2. 父会话只做三件事：切分、审、汇总。父不代替子干活（父干活时子就白跑了）。
//   3. 审查结果必须是机器码（PASS / REVISE），不接受「看起来不错」这种人话。
//   4. 子产物先落盘再审 —— 内存里的东西审完就没了，无法复判。
import fs from 'node:fs';
import path from 'node:path';

export const VERDICT = { pass: 'PASS', revise: 'REVISE', none: 'unreviewed' };

/** 子任务描述：每个子会话只拿到自己那一条 + 共通约束，彼此不知道对方存在。 */
export function buildChildPrompt(task, index, total, note) {
  return [
    `你在为一个父会话干活。这是第 ${index + 1} / ${total} 个子任务，你看不到其他子任务，也不需要问它们。`,
    '',
    '## 任务',
    task,
    ...(note ? ['', '## 上一轮被打回，父会话的理由（必须消除它，不要辩解）', String(note).trim(), '', '这一轮要求：关键结论必须自己去读源码核对，EVIDENCE 写出你实际读到的原文。'] : []),
    '',
    '## 输出格式（严格照抄标签，父会话按标签解析，格式不对等于没交）',
    'ANSWER:',
    '<结论，一到三行，能给数字就给数字>',
    'EVIDENCE:',
    '<你是从哪个文件的哪一行/跑了什么命令看出来的>',
    '',
    '## 纪律',
    '- 不确定就写「不确定（原因）」，不要编数字。编错的答案比不答更贵。',
    '- 只回答任务问的，不要顺手改代码、不要写文件。',
  ].join('\n');
}

/** 父会话的审查提示：拿到全部子产物，逐个判 PASS / REVISE。 */
export function buildReviewPrompt(task, children, note, refsText, impactText) {
  // 编队后产物来自不同通道：云端高质与本地 8B 粗活的可信度不同，父审必须知道来源。
  const laneTag = (c) => {
    const l = c && c.lane;
    if (!l) return '';
    const weak = l === 'ollama' ? '，本地小模型，可信度低 → 重点核对 EVIDENCE' : '';
    return '（通道：' + l + weak + '）';
  };
  // 父审提示会被当作命令行参数或 stdio 传递，长到一定程度就既贵又超限（Windows 单条命令约 32767 字符）。
  // 只截「交付正文」，且明确写着截了多少字 —— 让父审知道有东西被截了，不要据此判 PASS。
  const CAP_ANSWER = 3000;
  const CAP_EVIDENCE = 2500;
  const cut = (s, cap) => {
    const x = String(s || '');
    if (x.length <= cap) return x;
    return x.slice(0, cap) + `\n…（此处截断，原文另有 ${x.length - cap} 字没显示；不要因为看不到就判 PASS）`;
  };
  const body = children.map((c, i) => [
    `### 子会话 #${i + 1}（id: ${c.id}）${laneTag(c)}`,
    'ANSWER: ' + (cut(c.answer, CAP_ANSWER) || '(空)'),
    'EVIDENCE: ' + (cut(c.evidence, CAP_EVIDENCE) || '(空)'),
  ].join('\n')).join('\n\n');
  return [
    '你是父会话，只做审查，不要重做任务。',
    '',
    '## 原始任务',
    task,
    '',
    '## 子会话交上来的东西',
    body,
    '',
    ...(String(refsText || '').trim()
      ? [
        '## 有人已经替你把被引用的行读好了（下方原文即真实文件内容）',
        '先拿 EVIDENCE 跟这里的原文比对：引用的行号下根本不是你声称的内容 = 证据捏造，直接 REVISE。',
        '这里面没列到的行，你仍然必须自己 Read 核对。',
        '但已经列在下面的行，不要再 Read —— 那是在重复劳动，直接比对即可（省下的时间就是验收带宽）。',
        '',
        String(refsText).trim(),
        '',
      ]
      : []),
    ...(String(impactText || '').trim()
      ? [
        '## 这次改动波及谁（依赖图算出来的，不是模型猜的）',
        String(impactText).trim(),
        '',
        '判据：子会话如果动了上面某个文件，它必须说明「这些依赖点会不会被这次改动弄坏」。',
        '一个字都没提 = 影响面没交代，这是判 REVISE 的理由之一（不是唯一理由，也不是必判的理由）。',
        '',
      ]
      : []),
    '## 你有核对权（必须用）',
    '你可以用 Read 工具读仓库文件（当前工作目录就是仓库根），但不能改任何文件 —— 只读。',
    'EVIDENCE 声称的「某文件某行」，你必须真的去读那一行再判，不许凭印象认可。',
    'reason 里要写出你实际读到的内容片段（例如 EXIT = { ok: 0, usage: 2, ... }），',
    '写不出实际读到的内容，或那一行根本对不上，就判 REVISE，理由写「证据未能核对」+ 你读到了什么。',
    '',
    '## 你要判断的',
    '1. ANSWER 是否直接回答了任务问的东西；',
    '2. EVIDENCE 是否可核对 —— 判据是你自己读到了对得上的内容，不是它自称有行号；',
    '3. 各子会话之间若互相矛盾，必定至少一方是错的：在矛盾的那几条里，谁的证据更强（带文件名+行号或命令输出）谁 PASS，证据弱的一方判 REVISE。',
    '   若产物标注了通道（例如 ollama），它来自本地小模型：证据必须比云端更硬才放过，宁可判 REVISE 让它重做。',
    '   —— 不要因为「存在矛盾」就把正确答案一起毙掉：把对的一起毙掉，等于这次分发白跑。',
    '',
    // 运行中追加的指令：人在/人在看的 AI 往 notes.md 里写一句，父审必须照办。
    // 这是「可转向」的唯一实现方式 —— 派活一旦发出去就收不回，只能让下一环吸收新要求。
    ...(String(note || '').trim()
      ? ['## 父批注（运行中追加，优先级高于原任务）', String(note).trim(), '']
      : []),
    '## 输出格式（只输出 JSON 数组，不要任何解释文字）',
    '[{"id":"子会话 id","verdict":"PASS 或 REVISE","reason":"一句话，指出问题在哪"}]',
  ].join('\n');
}

/** 解析子产物。标签缺失时退回整段文本 —— 宁可交给父会话看原始文本，也不要静默丢。 */
export function parseChildOutput(text) {
  const raw = String(text || '').trim();
  if (!raw) return { answer: '', evidence: '', malformed: true };
  const a = raw.search(/ANSWER\s*[:：]/i);
  const e = raw.search(/EVIDENCE\s*[:：]/i);
  if (a >= 0 && e > a) {
    const answer = raw.slice(raw.indexOf(raw.slice(a).match(/[:：]/)[0], a) + 1, e).trim().replace(/^$/, '');
    const evidence = raw.slice(raw.indexOf(raw.slice(e).match(/[:：]/)[0], e) + 1).trim();
    return { answer: clean(answer), evidence: clean(evidence), malformed: !answer };
  }
  return { answer: clean(raw).slice(0, 600), evidence: '', malformed: true };
}

const clean = (s) => String(s).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();

/** 父会话回填 id 的方式五花八门（实测 glm 会回 "子会话 #2" 而不是 c2）。
 *  归一：精确 id → 序号（#N / 子会话 N）→ 子串包含。归不出来的一律 unreviewed。 */
function normId(raw, ids) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const exact = ids.find((id) => s === String(id));
  if (exact) return exact;
  const num = s.match(/#\s*(\d+)/) || s.match(/第\s*(\d+)\s*个子会话/) || s.match(/^子会话\s*(\d+)$/);
  if (num) {
    const n = Number(num[1]);
    if (Number.isInteger(n) && n >= 1 && n <= ids.length) return ids[n - 1];
  }
  const lower = s.toLowerCase();
  return ids.find((id) => lower.includes(String(id).toLowerCase())) || null;
}

/** 解析父审查结果。只认机器码；认不出的一律 unreviewed，绝不默认 PASS。 */
export function parseReview(text, ids) {
  const raw = String(text || '');
  const lo = raw.indexOf('[');
  const hi = raw.lastIndexOf(']');
  if (lo >= 0 && hi > lo) {
    try {
      const arr = JSON.parse(raw.slice(lo, hi + 1));
      if (Array.isArray(arr)) {
        const taken = new Set();
        return ids.map((id) => {
          const hit = arr.find((x) => x && !taken.has(x) && normId(x.id, ids) === id);
          if (!hit) return { id, verdict: VERDICT.none, reason: '父会话没有对这条给票' };
          taken.add(hit);
          const v = String(hit.verdict || '').toUpperCase();
          const verdict = v === 'PASS' ? VERDICT.pass : v === 'REVISE' ? VERDICT.revise : VERDICT.none;
          return { id, verdict, reason: clean(hit.reason || '') };
        });
      }
    } catch { /* 落到下面按行兜底 */ }
  }
  return ids.map((id) => {
    const line = raw.split('\n').find((l) => l.includes(String(id)));
    if (!line) return { id, verdict: VERDICT.none, reason: '父会话没有对这条给票' };
    const v = /REVISE|驳回|重做/i.test(line) ? VERDICT.revise : /PASS|通过/i.test(line) ? VERDICT.pass : VERDICT.none;
    return { id, verdict: v, reason: clean(line) };
  });
}

/** 机器汇总：父会话的结论能不能放行，由这里算，不由父自己说。 */
export function summarizeFanout(reviews) {
  const counts = { PASS: 0, REVISE: 0, unreviewed: 0 };
  for (const r of reviews) {
    if (r.verdict === VERDICT.pass) counts.PASS++;
    else if (r.verdict === VERDICT.revise) counts.REVISE++;
    else counts.unreviewed++;
  }
  const value = counts.REVISE > 0 ? -1 : counts.unreviewed > 0 ? 0 : 1;
  return {
    value,
    state: value === 1 ? 'ACCEPT' : value === -1 ? 'REVISE' : counts.unreviewed === reviews.length ? 'unreviewed' : 'partial',
    counts,
    total: reviews.length,
  };
}

/** 落盘：父目录 + 每个子会话一个文件，审完还要能复判。 */
export function writeFanout(dir, { task, children, reviews, summary, meta, merged, reviewRaw }) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  lines.push('# fanout 记录', '', '- task: ' + task, '- 子会话数: ' + children.length, '- 汇总: ' + summary.state + '（' + JSON.stringify(summary.counts) + '）', '');
  // 谁审的必须是一眼看得到的字段，不能只躺在 meta JSON 里 —— 同源自审与异源评审
  // 的结论可信度差一个档，读产物的人不该靠解析 JSON 才知道这件事。
  if (meta && meta.reviewLane) {
    lines.push('- 父审: ' + meta.reviewLane + (meta.homogeneous === false ? '（异源）' : '（同源 —— 主力与评审是同一家）'), '');
  }
  if (meta) lines.push('- meta: ' + JSON.stringify(meta), '');
  // 父审错误必须落盘：2026-11-16 一次 6 片跑出 3 条「父审没给票」，因为原始输出没留，
  // 事后无法区分「父审漏答」「解析失败」「调用失败」—— 可观测性缺口比 bug 更贵。
  if (summary && summary.error) lines.push('- 父审错误: ' + summary.error, '');
  for (const c of children) {
    lines.push('## ' + c.id, '', '- verdict: ' + (reviews.find((r) => r.id === c.id) || {}).verdict, '- reason: ' + ((reviews.find((r) => r.id === c.id) || {}).reason || ''), '- elapsedMs: ' + c.elapsedMs, '', 'ANSWER:', c.answer || '(空)', '', 'EVIDENCE:', c.evidence || '(空)', '');
    fs.writeFileSync(path.join(dir, c.id + '.md'), ['# ' + c.id, '', 'ANSWER:', c.answer || '(空)', '', 'EVIDENCE:', c.evidence || '(空)', '', '--- raw ---', c.raw || ''].join('\n'), 'utf8');
  }
  if (merged && merged.text) {
    // 分片合订是机械拼装（不调 LLM）：谁说了什么原样保留，可复算。
    lines.push('## 机械拼装（分片合订 · 未调 LLM）', '', merged.text, '');
    fs.writeFileSync(path.join(dir, 'MERGED.md'), merged.text, 'utf8');
  }
  if (reviewRaw) {
    lines.push('## 父审原始输出', '', '见 REVIEW-RAW.md（原样保存，可复判）', '');
    fs.writeFileSync(path.join(dir, 'REVIEW-RAW.md'), String(reviewRaw), 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'FANOUT.md'), lines.join('\n'), 'utf8');
  return path.join(dir, 'FANOUT.md');
}
