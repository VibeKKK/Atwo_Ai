// lib/should.mjs —— 要不要派活：把「每次临场权衡」压成一次可解释的函数调用。
//
// 为什么需要它（真事）：今天唯一那次 atwo fanout 自审计，本该自己干，结果卡了 17 分钟。
// 连写这个工具的人都会在临场权衡上判错，说明「该不该派」不能靠想起来，得让它自己开口。
//
// 纪律：
//   1. 每条判据都能指出「哪个词触发的」，不搞黑箱打分 —— AI 看不懂理由就不会照办。
//   2. 只有三种结论：delegate（派）/ self（自己干）/ either（都行，但偏一侧）。
//      永不返回「建议询问用户」——问人等于把成本又转回给人。
//   3. veto 优先：不可撤回的操作（删库 / 强推 / 提交 / 改契约）一律 self，不看分。

/** 热点文件：多路并行会互相顶掉的文件。派活撞这些必然返工。 */
export const HOT_FILES = [
  'atwo.mjs',
  'orchestra.mjs',
  'lib/cli-spec.mjs',
  'lib/fanout-run.mjs',
  'lib/fanout.mjs',
  'lib/prompt.mjs',
  'vm/oracle-contract.json',
  'package.json',
];

/** 不可撤回 / 影响面不可控 —— 这类任务派出去，出错没有第二次机会。 */
const VETO = [
  { re: /rm\s+-rf|删库|清空|格式化磁盘|drop\s+table/i, why: '不可撤回的破坏性操作' },
  { re: /git\s+push\s+--force|强推|git\s+reset\s+--hard/i, why: '会改写别人的历史' },
  { re: /git\s+commit|提交|push\s+origin/i, why: '签字动作不许代签' },
  { re: /contract\.json|契约改|authority\.json|SHARED\.md/i, why: '契约与治理文件只有人/rank1 能改' },
];

const SIGNALS = [
  {
    key: 'multi', weight: 3, side: 'delegate',
    // 「一个」不算多份 —— 一开始写成 \d+个，结果「加一个分支」被当成批量任务（真踩过）。
    re: /(?:[1-9]\d+|十|几十|[二三四五六七八九十两]+)\s*个|每个|逐个|全部|所有|批量|各自|分别|清单|多份|多路/,
    why: '多份同类产物 —— 多路并行才划得来',
  },
  {
    key: 'independent', weight: 3, side: 'delegate',
    re: /独立|互不相干|互不影响|不同仓库|并行|同时(跑|做|开)|各自独立/,
    why: '彼此独立 —— 拆分没有对齐成本',
  },
  {
    key: 'mechanical', weight: 2, side: 'delegate',
    re: /重命名|统一改成|统一为|格式化|替换成|补(注释|类型|文档)|机械|套路化|模板化/,
    why: '机械改造 —— 不需要判断力，只需要手',
  },
  {
    key: 'research', weight: 2, side: 'delegate',
    re: /调研|对比(一下|几个)|收集|列出|查一下|搜一下|罗列|盘点/,
    why: '收集类 —— 结论才是交付物，过程不值得占用主上下文',
  },
  {
    key: 'needs-context', weight: -3, side: 'self',
    re: /刚才|上面(说|写)|前面(说|那)|我们(讨论|说)|这个文件|这段代码|我(在|想|的)|上下文|你还记得/,
    why: '依赖我脑里的上下文 —— 交接描述成本 ≈ 自己做一半',
  },
  {
    key: 'judgment', weight: -3, side: 'self',
    re: /评估|判据|决策|权衡|该不该|值不值|为什么|可信吗|打分|评分|定夺/,
    why: '判断类 —— 派出去等于把判定权交给没有上下文的人',
  },
  {
    key: 'must-run', weight: -2, side: 'self',
    re: /跑(一遍)?测试|实测|复现|上机|验证(一下)?|真跑|压测/,
    why: '要真跑环境 —— 子会话卡住时你看不见，一次失败能吃光十次收益',
  },
  {
    key: 'trivial', weight: -2, side: 'self',
    re: /^.{0,12}$/,
    why: '小活 —— spawn 5–10s + 注入 400–800 token 摊不回本',
  },
];

/**
 * 判一次「该不该派」。
 * @param {string} task 任务原文（就一句话，不要加工）
 * @param {{hotFiles?: string[], parts?: number, timeoutMs?: number}} [opts]
 */
export function shouldDelegate(task, opts = {}) {
  const text = String(task == null ? '' : task);
  const hot = opts.hotFiles || HOT_FILES;

  const vetoed = VETO.filter((v) => v.re.test(text)).map((v) => v.why);
  if (vetoed.length) {
    return {
      contract: 'atwo-should/1',
      verdict: 'self',
      score: -99,
      vetoed,
      signals: [],
      why: '不派：' + vetoed.join('、'),
      est: null,
      contract_note: 'veto 优先于任何正分',
    };
  }

  const signals = [];
  let score = 0;
  for (const s of SIGNALS) {
    const m = text.match(s.re);
    if (!m) continue;
    const evidence = m[0];
    // 同一条判据只算一次：关键词堆砌不该把分堆上去。
    const w = s.weight;
    signals.push({ key: s.key, weight: w, side: s.side, evidence, why: s.why });
    score += w;
  }

  // 热点文件单独扫：出现具体文件名比「这个文件」更硬。
  const hotHit = hot.filter((f) => text.includes(f));
  if (hotHit.length) {
    signals.push({ key: 'hot-file', weight: -3, side: 'self', evidence: hotHit.join(','), why: '命中热点文件 —— 多路并行会互相顶掉' });
    score -= 3;
  }

  const verdict = score >= 3 ? 'delegate' : score <= -2 ? 'self' : 'either';
  const parts = Math.max(2, Math.min(6, Number(opts.parts) || (signals.some((s) => s.key === 'independent') ? 3 : 4)));
  const timeoutMs = Number(opts.timeoutMs) || 180000;

  const est = verdict === 'delegate' ? {
    parts,
    // 实测：3 路 12.3s 子 + 13.7s 父审；6 路 7.2s；启动 5–10s/路（实测 5.0–8.2s）。
    childSec: Math.round(6 + parts * 4),
    reviewSec: 14,
    totalSec: Math.round(6 + parts * 4 + 14),
    injectTokens: 400 + parts * 150,
    ctxSaveTokens: 3000,
    worstCaseSec: Math.round((timeoutMs * 2 + 120000) / 1000),
    note: '最坏情况（deadline 兜底）会跑 ' + Math.round((timeoutMs * 2 + 120000) / 1000) + 's，一次失败能吃光十次收益',
  } : null;

  const plus = signals.filter((s) => s.weight > 0);
  const minus = signals.filter((s) => s.weight < 0);
  const why = verdict === 'delegate'
    ? '派：' + plus.map((s) => s.why).join('；')
    : verdict === 'self'
      ? '自己干：' + (minus.length ? minus.map((s) => s.why).join('；') : '没有值得拆的信号')
      : '两边都行（权重打平）：派能省上下文，自干能省一次验收；偏 ' + (plus.length >= minus.length ? '派，先 --dry-run 看计划' : '自干');

  return { contract: 'atwo-should/1', verdict, score, vetoed: [], signals, why, est };
}

/** 人读版：一行结论 + 触发词 + 代价。 */
export function formatShould(r) {
  const lines = [];
  lines.push('结论：' + (r.verdict === 'delegate' ? '派给子会话' : r.verdict === 'self' ? '自己干' : '都可以（偏一侧）') + '（score ' + r.score + '）');
  lines.push(r.why);
  if (r.signals.length) {
    lines.push('');
    lines.push('判据：');
    for (const s of r.signals) {
      lines.push('  ' + (s.weight > 0 ? '+' : '') + s.weight + '  ' + s.key + '  ←「' + s.evidence + '」');
    }
  }
  if (r.est) {
    lines.push('');
    lines.push('代价：' + r.est.parts + ' 路 ≈ ' + r.est.childSec + 's 子 + ' + r.est.reviewSec + 's 审 = ' + r.est.totalSec + 's，注入 ≈ ' + r.est.injectTokens + ' token，省下主上下文 ≈ ' + r.est.ctxSaveTokens + ' token');
    lines.push('       ' + r.est.note);
  }
  return lines.join('\n');
}
