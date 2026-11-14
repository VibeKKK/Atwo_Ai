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
  return `${SUB_ROLE}\n\n[子目标] ${sub.title}\n[要求] ${sub.brief}`;
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
export function digest(results, maxChars = 160) {
  const rows = (results || []).map((r) => {
    const ok = r.status === 'done';
    const body = String(r.addedText || r.text || r.error || '').replace(/\s+/g, ' ').trim();
    return {
      id: r.id,
      agent: r.agent,
      ok,
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
    const mark = r.ok ? '✓' : '✗';
    lines.push(`  ${mark} #${r.id} ${String(r.agent).padEnd(10)} ${(r.ms / 1000).toFixed(1)}s  ${r.head.slice(0, maxChars)}`);
  }
  return lines.join('\n');
}
