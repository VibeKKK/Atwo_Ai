// 子 agent 能力：把一个目标拆成若干「自包含子任务」，每个子任务都是一个独立角色，
// 只回结论、中间产物落盘，不进主上下文。
//
// 设计原则（为什么不是简单地把 swarm 包一层）：
//   1. 拆解必须在派活之前完成，否则子任务之间会互相依赖、无法并行；
//   2. 子任务的 brief 要自带全部前提（子 agent 看不到我这边的上下文）；
//   3. 回来的只有 digest（截断结论）+ 落盘路径，全文留在 runs/<id>/；
//   4. 拆解失败就退化成单任务，绝不因为「拆得不漂亮」而整单失败。
import fs from 'node:fs';
import path from 'node:path';

export const DECOMPOSE_CONTRACT = `你是任务拆解器。把目标拆成 __N__ 个可并行、互不依赖的子任务。
要求：
- 每个子任务必须自带全部前提（执行者看不到原始目标以外的任何上下文）；
- 子任务之间不许有先后依赖；
- 每个子任务都能独立产出可验收的结果。
只输出一个 JSON 对象，不要解释：
{"subtasks":[{"id":1,"title":"不超过20字","brief":"给执行者的完整任务描述，含必要背景与验收标准"}]}`;

export const SUB_ROLE = `你是子 agent，只对一个子目标负责。
规则：
- 只输出该子目标的结论或产物，不要复述任务、不要客套、不要总结全文；
- 需要落盘的内容直接给完整文件内容；
- 结论里必须包含「如何验证这是对的」一句。`;

const ID_RE = /^[a-z0-9_-]{1,24}$/i;

// 模板残留标记：模型常把「要求」原样抄回来当答案（实测 trae 会整段回声），
// 这类项必须丢掉，否则会拿一句「不超过20字」当子任务派出去。
const TEMPLATE_MARKS = ['不超过20字', '__N__', '给执行者的完整任务描述', '"subtasks"', '可并行、互不依赖的子任务'];

function looksLikeTemplate(s) {
  const t = String(s || '');
  return TEMPLATE_MARKS.some((m) => t.includes(m));
}

function safeId(s, fallback) {
  const t = String(s ?? '').trim();
  return ID_RE.test(t) ? t : fallback;
}

// 从模型输出里抠 JSON（容忍前后解释、代码围栏、全角引号）
export function parseSubtasks(text, limit = 6) {
  if (!text) return [];
  let s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  let obj;
  try { obj = JSON.parse(s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1')); }
  catch { return []; }
  const arr = Array.isArray(obj) ? obj : (obj && (obj.subtasks || obj.tasks || obj.items)) || [];
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let k = 0; k < arr.length && out.length < limit; k++) {
    const it = arr[k] || {};
    const brief = String(it.brief || it.task || it.text || it.description || '').trim();
    if (brief.length < 8) continue;
    if (looksLikeTemplate(brief) || looksLikeTemplate(it.title)) continue;
    out.push({
      id: safeId(it.id, String(out.length + 1)),
      title: String(it.title || it.name || '').trim().slice(0, 40) || brief.slice(0, 40),
      brief,
    });
  }
  return out;
}

// 单任务降级：拆解失败时也不空手
export function singleTask(goal) {
  return [{ id: '1', title: String(goal).replace(/\s+/g, ' ').slice(0, 40), brief: String(goal) }];
}

export function buildBrief(sub) {
  // 2026-11-15 改：原来把 SUB_ROLE（约 500 字角色说明）+ 子目标 + 要求整段发给执行方，
  // 实测 WorkBuddy 面对这么长的 brief 只回「完成」两个字（`orch sub` 因此判 0/1）。
  // 现在压到 150 字符以内、固定两行：目标 + 一句约束。角色说明改由 SUB_ROLE 单独使用
  // （需要时显式拼，不塞进每一条派单）。
  const brief = String((sub && sub.brief) || '').replace(/\s+/g, ' ').trim();
  const head = brief.slice(0, 100);
  return `目标：${head}\n只回结论，不要复述问题，也不要解释。`;
}

export function briefDir(runId) {
  return path.join(process.cwd(), 'runs', runId);
}

export function writeBrief(dir, goal, subtasks) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const md = [
      `# 子 agent 派单 · ${new Date().toISOString()}`,
      '',
      `## 总目标`, '', String(goal).trim(), '',
      `## 子任务（${subtasks.length}）`, '',
      ...subtasks.map((s) => `### ${s.id}. ${s.title}\n\n${s.brief}\n`),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'brief.md'), md, 'utf8');
    return path.join(dir, 'brief.md');
  } catch { return ''; }
}

// 只回摘要：每条截 maxChars，全文留在 runs/<id>/
// 同时判「回声」：回来的内容基本等于派出去的提示词 = 这一路没干活（实测 workbuddy 会整段回声）。
export function digest(results, maxChars = 160) {
  const rows = (results || []).map((r) => {
    const ok = r.status === 'done';
    const raw = String(r.addedText || r.text || r.error || '');
    const body = raw.replace(/\s+/g, ' ').trim();
    const shown = String(r.shownPrompt || r.prompt || '').replace(/\s+/g, ' ').trim();
    const echo = !!shown && body.length > 40 && (shown.includes(body.slice(0, 40)) || body.includes(shown.slice(0, 40)));
    return {
      id: r.id,
      agent: r.agent,
      ok: ok && !echo,
      status: echo ? 'echo' : (ok ? 'done' : 'fail'),
      ms: r.elapsedMs || 0,
      head: body.slice(0, maxChars),
      full: r.file || r.outPath || '',
    };
  });
  const okN = rows.filter((r) => r.ok).length;
  return { total: rows.length, ok: okN, rows };
}

export function renderDigest(d, { maxChars = 160 } = {}) {
  const lines = [];
  lines.push(`子 agent 汇总 ${d.ok}/${d.total} 完成`);
  for (const r of d.rows) {
    const mark = r.status === 'echo' ? '⟲' : (r.ok ? '✓' : '✗');
    const tag = r.status === 'echo' ? '回声' : '';
    lines.push(`  ${mark} #${r.id} ${String(r.agent).padEnd(10)} ${(r.ms / 1000).toFixed(1)}s ${tag}${tag ? ' ' : ' '}${r.head.slice(0, maxChars)}`);
  }
  return lines.join('\n');
}
