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
export const DEFAULT_MAX_CHUNKS = 4;

/** 通配展开上限：超了就说明这条通配不是「本次要改的文件」，而是「整个目录」。 */
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
/**
 * 按「真依赖」把单元聚成簇（2026-11-17 标定撞出来的）。
 * 起因：planSplit 只看单元数量就切，于是 lib/fanout-run.mjs + lib/reviewer-ledger.mjs
 * 这种「一方 import 另一方」的强耦合也被切开 —— 两边各写一半口径，合起来必打架。
 * 反过来，3 个互不相干的测试文件因为「少于 4 个单元」被拒绝切分，白丢了并行收益。
 */
export function buildClusters(units, opts = {}) {
  const n = units.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { const a = find(i); const b = find(j); if (a !== b) parent[b] = a; };
  const src = units.map((u) => { try { return fs.readFileSync(u.abs, 'utf8'); } catch { return ''; } });
  const isDoc = (u) => /[.](md|json)$/.test(u.unit);
  const isTest = (u) => /[.]test[.](mjs|js|cjs)$/.test(u.unit);
  const stemOf = (u) => path.basename(u.unit).replace(/[.](test[.])?(mjs|js|cjs|py)$/, '');
  // 依赖只认「真的 import/require 了一个文件」。
  // 教训（2026-11-17 标定）：最初用「源码里出现过对方文件名」判依赖，gate.mjs 在注释里提到
  // split.mjs 就被并簇，四个本来可以分头审计的文件被当成一件事，连 split.test.mjs 的旧断言
  // （四单元切两片）都被打破 —— 注释里的名字不是依赖。
  const SPEC_RE = new RegExp("(?:^|[ \\t;{])(?:import|export)[^'\"`]*?from[ \\t]*['\"`]([^'\"`]+)['\"`]|require[(][ \\t]*['\"`]([^'\"`]+)['\"`][ \\t]*[)]|import[(][ \\t]*['\"`]([^'\"`]+)['\"`][ \\t]*[)]", 'gm');
  const specs = src.map((t) => {
    const out = [];
    let m;
    SPEC_RE.lastIndex = 0;
    while ((m = SPEC_RE.exec(t))) out.push(m[1] || m[2] || m[3]);
    return out.filter(Boolean);
  });
  const byUnit = new Map(units.map((u, i) => [u.unit, i]));
  for (let i = 0; i < n; i++) {
    for (const spec of specs[i]) {
      if (!spec.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(units[i].unit), spec));
      const j = byUnit.get(target);
      if (j !== undefined && j !== i) union(i, j);
    }
  }
  // 测试与实现同名主干才合并（lib/pitfalls.mjs ↔ test/pitfall.test.mjs，含复数 s）。
  // 文档不参与：views.md / views.trae.md 共享 views 但彼此独立。
  for (let i = 0; i < n; i++) {
    if (!isTest(units[i])) continue;
    const want = stemOf(units[i]);
    for (let j = 0; j < n; j++) {
      if (i === j || isDoc(units[j]) || isTest(units[j])) continue;
      const got = stemOf(units[j]);
      if (got === want || got.replace(/s$/, '') === want) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(units[i]); }
  return [...groups.values()];
}
export function planSplit(task, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const maxChunks = Math.max(2, Math.min(Number(opts.maxChunks) || DEFAULT_MAX_CHUNKS, 14));
  const units = opts.units || detectUnits(task, { cwd });
  if (!units.length) return { chunks: [], units: [], clusters: [], reason: 'no-units', strategy: 'none' };
  const clusters = buildClusters(units, { cwd });
  // 只有一簇 = 这批文件本来就该一个人做，切了就是两边各写一半口径。
  if (clusters.length < 2) return { chunks: [], units, clusters, reason: 'single-cluster', strategy: 'none' };
  // 片数 = 簇数（上限 maxChunks）：不再用 floor(units/2) —— 那个公式会把 5 份互不依赖的文档切成 2 片。
  const count = Math.min(maxChunks, clusters.length);
  const chunks = Array.from({ length: count }, () => []);
  clusters.slice().sort((x, y) => y.length - x.length).forEach((c, i) => chunks[i % count].push(...c));
  return {
    chunks: chunks.map((us, i) => ({ index: i, total: count, units: us, label: 'chunk-' + (i + 1) + '/' + count })),
    units,
    clusters,
    strategy: 'clusters',
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

// ────────────────────────────────────────────────────────────────────────────
// 切分侧的「尺子」（2026-11-17）
//
// 为什么要有这一段：用户明确要求「任务分割」与「检查机制」等价占比 —— 各占一半。
// 可验收那边早有五层闸门、三值票决、凭证；切分这边此前只有一个 describeSplit（报个数），
// 等于「切了但没人判切得对不对」。没有尺子的半边不叫一半，叫陪衬。
// 所以这里给切分配同等硬度的判据：七条机器可查，任一硬项不过就是 bad，软项不过降级为 weak。
// ────────────────────────────────────────────────────────────────────────────

/** 片间负载比上限（最大片 / 最小片）。超过就说明切歪了：慢的那片会拖住整批。 */
export const MAX_IMBALANCE = 2;

/**
 * 判一份切分计划好不好。纯函数，不看盘、不调模型。
 *
 * 七条判据：
 *   has-units          有可枚举单元
 *   chunks>=2          真切成至少两片（一片等于没切）
 *   no-empty-chunk     没有空片
 *   mutually-exclusive 同一个单元不落在两片（否则两路会同改一个文件）
 *   complete           所有单元都被覆盖（漏掉的单元等于没人做）
 *   balanced           最大片 / 最小片 ≤ MAX_IMBALANCE
 *   dense              每片 ≥ MIN_UNITS_PER_CHUNK（**软项**：单元本来就少的活不该被规则否掉）
 *
 * @param {object} plan planSplit 的返回值
 * @param {object} [opts] { maxImbalance, minUnitsPerChunk }
 * @returns {{ok:boolean, verdict:'ok'|'weak'|'bad', items:Array, load:object, coverage:number, count:number, units:number}}
 */
export function checkSplit(plan, opts = {}) {
  const maxImbalance = Number(opts.maxImbalance) > 0 ? Number(opts.maxImbalance) : MAX_IMBALANCE;
  const minDense = Number(opts.minUnitsPerChunk) > 0 ? Number(opts.minUnitsPerChunk) : MIN_UNITS_PER_CHUNK;
  const chunks = plan && Array.isArray(plan.chunks) ? plan.chunks : [];
  const units = plan && Array.isArray(plan.units) ? plan.units : [];
  const items = [];
  const add = (code, ok, detail, level = 'bad') => items.push({ code, ok, detail, level: ok ? 'ok' : level });

  // 「不切」是合法结论（单元太少），不是切坏了 —— 用 skip 与 bad 分开，
  // 否则 --split 遇到小任务会被自己的闸门拒掉。
  if (chunks.length === 0) {
    add('has-units', units.length > 0, '单元 ' + units.length + ' 个');
    const enough = units.length > 0;
    return {
      ok: enough,
      verdict: enough ? 'skip' : 'bad',
      items,
      load: { min: 0, max: 0, ratio: null },
      coverage: 0,
      count: 0,
      units: units.length,
    };
  }

  add('has-units', units.length > 0, '单元 ' + units.length + ' 个');
  add('chunks>=2', chunks.length >= 2, '片数 ' + chunks.length);

  const sizes = chunks.map((c) => (Array.isArray(c.units) ? c.units.length : 0));
  add('no-empty-chunk', chunks.length > 0 && sizes.every((n) => n >= 1), '空片 ' + sizes.filter((n) => n < 1).length + ' 个');

  const flat = [];
  for (const c of chunks) for (const u of Array.isArray(c.units) ? c.units : []) flat.push(u && u.unit);
  const dup = flat.length - new Set(flat).size;
  add('mutually-exclusive', dup === 0, '重复单元 ' + dup + ' 个');

  const want = new Set(units.map((u) => u && u.unit));
  const got = new Set(flat);
  const missing = [...want].filter((x) => !got.has(x)).length;
  add('complete', want.size > 0 && missing === 0, '漏掉单元 ' + missing + ' 个');

  const min = sizes.length ? Math.min(...sizes) : 0;
  const max = sizes.length ? Math.max(...sizes) : 0;
  const ratio = min > 0 ? max / min : Infinity;
  add('balanced', Number.isFinite(ratio) && ratio <= maxImbalance,
    '最大/最小 = ' + (Number.isFinite(ratio) ? ratio.toFixed(2) + '×' : '∞') + '（上限 ' + maxImbalance + '×）');

  // 密度判据不能一刀切「每片 ≥2」：3 个零耦合文件切 3 片时，1 片 1 个已经是最密。
  // 只有当单元够多（≥ 2×片数）却仍切出薄片时，才说明切法有问题。
  const unitsTotal = (plan.units || []).length;
  const chunkCount = sizes.length;
  const denseFloor = unitsTotal >= chunkCount * 2 ? minDense : 1;
  add('dense', sizes.length > 0 && sizes.every((n) => n >= denseFloor),
    '低于 ' + denseFloor + ' 个的片 ' + sizes.filter((n) => n > 0 && n < minDense).length + ' 个', 'weak');

  const bad = items.filter((i) => !i.ok && i.level === 'bad').length;
  const weak = items.filter((i) => !i.ok && i.level === 'weak').length;
  const verdict = bad ? 'bad' : weak ? 'weak' : 'ok';
  return {
    ok: verdict === 'ok',
    verdict,
    items,
    load: { min, max, ratio: Number.isFinite(ratio) ? ratio : null },
    coverage: want.size ? (want.size - missing) / want.size : 0,
    count: chunks.length,
    units: units.length,
  };
}

const SPLIT_LABEL = {
  'has-units': '有单元',
  'chunks>=2': '切成多片',
  'no-empty-chunk': '无空片',
  'mutually-exclusive': '互斥',
  'complete': '无遗漏',
  'balanced': '均衡',
  dense: '密度',
};

/**
 * 一行给人看：合格的打 ✓ 带关键数值，不合格的打 ✗。
 * 例：▶ 切分：4 片 · 单元 10 个（互斥 ✓ · 无遗漏 ✓ · 均衡 1.00× ✓ · 密度 ✓）
 */
export function renderSplitLine(result) {
  if (!result || !Array.isArray(result.items)) return '▶ 切分：（没有切分计划）';
  if (result.verdict === 'skip') {
    const why = result.reason === 'single-cluster'
      ? '全都属于同一簇：互相 import，切开就是两边各写一半口径'
      : '单元 ' + result.units + ' 个，本来就少，切了反而更慢';
    return '▶ 切分：不切（' + why + '）';
  }
  const parts = result.items.map((i) => {
    const name = SPLIT_LABEL[i.code] || i.code;
    if (!i.ok) return name + ' ✗ ' + i.detail;
    // 片数与单元数在行首已经写过一遍，这里只打勾，免得同一句话出现两次。
    if (i.code === 'has-units' || i.code === 'chunks>=2') return name + ' ✓';
    // 均衡只留倍数，去掉「最大/最小 = …（上限 2×）」这层解释。
    if (i.code === 'balanced') {
      const m = /=\s*([\d.]+×|∞)/.exec(i.detail);
      return name + (m ? ' ' + m[1] : '') + ' ✓';
    }
    return name + ' ✓';
  });
  const head = '▶ 切分：' + result.count + ' 片 · ' + result.units + ' 个单元';
  return head + '（' + parts.join(' · ') + '）';
}

/** bad → 前置条件不满足（不该开工）；weak/ok 都放行。 */
export function exitForSplit(result, exitCodes) {
  return result && result.verdict === 'bad' ? exitCodes.precondition : exitCodes.ok;
}