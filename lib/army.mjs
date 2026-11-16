// lib/army.mjs —— 三三制阵型（侦察 / 主力 / 评审）的纯逻辑层：提示词、解析、票面结算、渲染。
// 执行在 lib/army-run.mjs；这里不碰子进程，所以能单测。
//
// 为什么这个阵型只对「批次」划算（2026-11-16 实测）：
//   侦察 15s + 主力 90s（最慢那路）+ 评审 50s（单片固定成本，8 份走一个父审 67.4s）
//   = 155s；而只跑主力 = 90s → 单任务慢 72%。
//   一个 PRD 20 个单元、主力 3 路：串行 600s vs 三三制 280s ≈ 2.1x。
//   → 所以 units < 2 时不许用（会净亏），这由 validateArmy 挡住。
//
// 三条纪律（来自同一天的标定与事故）：
//   1. 侦察产出是【候选】不是事实。pregate 标定 30 份真实产物：codebuddy 在 PASS 侧
//      zero-overlap 最高 17%，本地小模型 100% 捏造。侦察常跑本地快模型 → 每条强制打标记，
//      主力必须自己读源码核对。评审只能发现「三份互相矛盾」，发现不了「三份一致地错」。
//   2. 票面结算必须经过 judgeVotes（到票率闸门 votes.arity=0.8）：2 路评审只回 1 路时，
//      该产物是 unreviewed，不是「那一路说了算」。
//   3. 阵型不许自带实现：主力复用 fanout 的子会话契约，评审复用 parseReview，
//      结算复用 vm/votes.mjs。多一份实现就多一个漂移面。
import { detectUnits } from './split.mjs';
import { judgeVotes } from '../vm/votes.mjs';

export const ARMY_STAGES = ['scout', 'main', 'review'];

/** 侦察产出的每条都必须带这个标记：模型给的骨架是候选，不是事实。 */
export const CANDIDATE = '[候选]';

export const ARMY_LIMITS = {
  minUnits: 2, // 少于 2 个单元三段串行净亏（单任务 155s vs 90s）
  maxUnits: 6, // 单通道拐点：12 路时单路由 4.85s 涨到 11.05s
  defaultUnits: 3,
  minReviewers: 1,
  maxReviewers: 3,
  maxScoutChars: 6000, // 侦察产出喂给每一路主力，太长等于给三路各灌一次噪声
};

const uniq = (arr) => Array.from(new Set(arr));

/**
 * 定单元：显式 --units 优先；否则从任务文本里抠可枚举的文件（split.detectUnits）。
 * 抠不出来就是 []，绝不猜 —— 猜出来的单元会让主力各答错题。
 */
export function pickUnits(task, opts = {}) {
  const explicit = Array.isArray(opts.units)
    ? opts.units.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (explicit.length) return { units: uniq(explicit), from: 'explicit', source: 'explicit' };
  // detectUnits 返回 [{unit, abs, exists}]：这里统一成字符串，army 只关心「哪一路负责什么」。
  const detected = detectUnits(String(task || ''), { cwd: opts.cwd, keepIgnored: opts.keepIgnored })
    .map((u) => (typeof u === 'string' ? u : u.unit)).filter(Boolean);
  return { units: uniq(detected), from: detected.length ? 'detected' : 'none', source: 'task-text' };
}

/**
 * 阵型准入。返回 {ok, reason, hint} —— 由 CLI 决定退出码，这里不 die。
 * 低于 2 个单元不许用（三段串行净亏），超过 6 个要求先拆 PRD（否则长尾回到单路）。
 */
export function validateArmy({ units, reviewers = 1 }) {
  const n = Array.isArray(units) ? units.length : 0;
  if (n < ARMY_LIMITS.minUnits) {
    return {
      ok: false,
      reason: 'units<2',
      hint: n === 0
        ? '没有可枚举的单元：用 --units a.mjs,b.mjs 显式指定（三三制主力是「异题并行、一文件一路」），或者这件活用 atwo fanout 更便宜。'
        : '只有 1 个单元：三三制对它净亏（侦察+评审是串行段，实测 155s vs 只跑主力 90s）。这活直接用 atwo fanout。',
    };
  }
  if (n > ARMY_LIMITS.maxUnits) {
    return {
      ok: false,
      reason: 'units>max',
      hint: '单元 ' + n + ' 个超过单次阵型上限 ' + ARMY_LIMITS.maxUnits + '（并发拐点）：先拆成两个 PRD 各跑一次 army，或改用 atwo fanout --split 做同题切分。',
    };
  }
  // 默认值只在「没给」时生效：显式写 --reviewers 0 是用法错，不许被 || 1 悄悄吞成 1 路。
  const given = reviewers !== undefined && reviewers !== null && reviewers !== '';
  const rv = given ? Math.floor(Number(reviewers)) : 1;
  if (!Number.isFinite(rv) || rv < ARMY_LIMITS.minReviewers || rv > ARMY_LIMITS.maxReviewers) {
    return { ok: false, reason: 'reviewers', hint: '评审路数只能是 ' + ARMY_LIMITS.minReviewers + '-' + ARMY_LIMITS.maxReviewers + '。' };
  }
  return { ok: true, reason: null, hint: null };
}

/** 侦察兵提示词：只读、只给候选、不许断言。 */
export function buildScoutPrompt(prd, units) {
  return [
    '你是侦察兵，不是主攻。你不出方案，只给后面 2–3 路主攻探路。',
    '',
    '## PRD（要干的事）',
    String(prd || '').trim(),
    '',
    '## 这次要动的单元（共 ' + units.length + ' 个，每个单元后面会有独立的一路主攻）',
    ...units.map((u, i) => '  ' + (i + 1) + '. ' + u),
    '',
    '你有只读权限（Read / Grep / Glob）。看到的写出来，没看到的写「不确定」，不要凭印象。',
    '',
    '## 输出格式（严格照抄标签，父会话按标签解析）',
    'SKELETON:',
    '- ' + CANDIDATE + ' <这件事大概由哪些文件/函数承担；能定位就写 文件:行>',
    'RISKS:',
    '- ' + CANDIDATE + ' <哪里最容易错、最容易被漏>',
    'CHECKS:',
    '- ' + CANDIDATE + ' <主攻交上来以后，用哪一条命令/哪一行核对它>',
    '',
    '## 纪律',
    '- 每一条都只能写成候选（你已经看到 ' + CANDIDATE + ' 前缀，照抄它）。你的产出会被主攻当成假设去核对，不会被当成结论。',
    '- 不要写方案、不要写代码、不要改文件。',
  ].join('\n');
}

/**
 * 解析侦察产出。**不管模型自不自觉，每条都强制打上候选标记与来源**：
 * 侦察段常跑本地快模型（pregate 标定：本地模型捏造率 100%），
 * 靠提示词让它自己标注是不可靠的，必须由解析层强制。
 */
export function parseScout(text, opts = {}) {
  const model = opts.model || 'unknown';
  const raw = String(text || '').replace(/\r/g, '');
  const sections = { skeleton: [], risks: [], checks: [] };
  const keyOf = { SKELETON: 'skeleton', RISKS: 'risks', CHECKS: 'checks' };
  let cur = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    const head = t.replace(/[:：].*$/, '').toUpperCase();
    if (keyOf[head]) { cur = keyOf[head]; continue; }
    if (!cur) continue;
    if (!t) continue;
    const item = t.replace(/^[-*\d.\s]+/, '').trim();
    if (!item) continue;
    const body = item.replace(new RegExp('^\\' + CANDIDATE), '').trim();
    if (!body) continue;
    sections[cur].push({ text: body, candidate: true, source: model });
  }
  const total = sections.skeleton.length + sections.risks.length + sections.checks.length;
  return { ...sections, total, model, empty: total === 0 };
}

/** 把侦察的三段渲染成主力能读的文本（带「候选」警告，防止被当事实）。 */
export function renderScout(scout) {
  if (!scout || !scout.total) return '(侦察没有给出任何候选 —— 直接按 PRD 自己读源码，不要假设)';
  const block = (title, items) => (items.length ? '### ' + title + '\n' + items.map((x) => '- ' + CANDIDATE + ' ' + x.text + '（来源：' + x.source + '）').join('\n') : '');
  const out = [block('骨架', scout.skeleton), block('风险', scout.risks), block('核对点', scout.checks)].filter(Boolean).join('\n\n');
  const cut = out.length > ARMY_LIMITS.maxScoutChars ? out.slice(0, ARMY_LIMITS.maxScoutChars) + '\n（侦察产出过长，已截断）' : out;
  return ['**以下是候选，不是事实。与源码冲突时以源码为准；不要因为「侦察说」就当成已核实。**', '', cut].join('\n');
}

/** 主力那一路的任务文本：一个单元、带契约块头要求、带候选骨架。 */
export function buildMainTask(unit, prd, scout) {
  return [
    '## 你这一路只负责一个单元',
    String(unit),
    '',
    '## 背景 PRD（只作背景；不要越界去替别的单元下结论，别的单元有它们自己的主攻）',
    String(prd || '').trim(),
    '',
    '## 侦察给的候选',
    renderScout(scout),
    '',
    '## 产物要求',
    '- ANSWER 的第一行必须是契约块头：// file: ' + unit,
    '- 每条结论必须带「文件:行」，父审会拿原文核对（读不到原文的结论一律判 REVISE）',
    '- 只写你这一路负责的单元，不要顺手改文件',
  ].join('\n');
}

/**
 * 评审提示词：只找反例，不许重写。
 * 用与 fanout 相同的 JSON 票格式，这样 parseReview 能直接解析；
 * id 用 unit-1..unit-N，与主力产物 id 一一对应。
 */
export function buildArmyReviewPrompt(prd, artifacts, opts = {}) {
  const note = String(opts.note || '').trim();
  const body = artifacts.map((a, i) => [
    '### unit-' + (i + 1) + '（单元：' + a.unit + '）',
    'ANSWER: ' + (a.answer || '(空)'),
    'EVIDENCE: ' + (a.evidence || '(空)'),
  ].join('\n')).join('\n\n');
  return [
    '你是评审，只干一件事：找反例。不许重写、不许给替代方案、不许评价文风。',
    '',
    '## PRD',
    String(prd || '').trim(),
    '',
    '## 主攻交上来的东西',
    body,
    '',
    '## 你有核对权（必须用）',
    '你可以 Read 仓库文件（当前目录就是仓库根），但不能改任何文件。',
    'EVIDENCE 声称的「某文件某行」，你必须真的读那一行再判。写不出你实际读到的内容 → 判 REVISE。',
    '',
    '## 判定口径',
    '- PASS：反例找不出来（注意：找不到反例不等于它对，只是你没找到）。',
    '- REVISE：证据对不上、结论与 PRD 冲突、越界替别的单元下结论、或明显漏了 PRD 要求的某条。',
    '- 多份产物互相矛盾时：证据硬的一方 PASS，软的一方 REVISE；不要因为「有矛盾」把对的也毙掉。',
    '- 产物标注通道为 ollama 的，来自本地小模型：证据必须比云端更硬才放过。',
    ...(note ? ['', '## 批注（优先级高于上面的口径）', note] : []),
    '',
    '## 输出格式（只输出 JSON 数组，不要任何解释文字）',
    '[{"id":"unit-1","verdict":"PASS 或 REVISE","reason":"一句话，指出反例在哪一行"}]',
  ].join('\n');
}

const VOTE_OF = { PASS: 'ACCEPT', REVISE: 'REVISE' };

/**
 * 逐产物票面结算（这是三三制的「票面」那一半）。
 * 每份产物收到 reviewers 张票；缺票 = 到票率不足 = judgeVotes 判 unreviewed，
 * 绝不会因为「来了一张 ACCEPT」就放行（这正是 2026-11-16 堵掉的放行侧漏洞）。
 *
 * @param {Array<{id:string, unit:string}>} artifacts
 * @param {Array<Array<{id:string, verdict:string, reason:string}>>} reviewPasses 每位评审一轮的 parseReview 结果
 */
export function settleArtifacts(artifacts, reviewPasses) {
  const passes = Array.isArray(reviewPasses) ? reviewPasses : [];
  const expected = passes.length;
  return artifacts.map((a) => {
    const votes = passes.map((pass, i) => {
      const hit = (Array.isArray(pass) ? pass : []).find((r) => r && r.id === a.id);
      const v = hit ? VOTE_OF[String(hit.verdict || '').toUpperCase()] : null;
      return { reviewer: 'reviewer-' + (i + 1), value: v, reason: hit ? hit.reason : '这一路评审没对这条给票' };
    });
    const j = judgeVotes({ votes, expected });
    const reasons = votes.filter((v) => v.reason).map((v) => v.reviewer + '：' + v.reason);
    // 三态自己算，不抄 judgeVotes 的 state：它把 value=-1 一律叫 unreviewed，
    // 而 -1 在票面里有两个来源 —— 「票不够」（该算没票）与「都说要改」（该算 REVISE）。
    // 区分的唯一依据是到票率 + 方向：到票够且方向为负 = REVISE；否则一律没票。
    const cast = j.counts.ACCEPT + j.counts.REVISE;
    const enough = !j.rosterMissing && j.expected > 0 && cast / j.expected + 1e-12 >= (Number(j.arity) || 0.8);
    const state = !enough ? 'unreviewed'
      : (j.direction > 0 ? 'ACCEPT' : (j.direction < 0 ? 'REVISE' : 'unreviewed'));
    // 票面的 value 是「决议」：+1 认可 / -1 驳 / 0 存疑 —— 不能直接抄 judge 的 value，
    // 那个是「可判性」（两票全 REVISE 时它给 1，因为判得出来，只是判的是否定）。
    const value = state === 'ACCEPT' ? 1 : (state === 'REVISE' ? -1 : 0);
    return {
      id: a.id,
      unit: a.unit,
      value,
      judgeValue: j.value,
      state,
      confidence: j.confidence,
      reason: j.reason,
      reasonText: j.reasonText,
      turnout: j.turnout,
      counts: j.counts,
      expected: j.expected,
      votes,
      reasons,
    };
  });
}

/** 阵型级汇总：任一产物 REVISE → REVISE；有产物没票 → unreviewed；全 ACCEPT 才 ACCEPT。 */
export function summarizeArmy(settled) {
  const list = Array.isArray(settled) ? settled : [];
  const counts = { ACCEPT: 0, REVISE: 0, unreviewed: 0 };
  for (const s of list) {
    // 按 state 分类而不是 value：value=-1 既可能是「票不够」也可能是「都说要改」，
    // 直接按 value 分类会把「到票不足」报成 REVISE，等于替缺席的评审下结论。
    // 优先信 state（含三态语义）；没有 state 的裸 {value} 才退回按 value 分类。
    const st = s.state || (s.value === 1 ? 'ACCEPT' : (s.value === -1 ? 'REVISE' : 'unreviewed'));
    if (st === 'ACCEPT') counts.ACCEPT += 1;
    else if (st === 'REVISE') counts.REVISE += 1;
    else counts.unreviewed += 1;
  }
  // 空清单不是「全部通过」：没有产物就没有可放行的东西，判没票。
  const value = list.length === 0 ? 0 : (counts.REVISE > 0 ? -1 : (counts.unreviewed > 0 ? 0 : 1));
  return {
    value,
    state: value === 1 ? 'ACCEPT' : value === -1 ? 'REVISE' : 'unreviewed',
    counts,
    total: list.length,
    // 阵型级不给自己编置信度：产物级已经各有一份，合并成一个是假精度。
    confidence: null,
  };
}

/** 墙钟预估（给 --dry-run 用）。公式来自实测：侦察 15s / 主力最慢路 90s / 评审 50s。 */
export function estimateArmy({ units = 3, reviewers = 1, scoutMs = 15000, mainMs = 90000, reviewMs = 50000 } = {}) {
  const totalMs = scoutMs + mainMs + reviewMs * Math.max(1, reviewers);
  const mainOnlyMs = mainMs;
  return {
    totalMs,
    mainOnlyMs,
    overheadRatio: mainOnlyMs ? (totalMs - mainOnlyMs) / mainOnlyMs : 0,
    stages: [
      { stage: 'scout', ms: scoutMs, notes: '1 路只读，产出全是候选' },
      { stage: 'main', ms: mainMs, notes: units + ' 路异题并行（墙钟=最慢那路）' },
      { stage: 'review', ms: reviewMs * Math.max(1, reviewers), notes: reviewers + ' 路异源评审，各出 ' + units + ' 张票' },
    ],
  };
}

/** 落 ARMY.md：阵型的三段全部写下来，事后能复判「当时侦察说了什么、谁投了什么票」。 */
export function renderArmy({ prd, units, scout, artifacts, settled, summary, elapsed, sources }) {
  const p2 = (v) => String(v).padStart(2, '0');
  const dur = (ms) => (ms / 1000).toFixed(1) + 's';
  const src = sources || {};
  return [
    '# 三三制阵型记录',
    '',
    '- PRD：' + String(prd || '').split('\n')[0].slice(0, 200),
    '- 单元（' + units.length + '）：' + units.join(' / '),
    '- 侦察：' + (src.scout || 'none') + (scout && scout.total ? '（' + scout.total + ' 条候选，全部标记为候选）' : '（没有产出候选）'),
    '- 主力：' + artifacts.length + ' 路 · ' + (src.main || 'n/a'),
    '- 评审：' + (src.reviewers || 1) + ' 路 · ' + (src.review || 'n/a') + (src.homogeneous ? '（与主力同源：只能抓矛盾与硬错，抓不了同源共错）' : '（异源）'),
    '- 墙钟：侦察 ' + dur(elapsed.scoutMs) + ' + 主力 ' + dur(elapsed.mainMs) + ' + 评审 ' + dur(elapsed.reviewMs) + ' = ' + dur(elapsed.totalMs),
    '- 结论：' + summary.state + '（' + summary.counts.ACCEPT + ' 过 / ' + summary.counts.REVISE + ' 重做 / ' + summary.counts.unreviewed + ' 没票）',
    '',
    '## 一 · 侦察（全部是候选，不是事实）',
    renderScout(scout),
    '',
    '## 二 · 主力产物',
    ...artifacts.map((a, i) => [
      '### ' + a.id + ' · ' + a.unit + (a.lane ? '（通道：' + a.lane + '）' : ''),
      'ANSWER: ' + (a.answer || '(空)'),
      'EVIDENCE: ' + (a.evidence || '(空)'),
      '',
    ].join('\n')),
    '## 三 · 票面结算（逐产物过 judgeVotes，缺票一律 unreviewed）',
    '| 产物 | 单元 | 结论 | 置信度 | 到票 | 理由 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...settled.map((s) => '| ' + s.id + ' | ' + s.unit + ' | ' + s.state + ' | ' + (s.confidence != null ? Number(s.confidence).toFixed(3) : '-') + ' | ' + String(s.counts.ACCEPT) + '认/' + String(s.counts.REVISE) + '改/' + String(s.counts.unreviewed) + '未评 应评' + s.expected + ' | ' + String(s.reason) + ' |'),
    '',
    '## 四 · 为什么要到票率闸门',
    '评审路数声明了 ' + (src.reviewers || 1) + ' 路，实际到票不足时该产物是 unreviewed —— 「来了几张都认」等于把缺席当成同意。',
    '这条闸门来自 2026-11-16 的实测缺陷：3 张 ACCEPT、应评 5 → 置信度 0.457 就能放行。',
    '',
  ].join('\n');
}
