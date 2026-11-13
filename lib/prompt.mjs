// 上下文组装器：把一次派活的 prompt 拆成分区，并给每个分区算「注意力预算」。
//
// 为什么要有这一层：
//   模型的上下文是有限注意预算，不是免费白板（Anthropic《Effective context engineering》）。
//   我们这套系统会往 prompt 里塞四类东西——团队记忆、项目接续、临时能力、输出契约——
//   每一类都会稀释模型对「任务本身」的注意力。过去是裸字符串拼接，谁加了什么、
//   加了多少、有没有超预算，全靠记性。现在改成结构化组装 + 预算记账。
//
// 设计原则（对应文章里的几条）：
//   1. 最小高信号 token 集合：每个分区都有硬上限，超了截断并记录（不静默膨胀）。
//   2. 分区显式标注：用 [..] 围栏而非一堆散落的换行，模型和人一眼能分清哪段是什么。
//   3. 即时检索优于全文注入：长内容只放「路径 + 一句话」，要正文再单独读（ephemeral 就是这么做的）。
//   4. 预算可审计：每次派活都能打印出「哪段占了多少 token」。
//
// token 估算：中文一字≈1 token、英文 4 字符≈1 token。只用于相对比较，
// 不追求和具体分词器对齐——它要回答的是「谁超了」，不是「精确多少」。

export const LIMITS = {
  task: 20000,
  memory: 1200,
  project: 900,
  ephemeral: 1200,
  skill: 3000,
  contract: 1400,
};

/** 粗略 token 估算：CJK 计 1，其余按 4 字符 1 token */
export function estTokens(s) {
  const str = String(s || '');
  let cjk = 0;
  let other = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (
      (c >= 0x3040 && c <= 0x30ff) || // 日文假名
      (c >= 0x3400 && c <= 0x4dbf) || // CJK 扩展 A
      (c >= 0x4e00 && c <= 0x9fff) || // CJK 基本区
      (c >= 0xf900 && c <= 0xfaff) || // 兼容表意
      (c >= 0xff00 && c <= 0xffef) || // 全角标点
      (c >= 0x3000 && c <= 0x303f)    // CJK 标点
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/** 截断到字符上限，保留尾部说明，返回是否截断 */
export function clip(text, maxChars) {
  const s = String(text || '');
  if (!maxChars || s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars) + '\n…（已截断）', truncated: true };
}

/**
 * 组装 prompt。
 * @param {object} o
 * @param {string} o.task        任务本体（必填）
 * @param {string} o.memory      团队记忆（buildContext 出来的）
 * @param {string} o.project     项目接续简报
 * @param {string} o.ephemeral   临时能力清单
 * @param {string} o.skill       技能正文
 * @param {string} o.contract    输出契约
 * @param {object} o.limits      覆盖默认上限（token 计）
 */
export function assemble(o = {}) {
  const limits = { ...LIMITS, ...(o.limits || {}) };
  const report = [];
  const out = [];

  const push = (name, text, wrap) => {
    const raw = String(text || '').trim();
    if (!raw) return;
    const limit = limits[name] ?? Infinity;
    const before = estTokens(raw);
    // 按 token 上限反推字符上限（保守：中文 1 字 1 token）
    const maxChars = Number.isFinite(limit) ? Math.max(200, Math.ceil(limit * 2.2)) : 0;
    const c = clip(raw, maxChars);
    const after = estTokens(c.text);
    report.push({
      section: name,
      chars: raw.length,
      tokens: after,
      limit: Number.isFinite(limit) ? limit : null,
      over: Number.isFinite(limit) ? before > limit : false,
      truncated: c.truncated,
    });
    out.push(wrap ? wrap(c.text) : c.text);
  };

  // 顺序刻意如此：任务在最前（模型对开头最敏感），契约在最后（离生成最近）。
  push('task', o.task);
  push('memory', o.memory, (t) => `${t}`);
  push('project', o.project, (t) => `${t}`);
  push('ephemeral', o.ephemeral, (t) => `${t}`);
  push('skill', o.skill, (t) => `${t}`);
  push('contract', o.contract, (t) => `\n${t}`);

  const prompt = out.join('\n\n');
  const total = report.reduce((a, r) => a + r.tokens, 0);
  return { prompt, report, totalTokens: total, overBudget: report.some((r) => r.over) };
}

/** 人看的预算表 */
export function renderReport(r) {
  const rows = r.report || [];
  if (!rows.length) return '（没有分区）';
  const w = (s, n) => String(s).padEnd(n, ' ');
  const lines = [];
  lines.push(w('分区', 12) + w('token', 8) + w('上限', 8) + '状态');
  for (const x of rows) {
    const state = x.truncated ? `截断（原 ${x.chars} 字）` : x.over ? '超预算' : 'ok';
    lines.push(w(x.section, 12) + w(x.tokens, 8) + w(x.limit == null ? '—' : x.limit, 8) + state);
  }
  lines.push('');
  lines.push(`合计 ≈ ${r.totalTokens} token` + (r.overBudget ? '  ← 有分区超预算' : '  ← 在预算内'));
  return lines.join('\n');
}
