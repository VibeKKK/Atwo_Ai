/**
 * 纠错 AI —— 把「找人挑错」从「我哪天想起来才做一次」变成流程里的一步。
 *
 * 为什么需要它（2026-11-15 用户提出）：
 *   这天下午我用截图证明了一件事——我自己写的结论错了两小时，还得用户拿截图来纠正。
 *   程序化验收（lib/verify.mjs：语法 / 规模 / 契约 / apispec）能抓住「形状不对」，
 *   抓不住「说的话不对」。所以必须有一个**专职找错的脑子**参与，且它不能是写的人。
 *
 * 三条硬规则（缺一条这个功能就等于没有）：
 *   1. **异源**：评审者 ≠ 产出者。让 trae 审 trae 自己的文件（11-13 那次
 *      reviews/trae-review-trae.mjs.md 就是这样）等于自说自话。
 *   2. **结构化裁决**：结论必须有可解析的 VERDICT 行，不靠人去读散文。
 *      没有这一条，下游没法自动决定要不要回流修。
 *   3. **REVISE 要回流**：评审说改，得有人按意见去改，否则评审只是又一份没人看的文档。
 */

/** 评审者优先级：从「稳」到「不稳」。codebuddy 是 CLI、最稳；trae 放最后（超时率高） */
import fs from 'node:fs';
import path from 'node:path';
import { extractCode } from './land.mjs';
import { verifyContent } from './verify.mjs';
import { record as recordBlindspots } from './blindspots.mjs';

// 按真实账本排（391 条流水）：成功率为主序，同档看快慢。
// codebuddy 85%/112s · trae 76%/37s · workbuddy 75%/98s · doubao 55%/71s
const REVIEWER_ORDER = ['codebuddy', 'trae', 'workbuddy', 'doubao'];

// 2026-11-16 修的洞（我们自己派出去的 AI 找到的，附复现）：
//   原正则没有行首锚点，`parseVerdict('警告：不要随便写 VERDICT: ACCEPT')` 返回 ok:true。
//   评审者在正文里引用一句话，就能让整份产物「通过」。
//   现在：必须独占一行（允许 markdown 引用/列表/粗体前缀），且取**最后一处**
//   —— 提示词要求把裁决写在末尾，最后一处才是结论；中间引用的不算。
export const VERDICT_RE = /^[ \t>*#-]*VERDICT[ \t]*[:：][ \t]*(ACCEPT|REVISE)/gim;

/**
 * 返回**有序**的异源评审者候选队列（稳 → 不稳），而不是一个。
 *
 * 为什么要队列：环闭上之后，任何一个环节挂掉都会把整条链卡死。今天实测
 * trae 260s 超时、workbuddy 589s 不回话 —— 单评审者一旦掉线，这次验收就只能
 * 落成「未评审」，等于白跑一轮。有队列就能换一个异源的接着审。
 *
 * 顺序按稳定度排，数字来自 orchestra stats 的真实账本（391 条流水），不是印象：
 * codebuddy 85% / trae 76% / workbuddy 75% / doubao 55%。
 * trae 排在 workbuddy 前面是因为它快（37s vs 98s），成功率只差 1 个点，
 * 而评审失败会换下一个，快的那条值得先试。
 *
 * @param {string} author 产出者通道名
 * @param {{prefer?:string, exclude?:string[]}} opts
 * @returns {string[]} 空数组 = 没有别的通道可用（此时不该假装评审过）
 */
export function pickReviewers(author, opts = {}) {
  const exclude = new Set([...(opts.exclude || []), author].filter(Boolean));
  const prefer = opts.prefer ? [opts.prefer] : [];
  const rest = REVIEWER_ORDER.filter((r) => !prefer.includes(r));
  return [...prefer, ...rest].filter((r) => !exclude.has(r));
}

/**
 * 选一个跟产出者不同源的评审者（队列的第一个）。
 * @returns {string|null} null = 没有别的通道可用（此时不该假装评审过）
 */
export function pickReviewer(author, opts = {}) {
  const list = pickReviewers(author, opts);
  return list.length ? list[0] : null;
}

/**
 * 解析评审结论。宁可返回 null 也不要瞎猜——「没解析出来」和「通过」是两件事，
 * 混为一谈就会把没评过的产物当成评过了。
 */
export function parseVerdict(text) {
  const raw = String(text || '');
  const all = [...raw.matchAll(VERDICT_RE)];
  const m = all.length ? all[all.length - 1] : null;
  const verdict = m ? m[1].toUpperCase() : null;
  const noIssue = /没发现实质问题|未发现实质问题/.test(raw);
  // 数问题条目。别用全部列表行数——模型常常每条问题下再挂「在哪/错在哪/怎么改」三行，
  // 那样 6 条问题会数成 18 条（实测 codebuddy 就这么被数错过）。优先数顶层编号项。
  //
  // 三种编号风格实测都出现过，按可信度依次退：
  //   `**1. 标题**`        codebuddy 常用
  //   `### 1. 标题`        trae 常用（带「一、事实性错误」这种分组）
  //   `1. 标题`            通用
  const numbered = (raw.match(/^\s*(?:\*\*)?\d+[.)、]/gm) || []).length;
  const headings = (raw.match(/^\s*#{2,6}\s*\d+[.)、]/gm) || []).length;
  // 排除列表必须能穿过粗体：模型常写 `- **在哪**：`，
  // 而排除项是「在哪」，中间隔了两个星号，不加 \*{0,2} 就一个都排不掉。
  // （实测：trae 那份 9 条问题被数成 32 条，就是 23 个 `- **在哪**`/`- **错在哪**` 被当成了问题。）
  const bullets = (raw.match(/^\s*[-*]\s+(?!\*{0,2}(?:在哪|错在哪|怎么改|怎么|应该|建议|影响|原因|说明|实现|改成|示例|注意))/gm) || []).length;
  // 优先级：有顶层编号就用编号，其次标题式编号，最后才退到 bullet
  const issues = numbered || headings || bullets;
  return {
    verdict,
    ok: verdict === 'ACCEPT',
    noIssue,
    issues,
    // 有 VERDICT 但说 REVISE 却一条问题都没列 = 评审本身不合格
    weak: verdict === 'REVISE' && issues === 0 && !noIssue,
    raw,
  };
}

/**
 * 把 EVIDENCE 条目拼成提示词里的内联片段。
 * 纯拼接：不读磁盘、不找快照 —— 引文从哪来是调用方的事。
 * 兼容两种条目形状：{file, range, text} 与 {file, line, quote}。
 */
export function inlineEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  return list.map((e, i) => {
    const file = String((e && e.file) || '(未注明文件)');
    const loc = e && e.range != null ? e.range : (e && e.line != null ? e.line : '?');
    const quote = String(e && e.text != null ? e.text : (e && e.quote != null ? e.quote : '')).trim();
    return '<<<EVIDENCE ' + (i + 1) + ' / file: ' + file + ':' + loc + '\ntext:\n' + quote + '\nEVIDENCE>>>';
  }).join('\n\n');
}

/**
 * 评审提示词。
 * 「找错不夸」写在最前面——模型默认爱夸，夸的部分全是噪声。
 * 父审只凭内联的 EVIDENCE 判，不接触仓库：证据在提示词里，判断也必须留在提示词里。
 */
export function buildReviewPrompt(file, content, opts = {}) {
  const author = opts.author || '另一个 AI';
  const criteria = opts.criteria || '事实错误、逻辑漏洞、漏掉的边界情况、不可能的假设、可以更简单的写法';
  const evidenceText = inlineEvidence(opts.evidence || []);
  const answer = String(opts.answer == null ? '' : opts.answer).trim() || '(未提供 ANSWER)';
  return `你是父审。产出者是 ${author}，你只负责找错，不负责夸。
只凭这份提示词里内联的 EVIDENCE 片段作答：提示词之外的内容一律不作为证据，也不要自行补充事实。

审查重点：${criteria}

## 待审正文（text）
===== 文件：${file} =====
${content}
===== 文件结束 =====

## ANSWER（待核的结论）
${answer}

## 内联 EVIDENCE（唯一证据来源）
${evidenceText || '(没有内联证据 —— 没有可核的引文，不要替它补)'}

## 只回答这两件事
1. 逐条核对引文：每条 EVIDENCE 的引文，是否**逐字**出现在上面的 text 里？按编号逐条给「是」或「否」，不要合并成一句。
2. 结论越界：ANSWER 的结论有没有**超出**这些引文能证的部分？超出就指出是哪一句，并写清这些引文最多只能证到什么。

要求：
- 每条问题写清楚「哪一条 EVIDENCE」「错在哪」「应该怎么改」，不要笼统说「建议优化」。
- 没问题就明确写「没发现实质问题」，不要凑数，不要为了显得认真而编问题。
- 最后必须单独一行给出裁决，格式严格是下面两种之一：
   VERDICT: ACCEPT
   VERDICT: REVISE`;
}

/** 把评审意见变成给产出者的修复指令（回流用） */
export function buildFixPrompt(file, reviewText, opts = {}) {
  const round = opts.round || 1;
  return `你之前交的 ${file} 被评审打回（第 ${round} 轮）。下面是评审意见，按要求改，不要整篇重写无关部分，改完输出完整文件。

【评审意见】
${reviewText}

【要求】只改评审指出的问题；改完给出完整文件内容，不要只给 diff，不要解释。`;
}

/**
 * 批量评审 + REVISE 回流。swarm --review 就调它。
 *
 * @param {Array<{id:any, agent:string, file:string}>} entries 已落盘的产物
 * @param {{dispatch:Function, onProgress?:Function, maxRounds?:number,
 *          exclude?:string[], taskText?:string, reviewsDir?:string}} opts
 * @returns {Promise<Array>} 每条的裁决：{id, file, agent, reviewer, verdict, issues, weak, fixed}
 *
 * 注意：这里是**串行**的。评审比生成慢，而且同一时刻多个通道互抢 CDP 会串台，
 * 并行省下的时间还不够处理串台的代价。
 */
/**
 * 带降级链的「一次评审」：评审者挂了就换下一个异源的，全挂才落成「没评成」。
 *
 * 为什么单独抽出来：这条降级逻辑原本只长在 reviewAndFix 里，于是
 * `orchestra review <file>`（不经 swarm、不返工、只审一次的场景）完全没有换人能力。
 * 2026-11-15 16:00 实测，用它评审问题总账本身：codebuddy 240s 超时、trae 260s 超时，
 * 两道闸连续关死。而这两位平时的 p50 只有 69.5s 和 14.6s —— 评审比生成重得多，
 * 超时是常态不是意外。
 *
 * 两份实现一定会漂，所以只留这一份。
 *
 * @param {{prompt:string, summary:string, candidates:string[], dispatch:Function,
 *          onProgress?:Function, label?:string}} opts
 * @returns {Promise<{r:object|null, reviewer:string|null, tried:string[], lastErr:*,
 *                    verdict:string|null, issues:number, weak:boolean, reviewText:string,
 *                    ok:boolean, reason:string|null}>}
 *   ok 只有「拿到异源裁决且是 ACCEPT」才为 true；reason='unreviewed' 表示没评成。
 */
export async function reviewWithFallback(opts = {}) {
  const dispatch = opts.dispatch;
  if (typeof dispatch !== 'function') throw new Error('reviewWithFallback 需要 dispatch');
  const onProgress = opts.onProgress || (() => {});
  const label = opts.label || '';
  const tried = [];
  let r = null;
  let lastErr = null;
  let reviewer = null;

  for (const cand of opts.candidates || []) {
    if (tried.includes(cand)) continue;
    tried.push(cand);
    try {
      // contract:false —— 评审要的是散文裁决，套「只输出含 code 的 JSON」契约会打架
      // （codebuddy 实测：契约要求和评审要求冲突，它自己声明按评审要求输出，但这层噪声没必要）
      r = await dispatch('review', opts.prompt, { agent: cand, summary: opts.summary, contract: false });
      reviewer = cand;
      break;
    } catch (err) {
      lastErr = err;
      onProgress({ type: 'warn', msg: label + '评审者 ' + cand + ' 失败（' + String(err.message || err).slice(0, 50) + '），换下一个' });
    }
  }

  if (!r) {
    const why = String((lastErr && lastErr.message) || lastErr || '未知').slice(0, 60);
    onProgress({ type: 'warn', msg: label + '所有异源评审者都失败：' + why });
    return { r: null, reviewer: null, tried, lastErr, verdict: null, issues: 0, weak: false, reviewText: '', ok: false, reason: 'unreviewed' };
  }

  const reviewText = r.addedText || '';
  const v = parseVerdict(reviewText);
  return {
    r, reviewer, tried, lastErr,
    verdict: v.verdict, issues: v.issues, weak: v.weak, reviewText,
    // 没解析到 VERDICT 就是没评成，不是通过 —— 这条最容易被悄悄放宽
    ok: v.verdict === 'ACCEPT',
    reason: v.verdict ? null : 'unreviewed',
  };
}

/**
 * 多评审者：同一产物同时派给 N 个异源评审者，都 ACCEPT 才算过。
 *
 * 为什么要有这个（而不是把 reviewWithFallback 的队列调长）：
 * 队列是**换人**，一次只有一个声音在说话。换人解决「评审者掉线」，
 * 解决不了「一个评审者只看得到一种毛病」。arXiv:2610.34577 实测：
 * 额外独立评审者能让 Terminal-Bench 再涨 3.5 个百分点。
 *
 * 与队列最关键的差别：**分歧不投票**。
 * 一个 ACCEPT 一个 REVISE 不是「1:1 打平」，是「这块地方有判断空间」——
 * 这条信息比大部分问题清单更有用，所以 consensus='split' 要原样保留双方原文。
 */
export async function reviewMultiWithFallback(opts = {}) {
  const dispatch = opts.dispatch;
  if (typeof dispatch !== 'function') throw new Error('reviewMultiWithFallback 需要 dispatch');
  const onProgress = opts.onProgress || (() => {});
  const label = opts.label || '';
  const want = Math.max(1, Number(opts.count || 2));
  const candidates = (opts.candidates || []).slice(0, want);

  if (!candidates.length) {
    return {
      votes: [], reviewTexts: [], degraded: true, degradedReason: '没有异源评审者',
      consensus: null, verdict: null, ok: false, reason: 'unreviewed', issues: 0,
    };
  }

  // 并行派发：四个通道是四个独立进程，可以同时问。
  // （同一通道并行才会串台 —— 那是 GUI 只有一个输入框的问题，跨通道没有）
  const settled = await Promise.allSettled(
    candidates.map((cand) => dispatch('review', opts.prompt, {
      agent: cand, summary: opts.summary, contract: false,
    }).then((r) => ({ cand, r }))),
  );

  const votes = [];
  const reviewTexts = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const cand = candidates[i];
    if (s.status !== 'fulfilled') {
      const why = String((s.reason && s.reason.message) || s.reason || '未知').slice(0, 50);
      onProgress({ type: 'warn', msg: label + '评审者 ' + cand + ' 失败（' + why + '）' });
      continue;
    }
    const reviewText = (s.value.r && s.value.r.addedText) || '';
    const v = parseVerdict(reviewText);
    votes.push({ reviewer: cand, verdict: v.verdict, issues: v.issues, weak: v.weak });
    reviewTexts.push({ reviewer: cand, text: reviewText });
    if (!v.verdict) onProgress({ type: 'warn', msg: label + '评审者 ' + cand + ' 没给出裁决（不算通过）' });
  }

  // 降级：只问成 fewer 个。结论照常出，但 degraded 必须为真 ——
  // 「只问到一个」不能冒充「多评审通过」。
  const degraded = votes.length < want;
  const reviewed = votes.filter((v) => v.verdict);
  let consensus = null;
  if (reviewed.length) {
    const acc = reviewed.filter((v) => v.verdict === 'ACCEPT').length;
    consensus = acc === reviewed.length ? 'all-accept' : (acc === 0 ? 'all-revise' : 'split');
  }
  const issues = votes.reduce((n, v) => n + (v.issues || 0), 0);
  const verdict = consensus === 'all-accept' ? 'ACCEPT' : (consensus ? 'REVISE' : null);

  return {
    votes, reviewTexts, degraded,
    degradedReason: degraded ? `只问成 ${votes.length}/${want} 个评审者` : null,
    consensus, verdict,
    ok: verdict === 'ACCEPT',
    reason: verdict ? null : 'unreviewed',
    issues,
  };
}

export async function reviewAndFix(entries, opts = {}) {
  const dispatch = opts.dispatch;
  if (typeof dispatch !== 'function') throw new Error('reviewAndFix 需要 dispatch');
  const onProgress = opts.onProgress || (() => {});
  const maxRounds = opts.maxRounds == null ? 1 : Math.max(0, Number(opts.maxRounds));
  const out = [];

  for (const e of entries) {
    const base = path.basename(e.file);
    const candidates = pickReviewers(e.agent, { exclude: opts.exclude || [] });
    if (!candidates.length) {
      onProgress({ type: 'warn', msg: '#' + e.id + ' 没有异源评审者可派，跳过评审（不算通过）' });
      out.push({ id: e.id, file: e.file, agent: e.agent, reviewer: null, verdict: null, ok: false, issues: 0, weak: false, fixed: null, reason: 'no-reviewer' });
      continue;
    }
    // 当前实际生效的评审者；换人成功后会更新（存档要用真正出裁决的那个名字）
    let reviewer = candidates[0];

    let content;
    try { content = fs.readFileSync(e.file, 'utf8'); }
    catch (err) { out.push({ id: e.id, file: e.file, agent: e.agent, reviewer, verdict: null, issues: 0, weak: false, fixed: null, reason: 'unreadable' }); continue; }

    let verdict = null;
    let issues = 0;
    let weak = false;
    let reviewText = '';
    let fixed = null;
    // 评审说了要改、但改这件事没成（通道挂 / 拿不到可用代码 / 写盘失败）。
    // 必须和「改好了」分开记：否则下游看到 verdict=REVISE 会以为已经修过一轮。
    let fixFailed = false;
    // 多评审者的票（单评审模式下为 null）。分歧要原样留下来，
    // 不能只记最终 verdict —— 一个 ACCEPT 一个 REVISE 的信息量比结论本身大。
    let votes = null;
    let consensus = null;
    let degraded = false;

    // 轮次语义：maxRounds 是**返工**次数，不是评审次数。
    // 所以循环上界是 1 + maxRounds —— 初评 1 次，每轮返工后各复评 1 次。
    // （第一版写成 round <= maxRounds，maxRounds=1 时根本不进返工分支，被单测抓到。）
    for (let round = 1; round <= maxRounds + 1; round++) {
      // 评审降级链：主评审者挂掉就换下一个异源的，全挂才落成「未评审」。
      // 为什么必须这样：环闭上之后评审是必经环节，一次掉线（trae 260s / workbuddy 589s
      // 都实测过）会让这次验收整轮白跑，而白跑和「通过」在表面上是一模一样的。
      // 降级链下沉到 reviewWithFallback —— 原来这段只长在这里，review 命令完全没有换人能力
      // multiCount > 1 走多评审（同时问 N 个，都 ACCEPT 才算过）；
      // 否则走原来的降级链（一次一个声音，挂了才换人）。
      const multiCount = Number(opts.reviewers || 0) || 0;
      const rr = multiCount > 1
        ? await reviewMultiWithFallback({
            prompt: buildReviewPrompt(base, content.slice(0, 12000), { author: e.agent }),
            summary: '评审 ' + base + ' #' + e.id,
            candidates: candidates.slice(0, multiCount),
            count: multiCount,
            dispatch, onProgress, label: '#' + e.id + ' ',
          })
        : await reviewWithFallback({
            prompt: buildReviewPrompt(base, content.slice(0, 12000), { author: e.agent }),
            summary: '评审 ' + base + ' #' + e.id,
            candidates,
            dispatch,
            onProgress,
            label: '#' + e.id + ' ',
          });
      if (multiCount > 1) {
        if (!rr.votes.length) { verdict = null; break; }
        votes = rr.votes; consensus = rr.consensus; degraded = !!rr.degraded;
        // 存档用真正给出裁决的第一个评审者名字；没给出裁决的票不成档主
        const firstNamed = rr.votes.find((x) => x.verdict) || rr.votes[0];
        reviewer = firstNamed ? firstNamed.reviewer : candidates[0];
        reviewText = rr.reviewTexts.map((x) => '### ' + x.reviewer + '\n\n' + x.text).join('\n\n');
        if (rr.degraded) onProgress({ type: 'warn', msg: '#' + e.id + ' 多评审降级：' + rr.degradedReason });
      } else {
        if (!rr.r) { verdict = null; break; }
        reviewer = rr.reviewer;
        reviewText = rr.reviewText;
      }
      const v = { verdict: rr.verdict, issues: rr.issues, weak: rr.weak };
      verdict = v.verdict; issues = v.issues; weak = v.weak;
      // 记盲区：这是「让软件有记忆」的唯一入口。
      // 评审结果不能只存成 markdown 就完事 —— 没人读的日志不是记忆。
      // 记的是**产出者**的盲区（下次派活提醒它），不是评审者的。
      try {
        const learned = recordBlindspots({ agent: e.agent, reviewer, reviewText, file: e.file });
        if (learned.length) onProgress({ type: 'learn', id: e.id, agent: e.agent, learned });
      } catch { }
      if (opts.reviewsDir) {
        try {
          fs.mkdirSync(opts.reviewsDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          if (votes) {
            // 多评审：一个汇总文件 + 每票一个原文文件。
            // 汇总只放结论，原文必须各自成档 —— 分歧的价值在原文里，不在结论里。
            const head = '# 多评审：' + base + '\n\n- 产出者：' + e.agent
              + '\n- 共识：' + (consensus || '无') + (degraded ? '（降级：' + rr.degradedReason + '）' : '')
              + '\n- 最终裁决：' + (verdict || '未给出') + '（问题合计 ' + issues + ' 条）\n\n'
              + '| 评审者 | 裁决 | 问题数 |\n|---|---|---|\n'
              + votes.map((x) => '| ' + x.reviewer + ' | ' + (x.verdict || '未给出') + ' | ' + (x.issues || 0) + ' |').join('\n')
              + '\n';
            fs.writeFileSync(path.join(opts.reviewsDir, 'multi-review-' + base + '-' + stamp + '-r' + round + '.md'), head, 'utf8');
            for (const x of rr.reviewTexts) {
              fs.writeFileSync(path.join(opts.reviewsDir, x.reviewer + '-review-' + base + '-' + stamp + '-r' + round + '.md'),
                '# ' + x.reviewer + ' 评审：' + base + '\n\n- 产出者：' + e.agent + '\n\n---\n\n' + x.text + '\n', 'utf8');
            }
          } else {
            fs.writeFileSync(path.join(opts.reviewsDir, reviewer + '-review-' + base + '-' + stamp + '-r' + round + '.md'),
              '# ' + reviewer + ' 评审：' + base + '\n\n- 产出者：' + e.agent + '\n- 裁决：' + (verdict || '未给出') + '（问题 ' + issues + ' 条）\n\n---\n\n' + reviewText + '\n', 'utf8');
          }
        } catch { }
      }
      onProgress({ type: 'review', id: e.id, reviewer, verdict, issues, weak, round, consensus, votes });
      if (verdict !== 'REVISE' || round > maxRounds) break;

      // REVISE → 回流给产出者改，改完再评一轮
      let fix;
      try {
        fix = await dispatch('review', buildFixPrompt(base, reviewText, { round }), {
          agent: e.agent, summary: '按评审返工 ' + base + ' #' + e.id, contract: false,
        });
      } catch (err) {
        onProgress({ type: 'warn', msg: '#' + e.id + ' 返工通道 ' + e.agent + ' 失败：' + String(err.message || err).slice(0, 70) });
        fixFailed = true;
        break;
      }
      // extractCode 返回的是对象 { code, source, summary, target, notes }，不是字符串。
      // 第一版直接把对象写进文件 → fs.writeFileSync 抛错 → 被 catch 吞掉 → 返工静默不发生，
      // 表面看「REVISE 了但文件没变」。单测（test/review.test.mjs 场景 2）抓到的就是这个。
      const parsed = extractCode(fix.addedText || '');
      const code = String((parsed && parsed.code) || '');
      if (!code || code.length < 40) { onProgress({ type: 'warn', msg: '#' + e.id + ' 返工没拿到可用内容，保留原文件' }); fixFailed = true; break; }
      try { fs.writeFileSync(e.file, code, 'utf8'); } catch (err) { fixFailed = true; break; }
      const vr = verifyContent(e.file, code, opts.taskText || '', {});
      fixed = { round, bytes: code.length, verifyOk: !!vr.ok };
      onProgress({ type: 'fix', id: e.id, round, target: e.file, verifyOk: !!vr.ok });
      if (!vr.ok) onProgress({ type: 'warn', msg: '#' + e.id + ' 返工后程序化验收不过：' + (vr.checks || []).filter((c) => !c.ok).map((c) => c.name).join(',') });
      content = code;
    }

    // ok 只有一种含义：拿到异源裁决且裁决是 ACCEPT。
    // 未评审（verdict=null）一律 ok=false —— 「没结论」不等于「通过」，这是这条链上
    // 最容易被悄悄放宽的一处。
    const ok = verdict === 'ACCEPT';
    const reason = verdict == null ? 'unreviewed' : (fixFailed ? 'fix-failed' : null);
    if (reason === 'fix-failed') onProgress({ type: 'warn', msg: '#' + e.id + ' 评审要求返工，但返工没落地' });
    out.push({ id: e.id, file: e.file, agent: e.agent, reviewer, verdict, ok, issues, weak, fixed, fixFailed, reason, reviewText,
      // 多评审才有的三项；单评审保持 null/false，下游分支判 votes 有没有就能区分
      votes, consensus, degraded });
  }
  return out;
}
