// lib/split.mjs —— 长尾切分：把「一个大活」切成 N 份并行，砍掉的不是平均值而是最慢那一个。
// 口径（2026-11-16 实测）：12 个任务并行 216.8s = 最慢那个的时长，不是均值；
// 想把 6.5x 往上顶，只能让「最慢那一个」本身变小 —— 加路数对它零作用。
//
// 为什么不让 LLM 决定怎么切：切分方案一旦不可复算，就没法判断「切错了」还是「活本来这么大」。
// 这里只切**可枚举的工作单元**（文件清单），切法本身是纯函数，能写测试。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 每片最少几个单元：单元太少时，子会话的启动税（5–10s）+ 注入税（400–800 token）摊不回本。 */
export const MIN_UNITS_PER_CHUNK = 2;
/** 少于这么多单元就不切：4 个单元切成 2 片只是把同一份活写了两遍开头。 */
export const MIN_UNITS_TO_SPLIT = 4;
export const DEFAULT_MAX_CHUNKS = 4;

const GLOB_RE = /([\w./-]*\*[\w./*-]*\.(?:mjs|js|cjs|py|json|md))/g;
const FILE_RE = /([\w./-]+\.(?:mjs|js|cjs|py|json|md))/g;

function expandGlob(pattern, cwd) {
  // 只支持最后一段是 *.ext 的简单 glob：复杂的交给 shell，这里不做正则生成器。
  const abs = path.isAbsolute(pattern) ? pattern : path.join(cwd, pattern);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  if (!base.includes('*')) return fs.existsSync(abs) ? [abs] : [];
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => re.test(n)).map((n) => path.join(dir, n));
}

/**
 * 剔掉被 .gitignore 命中的单元。为什么必须剔（2026-11-16 实测）：
 * 子会话的 Glob / Grep 尊重 .gitignore，而这里用 fs 直接读盘 —— 两边看到的文件集不一致时，
 * 派下去的文件子会话说「不存在」、父审用 Read 又读到了 → 必然判成假 REVISE。
 * 实测 lib/*.mjs 磁盘 78 个、子会话只看得见 52 个，26 个草稿/备份文件把整组结论带偏。
 * git 不可用或不在仓库里时不过滤（宁可多派，也不要因为拿不到规则就把清单清空）。
 */
function dropIgnored(units, cwd) {
  if (!units.length) return units;
  if (spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' }).status !== 0) return units;
  const r = spawnSync('git', ['check-ignore', '--stdin'], { cwd, input: units.map((u) => u.unit).join('\n'), encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) return units;
  const ignored = new Set(String(r.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean));
  return units.filter((u) => !ignored.has(u.unit));
}

/**
 * 从任务文本里抠出「可枚举的工作单元」。只有真的能落到文件上才算 —— 抠不出就返回空，绝不猜。
 * 返回 [{unit, abs, exists}]，unit 是给人看的形式（相对 cwd 的路径）。
 */
export function detectUnits(task, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const text = String(task || '');
  const seen = new Set();
  const out = [];
  const push = (abs) => {
    const rel = path.relative(cwd, abs).replace(/\\/g, '/');
    const key = rel || abs;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ unit: key, abs, exists: fs.existsSync(abs) });
  };
  for (const m of text.matchAll(GLOB_RE)) for (const p of expandGlob(m[1], cwd)) push(p);
  for (const m of text.matchAll(FILE_RE)) {
    if (m[1].includes('*')) continue;
    const abs = path.isAbsolute(m[1]) ? m[1] : path.join(cwd, m[1]);
    if (fs.existsSync(abs)) push(abs);
  }
  return opts.keepIgnored ? out.filter((u) => u.exists) : dropIgnored(out.filter((u) => u.exists), cwd);
}

/**
 * 切分计划（纯函数）。返回 null 表示「不该切」，reason 说明为什么 —— 静默不切比切了更慢要好。
 * 片数 = min(maxChunks, floor(units / MIN_UNITS_PER_CHUNK))，且不超过 units。
 */
export function planSplit(task, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const maxChunks = Math.max(2, Math.min(Number(opts.maxChunks) || DEFAULT_MAX_CHUNKS, 14));
  const units = opts.units || detectUnits(task, { cwd });
  if (!units.length) return { chunks: [], units: [], reason: 'no-units', strategy: 'none' };
  if (units.length < MIN_UNITS_TO_SPLIT) return { chunks: [], units, reason: 'units<' + MIN_UNITS_TO_SPLIT, strategy: 'none' };
  const bySize = Math.floor(units.length / MIN_UNITS_PER_CHUNK);
  const count = Math.max(2, Math.min(maxChunks, bySize, units.length));
  if (count < 2) return { chunks: [], units, reason: 'count<2', strategy: 'none' };
  const chunks = Array.from({ length: count }, () => []);
  units.forEach((u, i) => chunks[i % count].push(u));
  return {
    chunks: chunks.map((us, i) => ({ index: i, total: count, units: us, label: 'chunk-' + (i + 1) + '/' + count })),
    units,
    strategy: 'units',
    reason: 'ok',
    count,
  };
}

/** 给一片子会话的任务文本：原任务 + 本片清单 + 越界禁令。 */
export function chunkTask(task, chunk) {
  const list = chunk.units.map((u) => '- ' + u.unit).join('\n');
  return [
    String(task).trim(),
    '',
    '## 你这一片只负责（第 ' + (chunk.index + 1) + ' / ' + chunk.total + ' 片）',
    list,
    '',
    '清单外的部分由别的子会话负责：不要越界、不要补写别处结论、不要声称你检查了清单外的文件。',
    '本片结论必须逐项覆盖上面每一条，每条都要带「文件:行」证据。',
  ].join('\n');
}

/** 机械拼装：不调 LLM。多份分片产物按片序拼起来，谁说了什么原样保留，可复算。 */
export function mergeParts(parts, plan) {
  const usable = (parts || []).filter((p) => p && String(p.answer || '').trim());
  if (!usable.length) return { text: '', chars: 0, parts: 0 };
  const blocks = usable.map((p, i) => {
    const c = plan && plan.chunks ? plan.chunks.find((x) => x.label === p.chunkLabel) : null;
    const head = '## 分片 ' + (c ? (c.index + 1) + '/' + c.total : i + 1 + '/' + usable.length) +
      (c ? ' · ' + c.units.map((u) => u.unit).join('、') : '');
    return head + '\n\n' + String(p.answer).trim() + (p.evidence ? '\n\n证据：' + String(p.evidence).trim() : '');
  });
  const text = blocks.join('\n\n');
  return { text, chars: text.length, parts: usable.length };
}

export function describeSplit(plan) {
  if (!plan || !plan.chunks || !plan.chunks.length) return '不切（' + ((plan && plan.reason) || 'no-plan') + '）';
  return plan.count + ' 片 × 约 ' + Math.ceil(plan.units.length / plan.count) + ' 个单元（共 ' + plan.units.length + ' 个）';
}